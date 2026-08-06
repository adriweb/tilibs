'use strict';

const UpsilonNumworks = require('./third_party/upsilon-js/index.js');
const WebDFU = require('./third_party/webdfu/index.js');
const { copyBytes } = require('./numworks_storage.js');

const NUMWORKS_VENDOR_ID = 0x0483;
const NUMWORKS_PRODUCT_ID = 0xA291;
const DEFAULT_TRANSFER_SIZE = 2048;

function isNumWorksDevice(device) {
    return Boolean(device
        && device.vendorId === NUMWORKS_VENDOR_ID
        && device.productId === NUMWORKS_PRODUCT_ID);
}

function findDfuInterfaces(device) {
    return WebDFU.DFU.findDeviceDfuInterfaces(device);
}

function parseMemoryDescriptor(descriptor) {
    return WebDFU.DFUse.parseMemoryDescriptor(String(descriptor || ''));
}

class UpsilonTransport {
    constructor(device, options = {}) {
        this.device = device;
        this.calculator = new UpsilonNumworks();
        this.vendorDevice = null;
        this.transferSize = DEFAULT_TRANSFER_SIZE;
        this.memorySegments = [];
        this.onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
        this.progressDirection = null;
    }

    async open() {
        if (!isNumWorksDevice(this.device)) {
            throw new Error('The selected USB device is not a supported NumWorks calculator.');
        }
        const interfaces = findDfuInterfaces(this.device);
        for (const candidate of interfaces) {
            if (candidate.name === undefined) candidate.name = null;
        }
        const settings = interfaces.find(candidate =>
            candidate.alternate.interfaceProtocol === 0x02
            && candidate.alternate.alternateSetting === 0
        ) || interfaces.find(candidate => candidate.alternate.interfaceProtocol === 0x02)
            || interfaces[0];
        if (!settings) {
            throw new Error('The NumWorks calculator does not expose a DFU interface.');
        }

        await this.calculator.__fixInterfaceNames(this.device, interfaces);
        const connected = await this.calculator.__connect(
            new WebDFU.DFU.Device(this.device, settings)
        );
        this.calculator.device = connected;
        this.vendorDevice = connected;
        this.transferSize = Number.isInteger(this.calculator.transferSize)
            ? this.calculator.transferSize
            : DEFAULT_TRANSFER_SIZE;
        this.memorySegments = connected.memoryInfo?.segments || [];

        connected.logDebug = () => {};
        connected.logInfo = () => {};
        connected.logWarning = message => console.warn('[NumWorks]', message);
        connected.logError = message => console.error('[NumWorks]', message);
        connected.logProgress = (done, total) => {
            if (Number.isFinite(total)) {
                this.onProgress(done, total, this.progressDirection);
            }
        };
        await this.resetToIdle();
        return this;
    }

    async close() {
        const rawDevice = this.device;
        const interfaceNumber = this.vendorDevice?.intfNumber;
        try {
            const activeInterface = rawDevice?.configuration?.interfaces?.find(entry =>
                entry.interfaceNumber === interfaceNumber
            );
            if (activeInterface?.claimed && typeof rawDevice.releaseInterface === 'function') {
                await rawDevice.releaseInterface(interfaceNumber);
            }
        } catch (error) {
            console.warn('[NumWorks] Failed to release the DFU interface.', error);
        }
        try {
            if (rawDevice?.opened) await rawDevice.close();
        } finally {
            this.calculator.device = null;
            this.vendorDevice = null;
            this.memorySegments = [];
        }
    }

    async resetToIdle() {
        if (!this.vendorDevice) return;
        let state = await this.vendorDevice.getState();
        if (state === WebDFU.DFU.dfuERROR) {
            await this.vendorDevice.clearStatus();
            state = await this.vendorDevice.getState();
        }
        if (state !== WebDFU.DFU.dfuIDLE) {
            await this.vendorDevice.abortToIdle();
        }
    }

    activeInterface() {
        return this.device?.configuration?.interfaces?.find(entry =>
            entry.interfaceNumber === this.vendorDevice?.intfNumber
        ) || null;
    }

    hasAlternateSetting(alternateSetting) {
        return Boolean(this.activeInterface()?.alternates?.some(alternate =>
            alternate.alternateSetting === alternateSetting
        ));
    }

    async withAlternateSetting(alternateSetting, operation) {
        const activeInterface = this.activeInterface();
        if (!activeInterface || !this.hasAlternateSetting(alternateSetting)) {
            throw new Error(`NumWorks DFU alternate interface ${alternateSetting} is unavailable.`);
        }
        const previousSetting = activeInterface.alternate?.alternateSetting
            ?? this.vendorDevice.settings.alternate.alternateSetting;
        if (previousSetting === alternateSetting) return operation();

        await this.resetToIdle();
        await this.device.selectAlternateInterface(
            this.vendorDevice.intfNumber,
            alternateSetting
        );
        let result;
        let operationError = null;
        try {
            result = await operation();
        } catch (error) {
            operationError = error;
        }

        let restoreError = null;
        try {
            await this.resetToIdle();
            await this.device.selectAlternateInterface(
                this.vendorDevice.intfNumber,
                previousSetting
            );
        } catch (error) {
            restoreError = error;
        }
        if (operationError) {
            if (restoreError) {
                console.warn('[NumWorks] Failed to restore the DFU alternate interface.', restoreError);
            }
            throw operationError;
        }
        if (restoreError) throw restoreError;
        return result;
    }

    isRamWriteRange(address, length) {
        if (!Number.isInteger(address) || !Number.isInteger(length) || length < 0) return false;
        const end = address + length;
        if (!Number.isSafeInteger(end) || end > 0x100000000) return false;
        return [
            [0x20000000, 0x20040000],
            [0x24000000, 0x24040000]
        ].some(([start, limit]) => address >= start && end <= limit);
    }

    memoryMapAllowsRead(address, length) {
        if (!Number.isInteger(address) || !Number.isInteger(length) || length <= 0) return false;
        const end = address + length;
        if (!Number.isSafeInteger(end) || end > 0x100000000) return false;
        let cursor = address;
        for (const segment of [...this.memorySegments].sort((a, b) => a.start - b.start)) {
            if (segment.end <= cursor || segment.start > cursor) continue;
            if (!segment.readable) return false;
            cursor = Math.min(end, segment.end);
            if (cursor === end) return true;
        }
        return false;
    }

    isKnownReadRange(address, length) {
        if (this.memoryMapAllowsRead(address, length)) return true;
        if (!Number.isInteger(address) || !Number.isInteger(length) || length <= 0) return false;
        const end = address + length;
        if (!Number.isSafeInteger(end) || end > 0x100000000) return false;
        // Some NumWorks DFU alternates advertise only the currently selected
        // memory while their slot metadata legitimately points into another
        // standard NumWorks flash region. Keep the same bounded fallback the
        // pre-vendoring backend used for platform-header reads.
        return [
            [0x08000000, 0x08100000],
            [0x90000000, 0x91000000],
            [0x20000000, 0x20040000],
            [0x24000000, 0x24040000]
        ].some(([start, limit]) => address >= start && end <= limit);
    }

    async readMemory(address, length) {
        if (!this.vendorDevice) throw new Error('NumWorks calculator is not connected.');
        if (!this.isKnownReadRange(address, length)) {
            throw new Error(`Refusing unsafe NumWorks read at 0x${address.toString(16)} + ${length}.`);
        }
        const vendorDevice = this.vendorDevice;
        this.progressDirection = 'read';
        vendorDevice.startAddress = address >>> 0;
        const suppressMissingMapWarning = !this.memoryMapAllowsRead(address, length);
        const originalLogWarning = vendorDevice.logWarning;
        if (suppressMissingMapWarning) vendorDevice.logWarning = () => {};
        try {
            const blob = await vendorDevice.do_upload(this.transferSize, length);
            const bytes = new Uint8Array(await blob.arrayBuffer());
            if (bytes.byteLength !== length) {
                throw new Error(`Short NumWorks memory read (${bytes.byteLength} < ${length}).`);
            }
            return bytes;
        } finally {
            vendorDevice.logWarning = originalLogWarning;
            this.progressDirection = null;
        }
    }

    async writeRam(address, data) {
        if (!this.vendorDevice) throw new Error('NumWorks calculator is not connected.');
        const bytes = copyBytes(data);
        if (!this.isRamWriteRange(address, bytes.byteLength)) {
            throw new Error('Refusing a NumWorks write outside known RAM.');
        }
        this.progressDirection = 'write';
        this.vendorDevice.startAddress = address >>> 0;
        try {
            await this.resetToIdle();
            const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            await this.vendorDevice.do_download(this.transferSize, buffer, false);
        } finally {
            this.progressDirection = null;
        }
    }

    detectModel() {
        const model = this.calculator.getModel();
        const known = new Map([
            ['0100', 'NumWorks N0100'],
            ['0110', 'NumWorks N0110'],
            ['0115', 'NumWorks N0115'],
            ['0120', 'NumWorks N0120']
        ]);
        return known.get(model) || 'NumWorks';
    }
}

module.exports = {
    NUMWORKS_PRODUCT_ID,
    NUMWORKS_VENDOR_ID,
    UpsilonTransport,
    findDfuInterfaces,
    isNumWorksDevice,
    parseMemoryDescriptor
};
