/* Sharp EL-99xx PC-Link and receive-only REPROGRAM support.
 * Firmware provenance and wire/file layouts: docs/SHARP_PROTOCOL.md.
 */
(function (scope) {
'use strict';
const VENDOR_ID = 0x04FC, PRODUCT_ID = 0x0201;
const RAM_SIZE = 0xE32B, BASE = 0xF00000, OS_END = 0xFFC000, ROM_END = 0x1000000;
const MODELS = Object.freeze({
    'sharp-auto': 'Sharp EL-99xx',
    'sharp-el9900': 'Sharp EL-9900',
    'sharp-el9900g': 'Sharp EL-9900G',
    'sharp-el9900gsii': 'Sharp EL-9900G SII',
    'sharp-el9950': 'Sharp EL-9950'
});
const CATEGORIES = Object.freeze([
    { name: 'PROGRAM', ext: 'p', dynamic: true },
    { name: 'SOLVE EQU', ext: 'e', dynamic: true },
    { name: 'ANIME', ext: 's', dynamic: true },
    { name: 'GRAPH EQU', ext: 'y', directorySlots: 31 }, { name: 'MATRIX', ext: 'm', directorySlots: 29 },
    { name: 'PICT', ext: 'i', directorySlots: 10 }, { name: 'GDB', ext: 'd', directorySlots: 10 },
    { name: 'MATRIX', ext: 'l', alias: true, directorySlots: 29 }, { name: 'LISTDB', ext: 'n', directorySlots: 10 },
    { name: 'VARIABLE', ext: 'v', command: 0x68, size: 486 },
    { name: 'ZOOM', ext: 'z', command: 0x69, size: 19 },
    { name: 'WINDOW', ext: 'w', command: 0x6A, size: 54 },
    { name: 'TABLE', ext: 't', command: 0x6B, size: 324 }
]);
const bytes = value => new Uint8Array(value);
const concat = (...parts) => {
    const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.length; }
    return result;
};
const text = value => Array.from(value, b => String.fromCharCode(b)).join('');
function ascii(value, size = value.length, fill = 0) {
    const result = new Uint8Array(size).fill(fill);
    if (value.length > size || Array.from(value).some(c => c.charCodeAt(0) > 255)) {
        throw new Error('Invalid Sharp byte string.');
    }
    Array.from(value).forEach((c, i) => { result[i] = c.charCodeAt(0); });
    return result;
}
const categoryBytes = category => ascii(category.name, 11, 32);
const checksum = value => value.reduce((sum, b) => (sum + b) & 65535, 0);
const view = value => new DataView(value.buffer, value.byteOffset, value.byteLength);
function le32(value) { const result = new Uint8Array(4); view(result).setUint32(0, value, true); return result; }
function frame(payload, identity = '11') {
    const body = concat(ascii(identity), payload);
    const sum = checksum(body);
    return concat(body, Uint8Array.of(sum & 255, sum >>> 8));
}
function validateObject(object, category) {
    const minimum = category.dynamic ? 20 : 10;
    if (object.length < minimum || object.length > RAM_SIZE || view(object).getUint32(0, true) !== object.length) {
        throw new Error('Invalid Sharp RAM object length.');
    }
}
function selectorName(category, selector) {
    const low = selector[0], bank = selector[1];
    if (bank === 0x0D) {
        for (const [base, prefix, ext] of [[0x10, 'Pict', 'i'], [0x20, 'G_Data', 'd'], [0x30, 'L_Data', 'n']]) {
            if (category.ext === ext && low >= base && low < base + 10) return prefix + ((low - base + 1) % 10);
        }
    }
    if (category.ext === 'm' && bank === 9 && low >= 0x10 && low <= 0x19) return 'mat ' + String.fromCharCode(65 + low - 0x10);
    if (category.ext === 'm' && bank === 9 && low === 0x30) return 'MatAns';
    if (category.ext === 'l' && bank === 8) {
        if (low >= 0x10 && low <= 0x15) return 'L' + (low - 0x10 + 1);
        if (low === 0x16) return 'TBLList';
        if (low === 0x17) return 'resid';
        if (low >= 0x20 && low <= 0x25) return (low >= 0x23 ? 'Zm_' : '') + 'uvw'[(low - 0x20) % 3] + '(nMin)';
    }
    if (category.ext === 'y' && bank === 12 && low >= 0x10 && low <= 0x19) return 'Y' + ((low - 0x10 + 1) % 10);
    return `${category.name} ${view(selector).getUint16(0, true)}`;
}
function nativeHeader(ext, selector, description = '') {
    const result = new Uint8Array(54);
    result.set(ascii('4' + ext));
    result.set(selector.subarray(0, 11), 2);
    result.set(ascii(description, 40), 13);
    return result;
}
function encodeNative(category, object, selector, description = '') {
    if (category.command) {
        if (object.length !== category.size) throw new Error('Invalid Sharp fixed-block length.');
        return concat(nativeHeader(category.ext, selector, description), object);
    }
    validateObject(object, category);
    // PC-Link omits object size/previous-size and moves dynamic name11 to the
    // file header. Dynamic objects have a zero pad after the name.
    return concat(nativeHeader(category.ext, selector, description),
        object.subarray(category.dynamic ? 20 : 8));
}
function decodeNative(data, filename = '') {
    data = bytes(data);
    if (data.length < 54 || data[0] !== 52 || data[53] !== 0) throw new Error('Invalid Sharp g4 file header.');
    const ext = String.fromCharCode(data[1]).toLowerCase();
    if (filename && !filename.toLowerCase().endsWith('.g4' + ext)) throw new Error('Sharp filename and file type disagree.');
    const selector = data.slice(2, 13), description = text(data.slice(13, 53)).replace(/\0.*$/, '');
    const payload = data.slice(54);
    if (ext === 'b') {
        if (payload.length !== RAM_SIZE) throw new Error('Invalid Sharp native RAM backup size.');
        return { backup: true, data: payload, description };
    }
    const category = CATEGORIES.find(item => item.ext === ext);
    if (!category) throw new Error('Unsupported Sharp file type (convert source or expand groups before transfer).');
    let object;
    if (category.command) {
        if (payload.length !== category.size) throw new Error('Invalid Sharp fixed-block size.');
        object = payload;
    } else if (category.dynamic) {
        if (!selector.subarray(0, 8).some(b => b && b !== 32)) throw new Error('Empty Sharp object name.');
        object = concat(le32(payload.length + 20), le32(48), selector, Uint8Array.of(0), payload);
        validateObject(object, category);
    } else {
        if (payload.length < 2 || payload[0] !== selector[0] || payload[1] !== selector[1]) {
            throw new Error('Sharp fixed object selector disagrees with its file header.');
        }
        object = concat(le32(payload.length + 8), le32(48), payload);
        validateObject(object, category);
    }
    return { category, object, selector, description };
}
function validateRestore(file, model, allowRestore) {
    if (!file.backup) return;
    if (!allowRestore || !MODELS[model] || model === 'sharp-auto') throw new Error('Select an exact Sharp model and confirm RAM restore first.');
    const marker = /^WebTiLP (sharp-[a-z0-9]+)/.exec(file.description);
    if (marker && marker[1] !== model) throw new Error('This backup belongs to a different Sharp model.');
}
function decodeScreenshot(data, width = 132, height = 64) {
    if (width !== 132 || height !== 64 || data.length !== 1056) throw new Error('Invalid Sharp screenshot dimensions or size.');
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const color = data[(y >> 3) * width + x] & (0x80 >> (y & 7)) ? 0 : 255;
        const i = (y * width + x) * 4;
        rgba.set([color, color, color, 255], i);
    }
    return { width, height, rgba };
}

// REPROGRAM has its own address/length framing and raw OK/NG replies.
class DumpReceiver {
    constructor({ recoverFirstHeader = false } = {}) {
        this.pending = new Uint8Array(); this.phase = 'header'; this.complete = false;
        this.failed = false; this.blocks = []; this.lastEnd = BASE; this.systemBlocks = 0;
        this.recoverFirstHeader = recoverFirstHeader; this.recoveredFirstHeader = null;
    }
    push(chunk) {
        if (this.failed || (this.complete && chunk.length)) { this.failed = true; this.complete = false; throw new Error('Unexpected data after the Sharp dump ended.'); }
        this.pending = concat(this.pending, chunk);
        const events = [];
        try {
            while (!this.complete && this.pending.length >= 6) {
                if (this.recoverFirstHeader && this.phase === 'system' && !this.systemBlocks && this.header.mode === 0x80
                    && (view(this.pending).getUint32(0, true) !== BASE || view(this.pending).getUint16(4, true) !== 0x4000)) {
                    // Observed baud-transition damage is confined to the first
                    // six header bytes. Locate the ROM's 81..A0 prefix within
                    // that window; never reconstruct any payload or checksum.
                    let offset = -1;
                    for (let p = 0; p <= 6; p++) {
                        if (this.pending.length >= p + 32 && this.pending.subarray(p, p + 32).every((b, i) => b === 0x81 + i)) {
                            offset = p; break;
                        }
                    }
                    if (offset < 0) {
                        if (this.pending.length < 38) break;
                        throw new Error('Damaged Sharp first system header without an intact ROM prefix; recovery refused.');
                    }
                    const total = offset + 0x4000 + 2;
                    if (this.pending.length < total) break;
                    const inferredHeader = Uint8Array.of(0, 0, 0xF0, 0, 0, 0x40);
                    const sum = view(this.pending).getUint16(total - 2, true);
                    if (sum !== ((checksum(inferredHeader) + checksum(this.pending.subarray(offset, total - 2))) & 65535)) {
                        throw new Error('Sharp first system block checksum mismatch; header recovery refused.');
                    }
                    this.recoveredFirstHeader = { rawPrefix: Array.from(this.pending.subarray(0, offset)),
                        inferredHeader: Array.from(inferredHeader), payloadOffset: offset, payloadBytesReceived: 0x4000, checksum: sum,
                        payloadPrefixUsedForAlignment: '81..A0', reason: 'first system header damaged during baud transition' };
                    this.pending = concat(inferredHeader, this.pending.subarray(offset));
                }
                const address = view(this.pending).getUint32(0, true), length = view(this.pending).getUint16(4, true);
                if (this.phase === 'header' && (address !== 0 || length !== 5)) throw new Error('Invalid REPROGRAM header; check the initial baud rate.');
                if (address === 0xFFFFFFFF) {
                    if (length || this.phase !== 'system' || !this.blocks.some(b => b.address === BASE)) throw new Error('Premature Sharp dump terminator.');
                } else if (this.phase === 'boot') {
                    if (length !== 0x2000 || address < OS_END || address + length > ROM_END || address % length || address < this.lastEnd) throw new Error('Invalid or overlapping Sharp boot block.');
                } else if (this.phase === 'system') {
                    const expected = address < 0xFF0000 ? 0x4000 : 0x2000;
                    if (length !== expected || address < BASE || address + length > OS_END || address % length || address < this.lastEnd) throw new Error('Invalid or overlapping Sharp system block.');
                }
                const total = length + 8;
                if (this.pending.length < total) break;
                const packet = this.pending.slice(0, total);
                if (view(packet).getUint16(total - 2, true) !== checksum(packet.subarray(0, total - 2))) throw new Error('Sharp dump checksum mismatch.');
                this.pending = this.pending.slice(total);
                if (this.phase === 'header') {
                    const h = packet.subarray(6, 11);
                    if (h[0] !== 57 || h[1] !== 57 || h[2] !== 1 || ![0x70, 0x80].includes(h[3]) || h[4] > 1) throw new Error('Unsupported Sharp REPROGRAM mode.');
                    this.header = { mode: h[3], boot: Boolean(h[4]) };
                    this.image = new Uint8Array((h[4] ? ROM_END : OS_END) - BASE).fill(255);
                    this.phase = h[4] ? 'boot' : 'system'; this.lastEnd = h[4] ? OS_END : BASE;
                    events.push({ type: 'header', ...this.header });
                } else if (address === 0xFFFFFFFF) {
                    if (this.pending.length) throw new Error('Extra data after Sharp dump terminator.');
                    this.complete = true; this.phase = 'done'; events.push({ type: 'end' });
                } else {
                    this.image.set(packet.subarray(6, 6 + length), address - BASE);
                    const lastBoot = this.phase === 'boot' && address + length === ROM_END;
                    const block = { address, length, checksum: checksum(packet.subarray(0, total - 2)) };
                    this.blocks.push(block); this.lastEnd = address + length;
                    if (this.phase === 'system') this.systemBlocks++;
                    if (lastBoot) { this.phase = 'system'; this.lastEnd = BASE; }
                    events.push({ type: 'block', ...block, lastBoot,
                        headerRecovered: this.phase === 'system' && this.systemBlocks === 1 && Boolean(this.recoveredFirstHeader) });
                }
            }
            return events;
        } catch (error) { this.failed = true; this.complete = false; throw error; }
    }
    manifest() {
        return { format: 'sharp-reprogram-capture-v1', complete: this.complete, base: BASE,
            endExclusive: this.header?.boot ? ROM_END : OS_END, header: this.header,
            blocks: this.blocks, recoveredFirstHeader: this.recoveredFirstHeader, erasedGapsInferredFromProtocol: true };
    }
}

class SharpBackend {
    constructor({ serialPort, model = 'sharp-auto', timeoutMs = 30000, onProgress = () => {} }) {
        if (!MODELS[model]) throw new Error('Unknown Sharp model.');
        this.port = serialPort; this.model = model; this.timeoutMs = timeoutMs;
        this.onProgress = onProgress; this.queue = new Uint8Array(); this.waiters = new Set();
        this.busy = false; this.cancelled = false; this.closed = true; this.identity = null; this.error = null;
        this.receivedBytes = 0; this.version = null;
    }
    async connect(options = { baudRate: 38400, stopBits: 2 }) {
        if (this.cancelled) throw new Error('Sharp operation cancelled.');
        await this.port.open({ dataBits: 8, parity: 'none', flowControl: 'none', bufferSize: 65536, ...options });
        if (this.cancelled) { await this.port.close(); throw new Error('Sharp operation cancelled.'); }
        this.closed = false; this.error = null; this.queue = new Uint8Array();
        this.baudRate = options.baudRate;
        this.reader = this.port.readable.getReader(); this.writer = this.port.writable.getWriter();
        this.pump = this.readLoop();
    }
    async readLoop() {
        try {
            while (!this.closed) {
                const { value, done } = await this.reader.read();
                if (done) { if (!this.closed) throw new Error('Sharp serial port disconnected.'); break; }
                if (this.queue.length + value.length > 0x20000) throw new Error('Unexpected excess Sharp serial data.');
                this.receivedBytes += value.length;
                this.queue = concat(this.queue, value); this.wake();
            }
        } catch (error) { if (!this.closed) this.error = error; this.wake(); }
    }
    wake() { for (const waiter of this.waiters) waiter(); }
    async read(length, timeoutMs = this.timeoutMs, onProgress = null) {
        // This is an inactivity timeout, not a deadline for an entire frame.
        // A RAM backup is 58 KB and WebUSB delivers it in 16-byte packets.
        let available = -1, deadline = Date.now() + timeoutMs;
        while (this.queue.length < length) {
            if (this.closed || this.error) throw this.error || new Error('Sharp operation cancelled.');
            if (this.queue.length !== available) {
                available = this.queue.length;
                deadline = Date.now() + timeoutMs;
                onProgress?.(Math.min(length, available));
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                const error = new Error(`Sharp response timed out after ${timeoutMs} ms without data (${this.queue.length}/${length} bytes received). Reconnect with the calculator powered on at its normal screen.`);
                error.code = 'SHARP_RESPONSE_TIMEOUT'; throw error;
            }
            await new Promise(resolve => {
                const wake = () => { clearTimeout(timer); this.waiters.delete(wake); resolve(); };
                const timer = setTimeout(wake, remaining); this.waiters.add(wake);
            });
        }
        if (this.closed || this.error) throw this.error || new Error('Sharp operation cancelled.');
        const result = this.queue.slice(0, length); this.queue = this.queue.slice(length);
        onProgress?.(length); return result;
    }
    async write(data, onProgress = null) {
        if (this.closed || this.error) throw this.error || new Error('Sharp serial port is closed.');
        // Never retry an uncertain/partial serial write.
        // Stream large payloads through the UART in bounded writes so progress
        // reflects completed writes, rather than a single queued USB transfer.
        const chunkSize = onProgress ? 1024 : data.length;
        for (let offset = 0; offset < data.length; offset += chunkSize) {
            const chunk = data.subarray(offset, offset + chunkSize);
            await Promise.race([this.writer.write(chunk), new Promise((_, reject) => {
                this.writeTimer = setTimeout(() => reject(new Error('Sharp serial write timed out.')), this.timeoutMs);
            })]).finally(() => clearTimeout(this.writeTimer));
            if (this.closed) throw new Error('Sharp operation cancelled.');
            onProgress?.(offset + chunk.length);
        }
    }
    async receive(length, dynamicLength = null, timeoutMs = this.timeoutMs, onProgress = null) {
        for (let retry = 0; retry < 3; retry++) {
            onProgress?.(0);
            const prefix = await this.read(2 + length, timeoutMs,
                onProgress && (received => onProgress(Math.max(0, received - 2))));
            const identity = text(prefix.subarray(0, 2));
            if (!['99', '9:'].includes(identity) || (this.identity && this.identity !== identity)) {
                const hex = data => Array.from(data, b => b.toString(16).padStart(2, '0')).join(' ');
                const error = new Error(`Unexpected Sharp sender identity (${hex(prefix.subarray(0, 2))}; expected ${this.identity || '99 / 9:'}). Frame prefix: ${hex(prefix.subarray(0, 16))}; queued: ${hex(this.queue.subarray(0, 32))}.`);
                error.code = 'SHARP_FRAME_IDENTITY'; throw error;
            }
            if (this.model === 'sharp-el9950' && identity !== '9:' || this.model !== 'sharp-auto' && this.model !== 'sharp-el9950' && identity !== '99') throw new Error('Selected Sharp model does not match the calculator identity.');
            const extraLength = dynamicLength ? dynamicLength(prefix.subarray(2)) : 0;
            if (!Number.isSafeInteger(extraLength) || extraLength < 0 || extraLength > RAM_SIZE) throw new Error('Invalid Sharp frame size.');
            const packet = concat(prefix, await this.read(extraLength + 2, timeoutMs));
            if (view(packet).getUint16(packet.length - 2, true) === checksum(packet.subarray(0, packet.length - 2))) {
                this.identity = identity;
                // Only 9: uniquely identifies a supported model. The 9900,
                // 9900G and SII all use 99, so leave that family ambiguous.
                if (this.model === 'sharp-auto' && identity === '9:') this.model = 'sharp-el9950';
                return packet.slice(2, -2);
            }
            await this.write(frame(Uint8Array.of(0x81)));
        }
        throw new Error('Sharp frame checksum failed after three attempts.');
    }
    async receivePayload(length) {
        const data = await this.receive(length, null, this.timeoutMs,
            completed => this.onProgress({ completed: Math.min(completed, length - 1), total: length }));
        this.onProgress({ completed: length, total: length });
        return data;
    }
    async ack() { await this.write(frame(Uint8Array.of(1))); }
    async expectCommand(expected) {
        const data = await this.receive(1);
        if (data[0] !== expected) {
            const error = new Error(data[0] === 0x84 ? 'Sharp calculator has insufficient memory.' : `Unexpected Sharp response 0x${data[0].toString(16)} (expected 0x${expected.toString(16)}).`);
            error.code = data[0]; throw error;
        }
    }
    async send(payload, { responseTimeoutMs = this.timeoutMs, progress = false } = {}) {
        const packet = frame(payload);
        for (let retry = 0; retry < 3; retry++) {
            if (progress) this.onProgress({ completed: 0, total: payload.length });
            await this.write(packet, progress ? sent => this.onProgress({
                completed: Math.max(0, Math.min(sent - 2, payload.length - 1)), total: payload.length
            }) : null);
            const response = await this.receive(1, null, responseTimeoutMs);
            if (response[0] === 1) {
                if (progress) this.onProgress({ completed: payload.length, total: payload.length });
                return;
            }
            if (response[0] !== 0x81) {
                const error = new Error(response[0] === 0x84 ? 'Sharp calculator has insufficient memory.' : `Sharp rejected the transfer (0x${response[0].toString(16)}).`);
                error.code = response[0]; throw error;
            }
        }
        throw new Error('Sharp transfer retry limit reached.');
    }
    async command(value, options) { await this.send(Uint8Array.of(value), options); }
    async startSession() {
        // A powered-on EL-9950G can ignore the first two starts, including after
        // a successful end. Retry only this idempotent handshake, and only when
        // absolutely no response arrived. Partial frames and writes are fatal.
        for (let attempt = 0; attempt < 5; attempt++) {
            const receivedBefore = this.receivedBytes;
            try {
                await this.command(0x42, { responseTimeoutMs: Math.min(1200, this.timeoutMs) });
                return;
            } catch (error) {
                if (error.code !== 'SHARP_RESPONSE_TIMEOUT' || this.queue.length ||
                    this.receivedBytes !== receivedBefore || attempt === 4) throw error;
            }
        }
    }
    async operation(callback, { session = true, finish = true, keepOpenOnSilentStart = false } = {}) {
        if (this.busy) throw new Error('A Sharp operation is already running.');
        if (this.closed || this.error) throw this.error || new Error('Reconnect the Sharp calculator first.');
        this.busy = true;
        const receivedBefore = this.receivedBytes;
        let sessionStarted = false;
        try {
            this.onProgress({});
            if (session) { await this.startSession(); sessionStarted = true; }
            const result = await callback();
            if (session && finish) await this.command(0x41);
            return result;
        } catch (error) {
            // An automatic information probe may meet a powered-off calculator
            // or the REPROGRAM menu. If no bytes arrived at all, keep the idle
            // transport available for a dump; partial/uncertain sessions close.
            const silentStart = session && !sessionStarted && !this.closed && !this.error
                && error.code === 'SHARP_RESPONSE_TIMEOUT' && !this.queue.length
                && this.receivedBytes === receivedBefore;
            if (!keepOpenOnSilentStart || !silentStart) await this.close().catch(() => {});
            throw error;
        } finally { this.busy = false; }
    }
    async listVariables() {
        return this.operation(async () => {
            const entries = [];
            for (const category of CATEGORIES) {
                if (category.alias) continue;
                if (category.command) {
                    entries.push({ kind: 'sharp', name: category.name, type_name: category.name,
                        category, selector: new Uint8Array(11), size: category.size, type: category.command, folder: '', attr: 0 });
                    continue;
                }
                const directory = await this.readDirectory(category);
                for (let i = 0; i < directory[0]; i++) {
                    const selector = directory.slice(1 + i * 11, 12 + i * 11);
                    const entryCategory = category.name === 'MATRIX' && selector[1] === 8
                        ? CATEGORIES.find(item => item.ext === 'l') : category;
                    const name = category.dynamic ? text(selector.subarray(0, 8)).replace(/[\0 ]+$/, '')
                        : selectorName(entryCategory, selector);
                    let size = 0;
                    if (category.ext === 'i') {
                        // PICT descriptors do not contain a reliable length:
                        // an empty slot's descriptor overlaps the next object.
                        // Read each slot completely to distinguish empty from
                        // an all-white picture without guessing from pixels.
                        const object = await this.readObject(category, selector, { progress: false });
                        if (object.length === 11) continue;
                        size = object.length - 8;
                    }
                    entries.push({ kind: 'sharp', name, type_name: entryCategory.ext === 'l' ? 'LIST' : category.name, category: entryCategory, selector,
                        size, type: entryCategory.ext.charCodeAt(0), folder: '', attr: 0 });
                }
            }
            return entries;
        });
    }
    async readDirectory(category) {
        try {
            await this.command(0x61); await this.send(categoryBytes(category));
            await this.expectCommand(0x21); await this.ack();
            const echoed = await this.receive(11);
            if (text(echoed) !== text(categoryBytes(category))) throw new Error('Sharp directory category mismatch.');
            await this.ack();
            // F7B7CF filters the announced count, but F7B7FD–F7B82D
            // transmits the entire fixed table whenever that count is nonzero.
            // Empty tables still contain only count=0. Never send a premature
            // NAK at count*11 or scan for an identity inside descriptor data.
            const directory = await this.receive(1, prefix => {
                const count = prefix[0];
                if (category.directorySlots && count > category.directorySlots) throw new Error('Invalid Sharp fixed-directory count.');
                return (count && category.directorySlots || count) * 11;
            });
            await this.ack();
            const selectors = [];
            for (let offset = 1; offset < directory.length; offset += 11) {
                const selector = directory.slice(offset, offset + 11);
                if (category.name === 'MATRIX') {
                    const low = selector[0], bank = selector[1];
                    if (bank === 8) {
                        // 40..43 are internal working copies, not extra lists.
                        if (!((low >= 0x10 && low <= 0x17) || (low >= 0x20 && low <= 0x25))
                            || view(selector).getUint16(3, true) === 0) continue;
                    } else if (bank === 9) {
                        if (!((low >= 0x10 && low <= 0x19) || low === 0x30)
                            || view(selector).getUint16(3, true) === 0 || view(selector).getUint16(5, true) === 0) continue;
                    } else throw new Error('Invalid Sharp list/matrix selector.');
                }
                selectors.push(selector);
            }
            return concat(Uint8Array.of(selectors.length), ...selectors);
        } catch (error) {
            error.message = `Sharp ${category.name} directory: ${error.message}`;
            throw error;
        }
    }

    async receiveVariable(entry) {
        return this.operation(async () => {
            const { category, selector } = entry;
            const object = await this.readObject(category, selector);
            return { filename: `${entry.name.replace(/[\\/:*?"<>|]/g, '_')}.g4${category.ext}`,
                data: encodeNative(category, object, selector) };
        });
    }
    async readObject(category, selector, { progress = true } = {}) {
        if (!CATEGORIES.includes(category) || selector?.length !== 11) throw new Error('Refresh the Sharp directory before receiving this entry.');
        if (category.command) return this.receiveBlock(category.command, category.size);
        await this.command(0x62); await this.send(categoryBytes(category));
        // No ACK between selector and calculator's 22 in a host session.
        await this.write(frame(selector));
        let response = await this.receive(1);
        if (response[0] === 1) response = await this.receive(1); // receive-session bit0
        if (response[0] !== 0x22) throw new Error('Sharp variable request was rejected.');
        await this.ack();
        const metadata = await this.receive(15);
        if (text(metadata.subarray(0, 11)) !== text(categoryBytes(category))) throw new Error('Sharp variable category mismatch.');
        const length = view(metadata).getUint32(11, true);
        if (length < 10 || length > RAM_SIZE) throw new Error('Invalid Sharp variable size.');
        await this.ack();
        const object = progress ? await this.receivePayload(length) : await this.receive(length);
        validateObject(object, category); await this.ack();
        return object;
    }

    async receiveBlock(command, expectedSize) {
        await this.command(command); await this.expectCommand(command - 0x40); await this.ack();
        const length = view(await this.receive(4)).getUint32(0, true);
        if (length !== expectedSize) throw new Error('Unexpected Sharp native block size.');
        await this.ack(); const data = await this.receivePayload(length); await this.ack(); return data;
    }
    async sendFile(data, filename, { allowRestore = false } = {}) {
        const file = decodeNative(data, filename); // Validate entirely before touching the port.
        validateRestore(file, this.model, allowRestore);
        return this.operation(async () => {
            if (file.category?.dynamic) {
                // 22 appends dynamic objects even when their names match.
                // Do not claim replacement or create ambiguous duplicate names.
                const directory = await this.readDirectory(file.category);
                for (let i = 0; i < directory[0]; i++) {
                    const name = directory.subarray(1 + i * 11, 9 + i * 11);
                    if (name.every((b, n) => b === file.selector[n])) {
                        throw new Error('A Sharp ' + file.category.name + ' with this name already exists. Rename the incoming object before sending.');
                    }
                }
            }

            if (file.backup) {
                await this.command(0x27); await this.send(le32(RAM_SIZE)); await this.send(file.data, { progress: true });
                // Restoring the session RAM can leave PC-Link. Reconnect before
                // another operation instead of keeping a misleading live session.
                await this.close();
            } else if (file.category.command) {
                await this.command(file.category.command - 0x40); await this.send(le32(file.object.length)); await this.send(file.object, { progress: true });
            } else {
                await this.command(0x22); await this.send(concat(categoryBytes(file.category), le32(file.object.length))); await this.send(file.object, { progress: true });
            }
        }, { finish: !file.backup });
    }
    async receiveBackup() {
        // Identify through an ordinary session before requiring a model. End
        // the probe cleanly even when 99 leaves the exact model unknown.
        if (this.model === 'sharp-auto') await this.operation(async () => {});
        if (this.model === 'sharp-auto') throw new Error('Select the exact Sharp model in Settings before saving a RAM backup.');
        return this.operation(async () => {
            const data = await this.receiveBlock(0x67, RAM_SIZE);
            return { filename: `${this.model}.g4b`, data: concat(nativeHeader('b', ascii('BACKUP', 11), `WebTiLP ${this.model}`), data) };
        });
    }
    async captureScreenshot() {
        return this.operation(async () => {
            await this.command(0x63); await this.expectCommand(0x23); await this.ack();
            const dimensions = await this.receive(4);
            const width = view(dimensions).getUint16(0, true), height = view(dimensions).getUint16(2, true);
            if (width !== 132 || height !== 64) throw new Error('Unexpected Sharp screenshot dimensions.');
            await this.ack(); const data = await this.receivePayload(1056); await this.ack();
            return decodeScreenshot(data, width, height);
        }, { finish: false }); // Screenshot handler exits PC-Link after our ACK.
    }
    async readVersion({ keepOpenOnSilentStart = false } = {}) {
        // Auto can identify the 9950 from the session ACK before sending 74.
        // The 99 identity cannot distinguish SII from older models lacking 74.
        if (!['sharp-auto', 'sharp-el9900gsii', 'sharp-el9950'].includes(this.model)) return null;
        return this.operation(async () => {
            if (this.model === 'sharp-auto') return null;
            await this.write(frame(Uint8Array.of(0x74)));
            const digits = text(await this.receive(6));
            if (!/^\d{6}$/.test(digits)) throw new Error('Invalid Sharp firmware version.');
            this.version = `${digits[0]}.${digits.slice(1, 3)}`;
            return this.version;
        }, { keepOpenOnSilentStart });
    }
    async receiveDump({ includeBoot = false } = {}) {
        return this.operation(async () => {
            // No PC-Link session is sent. Start reception before selecting SEND
            // in REPROGRAM. The header always starts at 19200, even without boot.
            await this.configureSerial(19200, 1);
            const receiver = new DumpReceiver({ recoverFirstHeader: true });
            while (!receiver.complete) {
                let events;
                // Parse incrementally: a damaged transition header must not
                // determine how many payload bytes we attempt to receive.
                try { events = receiver.push(await this.read(Math.max(1, this.queue.length))); }
                catch (error) {
                    if (error.code === 'SHARP_RESPONSE_TIMEOUT') {
                        error.message = `Sharp REPROGRAM timed out while receiving ${receiver.phase}. Restart reception, then choose ${includeBoot ? '3:Send(with Boot Page)' : '2:Send'} on the calculator.`;
                    }
                    await this.write(ascii('NG')).catch(() => {}); throw error;
                }
                for (const event of events) {
                    if (event.type === 'header' && event.boot !== includeBoot) throw new Error('REPROGRAM Boot Page setting does not match this request.');
                    await this.write(ascii('OK'));
                    if (event.type === 'end' || receiver.header.mode === 0x80 && (event.lastBoot
                        || event.type === 'header' && !event.boot)) {
                        // WebSerial write completion need not mean the USB UART
                        // has sent OK. Allow wire time plus the supplied dumper's
                        // 3 ms guard before changing UART settings or reopening.
                        await new Promise(resolve => setTimeout(resolve, Math.ceil(20 * 1000 / this.baudRate) + 3));
                        if (event.type !== 'end') await this.configureSerial(38400, 1);
                    }
                    this.onProgress({ completed: event.type === 'end' ? receiver.image.length
                        : receiver.blocks.reduce((sum, b) => sum + b.length, 0), total: receiver.image.length });
                }
            }
            if (this.queue.length) throw new Error('Extra serial data after Sharp dump.');
            const manifest = { ...receiver.manifest(), model: this.model,
                serialSettings: { initialBaud: 19200, dataBaud: receiver.header.mode === 0x80 ? 38400 : 19200, stopBits: 1 },
                checksumValidated: true };
            if (scope.crypto?.subtle) {
                const digest = await scope.crypto.subtle.digest('SHA-256', receiver.image);
                manifest.imageSHA256 = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
            }
            const result = { filename: `${this.model}-${includeBoot ? 'rom' : 'system'}.bin`, data: receiver.image, manifest };
            await this.configureSerial(38400, 2); return result;
        }, { session: false });
    }
    async configureSerial(baudRate, stopBits) {
        // Direct CE-LK4 transports can keep their reads queued while changing
        // UART settings. Standard WebSerial only permits close/open.
        if (!this.port.setOptions) return this.reopen(baudRate, stopBits);
        if (this.closed || this.error) throw this.error || new Error('Sharp operation cancelled.');
        await this.port.setOptions({ baudRate, stopBits });
        if (this.closed || this.error) throw this.error || new Error('Sharp operation cancelled.');
        this.baudRate = baudRate;
    }
    async reopen(baudRate, stopBits) {
        await this.close({ reopening: true });
        if (this.cancelled) throw new Error('Sharp operation cancelled.');
        await this.connect({ baudRate, stopBits });
    }
    async close({ reopening = false } = {}) {
        if (!reopening) this.cancelled = true;
        if (this.closing) return this.closing;
        this.closed = true; this.wake();
        const reader = this.reader, writer = this.writer, pump = this.pump;
        this.closing = (async () => {
            // WebUSB writes have no per-transfer cancellation. Close the USB
            // device before waiting for a stream abort that would wait on them.
            try { await this.port.abort?.(); } catch (_) {}
            try { await reader?.cancel(); } catch (_) {}
            try { await writer?.abort(); } catch (_) {}
            await pump;
            reader?.releaseLock(); writer?.releaseLock(); this.reader = null; this.writer = null;
            if (this.port.readable || this.port.writable) await this.port.close();
        })();
        try { await this.closing; } finally { this.closing = null; }
    }
}
const api = { SharpBackend, DumpReceiver, MODELS, CATEGORIES, VENDOR_ID, PRODUCT_ID,
    RAM_SIZE, frame, checksum, decodeNative, encodeNative, nativeHeader, decodeScreenshot, validateRestore,
    isSharpUsbDevice: device => device?.vendorId === VENDOR_ID && device?.productId === PRODUCT_ID,
    isSharpSerialInfo: info => info?.usbVendorId === VENDOR_ID && info?.usbProductId === PRODUCT_ID };
scope.WebTILPSharp = api;
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
