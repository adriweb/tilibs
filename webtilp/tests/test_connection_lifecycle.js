'use strict';

const assert = require('node:assert/strict');
const { createWasmClient } = require('../runtime/wasm-client.js');
const { createSession } = require('../session.js');
const { closeTISerialTransport } = require('../runtime/transports.js');
const { createFeaturesConnections } = require('../features/connections.js');
const { createTransportBrowserDevices } = require('../transport/browser-devices.js');
const { createRuntimeDiagnostics } = require('../runtime/diagnostics.js');
const { createUiProgress } = require('../ui/progress.js');
const devices = require('../catalog/devices.js');

function deferred() {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return { promise, resolve };
}

async function flush() {
    for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

function setup(overrides = {}) {
    const state = { module: null, handle: 0, operationEpoch: 0, activeFamily: devices.DEVICE_FAMILY_TI,
        settings: { cableModel: 'auto', calcModel: 'auto' }, progressOps: new Map(),
        hpLegacyConnectionGeneration: 0, sharpConnectionGeneration: 0, ...overrides.state };
    const events = [];
    const ctx = {
        ...devices, state, events,
        self: { isSecureContext: true }, window: { crossOriginIsolated: true },
        console: { log() {}, warn() {}, error() {} },
        navigator: { usb: {} }, globalThis: {}, document: { querySelectorAll: () => [] },
        els: { btnConnect: {}, btnNuke: {} },
        CCALL_TIMEOUT_MS: null, CREATE_HANDLE_RETRY_DELAY_MS: 0,
        setTimeout, clearTimeout,
        ensureSupportedTransport() {},
        makeModulePrintHandlers: touch => ({ print: touch, printErr: touch }),
        applySettingsToModule: module => { events.push('settings'); assert.ok(module); },
        setButtonLoading() {}, setStatus: key => { state.status = key; },
        setConnected: value => { state.connected = value; },
        log() {}, logError: error => { if (!error.silent) events.push(error); },
        clearDeviceData: () => { state.hpLegacyConnectionGeneration += 1; },
        applyActiveFamilyUiState() {},
        updateDeviceModelDisplay() {},
        isNspireActive: () => false,
        isHPLegacyActive: () => state.activeFamily === devices.DEVICE_FAMILY_HP_LEGACY,
        isCasioActive: () => state.activeFamily === devices.DEVICE_FAMILY_CASIO,
        t: key => key, tFormat: key => key,
        closeTISerialTransport: async () => {}
    };
    ctx.wasmRuntime = createWasmClient({ getGeneration: () => state.operationEpoch,
        minGapMs: 0, timeoutMs: null, warn() {} });
    ctx.session = createSession(state, ctx.wasmRuntime);
    Object.assign(ctx, createTransportBrowserDevices(ctx), createRuntimeDiagnostics(ctx),
        createUiProgress(ctx), createFeaturesConnections(ctx));
    ctx.updateProgressIndicator = () => {};
    Object.assign(ctx, overrides, { state });
    return ctx;
}

async function cachedAppInitialization() {
    const factory = deferred(), native = deferred();
    let factories = 0, initializations = 0, handlers;
    const module = { ccall(name) { assert.equal(name, 'init'); initializations += 1; return native.promise; } };
    const ctx = setup({ TILibsModule(options) { handlers = options; factories += 1; return factory.promise; } });
    const first = ctx.initModule(), second = ctx.initModule();
    factory.resolve(module);
    await flush();
    assert.equal(factories, 1);
    assert.equal(initializations, 1);
    assert.equal(ctx.state.module, null);
    const third = ctx.initModule();
    native.resolve(0);
    const modules = await Promise.all([first, second, third]);
    assert.ok(modules.every(value => value === module));
    assert.equal(ctx.state.module, module);
    assert.deepEqual(ctx.events, ['settings']);
    ctx.session.invalidate('expected calculator reset');
    ctx.state.lastProgressTs = 0;
    handlers.print('activity after reauthorization');
    assert.ok(ctx.state.lastProgressTs > 0, 'retained Nspire module still reports progress after generation changes');
    ctx.session.invalidate('device disconnected', { retire: true });
    ctx.state.lastProgressTs = 0;
    handlers.print('late retired module activity');
    assert.equal(ctx.state.lastProgressTs, 0, 'retired module output cannot extend a replacement session deadline');
}

async function emergencyResetDoesNotWaitForNative() {
    for (const family of [devices.DEVICE_FAMILY_HP_PRIME, devices.DEVICE_FAMILY_CASIO]) {
        const native = deferred();
        const calls = [];
        let closes = 0;
        const module = { ccall(name) { calls.push(name); return native.promise; } };
        const device = { opened: true, async close() { closes += 1; } };
        const ctx = setup({ state: { module, authorizedDevice: device, activeFamily: family,
            connected: true, handle: 123, cableOpen: true } });
        const active = ctx.ccallAsync(module, 'transfer', 'number', [], []);
        const cancelled = assert.rejects(active, error => error.silent || error.wasmModuleDead);
        await flush();
        const reset = ctx.nukeConnection(false);
        assert.equal(ctx.state.module, null, 'reset detaches the module before its first transport await');
        assert.equal(ctx.state.connected, false);
        assert.equal(ctx.state.handle, 0);
        await reset;
        await cancelled;
        assert.equal(closes, 1);
        assert.deepEqual(calls, ['transfer'], 'native disconnect is never queued behind a suspended call');
        native.resolve(0);
        await ctx.wasmRuntime.getModuleCallState(module).tail;
    }
    const native = deferred();
    const module = { ccall() { return native.promise; } };
    const ctx = setup({ TILibsModule: async () => module });
    const initialization = ctx.initModule();
    const cancelled = assert.rejects(initialization, error => error.silent || error.wasmModuleDead);
    await flush();
    await ctx.nukeConnection(false);
    await cancelled;
    assert.equal(ctx.state.module, null);
    assert.equal(ctx.wasmRuntime.getModuleCallState(module).dead, true);
    native.resolve(0);
    await flush();
    assert.equal(ctx.events.includes('settings'), false, 'retired native initialization cannot apply settings');

    const events = [];
    const serialModule = { __ticablesWebSerial: {
        kind: devices.SERIAL_KIND_GRAYLINK, running: true, waiters: [],
        reader: { async cancel() { events.push('cancel'); }, releaseLock() { events.push('reader release'); } },
        writer: { async abort() { events.push('abort'); }, releaseLock() { events.push('writer release'); } },
        port: { readable: {}, async close() { events.push('serial close'); } }
    } };
    const serial = setup({ state: { module: serialModule,
        authorizedDevice: { transport: 'serial', reset: async () => {} } }, closeTISerialTransport });
    await serial.nukeConnection(false);
    assert.deepEqual(events, ['cancel', 'abort', 'reader release', 'writer release', 'serial close']);
}

async function staleChooserAndEvoAuthorization() {
    const chooser = deferred();
    const ctx = setup({ hasWebUsbTransport: () => true,
        requestSupportedWebUsbDevice: () => chooser.promise });
    const connecting = ctx.connect();
    await ctx.nukeConnection(false);
    chooser.resolve({ vendorId: devices.TI_VENDOR_ID, productId: 0xe003 });
    await connecting;
    assert.equal(ctx.state.authorizedDevice, null);
    assert.equal(ctx.state.status, 'status_disconnected');
    assert.equal(ctx.state.connected, false);

    const grants = deferred(), lookupStarted = deferred();
    let prompts = 0;
    const evo = setup({ navigator: { usb: {}, serial: {
        getPorts() { lookupStarted.resolve(); return grants.promise; },
        requestPort() { prompts += 1; assert.fail('reset grant lookup must not create another chooser'); }
    } } });
    const authorizing = evo.requestEvoSerialForUsbDevice({ vendorId: devices.TI_VENDOR_ID,
        productId: devices.PID_TI84_EVO_SERIAL });
    const cancelled = assert.rejects(authorizing, error => error.staleSession === true);
    await lookupStarted.promise;
    evo.session.invalidate('reset');
    grants.resolve([]);
    await cancelled;
    assert.equal(prompts, 0);
    assert.equal(evo.state.pendingEvoUsbDevice, undefined);
}

async function grayLinkPermissionRetainsGesture() {
    const events = [];
    let gesture = true;
    const port = { getInfo: () => ({}) };
    const ctx = setup({ state: { settings: { cableModel: devices.CABLE_GRAYLINK, calcModel: '13' } },
        navigator: { serial: {
            async requestPort() {
                assert.equal(gesture, true, 'serial chooser runs before module initialization consumes activation');
                events.push('chooser');
                return port;
            }
        } },
        hasWebUsbTransport: () => false,
        async initModule() { gesture = false; events.push('module'); return {}; },
        ensureGrayLinkModelSelected: () => true,
        ensureSilverlinkModelSelected: () => true,
        promptCableMismatchResolution: () => false,
        ensureCableOpen: async () => 123,
        updateCapabilities: async () => {}, getDeviceInfo: async () => {},
        isTi92Selected: () => false
    });
    await ctx.connect();
    assert.deepEqual(events, ['chooser', 'module']);
    assert.equal(ctx.state.authorizedDevice.serialPort, port);
    assert.equal(ctx.state.authorizedDevice.serialKind, devices.SERIAL_KIND_GRAYLINK);
    assert.equal(ctx.state.connected, true);
}

async function expectedNspireResetKeepsModule() {
    let notifications = 0;
    const module = { ccall(name) {
        assert.equal(name, 'notify_usb_disconnect');
        notifications += 1;
    } };
    const ctx = setup({ state: { module, connected: true, handle: 123, cableOpen: true },
        isNspireActive: () => true });
    const device = { async reset() {
        ctx.handleTransportDisconnect({ device });
        ctx.handleTransportConnect({ device });
    } };
    ctx.state.authorizedDevice = device;
    await ctx.silentReconnectAfterNspireTransfer();
    assert.equal(ctx.state.module, module);
    assert.equal(ctx.wasmRuntime.getModuleCallState(module).dead, false);
    assert.equal(ctx.state.needsReauthorize, true);
    assert.equal(ctx.state.silentReconnectInProgress, true);
    assert.equal(notifications, 1);

    const resetting = deferred();
    ctx.state.silentReconnectInProgress = false;
    ctx.state.authorizedDevice = { reset: () => resetting.promise };
    const reconnecting = ctx.silentReconnectAfterNspireTransfer();
    ctx.session.invalidate('replacement', { retire: true });
    const replacement = {};
    ctx.state.module = replacement;
    resetting.resolve();
    await reconnecting;
    assert.equal(ctx.state.module, replacement);
    assert.equal(notifications, 1, 'late reset does not notify the replacement native session');
}

async function main() {
    await cachedAppInitialization();
    await emergencyResetDoesNotWaitForNative();
    await staleChooserAndEvoAuthorization();
    await grayLinkPermissionRetainsGesture();
    await expectedNspireResetKeepsModule();
    console.log('Connection lifecycle tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
