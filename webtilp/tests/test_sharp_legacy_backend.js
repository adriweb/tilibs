'use strict';
const assert = require('node:assert/strict');
const sharp = require('../sharp_backend.js');
const { SharpLegacyBackend, CATEGORIES: backendCategories } = require('../sharp_legacy_backend.js');
const { frame, checksum } = sharp;
const join = (...parts) => Uint8Array.from(Buffer.concat(parts.map(p => Buffer.from(p))));
const command = opcode => frame(Uint8Array.of(opcode));
const reply = (identity, data) => frame(typeof data === 'number' ? Uint8Array.of(data) : data, identity);
const ack = command(0x01);
const ascii = value => Uint8Array.from(Buffer.from(value, 'latin1'));
const categoryBytes = name => ascii(name.padEnd(11, ' '));
const LEGACY_CATEGORIES = [['SOLVE EQU', 'e'], ['PROGRAM', 'p'], ['ANIME', 's']];
const PROFILES = [
    { model: 'sharp-el9400', identity: '94', width: 96, fileProfile: '2' },
    { model: 'sharp-el9450', identity: '95', width: 96, fileProfile: '5' },
    { model: 'sharp-el9600', identity: '96', width: 132, fileProfile: '3' },
    { model: 'sharp-el9650', identity: '96', width: 132, fileProfile: '3' }
];

// These are constructed transcripts from static CE-LK1P PC-LINK analysis.
// This strict wire peer neither emulates calculator firmware nor establishes
// compatibility with a physical calculator, cable, or pixel orientation.
class Port {
    constructor(script, { fragmentation = 'mixed', signals = true } = {}) {
        this.script = [...script]; this.fragmentation = fragmentation;
        this.options = []; this.writes = []; this.signals = []; this.closed = 0;
        if (!signals) this.setSignals = undefined;
    }
    async open(options) {
        this.options.push(options);
        this.readable = new ReadableStream({ start: controller => { this.controller = controller; }, cancel() {} });
        this.writable = new WritableStream({ write: bytes => {
            const packet = new Uint8Array(bytes);
            this.writes.push(packet.slice());
            const step = this.script[0];
            assert.ok(step, 'no unsolicited wire commands');
            const offset = this.packetOffset || 0;
            assert.ok(offset + packet.length <= step[0].length, 'write stays within its expected frame');
            assert.deepEqual(packet, new Uint8Array(step[0]).slice(offset, offset + packet.length), 'outgoing wire bytes');
            this.packetOffset = offset + packet.length;
            if (this.packetOffset === step[0].length) {
                this.packetOffset = 0; this.script.shift();
                if (step[1]) this.feed(step[1]);
            }
        } });
    }
    async setSignals(signals) { this.signals.push({ ...signals }); }
    feed(bytes) {
        const sizes = this.fragmentation === 'byte' ? [1]
            : this.fragmentation === 'coalesced' ? [bytes.length] : [1, 2, 7, 3, 127, 5, 16];
        for (let offset = 0, index = 0; offset < bytes.length; index++) {
            const size = sizes[index % sizes.length];
            this.controller.enqueue(bytes.slice(offset, offset + size)); offset += size;
        }
    }
    async close() { this.closed++; this.readable = null; this.writable = null; }
}

async function connected(profile, script, portOptions = {}, backendOptions = {}) {
    const port = new Port(script, portOptions);
    const backend = new SharpLegacyBackend({ serialPort: port, model: profile.model, timeoutMs: 100, ...backendOptions });
    await backend.connect();
    return { backend, port };
}

function screenshotScript(profile, bitmap, metadata = Uint8Array.of(0x84, 0x21, 0x23, 0x81)) {
    const f = value => reply(profile.identity, value);
    return [[command(0x42), f(0x01)], [command(0x63), join(f(0x01), f(0x23))],
        [ack, f(metadata)], [ack, f(bitmap)], [ack]];
}

async function checkSerialAndHandshake() {
    assert.equal(globalThis.WebTILPSharp.SharpLegacyBackend, SharpLegacyBackend);
    assert.ok(SharpLegacyBackend.prototype instanceof sharp.SharpBackend);
    assert.deepEqual([...reply('94', 1)], [0x39, 0x34, 1, 0x6e, 0]);
    assert.deepEqual([...reply('95', 1)], [0x39, 0x35, 1, 0x6f, 0]);
    assert.deepEqual([...reply('96', 1)], [0x39, 0x36, 1, 0x70, 0]);
    for (const model of ['sharp-auto', 'sharp-el9900', 'sharp-el9950']) {
        assert.throws(() => new SharpLegacyBackend({ serialPort: new Port([]), model }), /select|model|legacy/i);
    }
    for (const options of [{ baudRate: 38400 }, { stopBits: 2 }, { dataBits: 7 }, { parity: 'none' }, { flowControl: 'none' }]) {
        const port = new Port([]), backend = new SharpLegacyBackend({ serialPort: port, model: PROFILES[0].model });
        await assert.rejects(backend.connect(options), /9600|8E1|flow control/i);
        assert.deepEqual(port.options, [], 'incompatible serial overrides are rejected before opening the port');
        assert.deepEqual(port.writes, []);
    }
    for (const profile of PROFILES) {
        assert.equal(sharp.getModelProfile(profile.model).family, 'celk1');
        for (const signals of [true, false]) {
            const peer = await connected(profile, [[command(0x42), reply(profile.identity, 1)]], { signals });
            for (const capability of ['screen', 'directory', 'receive', 'send']) assert.equal(peer.backend.capabilities[capability], true);
            for (const capability of ['backup', 'dump', 'version', 'sourceConversion']) assert.equal(peer.backend.capabilities[capability], false);
            assert.equal(await peer.backend.readVersion(), null, 'legacy identity handshake does not invent a firmware version');
            assert.deepEqual(peer.port.options[0], { baudRate: 9600, stopBits: 1, dataBits: 8,
                parity: 'even', flowControl: 'hardware', bufferSize: 65536 });
            if (signals) {
                assert.ok(peer.port.signals.some(s => s.dataTerminalReady === true), 'DTR is asserted when supported');
                assert.ok(peer.port.signals.every(s => !Object.hasOwn(s, 'requestToSend')),
                    'hardware flow control owns RTS, so it is not set manually');
            }
            assert.equal(peer.port.script.length, 0, 'identity operation has no modern 41 end command');
            assert.deepEqual(peer.port.writes, [command(0x42)]);
            await peer.backend.close();
        }
    }
}

async function checkScreenshots() {
    for (const profile of PROFILES) {
        for (const fragmentation of ['byte', 'mixed', 'coalesced']) {
            const bitmap = new Uint8Array(profile.width * 8);
            // Command-looking pixel bytes and identities are still image data.
            bitmap.set([0x01, 0x21, 0x23, 0x81, 0x84, 0x39, 0x34, 0x39, 0x36]);
            bitmap[bitmap.length - 1] = 0xff;
            const progress = [];
            const peer = await connected(profile, screenshotScript(profile, bitmap), { fragmentation },
                { onProgress: p => progress.push(p) });
            const image = await peer.backend.captureScreenshot();
            assert.equal(image.width, profile.width); assert.equal(image.height, 64);
            const expected = sharp.decodeScreenshot(bitmap, profile.width, 64);
            assert.deepEqual(image.rgba, expected.rgba);
            const pixel = (x, y) => image.rgba[(y * profile.width + x) * 4];
            assert.equal(pixel(0, 7), 0, 'bit zero in first vertical page is its bottom pixel');
            assert.equal(pixel(0, 0), 255, 'bit seven in first vertical page is its top pixel');
            assert.equal(pixel(profile.width - 1, 63), 0);
            assert.equal(peer.port.script.length, 0, 'screenshot consumes exactly the profile-sized raw bitmap');
            assert.deepEqual(peer.port.writes, [command(0x42), command(0x63), ack, ack, ack],
                'metadata and bitmap phases add neither opcodes nor a modern end command');
            assert.ok(progress.some(p => p.total === bitmap.length && p.completed === bitmap.length));
            await peer.backend.close();
        }
    }
    // Metadata is an opaque 4-byte record. Its first byte can equal any of
    // the short-response controls without turning it into a short packet.
    for (const first of [0x01, 0x21, 0x23, 0x81, 0x84]) {
        const profile = PROFILES[0], bitmap = new Uint8Array(profile.width * 8);
        const peer = await connected(profile, screenshotScript(profile, bitmap, Uint8Array.of(first, 0, 0, 0)));
        await peer.backend.captureScreenshot();
        assert.equal(peer.port.script.length, 0); await peer.backend.close();
    }
}

function directoryScript(profile, payloads) {
    const result = [];
    for (const [name] of LEGACY_CATEGORIES) {
        result.push(...oneDirectory(profile, name, payloads[name] || []));
    }
    return result;
}

function oneDirectory(profile, name, selectors = []) {
    const f = data => reply(profile.identity, data);
    const data = join(Uint8Array.of(selectors.length), ...selectors);
    return [[command(0x61), f(1)], [frame(categoryBytes(name)), join(f(1), f(0x21))],
        [ack, f(categoryBytes(name))], [ack, f(data)], [ack]];
}

async function checkDirectories() {
    for (const profile of PROFILES) {
        for (const fragmentation of ['byte', 'coalesced']) {
            const program = ascii('HERON'.padEnd(11, ' ')), anime = ascii('MOTION'.padEnd(11, ' '));
            const peer = await connected(profile, directoryScript(profile, { PROGRAM: [program], ANIME: [anime] }), { fragmentation });
            const entries = await peer.backend.listVariables();
            assert.equal(entries.length, 2);
            for (const [entry, name, ext, selector] of [[entries[0], 'HERON', 'p', program], [entries[1], 'MOTION', 's', anime]]) {
                assert.equal(entry.name, name); assert.equal(entry.category.ext, ext);
                assert.deepEqual(entry.selector, selector);
            }
            assert.equal(peer.port.script.length, 0);
            assert.deepEqual(peer.port.writes, LEGACY_CATEGORIES.flatMap(([name]) =>
                [command(0x61), frame(categoryBytes(name)), ack, ack, ack]));
            await peer.backend.close();
        }
    }
    // A count which equals a short-response opcode is still a directory count.
    const profile = PROFILES[0];
    const selectors = Array.from({ length: 0x21 }, (_, index) => ascii(('P' + index).padEnd(11, ' ')));
    const many = await connected(profile, directoryScript(profile, { PROGRAM: selectors }));
    const entries = await many.backend.listVariables();
    assert.equal(entries.length, selectors.length); assert.equal(entries.at(-1).name, 'P32');
    assert.equal(many.port.script.length, 0); await many.backend.close();
    const badEchoScript = [[command(0x61), reply('94', 1)],
        [frame(categoryBytes('SOLVE EQU')), join(reply('94', 1), reply('94', 0x21))],
        [ack, reply('94', categoryBytes('PROGRAM'))]];
    const badEcho = await connected(profile, badEchoScript);
    await assert.rejects(badEcho.backend.listVariables(), /category|directory/i);
    assert.equal(badEcho.backend.closed, true); assert.equal(badEcho.port.script.length, 0);
}

function objectScript(profile, category, selector, useful) {
    const f = value => reply(profile.identity, value);
    const length = 15 + useful.length;
    const body = join(Uint8Array.of(length & 255, length >> 8, 0x81, 0x23), selector, useful);
    return [[command(0x62), f(1)],
        [frame(categoryBytes(category.name)), f(1)], [frame(selector), join(f(1), f(0x22))],
        [ack, f(join(categoryBytes(category.name), Uint8Array.of(0x84, 0x81)))], [ack, f(body)], [ack]];
}

async function checkVariableReception() {
    for (const profile of PROFILES) {
        for (const [name, ext] of LEGACY_CATEGORIES) {
            const category = backendCategories.find(c => c.name === name && c.ext === ext);
            // Keep all eleven selector bytes, including positions beyond the
            // usual eight displayed name characters.
            const selector = ascii('NINELONGXYZ');
            const useful = new Uint8Array(0x121 - 15);
            useful[0] = 0x01; useful.set([0x21, 0x81, 0x84, 0x39, 0x34], 1); useful[useful.length - 1] = 0x23;
            const peer = await connected(profile, objectScript(profile, category, selector, useful), { fragmentation: 'byte' });
            const received = await peer.backend.receiveVariable({ kind: 'sharp', name: 'NINELONGXYZ', category, selector });
            assert.equal(received.filename.toLowerCase(), `ninelongxyz.g${profile.fileProfile}${ext}`);
            assert.ok(received.data instanceof Uint8Array);
            assert.deepEqual(received.data.subarray(0, 2), ascii(profile.fileProfile + ext.toUpperCase()));
            assert.deepEqual(received.data.subarray(2, 13), selector, 'native header preserves the whole selector');
            assert.equal(received.data[53], 0, '54-byte native header is NUL terminated');
            assert.deepEqual(received.data.subarray(54), ext === 'p' ? useful.subarray(1) : useful,
                'program export alone omits the first useful body byte');
            assert.equal(peer.port.script.length, 0);
            assert.deepEqual(peer.port.writes, [command(0x62), frame(categoryBytes(name)), frame(selector), ack, ack, ack]);
            await peer.backend.close();
        }
    }
    const profile = PROFILES[0], category = backendCategories.find(c => c.ext === 'p'), selector = ascii('HERON'.padEnd(11, ' '));
    const mismatch = objectScript(profile, category, selector, Uint8Array.of(1, 2));
    mismatch[3] = [ack, reply(profile.identity, join(categoryBytes('ANIME'), Uint8Array.of(0, 0)))];
    mismatch.splice(4);
    const badCategory = await connected(profile, mismatch);
    await assert.rejects(badCategory.backend.receiveVariable({ name: 'HERON', category, selector }), /category|object/i);
    assert.equal(badCategory.backend.closed, true); assert.equal(badCategory.port.script.length, 0);
    const wrongName = objectScript(profile, category, selector, Uint8Array.of(1, 2));
    const badBody = join(Uint8Array.of(17, 0, 0, 0), ascii('HERON   XYZ'), Uint8Array.of(1, 2));
    wrongName[4] = [ack, reply(profile.identity, badBody)]; wrongName.splice(5);
    const badSelector = await connected(profile, wrongName);
    await assert.rejects(badSelector.backend.receiveVariable({ name: 'HERON', category, selector }), /name|selector|object/i);
    assert.equal(badSelector.backend.closed, true); assert.equal(badSelector.port.script.length, 0);
    for (const length of [0, 14]) {
        const malformed = objectScript(profile, category, selector, Uint8Array.of(1, 2));
        malformed[4] = [ack, reply(profile.identity, Uint8Array.of(length, 0))]; malformed.splice(5);
        const peer = await connected(profile, malformed);
        await assert.rejects(peer.backend.receiveVariable({ name: 'HERON', category, selector }), /length|size|object/i);
        assert.equal(peer.backend.closed, true); assert.equal(peer.port.script.length, 0);
    }
}

async function checkIdentityAndChecksumFailures() {
    for (const profile of PROFILES) {
        const wrongIdentity = profile.identity === '94' ? '95' : '94';
        const mismatch = await connected(profile, [[command(0x42), reply(wrongIdentity, 1)]]);
        await assert.rejects(mismatch.backend.readVersion(), /identity|model/i);
        assert.equal(mismatch.port.script.length, 0);
        assert.equal(mismatch.backend.closed, true);
        const modern = await connected(profile, [[command(0x42), reply('99', 1)]]);
        await assert.rejects(modern.backend.readVersion(), /identity|model/i);
        assert.equal(modern.port.script.length, 0);
        const valid = reply(profile.identity, 1), corrupt = valid.slice(); corrupt[corrupt.length - 1] ^= 1;
        assert.notEqual(corrupt[corrupt.length - 2] | corrupt[corrupt.length - 1] << 8, checksum(corrupt.subarray(0, -2)));
        const retry = await connected(profile, [[command(0x42), corrupt], [command(0x81), valid]]);
        assert.equal(await retry.backend.readVersion(), null);
        assert.equal(retry.port.script.length, 0); await retry.backend.close();
        const exhausted = await connected(profile, [[command(0x42), corrupt], [command(0x81), corrupt],
            [command(0x81), corrupt], [command(0x81)]]);
        await assert.rejects(exhausted.backend.readVersion(), /checksum|attempt/i);
        assert.equal(exhausted.port.script.length, 0); assert.equal(exhausted.backend.closed, true);
    }
    // The same checksum/retry rules apply to raw data phases, without adding
    // an image opcode to the retransmitted payload.
    {
        const profile = PROFILES[0], bitmap = new Uint8Array(profile.width * 8).fill(0x81);
        const valid = reply(profile.identity, bitmap), corrupt = valid.slice(); corrupt[corrupt.length - 2] ^= 1;
        const script = screenshotScript(profile, bitmap);
        script[3] = [ack, corrupt]; script.splice(4, 0, [command(0x81), valid]);
        const peer = await connected(profile, script);
        const image = await peer.backend.captureScreenshot();
        assert.deepEqual(image.rgba, sharp.decodeScreenshot(bitmap, profile.width, 64).rgba);
        assert.equal(peer.port.script.length, 0); await peer.backend.close();
    }
    {
        const profile = PROFILES[0], bitmap = new Uint8Array(profile.width * 8);
        const script = screenshotScript(profile, bitmap);
        script[2] = [ack, reply('95', Uint8Array.of(0x23, 0, 0, 0))];
        script.splice(3);
        const peer = await connected(profile, script);
        await assert.rejects(peer.backend.captureScreenshot(), /identity|model/i);
        assert.equal(peer.port.script.length, 0); assert.equal(peer.backend.closed, true);
    }
}

function nativeProgram(profile, selector, payload) {
    const header = new Uint8Array(54);
    header.set(ascii(profile.fileProfile + 'P')); header.set(selector, 2);
    header.set(ascii('Constructed CE-LK1P protocol test'), 13);
    return join(header, payload);
}

function uploadObject(selector, payload) {
    const length = 16 + payload.length;
    return join(Uint8Array.of(length & 255, length >> 8, 0x30, 0), selector, Uint8Array.of(0), payload);
}

function uploadScript(profile, selector, payload, selectors = []) {
    const object = uploadObject(selector, payload);
    const f = data => reply(profile.identity, data);
    return [...oneDirectory(profile, 'PROGRAM', selectors),
        [command(0x22), f(1)], [frame(join(categoryBytes('PROGRAM'), Uint8Array.of(object.length & 255, object.length >> 8))), f(1)],
        [frame(object), f(1)]];
}

async function checkProgramUploads() {
    for (const profile of PROFILES) {
        const category = backendCategories.find(c => c.ext === 'p');
        const receivedSelector = ascii('ORIGINAL'.padEnd(11, ' ')), selector = ascii('RENAMED'.padEnd(11, ' '));
        const payload = Uint8Array.of(0x21, 0x81, 0x84, 0x39, 0x34, 0x23);
        const peer = await connected(profile, [
            ...objectScript(profile, category, receivedSelector, join(Uint8Array.of(0), payload)),
            ...uploadScript(profile, selector, payload)
        ]);
        const received = await peer.backend.receiveVariable({ kind: 'sharp', name: 'ORIGINAL', category, selector: receivedSelector });
        const renamed = received.data.slice(); renamed.set(selector, 2);
        await peer.backend.sendFile(renamed, `RENAMED.g${profile.fileProfile}p`);
        assert.equal(peer.port.script.length, 0);
        assert.deepEqual(renamed.subarray(54), payload);
        assert.ok(!peer.port.writes.some(p => Buffer.from(p).equals(Buffer.from(command(0x41)))));
        await peer.backend.close();
        const duplicate = await connected(profile, oneDirectory(profile, 'PROGRAM', [selector]));
        await assert.rejects(duplicate.backend.sendFile(nativeProgram(profile, selector, payload), `RENAMED.g${profile.fileProfile}p`), /exist|duplicate/i);
        assert.equal(duplicate.port.script.length, 0);
        assert.ok(!duplicate.port.writes.some(p => Buffer.from(p).equals(Buffer.from(command(0x22)))));
        const valid = nativeProgram(profile, selector, payload);
        const wrongFamily = valid.slice(); wrongFamily[0] = (profile.fileProfile === '2' ? '3' : '2').charCodeAt(0);
        const unterminated = valid.slice(); unterminated[53] = 1;
        const nonProgram = valid.slice(); nonProgram[1] = 'E'.charCodeAt(0);
        const group = valid.slice(); group[1] = 'G'.charCodeAt(0);
        const backup = valid.slice(); backup[1] = 'B'.charCodeAt(0);
        for (const [data, filename] of [
            [wrongFamily, `RENAMED.g${String.fromCharCode(wrongFamily[0])}p`],
            [valid.slice(0, 53), `RENAMED.g${profile.fileProfile}p`],
            [unterminated, `RENAMED.g${profile.fileProfile}p`],
            [valid, `RENAMED.g${profile.fileProfile}s`], [valid, 'RENAMED.g4p'],
            [nonProgram, `RENAMED.g${profile.fileProfile}e`], [group, `RENAMED.g${profile.fileProfile}g`],
            [backup, `RENAMED.g${profile.fileProfile}b`], [ascii('Disp 1'), 'PROGRAM.txt'],
            [ascii('print(1)'), 'PROGRAM.py'],
            [nativeProgram(profile, selector, new Uint8Array(65520)), `RENAMED.g${profile.fileProfile}p`]
        ]) {
            const invalid = await connected(profile, []);
            await assert.rejects(invalid.backend.sendFile(data, filename), /unsupported|not supported|native|header|family|model|type|format|file|length|size|match|convert/i);
            assert.deepEqual(invalid.port.writes, [], 'invalid native uploads fail before handshake or any data write');
            await invalid.backend.close();
        }
    }
    const profile = PROFILES[0], selector = ascii('MEMTEST'.padEnd(11, ' ')), payload = Uint8Array.of(1, 2, 3);
    for (const rejectHeader of [false, true]) {
        const script = uploadScript(profile, selector, payload);
        if (rejectHeader) { script[script.length - 2][1] = reply(profile.identity, 0x84); script.pop(); }
        else { script[script.length - 3][1] = reply(profile.identity, 0x84); script.splice(script.length - 2); }
        const peer = await connected(profile, script);
        await assert.rejects(peer.backend.sendFile(nativeProgram(profile, selector, payload), 'MEMTEST.g2p'), /memory|0x84|error|reject/i);
        assert.equal(peer.port.script.length, 0); assert.equal(peer.backend.closed, true);
        assert.ok(!peer.port.writes.some(p => Buffer.from(p).equals(Buffer.from(frame(uploadObject(selector, payload))))),
            'memory refusal before the object phase never sends its body');
    }
}

async function checkUnsupportedOperations() {
    for (const profile of PROFILES) {
        for (const [method, args] of [
            ['receiveBackup', []],
            ['receiveDump', [{ includeBoot: false }]], ['receiveDump', [{ includeBoot: true }]],
            ['configureSerial', [38400, 2]], ['reopen', [38400, 2]]
        ]) {
            const peer = await connected(profile, []);
            assert.equal(typeof peer.backend[method], 'function');
            await assert.rejects(peer.backend[method](...args), /unsupported|not supported|read.only|unavailable/i);
            assert.deepEqual(peer.port.writes, [], `${method} must reject before any wire command`);
            await peer.backend.close();
        }
    }
}

async function checkRepeatedOperations() {
    const profile = PROFILES[1], bitmap = new Uint8Array(profile.width * 8).fill(0x55);
    const script = [[command(0x42), reply(profile.identity, 1)],
        ...screenshotScript(profile, bitmap), ...directoryScript(profile, {})];
    const peer = await connected(profile, script);
    assert.equal(await peer.backend.readVersion(), null);
    assert.equal(peer.backend.closed, false);
    assert.equal((await peer.backend.captureScreenshot()).rgba.length, profile.width * 64 * 4);
    assert.deepEqual(await peer.backend.listVariables(), []);
    assert.equal(peer.port.script.length, 0);
    assert.equal(peer.backend.closed, false, 'successful read operations keep the serial connection available');
    await peer.backend.close();
}

async function main() {
    await checkSerialAndHandshake();
    await checkScreenshots();
    await checkDirectories();
    await checkVariableReception();
    await checkIdentityAndChecksumFailures();
    await checkProgramUploads();
    await checkUnsupportedOperations();
    await checkRepeatedOperations();
    console.log('Sharp legacy constructed wire-transcript tests passed (no hardware validation)');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
