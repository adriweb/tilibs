'use strict';

const assert = require('node:assert/strict');
const {
    NUMWORKS_VENDOR_ID,
    NUMWORKS_PRODUCT_ID,
    NumWorksBackend,
    encodeStoragePrefix,
    firmwareNeedsStorageAlternate,
    makePythonRecord,
    parseMemoryDescriptor,
    parseSlotInfo,
    parseStorageImage,
    normalizeScriptName
} = require('../numworks_backend.js');

function setUint32BE(bytes, offset, value) {
    new DataView(bytes.buffer).setUint32(offset, value >>> 0, false);
}

function setUint32LE(bytes, offset, value) {
    new DataView(bytes.buffer).setUint32(offset, value >>> 0, true);
}

function setAscii(bytes, offset, length, text) {
    const encoded = new TextEncoder().encode(text);
    bytes.set(encoded.subarray(0, length), offset);
}

function makeStorageImage(storageSize) {
    const unknown = {
        fullName: 'settings.bin',
        nameBytes: new TextEncoder().encode('settings.bin'),
        data: new Uint8Array([0x10, 0x20, 0x30, 0x40])
    };
    const prefix = encodeStoragePrefix([
        makePythonRecord('hello', 'print("hello")\n', true),
        unknown
    ], storageSize);
    const image = new Uint8Array(storageSize + 8);
    image.set(prefix);
    setUint32BE(image, storageSize + 4, 0xBADD0BEE);
    return image;
}

class MockNumWorksDevice {
    constructor(options = {}) {
        this.vendorId = NUMWORKS_VENDOR_ID;
        this.productId = NUMWORKS_PRODUCT_ID;
        this.productName = 'NumWorks Calculator';
        this.serialNumber = 'NW-MOCK-0120';
        this.deviceVersionMajor = 1;
        this.deviceVersionMinor = 2;
        this.deviceVersionSubminor = 0;
        this.opened = false;
        this.state = 2;
        this.status = 0;
        this.currentAddress = 0;
        this.memory = new Map();
        this.firmwareVersion = options.firmwareVersion || '22.2.0';
        this.requireStorageAlternate = Boolean(options.requireStorageAlternate);
        this.selectedAlternates = [];

        const memoryDescriptor = options.omitExternalMemoryDescriptor
            ? '@NumWorks /0x08000000/256*004Kg'
            : '@NumWorks /0x08000000/256*004Kg/0x90000000/128*064Kg';
        const alternate0 = {
            alternateSetting: 0,
            interfaceName: memoryDescriptor,
            interfaceClass: 0xFE,
            interfaceSubclass: 0x01,
            interfaceProtocol: 0x02
        };
        const alternate1 = {
            ...alternate0,
            alternateSetting: 1,
            interfaceName: '@SRAM /0x20000000/256*001Kg'
        };
        this.configurations = [{
            configurationValue: 1,
            interfaces: [{
                interfaceNumber: 0,
                alternates: [alternate0, alternate1],
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
        this.initializeMemory(options);
    }

    initializeMemory(options = {}) {
        const slotAddress = 0x24000000;
        const kernelAddress = 0x08001008;
        const userlandAddress = options.externalUserlandHeader ? 0x90010000 : 0x08002000;
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
        setAscii(userland, 4, 8, this.firmwareVersion);
        setUint32LE(userland, 12, storageAddress);
        setUint32LE(userland, 16, storageSize);
        setUint32BE(userland, 36, 0xFEEDC0DE);
        this.writeRange(userlandAddress, userland);

        const kernel = new Uint8Array(0x40);
        setUint32BE(kernel, 0, 0xFEEDC0DE);
        setAscii(kernel, 4, 8, this.firmwareVersion);
        setAscii(kernel, 12, 8, 'abcdef1');
        setUint32BE(kernel, 20, 0xFEEDC0DE);
        this.writeRange(kernelAddress, kernel);
        this.writeRange(storageAddress, makeStorageImage(storageSize));
    }

    writeRange(address, data) {
        const bytes = new Uint8Array(data);
        for (let i = 0; i < bytes.byteLength; i++) {
            this.memory.set((address + i) >>> 0, bytes[i]);
        }
    }

    readRange(address, length) {
        const bytes = new Uint8Array(length);
        for (let i = 0; i < length; i++) {
            bytes[i] = this.memory.get((address + i) >>> 0) ?? 0xFF;
        }
        return bytes;
    }

    async open() {
        this.opened = true;
    }

    async close() {
        this.opened = false;
    }

    async selectConfiguration(value) {
        this.configuration = this.configurations.find(candidate => candidate.configurationValue === value);
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
        this.selectedAlternates.push(alternateSetting);
    }

    async controlTransferIn(setup, length) {
        if (setup.requestType === 'standard' && setup.request === 0x06) {
            const type = setup.value >> 8;
            if (type === 0x02) {
                return this.okIn(this.rawConfiguration.slice(0, length));
            }
        }
        if (setup.requestType !== 'class') {
            return { status: 'stall', data: new DataView(new ArrayBuffer(0)) };
        }
        if (setup.request === 0x05) {
            return this.okIn(new Uint8Array([this.state]));
        }
        if (setup.request === 0x03) {
            return this.okIn(new Uint8Array([this.status, 0, 0, 0, this.state, 0]));
        }
        if (setup.request === 0x02) {
            const blockOffset = Math.max(0, setup.value - 2) * 64;
            return this.okIn(this.readRange(this.currentAddress + blockOffset, length));
        }
        return { status: 'stall', data: new DataView(new ArrayBuffer(0)) };
    }

    async controlTransferOut(setup, data) {
        const bytes = data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : data
                ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                : new Uint8Array();
        if (setup.request === 0x06 || setup.request === 0x04) {
            this.state = 2;
            this.status = 0;
            return { status: 'ok', bytesWritten: 0 };
        }
        if (setup.request === 0x01 && setup.value === 0 && bytes[0] === 0x21) {
            this.currentAddress = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
                .getUint32(1, true);
            this.state = 5;
            return { status: 'ok', bytesWritten: bytes.byteLength };
        }
        if (setup.request === 0x01 && setup.value === 2) {
            const activeAlternate = this.configuration.interfaces[0].alternate?.alternateSetting;
            if (this.requireStorageAlternate && activeAlternate !== 1) {
                this.status = 1;
                this.state = 10;
                return { status: 'ok', bytesWritten: bytes.byteLength };
            }
            this.writeRange(this.currentAddress, bytes);
            this.state = 5;
            return { status: 'ok', bytesWritten: bytes.byteLength };
        }
        return { status: 'stall', bytesWritten: 0 };
    }

    okIn(bytes) {
        const copy = new Uint8Array(bytes);
        return {
            status: 'ok',
            data: new DataView(copy.buffer, copy.byteOffset, copy.byteLength)
        };
    }
}

async function main() {
    const descriptor = parseMemoryDescriptor(
        '@Flash /0x08000000/256*004Kg/0x90000000/128*064Kg'
    );
    assert.equal(descriptor.segments.length, 2);
    assert.equal(descriptor.segments[0].end, 0x08100000);
    assert.equal(descriptor.segments[1].end, 0x90800000);
    assert.equal(normalizeScriptName('Résumé 2026.PY'), 'resume_2026');
    assert.equal(normalizeScriptName('7 demo.py'), '_7_demo');
    assert.equal(firmwareNeedsStorageAlternate('23.9.9'), false);
    assert.equal(firmwareNeedsStorageAlternate('24.0.0'), true);
    assert.equal(firmwareNeedsStorageAlternate('26.3.0'), true);

    const legacyCorruptSlot = new Uint8Array(16);
    setUint32BE(legacyCorruptSlot, 0, 0x12DBEEEF);
    setUint32LE(legacyCorruptSlot, 4, 0x90000008);
    setUint32LE(legacyCorruptSlot, 8, 0x90010000);
    setUint32BE(legacyCorruptSlot, 12, 0xBADBEEEF);
    assert.equal(parseSlotInfo(legacyCorruptSlot).valid, true,
        'legacy slot headers accept any corrupted high byte when the lower magic matches');

    const initialImage = makeStorageImage(1024);
    const parsed = parseStorageImage(initialImage, 1024);
    assert.equal(parsed.records.length, 2);
    assert.equal(parsed.records[0].code, 'print("hello")\n');
    assert.deepEqual(Array.from(parsed.records[1].data), [0x10, 0x20, 0x30, 0x40]);
    assert.equal(parsed.footerValid, true);

    const fullStorageSize = 32;
    const fullRecord = {
        fullName: 'x',
        nameBytes: new TextEncoder().encode('x'),
        data: new Uint8Array(fullStorageSize - 6)
    };
    const fullPrefix = encodeStoragePrefix([fullRecord], fullStorageSize);
    assert.equal(fullPrefix.byteLength, fullStorageSize + 4);
    const fullImage = new Uint8Array(fullStorageSize + 8);
    fullImage.set(fullPrefix);
    setUint32BE(fullImage, fullStorageSize + 4, 0xBADD0BEE);
    const fullParsed = parseStorageImage(fullImage, fullStorageSize);
    assert.equal(fullParsed.freeBytes, 0);
    assert.equal(encodeStoragePrefix(fullParsed.records, fullStorageSize).byteLength,
        fullPrefix.byteLength);

    const mockDevice = new MockNumWorksDevice();
    const progressEvents = [];
    const backend = new NumWorksBackend({
        onProgress(done, total, direction) {
            progressEvents.push({ done, total, direction });
        }
    });
    const info = await backend.connect(mockDevice);
    assert.equal(info.model, 'NumWorks N0120');
    assert.equal(info.firmwareVersion, '22.2.0');
    assert.equal(info.commit, 'abcdef1');
    assert.equal(info.storageFooterValid, true);
    assert.equal(info.preservedRecordCount, 1);
    assert.equal(backend.listScripts().length, 1);
    assert.equal(backend.getScript('hello').code, 'print("hello")\n');

    await backend.upsertScripts([
        { name: 'hello.py', code: 'print("updated")\n', autoImport: false },
        { name: 'World Demo.py', code: 'print("world")\n', autoImport: true }
    ]);
    assert.equal(backend.listScripts().length, 2);
    assert.equal(backend.getScript('hello').autoImport, false);
    assert.equal(backend.getScript('world_demo').code, 'print("world")\n');
    await backend.upsertScripts([
        { name: 'hello.py', code: 'print("preserved")\n' }
    ]);
    assert.equal(backend.getScript('hello').autoImport, false,
        'an overwrite without an explicit flag preserves auto-import');
    assert.deepEqual(
        Array.from(backend.storage.records.find(record => record.fullName === 'settings.bin').data),
        [0x10, 0x20, 0x30, 0x40]
    );

    const renamed = await backend.renameScript('world_demo', 'Renamed script.py');
    assert.equal(renamed, 'renamed_script');
    assert.equal(backend.getScript('renamed_script').code, 'print("world")\n');
    await backend.deleteScripts(['hello']);
    assert.deepEqual(backend.listScripts().map(script => script.name), ['renamed_script']);
    assert.equal(backend.getInfo().storageFooterValid, true);
    assert(progressEvents.some(event => event.direction === 'read'));
    assert(progressEvents.some(event => event.direction === 'write'));

    const writeCalls = [];
    const originalWriteRam = backend.transport.writeRam.bind(backend.transport);
    backend.transport.writeRam = async (address, data) => {
        writeCalls.push({ address, data: new Uint8Array(data) });
        return originalWriteRam(address, data);
    };
    await backend.upsertScripts([{ name: 'renamed_script', code: 'pass\n' }]);
    assert.deepEqual(Array.from(writeCalls[0].data), [0, 0, 0, 0],
        'storage magic is invalidated before records are rewritten');
    assert.deepEqual(Array.from(writeCalls[1].data), [0, 0],
        'the new terminator is positioned before the record body is rewritten');
    assert.deepEqual(Array.from(writeCalls.at(-1).data), [0xBA, 0xDD, 0x0B, 0xEE],
        'valid storage magic is restored last');

    await backend.close();
    assert.equal(mockDevice.opened, false);

    const modernDevice = new MockNumWorksDevice({
        firmwareVersion: '26.3.0',
        requireStorageAlternate: true
    });
    const modernBackend = new NumWorksBackend();
    const modernInfo = await modernBackend.connect(modernDevice);
    assert.equal(modernInfo.firmwareVersion, '26.3.0');
    assert.deepEqual(modernDevice.selectedAlternates.slice(-2), [1, 0],
        'Epsilon 24+ storage reads use alternate 1 and restore alternate 0');
    modernDevice.selectedAlternates.length = 0;
    const unicodeCode = 'print("Café — 你好")\n';
    await modernBackend.upsertScripts([{
        name: 'unicode.py',
        code: unicodeCode,
        autoImport: true
    }]);
    assert.equal(modernBackend.getScript('unicode').code, unicodeCode,
        'UTF-8 script contents round-trip through storage');
    assert.deepEqual(modernDevice.selectedAlternates, [1, 0, 1, 0],
        'Epsilon 24+ storage writes and verification reads each use alternate 1');
    assert.equal(modernDevice.configuration.interfaces[0].alternate.alternateSetting, 0);
    modernDevice.selectedAlternates.length = 0;
    await assert.rejects(
        modernBackend.withStorageInterface(() => {
            throw new Error('storage operation failed');
        }),
        /storage operation failed/
    );
    assert.deepEqual(modernDevice.selectedAlternates, [1, 0],
        'the original alternate is restored when a storage operation fails');
    await modernBackend.close();

    const partialMapDevice = new MockNumWorksDevice({
        omitExternalMemoryDescriptor: true,
        externalUserlandHeader: true
    });
    const partialMapBackend = new NumWorksBackend();
    const partialMapInfo = await partialMapBackend.connect(partialMapDevice);
    assert.equal(partialMapInfo.firmwareVersion, '22.2.0',
        'platform headers remain readable from bounded external flash when the active DFU map omits it');
    assert.equal(partialMapBackend.transport.isKnownReadRange(0x90010000, 0x80), true);
    assert.equal(partialMapBackend.transport.isKnownReadRange(0x91000000, 0x80), false,
        'the fallback does not permit reads beyond the known NumWorks external flash window');
    await partialMapBackend.close();

    const invalidFooterDevice = new MockNumWorksDevice();
    invalidFooterDevice.writeRange(0x24001000 + 1024 + 4, new Uint8Array(4));
    const invalidFooterBackend = new NumWorksBackend();
    const invalidFooterInfo = await invalidFooterBackend.connect(invalidFooterDevice);
    assert.equal(invalidFooterInfo.storageFooterValid, false);
    await assert.rejects(
        invalidFooterBackend.upsertScripts([{ name: 'blocked', code: 'pass\n' }]),
        /invalid footer/
    );
    await invalidFooterBackend.close();

    const invalidHeaderDevice = new MockNumWorksDevice();
    invalidHeaderDevice.writeRange(0x24000000 + 12, new Uint8Array(4));
    const invalidHeaderBackend = new NumWorksBackend();
    const invalidHeaderInfo = await invalidHeaderBackend.connect(invalidHeaderDevice);
    assert.equal(invalidHeaderInfo.headerIntegrity, false);
    await assert.rejects(
        invalidHeaderBackend.deleteScripts(['hello']),
        /invalid platform headers/
    );
    await invalidHeaderBackend.close();

    const malformedRecordDevice = new MockNumWorksDevice();
    const malformedBackend = new NumWorksBackend();
    await malformedBackend.connect(malformedRecordDevice);
    malformedBackend.storage.records[0].valid = false;
    await assert.rejects(
        malformedBackend.renameScript('hello', 'blocked'),
        /malformed records/
    );
    await malformedBackend.close();

    const corruptStorageDevice = new MockNumWorksDevice();
    corruptStorageDevice.writeRange(0x24001000 + 4, new Uint8Array([0xFF, 0xFF]));
    const corruptStorageBackend = new NumWorksBackend();
    const corruptInfo = await corruptStorageBackend.connect(corruptStorageDevice);
    assert.equal(corruptInfo.storageValid, false);
    assert.match(corruptInfo.storageError, /record size/);
    assert.equal(corruptStorageBackend.listScripts().length, 0);
    const corruptBackup = await corruptStorageBackend.readRawStorageImage();
    assert.equal(corruptBackup.byteLength, 1032,
        'raw backup remains available when storage parsing fails');
    await assert.rejects(
        corruptStorageBackend.deleteScripts(['hello']),
        /record size/
    );
    await corruptStorageBackend.close();

    const interruptedDevice = new MockNumWorksDevice();
    const interruptedBackend = new NumWorksBackend();
    await interruptedBackend.connect(interruptedDevice);
    const interruptedWriteRam = interruptedBackend.transport.writeRam
        .bind(interruptedBackend.transport);
    let writeNumber = 0;
    interruptedBackend.transport.writeRam = async (address, data) => {
        writeNumber += 1;
        if (writeNumber === 3) {
            throw new Error('mock mid-commit disconnect');
        }
        return interruptedWriteRam(address, data);
    };
    await assert.rejects(
        interruptedBackend.upsertScripts([{ name: 'interrupted', code: 'pass\n' }]),
        /mid-commit disconnect/
    );
    const interruptedRaw = await interruptedBackend.readRawStorageImage();
    assert.notEqual(new DataView(interruptedRaw.buffer).getUint32(0, false), 0xBADD0BEE,
        'an interrupted rewrite remains explicitly marked invalid');
    await interruptedBackend.close();

    const recoveryBackend = new NumWorksBackend();
    const recoveryInfo = await recoveryBackend.connect(interruptedDevice);
    assert.equal(recoveryInfo.storageValid, false);
    assert.equal((await recoveryBackend.readRawStorageImage()).byteLength, 1032);
    await recoveryBackend.close();

    const disconnectedBackend = new NumWorksBackend();
    await assert.rejects(disconnectedBackend.deleteScripts(['missing']), /not connected/);
    await assert.rejects(disconnectedBackend.renameScript('old', 'new'), /not connected/);

    console.log('NumWorks backend tests passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
