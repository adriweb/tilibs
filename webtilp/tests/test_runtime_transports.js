'use strict';

const assert = require('node:assert/strict');
const { closeTISerialTransport } = require('../runtime/transports.js');

function deferred() {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return { promise, resolve };
}

async function main() {
    for (const rejects of [false, true]) {
        const events = [];
        const serial = {
            kind: 2, running: true, queue: [1], queuedBytes: 7,
            waiters: [() => { events.push('wake read'); assert.equal(serial.running, false); assert.ok(serial.error); }],
            reader: {
                async cancel() { events.push('cancel'); if (rejects) throw new Error('disconnected reader'); },
                releaseLock() { events.push('release reader'); }
            },
            writer: {
                async abort() { events.push('abort'); if (rejects) throw new Error('disconnected writer'); },
                releaseLock() { events.push('release writer'); }
            },
            port: { readable: {}, async close() { events.push('close port'); } }
        };
        const module = { __ticablesWebSerial: serial,
            ccall() { assert.fail('closing serial streams must never enter suspended WASM'); } };
        await closeTISerialTransport(module);
        assert.deepEqual(events, ['wake read', 'cancel', 'abort', 'release reader', 'release writer', 'close port']);
        assert.equal(serial.reader, null);
        assert.equal(serial.writer, null);
        assert.equal(serial.port, null);
        assert.equal(serial.kind, 0);
        assert.deepEqual(serial.waiters, []);
        assert.deepEqual(serial.queue, []);
        assert.equal(serial.queuedBytes, 0);
    }
    const cancellation = deferred();
    const events = [];
    const serial = { reader: { cancel() { return cancellation.promise; }, releaseLock() { events.push('release reader'); } },
        port: { writable: {}, async close() { events.push('close port'); } } };
    let timer;
    const closing = closeTISerialTransport({ __ticablesWebSerial: serial }, {
        setTimer(callback) { timer = callback; }, clearTimer() {}
    });
    const timedOut = assert.rejects(closing, /timed out/);
    timer();
    await timedOut;
    assert.equal(serial.running, false, 'browser timeout does not keep the read pump running');
    cancellation.resolve();
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    assert.deepEqual(events, ['release reader', 'close port'], 'late cancellation still releases browser resources');
    await closeTISerialTransport({});
    console.log('Browser transport retirement tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
