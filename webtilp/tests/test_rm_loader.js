'use strict';
const assert = require('node:assert/strict');
const api = require('../rm_loader_backend.js');
const { checksum, parseInstaller, receivedToInstaller, sendProgram, receiveProgram, SerialLink,
    SERIAL_OPTIONS, GROUP_SIZE, BLOCK_SIZE } = api;
const concat = (...parts) => Uint8Array.from(parts.flatMap(part => Array.from(part)));
const immediate = () => new Promise(setImmediate);
const noPause = async ms => { assert.equal(ms, 20); };

function fixture(groups = 1, flashSum = 0xF1234567) {
    const header = new Uint8Array(6); header[0] = groups;
    new DataView(header.buffer).setUint32(1, flashSum, true); header[5] = checksum(header.subarray(0, 5));
    const payload = Uint8Array.from({ length: groups * GROUP_SIZE }, (_, i) => (i * 17 + 23) & 255);
    return parseInstaller(receivedToInstaller(header, payload));
}
function uploadBytes(image) {
    const parts = [Uint8Array.of(0x16, 0x58), image.header];
    for (let offset = 0; offset < image.length; offset += BLOCK_SIZE) {
        const block = image.payload.subarray(offset, offset + BLOCK_SIZE);
        parts.push(block, Uint8Array.of(checksum(block)));
    }
    return concat(...parts);
}
function mockLink(input) {
    let at = 0;
    return {
        writes: [], timeouts: [],
        async read(n, timeout) { this.timeouts.push(timeout); assert.ok(at + n <= input.length, 'fixture exhausted'); const result = input.slice(at, at + n); at += n; return result; },
        async write(data) { this.writes.push(Uint8Array.from(data)); },
        get remaining() { return input.length - at; }
    };
}

// Web Streams exercise the real SerialLink, including reader/writer lock release.
class MockPort {
    constructor({ input = new Uint8Array(), chunkSizes = [1, 3, 8191, 5, 512], onWrite } = {}) {
        this.input = input; this.chunkSizes = chunkSizes; this.onWrite = onWrite; this.writes = [];
    }
    async open(options) {
        this.options = options;
        let offset = 0, chunk = 0;
        this.readable = new ReadableStream({
            start: controller => { this.controller = controller; },
            pull: controller => {
                if (offset >= this.input.length) return;
                const end = Math.min(this.input.length, offset + this.chunkSizes[chunk++ % this.chunkSizes.length]);
                controller.enqueue(this.input.slice(offset, end)); offset = end;
            },
            cancel: () => { this.cancelled = true; }
        });
        this.writable = new WritableStream({
            write: data => { this.writes.push(Uint8Array.from(data)); return this.onWrite?.(data, this); },
            abort: () => { this.aborted = true; }
        });
    }
    async close() {
        assert.equal(this.readable.locked, false, 'reader released before port.close');
        assert.equal(this.writable.locked, false, 'writer released before port.close');
        this.closeCount = (this.closeCount || 0) + 1;
    }
}

async function testFiles() {
    for (const groups of [1, 6, 10, 13]) {
        const image = fixture(groups);
        assert.equal(image.length, groups * GROUP_SIZE);
        assert.equal(image.expectedFlashSum, 0xF1234567, 'preserve unsigned full-Flash sum, not payload sum');
        assert.equal(checksum(image.header), 0);
        const container = receivedToInstaller(image.header, image.payload);
        assert.equal(container.length, 0xE0000);
        const parsed = parseInstaller(container);
        assert.deepEqual(parsed.header, image.header); assert.deepEqual(parsed.payload, image.payload);
        container[10] ^= 1;
        assert.throws(() => parseInstaller(container), /file checksum mismatch/);
    }
    for (const length of [0, GROUP_SIZE, 6 * GROUP_SIZE, 0xD0009, 0x100000, 0xE0001]) {
        assert.throws(() => parseInstaller(new Uint8Array(length)), /896 KiB/);
    }
    for (const groups of [0, 14, 16, 255]) {
        const header = Uint8Array.of(groups, 0, 0, 0, 0, (-groups) & 255);
        assert.throws(() => receivedToInstaller(header, new Uint8Array(groups * GROUP_SIZE)), /1–13/);
    }
    const image = fixture();
    const badHeader = image.header.slice(); badHeader[1] ^= 1;
    assert.throws(() => receivedToInstaller(badHeader, image.payload), /header checksum/);
    assert.throws(() => receivedToInstaller(image.header, image.payload.slice(1)), /length/);
    const link = mockLink([]);
    await assert.rejects(sendProgram(link, { ...image, payload: image.payload.slice(1) }), /length/);
    assert.equal(link.writes.length, 0, 'invalid PROGRAM never enters the wire');
}

async function testProtocol() {
    for (const groups of [1, 6, 10]) {
        const image = fixture(groups), link = mockLink(uploadBytes(image));
        const progress = [], phases = [];
        const result = await receiveProgram(link, { pause: noPause, progress: (done, total) => progress.push([done, total]), phase: p => phases.push(p) });
        assert.deepEqual(result.payload, image.payload); assert.deepEqual(result.header, image.header);
        assert.deepEqual(phases, ['connect', 'command', 'header', 'blocks']);
        assert.equal(link.writes.length, 3 + image.length / BLOCK_SIZE);
        assert.deepEqual(Array.from(concat(...link.writes)), [0x13, 0x51, 0x51, ...new Array(image.length / BLOCK_SIZE).fill(0x51)]);
        assert.equal(link.writes.some(bytes => bytes.includes(0x58)), false, 'receiver never initiates a Flash-write command');
        assert.deepEqual(progress.at(-1), [image.length, image.length]); assert.equal(link.remaining, 0);
        assert.equal(link.timeouts[0], 120000); assert.ok(link.timeouts.slice(1).every(n => n === 20000));

        const sender = mockLink(Uint8Array.of(0x13, 0x51, 0x51, ...new Array(image.length / BLOCK_SIZE).fill(0x51)));
        await sendProgram(sender, image, { pause: noPause });
        assert.deepEqual(concat(...sender.writes), uploadBytes(image));
        assert.deepEqual(sender.timeouts.slice(0, 3), [3000, 360000, 20000]);
        assert.equal(sender.remaining, 0);
    }
    const image = fixture(), wire = uploadBytes(image);
    const sender = mockLink(Uint8Array.of(0x13, 0x51, 0x51, 0x52, ...new Array(16).fill(0x51)));
    await sendProgram(sender, image, { pause: noPause });
    assert.deepEqual(sender.writes[3], sender.writes[5], 'same block retried');
    assert.deepEqual(sender.writes[4], sender.writes[6], 'same checksum retried');
    const reject = mockLink(Uint8Array.of(0x13, 0x51, 0x51, 0x52, 0x52));
    await assert.rejects(sendProgram(reject, image, { pause: noPause }), /rejected twice/);
    for (const replies of [[0, 0x51], [0x13, 0], [0x13, 0x51, 0], [0x13, 0x51, 0x51, 0]]) {
        await assert.rejects(sendProgram(mockLink(Uint8Array.from(replies)), image, { pause: noPause }), /Expected|Unexpected/);
    }
    const corrupt = wire.slice(8, 8 + BLOCK_SIZE + 1); corrupt[5] ^= 1;
    const retryReceiver = mockLink(concat(wire.slice(0, 8), corrupt, wire.slice(8)));
    assert.deepEqual((await receiveProgram(retryReceiver, { pause: noPause })).payload, image.payload);
    assert.equal(retryReceiver.writes[3][0], 0x52); assert.equal(retryReceiver.writes[4][0], 0x51);
    const rejectReceiver = mockLink(concat(wire.slice(0, 8), corrupt, corrupt));
    await assert.rejects(receiveProgram(rejectReceiver, { pause: noPause }), /Two corrupt copies/);
    assert.deepEqual(Array.from(concat(...rejectReceiver.writes)), [0x13, 0x51, 0x51, 0x52, 0x52]);
    const badHeader = wire.slice(0, 8); badHeader[7] ^= 1;
    const receiver = mockLink(badHeader);
    await assert.rejects(receiveProgram(receiver, { pause: noPause }), /header checksum/);
    assert.deepEqual(Array.from(concat(...receiver.writes)), [0x13, 0x51], 'bad header is never ACKed');
    const oversizedHeader = Uint8Array.of(14, 0, 0, 0, 0, (-14) & 255);
    const oversized = mockLink(concat([0x16, 0x58], oversizedHeader));
    await assert.rejects(receiveProgram(oversized, { pause: noPause }), /1–13/);
    assert.deepEqual(Array.from(concat(...oversized.writes)), [0x13, 0x51], 'native receiver rejects dumper-only lengths before ACK');
    for (const prefix of [[0x99], [0x16, 0x99]]) {
        await assert.rejects(receiveProgram(mockLink(Uint8Array.from(prefix)), { pause: noPause }), /Expected/);
    }
}

async function testTransport() {
    const image = fixture();
    for (const chunkSizes of [[1], [65536], [3, 19, 8192, 1, 4097]]) {
        const port = new MockPort({ input: concat(uploadBytes(image), [0xA5, 0x5A]), chunkSizes }), link = new SerialLink(port);
        await link.open(); assert.deepEqual(port.options, SERIAL_OPTIONS);
        const result = await receiveProgram(link, { pause: noPause });
        assert.deepEqual(result.payload, image.payload);
        assert.deepEqual(Array.from(await link.read(2, 100)), [0xA5, 0x5A], 'surplus bytes retained');
        await link.close(); await link.close(); assert.equal(port.closeCount, 1);
    }
    const port = new MockPort(), link = new SerialLink(port); await link.open();
    const pending = link.read(1, 1000);
    await assert.rejects(link.read(1, 100), /Concurrent/);
    const rejected = assert.rejects(pending, /cancelled/);
    await link.close(); await rejected;
    assert.equal(link.pending, null); assert.equal(port.closeCount, 1);

    const timeoutPort = new MockPort(), timeout = new SerialLink(timeoutPort); await timeout.open();
    await assert.rejects(timeout.read(6, 5), /Serial timeout/);
    await assert.rejects(timeout.write(Uint8Array.of(1)), /Serial timeout/, 'poisoned link rejects further writes');
    await timeout.close();

    const unplugPort = new MockPort(), unplug = new SerialLink(unplugPort); await unplug.open();
    const lost = assert.rejects(unplug.read(4097, 1000), /cable unplugged/);
    unplugPort.controller.error(new Error('cable unplugged')); await lost; await unplug.close().catch(() => {});
    assert.equal(unplugPort.closeCount, 1);

    const writePort = new MockPort({ onWrite() { throw new Error('write failed'); } }), writeLink = new SerialLink(writePort);
    await writeLink.open(); await assert.rejects(writeLink.write(Uint8Array.of(1)), /write failed/);
    await writeLink.close().catch(() => {}); assert.equal(writePort.closeCount, 1);

    let finishWrite, writeStarted;
    const started = new Promise(resolve => { writeStarted = resolve; });
    const writeGate = new Promise(resolve => { finishWrite = resolve; });
    const blockedPort = new MockPort({ onWrite() { writeStarted(); return writeGate; } });
    const blocked = new SerialLink(blockedPort); await blocked.open();
    const cancelledWrite = assert.rejects(blocked.write(Uint8Array.of(1)), /cancelled/);
    await started;
    const closing = blocked.close();
    await cancelledWrite; // Operation cancellation does not wait for a blocked OS write.
    finishWrite(); await closing; assert.equal(blockedPort.closeCount, 1);

    const partialPort = new MockPort();
    const originalOpen = partialPort.open.bind(partialPort);
    partialPort.open = async options => {
        await originalOpen(options);
        partialPort.writable = { locked: false, getWriter() { throw new Error('cannot acquire writer'); } };
    };
    const partial = new SerialLink(partialPort);
    await assert.rejects(partial.open(), /cannot acquire writer/);
    assert.equal(partialPort.closeCount, 1, 'partial setup failure releases the acquired reader');
    await immediate();
}

if (require.main === module) {
    (async () => {
        await testFiles(); await testProtocol(); await testTransport();
        console.log('RM loader: installer round trips, wire protocol, pacing/deadlines, bounded retries, fragmented reads, cancellation, timeout, disconnect and lock cleanup passed.');
    })().catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { MockPort, fixture, uploadBytes, concat };
