'use strict';

// Upsilon.js owns the generic storage format. This module is the deliberately
// small WebTILP policy layer: strict bounds checking, raw-image recovery,
// unknown-record preservation, and non-mutating Python record updates.

const STORAGE_MAGIC = 0xBADD0BEE;
const STORAGE_HEADER_SIZE = 4;
const STORAGE_TERMINATOR_SIZE = 2;
const MAX_STORAGE_SIZE = 512 * 1024;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8');

function asUint8Array(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    throw new TypeError('Expected binary data.');
}

function copyBytes(value) {
    return new Uint8Array(asUint8Array(value));
}

function dataViewFor(value) {
    const bytes = asUint8Array(value);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function concatBytes(chunks, totalLength = null) {
    const arrays = chunks.map(asUint8Array);
    const size = totalLength ?? arrays.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of arrays) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return output;
}

function parseStorageImage(data, storageSize) {
    const bytes = copyBytes(data);
    if (!Number.isInteger(storageSize) || storageSize <= 0 || storageSize > MAX_STORAGE_SIZE) {
        throw new Error(`Invalid NumWorks storage size ${storageSize}.`);
    }
    if (bytes.byteLength < storageSize + 8) {
        throw new Error(`Short NumWorks storage image (${bytes.byteLength} < ${storageSize + 8}).`);
    }
    const view = dataViewFor(bytes);
    if (view.getUint32(0, false) !== STORAGE_MAGIC) {
        throw new Error('NumWorks storage header magic is invalid.');
    }

    const records = [];
    const recordLimit = STORAGE_HEADER_SIZE + storageSize;
    let offset = STORAGE_HEADER_SIZE;
    let terminatorFound = false;
    while (offset + STORAGE_TERMINATOR_SIZE <= recordLimit) {
        const recordSize = view.getUint16(offset, true);
        if (recordSize === 0) {
            offset += STORAGE_TERMINATOR_SIZE;
            terminatorFound = true;
            break;
        }
        if (recordSize < 4 || offset + recordSize > recordLimit) {
            throw new Error(`Invalid NumWorks storage record size ${recordSize} at ${offset}.`);
        }

        const nameStart = offset + 2;
        const recordEnd = offset + recordSize;
        let nameEnd = nameStart;
        while (nameEnd < recordEnd && bytes[nameEnd] !== 0) nameEnd++;
        if (nameEnd >= recordEnd) {
            throw new Error(`NumWorks storage record at ${offset} has no terminated name.`);
        }

        const nameBytes = bytes.slice(nameStart, nameEnd);
        const fullName = textDecoder.decode(nameBytes);
        const dot = fullName.lastIndexOf('.');
        const baseName = dot > 0 ? fullName.slice(0, dot) : fullName;
        const type = dot > 0 ? fullName.slice(dot + 1) : '';
        const recordData = bytes.slice(nameEnd + 1, recordEnd);
        const record = {
            fullName,
            baseName,
            type,
            nameBytes,
            data: recordData,
            recordSize,
            valid: true
        };
        if (type.toLowerCase() === 'py') {
            record.autoImport = Boolean(recordData[0] & 0x01);
            let contentEnd = 1;
            while (contentEnd < recordData.byteLength && recordData[contentEnd] !== 0) {
                contentEnd++;
            }
            record.valid = recordData.byteLength >= 2 && contentEnd < recordData.byteLength;
            record.code = textDecoder.decode(recordData.subarray(1, contentEnd));
        }
        records.push(record);
        offset += recordSize;
    }
    if (!terminatorFound) {
        throw new Error('NumWorks storage record terminator is missing.');
    }

    return {
        records,
        rawImage: bytes,
        usedBytes: offset,
        freeBytes: Math.max(0, recordLimit - offset),
        footerValid: view.getUint32(STORAGE_HEADER_SIZE + storageSize, false) === STORAGE_MAGIC
    };
}

function encodeStoragePrefix(records, storageSize) {
    const chunks = [new Uint8Array([0xBA, 0xDD, 0x0B, 0xEE])];
    const prefixLimit = STORAGE_HEADER_SIZE + storageSize;
    let total = STORAGE_HEADER_SIZE;
    for (const record of records) {
        const nameBytes = record.nameBytes
            ? copyBytes(record.nameBytes)
            : textEncoder.encode(record.fullName);
        if (!nameBytes.byteLength || nameBytes.includes(0)) {
            throw new Error('NumWorks record name is empty or contains a NUL byte.');
        }
        const recordData = copyBytes(record.data);
        const recordSize = 2 + nameBytes.byteLength + 1 + recordData.byteLength;
        if (recordSize > 0xFFFF) {
            throw new Error(`NumWorks record ${record.fullName} is too large.`);
        }
        if (total + recordSize + STORAGE_TERMINATOR_SIZE > prefixLimit) {
            throw new Error('The NumWorks script storage does not have enough free space.');
        }
        const encoded = new Uint8Array(recordSize);
        new DataView(encoded.buffer).setUint16(0, recordSize, true);
        encoded.set(nameBytes, 2);
        encoded[2 + nameBytes.byteLength] = 0;
        encoded.set(recordData, 3 + nameBytes.byteLength);
        chunks.push(encoded);
        total += recordSize;
    }
    chunks.push(new Uint8Array([0, 0]));
    return concatBytes(chunks, total + STORAGE_TERMINATOR_SIZE);
}

function normalizeScriptName(filename) {
    const leaf = String(filename || '').split(/[\\/]/).pop() || '';
    const withoutExtension = leaf.replace(/\.py$/i, '');
    let baseName = withoutExtension
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/_+/g, '_');
    if (!baseName) baseName = 'script';
    if (!/^[a-z_]/.test(baseName)) baseName = `_${baseName}`;
    baseName = baseName.slice(0, 215);
    if (!/^[a-z_][a-z0-9_]*$/.test(baseName)) {
        throw new Error(`Cannot create a valid NumWorks script name from ${filename}.`);
    }
    return baseName;
}

function makePythonRecord(baseName, code, autoImport = true) {
    const normalized = normalizeScriptName(baseName);
    const source = String(code ?? '');
    if (source.includes('\0')) {
        throw new Error(`NumWorks script ${normalized}.py contains a NUL byte.`);
    }
    const content = textEncoder.encode(source);
    const data = new Uint8Array(content.byteLength + 2);
    data[0] = autoImport ? 1 : 0;
    data.set(content, 1);
    data[data.byteLength - 1] = 0;
    const fullName = `${normalized}.py`;
    return {
        fullName,
        baseName: normalized,
        type: 'py',
        nameBytes: textEncoder.encode(fullName),
        data,
        autoImport: Boolean(autoImport),
        code: source,
        valid: true
    };
}

function cloneRecord(record) {
    return {
        ...record,
        nameBytes: copyBytes(record.nameBytes),
        data: copyBytes(record.data)
    };
}

module.exports = {
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
};
