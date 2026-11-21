'use strict';

(function (scope) {
    const USB_VENDOR_ID = 0x0483;
    const USB_PRODUCT_ID = 0x5740;
    const USB_FILTER = { vendorId: USB_VENDOR_ID, productId: USB_PRODUCT_ID };
    const SERIAL_FILTER = { usbVendorId: USB_VENDOR_ID, usbProductId: USB_PRODUCT_ID };
    const PREAMBLE = Uint8Array.of(0x43, 0x41, 0x4c, 0x43); // CALC
    const MAX_PAYLOAD = 0xffff;
    const MAX_FILE_SIZE = 32 * 1024 * 1024;
    const MAX_FILE_COUNT = 16384;
    const IO_TIMEOUT = 10000;
    const VARIABLE_STATE_PATHS = new Set(['/vars.sav', '/lists.sav', '/matrixes', '~yfunc.sav']);
    const textEncoder = new TextEncoder();
    const textDecoder = new TextDecoder('utf-8', { fatal: true });
    const COMMAND = {
        GET_DEVICE_INFO: 1, GET_FILES_COUNT: 2, GET_FILES_INFO: 3, GET_FILE: 4,
        SEND_FILE: 5, DELETE_FILE: 6, DEVICE_INFO: 8, FILES_COUNT: 9, FILE_INFO: 10,
        SUCCESS: 11, FAILED: 12, FRAME: 13, GET_BACKUP_INFO: 14
    };

    function matchesUsbDevice(device) {
        return device?.vendorId === USB_VENDOR_ID && device?.productId === USB_PRODUCT_ID;
    }

    function matchesSerialPort(info) {
        return info?.usbVendorId === USB_VENDOR_ID && info?.usbProductId === USB_PRODUCT_ID;
    }

    function concat(...parts) {
        const bytes = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
        let offset = 0;
        for (const part of parts) {
            bytes.set(part, offset);
            offset += part.length;
        }
        return bytes;
    }

    function varint(value) {
        const bytes = [];
        while (value >= 128) {
            bytes.push((value % 128) | 128);
            value = Math.floor(value / 128);
        }
        bytes.push(value);
        return bytes;
    }

    function intField(number, value) {
        return value ? Uint8Array.of(number << 3, ...varint(value)) : new Uint8Array();
    }

    function bytesField(number, value) {
        return concat(Uint8Array.of((number << 3) | 2, ...varint(value.length)), value);
    }

    function fileField({ name, size }) {
        return bytesField(3, concat(bytesField(2, textEncoder.encode(name)), intField(3, size)));
    }

    // The link uses a subset of proto3. Skip unknown scalar and length-delimited fields.
    function decodeFields(bytes, schema) {
        const result = {};
        let offset = 0;
        function readVarint() {
            let value = 0;
            for (let index = 0; index < 10 && offset < bytes.length; index++) {
                const byte = bytes[offset++];
                value += (byte & 127) * 2 ** (index * 7);
                if (byte < 128 && (index < 9 || byte <= 1)) return value;
            }
            throw new Error('Invalid Zero protobuf varint.');
        }
        while (offset < bytes.length) {
            const tag = readVarint();
            if (tag < 8 || tag > 0xffffffff) throw new Error('Invalid Zero protobuf tag.');
            const descriptor = Object.hasOwn(schema, tag >>> 3) ? schema[tag >>> 3] : null;
            const wireType = tag & 7;
            if (descriptor && wireType !== (descriptor[1] === 'int' ? 0 : 2)) {
                throw new Error('Unexpected Zero protobuf field type.');
            }
            let value;
            if (wireType === 0) {
                value = readVarint();
            } else if (wireType === 2) {
                const length = readVarint();
                if (length > bytes.length - offset) throw new Error('Truncated Zero protobuf field.');
                value = bytes.subarray(offset, offset + length);
                offset += length;
            } else if (wireType === 1 || wireType === 5) {
                offset += wireType === 1 ? 8 : 4;
                if (offset > bytes.length) throw new Error('Truncated Zero protobuf field.');
            } else {
                throw new Error('Unknown Zero protobuf wire type.');
            }
            if (!descriptor) continue;
            const [name, type] = descriptor;
            if (type === 'int' && value > 0x7fffffff) throw new Error('Invalid Zero integer field.');
            if (type === 'repeated') {
                (result[name] ??= []).push(value);
            } else {
                result[name] = type === 'text' ? textDecoder.decode(value) : value;
            }
        }
        return result;
    }

    const MESSAGE_FIELDS = {
        1: ['type', 'int'], 2: ['frame', 'bytes'], 3: ['file', 'bytes'],
        4: ['device', 'bytes'], 5: ['count', 'int'], 6: ['error', 'int'],
        8: ['errorNum', 'int'], 9: ['errorText', 'text']
    };
    const FILE_FIELDS = { 2: ['name', 'text'], 3: ['size', 'int'] };
    const DEVICE_FIELDS = {
        1: ['hardwareVersion', 'text'], 2: ['firmwareVersion', 'text'],
        3: ['protocolVersion', 'text'], 4: ['name', 'text'], 5: ['chunkSize', 'int']
    };
    const FRAME_FIELDS = { 1: ['size', 'int'], 2: ['index', 'int'], 3: ['data', 'repeated'] };

    function packet(type, field = new Uint8Array()) {
        const body = concat(intField(1, type), field);
        if (body.length > MAX_PAYLOAD) throw new Error('Zero packet exceeds its 16-bit length.');
        return concat(PREAMBLE, Uint8Array.of(body.length & 255, body.length >> 8), body);
    }

    function validSize(size) {
        return Number.isInteger(size) && size >= 0 && size <= MAX_FILE_SIZE;
    }

    function validEntry({ name, size }) {
        return typeof name === 'string' && name !== '.' && name !== '..'
            && /^[^/\\\u0000-\u001f\u007f]{1,255}$/.test(name)
            && validSize(size);
    }

    function uploadName(name) {
        if (!/^[A-Z0-9_!#$%&'()@^`{}~-]{1,14}(?:\.[A-Z0-9_!#$%&'()@^`{}~-]{1,3})?$/i.test(name)) {
            throw new Error('Zero upload filenames must use ASCII characters with a 14-character base and a three-character extension at most.');
        }
        return name.toUpperCase();
    }

    class ZeroBackend {
        constructor(port, { timeoutMs = IO_TIMEOUT } = {}) {
            this.port = port;
            this.timeoutMs = timeoutMs;
            this.buffer = new Uint8Array();
            this.info = null;
            this.opened = false;
            this.busy = false;
        }

        async connect() {
            try {
                // ZeroConnect leaves QSerialPort at its default 9600 8N1.
                await this.port.open({ baudRate: 9600 });
                this.opened = true;
                this.reader = this.port.readable.getReader();
                this.writer = this.port.writable.getWriter();
                return await this.getInfo();
            } catch (error) {
                await this.close().catch(() => {});
                throw error;
            }
        }

        close() {
            if (this.closing) return this.closing;
            if (!this.opened) return Promise.resolve();
            this.opened = false;
            this.closing = this.closeStreams();
            return this.closing;
        }

        async closeStreams() {
            await Promise.allSettled([this.reader?.cancel(), this.writer?.abort()]);
            this.reader?.releaseLock();
            this.writer?.releaseLock();
            this.buffer = new Uint8Array();
            await this.port.close();
        }

        async withDeadline(promise, label) {
            let timer;
            try {
                return await Promise.race([
                    promise,
                    new Promise((_, reject) => {
                        timer = setTimeout(() => reject(new Error(`Zero ${label} timed out. Reconnect the calculator.`)), this.timeoutMs);
                    })
                ]);
            } finally {
                clearTimeout(timer);
            }
        }

        async send(type, field) {
            await this.withDeadline(this.writer.write(packet(type, field)), 'write');
        }

        async receive(expected) {
            const read = async () => {
                while (this.opened) {
                    const start = this.buffer.findIndex((byte, offset) =>
                        byte === PREAMBLE[0] && PREAMBLE.every((part, i) => this.buffer[offset + i] === part));
                    if (start >= 0) {
                        this.buffer = this.buffer.subarray(start);
                        if (this.buffer.length >= 6) {
                            const end = 6 + this.buffer[4] + (this.buffer[5] << 8);
                            if (this.buffer.length >= end) {
                                const message = this.buffer.subarray(6, end);
                                this.buffer = this.buffer.subarray(end);
                                return decodeFields(message, MESSAGE_FIELDS);
                            }
                        }
                    } else {
                        this.buffer = this.buffer.subarray(Math.max(0, this.buffer.length - 3));
                    }
                    const { value, done } = await this.reader.read();
                    if (done) break;
                    this.buffer = concat(this.buffer, value);
                }
                throw new Error('The Zero serial port closed.');
            };
            const message = await this.withDeadline(read(), 'response');
            if (message.type === COMMAND.FAILED) {
                const code = message.errorNum || message.error || 0;
                const detail = message.errorText ? `: ${message.errorText}` : '';
                throw new Error(`Zero rejected the request (${code})${detail}`);
            }
            if (message.type !== expected) {
                throw new Error(`Unexpected Zero response ${message.type ?? 0}, expected ${expected}.`);
            }
            return message;
        }

        async run(operation) {
            if (!this.opened) throw new Error('Reconnect the Zero calculator.');
            if (this.busy) throw new Error('Another Zero transfer is in progress.');
            this.busy = true;
            try {
                return await operation();
            } catch (error) {
                // The link has no transaction IDs or documented resync command.
                await this.close().catch(() => {});
                throw error;
            } finally {
                this.busy = false;
            }
        }

        getInfo() {
            return this.run(async () => {
                await this.send(COMMAND.GET_DEVICE_INFO);
                const { device } = await this.receive(COMMAND.DEVICE_INFO);
                if (!device) throw new Error('Zero device information is missing.');
                const info = decodeFields(device, DEVICE_FIELDS);
                if (!info.firmwareVersion || !info.protocolVersion
                    || !info.chunkSize || info.chunkSize > MAX_PAYLOAD - 32) {
                    throw new Error('Invalid Zero device information.');
                }
                this.info = info;
                return info;
            });
        }

        listFiles() {
            return this.run(async () => {
                await this.send(COMMAND.GET_FILES_COUNT);
                const { count = 0 } = await this.receive(COMMAND.FILES_COUNT);
                if (count > MAX_FILE_COUNT) throw new Error('Invalid Zero file count.');
                await this.send(COMMAND.GET_FILES_INFO);
                const entries = [];
                for (let index = 0; index < count; index++) {
                    const { file } = await this.receive(COMMAND.FILE_INFO);
                    if (!file) throw new Error('Missing Zero file information.');
                    const { name, size = 0 } = decodeFields(file, FILE_FIELDS);
                    const entry = { name, size };
                    if (!validEntry(entry)) throw new Error('Invalid Zero file information.');
                    entries.push(entry);
                    if (index + 1 < count) await this.send(COMMAND.SUCCESS);
                }
                return entries;
            });
        }

        readVariableState() {
            return this.run(async () => {
                await this.send(COMMAND.GET_BACKUP_INFO);
                const entries = new Map();
                for (let index = 0; index < MAX_FILE_COUNT; index++) {
                    const { file } = await this.receive(COMMAND.FILE_INFO);
                    const { name, size = 0 } = file ? decodeFields(file, FILE_FIELDS) : {};
                    if (!name) {
                        const files = new Map();
                        for (const [name, size] of entries) {
                            files.set(name, await this.#readFile({ name, size }, () => {}));
                        }
                        return files;
                    }
                    if (!VARIABLE_STATE_PATHS.has(name)) continue;
                    if (!validSize(size) || entries.has(name)) throw new Error('Invalid Zero backup inventory.');
                    entries.set(name, size);
                }
                throw new Error('Zero backup inventory is too large.');
            });
        }

        download(entry, onProgress = () => {}) {
            if (!validEntry(entry)) throw new Error('Invalid Zero file information.');
            return this.run(() => this.#readFile(entry, onProgress));
        }

        async #readFile(entry, onProgress) {
            const result = new Uint8Array(entry.size);
            if (!result.length) return result;
            await this.send(COMMAND.GET_FILE, fileField(entry));
            for (let offset = 0, index = 0; offset < result.length; index++) {
                const { frame } = await this.receive(COMMAND.FRAME);
                if (!frame) throw new Error('Missing Zero file data.');
                const chunk = decodeFields(frame, FRAME_FIELDS);
                const expected = Math.min(this.info.chunkSize, result.length - offset);
                if ((chunk.index ?? 0) !== index || chunk.size !== expected
                    || chunk.data?.length !== 1 || chunk.data[0].length !== expected) {
                    throw new Error(`Invalid Zero download chunk ${index}.`);
                }
                result.set(chunk.data[0], offset);
                offset += expected;
                if (offset < result.length) await this.send(COMMAND.SUCCESS);
                onProgress(offset, result.length);
            }
            return result;
        }

        upload(name, data, onProgress = () => {}) {
            name = uploadName(name);
            if (!(data instanceof Uint8Array) || !data.length || data.length > MAX_FILE_SIZE) {
                throw new Error('Zero file size is outside the supported range.');
            }
            return this.run(async () => {
                await this.send(COMMAND.SEND_FILE, fileField({ name, size: data.length }));
                await this.receive(COMMAND.SUCCESS);
                for (let offset = 0, index = 0; offset < data.length; index++) {
                    const chunk = data.subarray(offset, offset + this.info.chunkSize);
                    const frame = concat(intField(1, chunk.length), intField(2, index), bytesField(3, chunk));
                    await this.send(COMMAND.FRAME, bytesField(2, frame));
                    await this.receive(COMMAND.SUCCESS);
                    offset += chunk.length;
                    onProgress(offset, data.length);
                }
            });
        }

        delete(entry) {
            if (!validEntry(entry)) throw new Error('Invalid Zero file information.');
            return this.run(async () => {
                await this.send(COMMAND.DELETE_FILE, fileField(entry));
                await this.receive(COMMAND.SUCCESS);
            });
        }
    }

    const api = { ZeroBackend, USB_FILTER, SERIAL_FILTER, MAX_FILE_SIZE, matchesUsbDevice, matchesSerialPort, uploadName };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else scope.WebTILPZero = api;
})(globalThis);
