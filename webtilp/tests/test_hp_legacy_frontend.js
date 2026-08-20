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
    console.log('Old HP frontend regression tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
