'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { SharpBackend, DumpReceiver, CATEGORIES, RAM_SIZE, frame, checksum,
    decodeNative, encodeNative, nativeHeader, decodeScreenshot } = require('../sharp_backend.js');
const ascii = s => Uint8Array.from(Buffer.from(s, 'latin1'));
const cat = c => ascii(c.name.padEnd(11, ' '));
const join = (...parts) => Uint8Array.from(Buffer.concat(parts.map(p => Buffer.from(p))));
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const command = n => frame(Uint8Array.of(n));
const reply = (data, identity = '99') => frame(typeof data === 'number' ? Uint8Array.of(data) : data, identity);
const ack = command(1);
// Scripted peer checks each entire outgoing packet and fragments every response.
// It is a wire transcript peer, not a calculator firmware emulator.
class Port {
    constructor(script = []) { this.script = [...script]; this.options = []; this.writes = []; this.closed = 0; }
    async open(options) {
        this.options.push(options);
        this.readable = new ReadableStream({ start: c => { this.controller = c; }, cancel() {} });
        this.writable = new WritableStream({ write: packet => {
            this.writes.push(packet.slice());
            const step = this.script[0];
            assert.ok(step, 'no unsolicited wire commands');
            const offset = this.packetOffset || 0;
            assert.ok(offset + packet.length <= step[0].length, 'write stays within its frame');
            assert.deepEqual(packet, new Uint8Array(step[0]).slice(offset, offset + packet.length), `wire packet ${this.writes.length}`);
            this.packetOffset = offset + packet.length;
            if (this.packetOffset === step[0].length) {
                this.packetOffset = 0; this.script.shift();
                if (step[1]) this.feed(step[1]);
            }
        } });
    }
    feed(data) {
        for (let i = 0; i < data.length; i += 127) this.controller.enqueue(data.slice(i, i + 127));
    }
    async close() { this.closed++; this.readable = null; this.writable = null; }
}
async function connected(script, options = {}) {
    const port = new Port(script), backend = new SharpBackend({ serialPort: port, timeoutMs: 200, ...options });
    await backend.connect(); return { port, backend };
}
// EL-9950G 1.20 native capture: count=2 but 29 fixed descriptors, valid
// checksum 07EF. L1 and its internal 0840 working copy are populated.
const matrixWire = Uint8Array.from(Buffer.from("393a021008400300010000001000110800000001000f000000120800000001000f000000130800000001000f000000140800000001000f000000150800000001000f000000160800000001000f000000170800000001000f000000200840000001000f000000210840000001000f000000220840000001000f000000230800000001000f000000240800000001000f000000250800000001002a0000004008400300010000001000410800000001000f000000420800000001000f000000430800000001000f000000100900000000000f000000110900000000000f000000120900000000000f000000130900000000000f000000140900000000000f000000150900000000000f000000160900000000000f000000170900000000000f000000180900000000000f000000190900000000000f0000003009000000000000000000ef07", 'hex'));
const matrixDirectory = matrixWire.subarray(2, -2);
const directory = (c, selectors = []) => [[command(0x61), reply(1)], [frame(cat(c)), join(reply(1), reply(0x21))],
    [ack, reply(cat(c))], [ack, reply(join([selectors.length], ...selectors))], [ack]];
const session = steps => [[command(0x42), reply(1)], ...steps, [command(0x41), reply(1)]];
async function main() {
    assert.deepEqual([...command(0x42)], [0x31, 0x31, 0x42, 0xA4, 0]);
    assert.deepEqual([...reply(1)], [0x39, 0x39, 1, 0x73, 0]);
    const bitmap = new Uint8Array(1056); bitmap[0] = 0x81; bitmap[132 + 1] = 0x40;
    const screen = decodeScreenshot(bitmap);
    const pixel = (x, y) => screen.rgba[(y * 132 + x) * 4];
    assert.equal(pixel(0, 0), 0); assert.equal(pixel(0, 7), 0); assert.equal(pixel(1, 9), 0);
    assert.equal(pixel(0, 1), 255); assert.throws(() => decodeScreenshot(bitmap, 128, 64));
    for (const identity of ['99', '9:']) {
        const model = identity === '9:' ? 'sharp-el9950' : 'sharp-el9900';
        const f = p => reply(p, identity);
        const progress = [];
        const { port, backend } = await connected([[command(0x42), f(1)], [command(0x63), join(f(1), f(0x23))],
            [ack, f(Uint8Array.of(132, 0, 64, 0))], [ack, f(bitmap)], [ack]], {
                model, onProgress: p => progress.push(p) });
        const result = await backend.captureScreenshot();
        assert.deepEqual(result.rgba, screen.rgba);
        assert.ok(progress.some(p => p.total === 1056 && p.completed > 0 && p.completed < 1056));
        assert.deepEqual(progress.at(-1), {completed: 1056, total: 1056}, 'final ACK does not erase progress');
        assert.equal(port.options[0].baudRate, 38400); assert.equal(port.options[0].stopBits, 2);
        assert.equal(port.script.length, 0); await backend.close();
    }
    const program = CATEGORIES.find(c => c.ext === 'p');
    const selector = ascii('HERON\0\0\0\0\0\0');
    const object = join(u32(24), u32(48), selector, [0], [0x0A, 0x10, 0xFD, 0xFF]);
    const native = encodeNative(program, object, selector, "Heron's Formula");
    const decoded = decodeNative(native, 'Heron.G4P');
    assert.deepEqual(decoded.object, object);
    assert.deepEqual(encodeNative(decoded.category, decoded.object, decoded.selector, decoded.description), native);
    assert.throws(() => decodeNative(native, 'Heron.g4m'), /disagree/);
    assert.throws(() => decodeNative(native.slice(0, 53)), /header/);
    const backup = join(nativeHeader('b', ascii('BACKUP\0\0\0\0\0'), 'WebTiLP sharp-el9900'), new Uint8Array(RAM_SIZE));
    assert.throws(() => decodeNative(backup.slice(0, -1)), /size/);
    const list = CATEGORIES.find(c => c.ext === 'l'), fixedSelector = Uint8Array.of(0x10, 8, 32, 32, 32, 32, 32, 32, 32, 32, 32);
    const fixedObject = join(u32(13), u32(48), fixedSelector.subarray(0, 2), [7, 8, 9]);
    assert.deepEqual(decodeNative(encodeNative(list, fixedObject, fixedSelector)).object, fixedObject);
    // Fixed variables/zoom/window/table have dedicated length/body commands.
    for (const category of CATEGORIES.filter(c => c.command)) {
        const body = new Uint8Array(category.size).fill(category.command);
        const fixed = await connected(session([[command(category.command), join(reply(1), reply(category.command - 0x40))],
            [ack, reply(u32(body.length))], [ack, reply(body)], [ack]]));
        const received = await fixed.backend.receiveVariable({ category, selector: new Uint8Array(11), name: category.name });
        assert.deepEqual(decodeNative(received.data, received.filename).object, body);
        assert.equal(fixed.port.script.length, 0); await fixed.backend.close();
        const upload = await connected(session([[command(category.command - 0x40), reply(1)],
            [frame(u32(body.length)), reply(1)], [frame(body), reply(1)]]));
        await upload.backend.sendFile(received.data, received.filename);
        assert.equal(upload.port.script.length, 0); await upload.backend.close();
    }
    // MATRIX subtype 08 is LIST on disk, retaining the binary selector in its body.
    {
        const nativeList = encodeNative(list, fixedObject, fixedSelector);
        const download = await connected(session([[command(0x62), reply(1)], [frame(cat(list)), reply(1)],
            [frame(fixedSelector), reply(0x22)], [ack, reply(join(cat(list), u32(fixedObject.length)))],
            [ack, reply(fixedObject)], [ack]]));
        const received = await download.backend.receiveVariable({ category: list, selector: fixedSelector, name: 'LIST 16' });
        assert.deepEqual(received.data, nativeList); await download.backend.close();
        const upload = await connected(session([[command(0x22), reply(1)],
            [frame(join(cat(list), u32(fixedObject.length))), reply(1)], [frame(fixedObject), reply(1)]]));
        await upload.backend.sendFile(nativeList, 'LIST.g4l');
        assert.equal(upload.port.script.length, 0); await upload.backend.close();
    }
    // Upload sends one complete RAM object, without replaying header/body separately.
    {
        const { port, backend } = await connected(session([...directory(program), [command(0x22), reply(1)],
            [frame(join(cat(program), u32(object.length))), reply(1)], [frame(object), reply(1)]]));
        await backend.sendFile(native, 'HERON.g4p'); assert.equal(port.script.length, 0); await backend.close();
    }
    // The physical firmware appends same-name programs. Stop before upload.
    {
        const peer = await connected([[command(0x42), reply(1)], ...directory(program, [selector])]);
        await assert.rejects(peer.backend.sendFile(native, 'HERON.g4p'), /already exists/);
        assert.equal(peer.port.script.length, 0);
        assert.ok(!peer.port.writes.some(p => Buffer.from(p).equals(Buffer.from(command(0x22)))));
    }
    // Both receive-session modes: optional framed ACK before 22.
    for (const optionalAck of [false, true]) {
        const { port, backend } = await connected(session([[command(0x62), reply(1)], [frame(cat(program)), reply(1)],
            [frame(selector), join(...(optionalAck ? [reply(1)] : []), reply(0x22))],
            [ack, reply(join(cat(program), u32(object.length)))], [ack, reply(object)], [ack]]));
        const result = await backend.receiveVariable({ category: program, selector, name: 'HERON' });
        assert.deepEqual(decodeNative(result.data).object, object); assert.equal(port.script.length, 0); await backend.close();
    }
    // Directory has a count-dependent payload inside a single frame.
    {
        const steps = [];
        for (const c of CATEGORIES.filter(c => !c.command && !c.alias)) {
            steps.push([command(0x61), reply(1)], [frame(cat(c)), join(reply(1), reply(0x21))],
                [ack, reply(cat(c))], [ack, reply(c === program ? join([1], selector)
                    : c.name === 'MATRIX' ? matrixDirectory : [0])], [ack]);
        }
        const { port, backend } = await connected(session(steps));
        const entries = await backend.listVariables();
        assert.equal(entries.length, 6); assert.equal(entries[0].name, 'HERON');
        assert.equal(entries[1].category, list); assert.equal(entries[1].type_name, 'LIST');
        assert.equal(entries[1].name, 'L1');
        assert.equal(entries[0].category, program); assert.equal(port.script.length, 0); await backend.close();
    }
    // Directory receive lengths follow the full fixed table, not the
    // filtered count; a 324-byte hardware frame must never elicit a mid-frame NAK.
    {
        assert.equal(matrixWire.length, 324);
        assert.equal(new DataView(matrixWire.buffer).getUint16(matrixWire.length - 2, true), checksum(matrixWire.subarray(0, -2)));
        const matrix = CATEGORIES.find(c => c.ext === 'm');
        const steps = [
            [command(0x42), reply(1, '9:')], [command(0x61), reply(1, '9:')],
            [frame(cat(matrix)), join(reply(1, '9:'), reply(0x21, '9:'))],
            [ack, reply(cat(matrix), '9:')], [ack, matrixWire], [ack], [command(0x41), reply(1, '9:')]
        ];
        const {backend, port} = await connected(steps);
        const data = await backend.operation(() => backend.readDirectory(matrix));
        assert.equal(data[0], 1, 'only public populated L1 is visible');
        assert.deepEqual(data.subarray(1, 3), Uint8Array.of(0x10, 8));
        assert.ok(!port.writes.some(p => Buffer.from(p).equals(Buffer.from(command(0x81)))));
        assert.equal(port.script.length, 0); await backend.close();
        // A complete corrupt fixed table still uses the ordinary bounded NAK
        // retry, and the returned data is always checksum-validated.
        const corrupt = matrixWire.slice(); corrupt[corrupt.length - 2] ^= 1;
        const retrySteps = steps.map(step => [...step]); retrySteps[4] = [ack, corrupt];
        retrySteps.splice(5, 0, [command(0x81), matrixWire]);
        const retry = await connected(retrySteps);
        assert.equal((await retry.backend.operation(() => retry.backend.readDirectory(matrix)))[0], 1);
        assert.equal(retry.port.script.length, 0); await retry.backend.close();
        const bad = await connected([[command(0x42), reply(1)],
            [command(0x61), reply(1)], [frame(cat(matrix)), join(reply(1), reply(0x21))],
            [ack, reply(cat(matrix))], [ack, reply([30])]]);
        await assert.rejects(bad.backend.operation(() => bad.backend.readDirectory(matrix)), /fixed-directory count/);
        assert.equal(bad.backend.closed, true);
    }
    // PICT has the same filtered-count/full-table mismatch. Empty objects are
    // 11 bytes; an all-white picture has zero pixels but is still a real file.
    {
        const pict = CATEGORIES.find(c => c.ext === 'i'), steps = [];
        const selectors = Array.from({length: 10}, (_, i) => Uint8Array.from([0x10 + i, 13, ...new Uint8Array(9)]));
        for (const category of CATEGORIES.filter(c => !c.command && !c.alias)) {
            if (category !== pict) { steps.push(...directory(category)); continue; }
            const dir = directory(category, selectors);
            dir[3] = [ack, reply(join([1], ...selectors))]; steps.push(...dir);
            for (let i = 0; i < selectors.length; i++) {
                const body = new Uint8Array(i === 9 ? 1027 : 11);
                new DataView(body.buffer).setUint32(0, body.length, true);
                new DataView(body.buffer).setUint32(4, 48, true); body.set(selectors[i].subarray(0, 2), 8);
                steps.push([command(0x62), reply(1)], [frame(cat(pict)), reply(1)],
                    [frame(selectors[i]), reply(0x22)], [ack, reply(join(cat(pict), u32(body.length)))],
                    [ack, reply(body)], [ack]);
            }
        }
        const peer = await connected(session(steps));
        const entries = await peer.backend.listVariables();
        const pictures = entries.filter(e => e.category === pict);
        assert.equal(pictures.length, 1); assert.equal(pictures[0].name, 'Pict0'); assert.equal(pictures[0].size, 1019);
        assert.equal(peer.port.script.length, 0); await peer.backend.close();
    }
    // Native backup uses 67/27, no directory or variable enumeration.
    {
        const data = new Uint8Array(RAM_SIZE).fill(17);
        const { port, backend } = await connected(session([[command(0x67), join(reply(1), reply(0x27))],
            [ack, reply(u32(RAM_SIZE))], [ack, reply(data)], [ack]]), { model: 'sharp-el9900' });
        const result = await backend.receiveBackup(); assert.deepEqual(decodeNative(result.data).data, data);
        assert.equal(port.script.length, 0); await backend.close();
        const restore = await connected([[command(0x42), reply(1)], [command(0x27), reply(1)],
            [frame(u32(RAM_SIZE)), reply(1)], [frame(data), reply(1)]], { model: 'sharp-el9900' });
        await restore.backend.sendFile(result.data, result.filename, { allowRestore: true });
        assert.equal(restore.backend.closed, true, 'restore closes a session whose RAM was replaced');
        assert.equal(restore.port.script.length, 0); await restore.backend.close();
        const mismatch = await connected([], { model: 'sharp-el9950' });
        await assert.rejects(mismatch.backend.sendFile(result.data, result.filename, { allowRestore: true }), /different/);
        assert.equal(mismatch.port.writes.length, 0); await mismatch.backend.close();
    }
    // A progressing backup may outlast the inactivity timeout. Report payload
    // progress before the complete frame arrives, not just after one huge read.
    {
        const data = new Uint8Array(RAM_SIZE).fill(19), progress = [];
        class SlowPort extends Port {
            feed(packet) {
                if (packet.length < RAM_SIZE) return super.feed(packet);
                for (let offset = 0; offset < packet.length; offset += 4096) {
                    setTimeout(() => this.controller.enqueue(packet.slice(offset, offset + 4096)), offset / 4096 * 15);
                }
            }
        }
        const script = session([[command(0x67), join(reply(1), reply(0x27))],
            [ack, reply(u32(RAM_SIZE))], [ack, reply(data)], [ack]]);
        const port = new SlowPort(script), backend = new SharpBackend({ serialPort: port,
            model: 'sharp-el9900', timeoutMs: 80, onProgress: p => progress.push(p) });
        await backend.connect();
        const started = Date.now(), result = await backend.receiveBackup();
        assert.ok(Date.now() - started > backend.timeoutMs, 'total frame time exceeds timeout');
        assert.deepEqual(decodeNative(result.data).data, data);
        assert.ok(progress.some(p => p.total === RAM_SIZE && p.completed > 0 && p.completed < RAM_SIZE));
        assert.deepEqual(progress.at(-1), { completed: RAM_SIZE, total: RAM_SIZE });
        assert.equal(port.script.length, 0); await backend.close();

        const stalledProgress = [];
        const stalled = await connected([[command(0x42), reply(1)],
            [command(0x67), join(reply(1), reply(0x27))], [ack, reply(u32(RAM_SIZE))],
            [ack, reply(data).slice(0, 1024)]], { model: 'sharp-el9900', timeoutMs: 20,
                onProgress: p => stalledProgress.push(p) });
        await assert.rejects(stalled.backend.receiveBackup(), /without data \(1024\/58157 bytes received\)/);
        assert.ok(stalled.backend.closed);
        assert.ok(stalledProgress.some(p => p.completed > 0));
        assert.ok(!stalledProgress.some(p => p.completed === RAM_SIZE));
        assert.equal(stalled.port.writes.length, 4, 'no replay or ACK of a truncated backup');

        const sentProgress = [];
        const upload = await connected([[command(0x42), reply(1)], [command(0x27), reply(1)],
            [frame(u32(RAM_SIZE)), reply(1)], [frame(data), reply(1)]], {
                model: 'sharp-el9900', onProgress: p => sentProgress.push(p) });
        await upload.backend.sendFile(result.data, result.filename, { allowRestore: true });
        assert.ok(sentProgress.some(p => p.completed > 0 && p.completed < RAM_SIZE));
        assert.deepEqual(sentProgress.at(-1), { completed: RAM_SIZE, total: RAM_SIZE });
        assert.equal(upload.port.script.length, 0, 'chunked writes preserve the complete wire frame');

        const failedProgress = [];
        const failed = await connected([[command(0x42), reply(1)], [command(0x27), reply(1)],
            [frame(u32(RAM_SIZE)), reply(1)], [frame(data), reply(1)]], {
                model: 'sharp-el9900', onProgress: p => failedProgress.push(p) });
        const originalWrite = failed.backend.writer.write.bind(failed.backend.writer);
        let payloadWrites = 0;
        failed.backend.writer.write = async packet => {
            if (packet.length > 100 && ++payloadWrites === 2) throw new Error('Partial USB write');
            return originalWrite(packet);
        };
        await assert.rejects(failed.backend.sendFile(result.data, result.filename, {allowRestore: true}), /Partial USB write/);
        assert.equal(payloadWrites, 2, 'a failed payload write is never replayed');
        assert.ok(failed.backend.closed);
        assert.ok(!failedProgress.some(p => p.completed === RAM_SIZE));

        const corrupt = reply(data); corrupt[corrupt.length - 1] ^= 1;
        const corruptProgress = [];
        const bad = await connected([[command(0x42), reply(1)],
            [command(0x67), join(reply(1), reply(0x27))], [ack, reply(u32(RAM_SIZE))],
            [ack, corrupt], [command(0x81), corrupt], [command(0x81), corrupt], [command(0x81)]], {
                model: 'sharp-el9900', onProgress: p => corruptProgress.push(p) });
        await assert.rejects(bad.backend.receiveBackup(), /checksum/);
        assert.ok(!corruptProgress.some(p => p.completed === RAM_SIZE), 'bad checksums never reach 100%');
    }
    // Complete frame NAK retries, checksum recovery, error and timeout teardown.
    {
        const corrupt = reply(1); corrupt[3] ^= 1;
        const { backend, port } = await connected([[command(0x42), corrupt], [command(0x81), reply(1)],
            [command(0x41), reply(1)]]);
        await backend.operation(async () => 1); assert.equal(port.script.length, 0); await backend.close();
        const retry = await connected([[command(0x42), reply(0x81)], [command(0x42), reply(1)], [command(0x41), reply(1)]]);
        await retry.backend.operation(async () => 1); await retry.backend.close();
        const rejected = await connected([[command(0x42), reply(0x84)]]);
        await assert.rejects(rejected.backend.operation(async () => 1), /memory/); assert.equal(rejected.backend.closed, true);
        const timeout = await connected(Array.from({length: 5}, () => [command(0x42)]), { timeoutMs: 10 });
        await assert.rejects(timeout.backend.operation(async () => 1), /timed out/); assert.equal(timeout.backend.closed, true);
        const cancelled = await connected([[command(0x42)]]);
        const pending = cancelled.backend.captureScreenshot();
        await new Promise(resolve => setTimeout(resolve, 5)); await cancelled.backend.close();
        await assert.rejects(pending, /cancelled/); assert.equal(cancelled.backend.busy, false);
    }
    {
        const { backend, port } = await connected([[command(0x42), reply(1, '9:')],
            [command(0x74), reply(ascii('120000'), '9:')], [command(0x41), reply(1, '9:')]], { model: 'sharp-el9950' });
        assert.equal(await backend.readVersion(), '1.20'); assert.equal(port.script.length, 0); await backend.close();
    }
    // Auto identifies only checksum-validated 9: replies. Ambiguous 99 peers
    // must never receive 74 unless the user explicitly selected SII.
    {
        const peer = await connected([[command(0x42), reply(1, '9:')],
            [command(0x74), reply(ascii('120000'), '9:')], [command(0x41), reply(1, '9:')]]);
        assert.equal(peer.port.writes.length, 0, 'connect remains passive for REPROGRAM');
        assert.equal(await peer.backend.readVersion(), '1.20');
        assert.equal(peer.backend.model, 'sharp-el9950'); assert.equal(peer.backend.version, '1.20');
        assert.equal(peer.port.script.length, 0); await peer.backend.close();

        const ambiguous = await connected(session([]));
        assert.equal(await ambiguous.backend.readVersion(), null);
        assert.equal(ambiguous.backend.model, 'sharp-auto');
        assert.equal(ambiguous.port.script.length, 0); await ambiguous.backend.close();
        const corrupt = reply(1, '9:'); corrupt[4] ^= 1;
        const untrusted = await connected([[command(0x42), corrupt], [command(0x81), reply(1)],
            [command(0x41), reply(1)]]);
        assert.equal(await untrusted.backend.readVersion(), null);
        assert.equal(untrusted.backend.model, 'sharp-auto');
        assert.equal(untrusted.backend.identity, '99'); await untrusted.backend.close();
        for (const model of ['sharp-el9900', 'sharp-el9900g']) {
            const old = await connected([], {model});
            assert.equal(await old.backend.readVersion(), null);
            assert.equal(old.port.writes.length, 0); await old.backend.close();
        }
        const sii = await connected(session([[command(0x74), reply(ascii('410000'))]]), {model: 'sharp-el9900gsii'});
        assert.equal(await sii.backend.readVersion(), '4.10'); await sii.backend.close();
        const mismatch = await connected([[command(0x42), reply(1, '9:')]], {model: 'sharp-el9900gsii'});
        await assert.rejects(mismatch.backend.readVersion(), /model does not match/);
        assert.equal(mismatch.port.writes.length, 1);

        const data = new Uint8Array(RAM_SIZE).fill(23), f = p => reply(p, '9:');
        const backup = await connected([[command(0x42), f(1)], [command(0x41), f(1)],
            [command(0x42), f(1)], [command(0x67), join(f(1), f(0x27))],
            [ack, f(u32(RAM_SIZE))], [ack, f(data)], [ack], [command(0x41), f(1)]]);
        const result = await backup.backend.receiveBackup();
        assert.equal(result.filename, 'sharp-el9950.g4b');
        assert.equal(decodeNative(result.data).description, 'WebTiLP sharp-el9950');
        assert.deepEqual(decodeNative(result.data).data, data);
        assert.equal(backup.port.script.length, 0); await backup.backend.close();
        const unknown = await connected(session([]));
        await assert.rejects(unknown.backend.receiveBackup(), /Select the exact Sharp model/);
        assert.equal(unknown.port.script.length, 0, 'ambiguous probe ends without requesting backup');
        assert.equal(unknown.backend.closed, false); await unknown.backend.close();
    }
    // Automatic connection info leaves a completely silent transport usable
    // for REPROGRAM, but never keeps a partial or rejected PC-Link session.
    {
        const silent = await connected(Array.from({length: 5}, () => [command(0x42)]), {timeoutMs: 5});
        await assert.rejects(silent.backend.readVersion({keepOpenOnSilentStart: true}), /timed out/);
        assert.equal(silent.backend.closed, false); assert.equal(silent.backend.cancelled, false);
        assert.equal(silent.backend.busy, false); assert.equal(silent.port.script.length, 0);
        await silent.backend.close();
        const partial = await connected([[command(0x42), reply(1).slice(0, 1)]], {timeoutMs: 5});
        await assert.rejects(partial.backend.readVersion({keepOpenOnSilentStart: true}), /timed out/);
        assert.equal(partial.backend.closed, true); assert.equal(partial.port.writes.length, 1);
        const rejected = await connected([[command(0x42), reply(0x84)]]);
        await assert.rejects(rejected.backend.readVersion({keepOpenOnSilentStart: true}), /memory/);
        assert.equal(rejected.backend.closed, true);
    }
    // Hardware wake-up: retry silent session starts on every operation, never
    // replay a partial response, a failed write, or a command inside a session.
    {
        const start = command(0x42), endSession = [command(0x41), reply(1)];
        const retry = await connected([[start], [start], [start, reply(1)], endSession,
            [start], [start], [start, reply(1)], endSession], { timeoutMs: 10 });
        await retry.backend.operation(async () => 1);
        await retry.backend.operation(async () => 2);
        assert.equal(retry.port.script.length, 0); await retry.backend.close();
        // Prefix already consumed before checksum times out: queue alone would
        // look empty. The monotonic received-byte counter prevents a replay.
        for (const partial of [reply(1).slice(0, 1), reply(1).slice(0, 3)]) {
            const peer = await connected([[start, partial]], { timeoutMs: 10 });
            await assert.rejects(peer.backend.operation(async () => 1), /timed out/);
            assert.equal(peer.port.writes.length, 1);
        }
        const dataTimeout = await connected([[start, reply(1)], [command(0x61)]], { timeoutMs: 10 });
        await assert.rejects(dataTimeout.backend.operation(() => dataTimeout.backend.command(0x61)), /timed out/);
        assert.equal(dataTimeout.port.writes.length, 2);
        const failed = await connected([], { timeoutMs: 10 });
        failed.backend.writer.write = async () => { throw new Error('Partial USB write'); };
        await assert.rejects(failed.backend.operation(async () => 1), /Partial USB write/);
        assert.equal(failed.port.writes.length, 0);
    }
    // Reject malformed dumps, reconstruct erased gaps, and never expose partial images.
    const packet = (address, payload) => {
        const h = Buffer.alloc(6); h.writeUInt32LE(address); h.writeUInt16LE(payload.length, 4);
        const body = join(h, payload), sum = checksum(body); return join(body, [sum & 255, sum >>> 8]);
    };
    // Run the full backend around both baud transitions. A synthetic peer waits
    // for each OK and delivers data on the reopened port, like a paced sender.
    class DumpPort extends Port {
        constructor(includeBoot, firstBlock = first) {
            super(); this.includeBoot = includeBoot; this.bootPending = includeBoot;
            this.systemPending = false; this.bootSent = false; this.firstBlock = firstBlock;
        }
        async open(options) {
            this.options.push(options);
            this.readable = new ReadableStream({ start: controller => {
                this.controller = controller;
                if (options.stopBits === 1) {
                    if (!this.headerSent) {
                        this.headerSent = true;
                        controller.enqueue(packet(0, [57, 57, 1, 0x80, this.includeBoot ? 1 : 0]));
                    } else if (this.systemPending) this.feed(this.firstBlock);
                }
            } });
            this.writable = new WritableStream({ write: value => {
                this.writes.push(value);
                if (Buffer.from(value).toString() === 'NG') { this.rejected = true; return; }
                assert.equal(Buffer.from(value).toString(), 'OK');
                if (this.bootPending) {
                    this.bootPending = false; this.bootSent = true;
                    this.controller.enqueue(packet(0xFFE000, new Uint8Array(0x2000).fill(7)));
                } else if (this.bootSent) { this.bootSent = false; this.systemPending = true; }
                else if (!this.systemPending) this.systemPending = true;
                else if (!this.endSent) { this.endSent = true; this.controller.enqueue(end); }
            } });
        }
    }
    const header = boot => packet(0, [57, 57, 1, 0x80, boot ? 1 : 0]);
    const end = packet(0xFFFFFFFF, []), first = packet(0xF00000, new Uint8Array(0x4000).fill(5));
    const payload = Uint8Array.from({ length: 0x4000 }, (_, i) => (0x81 + i) & 255);
    const recoverable = packet(0xF00000, payload);
    // Actual damaged prefix from the separately validated receiver's capture:
    // two header bytes lost, four garbled; payload and trailing checksum intact.
    const damaged = join([0x18, 0x1C, 0x10, 0xFF], recoverable.subarray(6));
    // EL-9950G full-ROM WebUSB retest: three garbled bytes after the boot ACK.
    const damagedAfterBoot = join([0x10, 0x1E, 0x10], recoverable.subarray(6));
    class InPlaceDumpPort extends DumpPort {
        async setOptions(options) {
            (this.configurations ??= []).push(options);
            if (options.baudRate === 19200) this.feed(header(this.includeBoot));
            else if (options.stopBits === 1) this.feed(this.firstBlock);
        }
    }
    for (const includeBoot of [false, true]) for (const firstBlock of [first, damaged, damagedAfterBoot]) for (const inPlace of [false, true]) {
        const port = new (inPlace ? InPlaceDumpPort : DumpPort)(includeBoot, firstBlock);
        const backend = new SharpBackend({ serialPort: port, timeoutMs: 200 });
        await backend.connect(); const result = await backend.receiveDump({ includeBoot });
        assert.equal(result.manifest.complete, true);
        assert.equal(result.data.length, includeBoot ? 0x100000 : 0xFC000);
        assert.deepEqual(result.data.subarray(0, 0x4000), firstBlock === first ? first.subarray(6, -2) : payload);
        assert.equal(Boolean(result.manifest.recoveredFirstHeader), firstBlock !== first);
        if (firstBlock !== first) assert.deepEqual(result.manifest.recoveredFirstHeader.rawPrefix,
            Array.from(firstBlock.subarray(0, firstBlock.length - 0x4000 - 2)));
        if (inPlace) {
            assert.equal(port.options.length, 1); assert.equal(port.closed, 0, 'no port closure at baud transitions');
            assert.deepEqual(port.configurations.map(o => [o.baudRate, o.stopBits]), [[19200, 1], [38400, 1], [38400, 2]]);
        } else assert.deepEqual(port.options.map(o => [o.baudRate, o.stopBits]), [[38400, 2], [19200, 1], [38400, 1], [38400, 2]]);
        assert.equal(port.writes.length, includeBoot ? 4 : 3);
        assert.equal(backend.closed, false); await backend.close();
    }
    // Recovery is restricted to the first system frame at the fast-baud
    // transition, including after boot; require every payload byte and checksum.
    for (const includeBoot of [false, true]) for (let prefixLength = 0; prefixLength <= 6; prefixLength++) {
        const rx = new DumpReceiver({ recoverFirstHeader: true }); rx.push(header(includeBoot));
        if (includeBoot) rx.push(packet(0xFFE000, new Uint8Array(0x2000).fill(7)));
        const wire = join(new Uint8Array(prefixLength).fill(0xAA), recoverable.subarray(6));
        for (let offset = 0; offset < wire.length; offset += 7) rx.push(wire.subarray(offset, offset + 7));
        assert.equal(rx.systemBlocks, 1); assert.deepEqual(rx.image.subarray(0, payload.length), payload);
        assert.equal(rx.manifest().recoveredFirstHeader.rawPrefix.length, prefixLength);
        assert.equal(rx.manifest().recoveredFirstHeader.payloadOffset, prefixLength);
        rx.push(end); assert.equal(rx.complete, true);
        assert.throws(() => rx.push([1]), /Unexpected/); assert.equal(rx.complete, false);
    }
    const recoveryStart = (boot = false, mode = 0x80) => {
        const rx = new DumpReceiver({ recoverFirstHeader: true }); rx.push(packet(0, [57, 57, 1, mode, Number(boot)])); return rx;
    };
    const corruptPayload = damaged.slice(); corruptPayload[400] ^= 1;
    const corruptChecksum = damaged.slice(); corruptChecksum[corruptChecksum.length - 1] ^= 1;
    for (const firstBlock of [corruptPayload, damaged.subarray(0, -1)]) {
        const port = new InPlaceDumpPort(false, firstBlock);
        const backend = new SharpBackend({serialPort: port, timeoutMs: 10});
        await backend.connect();
        await assert.rejects(backend.receiveDump(), firstBlock === corruptPayload ? /checksum/ : /REPROGRAM timed out.*2:Send/);
        assert.equal(backend.closed, true); assert.equal(port.rejected, true, 'invalid/incomplete frame gets NG, never OK');
    }
    const missingPayload = join(damaged.subarray(0, 100), damaged.subarray(101), end);
    const missingPrefix = join(damaged.subarray(0, 4), damaged.subarray(5));
    const excessPrefix = join(new Uint8Array(7).fill(0xAA), recoverable.subarray(6));
    for (const bad of [corruptPayload, corruptChecksum, missingPayload, missingPrefix, excessPrefix]) {
        const rx = recoveryStart();
        assert.throws(() => rx.push(bad), /checksum|prefix/); assert.equal(rx.complete, false);
    }
    const truncated = recoveryStart(); truncated.push(damaged.subarray(0, -1));
    assert.equal(truncated.complete, false); assert.equal(truncated.blocks.length, 0);
    const later = recoveryStart(); later.push(recoverable); assert.throws(() => later.push(damaged), /Invalid/);
    const bootDamage = recoveryStart(true); assert.throws(() => bootDamage.push(damaged), /boot block/);
    const slowMode = recoveryStart(false, 0x70); assert.throws(() => slowMode.push(damaged), /system block/);
    const strict = new DumpReceiver(); strict.push(header(false)); assert.throws(() => strict.push(damaged), /system block/);
    const receiver = new DumpReceiver();
    for (const byte of join(header(false), first, end)) receiver.push(Uint8Array.of(byte));
    assert.equal(receiver.complete, true); assert.equal(receiver.image.length, 0xFC000);
    assert.equal(receiver.image[0x4000], 255); assert.equal(receiver.manifest().blocks.length, 1);
    assert.throws(() => receiver.push([1]), /Unexpected/); assert.equal(receiver.complete, false);
    for (const bad of [join(header(false), end), join(header(false), first, first), join(header(true), end),
        join(header(false), first.slice(0, -1), [0], end)]) {
        assert.throws(() => new DumpReceiver().push(bad));
    }
    const incomplete = new DumpReceiver(); incomplete.push(join(header(false), first.slice(0, -1))); assert.equal(incomplete.complete, false);
    // Optional external ROM corpus: synthetic sparse captures of every supplied ROM
    // must reconstruct all bytes and original hashes. No copyrighted ROM fixture committed.
    if (process.env.SHARP_DUMPS_DIR) {
        let referenceCore;
        for (const [name, expected] of Object.entries({
            'el9900_1.09_and_boot.bin': '3b9a9599c49d915fcce9dd23315d5e23540edaa508dcf8c3034b370ab93e776c',
            'el9900g_3.01_and_boot.bin': 'f1c62cdfbeda144a7c32333a501823469fa705ffb19353c49a9a8d3baa79b0fb',
            'el9900gs2_4.10_and_boot.bin': 'eb3dd761732315df152ac98bb43cfa412e46b4ac15cab847ce944d69f219d37a',
            'el9950_1.20_and_boot.bin': 'deae0913c635b02e5b273db20905fa57993ec035edb7cbf78f08f9bc79f42082'
        })) {
            const rom = fs.readFileSync(`${process.env.SHARP_DUMPS_DIR}/${name}`);
            assert.equal(rom.length, 0x100000);
            assert.equal(crypto.createHash('sha256').update(rom.subarray(0xFC000)).digest('hex'),
                '4cd06363e65f4814bb05808e4e854c48383eaa523ed3e500c33b630542418ed5');
            if (!referenceCore) referenceCore = rom.subarray(0x3CC02, 0x3CE98);
            assert.deepEqual(rom.subarray(0x3CC02, 0x3CE98), referenceCore,
                'all supplied versions share the analyzed REPROGRAM core');
            for (const includeBoot of [false, true]) for (const recover of [false, true]) {
                const rx = new DumpReceiver({ recoverFirstHeader: recover }); rx.push(header(includeBoot));
                const regions = includeBoot ? [[0xFFC000, 0x1000000], [0xF00000, 0xFFC000]] : [[0xF00000, 0xFFC000]];
                for (const [start, stop] of regions) {
                    for (let address = start; address < stop;) {
                        const size = address < 0xFF0000 ? 0x4000 : 0x2000;
                        const block = rom.subarray(address - 0xF00000, address - 0xF00000 + size);
                        if (address === start || address + size === 0x1000000 || block.some(b => b !== 255)) {
                            let p = packet(address, block);
                            if (recover && address === 0xF00000) p = join([0x18, 0x1C, 0x10, 0xFF], p.subarray(6));
                            for (let i = 0; i < p.length; i += 997) rx.push(p.slice(i, i + 997));
                        }
                        address += size;
                    }
                }
                const reference = includeBoot ? rom : rom.subarray(0, 0xFC000);
                rx.push(end); assert.equal(rx.complete, true); assert.deepEqual(Buffer.from(rx.image), reference);
                assert.equal(Boolean(rx.manifest().recoveredFirstHeader), recover);
                if (includeBoot) assert.equal(crypto.createHash('sha256').update(rx.image).digest('hex'), expected);
            }
            console.log(`${name}: clean/recovered system and full-ROM sparse captures reconstructed exactly`);
        }
    }
    if (process.env.SHARP_NATIVE_PROGRAM) {
        const original = fs.readFileSync(process.env.SHARP_NATIVE_PROGRAM), file = decodeNative(original);
        assert.deepEqual(Buffer.from(encodeNative(file.category, file.object, file.selector, file.description)), original);
        console.log('Official native program file round-tripped byte-for-byte');
    }
    console.log('Sharp framing, native files, directory, upload/download, backup/restore, screenshot, version, retry/cancel and dump tests passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
