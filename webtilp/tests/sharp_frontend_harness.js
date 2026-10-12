/* Browser QA only: this page exposes a clearly marked simulated serial cable. */
(() => {
'use strict';
const api = WebTILPSharp;
const serialInfoMode = new URLSearchParams(location.search).get('serialInfo');
const identity = '9:';
const category = api.CATEGORIES.find(c => c.ext === 'p');
const ascii = value => Uint8Array.from(value, c => c.charCodeAt(0));
const join = (...parts) => {
    const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; } return result;
};
const length = n => { const value = new Uint8Array(4); new DataView(value.buffer).setUint32(0, n, true); return value; };
const selector = ascii('HELLO\0\0\0\0\0\0');
const object = join(length(24), length(48), selector, [0], [0x0A, 0x10, 0xFD, 0xFF]);
const bitmap = new Uint8Array(1056);
for (let x = 0; x < 132; x++) {
    bitmap[x] = 0x80; bitmap[7 * 132 + x] = 1;
    const y = Math.floor(x * 63 / 131); bitmap[(y >> 3) * 132 + x] |= 0x80 >> (y & 7);
}
for (let y = 0; y < 64; y++) { bitmap[(y >> 3) * 132] |= 0x80 >> (y & 7); bitmap[(y >> 3) * 132 + 131] |= 0x80 >> (y & 7); }
class SimulatedPort {
    getInfo() {
        if (serialInfoMode === 'missing') return {};
        if (serialInfoMode === 'alternate') return { usbVendorId: 0x1234, usbProductId: 0x5678 };
        return { usbVendorId: 0x04FC, usbProductId: 0x0201 };
    }
    async open(options) {
        if (options.stopBits !== 2 || options.baudRate !== 38400) throw new Error('This browser peer simulates PC-Link only.');
        this.phase = 'command';
        this.readable = new ReadableStream({ start: controller => { this.controller = controller; } });
        this.writable = new WritableStream({ write: packet => this.receive(packet) });
    }
    reply(payload) {
        const packet = api.frame(typeof payload === 'number' ? Uint8Array.of(payload) : payload, identity);
        for (let i = 0; i < packet.length; i += 137) this.controller.enqueue(packet.slice(i, i + 137));
    }
    receive(packet) {
        const data = packet.slice(2, -2);
        if (this.phase === 'directory-category') {
            this.category = data; this.reply(1); this.reply(0x21); this.phase = 'directory-echo'; return;
        }
        if (this.phase === 'receive-category') {
            this.category = data; this.reply(1); this.phase = 'receive-selector'; return;
        }
        if (this.phase === 'receive-selector') { this.reply(0x22); this.phase = 'receive-metadata'; return; }
        if (this.phase === 'send-metadata' || this.phase === 'restore-length') {
            this.reply(1); this.phase = 'send-body'; return;
        }
        if (this.phase === 'send-body') { this.reply(1); this.phase = 'command'; return; }
        if (data[0] === 1) {
            switch (this.phase) {
                case 'directory-echo': this.reply(this.category); this.phase = 'directory-body'; return;
                case 'directory-body': this.reply(String.fromCharCode(...this.category).trim() === 'PROGRAM' ? join([1], selector) : [0]); this.phase = 'done'; return;
                case 'receive-metadata': this.reply(join(this.category, length(object.length))); this.phase = 'receive-body'; return;
                case 'receive-body': this.reply(object); this.phase = 'done'; return;
                case 'screen-dimensions': this.reply([132, 0, 64, 0]); this.phase = 'screen-body'; return;
                case 'screen-body': this.reply(bitmap); this.phase = 'done'; return;
                case 'backup-length': this.reply(length(api.RAM_SIZE)); this.phase = 'backup-body'; return;
                case 'backup-body': this.reply(new Uint8Array(api.RAM_SIZE).fill(23)); this.phase = 'done'; return;
                case 'fixed-length': this.reply(length(this.fixed.size)); this.phase = 'fixed-body'; return;
                case 'fixed-body': this.reply(new Uint8Array(this.fixed.size).fill(this.fixed.command)); this.phase = 'done'; return;
                case 'done': this.phase = 'command'; return;
            }
        }
        switch (data[0]) {
            case 0x42: case 0x41: this.reply(1); this.phase = 'command'; break;
            case 0x61: this.reply(1); this.phase = 'directory-category'; break;
            case 0x62: this.reply(1); this.phase = 'receive-category'; break;
            case 0x22: this.reply(1); this.phase = 'send-metadata'; break;
            case 0x27: this.reply(1); this.phase = 'restore-length'; break;
            case 0x63: this.reply(1); this.reply(0x23); this.phase = 'screen-dimensions'; break;
            case 0x67: this.reply(1); this.reply(0x27); this.phase = 'backup-length'; break;
            case 0x74: this.reply(ascii('120000')); break;
            case 0x68: case 0x69: case 0x6A: case 0x6B:
                this.fixed = api.CATEGORIES.find(c => c.command === data[0]);
                this.reply(1); this.reply(data[0] - 0x40); this.phase = 'fixed-length'; break;
            case 0x28: case 0x29: case 0x2A: case 0x2B:
                this.reply(1); this.phase = 'send-metadata'; break;
            default: throw new Error(`Unimplemented simulated Sharp command ${data[0]}`);
        }
    }
    async close() { this.readable = null; this.writable = null; }
}
const port = new SimulatedPort();
let granted = false;
const serial = { async getPorts() { return granted ? [port] : []; }, async requestPort(options) {
    if (options?.filters?.length && !options.filters.some(filter =>
        filter.usbVendorId === port.getInfo().usbVendorId && (!filter.usbProductId || filter.usbProductId === port.getInfo().usbProductId))) {
        throw new DOMException('No compatible simulated port', 'NotFoundError');
    }
    granted = true; return port;
}, addEventListener() {} };
Object.defineProperty(navigator, 'serial', { configurable: true, value: serial });
// Avoid opening any actual hardware chooser in this QA harness.
Object.defineProperty(navigator, 'usb', { configurable: true, value: undefined });
const controls = document.createElement('div');
controls.id = 'sharpTestControls';
controls.style.cssText = 'position:fixed;bottom:8px;right:8px;z-index:10000;background:#111827;color:white;border:1px solid #586178;padding:8px;border-radius:8px;display:flex;gap:8px';
const label = document.createElement('span'); label.textContent = `Simulated Sharp serial peer (no hardware; USB IDs: ${serialInfoMode || 'Sunplus'})`; controls.appendChild(label);
const button = document.createElement('button'); button.id = 'sharpTestFile'; button.textContent = 'Get simulated g4p';
button.onclick = () => triggerDownload('HELLO.g4p', api.encodeNative(category, object, selector)); controls.appendChild(button);
document.body.appendChild(controls);
updateTransportSplashState();
})();
