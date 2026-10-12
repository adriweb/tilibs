'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');

function extract(name) {
    let start = app.indexOf(`async function ${name}(`);
    if (start < 0) start = app.indexOf(`function ${name}(`);
    assert.ok(start >= 0, name);
    const body = app.indexOf(') {', start) + 2;
    let depth = 0;
    for (let i = body; i < app.length; i++) {
        if (app[i] === '{') depth++;
        if (app[i] === '}') depth--;
        if (!depth) return app.slice(start, i + 1);
    }
    throw new Error(`Unterminated ${name}`);
}

class USBDevice {
    vendorId = 0x0451;
    productId = 0xe001;
    opened = true;
    calls = [];
    writes = [];
    bytes = [];
    waiting = new Set();
    holdWrites = false;
    endless = false;
    failReset = false;
    configuration = { configurationValue: 1, interfaces: [{
        interfaceNumber: 0, claimed: true, alternate: {
            alternateSetting: 0, endpoints: [
                { endpointNumber: 1, direction: 'out', type: 'bulk', packetSize: 64 },
                { endpointNumber: 1, direction: 'in', type: 'bulk', packetSize: 64 }
            ]
        }
    }] };
    async open() { this.calls.push('open'); this.opened = true; }
    async claimInterface(number) { assert.equal(number, 0); this.configuration.interfaces[0].claimed = true; }
    async releaseInterface(number) { assert.equal(number, 0); this.configuration.interfaces[0].claimed = false; }
    async selectConfiguration(value) { assert.equal(value, 1); }
    async reset() {
        this.calls.push('reset');
        assert.equal(this.waiting.size, 0, 'reset happens only after cancelled I/O settles');
        this.configuration.interfaces[0].claimed = false;
        // Deliberately retain USB bytes: resetting alone is not a flush.
        if (this.failReset) {
            this.opened = false;
            throw new DOMException("Failed to execute 'reset' on 'USBDevice': Unable to reset the device.", 'NetworkError');
        }
    }
    async clearHalt(direction, endpoint) { this.calls.push(`halt:${direction}:${endpoint}`); }
    async close() {
        this.calls.push('close'); this.opened = false;
        this.configuration.interfaces[0].claimed = false;
        await new Promise(resolve => setImmediate(resolve));
        for (const reject of this.waiting) reject(new DOMException('Transfer cancelled by close', 'AbortError'));
        this.waiting.clear();
    }
    transferIn(endpoint, length) {
        this.calls.push('read');
        assert.equal(endpoint, 1);
        assert.equal(this.opened, true);
        assert.equal(this.configuration.interfaces[0].claimed, true);
        if (this.bytes.length || this.endless) {
            const bytes = this.endless ? new Uint8Array(length) : Uint8Array.from(this.bytes.splice(0, length));
            return Promise.resolve({ status: 'ok', data: new DataView(bytes.buffer) });
        }
        return new Promise((_, reject) => this.waiting.add(reject));
    }
    transferOut(endpoint, bytes) {
        this.calls.push('write');
        this.writes.push([...bytes]);
        if (this.holdWrites) return new Promise((_, reject) => this.waiting.add(reject));
        return Promise.resolve({ status: 'ok', bytesWritten: bytes.byteLength });
    }
}

function harness(device = new USBDevice(), realTime = false) {
    const state = { authorizedDevice: device, operationEpoch: 0, handle: 42, activeFamily: 'ti', lastCcallTs: 0, cableOpen: true };
    const logs = [];
    const context = vm.createContext({
        state, DOMException, Date, Promise, Set, WeakMap,
        setTimeout: (fn, ms) => setTimeout(fn, realTime ? ms : Math.max(1, ms / 100)), clearTimeout,
        sleep: ms => new Promise(resolve => setTimeout(resolve, ms / 100)),
        CCALL_TIMEOUT_MS: 8000, CCALL_MIN_GAP_MS: 0, SUSPENDED_CCALL_GRACE_MS: 3000,
        PID_SILVERLINK: 0xe001, DEVICE_FAMILY_TI: 'ti', DEVICE_FAMILY_SHARP: 'sharp',
        console: { log() {}, warn(...args) { logs.push(args); }, error(...args) { logs.push(args); } },
        els: {}, setButtonLoading() {},
        clearActiveOperations() { state.operationEpoch++; },
        isHPPrimeActive: () => false, isHPLegacyActive: () => false, isNumWorksActive: () => false,
        isCasioActive: () => false, isNspireActive: () => false,
        clearDeviceData() {}, applyActiveFamilyUiState() {}, setConnected() {}, setStatus() {}, log() {},
        logError(...args) { logs.push(['ERROR', ...args]); },
        startProgress() {}, stopProgress() {}, readProgressTick: () => null, refreshProgressDetails() {},
        async connect() { state.reconnected = true; assert.equal(device.bytes.length, 0, 'reconnect sees a drained cable'); }
    });
    vm.runInContext('const silverLinkTransports = new WeakMap();', context);
    for (const name of ['installSilverLinkTransport', 'recoverSilverLinkOperation', 'getModuleCallState',
        'makeModuleDeadError', 'retireModule', 'withTimeout', 'withProgressTimeout', 'watchAbandonedCcall',
        'isFatalWasmRuntimeError', 'handleFatalWasmRuntimeError', 'ccallAsync', 'nukeConnection']) {
        vm.runInContext(extract(name), context);
    }
    const transport = context.installSilverLinkTransport(device);
    return { device, state, context, transport, logs };
}

async function main() {
    {
        const h = harness(new USBDevice(), true);
        const started = Date.now();
        await assert.rejects(h.device.transferIn(1, 64), { name: 'TimeoutError' });
        const elapsed = Date.now() - started;
        assert.ok(elapsed >= 1050 && elapsed < 2500, `actual 1.1-second deadline: ${elapsed}ms`);
        assert.equal(h.device.waiting.size, 0, 'timeout cancels browser I/O before rejecting to native code');
        h.device.bytes.push(0x86, 0x56, 0, 0, 0x15, 0x00);
        await h.transport.recover();
        assert.equal(h.device.bytes.length, 0);
        assert.equal(h.device.opened, false);
        await h.device.open(); await h.device.claimInterface(0);
        h.device.bytes.push(0x86, 0x56, 0, 0);
        assert.deepEqual([...new Uint8Array((await h.device.transferIn(1, 64)).data.buffer)], [0x86, 0x56, 0, 0]);
    }
    {
        const h = harness();
        h.device.holdWrites = true;
        await assert.rejects(h.device.transferOut(1, new Uint8Array([6, 0xa2])), { name: 'TimeoutError' });
        assert.equal(h.device.waiting.size, 0);
        h.device.holdWrites = false;
        await h.transport.recover();
    }
    for (const failReset of [false, true]) {
        const h = harness();
        h.device.failReset = failReset;
        const calls = [];
        let nativeBuffer = [0xa2, 0x15];
        const module = h.state.module = { async ccall(name) {
            calls.push(name);
            if (name === 'close_cable') { nativeBuffer = []; await h.device.close(); return 0; }
            if (name === 'calc_recv_backup') {
                try { await h.device.transferIn(1, 64); } catch (_) { h.device.bytes.push(0x15, 0x00); return 3; }
            }
            assert.equal(name, 'calc_screenshot');
            assert.equal(h.device.bytes.length, 0, 'queued command starts after the hardware drain');
            assert.deepEqual(nativeBuffer, [], 'native cable buffer is discarded too');
            await h.device.open(); await h.device.claimInterface(0);
            h.device.bytes.push(99);
            assert.equal((await h.device.transferIn(1, 64)).data.getUint8(0), 99);
            return 0;
        } };
        const first = h.context.ccallAsync(module, 'calc_recv_backup', 'number', [], []);
        const next = h.context.ccallAsync(module, 'calc_screenshot', 'number', [], []);
        assert.equal(await first, 3, 'original native failure is preserved');
        assert.equal(await next, 0);
        assert.deepEqual(calls, ['calc_recv_backup', 'close_cable', 'calc_screenshot']);
        assert.equal(h.context.getModuleCallState(module).dead, false, 'ordinary timeout preserves the WASM module');
        assert.equal(h.transport.needsRecovery, false, 'a rejected USB reset does not prevent draining and retrying');
    }
    for (const failReset of [false, true]) {
        const h = harness();
        h.device.failReset = failReset;
        let nativeActive = false;
        const module = h.state.module = { async ccall(name) {
            if (name === 'calc_recv_backup') {
                nativeActive = true;
                try { await h.device.transferIn(1, 64); } catch (_) { h.device.bytes.push(0x86, 0x15, 0, 0); }
                nativeActive = false;
                return 3;
            }
            assert.ok(['close_cable', 'notify_usb_disconnect'].includes(name));
            assert.equal(nativeActive, false, 'bomb never re-enters suspended Asyncify');
            await h.device.close();
            return 0;
        } };
        const transfer = h.context.ccallAsync(module, 'calc_recv_backup', 'number', [], []);
        const cancelled = assert.rejects(transfer, error => error.silent === true);
        await new Promise(resolve => setImmediate(resolve));
        await h.context.nukeConnection();
        await cancelled;
        assert.equal(h.state.reconnected, true);
        assert.equal(h.state.module, null);
        assert.equal(h.state.progressHooked, false);
        assert.equal(h.state.progressTickPtr, null);
        assert.equal(h.device.waiting.size, 0);
        assert.equal(h.state.nukeInProgress, false);
        assert.equal(h.transport.needsRecovery, false);
        assert.ok(!h.logs.some(args => args[0] === 'ERROR'), 'bomb recovery succeeds even if USB reset is rejected');
    }
    for (const failReset of [false, true]) {
        const h = harness();
        h.device.failReset = failReset;
        h.device.endless = true;
        await assert.rejects(h.transport.recover(), /did not become quiet/);
        await assert.rejects(h.device.transferOut(1, new Uint8Array([1])), /needs buffer recovery/);
    }
    {
        const device = new USBDevice(); device.productId = 0xe003;
        const original = device.transferIn;
        const h = harness(device);
        assert.equal(h.transport, null);
        assert.equal(device.transferIn, original, 'DirectLink USB transport is unchanged');
    }
    console.log('SilverLink deadlines, native/USB buffer recovery, FIFO and bomb cancellation tests passed');
}

async function wasmHarness(path, model, failReset) {
    const h = harness(new USBDevice(), true);
    h.device.failReset = failReset;
    const descriptor = [18, 1, 0x10, 1, 0, 0, 0, 8, 0x51, 4, 1, 0xe0, 0, 1, 1, 2, 3, 1];
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
    module._set_cable_model(4); module._set_force_cable(1);
    module._set_calc_model(model); module._set_force_calc(1);
    module.__silverLinkDevice = h.device;
    h.transport.module = module;
    h.state.handle = await module.ccall('create_handle', 'number', [], [], { async: true });
    assert.ok(h.state.handle);
    assert.equal(await module.ccall('open_cable', 'number', ['number'], [h.state.handle], { async: true }), 0);
    return { ...h, module, writes: h.device.writes };
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

async function testWasm(path, failReset) {
    const h = await wasmHarness(path, 7, failReset);
    const { module, writes } = h;
    const packet = (cmd, data = []) => {
        const bytes = [0x86, cmd, data.length & 255, data.length >> 8, ...data];
        if (data.length) { const sum = data.reduce((a, b) => a + b, 0); bytes.push(sum & 255, sum >> 8); }
        return bytes;
    };
    const receive = async () => {
        h.device.bytes.push(...packet(0x56), ...packet(6, [2, 0, 0x1d, 3, 0, 4, 0, 5, 0, 0, 0]),
            ...packet(0x56), ...packet(0x15, [1, 2]), ...packet(0x15, [3, 4, 5]),
            ...packet(0x15, [6, 7, 8, 9]), ...packet(0x15, [10, 11, 12, 13, 14]));
        assert.equal(await h.context.ccallAsync(module, 'calc_recv_backup', 'number', ['number', 'string'],
            [h.state.handle, '/backup.86b']), 0);
        const bytes = module.FS.readFile('/backup.86b');
        assert.equal(Buffer.from(bytes.subarray(0, 8)).toString(), '**TI86**');
        assert.equal(h.device.bytes.length, 0);
    };
    await receive();
    assert.deepEqual(writes[0], [6, 0xa2, 11, 0, 0, 0, 0x1d, 0, 0, 0, 0, 0, 0, 0, 0, 0x1d, 0]);
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
    const stuck = h.context.ccallAsync(module, 'calc_screenshot', 'number', ['number'], [h.state.handle]);
    const cancelled = assert.rejects(stuck, error => error.silent === true);
    while (!h.device.waiting.size) await new Promise(resolve => setTimeout(resolve, 10));
    await h.context.nukeConnection(false);
    await cancelled;
    assert.equal(h.device.waiting.size, 0);
    assert.equal(h.transport.needsRecovery, false);
    assert.ok(!h.logs.some(args => args[0] === 'ERROR'));
    console.log(`Compiled WASM/libusb TI-86 backup, timeout/retry and bomb cancellation passed (USB reset ${failReset ? 'rejected' : 'accepted'})`);
}

(async () => {
    await main();
    if (process.argv[2]) {
        await test83PlusWasm(process.argv[2]);
        for (const failReset of [false, true]) await testWasm(process.argv[2], failReset);
        process.exit(0);
    }
})().catch(error => { console.error(error); if (process.argv[2]) process.exit(1); process.exitCode = 1; });
