'use strict';

(function (scope) {
    const STATE_VERSION = 50;
    const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
    const utf8 = new TextDecoder('utf-8', { fatal: true });
    const SPECIAL_GLYPHS = {
        0x7f: '√', 0x8a: '⁻¹', 0x95: '≤', 0x96: '≥', 0x98: '−', 0x99: 'θ',
        0x9a: 'Δ', 0x9d: '∕', 0xa0: '␣', 0xa1: 'ⁿ√', 0xa2: 'Σ',
        0xa3: '↑', 0xa4: '↓', 0xa5: '𝑖', 0xa6: 'ʟ', 0xa8: '→',
        0xa9: 'x̄', 0xaa: 'ȳ', 0xab: 'σ', 0xae: '↑', 0xaf: 'μ',
        0xb1: '≠', 0xb2: 'p̂', 0xb3: 'ρ', 0xb4: 'β', 0xbb: '…',
        0xbc: 'ₜ', 0xbd: '²', 0xbe: 'R', 0xbf: '°', 0xca: 'ʳ',
        0xcb: 'λ', 0xcc: 'τ', 0xcd: '*', 0xce: '+', 0xcf: '∫',
        0xd0: '𝑒', 0xd1: '³', 0xd2: 'π', 0xd3: '″', 0xd4: '⁻¹', 0xd5: '₁₀',
        0xd6: 'ᴇ', 0xd7: '𝑛', 0xd8: 'χ', 0xd9: '𝐹', 0xda: '▶', 0xdb: '𝑛'
    };
    const SUPERSCRIPTS = '⁰¹²³⁴⁵⁶⁷⁸⁹';
    const SUBSCRIPTS = '₀₁₂₃₄₅₆₇₈₉';

    function zeroText(bytes) {
        let text = '';
        for (const byte of bytes) {
            if (byte === 9 || byte === 10 || byte === 13 || (byte >= 0x20 && byte < 0x7f)) {
                text += String.fromCharCode(byte);
            } else if (byte >= 0x80 && byte <= 0x89) {
                text += SUPERSCRIPTS[byte - 0x80];
            } else if (byte >= 0xc0 && byte <= 0xc9) {
                text += SUBSCRIPTS[byte - 0xc0];
            } else {
                text += SPECIAL_GLYPHS[byte] ?? `\\x${byte.toString(16).padStart(2, '0')}`;
            }
        }
        return text;
    }

    class StateReader {
        constructor(bytes) {
            if (bytes.length > MAX_PREVIEW_BYTES) throw new Error('Zero state file is too large to preview.');
            this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            this.bytes = bytes;
            this.offset = 0;
            if (this.uint() !== STATE_VERSION) throw new Error('Unsupported Zero state file version.');
        }

        get remaining() {
            return this.bytes.length - this.offset;
        }

        take(length) {
            if (length > this.remaining) throw new Error('Truncated Zero state record.');
            const start = this.offset;
            this.offset += length;
            return this.bytes.subarray(start, this.offset);
        }

        uint() {
            const start = this.offset;
            this.take(4);
            return this.view.getUint32(start, true);
        }

        string() {
            return this.take(this.uint());
        }

        numeric() {
            const real = zeroText(this.string());
            const imaginary = zeroText(this.string());
            this.take(1); // Numeric metadata byte, independent of the two stored components.
            if (!real || !imaginary) throw new Error('Invalid Zero number.');
            const isZero = text => /^[-+−]?0+(?:\.0*)?(?:e[-+−]?\d+)?$/i.test(text);
            if (isZero(imaginary)) return real;
            const negative = /^[-−]/.test(imaginary);
            const magnitude = imaginary.replace(/^[-+−]/, '');
            const coefficient = magnitude === '1' ? 'i' : `${magnitude}i`;
            if (isZero(real)) return negative ? `-${coefficient}` : coefficient;
            return `${real} ${negative ? '−' : '+'} ${coefficient}`;
        }

        count(minSize) {
            const count = this.uint();
            if (count > this.remaining / minSize) throw new Error('Invalid Zero record count.');
            return count;
        }

        numbers(count) {
            if (count > this.remaining / 9) throw new Error('Invalid Zero array dimensions.');
            return Array.from({ length: count }, () => this.numeric());
        }

        finish() {
            if (this.bytes.subarray(this.offset).some(byte => byte !== 0)) {
                throw new Error('Unexpected data at the end of the Zero state file.');
            }
        }
    }

    function listText(values) {
        return `{${values.join(', ')}}`;
    }

    function readMatrix(reader) {
        const rows = reader.uint();
        const columns = reader.uint();
        if (!rows && !columns) return '';
        if (!rows || !columns) throw new Error('Invalid Zero matrix dimensions.');
        const values = reader.numbers(rows * columns);
        const lines = Array.from({ length: rows }, (_, row) =>
            `[${values.slice(row * columns, (row + 1) * columns).join(', ')}]`);
        return `[${lines.join(',\n ')}]`;
    }

    function readNamedState(reader, path) {
        const records = [];
        const count = reader.count(8);
        for (let index = 0; index < count; index++) {
            const rawName = reader.string();
            if (!rawName.length) throw new Error('Missing Zero variable name.');
            const name = rawName[0] === 0xa6 && rawName.length === 2 && rawName[1] >= 0xc0 && rawName[1] <= 0xc9
                ? `L${rawName[1] - 0xc0}` : zeroText(rawName);
            const start = reader.offset;
            let type;
            let text;
            if (path === '/lists.sav') {
                type = 'list';
                const length = reader.count(9);
                text = length ? listText(reader.numbers(length)) : '';
            } else if (path === '/matrixes') {
                type = 'matrix';
                text = readMatrix(reader);
            } else {
                const valueType = reader.uint();
                if (valueType === 4) {
                    type = 'number';
                    text = reader.numeric();
                } else if (valueType === 16) {
                    type = 'list';
                    text = listText(reader.numbers(reader.count(9)));
                } else if (valueType === 32) {
                    type = 'matrix';
                    text = readMatrix(reader);
                } else {
                    throw new Error(`Unsupported Zero variable type ${valueType}.`);
                }
            }
            if (text) records.push({ name, type, text, size: reader.offset - start });
        }
        if (path === '/vars.sav') {
            // The ten predefined strings follow the named values as length-prefixed slots.
            for (let index = 0; index < 10; index++) {
                const data = reader.string();
                if (data.length) records.push({ name: `Str${index}`, type: 'string', text: zeroText(data), size: data.length });
            }
        }
        return records;
    }

    function readEquations(reader) {
        const records = [];
        // v50 stores ten slots for each mode, including empty entries.
        const extraModes = ['Parametric', 'Polar', 'Sequence'];
        for (let slot = 0; slot < 40; slot++) {
            const raw = reader.string();
            reader.take(14); // Graph style and other settings.
            reader.string(); // Serialized expression tree. The stored expression is sufficient for preview.
            if (!raw.length) continue;
            const index = slot % 10 + 1;
            const text = zeroText(raw);
            const name = slot < 10 ? `Y${index}` : `${extraModes[Math.floor(slot / 10) - 1]} ${index}`;
            records.push({ name, type: 'function', text, size: raw.length });
        }
        return records;
    }

    function decodeState(path, bytes) {
        if (!bytes.length) return [];
        const reader = new StateReader(bytes);
        const records = path === '~yfunc.sav' ? readEquations(reader) : readNamedState(reader, path);
        reader.finish();
        return records;
    }

    function exchangePreviewKind({ name, size }) {
        if (size > MAX_PREVIEW_BYTES) return '';
        if (/\.zcb$/i.test(name)) return 'zerobasic';
        if (/\.py$/i.test(name)) return 'python';
        return '';
    }

    function decodeProgram(kind, bytes) {
        return kind === 'zerobasic' ? zeroText(bytes) : utf8.decode(bytes);
    }

    const api = { decodeState, exchangePreviewKind, decodeProgram };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else scope.WebTILPZeroPreview = api;
})(globalThis);
