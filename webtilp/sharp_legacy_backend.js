/* Sharp CE-LK1P data protocol: EL-9400/9450/9600/9650.
 * Static PC-LINK evidence and hardware-validation scope: docs/SHARP_PROTOCOL.md.
 * Receive stages are framing states, not opcodes to prepend to data records.
 */
(function (scope) {
'use strict';
const shared = typeof module === 'object' && module.exports ? require('./sharp_backend.js') : scope.WebTILPSharp;
const { SharpBackend, decodeScreenshot } = shared;
const CATEGORIES = Object.freeze([
    Object.freeze({ name: 'SOLVE EQU', ext: 'e', dynamic: true }),
    Object.freeze({ name: 'PROGRAM', ext: 'p', dynamic: true }),
    Object.freeze({ name: 'ANIME', ext: 's', dynamic: true })
]);
const ascii = value => Uint8Array.from(value, character => character.charCodeAt(0));
const text = data => Array.from(data, byte => String.fromCharCode(byte)).join('');
const concat = (...arrays) => {
    const result = new Uint8Array(arrays.reduce((length, part) => length + part.length, 0));
    let offset = 0;
    for (const part of arrays) { result.set(part, offset); offset += part.length; }
    return result;
};
const categoryBytes = category => ascii(category.name.padEnd(11, ' '));
const word = value => Uint8Array.of(value & 255, value >>> 8);
const readWord = (data, offset = 0) => data[offset] | data[offset + 1] << 8;
const equal = (first, second) => first.length === second.length && first.every((byte, i) => byte === second[i]);
const nameKey = selector => text(selector).replace(/\0.*$/, '').trimEnd().toUpperCase();
function unsupported(operation) {
    const error = new Error(operation + ' is not supported for Sharp CE-LK1P models.');
    error.code = 'SHARP_UNSUPPORTED_OPERATION'; return error;
}
function nativeHeader(profile, category, selector) {
    const header = new Uint8Array(54);
    header[0] = 48 + profile.fileFamily; header[1] = category.ext.toUpperCase().charCodeAt(0);
    header.set(selector, 2); return header;
}

class SharpLegacyBackend extends SharpBackend {
    constructor(options) {
        super(options);
        if (this.profile.family !== 'celk1') throw new Error('Select an EL-9400, EL-9450, EL-9600 or EL-9650 model.');
        this.capabilities = Object.freeze({ screen: true, directory: true, receive: true,
            send: true, backup: false, dump: false, version: false, sourceConversion: false });
    }
    async connect(options = {}) {
        for (const [key, value] of Object.entries(this.profile.serialOptions)) {
            if (key in options && options[key] !== value) throw new Error('CE-LK1P requires 9600 baud, 8E1 and hardware flow control.');
        }
        await super.connect({ ...options, ...this.profile.serialOptions });
        try {
            // Hardware flow control owns RTS. WebSerial can assert DTR without
            // overriding the driver's automatic RTS/CTS handling.
            await this.port.setSignals?.({ dataTerminalReady: true });
        } catch (error) { await this.close().catch(() => {}); throw error; }
    }
    async readVersion() {
        // CE-LK1P identifies the selected profile in its ACK; a firmware-version
        // command has not been established for these models. Do not send 74.
        return this.operation(async () => { await this.command(0x42); return null; }, { session: false });
    }
    async captureScreenshot() {
        return this.operation(async () => {
            await this.command(0x42); await this.command(0x63);
            await this.expectCommand(0x23); await this.ack();
            // These four bytes are opaque metadata, not width/height or opcodes.
            this.screenMetadata = await this.receive(4); await this.ack();
            const { width, height } = this.profile;
            const data = await this.receivePayload(width * height / 8); await this.ack();
            return decodeScreenshot(data, width, height);
        }, { session: false });
    }
    async readDirectory(category) {
        if (!CATEGORIES.includes(category)) throw new Error('Unknown CE-LK1P directory category.');
        await this.command(0x61); await this.send(categoryBytes(category));
        await this.expectCommand(0x21); await this.ack();
        const echoed = await this.receive(11);
        if (!equal(echoed, categoryBytes(category))) throw new Error('Sharp directory category mismatch.');
        await this.ack();
        const directory = await this.receive(1, prefix => prefix[0] * 11);
        await this.ack(); return directory;
    }
    async listVariables() {
        return this.operation(async () => {
            const entries = [];
            for (const category of CATEGORIES) {
                const directory = await this.readDirectory(category);
                for (let i = 0; i < directory[0]; i++) {
                    const selector = directory.slice(1 + i * 11, 12 + i * 11);
                    const name = text(selector).replace(/[\0 ]+$/, '') || category.name + ' ' + (i + 1);
                    entries.push({ kind: 'sharp', name, type_name: category.name, category, selector,
                        size: 0, type: category.ext.charCodeAt(0), folder: '', attr: 0 });
                }
            }
            return entries;
        }, { session: false });
    }
    async readObject(category, selector) {
        if (!CATEGORIES.includes(category) || selector?.length !== 11) throw new Error('Refresh the Sharp directory before receiving this entry.');
        await this.command(0x62); await this.send(categoryBytes(category));
        await this.send(selector); await this.expectCommand(0x22); await this.ack();
        const metadata = await this.receive(13);
        if (!equal(metadata.subarray(0, 11), categoryBytes(category))) throw new Error('Sharp variable category mismatch.');
        await this.ack();
        // Phase 15 has a uint16 length including its four internal header
        // bytes and, for these named categories, the full eleven-byte selector.
        let objectLength = 0;
        const object = await this.receive(2, prefix => {
            const length = readWord(prefix);
            if (length < 15) throw new Error('Invalid Sharp object length.');
            objectLength = length;
            return length - 2;
        }, this.timeoutMs, completed => this.onProgress({
            completed: objectLength ? Math.min(completed, objectLength - 1) : 0, total: objectLength || null
        }));
        if (!equal(object.subarray(4, 15), selector)) throw new Error('Sharp variable name mismatch.');
        const useful = object.slice(15);
        if (category.ext === 'p' && !useful.length) throw new Error('Invalid Sharp program object length.');
        await this.ack();
        this.onProgress({ completed: object.length, total: object.length });
        return useful;
    }
    async receiveVariable(entry) {
        return this.operation(async () => {
            const useful = await this.readObject(entry.category, entry.selector);
            // PC-LINK's program writer omits the leading program flag. Other
            // named types retain the entire extracted body (40E8B0–40E9AF).
            const payload = entry.category.ext === 'p' ? useful.subarray(1) : useful;
            const name = entry.name.replace(/[\x00-\x1F\\/:*?"<>|]/g, '_').replace(/[. ]+$/, '') || 'OBJECT';
            return { filename: `${name}.g${this.profile.fileFamily}${entry.category.ext}`,
                data: concat(nativeHeader(this.profile, entry.category, entry.selector), payload) };
        }, { session: false });
    }
    decodeFile(input, filename = '') {
        const data = new Uint8Array(input);
        const extension = '.g' + this.profile.fileFamily + 'p';
        if (data.length < 54 || data[53] !== 0 || data[0] !== 48 + this.profile.fileFamily
            || String.fromCharCode(data[1]).toLowerCase() !== 'p'
            || filename && !filename.toLowerCase().endsWith(extension)) {
            throw new Error('Only native ' + extension + ' programs for the selected Sharp model are supported; file families are not interchangeable.');
        }
        const selector = data.slice(2, 13);
        if (!selector.some(byte => byte !== 0 && byte !== 32)) throw new Error('Empty Sharp program name.');
        const length = data.length - 54 + 16;
        if (length > 0xFFFF) throw new Error('Sharp program exceeds the CE-LK1P uint16 object length.');
        // PC-LINK 40E9C0/402670: size16, 30 00, name11, flag00, native payload.
        return { category: CATEGORIES[1], selector,
            object: concat(word(length), Uint8Array.of(0x30, 0), selector, Uint8Array.of(0), data.subarray(54)) };
    }
    async sendFile(data, filename) {
        const file = this.decodeFile(data, filename); // Validate the whole file before I/O.
        return this.operation(async () => {
            const directory = await this.readDirectory(file.category);
            for (let i = 0; i < directory[0]; i++) {
                if (nameKey(directory.subarray(1 + i * 11, 12 + i * 11)) === nameKey(file.selector)) {
                    throw new Error('A Sharp program with this name already exists. Rename the incoming object before sending.');
                }
            }
            await this.command(0x22);
            await this.send(concat(categoryBytes(file.category), word(file.object.length)));
            await this.send(file.object, { progress: true });
        }, { session: false });
    }
    async receiveBackup() { throw unsupported('RAM backup'); }
    async receiveDump() { throw unsupported('OS/boot reception'); }
    async configureSerial() { throw unsupported('Baud-rate switching'); }
    async reopen() { throw unsupported('Baud-rate switching'); }
}

shared.SharpLegacyBackend = SharpLegacyBackend;
const api = { SharpLegacyBackend, CATEGORIES };
scope.WebTILPSharpLegacy = api;
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
