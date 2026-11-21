'use strict';
const assert = require('node:assert/strict');
const { decodeState, decodeProgram, exchangePreviewKind } = require('../zero_preview.js');

function u32(value) {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32LE(value);
    return bytes;
}

function string(value) {
    const bytes = Buffer.from(value);
    return Buffer.concat([u32(bytes.length), bytes]);
}

function number(real, imaginary = '0') {
    return Buffer.concat([string(real), string(imaginary), Buffer.of(0)]);
}

function container(count, ...entries) {
    return Buffer.concat([u32(50), u32(count), ...entries]);
}

const precisions = ['123456789012345678901234567890.0123456', '1.024'];
const variables = container(3, string('A'), u32(4), number(precisions[0]),
    string('B'), u32(4), number('2', '-3'),
    string('Ans'), u32(32), u32(1), u32(2), number('0', '-1'), number('2', '-3'),
    u32(0), string('HELLO'), Buffer.alloc(8 * 4));
assert.deepEqual(decodeState('/vars.sav', variables).map(({ name, type, text }) => [name, type, text]), [
    ['A', 'number', precisions[0]], ['B', 'number', '2 − 3i'],
    ['Ans', 'matrix', '[[-i, 2 − 3i]]'], ['Str1', 'string', 'HELLO']
]);

const lists = container(3, string([0xa6, 0xc1]), u32(2), number('1'), number('0', '3'),
    string([0xa6, 0xc2]), u32(0), string([0xa6, 0x41, 0x42]), u32(1), number('2.5'));
assert.deepEqual(decodeState('/lists.sav', lists).map(({ name, text }) => [name, text]), [
    ['L1', '{1, 3i}'], ['ʟAB', '{2.5}']
]);

const matrices = container(2, string('[A]'), u32(2), u32(3),
    number('1'), number('2'), number('3'), number('4'), number('5'), number(precisions[1]),
    string('[B]'), u32(0), u32(0));
assert.deepEqual(decodeState('/matrixes', matrices).map(({ name, text }) => [name, text]), [
    ['[A]', '[[1, 2, 3],\n [4, 5, 1.024]]']
]);

function equation(expr, tree) {
    return Buffer.concat([string(expr), Buffer.alloc(14), string(tree)]);
}
const equations = Buffer.concat([u32(50), equation('sin(X', [0, 1, 2, 3]), equation('X^(2)', [0, 1]),
    ...Array.from({ length: 38 }, () => Buffer.alloc(22)), u32(0)]);
assert.deepEqual(decodeState('~yfunc.sav', equations).map(({ name, text }) => [name, text]), [
    ['Y1', 'sin(X'], ['Y2', 'X^(2)']
]);

assert.throws(() => decodeState('/vars.sav', Buffer.from([49, 0, 0, 0])), /version/);
assert.throws(() => decodeState('/lists.sav', lists.subarray(0, -1)), /Truncated|Invalid/);
assert.throws(() => decodeState('/matrixes', container(1, string('[A]'), u32(0xffffffff), u32(200))), /dimensions/);
assert.throws(() => decodeState('~yfunc.sav', equations.subarray(0, 80)), /Truncated/);

assert.equal(exchangePreviewKind({ name: 'ABC.ZCB', size: 8 }), 'zerobasic');
assert.equal(exchangePreviewKind({ name: 'script.py', size: 10 }), 'python');
assert.equal(exchangePreviewKind({ name: 'FIRMWARE.BAK', size: 9 }), '');
assert.equal(exchangePreviewKind({ name: 'giant.zcb', size: 32 * 1024 * 1024 }), '');
assert.equal(decodeProgram('zerobasic', Buffer.from([0x58, 0xbd, 0xa8, 0x59, 10, 0xd2, 0x9d, 0xc2])), 'X²→Y\nπ∕₂');
assert.equal(decodeProgram('zerobasic', Buffer.from([0x85, 0xff])), '⁵\\xff');
assert.equal(decodeProgram('python', Buffer.from('print("π")')), 'print("π")');
console.log('Zero variable containers and program preview codecs passed');
