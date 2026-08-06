(function (scope) {
    'use strict';

    const NUMWORKS_VENDOR_ID = 0x0483;
    const NUMWORKS_PRODUCT_ID = 0xA291;
    const STORAGE_MAGIC = 0xBADD0BEE;

    function setUint32BE(bytes, offset, value) {
        new DataView(bytes.buffer).setUint32(offset, value >>> 0, false);
    }

    function setUint32LE(bytes, offset, value) {
        new DataView(bytes.buffer).setUint32(offset, value >>> 0, true);
    }

    function setAscii(bytes, offset, length, value) {
        const encoded = new TextEncoder().encode(value);
        bytes.set(encoded.subarray(0, length), offset);
    }

    function encodeRecord(fullName, data) {
        const name = new TextEncoder().encode(fullName);
        const record = new Uint8Array(2 + name.byteLength + 1 + data.byteLength);
        new DataView(record.buffer).setUint16(0, record.byteLength, true);
        record.set(name, 2);
        record.set(data, 3 + name.byteLength);
        return record;
    }

    function makeStorageImage(storageSize) {
        const source = new TextEncoder().encode('print("hello from mock")\n');
        const pythonData = new Uint8Array(source.byteLength + 2);
        pythonData[0] = 1;
        pythonData.set(source, 1);
        const records = [
            encodeRecord('hello.py', pythonData),
            encodeRecord('settings.bin', new Uint8Array([0x10, 0x20, 0x30, 0x40]))
        ];
        const image = new Uint8Array(storageSize + 8);
        setUint32BE(image, 0, STORAGE_MAGIC);
        let offset = 4;
        for (const record of records) {
            image.set(record, offset);
            offset += record.byteLength;
        }
        setUint32BE(image, storageSize + 4, STORAGE_MAGIC);
        return image;
    }

    class MockNumWorksDevice {
        constructor() {
            this.vendorId = NUMWORKS_VENDOR_ID;
            this.productId = NUMWORKS_PRODUCT_ID;
            this.productName = 'NumWorks Calculator';
            this.serialNumber = 'NW-BROWSER-MOCK-0120';
            this.deviceVersionMajor = 1;
            this.deviceVersionMinor = 2;
            this.deviceVersionSubminor = 0;
            this.opened = false;
            this.state = 2;
            this.currentAddress = 0;
            this.memory = new Map();
            const alternate = {
                alternateSetting: 0,
                interfaceName: '@NumWorks /0x08000000/256*004Kg/0x90000000/128*064Kg',
                interfaceClass: 0xFE,
                interfaceSubclass: 0x01,
                interfaceProtocol: 0x02
            };
            this.configurations = [{
                configurationValue: 1,
                interfaces: [{
                    interfaceNumber: 0,
                    alternates: [alternate],
                    alternate: null,
                    claimed: false
                }]
            }];
            this.configuration = null;
            this.rawConfiguration = new Uint8Array([
                9, 2, 27, 0, 1, 1, 0, 0x80, 50,
                9, 4, 0, 0, 0, 0xFE, 0x01, 0x02, 1,
                9, 0x21, 0x03, 0xE8, 0x03, 64, 0, 0x1A, 0x01
            ]);
            this.initializeMemory();
        }

        initializeMemory() {
            const slotAddress = 0x24000000;
            const kernelAddress = 0x08001008;
            const userlandAddress = 0x08002000;
            const storageAddress = 0x24001000;
            const storageSize = 1024;
            const slot = new Uint8Array(0x64);
            setUint32BE(slot, 0, 0xBADBEEEF);
            setUint32LE(slot, 4, kernelAddress);
            setUint32LE(slot, 8, userlandAddress);
            setUint32BE(slot, 12, 0xBADBEEEF);
            this.writeRange(slotAddress, slot);

            const userland = new Uint8Array(0x80);
            setUint32BE(userland, 0, 0xFEEDC0DE);
            setAscii(userland, 4, 8, '22.2.0');
            setUint32LE(userland, 12, storageAddress);
            setUint32LE(userland, 16, storageSize);
            setUint32BE(userland, 36, 0xFEEDC0DE);
            this.writeRange(userlandAddress, userland);

            const kernel = new Uint8Array(0x40);
            setUint32BE(kernel, 0, 0xFEEDC0DE);
            setAscii(kernel, 4, 8, '22.2.0');
            setAscii(kernel, 12, 8, 'abcdef1');
            setUint32BE(kernel, 20, 0xFEEDC0DE);
            this.writeRange(kernelAddress, kernel);
            this.writeRange(storageAddress, makeStorageImage(storageSize));
        }

        writeRange(address, data) {
            const bytes = new Uint8Array(data);
            for (let index = 0; index < bytes.byteLength; index++) {
                this.memory.set((address + index) >>> 0, bytes[index]);
            }
        }

        readRange(address, length) {
            const bytes = new Uint8Array(length);
            for (let index = 0; index < length; index++) {
                bytes[index] = this.memory.get((address + index) >>> 0) ?? 0xFF;
            }
            return bytes;
        }

        async open() { this.opened = true; }
        async close() { this.opened = false; }
        async selectConfiguration(value) {
            this.configuration = this.configurations.find(entry => entry.configurationValue === value);
        }
        async claimInterface(number) {
            this.configuration.interfaces.find(entry => entry.interfaceNumber === number).claimed = true;
        }
        async releaseInterface(number) {
            this.configuration.interfaces.find(entry => entry.interfaceNumber === number).claimed = false;
        }
        async selectAlternateInterface(number, alternateSetting) {
            const entry = this.configuration.interfaces.find(candidate => candidate.interfaceNumber === number);
            entry.alternate = entry.alternates.find(candidate => candidate.alternateSetting === alternateSetting);
        }

        okIn(bytes) {
            const copy = new Uint8Array(bytes);
            return { status: 'ok', data: new DataView(copy.buffer) };
        }

        async controlTransferIn(setup, length) {
            if (setup.requestType === 'standard' && setup.request === 0x06
                && (setup.value >> 8) === 0x02) {
                return this.okIn(this.rawConfiguration.slice(0, length));
            }
            if (setup.requestType !== 'class') {
                return { status: 'stall', data: new DataView(new ArrayBuffer(0)) };
            }
            if (setup.request === 0x05) return this.okIn(new Uint8Array([this.state]));
            if (setup.request === 0x03) {
                return this.okIn(new Uint8Array([0, 0, 0, 0, this.state, 0]));
            }
            if (setup.request === 0x02) {
                const blockOffset = Math.max(0, setup.value - 2) * 64;
                return this.okIn(this.readRange(this.currentAddress + blockOffset, length));
            }
            return { status: 'stall', data: new DataView(new ArrayBuffer(0)) };
        }

        async controlTransferOut(setup, data) {
            const bytes = data
                ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                : new Uint8Array();
            if (setup.request === 0x06 || setup.request === 0x04) {
                this.state = 2;
                return { status: 'ok', bytesWritten: 0 };
            }
            if (setup.request === 0x01 && setup.value === 0 && bytes[0] === 0x21) {
                this.currentAddress = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
                    .getUint32(1, true);
                this.state = 5;
                return { status: 'ok', bytesWritten: bytes.byteLength };
            }
            if (setup.request === 0x01 && setup.value === 2) {
                this.writeRange(this.currentAddress, bytes);
                this.state = 5;
                return { status: 'ok', bytesWritten: bytes.byteLength };
            }
            return { status: 'stall', bytesWritten: 0 };
        }
    }

    function installNumWorksWebUsbMock() {
        const device = new MockNumWorksDevice();
        const listeners = new Map();
        const usb = {
            async getDevices() { return [device]; },
            async requestDevice() { return device; },
            addEventListener(type, listener) { listeners.set(type, listener); },
            removeEventListener(type) { listeners.delete(type); }
        };
        Object.defineProperty(scope.navigator, 'usb', {
            configurable: true,
            value: usb
        });
        return { device, usb, listeners };
    }

    scope.WebTILPNumWorksTest = { MockNumWorksDevice, installNumWorksWebUsbMock };
    if (typeof module === 'object' && module.exports) {
        module.exports = scope.WebTILPNumWorksTest;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
