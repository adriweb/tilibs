'use strict';
const assert = require('node:assert/strict');
const { ZeroBackend, SERIAL_FILTER, matchesSerialPort, uploadName } = require('../zero_backend.js');

const INFO_REQUEST = '43414c4302000801';
// Captured from ZGC4 HW v1, firmware 2.22.0. The wire reports 0.0 and 236-byte chunks.
const INFO = '43414c431c00080822180a03302e301203302e301a03302e30220443414c4328ec01';
const COUNT_REQUEST = '43414c4302000802';
const LIST_REQUEST = '43414c4302000803';
const SUCCESS = '43414c430200080b';
const GET_A = '43414c43090008041a051201411801';
const A_INFO = '43414c430900080a1a051201411801';
const B_INFO = '43414c430700080a1a03120142';
const FRAME_A = '43414c430900080d120508011a01ff';
const PUT_A = '43414c43090008051a051201411801';
const DELETE_A = '43414c43090008061a051201411801';

function serialFixture(script) {
    let incoming;
    const port = {
        closed: false,
        async open(options) {
            assert.deepEqual(options, { baudRate: 9600 });
            this.readable = new ReadableStream({ start(controller) { incoming = controller; } });
            this.writable = new WritableStream({
                write(data) {
                    assert.ok(script.length, 'unexpected serial write');
                    const [expected, ...responses] = script.shift();
                    assert.equal(Buffer.from(data).toString('hex'), expected);
                    for (const response of responses) incoming.enqueue(Buffer.from(response, 'hex'));
                }
            });
        },
        async close() {
            assert.equal(this.readable.locked, false);
            assert.equal(this.writable.locked, false);
            this.closed = true;
        }
    };
    return { port, backend: new ZeroBackend(port, { timeoutMs: 50 }) };
}

async function main() {
    assert.equal(matchesSerialPort(SERIAL_FILTER), true);
    assert.equal(matchesSerialPort({ ...SERIAL_FILTER, usbProductId: 0x5741 }), false);
    assert.equal(uploadName('fourteen_chars.py'), 'FOURTEEN_CHARS.PY');
    for (const name of ['../a', 'a/b', 'with spaces.py', 'fifteen_chars_a.py', 'A.test']) {
        assert.throws(() => uploadName(name), /filename/);
    }
    const script = [
        [INFO_REQUEST, '134343414c', INFO.slice(6, 14), INFO.slice(14)],
        [COUNT_REQUEST, '43414c43040008092802'],
        [LIST_REQUEST, A_INFO],
        [SUCCESS, B_INFO],
        [GET_A, FRAME_A],
        [PUT_A, SUCCESS],
        [FRAME_A, SUCCESS],
        [DELETE_A, SUCCESS],
        [COUNT_REQUEST, '43414c4302000809'],
        [LIST_REQUEST]
    ];
    const { port, backend } = serialFixture(script);
    assert.deepEqual(await backend.connect(), {
        hardwareVersion: '0.0', firmwareVersion: '0.0', protocolVersion: '0.0',
        name: 'CALC', chunkSize: 236
    });
    const [a, b] = await backend.listFiles();
    assert.deepEqual([a, b], [{ name: 'A', size: 1 }, { name: 'B', size: 0 }]);
    assert.deepEqual(await backend.download(a), Uint8Array.of(255));
    assert.deepEqual(await backend.download(b), new Uint8Array());
    await backend.upload('a', Uint8Array.of(255));
    await backend.delete(a);
    assert.deepEqual(await backend.listFiles(), []);
    assert.equal(script.length, 0);
    await backend.close();
    assert.ok(port.closed);

    const backup = serialFixture([
        [INFO_REQUEST, INFO],
        ['43414c430200080e',
            '43414c431100080a1a0d12092f766172732e7361761801',
            '43414c431e00080a1a1a12162f65786368616e67652f4649524d574152452e42414b1801',
            '43414c430400080a1a00'],
        ['43414c43110008041a0d12092f766172732e7361761801', FRAME_A]
    ]);
    await backup.backend.connect();
    assert.deepEqual(await backup.backend.readVariableState(), new Map([['/vars.sav', Uint8Array.of(255)]]));
    assert.throws(() => backup.backend.download({ name: '/vars.sav', size: 1 }), /Invalid Zero file information/);
    assert.throws(() => backup.backend.delete({ name: '/vars.sav', size: 1 }), /Invalid Zero file information/);
    await backup.backend.close();

    const badFrame = serialFixture([
        [INFO_REQUEST, INFO],
        [GET_A, '43414c430b00080d1207080110011a01ff']
    ]);
    await badFrame.backend.connect();
    await assert.rejects(badFrame.backend.download(a), /Invalid Zero download chunk 0/);
    assert.ok(badFrame.port.closed);

    const timedOut = serialFixture([[INFO_REQUEST]]);
    await assert.rejects(timedOut.backend.connect(), /response timed out/);
    assert.ok(timedOut.port.closed);
    console.log('Zero WebSerial wire format, file operations, and error cleanup passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
