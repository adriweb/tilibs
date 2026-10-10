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
    { name: 'GRAPH EQU', ext: 'y' }, { name: 'MATRIX', ext: 'm' },
    { name: 'PICT', ext: 'i' }, { name: 'GDB', ext: 'd' },
    { name: 'MATRIX', ext: 'l', alias: true }, { name: 'LISTDB', ext: 'n' },
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
    if (!category) throw new Error('Unsupported Sharp file type (groups and text require PC-Link conversion).');
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
    constructor() {
        this.pending = new Uint8Array(); this.phase = 'header'; this.complete = false;
        this.failed = false; this.blocks = []; this.lastEnd = BASE; this.systemBlocks = 0;
    }
    push(chunk) {
        if (this.failed || (this.complete && chunk.length)) { this.failed = true; this.complete = false; throw new Error('Unexpected data after the Sharp dump ended.'); }
        this.pending = concat(this.pending, chunk);
        const events = [];
        try {
            while (!this.complete && this.pending.length >= 6) {
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
                    events.push({ type: 'block', ...block, lastBoot });
                }
            }
            return events;
        } catch (error) { this.failed = true; this.complete = false; throw error; }
    }
    manifest() {
        return { format: 'sharp-reprogram-capture-v1', complete: this.complete, base: BASE,
            endExclusive: this.header?.boot ? ROM_END : OS_END, header: this.header,
            blocks: this.blocks, erasedGapsInferredFromProtocol: true };
    }
}

class SharpBackend {
    constructor({ serialPort, model = 'sharp-auto', timeoutMs = 30000, onProgress = () => {} }) {
        if (!MODELS[model]) throw new Error('Unknown Sharp model.');
        this.port = serialPort; this.model = model; this.timeoutMs = timeoutMs;
        this.onProgress = onProgress; this.queue = new Uint8Array(); this.waiters = new Set();
        this.busy = false; this.cancelled = false; this.closed = true; this.identity = null; this.error = null;
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
                this.queue = concat(this.queue, value); this.wake();
            }
        } catch (error) { if (!this.closed) this.error = error; this.wake(); }
    }
    wake() { for (const waiter of this.waiters) waiter(); }
    async read(length) {
        const deadline = Date.now() + this.timeoutMs;
        while (this.queue.length < length) {
            if (this.closed || this.error) throw this.error || new Error('Sharp operation cancelled.');
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new Error('Sharp response timed out. Reconnect and restart PC-Link on the calculator.');
            await new Promise(resolve => {
                const wake = () => { clearTimeout(timer); this.waiters.delete(wake); resolve(); };
                const timer = setTimeout(wake, remaining); this.waiters.add(wake);
            });
        }
        if (this.closed || this.error) throw this.error || new Error('Sharp operation cancelled.');
        const result = this.queue.slice(0, length); this.queue = this.queue.slice(length);
        this.onProgress({ transferred: length }); return result;
    }
    async write(data) {
        if (this.closed || this.error) throw this.error || new Error('Sharp serial port is closed.');
        // Never retry an uncertain/partial serial write.
        await Promise.race([this.writer.write(data), new Promise((_, reject) => {
            this.writeTimer = setTimeout(() => reject(new Error('Sharp serial write timed out.')), this.timeoutMs);
        })]).finally(() => clearTimeout(this.writeTimer));
        if (this.closed) throw new Error('Sharp operation cancelled.');
    }
    async receive(length, dynamicLength = null) {
        for (let retry = 0; retry < 3; retry++) {
            const prefix = await this.read(2 + length);
            const identity = text(prefix.subarray(0, 2));
            if (!['99', '9:'].includes(identity) || (this.identity && this.identity !== identity)) throw new Error('Unexpected Sharp sender identity.');
            if (this.model === 'sharp-el9950' && identity !== '9:' || this.model !== 'sharp-auto' && this.model !== 'sharp-el9950' && identity !== '99') throw new Error('Selected Sharp model does not match the calculator identity.');
            this.identity = identity;
            const extraLength = dynamicLength ? dynamicLength(prefix.subarray(2)) : 0;
            if (!Number.isSafeInteger(extraLength) || extraLength < 0 || extraLength > RAM_SIZE) throw new Error('Invalid Sharp frame size.');
            const packet = concat(prefix, await this.read(extraLength + 2));
            if (view(packet).getUint16(packet.length - 2, true) === checksum(packet.subarray(0, packet.length - 2))) return packet.slice(2, -2);
            await this.write(frame(Uint8Array.of(0x81)));
        }
        throw new Error('Sharp frame checksum failed after three attempts.');
    }
    async ack() { await this.write(frame(Uint8Array.of(1))); }
    async expectCommand(expected) {
        const data = await this.receive(1);
        if (data[0] !== expected) {
            const error = new Error(data[0] === 0x84 ? 'Sharp calculator has insufficient memory.' : `Unexpected Sharp response 0x${data[0].toString(16)} (expected 0x${expected.toString(16)}).`);
            error.code = data[0]; throw error;
        }
    }
    async send(payload) {
        const packet = frame(payload);
        for (let retry = 0; retry < 3; retry++) {
            await this.write(packet);
            const response = await this.receive(1);
            if (response[0] === 1) return;
            if (response[0] !== 0x81) {
                const error = new Error(response[0] === 0x84 ? 'Sharp calculator has insufficient memory.' : `Sharp rejected the transfer (0x${response[0].toString(16)}).`);
                error.code = response[0]; throw error;
            }
        }
        throw new Error('Sharp transfer retry limit reached.');
    }
    async command(value) { await this.send(Uint8Array.of(value)); }
    async operation(callback, { session = true, finish = true } = {}) {
        if (this.busy) throw new Error('A Sharp operation is already running.');
        if (this.closed || this.error) throw this.error || new Error('Reconnect the Sharp calculator first.');
        this.busy = true;
        try {
            if (session) await this.command(0x42);
            const result = await callback();
            if (session && finish) await this.command(0x41);
            return result;
        } catch (error) {
            await this.close().catch(() => {}); throw error;
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
                await this.command(0x61); await this.send(categoryBytes(category));
                await this.expectCommand(0x21); await this.ack();
                const echoed = await this.receive(11);
                if (text(echoed) !== text(categoryBytes(category))) throw new Error('Sharp directory category mismatch.');
                await this.ack();
                const directory = await this.receive(1, prefix => prefix[0] * 11); await this.ack();
                for (let i = 0; i < directory[0]; i++) {
                    const selector = directory.slice(1 + i * 11, 12 + i * 11);
                    const entryCategory = category.name === 'MATRIX' && selector[1] === 8
                        ? CATEGORIES.find(item => item.ext === 'l') : category;
                    const name = category.dynamic ? text(selector.subarray(0, 8)).replace(/[\0 ]+$/, '')
                        : `${category.name} ${view(selector).getUint16(0, true)}`;
                    entries.push({ kind: 'sharp', name, type_name: entryCategory.ext === 'l' ? 'LIST' : category.name, category: entryCategory, selector,
                        size: 0, type: entryCategory.ext.charCodeAt(0), folder: '', attr: 0 });
                }
            }
            return entries;
        });
    }
    async receiveVariable(entry) {
        return this.operation(async () => {
            const { category, selector } = entry;
            if (!CATEGORIES.includes(category) || selector?.length !== 11) throw new Error('Refresh the Sharp directory before receiving this entry.');
            let object;
            if (category.command) {
                object = await this.receiveBlock(category.command, category.size);
            } else {
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
                await this.ack(); object = await this.receive(length); validateObject(object, category); await this.ack();
            }
            return { filename: `${entry.name.replace(/[\\/:*?"<>|]/g, '_')}.g4${category.ext}`,
                data: encodeNative(category, object, selector) };
        });
    }
    async receiveBlock(command, expectedSize) {
        await this.command(command); await this.expectCommand(command - 0x40); await this.ack();
        const length = view(await this.receive(4)).getUint32(0, true);
        if (length !== expectedSize) throw new Error('Unexpected Sharp native block size.');
        await this.ack(); const data = await this.receive(length); await this.ack(); return data;
    }
    async sendFile(data, filename, { allowRestore = false } = {}) {
        const file = decodeNative(data, filename); // Validate entirely before touching the port.
        validateRestore(file, this.model, allowRestore);
        return this.operation(async () => {
            if (file.backup) {
                await this.command(0x27); await this.send(le32(RAM_SIZE)); await this.send(file.data);
                // Restoring the session RAM can leave PC-Link. Reconnect before
                // another operation instead of keeping a misleading live session.
                await this.close();
            } else if (file.category.command) {
                await this.command(file.category.command - 0x40); await this.send(le32(file.object.length)); await this.send(file.object);
            } else {
                await this.command(0x22); await this.send(concat(categoryBytes(file.category), le32(file.object.length))); await this.send(file.object);
            }
        }, { finish: !file.backup });
    }
    async receiveBackup() {
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
            await this.ack(); const data = await this.receive(1056); await this.ack();
            return decodeScreenshot(data, width, height);
        });
    }
    async readVersion() {
        // 74 is only present in the extended SII/9950 dispatcher. Older models
        // have no safe version request; report the selected model only.
        if (!['sharp-el9900gsii', 'sharp-el9950'].includes(this.model)) return null;
        return this.operation(async () => {
            await this.write(frame(Uint8Array.of(0x74)));
            const digits = text(await this.receive(6));
            if (!/^\d{6}$/.test(digits)) throw new Error('Invalid Sharp firmware version.');
            return `${digits[0]}.${digits.slice(1, 3)}`;
        });
    }
    async receiveDump({ includeBoot = false } = {}) {
        return this.operation(async () => {
            // No PC-Link session is sent. Start reception before selecting SEND
            // in REPROGRAM. The header always starts at 19200, even without boot.
            await this.reopen(19200, 1);
            const receiver = new DumpReceiver();
            while (!receiver.complete) {
                const header = await this.read(6), length = view(header).getUint16(4, true);
                if (length > 0x4000) throw new Error('Invalid Sharp dump block length.');
                const packet = concat(header, await this.read(length + 2));
                let events;
                try { events = receiver.push(packet); } catch (error) { await this.write(ascii('NG')); throw error; }
                for (const event of events) {
                    if (event.type === 'header' && event.boot !== includeBoot) throw new Error('REPROGRAM Boot Page setting does not match this request.');
                    await this.write(ascii('OK'));
                    if (event.type === 'end' || receiver.header.mode === 0x80 && (event.lastBoot
                        || event.type === 'header' && !event.boot)) {
                        // WebSerial write completion need not mean the USB UART
                        // has sent OK. Allow wire time plus the supplied dumper's
                        // 3 ms guard before aborting streams to close/reopen.
                        await new Promise(resolve => setTimeout(resolve, Math.ceil(20 * 1000 / this.baudRate) + 3));
                        if (event.type !== 'end') await this.reopen(38400, 1);
                    }
                    this.onProgress({ completed: receiver.blocks.reduce((sum, b) => sum + b.length, 0), total: receiver.image.length });
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
            await this.reopen(38400, 2); return result;
        }, { session: false });
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
