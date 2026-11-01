/* Casio RM-7000/RM-9000 native Flash Memory PROGRAM transfers.
 * Protocol supplied by Critor; provenance and hardware evidence: docs/RM_LOADER.md.
 * This backend does not use Cahute and never transfers the native LOADER.
 */
(function (scope) {
'use strict';
const SERIAL_OPTIONS = Object.freeze({ baudRate: 19200, dataBits: 8, stopBits: 2,
    parity: 'odd', flowControl: 'none', bufferSize: 65536 });
const INSTALLER_SIZE = 0xE0000, METADATA_OFFSET = 0xD0000;
const BLOCK_SIZE = 4096, GROUP_SIZE = 65536, MAX_GROUPS = 13;
const checksum = data => (-data.reduce((sum, byte) => (sum + byte) & 255, 0)) & 255;
const view = data => new DataView(data.buffer, data.byteOffset, data.byteLength);

function validateHeader(header) {
    if (header.length !== 6 || checksum(header) !== 0) throw new Error('Invalid RM header checksum.');
    if (header[0] < 1 || header[0] > MAX_GROUPS) throw new Error('Invalid native PROGRAM length (expected 1–13 groups).');
    return header[0] * GROUP_SIZE;
}

function fileChecksum(bytes) {
    let sum = 0;
    for (let i = 0; i < bytes.length; i++) {
        if (i < METADATA_OFFSET + 5 || i >= METADATA_OFFSET + 9) sum = (sum + bytes[i]) >>> 0;
    }
    return sum;
}

function parseInstaller(data) {
    const bytes = Uint8Array.from(data);
    if (bytes.length !== INSTALLER_SIZE) throw new Error('Expected an 896 KiB RM installation .bin, not a raw PROGRAM or full Flash ROM.');
    const meta = bytes.subarray(METADATA_OFFSET, METADATA_OFFSET + 9);
    const header = new Uint8Array(6);
    header.set(meta.subarray(0, 5));
    header[5] = checksum(header.subarray(0, 5));
    const length = validateHeader(header);
    if (fileChecksum(bytes) !== view(meta).getUint32(5, true)) throw new Error('RM installation-file checksum mismatch.');
    return { header, groups: header[0], length, payload: bytes.slice(0, length),
        expectedFlashSum: view(header).getUint32(1, true) };
}

function receivedToInstaller(header, payload) {
    const length = validateHeader(header);
    if (payload.length !== length) throw new Error('PROGRAM length does not match its header.');
    const bytes = new Uint8Array(INSTALLER_SIZE).fill(255);
    bytes.set(payload);
    bytes.set(header.subarray(0, 5), METADATA_OFFSET);
    view(bytes).setUint32(METADATA_OFFSET + 5, fileChecksum(bytes), true);
    return bytes;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function expect(link, expected, timeout) {
    const actual = (await link.read(1, timeout))[0];
    if (actual !== expected) throw new Error(`Expected 0x${expected.toString(16)}, received 0x${actual.toString(16)}.`);
}

async function sendProgram(link, image, { progress = () => {}, phase = () => {}, pause = sleep } = {}) {
    // Reject inconsistent objects before the first byte, even outside the UI.
    const length = validateHeader(image.header);
    if (image.payload.length !== length || image.length !== length) throw new Error('PROGRAM length does not match its header.');
    phase('connect');
    await link.write(Uint8Array.of(0x16)); await expect(link, 0x13, 3000); await pause(20);
    phase('prepare');
    await link.write(Uint8Array.of(0x58)); await expect(link, 0x51, 360000); await pause(20);
    phase('header');
    await link.write(image.header); await expect(link, 0x51, 20000); await pause(20);
    phase('blocks');
    for (let offset = 0; offset < length; offset += BLOCK_SIZE) {
        const block = image.payload.slice(offset, offset + BLOCK_SIZE);
        let accepted = false;
        for (let attempt = 0; attempt < 2; attempt++) {
            await link.write(block); await link.write(Uint8Array.of(checksum(block)));
            const reply = (await link.read(1, 20000))[0];
            if (reply === 0x51) { accepted = true; break; }
            if (reply !== 0x52) throw new Error(`Unexpected reply 0x${reply.toString(16)} at block ${offset / BLOCK_SIZE + 1}.`);
        }
        if (!accepted) throw new Error(`Block ${offset / BLOCK_SIZE + 1} rejected twice.`);
        progress(offset + BLOCK_SIZE, length); await pause(20);
    }
}

async function receiveProgram(link, { progress = () => {}, phase = () => {}, pause = sleep } = {}) {
    // Upload is calculator-initiated: reception never sends the Flash-write X.
    phase('connect'); await expect(link, 0x16, 120000); await link.write(Uint8Array.of(0x13));
    phase('command'); await expect(link, 0x58, 20000); await pause(20); await link.write(Uint8Array.of(0x51));
    phase('header');
    const header = await link.read(6, 20000), length = validateHeader(header);
    const payload = new Uint8Array(length);
    await pause(20); await link.write(Uint8Array.of(0x51)); phase('blocks');
    for (let offset = 0; offset < length; offset += BLOCK_SIZE) {
        let accepted = false;
        for (let attempt = 0; attempt < 2; attempt++) {
            const frame = await link.read(BLOCK_SIZE + 1, 20000);
            if (checksum(frame) === 0) {
                payload.set(frame.subarray(0, BLOCK_SIZE), offset);
                await pause(20); await link.write(Uint8Array.of(0x51)); accepted = true; break;
            }
            await link.write(Uint8Array.of(0x52));
        }
        if (!accepted) throw new Error(`Two corrupt copies of block ${offset / BLOCK_SIZE + 1}.`);
        progress(offset + BLOCK_SIZE, length);
    }
    return { header, payload, length, groups: header[0], expectedFlashSum: view(header).getUint32(1, true) };
}

// Exact-length reads over arbitrary serial chunks. A failed operation retires
// the link: delayed bytes from a previous handshake must not enter the next one.
class SerialLink {
    constructor(port) {
        this.port = port; this.closed = true; this.queue = []; this.available = 0;
        this.pending = null; this.failure = null; this.closing = null;
        this.failed = new Promise((_, reject) => { this.rejectWrites = reject; });
        this.failed.catch(() => {});
    }
    async open() {
        await this.port.open({ ...SERIAL_OPTIONS });
        this.closed = false;
        try {
            this.reader = this.port.readable.getReader();
            this.writer = this.port.writable.getWriter();
            this.pump = this.readLoop();
        } catch (error) { await this.close(); throw error; }
    }
    fail(error) {
        this.failure ||= error;
        this.rejectWrites(this.failure);
        if (this.pending) {
            const pending = this.pending; this.pending = null;
            clearTimeout(pending.timer); pending.reject(this.failure);
        }
    }
    drain() {
        const pending = this.pending;
        if (!pending || this.available < pending.length) return;
        const result = new Uint8Array(pending.length);
        let at = 0;
        while (at < result.length) {
            const first = this.queue[0], count = Math.min(first.length, result.length - at);
            result.set(first.subarray(0, count), at); at += count;
            if (count === first.length) this.queue.shift();
            else this.queue[0] = first.subarray(count);
            this.available -= count;
        }
        this.pending = null; clearTimeout(pending.timer); pending.resolve(result);
    }
    async readLoop() {
        try {
            while (!this.closed) {
                const { value, done } = await this.reader.read();
                if (done) throw new Error('Serial stream ended. Reconnect the cable and restart the calculator transfer.');
                if (value?.length) {
                    this.queue.push(value.slice()); this.available += value.length;
                    if (this.available > 2 * 1024 * 1024) throw new Error('Unexpected serial data exceeds the RM transfer buffer.');
                    this.drain();
                }
            }
        } catch (error) {
            this.fail(error);
            if (!this.closed) this.onError?.(error);
        }
        finally { this.reader.releaseLock(); }
    }
    read(length, timeout) {
        if (this.pending) return Promise.reject(new Error('Concurrent serial reads are not supported.'));
        if (this.failure || this.closed) return Promise.reject(this.failure || new Error('Serial port closed.'));
        return new Promise((resolve, reject) => {
            this.pending = { length, resolve, reject, timer: setTimeout(() => {
                this.fail(new Error(`Serial timeout after ${timeout / 1000} seconds. Restart the calculator transfer before reconnecting.`));
            }, timeout) };
            this.drain();
        });
    }
    async write(bytes) {
        if (this.failure || this.closed) throw this.failure || new Error('Serial port closed.');
        let timer;
        try {
            await Promise.race([this.writer.write(bytes), this.failed, new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('Serial write timeout.')), 20000);
            })]);
        } catch (error) { this.fail(error); throw error; }
        finally { clearTimeout(timer); }
    }
    close() {
        if (this.closing) return this.closing;
        this.closed = true; this.fail(new Error('Transfer cancelled; serial port closed.'));
        this.closing = (async () => {
            const results = await Promise.allSettled([this.reader?.cancel(), this.writer?.abort(this.failure)]);
            await this.pump;
            if (!this.pump) this.reader?.releaseLock();
            this.writer?.releaseLock();
            await this.port.close();
            const rejected = results.find(result => result.status === 'rejected');
            if (rejected) throw rejected.reason;
        })();
        return this.closing;
    }
}

const api = { SERIAL_OPTIONS, INSTALLER_SIZE, METADATA_OFFSET, BLOCK_SIZE, GROUP_SIZE,
    checksum, validateHeader, parseInstaller, receivedToInstaller, sendProgram, receiveProgram, SerialLink };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else scope.WebTILPRMLoader = Object.freeze(api);
})(globalThis);
