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
        if (this.closing) throw new DOMException('A device-state change is in progress', 'InvalidStateError');
        this.closing = true;
        this.calls.push('close'); this.opened = false;
        this.configuration.interfaces[0].claimed = false;
        if (this.closeGate) await this.closeGate;
        await new Promise(resolve => setImmediate(resolve));
        for (const reject of this.waiting) reject(new DOMException('Transfer cancelled by close', 'AbortError'));
        this.waiting.clear();
        this.readPending = null;
        this.closing = false;
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
        return new Promise((resolve, reject) => {
            this.waiting.add(reject);
            this.readPending = { resolve, reject, length };
        });
    }
    feed(bytes) {
        this.bytes.push(...bytes);
        if (!this.readPending) return;
        const { resolve, reject, length } = this.readPending;
        this.readPending = null;
        this.waiting.delete(reject);
        const data = Uint8Array.from(this.bytes.splice(0, length));
        resolve({ status: 'ok', data: new DataView(data.buffer) });
    }
    transferOut(endpoint, bytes) {
        this.calls.push('write');
        this.retainedWrite = bytes;
        this.writes.push([...bytes]);
        if (this.holdWrites) return new Promise((_, reject) => this.waiting.add(reject));
        return Promise.resolve({ status: 'ok', bytesWritten: bytes.byteLength });
    }
}

function harness(device = new USBDevice(), realTime = false) {
    const state = { authorizedDevice: device, operationEpoch: 0, handle: 42, activeFamily: 'ti', lastCcallTs: 0, cableOpen: true };
    const logs = [];
    const deadlines = [];
    const context = vm.createContext({
        state, DOMException, Date, Promise, Set, WeakMap,
        setTimeout: (fn, ms) => {
            deadlines.push(ms);
            return setTimeout(fn, realTime ? ms : Math.max(1, ms / 100));
        }, clearTimeout,
        sleep: ms => new Promise(resolve => setTimeout(resolve, ms / 100)),
        CCALL_TIMEOUT_MS: 8000, CCALL_MIN_GAP_MS: 0, SUSPENDED_CCALL_GRACE_MS: 3000,
        PID_SILVERLINK: 0xe001, TI84P_FAMILY_PIDS: new Set([0xe003, 0xe008]), DEVICE_FAMILY_TI: 'ti', DEVICE_FAMILY_SHARP: 'sharp',
        console: { log() {}, warn(...args) { logs.push(args); }, error(...args) { logs.push(args); } },
        els: {}, setButtonLoading() {},
        clearActiveOperations() { state.operationEpoch++; },
        isGrayLinkSerialDevice: device => device?.serialKind === 2,
        isHPPrimeActive: () => false, isHPLegacyActive: () => false, isNumWorksActive: () => false,
        isCasioActive: () => false, isNspireActive: () => false,
        clearDeviceData() {}, applyActiveFamilyUiState() {}, setConnected() {}, setStatus() {}, log() {},
        logError(...args) { logs.push(['ERROR', ...args]); },
        startProgress() {}, stopProgress() {}, readProgressTick: () => null, refreshProgressDetails() {},
        async connect() { state.reconnected = true; assert.equal(device.bytes.length, 0, 'reconnect sees a drained cable'); }
    });
    vm.runInContext('const tiUsbTransports = new WeakMap();', context);
    vm.runInContext("let lastDebugLog = null;", context);
    for (const name of ['installTiUsbTransport', 'recoverTiUsbOperation', 'getModuleCallState',
        'makeModuleDeadError', 'readDebugLog', 'retireModule', 'withTimeout', 'withProgressTimeout', 'watchAbandonedCcall',
        'isFatalWasmRuntimeError', 'handleFatalWasmRuntimeError', 'ccallAsync', 'nukeConnection']) {
        vm.runInContext(extract(name), context);
    }
    const transport = context.installTiUsbTransport(device);
    return { device, state, context, transport, logs, deadlines };
}

module.exports = { USBDevice, extract, harness };
