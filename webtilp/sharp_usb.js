/* CE-LK4 / SPCP825 UART transport. Deliberately limited to 04fc:0201.
 * Windows/Linux retain the OS serial driver; macOS can use direct WebUSB.
 */
(function (scope) {
'use strict';
const ports = new WeakMap();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function uartValue({ baudRate, stopBits = 2, dataBits = 8, parity = 'none', flowControl = 'none' }) {
    if (![19200, 38400].includes(baudRate) || ![1, 2].includes(stopBits) || dataBits !== 8 || parity !== 'none' || flowControl !== 'none') {
        throw new TypeError('Unsupported CE-LK4 serial settings.');
    }
    return (baudRate === 38400 ? 9 : 7) | ((3 | (stopBits === 2 ? 4 : 0)) << 8);
}
class SharpUsbPort extends EventTarget {
    constructor(device) {
        super();
        if (device?.vendorId !== 0x04fc || device?.productId !== 0x0201) throw new TypeError('Expected a Sharp CE-LK4.');
        this.device = device; this.readable = null; this.writable = null; this.epoch = 0;
    }
    getInfo() { return { usbVendorId: this.device.vendorId, usbProductId: this.device.productId }; }
    async open({ baudRate, stopBits = 2, dataBits = 8, parity = 'none', flowControl = 'none' }) {
        if (this.opening || this.readable || this.writable) throw new Error('CE-LK4 is already open.');
        uartValue({ baudRate, stopBits, dataBits, parity, flowControl });
        this.opening = true;
        try {
            await this.device.open();
            if (this.device.configuration?.configurationValue !== 1) await this.device.selectConfiguration(1);
            const iface = this.device.configuration.interfaces.find(i => i.interfaceNumber === 0);
            const alternate = iface?.alternates.find(a => a.alternateSetting === 0);
            const hasEndpoint = (direction, number) => alternate?.endpoints.some(e => e.type === 'bulk' && e.direction === direction && e.endpointNumber === number);
            if (!hasEndpoint('in', 1) || !hasEndpoint('out', 2)) throw new Error('Unexpected CE-LK4 USB interface.');
            const readSize = alternate.endpoints.find(e => e.direction === 'in' && e.endpointNumber === 1).packetSize;
            if (!Number.isInteger(readSize) || readSize <= 0 || readSize > 512) throw new Error('Invalid CE-LK4 USB packet size.');
            await this.device.claimInterface(0);
            if (iface.alternate.alternateSetting !== 0) await this.device.selectAlternateInterface(0, 0);
            await this.device.clearHalt('in', 1); await this.device.clearHalt('out', 2);
            await this.setOptions({ baudRate, stopBits });
            // SPCP825 has no UART-status or work-mode requests (newer chips do).
            await pause(1000);
            const epoch = ++this.epoch;
            // Keep USB reads queued while JavaScript handles previous packets.
            // With only one outstanding read, a main-thread pause can overflow
            // the UART adapter during a continuous RAM/ROM transfer. Each read
            // still requests exactly one packet: larger buffers can deadlock on
            // framed replies without a terminating zero-length packet.
            const submitRead = () => this.device.transferIn(1, readSize).then(
                result => ({result}), error => ({error}));
            const reads = Array.from({length: 64}, submitRead);
            this.readable = new ReadableStream({
                pull: async controller => {
                    try {
                        while (epoch === this.epoch) {
                            // Consume in submission order even if promise
                            // callbacks are scheduled in a different order.
                            // Every pending rejection is handled immediately,
                            // including when close aborts the entire pipeline.
                            const {result, error} = await reads.shift();
                            if (epoch !== this.epoch) return;
                            if (error) throw error;
                            if (result.status !== 'ok') throw new Error('CE-LK4 USB read failed: ' + result.status);
                            reads.push(submitRead());
                            if (result.data?.byteLength) {
                                controller.enqueue(new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength).slice());
                                return;
                            }
                        }
                    } catch (error) { if (epoch === this.epoch) controller.error(error); }
                },
                cancel: () => { this.epoch++; }
            });
            this.writable = new WritableStream({write: async chunk => {
                if (epoch !== this.epoch) throw new Error('CE-LK4 is closed.');
                const data = chunk instanceof ArrayBuffer ? new Uint8Array(chunk)
                    : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
                const started = performance.now();
                const result = await this.device.transferOut(2, data);
                if (result.status !== 'ok' || result.bytesWritten !== data.byteLength) throw new Error('Incomplete CE-LK4 USB write.');
                if (epoch !== this.epoch) throw new Error('CE-LK4 is closed.');
                // Bulk completion only queues UART data. Avoid losing the next
                // frame when ACK and session-end are written back-to-back.
                await new Promise(resolve => {
                    const timer = setTimeout(() => { this.finishWriteDelay = null; resolve(); },
                        Math.max(0, data.byteLength * (9 + this.stopBits) * 1000 / this.baudRate - (performance.now() - started)) + 5);
                    this.finishWriteDelay = () => { clearTimeout(timer); this.finishWriteDelay = null; resolve(); };
                });
                if (epoch !== this.epoch) throw new Error('CE-LK4 is closed.');
            }});
        } catch (error) { await this.close(); throw error; }
        finally { this.opening = false; }
    }
    async setOptions(options) {
        const value = uartValue(options), epoch = this.epoch;
        if (!this.device.opened) throw new Error('CE-LK4 is closed.');
        const setup = await this.device.controlTransferOut({requestType:'vendor', recipient:'device', request:0x21, value, index:0});
        if (epoch !== this.epoch || !this.device.opened) throw new Error('CE-LK4 is closed.');
        if (setup.status !== 'ok') throw new Error('CE-LK4 UART setup failed.');
        this.baudRate = options.baudRate; this.stopBits = options.stopBits ?? 2;
    }
    async close() {
        this.epoch++;
        this.finishWriteDelay?.();
        // Closing the device aborts outstanding transferIn; WebUSB provides no
        // per-transfer cancellation. Stream readers are cancelled by backend.
        try { if (this.device.opened) await this.device.close(); }
        finally { this.readable = null; this.writable = null; }
    }
    async abort() { await this.close(); }
}
function shouldUse(nav = scope.navigator) {
    return Boolean(nav?.usb && (!nav.serial || /Mac/i.test(nav.userAgentData?.platform || nav.platform || '')));
}
function createPort(device) {
    if (!ports.has(device)) ports.set(device, new SharpUsbPort(device));
    return ports.get(device);
}
const api = {SharpUsbPort, createPort, shouldUse};
scope.WebTILPSharpUsb = api;
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
