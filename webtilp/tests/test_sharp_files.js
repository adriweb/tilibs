'use strict';
const assert = require('node:assert/strict');
const codec = require('../sharp_files.js');
const native = require('../sharp_backend.js');
const bytes = hex => Uint8Array.from(Buffer.from(hex.replace(/\s/g, ''), 'hex'));
const join = (...parts) => Uint8Array.from(parts.flatMap(part => Array.from(part)));
const header = (ext, selector = [0x10, 0x08]) => native.nativeHeader(ext, Uint8Array.from(selector));
const number = (digits, exponent = 0, negative = false) => {
    if (exponent < 0) exponent += 1000;
    return bytes(String(exponent).padStart(3, '0') + (negative ? '1' : '0') + digits.padEnd(14, '0'));
};
// Official HERON_4.g4p body (Sharp's sample): all 75 bytes, including its
// unclosed quotes and trailing empty lines. This is an external format oracle.
const heron = bytes(`0a76260a774c454e475448fd0a7741fd0a7742fd0a7743fd
2a41724272432b71327c44fd812a442a4473412b2a4473422b2a4473432b2b7c53fd
0a76265360fd0a7653fd0a10fdfdfdfdff`);
const heronSource = 'Print "Input LENGTH\nInput A\nInput B\nInput C\n(A+B+C)/2→D\n√(D(D-A)(D-B)(D-C))→S\nPrint "S=\nPrint S\nEnd\n\n\n\n';
assert.equal(codec.detokenize(heron), heronSource);
assert.deepEqual(codec.tokenize(heronSource), heron);
assert.deepEqual(codec.tokenize('1@sto@A\r\n@root@(A)'), codec.tokenize('1→A\n√(A)'));
assert.deepEqual(codec.tokenize('1->A\nsqrt(A)'), codec.tokenize('1→A\n√(A)'));
assert.notDeepEqual(codec.tokenize('sin A'), codec.tokenize('SIN A'));
// Every wire token, reserved bytes, ambiguous aliases and letter/keyword
// boundaries survive detokenization. Escapes are deliberately reversible.
for (let first = 0; first < 255; first++) {
    const codes = first >= 5 && first <= 15 ? Array.from({ length: 256 }, (_, n) => [first, n]) : [[first]];
    for (const code of codes) {
        const data = Uint8Array.from([...code, 255]);
        assert.deepEqual(codec.tokenize(codec.detokenize(data)), data, Buffer.from(data).toString('hex'));
    }
}
for (const data of [bytes('414e53ff'), bytes('6141ff'), bytes('5052494e542041ff')]) {
    assert.deepEqual(codec.tokenize(codec.detokenize(data)), data);
}
assert.throws(() => codec.tokenize('🙂'), /Unsupported/);
assert.throws(() => codec.tokenize('A'.repeat(161)), /160/);
assert.throws(() => codec.tokenize('\\x{FF}A'), /terminator/);
assert.throws(() => codec.detokenize(bytes('4142')), /terminator/);
assert.throws(() => codec.detokenize(bytes('41ff42ff')), /terminator/);
assert.throws(() => codec.tokenize('\\x{FF41}'), /prefix/);
assert.throws(() => codec.programFile('End', 'TOOLONGGG'), /names/);
const program = codec.programFile(heronSource, 'HERON');
assert.deepEqual(program.subarray(54), heron);
assert.deepEqual(codec.programFile('End', 'TEST').subarray(54), bytes('0a10fdff'));
assert.equal(native.decodeNative(program, 'HERON.g4p').category.ext, 'p');
// Independently construct the official group's two-byte header and records:
// total size32 + filename260 + unmodified native file; zeroed record ends it.
function group(members) {
    return join([52, 103], ...members.map(([name, data]) => {
        const record = new Uint8Array(264 + data.length);
        new DataView(record.buffer).setUint32(0, record.length, true);
        record.set(new TextEncoder().encode(name), 4); record.set(data, 264); return record;
    }), new Uint8Array(264));
}
const grouped = group([['HERON.g4p', program]]);
assert.deepEqual(codec.decodeGroup(grouped)[0].data, program);
assert.equal(codec.previewFile(grouped).value.files[0].code, heronSource);
assert.throws(() => codec.decodeGroup(grouped.slice(0, -1)), /Truncated/);
const badLength = grouped.slice(); new DataView(badLength.buffer).setUint32(2, 0xFFFFFFFF, true);
assert.throws(() => codec.decodeGroup(badLength), /length/);
assert.throws(() => codec.decodeGroup(group([['../HERON.g4p', program]])), /name/);
assert.throws(() => codec.decodeGroup(group([['nested.g4g', grouped]])), /type/);
assert.throws(() => codec.decodeGroup(group([['backup.g4b', new Uint8Array(54)]])), /type/);
// Asymmetric pixel fixtures verify the PC-Link PICT page/bit orientation,
// alpha compositing and 127-column stride, independently of a round trip.
const rgba = new Uint8ClampedArray(127 * 64 * 4).fill(255);
function pixel(x, y, r, g = r, b = r, a = 255) { rgba.set([r, g, b, a], (y * 127 + x) * 4); }
pixel(0, 0, 0); pixel(126, 7, 0); pixel(1, 8, 0); pixel(125, 63, 0); pixel(2, 2, 0, 0, 0, 0);
const picture = codec.pictureFile(rgba, 0);
assert.equal(picture.length, 1073);
assert.deepEqual(picture.subarray(54, 57), bytes('190d00'));
assert.equal(picture[57], 1); assert.equal(picture[57 + 126], 128);
assert.equal(picture[57 + 127 + 1], 1); assert.equal(picture[57 + 7 * 127 + 125], 128);
assert.equal(picture[57 + 2], 0, 'transparent pixels composite on white');
assert.deepEqual(codec.decodePicture(picture).rgba.slice(0, 4), Uint8ClampedArray.from([0, 0, 0, 255]));
assert.deepEqual(codec.pictureFile(codec.decodePicture(picture).rgba, 0), picture);
assert.throws(() => codec.pictureFile(rgba, 10), /slot/);
assert.throws(() => codec.decodePicture(picture.slice(0, -1)), /layout/);
assert.equal(codec.previewFile(picture).image.width, 127);
// BCD numbers stay decimal strings to preserve all fourteen significant digits.
assert.equal(codec.decodeNumber(number('12345678901234', -9, true)), '-1.2345678901234e-9');
assert.equal(codec.decodeNumber(number('0')), '0');
assert.throws(() => codec.decodeNumber(bytes('0a0000000000000000')), /encoding/);
const variables = join(header('v', new Uint8Array(11)), number('123'), number('0'), new Uint8Array(468));
assert.equal(codec.previewFile(variables).value.A.real, '1.23');
assert.equal(Object.keys(codec.previewFile(variables).value).length, 27);
// Official matrix serializer stores columns consecutively. Two rows, three columns.
const matrix = join(header('m', [0x10, 9]), [0x10, 9, 0, 3, 0, 2, 0], ...['1', '2', '3', '4', '5', '6'].map(x => number(x)));
assert.deepEqual(codec.previewFile(matrix).value.values, [['1', '3', '5'], ['2', '4', '6']]);
const list = join(header('l'), [0x10, 8, 0, 2, 0, 1, 0], number('3'), number('4'));
assert.deepEqual(codec.previewFile(list).value.values, ['3', '4']);
assert.throws(() => codec.previewFile(list.slice(0, -1)), /length/);
console.log('Sharp token round trips, official Heron fixture, groups, BCD variables/lists/matrices and picture layout passed');
