'use strict';

const { copyBytes, dataViewFor } = require('./numworks_storage.js');

const SLOT_MAGIC = 0xBADBEEEF;
const PLATFORM_MAGICS = new Set([0xF00DC0DE, 0xFEEDC0DE]);
const textDecoder = new TextDecoder('utf-8');

function readCString(bytes, offset, maxLength) {
    const data = copyBytes(bytes);
    const endLimit = Math.min(data.byteLength, offset + maxLength);
    let end = offset;
    while (end < endLimit && data[end] !== 0) end++;
    return textDecoder.decode(data.subarray(offset, end));
}

function parseSlotInfo(data) {
    const bytes = copyBytes(data);
    if (bytes.byteLength < 16) return { valid: false };
    const view = dataViewFor(bytes);
    const regularMagic = view.getUint32(0, false) === SLOT_MAGIC;
    // Old Upsilon bootloaders could corrupt only the high byte of this magic.
    const legacyCorruptMagic = (view.getUint32(0, false) & 0x00FFFFFF)
        === (SLOT_MAGIC & 0x00FFFFFF);
    if (!regularMagic && !legacyCorruptMagic) return { valid: false };

    const kernelHeader = view.getUint32(4, true);
    const userlandHeader = view.getUint32(8, true);
    const slotStarts = new Map([
        [0x90000000, 'A'],
        [0x90400000, 'B'],
        [0x90180000, 'Khi']
    ]);
    return {
        valid: true,
        footerValid: view.getUint32(12, false) === SLOT_MAGIC,
        kernelHeader,
        userlandHeader,
        name: slotStarts.get((kernelHeader - 8) >>> 0) || 'Unknown'
    };
}

function parseKernelHeader(data) {
    const bytes = copyBytes(data);
    if (bytes.byteLength < 24) return { valid: false };
    const view = dataViewFor(bytes);
    const magic = view.getUint32(0, false);
    if (!PLATFORM_MAGICS.has(magic)) return { valid: false };
    return {
        valid: true,
        footerValid: view.getUint32(20, false) === magic,
        version: readCString(bytes, 4, 8),
        commit: readCString(bytes, 12, 8)
    };
}

function parseUserlandHeader(data) {
    const bytes = copyBytes(data);
    if (bytes.byteLength < 40) return { valid: false };
    const view = dataViewFor(bytes);
    const magic = view.getUint32(0, false);
    if (!PLATFORM_MAGICS.has(magic)) return { valid: false };
    let footerOffset = 36;
    if (view.getUint32(footerOffset, false) !== magic && bytes.byteLength >= 48) {
        footerOffset = 44;
    }
    return {
        valid: true,
        footerValid: view.getUint32(footerOffset, false) === magic,
        version: readCString(bytes, 4, 8),
        storageAddress: view.getUint32(12, true),
        storageSize: view.getUint32(16, true)
    };
}

function parseLegacyPlatformInfo(data) {
    const bytes = copyBytes(data);
    if (bytes.byteLength < 64) return { valid: false };
    const view = dataViewFor(bytes);
    const magic = view.getUint32(0, false);
    if (!PLATFORM_MAGICS.has(magic)) return { valid: false };

    const oldPlatform = view.getUint32(0x1C, false) !== magic;
    let offset = 0;
    if (oldPlatform) {
        for (const candidate of [8, 16, 32]) {
            if (0x1C + candidate + 4 <= bytes.byteLength
                && view.getUint32(0x1C + candidate, false) === magic) {
                offset = candidate;
                break;
            }
        }
    }
    return {
        valid: true,
        oldPlatform,
        version: readCString(bytes, 4, 8),
        commit: readCString(bytes, 0x0C + offset, 8),
        storageAddress: view.getUint32(0x14 + offset, true),
        storageSize: view.getUint32(0x18 + offset, true)
    };
}

function firmwareNeedsStorageAlternate(version) {
    const match = /^\s*(\d+)/.exec(String(version || ''));
    return Boolean(match && Number(match[1]) >= 24);
}

function hex(value, width = 8) {
    return `0x${Number(value >>> 0).toString(16).toUpperCase().padStart(width, '0')}`;
}

module.exports = {
    firmwareNeedsStorageAlternate,
    hex,
    parseKernelHeader,
    parseLegacyPlatformInfo,
    parseSlotInfo,
    parseUserlandHeader
};
