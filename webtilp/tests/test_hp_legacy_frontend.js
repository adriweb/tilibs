'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const appSource = fs.readFileSync(require.resolve('../app.js'), 'utf8');

function extractFunction(name) {
    const asyncMarker = `async function ${name}(`;
    const plainMarker = `function ${name}(`;
    let start = appSource.indexOf(asyncMarker);
    if (start < 0) start = appSource.indexOf(plainMarker);
    assert.notEqual(start, -1, `function ${name} exists`);
    const bodyStart = appSource.indexOf(') {', start) + 2;
    let depth = 0;
    for (let index = bodyStart; index < appSource.length; index++) {
        if (appSource[index] === '{') depth += 1;
        if (appSource[index] === '}') depth -= 1;
        if (depth === 0) return appSource.slice(start, index + 1);
    }
    throw new Error(`unterminated function ${name}`);
}

function element() {
    return {
        disabled: false,
        title: '',
        accept: '',
        textContent: '',
        classList: {
            values: new Set(),
            add(value) { this.values.add(value); },
            remove(value) { this.values.delete(value); },
            contains(value) { return this.values.has(value); },
            toggle(value, force) {
                if (force) this.values.add(value);
                else this.values.delete(value);
            }
        },
        removeAttribute() {}
    };
}

function testCapabilityGateRequiresKermitServerMode() {
    const els = {};
    for (const name of ['keyCodeInput', 'fileInput', 'btnSyncClock', 'btnNewFolder',
        'btnDeleteSelected', 'btnReceiveBackup', 'btnScreenshot', 'btnRefreshDirlist',
        'btnIsReady', 'btnReceiveOs', 'btnDownloadOsPartial', 'btnDumpRom',
        'btnLeaveExam', 'btnSendFiles']) els[name] = element();
    const text = {
        dropzoneTitle: element(), dropzoneSubtitle: element(), panelVarsTitle: element()
    };
    const state = { hpLegacyKermitEnabled: false, selectedFiles: [{ name: 'A.49g' }] };
    const context = {
        state,
        els,
        document: { getElementById(id) { return text[id] || null; } },
        t(key) { return key; },
        setTextContent(target, value) { target.textContent = value; },
        updateKeyControlsState() {},
        clearKeyMapDataList() {},
        updateSelectionActionButtons() {},
        updateSendFilesButtonState() {
            els.btnSendFiles.disabled = !state.hpLegacyKermitEnabled;
        }
    };
    vm.createContext(context);
    vm.runInContext(extractFunction('setHPLegacyUiState'), context);

    context.setHPLegacyUiState();
    assert.equal(els.fileInput.disabled, true);
    assert.equal(els.btnRefreshDirlist.disabled, true);
    assert.equal(els.btnScreenshot.disabled, true);
    assert.equal(els.btnDeleteSelected.disabled, true);
    assert.equal(text.dropzoneSubtitle.textContent, 'hp_legacy_xmodem_only_hint');

    state.hpLegacyKermitEnabled = true;
    context.setHPLegacyUiState();
    assert.equal(els.fileInput.disabled, false);
    assert.equal(els.btnRefreshDirlist.disabled, false);
    assert.equal(els.btnScreenshot.disabled, false,
        'Kermit selection exposes RHOST LCD screenshot capture');
    assert.equal(els.btnDeleteSelected.disabled, true,
        'Kermit selection does not expose rhost-backed deletion');
    assert.equal(text.dropzoneSubtitle.textContent, 'hp_legacy_dropzone_subtitle');
}

function testDisconnectIsolationForRawUsbAndSerial() {
    const usb = { vendorId: 0x03F0, productId: 0x0121 };
    const port = { getInfo() { return { usbVendorId: 0x03F0, usbProductId: 0x0121 }; } };
    const unrelated = { vendorId: 0x0451, productId: 0xE003 };
    const state = { authorizedDevice: usb, numWorksBackend: null };
    const context = {
        state,
        isHPLegacyActive() { return true; },
        isCasioActive() { return false; }
    };
    vm.createContext(context);
    vm.runInContext(extractFunction('isTransportEventForActiveDevice'), context);
    assert.equal(context.isTransportEventForActiveDevice({ device: usb }), true);
    assert.equal(context.isTransportEventForActiveDevice({ device: unrelated }), false);

    state.authorizedDevice = { transport: 'serial', serialPort: port };
    assert.equal(context.isTransportEventForActiveDevice({ target: port }), true);
    assert.equal(context.isTransportEventForActiveDevice({ target: {} }), false);
}

function testDetectedModelReplacesAmbiguousUsbLabel() {
    const state = {
        hpLegacyKermitEnabled: true,
        hpLegacyModelInfo: {
            modelId: 'hp50g', modelName: 'HP 50g',
            versionText: 'HP50-C Revision #2.15',
            serialText: 'HP50 Serial Number: CNA6110007'
        }
    };
    const els = { memoryInfo: element() };
    let rendered = null;
    let displayed = null;
    const context = {
        state,
        els,
        isHPLegacySerialDevice() { return false; },
        renderDeviceInfo(entries) { rendered = entries; },
        updateDeviceModelDisplay(model) { displayed = model; }
    };
    vm.createContext(context);
    vm.runInContext(extractFunction('readHPLegacyInfo'), context);
    context.readHPLegacyInfo();
    assert.equal(state.deviceModelName, 'HP 50g');
    assert.equal(displayed, 'HP 50g');
    assert.ok(rendered.some(entry => entry.key === 'Detected model'
        && entry.value === 'HP 50g'));
    assert.ok(rendered.some(entry => entry.key === 'VERSION response'
        && entry.value === 'HP50-C Revision #2.15'));
    assert.deepEqual(Array.from(rendered, entry => entry.key), [
        'USB identity', 'Detected model', 'SERIAL', 'VERSION response', 'Protocol'
    ]);
    assert.equal(rendered[2].value, 'HP50 Serial Number: CNA6110007');
    assert.ok(!rendered.some(entry => entry.key === 'Transport'));
    assert.ok(!rendered.some(entry => entry.key === 'Hardware validation'));
    assert.ok(!rendered.some(entry => entry.key === 'Possible models'));
}

function testUnknownModelIsReportedWithoutClaimingExactDetection() {
    const state = {
        hpLegacyKermitEnabled: true,
        hpLegacyModelInfo: {
            modelId: null, modelName: null,
            versionText: 'Future HP Kermit firmware'
        }
    };
    const els = { memoryInfo: element() };
    let rendered = null;
    const context = {
        state,
        els,
        isHPLegacySerialDevice() { return false; },
        renderDeviceInfo(entries) { rendered = entries; },
        updateDeviceModelDisplay() {}
    };
    vm.createContext(context);
    vm.runInContext(extractFunction('readHPLegacyInfo'), context);
    context.readHPLegacyInfo();
    assert.equal(state.deviceModelName,
        'Legacy HP Kermit calculator (model unrecognized)');
    assert.ok(rendered.some(entry => entry.key === 'Model probe'
        && entry.value === 'Unrecognized VERSION response'));
    assert.ok(rendered.some(entry => entry.key === 'VERSION response'
        && entry.value === 'Future HP Kermit firmware'));
    assert.ok(rendered.some(entry => entry.key === 'Protocol'
        && entry.value === 'Classic Kermit (model unrecognized)'));
    assert.ok(!rendered.some(entry => entry.key === 'Detected model'));
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

async function testConnectionReadsSerialNumberForDeviceInfo() {
    let serialReadCalls = 0;
    const events = [];
    class Backend {
        async connect(options) {
            events.push(`connect:${options.enableKermit}`);
        }
        setKermitEnabled(enabled) {
            events.push(`kermit:${enabled}`);
        }
        async detectModel() {
            events.push('detect');
            return {
                modelId: 'hp50g', modelName: 'HP 50g',
                versionText: 'HP50-C Revision #2.15'
            };
        }
        async readSerialNumber() {
            serialReadCalls += 1;
            events.push('serial');
            return 'HP50 Serial Number: CNA6110007';
        }
        async close() {}
    }
    const state = {
        hpLegacyConnectionGeneration: 0,
        hpLegacyBackend: null,
        hpLegacyKermitEnabled: false,
        hpLegacyModelInfo: null,
        authorizedDevice: null,
        connected: false
    };
    const context = {
        state,
        WebTILPHPLegacy: { HpLegacyBackend: Backend },
        navigator: { serial: null },
        confirm() {
            events.push('confirm');
            return true;
        },
        t(key) { return key; },
        log() {},
        FEATURE_FLAGS: { OPS_SCREEN: 1, OPS_DIRLIST: 2, OPS_VARS: 4 },
        DEVICE_FAMILY_HP_LEGACY: 'hp-legacy',
        applyActiveFamilyUiState() {},
        readHPLegacyInfo() {},
        renderDirlist() {},
        setConnected(value) { state.connected = value; },
        setStatus() {}
    };
    vm.createContext(context);
    vm.runInContext(extractFunction('connectHPLegacy'), context);
    const device = { vendorId: 0x03F0, productId: 0x0121 };
    await context.connectHPLegacy(false, device);
    assert.deepEqual(events, [
        'connect:false', 'confirm', 'kermit:true', 'detect', 'serial'
    ], 'the transport read must be armed before SERVER is started');
    assert.equal(serialReadCalls, 1);
    assert.equal(state.hpLegacyModelInfo.serialText,
        'HP50 Serial Number: CNA6110007');
    assert.equal(state.connected, true);
}

async function testSerialFailureDoesNotFailConnection() {
    class Backend {
        async connect() {}
        setKermitEnabled() {}
        async detectModel() {
            return {
                modelId: 'hp50g', modelName: 'HP 50g',
                versionText: 'HP50-C Revision #2.15'
            };
        }
        async readSerialNumber() {
            throw new Error('Invalid Server Cmd.');
        }
        async close() {}
    }
    const state = {
        hpLegacyConnectionGeneration: 0,
        hpLegacyBackend: null,
        hpLegacyKermitEnabled: false,
        hpLegacyModelInfo: null,
        authorizedDevice: null,
        connected: false
    };
    const logs = [];
    const context = {
        state,
        WebTILPHPLegacy: { HpLegacyBackend: Backend },
        navigator: { serial: null },
        confirm() { return true; },
        t(key) { return key; },
        log(message) { logs.push(message); },
        FEATURE_FLAGS: { OPS_SCREEN: 1, OPS_DIRLIST: 2, OPS_VARS: 4 },
        DEVICE_FAMILY_HP_LEGACY: 'hp-legacy',
        applyActiveFamilyUiState() {},
        readHPLegacyInfo() {},
        renderDirlist() {},
        setConnected(value) { state.connected = value; },
        setStatus() {}
    };
    vm.createContext(context);
    vm.runInContext(extractFunction('connectHPLegacy'), context);
    await context.connectHPLegacy(false,
        { vendorId: 0x03F0, productId: 0x0121 });
    assert.equal(state.connected, true);
    assert.deepEqual(logs, [
        'HP SERIAL information unavailable: Invalid Server Cmd.',
        'hp_legacy_connected_kermit'
    ]);
}

async function testStaleModelProbeCannotCommitConnection() {
    const detection = deferred();
    const detectionStarted = deferred();
    const instances = [];
    class Backend {
        constructor() {
            this.closeCalls = 0;
            this.serialReadCalls = 0;
            instances.push(this);
        }
        async connect() {}
        async detectModel() {
            detectionStarted.resolve();
            return detection.promise;
        }
        setKermitEnabled() {}
        async readSerialNumber() {
            this.serialReadCalls += 1;
            return 'must not be read after cancellation';
        }
        async close() {
            this.closeCalls += 1;
        }
    }
    const state = {
        hpLegacyConnectionGeneration: 0,
        hpLegacyBackend: null,
        hpLegacyKermitEnabled: false,
        hpLegacyModelInfo: null,
        authorizedDevice: null,
        connected: false
    };
    const context = {
        state,
        WebTILPHPLegacy: { HpLegacyBackend: Backend },
        navigator: { serial: null },
        confirm() { return true; },
        t(key) { return key; },
        log() {},
        FEATURE_FLAGS: { OPS_SCREEN: 1, OPS_DIRLIST: 2, OPS_VARS: 4 },
        DEVICE_FAMILY_HP_LEGACY: 'hp-legacy',
        applyActiveFamilyUiState() {},
        readHPLegacyInfo() {},
        renderDirlist() {},
        setConnected(value) { state.connected = value; },
        setStatus() {}
    };
    vm.createContext(context);
    vm.runInContext(extractFunction('connectHPLegacy'), context);
    const device = { vendorId: 0x03F0, productId: 0x0121 };
    const pending = context.connectHPLegacy(false, device);
    await detectionStarted.promise;
    state.hpLegacyConnectionGeneration += 1;
    detection.resolve({ modelId: 'hp50g', modelName: 'HP 50g', versionText: 'HP50-C' });
    await assert.rejects(pending, error => {
        assert.equal(error.hpLegacyConnectionCancelled, true);
        assert.equal(error.silent, true);
        return true;
    });
    assert.equal(instances.length, 1);
    assert.equal(instances[0].closeCalls, 1);
    assert.equal(instances[0].serialReadCalls, 0);
    assert.equal(state.hpLegacyBackend, null);
    assert.equal(state.connected, false);
}

function makeScreenshotCanvas() {
    const canvas = element();
    canvas.width = 0;
    canvas.height = 0;
    canvas.drawn = null;
    canvas.getContext = () => ({
        createImageData(width, height) {
            return { data: new Uint8ClampedArray(width * height * 4) };
        },
        putImageData(imageData) {
            canvas.drawn = Uint8ClampedArray.from(imageData.data);
        }
    });
    return canvas;
}

function makeScreenshotContext(state, canvas, logs, scaled) {
    return {
        state,
        els: { btnScreenshot: element(), screenshotCanvas: canvas },
        isHPPrimeActive() { return false; },
        isHPLegacyActive() { return state.activeFamily === 'hp-legacy'; },
        isNumWorksActive() { return false; },
        t(key) { return key; },
        log(message) { logs.push(message); },
        logError(error) { throw error; },
        setButtonLoading() {},
        updateScreenshotCanvasScale() { scaled.count += 1; }
    };
}

async function testHPLegacyScreenshotRendersIntoCanvas() {
    const rgba = Uint8ClampedArray.of(0, 0, 0, 255, 255, 255, 255, 255);
    const backend = {
        async captureScreenshot() { return { width: 2, height: 1, rgba }; }
    };
    const state = {
        activeFamily: 'hp-legacy', connected: true,
        hpLegacyKermitEnabled: true, hpLegacyBackend: backend,
        hpLegacyConnectionGeneration: 3
    };
    const canvas = makeScreenshotCanvas();
    const logs = [];
    const scaled = { count: 0 };
    const context = makeScreenshotContext(state, canvas, logs, scaled);
    vm.createContext(context);
    vm.runInContext(extractFunction('takeScreenshot'), context);
    await context.takeScreenshot();
    assert.equal(canvas.width, 2);
    assert.equal(canvas.height, 1);
    assert.deepEqual(canvas.drawn, rgba);
    assert.equal(canvas.classList.contains('filled'), true);
    assert.equal(scaled.count, 1);
    assert.deepEqual(logs, ['Screenshot captured (2x1).']);
}

async function testStaleHPLegacyScreenshotCannotRepaintCanvas() {
    const capture = deferred();
    const backend = {
        async captureScreenshot() { return capture.promise; }
    };
    const state = {
        activeFamily: 'hp-legacy', connected: true,
        hpLegacyKermitEnabled: true, hpLegacyBackend: backend,
        hpLegacyConnectionGeneration: 5
    };
    const canvas = makeScreenshotCanvas();
    const logs = [];
    const scaled = { count: 0 };
    const context = makeScreenshotContext(state, canvas, logs, scaled);
    vm.createContext(context);
    vm.runInContext(extractFunction('takeScreenshot'), context);
    const pending = context.takeScreenshot();
    state.hpLegacyBackend = null;
    state.hpLegacyConnectionGeneration += 1;
    state.connected = false;
    capture.resolve({
        width: 2,
        height: 1,
        rgba: Uint8ClampedArray.of(0, 0, 0, 255, 255, 255, 255, 255)
    });
    await pending;
    assert.equal(canvas.width, 0);
    assert.equal(canvas.height, 0);
    assert.equal(canvas.drawn, null);
    assert.equal(canvas.classList.contains('filled'), false);
    assert.equal(scaled.count, 0);
    assert.deepEqual(logs, []);
}

function setupSerialPermission({ activation = true, serialError = null, authorized = false } = {}) {
    const device = { vendorId: 0x03F0, productId: 0x0121, productName: 'HP 50g' };
    const port = { getInfo: () => ({ usbVendorId: 0x03F0, usbProductId: 0x0121 }) };
    const calls = [];
    const errors = [];
    const state = {
        settings: { cableModel: 'auto' }, hpLegacyConnectionGeneration: 0,
        pendingHPUsbDevice: null, activeFamily: 'ti', connected: false,
        handle: 0, hpLegacyBackend: null, numWorksBackend: null
    };
    class Backend {
        constructor(options) { this.options = options; }
        async connect() {
            if (this.options.usbDevice) {
                calls.push('usb connect');
                throw new DOMException('USB interface is owned by the serial driver.', 'NetworkError');
            }
            calls.push('serial connect');
        }
        async close() { calls.push('close'); }
        setKermitEnabled() {}
    }
    const context = {
        state, DOMException, console,
        WebTILPHPLegacy: { HpLegacyBackend: Backend },
        navigator: {
            userActivation: { isActive: activation },
            serial: {
                async getPorts() { calls.push('serial grants'); return authorized ? [port] : []; },
                async requestPort(options) {
                    calls.push('serial chooser');
                    assert.equal(options.filters[0].usbVendorId, 0x03F0);
                    assert.equal(options.filters[0].usbProductId, 0x0121);
                    if (serialError) throw serialError;
                    return port;
                }
            }
        },
        self: { isSecureContext: true },
        HP_VENDOR_ID: 0x03F0, HP_LEGACY_PRODUCT_ID: 0x0121,
        TI_VENDOR_ID: 0x0451, PID_TI84_EVO_SERIAL: 0xe018,
        SERIAL_KIND_EVO: 1, SERIAL_KIND_HP_LEGACY: 3, CABLE_GRAYLINK: '1',
        DEVICE_FAMILY_TI: 'ti', DEVICE_FAMILY_NUMWORKS: 'numworks',
        DEVICE_FAMILY_HP_PRIME: 'hp-prime', DEVICE_FAMILY_HP_LEGACY: 'hp-legacy',
        DEVICE_FAMILY_CASIO: 'casio',
        FEATURE_FLAGS: { OPS_SCREEN: 1, OPS_DIRLIST: 2, OPS_VARS: 4 },
        els: { btnConnect: {} },
        hasWebUsbTransport: () => true,
        async requestSupportedWebUsbDevice() { calls.push('usb chooser'); return device; },
        getWebUsbDeviceFamily: () => 'hp-legacy',
        t: key => key, confirm: () => false,
        log() {}, logError(error) { errors.push(error); },
        setStatus(key) { state.status = key; },
        setConnected(value) { state.connected = value; },
        setButtonLoading(_button, value) { state.loading = value; },
        applyActiveFamilyUiState() {}, readHPLegacyInfo() {}, renderDirlist() {},
        isHPLegacyActive: () => state.activeFamily === 'hp-legacy',
        isCasioActive: () => state.activeFamily === 'casio',
        clearActiveOperations() {}, retireModule() {},
        clearDeviceData() { state.hpLegacyConnectionGeneration += 1; }
    };
    vm.createContext(context);
    for (const name of ['serialPortToDevice', 'hpLegacySerialPortToDevice',
        'isHPLegacySerialPortInfo', 'getAuthorizedHPLegacySerialDevices',
        'requestHPLegacySerialDevice', 'connectHPLegacy', 'connect',
        'isTransportEventForActiveDevice', 'handleTransportDisconnect']) {
        vm.runInContext(extractFunction(name), context);
    }
    return { context, state, calls, errors, device, port };
}

async function testSerialPermissionRetryAndFamilySwitch() {
    const permissionStatus = 'status_hp_legacy_serial_authorization_required';
    for (const options of [
        { activation: false },
        { serialError: new DOMException('A user gesture is required to request a serial port.', 'SecurityError') }
    ]) {
        const { context, state, calls, errors, device, port } = setupSerialPermission(options);
        await context.connect();
        assert.equal(state.status, permissionStatus);
        assert.equal(state.pendingHPUsbDevice, device);
        assert.equal(state.connected, false);
        assert.equal(state.connectInProgress, false);
        assert.equal(state.loading, false);
        assert.deepEqual(errors, []);
        if (!options.activation && !options.serialError) {
            assert.equal(calls.includes('serial chooser'), false);
        }
        context.navigator.userActivation.isActive = true;
        context.navigator.serial.requestPort = async () => { calls.push('serial chooser'); return port; };
        calls.length = 0;
        const retry = context.connect();
        assert.deepEqual(calls, ['serial chooser'], 'fresh click starts authorization before any await');
        await context.connect();
        await retry;
        assert.deepEqual(calls, ['serial chooser', 'serial connect']);
        assert.equal(state.pendingHPUsbDevice, null);
        assert.equal(state.authorizedDevice.serialPort, port);
        assert.equal(state.authorizedDevice.productName, device.productName);
        assert.equal(state.connected, true);
        assert.equal(state.status, 'status_connected');
        assert.equal(state.loading, false);
    }
    for (const family of ['ti', 'numworks', 'hp-prime', 'casio']) {
        for (const completeRetry of [false, true]) {
            const { context, state, calls, errors, port } = setupSerialPermission({ activation: false });
            await context.connect();
            context.navigator.userActivation.isActive = true;
            context.navigator.serial.requestPort = async () => {
                if (completeRetry) return port;
                throw new DOMException('Chooser cancelled.', 'NotFoundError');
            };
            await context.connect();
            assert.equal(state.pendingHPUsbDevice, null);
            assert.equal(state.status, completeRetry ? 'status_connected' : 'status_select_device');
            const other = { productName: family };
            context.requestSupportedWebUsbDevice = async () => { calls.push('usb chooser'); return other; };
            context.getWebUsbDeviceFamily = () => family;
            context.connectTI = async () => { calls.push('ti'); };
            context.connectNumWorks = async () => { calls.push('numworks'); };
            context.connectHPPrime = async () => { calls.push('hp-prime'); };
            context.connectCasio = async () => { calls.push('casio'); };
            context.navigator.serial.requestPort = async () => { throw new Error('Stale HP chooser'); };
            calls.length = 0;
            await context.connect();
            assert.deepEqual(calls, ['usb chooser', family]);
            assert.equal(state.authorizedDevice, other);
            assert.deepEqual(errors, []);
        }
    }
}

async function testSerialPermissionCancellationAndDisconnect() {
    const cancelled = setupSerialPermission({ serialError: new DOMException('Cancelled.', 'NotFoundError') });
    await cancelled.context.connect();
    assert.equal(cancelled.state.status, 'status_select_device');
    assert.equal(cancelled.state.pendingHPUsbDevice, null);
    assert.deepEqual(cancelled.errors, []);

    const authorized = setupSerialPermission({ activation: false, authorized: true });
    await authorized.context.connect();
    assert.equal(authorized.state.connected, true);
    assert.equal(authorized.calls.includes('serial chooser'), false);

    const policyError = new DOMException('Access denied by permissions policy.', 'SecurityError');
    const blocked = setupSerialPermission({ serialError: policyError });
    await blocked.context.connect();
    assert.equal(blocked.state.status, 'status_connection_failed');
    assert.equal(blocked.state.pendingHPUsbDevice, null);
    assert.ok(blocked.errors.includes(policyError));

    const grantLookup = setupSerialPermission({ activation: false });
    const grants = deferred();
    const grantsStarted = deferred();
    grantLookup.context.navigator.serial.getPorts = () => {
        grantsStarted.resolve();
        return grants.promise;
    };
    const lookupConnection = grantLookup.context.connect();
    await grantsStarted.promise;
    grantLookup.context.handleTransportDisconnect({ device: grantLookup.device });
    grants.resolve([]);
    await lookupConnection;
    assert.equal(grantLookup.state.pendingHPUsbDevice, null);
    assert.equal(grantLookup.state.status, 'status_disconnected');
    assert.equal(grantLookup.calls.includes('serial chooser'), false,
        'disconnect during grant lookup must not create a fresh permission retry');
    assert.deepEqual(grantLookup.errors, []);

    for (const duringChooser of [false, true]) {
        const { context, state, calls, errors, device, port } = setupSerialPermission({ activation: false });
        await context.connect();
        const chooser = deferred();
        let retry;
        if (duringChooser) {
            context.navigator.userActivation.isActive = true;
            context.navigator.serial.requestPort = () => { calls.push('serial chooser'); return chooser.promise; };
            retry = context.connect();
        }
        context.handleTransportDisconnect({ device });
        assert.equal(state.pendingHPUsbDevice, null);
        assert.equal(state.status, 'status_disconnected');
        if (duringChooser) {
            chooser.resolve(port);
            await retry;
        }
        assert.equal(state.connected, false);
        assert.equal(state.hpLegacyBackend, null);
        assert.equal(state.status, 'status_disconnected', 'late chooser result cannot reconnect a disconnected calculator');
        assert.equal(calls.includes('serial connect'), false);
        assert.deepEqual(errors, []);
    }
}

async function testOldSerialChooserCannotClearReplacementAttempt() {
    for (const replacementChooserOpen of [false, true]) {
        const { context, state, calls, errors, device, port } = setupSerialPermission({ activation: false });
        await context.connect();
        const oldChooser = deferred();
        context.navigator.userActivation.isActive = true;
        context.navigator.serial.requestPort = () => oldChooser.promise;
        const oldRetry = context.connect();
        context.handleTransportDisconnect({ device });

        const replacementDevice = { ...device, productName: 'Replacement HP' };
        context.requestSupportedWebUsbDevice = async () => replacementDevice;
        context.navigator.userActivation.isActive = false;
        await context.connect();
        assert.equal(state.pendingHPUsbDevice, replacementDevice);
        let replacementRetry;
        const replacementChooser = deferred();
        if (replacementChooserOpen) {
            context.navigator.userActivation.isActive = true;
            context.navigator.serial.requestPort = () => replacementChooser.promise;
            replacementRetry = context.connect();
            assert.equal(state.connectInProgress, true);
            assert.equal(state.loading, true);
        }
        oldChooser.resolve(port);
        await oldRetry;
        assert.equal(state.pendingHPUsbDevice, replacementDevice,
            'an old cancelled chooser must not clear a newer USB selection');
        assert.equal(state.status, 'status_hp_legacy_serial_authorization_required');
        assert.equal(state.connectInProgress, replacementChooserOpen,
            'an old finally block must not unlock a newer connection attempt');
        assert.equal(state.loading, replacementChooserOpen,
            'an old finally block must not clear the new Connect button spinner');
        assert.equal(calls.includes('serial connect'), false);
        if (replacementChooserOpen) {
            replacementChooser.resolve(port);
            await replacementRetry;
            assert.equal(state.connected, true);
            assert.equal(state.authorizedDevice.productName, 'Replacement HP');
            assert.equal(state.connectInProgress, false);
            assert.equal(state.loading, false);
        }
        assert.deepEqual(errors, []);
    }
}

async function testUploadPromptPreservesNativeNameBytes() {
    const nativeName = '\xA0HP\xA0';
    const sent = [];
    const state = {
        hpLegacyKermitEnabled: true,
        hpLegacyBackend: {
            async sendFile(name, data) { sent.push([name, Array.from(data)]); }
        }
    };
    const context = {
        state, confirm: () => true,
        prompt(_message, suggestedName) {
            assert.equal(suggestedName, nativeName);
            return ` \t${suggestedName}\t `;
        },
        t: key => key, tFormat: key => key, log() {},
        setSelectedFiles() {}, async refreshDirlist() {}
    };
    vm.createContext(context);
    vm.runInContext(extractFunction('sendHPLegacyFiles'), context);
    await context.sendHPLegacyFiles([{
        name: `${nativeName}.49g`,
        async arrayBuffer() { return Uint8Array.of(1, 2).buffer; }
    }]);
    assert.deepEqual(sent, [[nativeName, [1, 2]]],
        'the upload prompt removes ASCII padding without stripping native byte 0xA0');
}

(async () => {
    testCapabilityGateRequiresKermitServerMode();
    testDisconnectIsolationForRawUsbAndSerial();
    testDetectedModelReplacesAmbiguousUsbLabel();
    testUnknownModelIsReportedWithoutClaimingExactDetection();
    await testConnectionReadsSerialNumberForDeviceInfo();
    await testSerialFailureDoesNotFailConnection();
    await testStaleModelProbeCannotCommitConnection();
    await testHPLegacyScreenshotRendersIntoCanvas();
    await testStaleHPLegacyScreenshotCannotRepaintCanvas();
    await testSerialPermissionRetryAndFamilySwitch();
    await testSerialPermissionCancellationAndDisconnect();
    await testOldSerialChooserCannotClearReplacementAttempt();
    await testUploadPromptPreservesNativeNameBytes();
    console.log('Old HP frontend regression tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
