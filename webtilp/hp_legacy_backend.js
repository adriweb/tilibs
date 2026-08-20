/*
 * Classic Kermit support for the pre-Prime HP calculators which share
 * USB 03f0:0121.  The USB identity is deliberately treated as ambiguous:
 * it covers the HP 39g+/39gs/40gs as well as the HP 48gII/49g+/50g.
 *
 * Only the latter RPL family is known to expose the Kermit server used here.
 * The 39/40 family uses the same byte transport, but its documented host
 * protocol is HP-flavoured XModem and is not enabled by this backend yet.
 */
(function (scope) {
'use strict';

const HP_LEGACY_VENDOR_ID = 0x03F0;
const HP_LEGACY_PRODUCT_ID = 0x0121;
const HP_LEGACY_MAX_SEND_PACKET = 80;
const KERMIT_SOH = 0x01;
const KERMIT_CR = 0x0D;
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_RETRIES = 5;
const HP48_BINARY_PREFIX = Uint8Array.of(
    0x48, 0x50, 0x48, 0x50, 0x34, 0x38
); // "HPHP48"
const HP49_BINARY_PREFIX = Uint8Array.of(
    0x48, 0x50, 0x48, 0x50, 0x34, 0x39
); // "HPHP49"
const HP_STRING_PROLOG = 0x02A2C;
const HP_GROB_PROLOG = 0x02B1E;

const ascii = value => typeof value === 'number' ? value : value.charCodeAt(0);
const toChar = value => (value + 32) & 0xFF;
const unChar = value => (value - 32) & 0xFF;
const ctl = value => value ^ 0x40;

function copyBytes(value) {
    if (value instanceof Uint8Array) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer.slice(value.byteOffset,
            value.byteOffset + value.byteLength));
    }
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
    return Uint8Array.from(value || []);
}

function concatBytes(parts) {
    const arrays = parts.map(copyBytes);
    const output = new Uint8Array(arrays.reduce((sum, item) => sum + item.length, 0));
    let offset = 0;
    for (const item of arrays) {
        output.set(item, offset);
        offset += item.length;
    }
    return output;
}

function latin1Bytes(value) {
    const text = String(value);
    const output = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        if (code > 0xFF) {
            throw new Error('HP RHOST commands must use the calculator Latin-1/ASCII spelling.');
        }
        output[index] = code;
    }
    return output;
}

function startsWithBytes(input, prefix) {
    return input.length >= prefix.length
        && prefix.every((byte, index) => input[index] === byte);
}

function hpBinaryObjectOffset(bytes, kind) {
    const hasKnownPrefix = startsWithBytes(bytes, HP48_BINARY_PREFIX)
        || startsWithBytes(bytes, HP49_BINARY_PREFIX);
    if (hasKnownPrefix) {
        if (bytes.length < 8) {
            throw new Error(`The HP ${kind} binary-file header is truncated.`);
        }
        return 8;
    }
    if (bytes.length >= 4
        && bytes[0] === ascii('H') && bytes[1] === ascii('P')
        && bytes[2] === ascii('H') && bytes[3] === ascii('P')) {
        throw new Error(`The HP ${kind} has an unsupported binary-file header.`);
    }
    return 0;
}

function latin1Text(data) {
    let text = '';
    for (const byte of copyBytes(data)) text += String.fromCharCode(byte);
    return text;
}

function hpAsciiObjectBody(data) {
    const bytes = copyBytes(data);
    let offset = 0;
    // A BOM is not part of HP's format, but accepting one makes downloaded
    // text objects no less safe to identify.
    if (bytes.length >= 3
        && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
        offset = 3;
    }
    while (offset < bytes.length
        && [0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20].includes(bytes[offset])) {
        offset += 1;
    }
    const prefix = latin1Bytes('%%HP:');
    if (!startsWithBytes(bytes.slice(offset), prefix)) return null;

    const headerEnd = bytes.indexOf(ascii(';'), offset + prefix.length);
    if (headerEnd < 0) throw new Error('The HP ASCII-file header is truncated.');
    return latin1Text(bytes.slice(headerEnd + 1)).trim();
}

function makeHpGrobImage(width, height, rowStrideNibbles, nibbleAt) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
        || width <= 0 || height <= 0) {
        throw new Error('The HP GROB dimensions are invalid.');
    }
    const minimumRowNibbles = Math.ceil(width / 4);
    if (!Number.isSafeInteger(rowStrideNibbles)
        || rowStrideNibbles < minimumRowNibbles) {
        throw new Error('The HP GROB rows are too short for its declared width.');
    }

    const pixelCount = width * height;
    if (!Number.isSafeInteger(pixelCount)) {
        throw new Error('The HP GROB dimensions are too large.');
    }
    const pixels = new Uint8Array(pixelCount);
    const rgba = new Uint8ClampedArray(pixelCount * 4);
    for (let y = 0; y < height; y += 1) {
        const rowStart = y * rowStrideNibbles;
        for (let x = 0; x < width; x += 1) {
            const set = (nibbleAt(rowStart + (x >> 2)) >>> (x & 3)) & 1;
            const pixelIndex = y * width + x;
            pixels[pixelIndex] = set;
            const color = set ? 0 : 0xFF;
            const rgbaIndex = pixelIndex * 4;
            rgba[rgbaIndex] = color;
            rgba[rgbaIndex + 1] = color;
            rgba[rgbaIndex + 2] = color;
            rgba[rgbaIndex + 3] = 0xFF;
        }
    }
    return { width, height, pixels, rgba };
}

function decodeHpBinaryGrob(data) {
    const bytes = copyBytes(data);
    const byteOffset = hpBinaryObjectOffset(bytes, 'GROB');

    const nibbleCount = (bytes.length - byteOffset) * 2;
    if (nibbleCount < 20) throw new Error('The HP GROB header is truncated.');
    const nibbleAt = index => {
        if (index < 0 || index >= nibbleCount) {
            throw new Error('The HP GROB data is truncated.');
        }
        const byte = bytes[byteOffset + (index >> 1)];
        return index & 1 ? byte >>> 4 : byte & 0x0F;
    };
    const uintAt = (index, length) => {
        let value = 0;
        for (let digit = 0; digit < length; digit += 1) {
            value += nibbleAt(index + digit) * (16 ** digit);
        }
        return value;
    };

    const prolog = uintAt(0, 5);
    if (prolog !== HP_GROB_PROLOG) {
        throw new Error(`Expected an HP GROB object (prolog 02B1E), received ${prolog.toString(16).toUpperCase().padStart(5, '0')}.`);
    }
    const objectSizeNibbles = uintAt(5, 5);
    const height = uintAt(10, 5);
    const width = uintAt(15, 5);
    if (objectSizeNibbles < 15) throw new Error('The HP GROB size is invalid.');
    const objectEnd = 5 + objectSizeNibbles;
    if (objectEnd > nibbleCount) throw new Error('The HP GROB data is truncated.');
    if (!width || !height) throw new Error('The HP GROB dimensions are invalid.');

    const pixelNibbleCount = objectSizeNibbles - 15;
    if (pixelNibbleCount % height !== 0) {
        throw new Error('The HP GROB rows do not fit its declared size.');
    }
    const rowStrideNibbles = pixelNibbleCount / height;
    const pixelStart = 20;
    return makeHpGrobImage(width, height, rowStrideNibbles,
        index => nibbleAt(pixelStart + index));
}

function decodeHpBinaryString(data) {
    const bytes = copyBytes(data);
    const byteOffset = hpBinaryObjectOffset(bytes, 'string');

    const nibbleCount = (bytes.length - byteOffset) * 2;
    if (nibbleCount < 10) throw new Error('The HP string header is truncated.');
    const nibbleAt = index => {
        if (index < 0 || index >= nibbleCount) {
            throw new Error('The HP string data is truncated.');
        }
        const byte = bytes[byteOffset + (index >> 1)];
        return index & 1 ? byte >>> 4 : byte & 0x0F;
    };
    const uintAt = (index, length) => {
        let value = 0;
        for (let digit = 0; digit < length; digit += 1) {
            value += nibbleAt(index + digit) * (16 ** digit);
        }
        return value;
    };

    const prolog = uintAt(0, 5);
    if (prolog !== HP_STRING_PROLOG) {
        throw new Error(`Expected an HP string object (prolog 02A2C), received ${prolog.toString(16).toUpperCase().padStart(5, '0')}.`);
    }
    const objectSizeNibbles = uintAt(5, 5);
    if (objectSizeNibbles < 5) throw new Error('The HP string size is invalid.');
    const objectEnd = 5 + objectSizeNibbles;
    if (objectEnd > nibbleCount) throw new Error('The HP string data is truncated.');
    const payloadNibbleCount = objectSizeNibbles - 5;
    if (payloadNibbleCount % 2 !== 0) {
        throw new Error('The HP string has an invalid character payload size.');
    }

    let text = '';
    for (let index = 0; index < payloadNibbleCount; index += 2) {
        const byte = nibbleAt(10 + index) | (nibbleAt(11 + index) << 4);
        text += String.fromCharCode(byte);
    }
    return text;
}

function decodeHpTransferredGrob(data) {
    const body = hpAsciiObjectBody(data);
    if (body === null) return decodeHpBinaryGrob(data);

    const match = /^GROB\s+([0-9]+)\s+([0-9]+)\s+([\s\S]*)$/.exec(body);
    if (!match) throw new Error('Expected an ASCII HP GROB object.');
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
        || width <= 0 || height <= 0) {
        throw new Error('The HP GROB dimensions are invalid.');
    }

    const hex = match[3].replace(/[\t\n\v\f\r ]/g, '');
    if (!/^[0-9A-Fa-f]+$/.test(hex)) {
        throw new Error('The ASCII HP GROB contains invalid hexadecimal data.');
    }
    // Text GROB rows are padded to whole bytes, even though four horizontal
    // pixels fit in each hexadecimal digit.
    const rowStrideNibbles = Math.ceil(width / 8) * 2;
    const expectedNibbles = height * rowStrideNibbles;
    if (!Number.isSafeInteger(expectedNibbles)) {
        throw new Error('The HP GROB dimensions are too large.');
    }
    if (hex.length !== expectedNibbles) {
        throw new Error(`The ASCII HP GROB pixel data has ${hex.length} hexadecimal digits; expected ${expectedNibbles}.`);
    }
    return makeHpGrobImage(width, height, rowStrideNibbles,
        index => Number.parseInt(hex[index], 16));
}

function decodeHpTransferredString(data) {
    const body = hpAsciiObjectBody(data);
    if (body === null) return decodeHpBinaryString(data);
    if (body.length < 2 || body[0] !== '"' || body[body.length - 1] !== '"') {
        throw new Error('Expected an ASCII HP string object.');
    }
    // VERSION's model marker is plain ASCII.  Keep the calculator's RPL
    // escape spelling intact instead of trying to implement every translation
    // mode encoded by the %%HP header.
    return body.slice(1, -1);
}

function makeHpTemporaryName(randomSource = scope?.crypto) {
    if (!randomSource || typeof randomSource.getRandomValues !== 'function') {
        throw new Error('Secure randomness is unavailable for the temporary HP variable name.');
    }
    const random = new Uint8Array(12);
    randomSource.getRandomValues(random);
    return `WT${Array.from(random, byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function validateHpTemporaryName(value) {
    const name = String(value || '');
    if (!/^[A-Z][A-Z0-9]{7,30}$/.test(name)) {
        throw new Error('The temporary HP variable name is invalid.');
    }
    return name;
}

function parseHpModelVersion(versionText) {
    const text = String(versionText ?? '');
    const normalized = text.toUpperCase();
    const models = [
        { marker: 'HP50-C', modelId: 'hp50g', modelName: 'HP 50g' },
        { marker: 'HP49-C', modelId: 'hp49gplus', modelName: 'HP 49g+' },
        // The HP 48gII is the only HP48-family model using USB 03f0:0121.
        { marker: 'HP48', modelId: 'hp48gii', modelName: 'HP 48gII' }
    ];
    const match = models.find(model => normalized.includes(model.marker));
    return {
        modelId: match?.modelId || null,
        modelName: match?.modelName || null,
        versionText: text
    };
}

function computeChecksum(seq, type, data, size) {
    const bytes = copyBytes(data);
    const typeByte = ascii(type);
    if (size === 1) {
        let sum = (toChar(bytes.length + 3) + toChar(seq) + typeByte) & 0xFF;
        for (const byte of bytes) sum = (sum + byte) & 0xFF;
        return Uint8Array.of(toChar((sum + ((sum & 0xC0) >> 6)) & 0x3F));
    }
    if (size === 2) {
        let sum = toChar(bytes.length + 4) + toChar(seq) + typeByte;
        for (const byte of bytes) sum = (sum + byte) & 0xFFFF;
        return Uint8Array.of(toChar((sum & 0x0FC0) >> 6), toChar(sum & 0x3F));
    }
    if (size === 3) {
        const framed = concatBytes([
            Uint8Array.of(toChar(bytes.length + 5), toChar(seq), typeByte),
            bytes
        ]);
        let crc = 0;
        for (const byte of framed) {
            let q = (crc ^ byte) & 0x0F;
            crc = (crc >>> 4) ^ (q * 0x1081);
            q = (crc ^ (byte >>> 4)) & 0x0F;
            crc = (crc >>> 4) ^ (q * 0x1081);
        }
        return Uint8Array.of(
            toChar((crc >>> 12) & 0x0F),
            toChar((crc >>> 6) & 0x3F),
            toChar(crc & 0x3F)
        );
    }
    throw new Error(`Unsupported Kermit checksum size ${size}.`);
}

function makePacket(seq, type, data = [], checksumSize = 1, parameters = {}) {
    const payload = copyBytes(data);
    const checksum = computeChecksum(seq, type, payload, checksumSize);
    const packetLength = payload.length + checksum.length + 2;
    if (packetLength > 94) throw new Error('Kermit short packet is too large.');
    const padCount = Math.max(0, Number(parameters.txNumPadBytes) || 0);
    const output = new Uint8Array(padCount + packetLength + 3);
    output.fill(Number(parameters.txPadByte) & 0xFF, 0, padCount);
    let offset = padCount;
    output[offset++] = KERMIT_SOH;
    output[offset++] = toChar(packetLength);
    output[offset++] = toChar(seq & 0x3F);
    output[offset++] = ascii(type);
    output.set(payload, offset);
    offset += payload.length;
    output.set(checksum, offset);
    output[output.length - 1] = parameters.txPacketTerminatorByte ?? KERMIT_CR;
    return output;
}

function parsePacket(bytes, checksumSize = 1) {
    const input = copyBytes(bytes);
    if (input.length < 5 || input[0] !== KERMIT_SOH) {
        throw new Error('Malformed Kermit packet.');
    }
    const packetLength = unChar(input[1]);
    const framedLength = packetLength + 2;
    if (packetLength < checksumSize + 2 || input.length < framedLength) {
        throw new Error('Truncated Kermit packet.');
    }
    const seq = unChar(input[2]) & 0x3F;
    const type = String.fromCharCode(input[3]);
    const dataEnd = framedLength - checksumSize;
    const data = input.slice(4, dataEnd);
    const receivedChecksum = input.slice(dataEnd, framedLength);
    const expectedChecksum = computeChecksum(seq, type, data, checksumSize);
    const checksumValid = receivedChecksum.length === expectedChecksum.length
        && receivedChecksum.every((byte, index) => byte === expectedChecksum[index]);
    return { seq, type, data, checksumSize, checksumValid, raw: input.slice(0, framedLength) };
}

function defaultParameters() {
    return {
        hostTimeoutMs: DEFAULT_TIMEOUT_MS,
        checksumSize: 1,
        binaryQuoteEnable: false,
        repeatPrefixEnable: false,
        binaryQuoteByte: ascii('Y'),
        repeatPrefixByte: ascii(' '),
        txMaxPacketLength: HP_LEGACY_MAX_SEND_PACKET,
        txNumPadBytes: 0,
        txPadByte: 0,
        txPacketTerminatorByte: KERMIT_CR,
        txCtrlQuoteByte: ascii('#'),
        rxCtrlQuoteByte: ascii('#')
    };
}

function parameterRequest(checksumSize = 3) {
    /*
     * The HP 50g rejects the nine-field minimal form accepted by many
     * Kermit implementations.  Match C-Kermit 9.0.302's extended
     * initialization parameters, including CAPAS and long-packet/window
     * fields.  The calculator may answer with only the first eight fields.
     */
    return Uint8Array.of(
        toChar(94),
        toChar(15),
        toChar(0),
        ctl(0),
        toChar(KERMIT_CR),
        ascii('#'),
        ascii('Y'),
        ascii('0') + checksumSize,
        ascii('~'),
        ascii('^'),
        ascii('>'),
        ascii('J'),
        ascii(')'),
        ascii('0'),
        ascii('_'),
        ascii('_'),
        ascii('_'),
        ascii('F'),
        ascii('"'),
        ascii('U'),
        ascii('1'),
        ascii('@')
    );
}

function applyNegotiatedParameters(data, base = defaultParameters()) {
    const bytes = copyBytes(data);
    const next = { ...base };
    if (bytes.length >= 1) {
        next.txMaxPacketLength = Math.min(HP_LEGACY_MAX_SEND_PACKET,
            Math.max(10, unChar(bytes[0])));
    }
    if (bytes.length >= 3) next.txNumPadBytes = unChar(bytes[2]);
    if (bytes.length >= 4) next.txPadByte = ctl(bytes[3]);
    if (bytes.length >= 5) next.txPacketTerminatorByte = unChar(bytes[4]);
    if (bytes.length >= 6) next.rxCtrlQuoteByte = bytes[5];
    if (bytes.length >= 7) next.binaryQuoteByte = bytes[6];
    if (bytes.length >= 8) {
        const requested = bytes[7] - ascii('0');
        next.checksumSize = requested >= 1 && requested <= 3 ? requested : 1;
    }
    if (bytes.length >= 9) next.repeatPrefixByte = bytes[8];
    const qbin = next.binaryQuoteByte;
    next.binaryQuoteEnable = !(qbin === ascii('Y') || qbin === ascii('N')
        || qbin < 33 || (qbin > 62 && qbin < 96) || qbin > 126);
    next.repeatPrefixEnable = next.repeatPrefixByte !== ascii(' ');
    return next;
}

function parameterResponse(request) {
    const pending = applyNegotiatedParameters(request);
    return {
        data: Uint8Array.of(
            toChar(94),
            toChar(3),
            toChar(0),
            ctl(0),
            toChar(KERMIT_CR),
            ascii('#'),
            pending.binaryQuoteByte,
            ascii('0') + pending.checksumSize,
            pending.repeatPrefixByte
        ),
        parameters: pending
    };
}

function encodeByte(byte, parameters) {
    const value = byte & 0xFF;
    const qctl = parameters.txCtrlQuoteByte;
    const qbinEnabled = parameters.binaryQuoteEnable;
    const qbin = parameters.binaryQuoteByte;
    const repeatEnabled = parameters.repeatPrefixEnable;
    const repeat = parameters.repeatPrefixByte;
    if (value < 32 || value === 127) return Uint8Array.of(qctl, ctl(value));
    if (value < 128) {
        if (value === qctl) return Uint8Array.of(qctl, qctl);
        if (qbinEnabled && value === qbin) return Uint8Array.of(qctl, qbin);
        if (repeatEnabled && value === repeat) return Uint8Array.of(qctl, repeat);
        return Uint8Array.of(value);
    }
    if (qbinEnabled) {
        if (value < 160 || value === 255) {
            return Uint8Array.of(qbin, qctl, ctl(value & 0x7F));
        }
        const low = value & 0x7F;
        if (low === qctl || low === qbin || (repeatEnabled && low === repeat)) {
            return Uint8Array.of(qbin, qctl, low);
        }
        return Uint8Array.of(qbin, low);
    }
    if (value < 160 || value === 255) return Uint8Array.of(qctl, ctl(value));
    if ((value & 0x7F) === qctl || (repeatEnabled && (value & 0x7F) === repeat)) {
        return Uint8Array.of(qctl, value);
    }
    return Uint8Array.of(value);
}

function encodeData(data, parameters) {
    return concatBytes(Array.from(copyBytes(data), byte => encodeByte(byte, parameters)));
}

function decodeData(data, parameters) {
    const input = copyBytes(data);
    const output = [];
    let index = 0;
    const decodeFragment = (allowRepeat = true) => {
        if (index >= input.length) throw new Error('Truncated Kermit quoted data.');
        const byte = input[index++];
        if (byte === parameters.rxCtrlQuoteByte) {
            if (index >= input.length) throw new Error('Truncated Kermit control quote.');
            const next = input[index++];
            const low = next & 0x7F;
            if (low === (parameters.rxCtrlQuoteByte & 0x7F)
                || (parameters.binaryQuoteEnable
                    && low === (parameters.binaryQuoteByte & 0x7F))
                || (parameters.repeatPrefixEnable
                    && low === (parameters.repeatPrefixByte & 0x7F))) {
                return [next];
            }
            return [ctl(next)];
        }
        if (parameters.binaryQuoteEnable && byte === parameters.binaryQuoteByte) {
            return decodeFragment(false).map(value => value | 0x80);
        }
        if (allowRepeat && parameters.repeatPrefixEnable
            && byte === parameters.repeatPrefixByte) {
            if (index >= input.length) throw new Error('Truncated Kermit repeat quote.');
            const count = unChar(input[index++]);
            const decoded = decodeFragment(false);
            return Array.from({ length: count }, () => decoded[0]);
        }
        return [byte];
    };
    while (index < input.length) output.push(...decodeFragment());
    return Uint8Array.from(output);
}

function encodeDataChunks(data, parameters) {
    const maxDataLength = Math.max(1,
        Math.min(HP_LEGACY_MAX_SEND_PACKET, parameters.txMaxPacketLength)
        - 2 - parameters.checksumSize);
    const chunks = [];
    let current = [];
    let currentLength = 0;
    for (const byte of copyBytes(data)) {
        const quantum = encodeByte(byte, parameters);
        if (currentLength && currentLength + quantum.length > maxDataLength) {
            chunks.push(concatBytes(current));
            current = [];
            currentLength = 0;
        }
        if (quantum.length > maxDataLength) {
            throw new Error('Kermit quoting quantum exceeds negotiated packet size.');
        }
        current.push(quantum);
        currentLength += quantum.length;
    }
    if (currentLength) chunks.push(concatBytes(current));
    return chunks;
}

class QueuedByteTransport {
    constructor() {
        this.chunks = [];
        this.waiters = [];
        this.closed = false;
        this.error = null;
        this.pumpPromise = null;
    }

    startPump(readOne) {
        this.pumpPromise = (async () => {
            try {
                while (!this.closed) {
                    const chunk = await readOne();
                    if (chunk?.length) this.pushChunk(chunk);
                    if (chunk === null) break;
                }
            } catch (error) {
                if (!this.closed) this.fail(error);
            }
        })();
    }

    pushChunk(chunk) {
        const bytes = copyBytes(chunk);
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(bytes);
        else this.chunks.push(bytes);
    }

    fail(error) {
        this.error = error instanceof Error ? error : new Error(String(error));
        for (const waiter of this.waiters.splice(0)) waiter.reject(this.error);
    }

    async read(timeoutMs = DEFAULT_TIMEOUT_MS) {
        if (this.chunks.length) return this.chunks.shift();
        if (this.error) throw this.error;
        if (this.closed) throw new Error('HP calculator transport is closed.');
        return new Promise((resolve, reject) => {
            const waiter = { resolve, reject, timer: null };
            waiter.resolve = value => {
                clearTimeout(waiter.timer);
                resolve(value);
            };
            waiter.reject = error => {
                clearTimeout(waiter.timer);
                reject(error);
            };
            waiter.timer = setTimeout(() => {
                const index = this.waiters.indexOf(waiter);
                if (index >= 0) this.waiters.splice(index, 1);
                reject(new Error('Timed out waiting for the HP calculator.'));
            }, timeoutMs);
            this.waiters.push(waiter);
        });
    }

    markClosed() {
        this.closed = true;
        for (const waiter of this.waiters.splice(0)) {
            waiter.reject(new Error('HP calculator transport is closed.'));
        }
    }
}

class WebUsbByteTransport extends QueuedByteTransport {
    constructor(device) {
        super();
        this.device = device;
        this.interfaceNumber = null;
        this.inEndpoint = null;
        this.outEndpoint = null;
    }

    async open() {
        await this.device.open();
        if (!this.device.configuration) await this.device.selectConfiguration(1);
        let selected = null;
        for (const iface of this.device.configuration?.interfaces || []) {
            for (const alternate of iface.alternates || []) {
                const endpoints = alternate.endpoints || [];
                const input = endpoints.find(endpoint => endpoint.type === 'bulk'
                    && endpoint.direction === 'in');
                const output = endpoints.find(endpoint => endpoint.type === 'bulk'
                    && endpoint.direction === 'out');
                if (input && output) {
                    selected = { iface, alternate, input, output };
                    break;
                }
            }
            if (selected) break;
        }
        if (!selected) throw new Error('The HP USB interface has no bulk IN/OUT pair.');
        this.interfaceNumber = selected.iface.interfaceNumber;
        await this.device.claimInterface(this.interfaceNumber);
        const activeSetting = selected.iface.alternate?.alternateSetting;
        if (activeSetting !== selected.alternate.alternateSetting
            && this.device.selectAlternateInterface) {
            await this.device.selectAlternateInterface(this.interfaceNumber,
                selected.alternate.alternateSetting);
        }
        this.inEndpoint = selected.input.endpointNumber;
        this.outEndpoint = selected.output.endpointNumber;
        this.startPump(async () => {
            const result = await this.device.transferIn(this.inEndpoint, 1024);
            if (result.status !== 'ok') throw new Error(`HP USB read failed (${result.status}).`);
            return result.data ? new Uint8Array(result.data.buffer,
                result.data.byteOffset, result.data.byteLength) : new Uint8Array();
        });
        return this;
    }

    async write(data) {
        const result = await this.device.transferOut(this.outEndpoint, copyBytes(data));
        if (result.status !== 'ok') throw new Error(`HP USB write failed (${result.status}).`);
    }

    async close() {
        this.markClosed();
        try {
            if (this.interfaceNumber != null && this.device.opened) {
                await this.device.releaseInterface(this.interfaceNumber);
            }
        } catch (_) {}
        try { if (this.device.opened) await this.device.close(); } catch (_) {}
    }
}

class WebSerialByteTransport extends QueuedByteTransport {
    constructor(port) {
        super();
        this.port = port;
        this.reader = null;
        this.writer = null;
    }

    async open() {
        if (!this.port.readable || !this.port.writable) {
            await this.port.open({ baudRate: 115200, dataBits: 8, stopBits: 1,
                parity: 'none', flowControl: 'none', bufferSize: 4096 });
        }
        this.reader = this.port.readable.getReader();
        this.writer = this.port.writable.getWriter();
        this.startPump(async () => {
            const { value, done } = await this.reader.read();
            return done ? null : copyBytes(value);
        });
        return this;
    }

    async write(data) {
        await this.writer.write(copyBytes(data));
    }

    async close() {
        this.markClosed();
        try { await this.reader?.cancel(); } catch (_) {}
        try { this.reader?.releaseLock(); } catch (_) {}
        try { await this.writer?.close(); } catch (_) {}
        try { this.writer?.releaseLock(); } catch (_) {}
        try { await this.port.close(); } catch (_) {}
    }
}

class KermitPacketStream {
    constructor(transport) {
        this.transport = transport;
        this.buffer = [];
    }

    async readPacket(checksumSize, timeoutMs) {
        while (true) {
            while (this.buffer.length && this.buffer[0] !== KERMIT_SOH) this.buffer.shift();
            if (this.buffer.length >= 2) {
                const packetLength = unChar(this.buffer[1]);
                if (packetLength >= 3 && packetLength <= 94
                    && this.buffer.length >= packetLength + 2) {
                    const raw = Uint8Array.from(this.buffer.splice(0, packetLength + 2));
                    if (this.buffer[0] === KERMIT_CR) this.buffer.shift();
                    return parsePacket(raw, checksumSize);
                }
                if (packetLength < 3 || packetLength > 94) this.buffer.shift();
            }
            const chunk = await this.transport.read(timeoutMs);
            this.buffer.push(...chunk);
        }
    }
}

class KermitClient {
    constructor(transport, options = {}) {
        this.transport = transport;
        this.stream = new KermitPacketStream(transport);
        this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
        this.retries = options.retries || DEFAULT_RETRIES;
        this.parameters = defaultParameters();
        this.busy = false;
    }

    resetParameters() {
        this.parameters = defaultParameters();
        this.parameters.hostTimeoutMs = this.timeoutMs;
    }

    packet(seq, type, data = [], checksumSize = this.parameters.checksumSize) {
        return makePacket(seq, type, data, checksumSize, this.parameters);
    }

    async readPacket(checksumSize = this.parameters.checksumSize) {
        const packet = await this.stream.readPacket(checksumSize, this.timeoutMs);
        if (!packet.checksumValid) throw new Error('HP calculator sent a bad Kermit checksum.');
        if (packet.type === 'E') {
            const message = new TextDecoder('latin1').decode(decodeData(packet.data, this.parameters));
            throw new Error(message || 'HP calculator reported a Kermit error.');
        }
        return packet;
    }

    async waitForServerReady() {
        let lastError = null;
        for (let attempt = 0; attempt < this.retries; attempt++) {
            try {
                while (true) {
                    const packet = await this.readPacket(1);
                    if (packet.type === 'N' && packet.seq === 0) return;
                }
            } catch (error) {
                lastError = error;
                if (!/Timed out|checksum/i.test(error.message)) throw error;
            }
        }
        throw lastError || new Error('Timed out waiting for the HP Kermit server.');
    }

    async exchange(packetBytes, expectedSeq, acceptedTypes = ['Y'], checksumSize) {
        let lastError = null;
        for (let attempt = 0; attempt < this.retries; attempt++) {
            await this.transport.write(packetBytes);
            try {
                while (true) {
                    const packet = await this.readPacket(checksumSize);
                    if (packet.type === 'N') {
                        if (packet.seq === ((expectedSeq + 1) & 0x3F)) return packet;
                        break;
                    }
                    if (packet.seq === expectedSeq && acceptedTypes.includes(packet.type)) return packet;
                }
            } catch (error) {
                lastError = error;
                if (!/Timed out|checksum/i.test(error.message)) throw error;
            }
        }
        throw lastError || new Error('HP Kermit retry limit reached.');
    }

    async initialize(type = 'I') {
        this.resetParameters();
        // The HP SERVER announces each new transaction with N0.  Commands sent
        // before that packet are ignored, so wait for the fresh ready window
        // instead of sending first and losing one complete timeout interval.
        await this.waitForServerReady();
        const response = await this.exchange(
            this.packet(0, type, parameterRequest(3), 1), 0, ['Y'], 1);
        this.parameters = applyNegotiatedParameters(response.data, this.parameters);
    }

    async requestReceiveStart(packetBytes) {
        let lastError = null;
        for (let attempt = 0; attempt < this.retries; attempt++) {
            await this.transport.write(packetBytes);
            try {
                while (true) {
                    const packet = await this.readPacket(1);
                    if (packet.type !== 'N') return packet;
                    break;
                }
            } catch (error) {
                lastError = error;
                if (!/Timed out|checksum/i.test(error.message)) throw error;
            }
        }
        throw lastError || new Error('HP Kermit retry limit reached.');
    }

    async receiveTransfer(firstPacket = null, initialChecksumSize = 1) {
        let packet = firstPacket || await this.readPacket(initialChecksumSize);
        if (packet.type !== 'S' || packet.seq !== 0) {
            throw new Error(`Expected Kermit send-init, received ${packet.type}${packet.seq}.`);
        }
        const negotiated = parameterResponse(packet.data);
        await this.transport.write(this.packet(0, 'Y', negotiated.data, initialChecksumSize));
        this.parameters = negotiated.parameters;
        let expectedSeq = 1;
        let remoteName = '';
        const received = [];
        let sawHeader = false;
        while (true) {
            packet = await this.readPacket();
            const previousSeq = (expectedSeq + 63) & 0x3F;
            if (packet.seq === previousSeq && ['F', 'X', 'D', 'Z'].includes(packet.type)) {
                await this.transport.write(this.packet(previousSeq, 'Y'));
                continue;
            }
            if (packet.seq !== expectedSeq) {
                await this.transport.write(this.packet(expectedSeq, 'N'));
                continue;
            }
            if (!sawHeader && (packet.type === 'F' || packet.type === 'X')) {
                remoteName = new TextDecoder('latin1').decode(decodeData(packet.data, this.parameters));
                sawHeader = true;
                await this.transport.write(this.packet(expectedSeq, 'Y'));
                expectedSeq = (expectedSeq + 1) & 0x3F;
                continue;
            }
            if (sawHeader && packet.type === 'D') {
                received.push(decodeData(packet.data, this.parameters));
                await this.transport.write(this.packet(expectedSeq, 'Y'));
                expectedSeq = (expectedSeq + 1) & 0x3F;
                continue;
            }
            if (sawHeader && packet.type === 'Z') {
                await this.transport.write(this.packet(expectedSeq, 'Y'));
                expectedSeq = (expectedSeq + 1) & 0x3F;
                packet = await this.readPacket();
                if (packet.type !== 'B' || packet.seq !== expectedSeq) {
                    throw new Error('HP Kermit transfer ended without an end-of-transaction packet.');
                }
                await this.transport.write(this.packet(expectedSeq, 'Y'));
                return { name: remoteName, data: concatBytes(received) };
            }
            throw new Error(`Unexpected Kermit packet ${packet.type}${packet.seq}.`);
        }
    }

    async withOperation(operation) {
        if (this.busy) throw new Error('Another HP Kermit operation is already running.');
        this.busy = true;
        try { return await operation(); } finally { this.busy = false; }
    }

    async listDirectory() {
        return this.withOperation(async () => {
            await this.initialize('I');
            const command = encodeData(Uint8Array.of(ascii('D')), this.parameters);
            const firstPacket = await this.requestReceiveStart(
                this.packet(0, 'G', command, 1));
            const transfer = await this.receiveTransfer(firstPacket, 1);
            return new TextDecoder('latin1').decode(transfer.data);
        });
    }

    async hostCommand(command) {
        return this.withOperation(async () => {
            await this.initialize('I');
            const encoded = encodeData(latin1Bytes(command), this.parameters);
            // C-Kermit and the HP server use a one-byte checksum for the
            // C0 command even when I0/Y0 negotiated a stronger checksum.
            const firstPacket = await this.requestReceiveStart(
                this.packet(0, 'C', encoded, 1));
            if (firstPacket.type === 'Y' && firstPacket.seq === 0) {
                return new TextDecoder('latin1').decode(
                    decodeData(firstPacket.data, this.parameters));
            }
            if (firstPacket.type === 'S' && firstPacket.seq === 0) {
                const transfer = await this.receiveTransfer(firstPacket, 1);
                return new TextDecoder('latin1').decode(transfer.data);
            }
            throw new Error(`Unexpected HP RHOST response ${firstPacket.type}${firstPacket.seq}.`);
        });
    }

    async receiveFile(name) {
        return this.withOperation(async () => {
            this.resetParameters();
            await this.waitForServerReady();
            const encodedName = encodeData(new TextEncoder().encode(String(name)), this.parameters);
            const firstPacket = await this.requestReceiveStart(
                this.packet(0, 'R', encodedName, 1));
            return this.receiveTransfer(firstPacket, 1);
        });
    }

    async sendFile(name, data) {
        return this.withOperation(async () => {
            await this.initialize('S');
            let seq = 1;
            const encodedName = encodeData(new TextEncoder().encode(String(name)), this.parameters);
            await this.exchange(this.packet(seq, 'F', encodedName), seq);
            seq = (seq + 1) & 0x3F;
            for (const chunk of encodeDataChunks(data, this.parameters)) {
                await this.exchange(this.packet(seq, 'D', chunk), seq);
                seq = (seq + 1) & 0x3F;
            }
            await this.exchange(this.packet(seq, 'Z'), seq);
            seq = (seq + 1) & 0x3F;
            await this.exchange(this.packet(seq, 'B'), seq);
        });
    }

    async finish() {
        return this.withOperation(async () => {
            this.resetParameters();
            await this.waitForServerReady();
            const command = encodeData(Uint8Array.of(ascii('F')), this.parameters);
            await this.exchange(this.packet(0, 'G', command, 1), 0, ['Y'], 1);
        });
    }
}

function parseHpRdir(text) {
    const source = String(text || '').replace(/\r/g, '');
    const normalized = source.replace(/\n/g, ' ');
    const directoryMatch = /\{\s*(.*?)\s*\}\s*([0-9.]+)/s.exec(normalized);
    if (!directoryMatch) throw new Error('The HP directory response has no { PATH } header.');
    const pathParts = directoryMatch[1].trim().split(/\s+/).filter(Boolean);
    const folder = pathParts.slice(1).join('/');
    const bodyStart = directoryMatch.index + directoryMatch[0].length;
    const body = normalized.slice(bodyStart);
    const entryPattern = /([A-Za-z][\s\S]*?)\s+([0-9.]+)\s+(.+?)\s+([0-9.]+)(?=\s+[A-Za-z]|\s*$)/g;
    const entries = [];
    for (const match of body.matchAll(entryPattern)) {
        const name = match[1].trim();
        const typeName = match[3].trim();
        const size = Number.parseFloat(match[2]);
        const isFolder = /^Directory$/i.test(typeName);
        entries.push({
            name,
            folder,
            type: 0,
            type_name: typeName,
            size: Number.isFinite(size) ? Math.ceil(size) : 0,
            hpSize: match[2],
            checksum: match[4],
            kind: 'hp-legacy',
            is_folder: isFolder ? 1 : 0,
            attr: 0
        });
    }
    return {
        path: pathParts.join(' '),
        pathParts,
        size: directoryMatch[2],
        entries
    };
}

function isHpLegacyUsbDevice(device) {
    return Boolean(device && device.vendorId === HP_LEGACY_VENDOR_ID
        && device.productId === HP_LEGACY_PRODUCT_ID);
}

function isHpLegacySerialPort(port) {
    const info = port?.getInfo?.() || {};
    return info.usbVendorId === HP_LEGACY_VENDOR_ID
        && info.usbProductId === HP_LEGACY_PRODUCT_ID;
}

class HpLegacyBackend {
    constructor(options = {}) {
        this.usbDevice = options.usbDevice || null;
        this.serialPort = options.serialPort || null;
        this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
        this.transport = null;
        this.kermit = null;
        this.kermitEnabled = false;
        this.directory = null;
        this.temporaryNameFactory = options.temporaryNameFactory || makeHpTemporaryName;
    }

    async connect(options = {}) {
        if (options.transport) {
            this.transport = options.transport;
        } else if (this.serialPort) {
            const candidate = new WebSerialByteTransport(this.serialPort);
            try {
                this.transport = await candidate.open();
            } catch (error) {
                await candidate.close();
                throw error;
            }
        } else if (this.usbDevice) {
            const candidate = new WebUsbByteTransport(this.usbDevice);
            try {
                this.transport = await candidate.open();
            } catch (error) {
                await candidate.close();
                throw error;
            }
        } else {
            throw new Error('No old-HP USB or serial transport was supplied.');
        }
        this.setKermitEnabled(options.enableKermit);
        return this;
    }

    setKermitEnabled(enabled) {
        this.kermitEnabled = Boolean(enabled);
        this.kermit = this.kermitEnabled
            ? new KermitClient(this.transport, { timeoutMs: this.timeoutMs })
            : null;
    }

    requireKermit() {
        if (!this.kermitEnabled || !this.kermit) {
            throw new Error('Kermit operations require an HP 48gII/49g+/50g running SERVER.');
        }
        return this.kermit;
    }

    async refresh() {
        this.directory = parseHpRdir(await this.requireKermit().listDirectory());
        return this.directory;
    }

    listEntries() {
        return this.directory ? this.directory.entries.map(entry => ({ ...entry })) : [];
    }

    async hostCommand(command) {
        return this.requireKermit().hostCommand(command);
    }

    async sendFile(name, data) {
        await this.requireKermit().sendFile(name, data);
    }

    async receiveFile(name) {
        return this.requireKermit().receiveFile(name);
    }

    async detectModel() {
        const kermit = this.requireKermit();
        const temporaryName = validateHpTemporaryName(await this.temporaryNameFactory());
        let created = false;
        let result = null;
        let failure = null;
        try {
            // VERSION pushes two strings.  Concatenating and storing them
            // consumes only those new objects and leaves the user stack intact.
            await kermit.hostCommand(`VERSION + '${temporaryName}' STO`);
            created = true;
            const received = await kermit.receiveFile(temporaryName);
            // SERVER follows flag -35: clear sends %%HP text, set sends a
            // binary memory image.  Decode either without changing the flag.
            result = parseHpModelVersion(decodeHpTransferredString(received.data));
        } catch (error) {
            failure = error;
        }

        // Do not risk purging a pre-existing object if creation was not
        // confirmed by a successful RHOST transaction.
        if (created) {
            try {
                await kermit.hostCommand(`'${temporaryName}' PURGE`);
            } catch (cleanupError) {
                if (failure) {
                    try { failure.cleanupError = cleanupError; } catch (_) {}
                } else {
                    failure = new Error(`The HP version probe completed, but temporary variable ${temporaryName} could not be purged.`);
                    failure.cause = cleanupError;
                }
            }
        }
        if (failure) throw failure;
        return result;
    }

    async readSerialNumber() {
        const kermit = this.requireKermit();
        const temporaryName = validateHpTemporaryName(await this.temporaryNameFactory());
        const previousTimeoutMs = kermit.timeoutMs;
        const previousRetries = kermit.retries;
        // SERIAL is optional device metadata and must not hold the whole
        // connection screen for the normal 20 s x 5 retry window.
        kermit.timeoutMs = Math.min(previousTimeoutMs, 5000);
        kermit.retries = 1;
        let created = false;
        let result = null;
        let failure = null;
        try {
            // SERIAL leaves its result on the stack.  Store it immediately so
            // reading device information does not alter the user's stack.
            await kermit.hostCommand(`SERIAL '${temporaryName}' STO`);
            created = true;
            const received = await kermit.receiveFile(temporaryName);
            result = decodeHpTransferredString(received.data);
        } catch (error) {
            failure = error;
        }

        if (created) {
            try {
                await kermit.hostCommand(`'${temporaryName}' PURGE`);
            } catch (cleanupError) {
                if (failure) {
                    try { failure.cleanupError = cleanupError; } catch (_) {}
                } else {
                    failure = new Error(`The HP serial-number probe completed, but temporary variable ${temporaryName} could not be purged.`);
                    failure.cause = cleanupError;
                }
            }
        }
        kermit.timeoutMs = previousTimeoutMs;
        kermit.retries = previousRetries;
        if (failure) throw failure;
        return result;
    }

    async captureScreenshot() {
        const kermit = this.requireKermit();
        const temporaryName = validateHpTemporaryName(await this.temporaryNameFactory());
        let created = false;
        let result = null;
        let failure = null;
        try {
            // The RPL command is LCD→, whose HP character-set byte is 0x8D.
            // Sending the printable sequence "\\->" makes the calculator parse
            // an undefined name instead of the LCD-capture command.
            await kermit.hostCommand(`LCD\x8D '${temporaryName}' STO`);
            created = true;
            const received = await kermit.receiveFile(temporaryName);
            // Preserve the user's flag -35 setting by accepting either the
            // textual GROB form or the binary memory-image form.
            result = decodeHpTransferredGrob(received.data);
        } catch (error) {
            failure = error;
        }

        if (created) {
            try {
                await kermit.hostCommand(`'${temporaryName}' PURGE`);
            } catch (cleanupError) {
                if (failure) {
                    try { failure.cleanupError = cleanupError; } catch (_) {}
                } else {
                    failure = new Error(`The HP screenshot was captured, but temporary variable ${temporaryName} could not be purged.`);
                    failure.cause = cleanupError;
                }
            }
        }
        if (failure) throw failure;
        return result;
    }

    async close(options = {}) {
        if (options.finish && this.kermit) {
            try { await this.kermit.finish(); } catch (_) {}
        }
        await this.transport?.close?.();
        this.transport = null;
        this.kermit = null;
    }
}

const api = {
    DEFAULT_TIMEOUT_MS,
    HP_LEGACY_MAX_SEND_PACKET,
    HP_LEGACY_PRODUCT_ID,
    HP_LEGACY_VENDOR_ID,
    HpLegacyBackend,
    KermitClient,
    KermitPacketStream,
    QueuedByteTransport,
    WebSerialByteTransport,
    WebUsbByteTransport,
    applyNegotiatedParameters,
    computeChecksum,
    decodeData,
    decodeHpBinaryGrob,
    decodeHpBinaryString,
    decodeHpTransferredGrob,
    decodeHpTransferredString,
    encodeData,
    encodeDataChunks,
    isHpLegacySerialPort,
    isHpLegacyUsbDevice,
    makePacket,
    makeHpTemporaryName,
    parameterRequest,
    parseHpModelVersion,
    parseHpRdir,
    parsePacket
};

if (typeof module === 'object' && module.exports) module.exports = api;
if (scope) scope.WebTILPHPLegacy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
