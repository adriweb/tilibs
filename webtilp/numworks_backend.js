/*
 * WebTILP adapter for the vendored MIT-licensed Upsilon.js and WebDFU.
 * Generic WebUSB/DFU handling lives in third_party/; this file retains only
 * WebTILP's bounded storage, recovery, CRUD, and frontend-facing policy.
 */
'use strict';

const {
    MAX_STORAGE_SIZE,
    STORAGE_HEADER_SIZE,
    STORAGE_MAGIC,
    STORAGE_TERMINATOR_SIZE,
    cloneRecord,
    copyBytes,
    dataViewFor,
    encodeStoragePrefix,
    makePythonRecord,
    normalizeScriptName,
    parseStorageImage,
    textEncoder
} = require('./numworks_storage.js');
const {
    firmwareNeedsStorageAlternate,
    hex,
    parseKernelHeader,
    parseLegacyPlatformInfo,
    parseSlotInfo,
    parseUserlandHeader
} = require('./numworks_platform.js');
const {
    NUMWORKS_PRODUCT_ID,
    NUMWORKS_VENDOR_ID,
    UpsilonTransport,
    findDfuInterfaces,
    isNumWorksDevice,
    parseMemoryDescriptor
} = require('./numworks_transport.js');

class NumWorksBackend {
    constructor(options = {}) {
        this.transport = null;
        this.device = null;
        this.model = 'NumWorks';
        this.platformInfo = null;
        this.storage = null;
        this.rawStorageImage = null;
        this.storageError = null;
        this.onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    }

    static async requestDevice() {
        if (typeof navigator === 'undefined' || !navigator.usb) {
            throw new Error('WebUSB is not supported in this browser.');
        }
        return navigator.usb.requestDevice({
            filters: [{ vendorId: NUMWORKS_VENDOR_ID, productId: NUMWORKS_PRODUCT_ID }]
        });
    }

    static async getAuthorizedDevices() {
        if (typeof navigator === 'undefined' || !navigator.usb) return [];
        return (await navigator.usb.getDevices()).filter(isNumWorksDevice);
    }

    async connect(device) {
        if (!isNumWorksDevice(device)) {
            throw new Error('No supported NumWorks calculator was selected.');
        }
        this.device = device;
        this.transport = new UpsilonTransport(device, { onProgress: this.onProgress });
        try {
            await this.transport.open();
            this.model = this.transport.detectModel();
            await this.refresh({ allowInvalidStorage: true });
            return this.getInfo();
        } catch (error) {
            try {
                await this.close();
            } catch {
                // Preserve the setup error.
            }
            throw error;
        }
    }

    async close() {
        try {
            await this.transport?.close();
        } finally {
            this.transport = null;
            this.device = null;
            this.platformInfo = null;
            this.storage = null;
            this.rawStorageImage = null;
            this.storageError = null;
        }
    }

    async readPlatformInfo() {
        const slotAddress = this.model.endsWith('N0120') ? 0x24000000 : 0x20000000;
        const slot = parseSlotInfo(await this.transport.readMemory(slotAddress, 0x64));
        if (slot.valid) {
            const userland = parseUserlandHeader(
                await this.transport.readMemory(slot.userlandHeader, 0x80)
            );
            const kernel = parseKernelHeader(
                await this.transport.readMemory(slot.kernelHeader, 0x40)
            );
            if (!userland.valid) {
                throw new Error('NumWorks userland header is invalid.');
            }
            return {
                valid: true,
                mode: 'bootloader',
                version: userland.version || kernel.version || '',
                commit: kernel.commit || '',
                storageAddress: userland.storageAddress,
                storageSize: userland.storageSize,
                slot,
                headerIntegrity: Boolean(
                    slot.footerValid && userland.footerValid && kernel.footerValid
                )
            };
        }

        const legacy = parseLegacyPlatformInfo(
            await this.transport.readMemory(0x080001C4, 0x128)
        );
        if (!legacy.valid) {
            throw new Error('NumWorks platform information is invalid.');
        }
        return {
            ...legacy,
            mode: 'legacy',
            slot: { valid: false },
            headerIntegrity: true
        };
    }

    validateStorageLocation(info) {
        if (!Number.isInteger(info.storageSize)
            || info.storageSize <= 0
            || info.storageSize > MAX_STORAGE_SIZE) {
            throw new Error(`Refusing invalid NumWorks storage size ${info.storageSize}.`);
        }
        if (!this.transport.isRamWriteRange(info.storageAddress, info.storageSize + 8)) {
            throw new Error(
                `Refusing NumWorks storage outside known RAM (${hex(info.storageAddress)} + ${info.storageSize + 8}).`
            );
        }
    }

    async withStorageInterface(operation) {
        if (!firmwareNeedsStorageAlternate(this.platformInfo?.version)) {
            return operation();
        }
        return this.transport.withAlternateSetting(1, operation);
    }

    async readRawStorageImage() {
        if (!this.transport) {
            throw new Error('NumWorks calculator is not connected.');
        }
        if (!this.platformInfo) this.platformInfo = await this.readPlatformInfo();
        this.validateStorageLocation(this.platformInfo);
        const raw = await this.withStorageInterface(() => this.transport.readMemory(
            this.platformInfo.storageAddress,
            this.platformInfo.storageSize + 8
        ));
        this.rawStorageImage = copyBytes(raw);
        return copyBytes(this.rawStorageImage);
    }

    async refresh(options = {}) {
        const allowInvalidStorage = Boolean(options.allowInvalidStorage);
        if (!this.transport) {
            throw new Error('NumWorks calculator is not connected.');
        }
        this.platformInfo = await this.readPlatformInfo();
        this.validateStorageLocation(this.platformInfo);
        const raw = await this.readRawStorageImage();
        try {
            this.storage = parseStorageImage(raw, this.platformInfo.storageSize);
            this.storageError = null;
        } catch (error) {
            this.storage = null;
            this.storageError = error;
            if (!allowInvalidStorage) throw error;
        }
        return this.storage;
    }

    getInfo() {
        if (!this.platformInfo) {
            throw new Error('NumWorks information has not been loaded.');
        }
        const storage = this.storage;
        const footerValid = this.rawStorageImage
            && this.rawStorageImage.byteLength >= this.platformInfo.storageSize + 8
            ? dataViewFor(this.rawStorageImage).getUint32(
                STORAGE_HEADER_SIZE + this.platformInfo.storageSize,
                false
            ) === STORAGE_MAGIC
            : false;
        return {
            model: this.model,
            productName: this.device?.productName || 'NumWorks Calculator',
            serialNumber: this.device?.serialNumber || '',
            firmwareVersion: this.platformInfo.version || '',
            commit: this.platformInfo.commit || '',
            mode: this.platformInfo.mode,
            slot: this.platformInfo.slot?.name || '',
            transferSize: this.transport.transferSize,
            storageSize: this.platformInfo.storageSize,
            storageUsed: storage?.usedBytes ?? null,
            storageFree: storage?.freeBytes ?? null,
            storageValid: Boolean(storage),
            storageError: this.storageError?.message || '',
            storageFooterValid: storage?.footerValid ?? footerValid,
            headerIntegrity: this.platformInfo.headerIntegrity,
            preservedRecordCount: storage
                ? storage.records.filter(record => record.type.toLowerCase() !== 'py').length
                : null
        };
    }

    listScripts() {
        if (!this.storage) return [];
        return this.storage.records
            .filter(record => record.type.toLowerCase() === 'py')
            .map((record, index) => ({
                index,
                name: record.baseName,
                fullName: record.fullName,
                size: textEncoder.encode(record.code || '').byteLength,
                autoImport: Boolean(record.autoImport),
                valid: Boolean(record.valid)
            }));
    }

    getScript(baseName) {
        const target = String(baseName || '').replace(/\.py$/i, '').toLowerCase();
        const record = this.storage?.records.find(candidate =>
            candidate.type.toLowerCase() === 'py'
            && candidate.baseName.toLowerCase() === target
        );
        if (!record) throw new Error(`NumWorks script ${baseName}.py was not found.`);
        if (!record.valid) {
            throw new Error(`NumWorks script ${record.fullName} is malformed.`);
        }
        return { name: record.fullName, code: record.code, autoImport: record.autoImport };
    }

    async commitRecords(records) {
        if (!this.platformInfo?.headerIntegrity) {
            throw new Error('Refusing to modify NumWorks storage with invalid platform headers.');
        }
        if (!this.storage?.footerValid) {
            throw new Error('Refusing to modify NumWorks storage with an invalid footer.');
        }
        if (this.storage.records.some(record => !record.valid)) {
            throw new Error('Refusing to modify NumWorks storage containing malformed records.');
        }

        const prefix = encodeStoragePrefix(records, this.platformInfo.storageSize);
        const storageAddress = this.platformInfo.storageAddress;
        const previousUsedBytes = this.storage.usedBytes;
        const invalidMagic = new Uint8Array(STORAGE_HEADER_SIZE);
        const terminator = prefix.subarray(prefix.byteLength - STORAGE_TERMINATOR_SIZE);
        try {
            await this.withStorageInterface(async () => {
                // Keep the image explicitly invalid until its body and terminator are complete.
                await this.transport.writeRam(storageAddress, invalidMagic);
                await this.transport.writeRam(
                    storageAddress + prefix.byteLength - STORAGE_TERMINATOR_SIZE,
                    terminator
                );
                await this.transport.writeRam(
                    storageAddress + STORAGE_HEADER_SIZE,
                    prefix.subarray(STORAGE_HEADER_SIZE)
                );
                const staleTailLength = Math.max(0, previousUsedBytes - prefix.byteLength);
                if (staleTailLength > 0) {
                    await this.transport.writeRam(
                        storageAddress + prefix.byteLength,
                        new Uint8Array(staleTailLength)
                    );
                }
                await this.transport.writeRam(
                    storageAddress,
                    prefix.subarray(0, STORAGE_HEADER_SIZE)
                );
            });
        } catch (error) {
            this.storage = null;
            this.storageError = error;
            throw error;
        }
        await this.refresh();
    }

    async upsertScripts(scripts) {
        if (!this.storage) await this.refresh();
        const records = this.storage.records.map(cloneRecord);
        const normalizedNames = new Set();
        for (const script of scripts) {
            let next = makePythonRecord(script.name, script.code, script.autoImport !== false);
            const key = next.fullName.toLowerCase();
            if (normalizedNames.has(key)) {
                throw new Error(`Multiple files normalize to ${next.fullName}.`);
            }
            normalizedNames.add(key);
            const index = records.findIndex(record => record.fullName.toLowerCase() === key);
            if (index >= 0) {
                if (script.autoImport === undefined) {
                    next = makePythonRecord(
                        script.name,
                        script.code,
                        Boolean(records[index].autoImport)
                    );
                }
                records[index] = next;
            } else {
                records.push(next);
            }
        }
        await this.commitRecords(records);
        return this.listScripts();
    }

    async deleteScripts(names) {
        if (!this.storage) await this.refresh();
        const targets = new Set(Array.from(names || [], name =>
            `${String(name).replace(/\.py$/i, '').toLowerCase()}.py`
        ));
        const records = this.storage.records.filter(record =>
            !targets.has(record.fullName.toLowerCase())
        );
        if (records.length === this.storage.records.length) {
            throw new Error('None of the selected NumWorks scripts were found.');
        }
        await this.commitRecords(records);
        return this.listScripts();
    }

    async renameScript(oldName, newName) {
        if (!this.storage) await this.refresh();
        const oldKey = `${String(oldName).replace(/\.py$/i, '').toLowerCase()}.py`;
        const newBase = normalizeScriptName(newName);
        const newKey = `${newBase}.py`;
        const records = this.storage.records.map(cloneRecord);
        const index = records.findIndex(record => record.fullName.toLowerCase() === oldKey);
        if (index < 0) throw new Error(`NumWorks script ${oldName}.py was not found.`);
        if (records.some((record, candidate) => candidate !== index
            && record.fullName.toLowerCase() === newKey)) {
            throw new Error(`NumWorks script ${newKey} already exists.`);
        }
        records[index].fullName = newKey;
        records[index].baseName = newBase;
        records[index].nameBytes = textEncoder.encode(newKey);
        await this.commitRecords(records);
        return newBase;
    }

    getRawStorageImage() {
        if (!this.rawStorageImage) {
            throw new Error('NumWorks storage has not been loaded.');
        }
        return copyBytes(this.rawStorageImage);
    }
}

const api = {
    NUMWORKS_PRODUCT_ID,
    NUMWORKS_VENDOR_ID,
    DfuSeTransport: UpsilonTransport,
    NumWorksBackend,
    encodeStoragePrefix,
    findDfuInterfaces,
    firmwareNeedsStorageAlternate,
    isNumWorksDevice,
    makePythonRecord,
    normalizeScriptName,
    parseKernelHeader,
    parseLegacyPlatformInfo,
    parseMemoryDescriptor,
    parseSlotInfo,
    parseStorageImage,
    parseUserlandHeader
};

if (typeof module === 'object' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.WebTILPNumWorks = api;
