'use strict';

/**
 * Releases the browser streams owned by ticables' EM_ASYNC_JS WebSerial
 * transport without entering a module that may still be suspended in Asyncify.
 */
async function closeTISerialTransport(module, {
    timeoutMs = 500,
    setTimer = setTimeout,
    clearTimer = clearTimeout
} = {}) {
    const serial = module?.__ticablesWebSerial;
    if (!serial) return;
    const reader = serial.reader;
    const writer = serial.writer;
    const port = serial.port;
    serial.running = false;
    serial.error = new Error('Calculator serial transport was reset.');
    serial.queue = [];
    serial.queuedBytes = 0;
    const waiters = Array.isArray(serial.waiters) ? serial.waiters.splice(0) : [];
    for (const notify of waiters) {
        try { notify(); } catch {}
    }

    // Cancellation may finish after the browser stops responding. Keep late
    // cleanup attached to its promises so locks are released when it resumes.
    const stopping = Promise.allSettled([
        Promise.resolve().then(() => reader?.cancel()),
        Promise.resolve().then(() => writer?.abort())
    ]).then(async () => {
        try { reader?.releaseLock(); } catch {}
        try { writer?.releaseLock(); } catch {}
        if (serial.reader === reader) serial.reader = null;
        if (serial.writer === writer) serial.writer = null;
        try {
            if (port?.readable || port?.writable) await port.close();
        } finally {
            if (serial.port === port) serial.port = null;
            serial.kind = 0;
        }
    });
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimer(() => reject(new Error('Closing calculator serial transport timed out')), timeoutMs);
    });
    try { await Promise.race([stopping, timeout]); }
    finally { clearTimer(timer); }
}

module.exports = { closeTISerialTransport };
