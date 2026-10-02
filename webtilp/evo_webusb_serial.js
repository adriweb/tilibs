/* USB CDC ACM adapter for WebTiLP's Evo Web Serial transport.
 * This is deliberately scoped to 0451:e018; it does not replace navigator.serial.
 */
(() => {
    'use strict';

    const ports = new WeakMap();
    let androidVersion;
    // Capture before app.js consumes its one-shot URL setting overrides.
    const transportOverride = globalThis.location
        ? new URLSearchParams(globalThis.location.search).get('evoSerial') : null;

    async function shouldUse(nav = navigator) {
        if (!nav.usb) return false;
        // Also useful for diagnosing Android builds that hide OS Client Hints.
        if (transportOverride === 'webusb') return true;
        if (transportOverride === 'native') return false;
        if (!nav.serial) return true;
        const data = nav.userAgentData;
        if (data?.platform !== 'Android' && !/Android/i.test(nav.userAgent || '')) return false;
        // Chrome's reduced user agent reports Android 10 even on newer phones.
        // Prefer UA Client Hints and keep native Serial when that version is unknown.
        if (!androidVersion) {
            androidVersion = (async () => {
                if (data?.getHighEntropyValues) {
                    try {
                        const hints = await data.getHighEntropyValues(['platformVersion']);
                        return Number.parseInt(hints.platformVersion, 10) || null;
                    } catch (_) { return null; }
                }
                return Number.parseInt(/Android\s+(\d+)/i.exec(nav.userAgent || '')?.[1], 10) || null;
            })();
        }
        const major = await androidVersion;
        return major !== null && major < 17;
    }

    function failure(message, name = 'NetworkError') {
        return new DOMException(message, name);
    }

    function findInterfaces(configuration) {
        const controls = [];
        const transfers = [];
        for (const iface of configuration.interfaces) {
            for (const alternate of iface.alternates) {
                if (alternate.interfaceClass === 2 && alternate.interfaceSubclass === 2) {
                    controls.push({ iface, alternate });
                }
                if (alternate.interfaceClass !== 10) continue;
                const input = alternate.endpoints.find(ep => ep.type === 'bulk' && ep.direction === 'in' && ep.packetSize > 0);
                const output = alternate.endpoints.find(ep => ep.type === 'bulk' && ep.direction === 'out' && ep.packetSize > 0);
                if (input && output) transfers.push({ iface, alternate, input, output });
            }
        }
        // WebUSB does not expose CDC Union descriptors. Evo has one ACM function;
        // reject ambiguous descriptors instead of pairing unrelated interfaces.
        if (controls.length !== 1 || transfers.length !== 1
            || controls[0].iface === transfers[0].iface) return null;
        return { control: controls[0], ...transfers[0] };
    }

    class EvoSerialPort extends EventTarget {
        constructor(device) {
            super();
            this.device = device;
            this.readable = null;
            this.writable = null;
            this._connected = true;
            this._opening = false;
            this._closing = false;
            this.lastOpenError = null;
            this._epoch = 0;
            this._signals = 0;
            this._disconnect = event => {
                if (event.device !== this.device) return;
                this._connected = false;
                this._epoch++;
                const error = failure('The Evo USB device was disconnected.');
                try { this._readController?.error(error); } catch (_) {}
                try { this._writeController?.error(error); } catch (_) {}
                this.readable = null;
                this.writable = null;
                this._readController = null;
                this._writeController = null;
                navigator.usb.removeEventListener('disconnect', this._disconnect);
                this.dispatchEvent(new Event('disconnect'));
            };
        }

        get connected() { return this._connected; }

        getInfo() {
            return { usbVendorId: this.device.vendorId, usbProductId: this.device.productId };
        }

        async _control(request, value, bytes = new Uint8Array()) {
            const result = await this.device.controlTransferOut({
                requestType: 'class', recipient: 'interface', request, value,
                index: this._interfaces.control.iface.interfaceNumber
            }, bytes);
            if (result.status !== 'ok' || result.bytesWritten !== bytes.byteLength) {
                throw failure(`Evo CDC request 0x${request.toString(16)} failed (${result.status}).`);
            }
        }

        async open(options) {
            if (this._opening || this._closing || this.readable || this.writable) {
                throw failure('The serial port is already open or changing state.', 'InvalidStateError');
            }
            const { baudRate, dataBits = 8, stopBits = 1, parity = 'none',
                bufferSize = 255, flowControl = 'none' } = options || {};
            if (!Number.isInteger(baudRate) || baudRate <= 0 || baudRate > 0xffffffff
                || ![7, 8].includes(dataBits) || ![1, 2].includes(stopBits)
                || !['none', 'even', 'odd'].includes(parity)
                || !Number.isInteger(bufferSize) || bufferSize <= 0 || bufferSize > 16 * 1024 * 1024
                || !['none', 'hardware'].includes(flowControl)) {
                throw new TypeError('Invalid Web Serial port options.');
            }
            if (flowControl === 'hardware') {
                throw failure('Evo CDC does not support hardware flow control.', 'NotSupportedError');
            }
            this._opening = true;
            this.lastOpenError = null;
            try {
                await this.device.open();
                const configuration = this.device.configurations.find(findInterfaces);
                if (!configuration) throw failure('No unambiguous Evo CDC ACM interface pair was found.', 'NotSupportedError');
                if (this.device.configuration?.configurationValue !== configuration.configurationValue) {
                    await this.device.selectConfiguration(configuration.configurationValue);
                }
                this._interfaces = findInterfaces(this.device.configuration);
                if (!this._interfaces) throw failure('The selected Evo USB configuration has no CDC ACM interface pair.', 'NotSupportedError');
                for (const item of [this._interfaces.control, this._interfaces]) {
                    const number = item.iface.interfaceNumber;
                    await this.device.claimInterface(number);
                    if (item.iface.alternate.alternateSetting !== item.alternate.alternateSetting) {
                        await this.device.selectAlternateInterface(number, item.alternate.alternateSetting);
                    }
                }
                const coding = new Uint8Array(7);
                new DataView(coding.buffer).setUint32(0, baudRate, true);
                coding[4] = stopBits === 2 ? 2 : 0;
                coding[5] = { none: 0, odd: 1, even: 2 }[parity];
                coding[6] = dataBits;
                await this._control(0x20, 0, coding); // SET_LINE_CODING
                await this._control(0x22, 3); // Assert DTR and RTS, as a native open does.
                this._signals = 3;
                this._connected = true;
                const epoch = ++this._epoch;
                const packetSize = this._interfaces.input.packetSize;
                const readSize = Math.ceil(bufferSize / packetSize) * packetSize;
                this.readable = new ReadableStream({
                    type: 'bytes',
                    start: controller => { this._readController = controller; },
                    pull: async controller => {
                        try {
                            while (epoch === this._epoch) {
                                const result = await this.device.transferIn(this._interfaces.input.endpointNumber, readSize);
                                if (epoch !== this._epoch) return;
                                if (result.status !== 'ok') throw failure(`Evo USB read failed (${result.status}).`);
                                if (result.data?.byteLength) {
                                    // Copy: enqueue() transfers ownership of byte-stream buffers.
                                    controller.enqueue(new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength).slice());
                                    return;
                                }
                            }
                        } catch (error) {
                            if (epoch === this._epoch) controller.error(error);
                        }
                    },
                    // WebUSB has no transfer cancellation. Stop delivery immediately;
                    // close() closes the USB device to unblock any outstanding transfer.
                    cancel: () => { this._epoch++; }
                });
                this.writable = new WritableStream({
                    start: controller => { this._writeController = controller; },
                    write: async chunk => {
                        if (!(chunk instanceof ArrayBuffer) && !ArrayBuffer.isView(chunk)) {
                            throw new TypeError('Serial writes require a BufferSource.');
                        }
                        const bytes = chunk instanceof ArrayBuffer ? new Uint8Array(chunk)
                            : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
                        // A USB transfer can succeed after writing only part of a chunk.
                        let offset = 0;
                        while (offset < bytes.byteLength) {
                            const result = await this.device.transferOut(this._interfaces.output.endpointNumber, bytes.subarray(offset));
                            if (result.status !== 'ok' || !Number.isInteger(result.bytesWritten)
                                || result.bytesWritten <= 0 || result.bytesWritten > bytes.byteLength - offset) {
                                throw failure(`Evo USB write failed (${result.status}).`);
                            }
                            offset += result.bytesWritten;
                        }
                    }
                });
                navigator.usb.addEventListener('disconnect', this._disconnect);
            } catch (error) {
                this.lastOpenError = error;
                await this._release();
                throw error;
            } finally {
                this._opening = false;
            }
        }

        async _release() {
            navigator.usb.removeEventListener('disconnect', this._disconnect);
            this._epoch++;
            // Close first to abort pending reads; releasing interfaces can otherwise
            // wait for a transfer whose device will never send another packet.
            try { if (this.device.opened) await this.device.close(); } catch (_) {}
            this._readController = null;
            this._writeController = null;
            this.readable = null;
            this.writable = null;
        }

        async close() {
            if (this._opening || this._closing || (!this.readable && !this.writable)) {
                throw failure('The serial port is not open or is changing state.', 'InvalidStateError');
            }
            if (this.readable?.locked || this.writable?.locked) {
                throw failure('Release the serial stream locks before closing the port.', 'InvalidStateError');
            }
            this._closing = true;
            this._epoch++;
            try {
                try { this._readController?.close(); } catch (_) {}
                try { this._writeController?.error(failure('The serial port was closed.', 'InvalidStateError')); } catch (_) {}
                if (this.device.opened) await this._control(0x22, 0);
            } finally {
                await this._release();
                this._closing = false;
            }
        }

        async setSignals(signals = {}) {
            if (!this.readable && !this.writable) throw failure('The serial port is not open.', 'InvalidStateError');
            let value = this._signals;
            if ('dataTerminalReady' in signals) value = signals.dataTerminalReady ? value | 1 : value & ~1;
            if ('requestToSend' in signals) value = signals.requestToSend ? value | 2 : value & ~2;
            if (value !== this._signals) {
                await this._control(0x22, value);
                this._signals = value;
            }
            if ('break' in signals) await this._control(0x23, signals.break ? 0xffff : 0);
        }

        async getSignals() {
            if (!this.readable && !this.writable) throw failure('The serial port is not open.', 'InvalidStateError');
            // CDC ACM has no CTS bit. Never invent input signals; Evo doesn't use them.
            throw failure('Evo CDC cannot provide all Web Serial input signals.', 'NotSupportedError');
        }

        async forget() {
            if (!this.device.forget) throw failure('USB permission revocation is unavailable.', 'NotSupportedError');
            await this.device.forget();
        }
    }

    function createPort(device) {
        if (device?.vendorId !== 0x0451 || device.productId !== 0xe018) {
            throw new TypeError('The WebUSB serial adapter only supports TI-83/84 Evo.');
        }
        if (!ports.has(device)) ports.set(device, new EvoSerialPort(device));
        return ports.get(device);
    }

    globalThis.EvoWebUsbSerial = Object.freeze({ shouldUse, createPort });
})();
