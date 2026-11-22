'use strict';

const assert = require('node:assert/strict');
const { USBDevice, harness } = require('./ti_link_harness');

async function wasmHarness(path, model, failReset, productId = 0xe001) {
    const device = new USBDevice();
    device.productId = productId;
    const h = harness(device, true);
    h.device.failReset = failReset;
    const descriptor = [18, 1, 0x10, 1, 0, 0, 0, 8, 0x51, 4, productId & 255, productId >> 8, 0, 1, 1, 2, 3, 1];
    const configuration = [9, 2, 32, 0, 1, 1, 0, 0x80, 50, 9, 4, 0, 0, 2, 0xff, 0, 0, 0,
        7, 5, 0x81, 2, 64, 0, 0, 7, 5, 1, 2, 64, 0, 0];
    h.device.controlTransferIn = async (setup, length) => {
        assert.equal(setup.request, 6);
        let bytes;
        switch (setup.value >> 8) {
        case 1: bytes = descriptor; break;
        case 2: bytes = configuration; break;
        case 3: bytes = (setup.value & 255) === 0 ? [4, 3, 9, 4] : [8, 3, 84, 0, 73, 0, 56, 0]; break;
        default: throw new Error('Unexpected descriptor request');
        }
        return { status: 'ok', data: new DataView(Uint8Array.from(bytes.slice(0, length)).buffer) };
    };
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
        usb: { getDevices: async () => [h.device], addEventListener() {}, removeEventListener() {} }
    } });
    const module = h.state.module = await require(require('node:path').resolve(path))();
    await module.ccall('init', 'number', [], [], { async: true });
    module._set_cable_model(productId === 0xe001 ? 4 : 5); module._set_force_cable(1);
    module._set_calc_model(model); module._set_force_calc(1);
    module.__tiUsbDevice = h.device;
    if (h.transport) h.transport.module = module;
    h.state.handle = await module.ccall('create_handle', 'number', [], [], { async: true });
    assert.ok(h.state.handle);
    assert.equal(await module.ccall('open_cable', 'number', ['number'], [h.state.handle], { async: true }), 0);
    return { ...h, module, writes: h.device.writes };
}

async function testCxIIAlreadyAssociatedWasm(path) {
    const h = await wasmHarness(path, 34, false, 0xe022);
    h.module._set_cable_timeout(10);
    const packet = (service, sequence, payload = []) => {
        const bytes = Buffer.alloc(12 + payload.length);
        bytes.set([0, service, 1, 0xfe]);
        bytes.writeUInt16BE(bytes.length, 6);
        bytes.writeUInt16BE(sequence, 8);
        bytes.set(payload, 12);
        let sum = 0;
        for (let i = 0; i < bytes.length; i += 2) {
            sum += (bytes[i] << 8) | (bytes[i + 1] || 0);
        }
        while (sum > 0xffff) sum = (sum & 0xffff) + (sum >> 16);
        bytes.writeUInt16BE(sum ^ 0xffff, 10);
        return [...bytes];
    };
    let assignments = 0;
    const write = h.device.transferOut.bind(h.device);
    h.device.transferOut = (endpoint, bytes) => {
        const result = write(endpoint, bytes);
        const message = Buffer.from(bytes);
        // An already-associated calculator ignores the two address prompts.
        if (message[1] !== 4) return result;
        const seq = message.readUInt16BE(8);
        const service = message.readUInt16BE(20);
        if (service === 0x4003) {
            assignments++;
            // The ACK arrives on the read started during the silent 300 ms
            // association probe, after the probe's deadline has elapsed.
            setTimeout(() => h.device.feed(packet(0x84, seq)), 20);
        } else if (service === 0x4002) {
            const echo = Buffer.from(message.subarray(12));
            message.copy(echo, 2, 18, 22);
            message.copy(echo, 6, 14, 18);
            echo[15] = echo.subarray(0, 15).reduce((sum, byte) => sum + byte, 0) & 255;
            h.device.feed([...packet(0x84, seq), ...packet(4, 1, echo)]);
        }
        return result;
    };

    assert.equal(await h.module.ccall('is_ready', 'number', ['number'], [h.state.handle], {async: true}), 0);
    assert.equal(assignments, 1, 'the first ACK survives the transition out of the association probe');
    await h.device.close();
    await h.module.ccall('close_cable', 'number', ['number'], [h.state.handle], {async: true});
    console.log('Compiled WASM/libusb CX II accepts the first stream ACK after a silent association probe');
}

async function testDirectLinkWasm(path) {
    const h = await wasmHarness(path, 20, false, 0xe008); // TI-84 Plus CE USB.
    const { module } = h;
    // A complete DUSB buffer allocation, raw ACK and mode-set response.
    const readyReply = [0, 0, 0, 4, 2, 0, 0, 3, 255,
        0, 0, 0, 2, 5, 224, 0,
        0, 0, 0, 10, 4, 0, 0, 0, 4, 0, 18, 0, 0, 7, 208];
    const ready = () => module.ccall('is_ready', 'number', ['number'], [h.state.handle], { async: true });
    h.device.feed(readyReply);
    assert.equal(await ready(), 0);
    for (const timeout of [3, 5]) {
        module._set_cable_timeout(timeout);
        assert.equal(module.__cableTimeoutMs, timeout * 100, 'native setter synchronizes browser deadline');
        const started = Date.now();
        const result = await ready();
        assert.notEqual(result, 0, 'raw ccall returns an error instead of suspending forever');
        // DUSB_MODE_NORMAL advertises 2000 ms, so GREET temporarily raises
        // shorter caller timeouts. ensure_calc_ready then waits 4 * 200 ms
        // between retries after the transport is poisoned.
        const packetTimeoutMs = Math.max(timeout * 100, 2000);
        const elapsed = Date.now() - started;
        assert.ok(elapsed >= packetTimeoutMs, `GREET honors its packet deadline: ${elapsed} ms`);
        assert.ok(elapsed < packetTimeoutMs + 2000,
            `packet deadline plus bounded native retries and scheduling margin: ${elapsed} ms`);
        assert.equal(module.__cableTimeoutMs, timeout * 100, 'GREET restores the caller timeout after failure');
        assert.equal(h.device.waiting.size, 0);
        assert.equal(h.transport.needsRecovery, true);
        await h.context.recoverTiUsbOperation(module, 'is_ready', 'number', result, h.state.handle);
        assert.equal(h.transport.needsRecovery, false);
        assert.equal(await module.ccall('open_cable', 'number', ['number'], [h.state.handle], { async: true }), 0);
        h.device.feed(readyReply);
        assert.equal(await ready(), 0, 'readiness succeeds after native and USB recovery');
    }
    assert.notEqual(await h.context.ccallAsync(module, 'is_ready', 'number', ['number'], [h.state.handle]), 0);
    await h.context.getModuleCallState(module).tail;
    assert.equal(h.transport.needsRecovery, false, 'UI wrapper automatically recovers a failed readiness operation');
    assert.equal(h.context.getModuleCallState(module).dead, false);
    console.log('Compiled WASM/libusb DirectLink deadlines, raw readiness timeout and recovery passed');
}

async function test83PlusWasm(path) {
    const h = await wasmHarness(path, 4, true); // TI-83+, USB reset rejected.
    const { module, writes } = h;
    // Start with a ready calculator, then simulate LinkView's silence.
    h.device.bytes.push(0x73, 0x56, 0, 0);
    assert.equal(await h.context.ccallAsync(module, 'is_ready', 'number', ['number'], [h.state.handle]), 0);
    assert.deepEqual(writes.splice(0), [[0x23, 0x68, 0, 0]], 'explicit Is Ready sends RDC');
    for (const [name, returnType, expectedPacket] of [
        ['calc_get_info_string', 'string', [0x23, 0x2d, 0, 0]],
        ['calc_screenshot', 'number', [0x23, 0x6d, 0, 0]]
    ]) {
        const started = Date.now();
        const result = await h.context.ccallAsync(module, name, returnType, ['number'], [h.state.handle]);
        if (returnType === 'string') assert.equal(result, '');
        else assert.notEqual(result, 0);
        assert.deepEqual(writes.splice(0), [expectedPacket], `${name} sends its request; screenshot skips readiness after failed info`);
        assert.ok(Date.now() - started < 2500, `${name} stops at the SilverLink deadline`);
        assert.equal(h.transport.needsRecovery, false);
        assert.equal(h.context.getModuleCallState(module).dead, false);
        assert.equal(h.device.waiting.size, 0);
    }
    for (const [name, returnType, argTypes, args] of [
        ['calc_get_info_string', 'string', [], []],
        ['calc_send_key', 'number', ['number'], [9]],
        ['calc_recv_backup', 'number', ['string'], ['/blocked.8xb']]
    ]) {
        const result = await h.context.ccallAsync(module, name, returnType,
            ['number', ...argTypes], [h.state.handle, ...args]);
        if (returnType === 'string') assert.equal(result, '');
        else assert.notEqual(result, 0);
        assert.deepEqual(writes.splice(0), [[0x23, 0x68, 0, 0]], `${name} requires readiness after recovery and stops when LinkView does not reply`);
        assert.equal(h.transport.needsRecovery, false);
        assert.equal(h.context.getModuleCallState(module).dead, false);
        assert.equal(h.device.waiting.size, 0);
    }
    assert.equal(module.FS.analyzePath('/blocked.8xb').exists, false, 'failed readiness prevents the backup operation');
    // An acknowledged readiness query lets the actual device-info request run.
    h.device.bytes.push(0x73, 0x56, 0, 0);
    assert.equal(await h.context.ccallAsync(module, 'calc_get_info_string', 'string', ['number'], [h.state.handle]), '');
    assert.deepEqual(writes.splice(0), [[0x23, 0x68, 0, 0], [0x23, 0x2d, 0, 0]], 'device info retains the readiness handshake');
    h.device.bytes.push(0x73, 0x56, 0, 0);
    assert.equal(await h.context.ccallAsync(module, 'is_ready', 'number', ['number'], [h.state.handle]), 0);
    assert.deepEqual(writes, [[0x23, 0x68, 0, 0]], 'explicit Is Ready still sends RDC after recovery');
    console.log('Compiled WASM/libusb TI-83+ screenshot exception, info/transfer readiness gates and recovery passed');
}

async function test89ScreenshotWasm(path) {
    const h = await wasmHarness(path, 8, false); // TI-89 over SilverLink.
    const data = Uint8Array.from({ length: 3840 }, (_, i) => i & 255);
    const checksum = data.reduce((sum, byte) => sum + byte, 0) & 65535;
    for (const badChecksum of [true, false]) {
        h.device.feed([0x98, 0x56, 0, 0, 0x98, 0x15, 0, 15,
            ...data, checksum & 255, (checksum >> 8) ^ (badChecksum ? 1 : 0)]);
        assert.equal(await h.context.ccallAsync(h.module, 'calc_screenshot', 'number',
            ['number'], [h.state.handle]), 0, 'TI-89 screenshot accepts its unreliable checksum');
        assert.deepEqual(h.writes.splice(0), [[8, 0x6d, 0, 0], [8, 0x56, 0, 0]],
            'screenshot finishes with ACK and no checksum-abort or cable recovery');
        const file = Buffer.from(h.module.FS.readFile('/screenshot.bin'));
        assert.equal(file.readUInt32LE(0), 160);
        assert.equal(file.readUInt32LE(4), 100);
        assert.equal(file.length, 8 + 160 * 100 * 3);
        for (let y = 0; y < 100; y++) {
            for (let x = 0; x < 160; x++) {
                const value = data[y * 30 + (x >> 3)] & (128 >> (x & 7)) ? 0 : 255;
                const offset = 8 + (y * 160 + x) * 3;
                assert.deepEqual([...file.subarray(offset, offset + 3)], [value, value, value]);
            }
        }
        assert.equal(h.transport.needsRecovery, false);
        assert.equal(h.device.bytes.length, 0);
    }
    console.log('Compiled WASM/libusb TI-89 screenshot checksum compatibility, ACK and RGB cropping passed');
}

async function test89FlashWaitWasm(path) {
    const h = await wasmHarness(path, 8, false);
    h.module._set_cable_timeout(600); // The frontend's OS-entry timeout.
    assert.equal(h.module.__configuredCableTimeoutMs, 60000);
    const data = Buffer.alloc(128, 0x5a);
    data[0] = 0x80;
    const image = Buffer.alloc(78 + data.length);
    image.write('**TIFL**');
    image[8] = 2; image[12] = 0x28; image[13] = 3;
    image.writeUInt16LE(0x0320, 14);
    image[16] = 8; image.write('basecode', 17);
    image[48] = 0x98; image[49] = 0x23; image[73] = 3;
    image.writeUInt32LE(data.length, 74);
    data.copy(image, 78);
    h.module.FS.writeFile('/flash-wait.89u', image);
    h.device.feed([0x98, 0x56, 0, 0]);
    const sending = h.context.ccallAsync(h.module, 'send_file_custom', 'number',
        ['number', 'string', 'string', 'number', 'number'], [h.state.handle, '/flash-wait.89u', '', -1, 0],
        { timeoutMs: 5000, useProgress: true });
    while (!h.device.waiting.size) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(h.module.__cableTimeoutMs, 360000, '68k Flash sender extends the native wait');
    await new Promise(resolve => setTimeout(resolve, 1300));
    assert.equal(h.transport.needsRecovery, false, 'Flash CTS can exceed the ordinary 1.1-second deadline');
    h.device.feed([0x98, 9, 0, 0, 0x98, 0x56, 0, 0, 0x98, 0x56, 0, 0]);
    assert.equal(await sending, 0);
    assert.equal(h.module.__cableTimeoutMs, 60000, 'Flash sender restores the caller timeout');
    assert.equal(h.module.__configuredCableTimeoutMs, 60000, 'temporary waits do not change the configured timeout');
    const wire = Buffer.concat(h.writes.map(bytes => Buffer.from(bytes)));
    const commands = [];
    for (let offset = 0; offset < wire.length;) {
        const command = wire[offset + 1];
        const length = wire.readUInt16LE(offset + 2);
        commands.push(command);
        if (command === 0x15) assert.deepEqual(wire.subarray(offset + 4, offset + 4 + length), data);
        offset += 4 + (length ? length + 2 : 0);
        assert.ok(offset <= wire.length);
    }
    assert.deepEqual(commands, [0xc9, 0x56, 0x15, 0x92], 'OS header/data are sent once, without replay or abort');
    console.log('Compiled WASM/libusb TI-89 Flash CTS wait, timeout restoration and OS data passed');
}

async function test86BackupRecoveryWasm(path, failReset) {
    const h = await wasmHarness(path, 7, failReset);
    const { module, writes } = h;
    const packet = (cmd, data = []) => {
        const bytes = [0x86, cmd, data.length & 255, data.length >> 8, ...data];
        if (data.length) { const sum = data.reduce((a, b) => a + b, 0); bytes.push(sum & 255, sum >> 8); }
        return bytes;
    };
    const prepare = async () => {
        assert.equal(await h.context.ccallAsync(module, 'is_ready', 'number', ['number'], [h.state.handle]), 0);
        writes.splice(0);
    };
    const receive = async (delay = false) => {
        await prepare();
        const bytes = [...packet(6, [2, 0, 0x1d, 3, 0, 4, 0, 5, 0, 0, 0]),
            ...packet(0x56), ...packet(0x15, [1, 2]), ...packet(0x15, [3, 4, 5]),
            ...packet(0x15, [6, 7, 8, 9]), ...packet(0x15, [10, 11, 12, 13, 14])];
        if (!delay) h.device.bytes.push(...bytes);
        const pending = h.context.ccallAsync(module, 'calc_recv_backup', 'number', ['number', 'string'],
            [h.state.handle, '/backup.86b'], { timeoutMs: null });
        if (delay) {
            while (!h.device.waiting.size) await new Promise(resolve => setTimeout(resolve, 10));
            await new Promise(resolve => setTimeout(resolve, 1300));
            assert.deepEqual(writes, [], 'waiting for a manual backup sends no request');
            assert.equal(h.transport.needsRecovery, false, 'human wait exceeds the packet deadline');
            assert.equal(module.__manualBackupWaiting, true);
            h.device.feed(bytes);
        }
        assert.equal(await pending, 0);
        assert.equal(module.__manualBackupWaiting, false);
        assert.deepEqual(writes, [[6, 0x56, 0, 0], [6, 0x09, 0, 0],
            ...Array.from({ length: 4 }, () => [6, 0x56, 0, 0])], 'manual backup replies only after calculator VAR');
        const file = module.FS.readFile('/backup.86b');
        assert.equal(Buffer.from(file.subarray(0, 8)).toString(), '**TI86**');
        assert.equal(h.device.bytes.length, 0);
    };
    await receive(true);
    // Once the first header arrives, a stalled transfer must still time out.
    await prepare();
    h.device.bytes.push(...packet(6, [2, 0, 0x1d, 3, 0, 4, 0, 5, 0, 0, 0]));
    const stalledAt = Date.now();
    assert.notEqual(await h.context.ccallAsync(module, 'calc_recv_backup', 'number', ['number', 'string'],
        [h.state.handle, '/stalled.86b'], { timeoutMs: null }), 0);
    assert.ok(Date.now() - stalledAt < 2500, 'started backup retains the native packet timeout');
    assert.equal(module.FS.analyzePath('/stalled.86b').exists, false);
    // A wrong reply with extra bytes in the same USB read leaves libticables'
    // private rBuf dirty. The next valid backup must not consume that tail.
    h.device.bytes.push(...packet(0x92), ...packet(0x15, [0x55]));
    assert.notEqual(await h.context.ccallAsync(module, 'calc_screenshot', 'number', ['number'], [h.state.handle]), 0);
    await receive();
    const started = Date.now();
    const failed = await h.context.ccallAsync(module, 'calc_screenshot', 'number', ['number'], [h.state.handle]);
    assert.notEqual(failed, 0);
    assert.ok(Date.now() - started < 2500, 'native timeout and buffer drain complete without the JS watchdog');
    assert.equal(h.context.getModuleCallState(module).dead, false);
    await receive();
    await prepare();
    const stuck = h.context.ccallAsync(module, 'calc_recv_backup', 'number', ['number', 'string'],
        [h.state.handle, '/cancelled.86b'], { timeoutMs: null });
    const cancelled = assert.rejects(stuck, error => error.silent === true);
    while (!h.device.waiting.size) await new Promise(resolve => setTimeout(resolve, 10));
    await h.context.nukeConnection(false);
    await cancelled;
    assert.equal(h.device.waiting.size, 0);
    assert.equal(h.transport.needsRecovery, false);
    assert.ok(!h.logs.some(args => args[0] === 'ERROR'));
    console.log(`Compiled WASM/libusb TI-86 backup, timeout/retry and bomb cancellation passed (USB reset ${failReset ? 'rejected' : 'accepted'})`);
}

async function testManualRestoreWasm(path, model) {
    const h = await wasmHarness(path, model, false);
    const {module, writes} = h;
    const mid = model === 2 ? 0x82 : model === 6 ? 0x85 : 0x86;
    const packet = (cmd, data = []) => {
        const bytes = [mid, cmd, data.length & 255, data.length >> 8, ...data];
        if (data.length) { const sum = data.reduce((a, b) => a + b, 0); bytes.push(sum & 255, sum >> 8); }
        return bytes;
    };
    const parts = [[1, 2], [3, 4, 5], [6, 7, 8, 9], ...(model === 7 ? [[10, 11, 12, 13, 14]] : [])];
    const header = [2, 0, model === 2 ? 0x0f : 0x1d, 3, 0, 4, 0, 5, 0, 0, 0];
    h.device.bytes.push(...packet(6, header), ...packet(0x56), ...parts.flatMap(p => packet(0x15, p)));
    const filename = `/restore.${model === 2 ? '82b' : model === 6 ? '85b' : '86b'}`;
    assert.equal(await h.context.ccallAsync(module, 'calc_recv_backup', 'number', ['number', 'string'],
        [h.state.handle, filename], {timeoutMs: null}), 0);
    writes.splice(0);
    h.device.bytes.push(...packet(0x56)); // Calculator is already in Receive mode.
    const restoring = h.context.ccallAsync(module, 'send_file_custom', 'number',
        ['number', 'string', 'string', 'number', 'number'], [h.state.handle, filename, '', -1, 0], {timeoutMs: null});
    while (!h.device.waiting.size) await new Promise(resolve => setTimeout(resolve, 10));
    await new Promise(resolve => setTimeout(resolve, 1300));
    assert.equal(module.__manualBackupWaiting, true, 'Continue confirmation gets a human wait');
    assert.equal(h.transport.needsRecovery, false, 'reading the backup warning exceeds 1.1 seconds');
    h.device.feed([...packet(9), ...parts.flatMap(() => packet(0x56))]);
    assert.equal(await restoring, 0);
    assert.equal(module.__manualBackupWaiting, false);
    assert.equal(writes[0][1], 6, 'restore starts with a nonsilent backup VAR');
    assert.equal(writes.filter(p => p[1] === 0x15).length, parts.length);
    // A partial CTS is a broken packet, not more time for a human.
    h.device.bytes.push(...packet(0x56));
    const partial = h.context.ccallAsync(module, 'send_file_custom', 'number',
        ['number', 'string', 'string', 'number', 'number'], [h.state.handle, filename, '', -1, 0], {timeoutMs: null});
    while (!h.device.waiting.size) await new Promise(resolve => setTimeout(resolve, 10));
    h.device.feed([mid, 9]);
    const started = Date.now();
    assert.notEqual(await partial, 0);
    assert.ok(Date.now() - started < 2500, 'partial CTS keeps normal packet deadlines');
    assert.equal(h.transport.needsRecovery, false, 'file-send failure recovers the cable before another transfer');
    assert.equal(module.__manualBackupWaiting, false);
    // ACK and CTS can arrive in one USB read; subsequent data ACKs still need a deadline.
    h.device.bytes.push(...packet(0x56), ...packet(9));
    const dataStarted = Date.now();
    assert.notEqual(await h.context.ccallAsync(module, 'send_file_custom', 'number',
        ['number', 'string', 'string', 'number', 'number'], [h.state.handle, filename, '', -1, 0], {timeoutMs: null}), 0);
    assert.ok(Date.now() - dataStarted < 2500, 'coalesced CTS does not extend the data-ACK deadline');
    assert.equal(h.transport.needsRecovery, false);
    assert.equal(module.__manualBackupWaiting, false);
    h.device.bytes.push(...packet(0x56));
    const cancelling = h.context.ccallAsync(module, 'send_file_custom', 'number',
        ['number', 'string', 'string', 'number', 'number'], [h.state.handle, filename, '', -1, 0], {timeoutMs: null});
    const cancelled = assert.rejects(cancelling, error => error.silent === true);
    while (!h.device.waiting.size) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(module.__manualBackupWaiting, true);
    await h.context.nukeConnection(false);
    await cancelled;
    assert.equal(module.__manualBackupWaiting, false);
    assert.equal(h.device.waiting.size, 0);
    console.log(`Compiled WASM TI-${model === 2 ? 82 : model === 6 ? 85 : 86} restore human wait and partial-CTS timeout passed`);
}

function nonsilentVariable(model) {
    const mid = model === 2 ? 0x82 : 0x85;
    const filename = model === 2 ? '/A.82p' : '/A.85p';
    const varHeader = model === 2 ? [3, 0, 5, 0x41, 0, 0, 0, 0, 0, 0, 0]
        : [3, 0, 0x12, 1, 0x41];
    const varSum = varHeader.reduce((sum, byte) => sum + byte, 0);
    const received = [mid, 6, varHeader.length, 0, ...varHeader, varSum, 0,
        mid, 0x56, 0, 0, mid, 0x15, 3, 0, 1, 0, 0x31, 0x32, 0, mid, 0x92, 3, 0];
    // The ROM echoes the VAR payload length in ACK and CTS.
    const varAck = [mid, 0x56, varHeader.length, 0];
    const overwrite = [mid, 9, varHeader.length, 0, mid, 0x56, 3, 0, mid, 0x56, 0, 0];
    return {mid, filename, received, varAck, overwrite};
}

async function testNonsilentVariables(path, model) {
    const h = await wasmHarness(path, model, false);
    const {module} = h;
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    const {mid, filename, received, varAck, overwrite} = nonsilentVariable(model);
    module._set_cable_timeout(4); // 400 ms, well below the user's response time.
    const receive = () => h.context.ccallAsync(module, 'calc_recv_var_ns', 'number', ['number', 'string'],
        [h.state.handle, '/'], {timeoutMs: null});
    const receivePending = receive();
    while (!h.device.waiting.size) await delay(10);
    await delay(1300);
    assert.equal(module.__manualLinkWaiting, true);
    assert.equal(h.transport.needsRecovery, false);
    h.device.feed(received);
    assert.equal(await receivePending, 0);
    assert.equal(module.__manualLinkWaiting, false);
    assert.equal(module.FS.readFile('/last_recv_path.txt', {encoding: 'utf8'}), filename);

    const send = (timeoutMs) => {
        h.device.feed(varAck);
        return h.context.ccallAsync(module, 'send_file_custom', 'number',
            ['number', 'string', 'string', 'number', 'number'],
            [h.state.handle, filename, '', -1, 0], {timeoutMs, useProgress: true});
    };
    const sending = send(700);
    while (!h.device.waiting.size) await delay(10);
    await delay(1300);
    assert.equal(module.__manualLinkWaiting, true);
    assert.equal(h.transport.needsRecovery, false);
    h.device.feed(overwrite);
    assert.equal(await sending, 0);
    assert.equal(module.__manualLinkWaiting, false);

    const broken = send(3000);
    while (!h.device.waiting.size) await delay(10);
    assert.equal(module.__manualLinkWaiting, true);
    h.device.feed([mid, 9]); // The user replied, but the header is incomplete.
    assert.notEqual(await broken, 0);
    assert.equal(module.__manualLinkWaiting, false);
    assert.equal(h.transport.needsRecovery, false);
    console.log(`Compiled TI-${model === 2 ? 82 : 85} WASM/SilverLink overwrites after both deadlines and times out on a partial reply`);
}

async function testGrayLinkOverwrite(path) {
    const h = harness();
    h.state.authorizedDevice = {serialKind: 2};
    Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {serial: {}}});
    let reader;
    const port = {
        readable: new ReadableStream({start(controller) { reader = controller; }}),
        writable: new WritableStream(),
        async setSignals() {},
        async getSignals() { return {}; },
        async close() {}
    };
    const feed = bytes => reader.enqueue(Uint8Array.from(bytes));
    const module = h.state.module = await require(require('node:path').resolve(path))();
    await module.ccall('init', 'number', [], [], {async: true});
    module.__ticablesWebSerial = {kind: 2, port};
    module._set_cable_model(1); // GrayLink
    module._set_force_cable(1);
    module._set_calc_model(2);
    module._set_force_calc(1);
    module._set_cable_timeout(4);
    h.state.handle = await module.ccall('create_handle', 'number', [], [], {async: true});
    assert.ok(h.state.handle);
    assert.equal(await module.ccall('open_cable', 'number', ['number'], [h.state.handle], {async: true}), 0);

    const {filename, received, varAck, overwrite} = nonsilentVariable(2);
    feed(received);
    assert.equal(await h.context.ccallAsync(module, 'calc_recv_var_ns', 'number', ['number', 'string'],
        [h.state.handle, '/']), 0);
    feed(varAck);
    const sending = h.context.ccallAsync(module, 'send_file_custom', 'number',
        ['number', 'string', 'string', 'number', 'number'],
        [h.state.handle, filename, '', -1, 0], {timeoutMs: 700, useProgress: true});
    await new Promise(resolve => setTimeout(resolve, 1300));
    assert.equal(module.__manualLinkWaiting, true, 'empty GrayLink reads preserve the overwrite wait');
    feed(overwrite);
    assert.equal(await sending, 0);
    assert.equal(module.__manualLinkWaiting, false);
    await module.ccall('close_cable', 'number', ['number'], [h.state.handle], {async: true});
    console.log('Compiled TI-82 WASM/GrayLink overwrites after repeated serial read timeouts');
}

(async () => {
    const wasmPath = process.argv[2];
    assert.ok(wasmPath, 'Pass the path to the compiled webtilp.js');
    await testCxIIAlreadyAssociatedWasm(wasmPath);
    await test89ScreenshotWasm(wasmPath);
    await test89FlashWaitWasm(wasmPath);
    await testDirectLinkWasm(wasmPath);
    await test83PlusWasm(wasmPath);
    for (const model of [2, 6]) await testNonsilentVariables(wasmPath, model);
    await testGrayLinkOverwrite(wasmPath);
    for (const model of [2, 6, 7]) await testManualRestoreWasm(wasmPath, model);
    for (const failReset of [false, true]) await test86BackupRecoveryWasm(wasmPath, failReset);
    process.exit(0); // Stop the Emscripten pthread pool.
})().catch(error => { console.error(error); process.exit(1); });
