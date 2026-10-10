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
            const step = this.script.shift();
            assert.ok(step, 'no unsolicited wire commands');
            assert.deepEqual(packet, new Uint8Array(step[0]), `wire packet ${this.writes.length}`);
            if (step[1]) this.feed(step[1]);
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
        const { port, backend } = await connected([[command(0x42), f(1)], [command(0x63), join(f(1), f(0x23))],
            [ack, f(Uint8Array.of(132, 0, 64, 0))], [ack, f(bitmap)], [ack], [command(0x41), f(1)]], { model });
        const result = await backend.captureScreenshot();
        assert.deepEqual(result.rgba, screen.rgba);
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
        const { port, backend } = await connected(session([[command(0x22), reply(1)],
            [frame(join(cat(program), u32(object.length))), reply(1)], [frame(object), reply(1)]]));
        await backend.sendFile(native, 'HERON.g4p'); assert.equal(port.script.length, 0); await backend.close();
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
                    : c.name === 'MATRIX' ? join([1], fixedSelector) : [0])], [ack]);
        }
        const { port, backend } = await connected(session(steps));
        const entries = await backend.listVariables();
        assert.equal(entries.length, 6); assert.equal(entries[0].name, 'HERON');
        assert.equal(entries[1].category, list); assert.equal(entries[1].type_name, 'LIST');
        assert.equal(entries[0].category, program); assert.equal(port.script.length, 0); await backend.close();
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
        const timeout = await connected([[command(0x42)]]);
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
    // Reject malformed dumps, reconstruct erased gaps, and never expose partial images.
    const packet = (address, payload) => {
        const h = Buffer.alloc(6); h.writeUInt32LE(address); h.writeUInt16LE(payload.length, 4);
        const body = join(h, payload), sum = checksum(body); return join(body, [sum & 255, sum >>> 8]);
    };
    // Run the full backend around both baud transitions. A synthetic peer waits
    // for each OK and delivers data on the reopened port, like a paced sender.
    class DumpPort extends Port {
        constructor(includeBoot) {
            super(); this.includeBoot = includeBoot; this.bootPending = includeBoot;
            this.systemPending = false; this.bootSent = false;
        }
        async open(options) {
            this.options.push(options);
            this.readable = new ReadableStream({ start: controller => {
                this.controller = controller;
                if (options.stopBits === 1) {
                    if (!this.headerSent) {
                        this.headerSent = true;
                        controller.enqueue(packet(0, [57, 57, 1, 0x80, this.includeBoot ? 1 : 0]));
                    } else if (this.systemPending) controller.enqueue(first);
                }
            } });
            this.writable = new WritableStream({ write: value => {
                assert.equal(Buffer.from(value).toString(), 'OK'); this.writes.push(value);
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
    for (const includeBoot of [false, true]) {
        const port = new DumpPort(includeBoot), backend = new SharpBackend({ serialPort: port, timeoutMs: 200 });
        await backend.connect(); const result = await backend.receiveDump({ includeBoot });
        assert.equal(result.manifest.complete, true);
        assert.equal(result.data.length, includeBoot ? 0x100000 : 0xFC000);
        assert.deepEqual(port.options.map(o => [o.baudRate, o.stopBits]), [[38400, 2], [19200, 1], [38400, 1], [38400, 2]]);
        assert.equal(port.writes.length, includeBoot ? 4 : 3);
        assert.equal(backend.closed, false); await backend.close();
    }
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
            const rx = new DumpReceiver(); rx.push(header(true));
            for (const [start, stop] of [[0xFFC000, 0x1000000], [0xF00000, 0xFFC000]]) {
                for (let address = start; address < stop;) {
                    const size = address < 0xFF0000 ? 0x4000 : 0x2000;
                    const block = rom.subarray(address - 0xF00000, address - 0xF00000 + size);
                    if (address === start || address + size === 0x1000000 || block.some(b => b !== 255)) {
                        const p = packet(address, block);
                        for (let i = 0; i < p.length; i += 997) rx.push(p.slice(i, i + 997));
                    }
                    address += size;
                }
            }
            rx.push(end); assert.equal(rx.complete, true); assert.deepEqual(Buffer.from(rx.image), rom);
            assert.equal(crypto.createHash('sha256').update(rx.image).digest('hex'), expected);
            console.log(`${name}: sparse capture reconstructed ${expected}`);
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
