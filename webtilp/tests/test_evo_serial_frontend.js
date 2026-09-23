'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const appSource = fs.readFileSync(require.resolve('../app.js'), 'utf8');

function extractFunction(name) {
    let start = appSource.indexOf(`async function ${name}(`);
    if (start < 0) start = appSource.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `function ${name} exists`);
    const bodyStart = appSource.indexOf(') {', start) + 2;
    let depth = 0;
    for (let index = bodyStart; index < appSource.length; index++) {
        if (appSource[index] === '{') depth++;
        if (appSource[index] === '}') depth--;
        if (!depth) return appSource.slice(start, index + 1);
    }
    throw new Error(`unterminated function ${name}`);
}

function setup({ activation = true, authorized = false, serialError = null } = {}) {
    const usbDevice = { vendorId: 0x0451, productId: 0xe018, productName: 'TI-84 Plus Evo' };
    const port = { getInfo: () => ({ usbVendorId: 0x0451, usbProductId: 0xe018 }) };
    const calls = [];
    const errors = [];
    const alerts = [];
    const state = { settings: { cableModel: 'auto' }, connected: false, handle: 0 };
    const context = {
        state, DOMException,
        console: { log() {}, warn() {}, error(...args) { errors.push(args); } },
        self: { isSecureContext: true },
        navigator: {
            userActivation: { isActive: activation },
            serial: {
                async getPorts() { return authorized ? [port] : []; },
                async requestPort(options) {
                    calls.push('serial chooser');
                    assert.equal(options.filters[0].usbProductId, 0xe018);
                    if (serialError) throw serialError;
                    if (context.navigator.userActivation?.isActive === false) {
                        throw new DOMException('Must be handling a user gesture', 'SecurityError');
                    }
                    return port;
                }
            }
        },
        TI_VENDOR_ID: 0x0451, PID_TI84_EVO_SERIAL: 0xe018,
        SERIAL_KIND_EVO: 1, CABLE_GRAYLINK: '1',
        DEVICE_FAMILY_TI: 'ti', DEVICE_FAMILY_NUMWORKS: 'numworks', DEVICE_FAMILY_HP_PRIME: 'hp-prime',
        els: { btnConnect: {} },
        t: key => key,
        alert(message) { alerts.push(message); },
        setButtonLoading(_button, loading) { state.loading = loading; },
        setStatus(key) { state.status = key; },
        setConnected(value) { state.connected = value; },
        log() {}, logError(error) { errors.push(error); },
        hasWebUsbTransport: () => true,
        async requestSupportedWebUsbDevice() { calls.push('usb chooser'); return usbDevice; },
        getWebUsbDeviceFamily: () => 'ti',
        applyActiveFamilyUiState() {},
        async initModule() { calls.push('module'); return {}; },
        updateDeviceModelDisplay() {},
        promptCableMismatchResolution: () => false,
        ensureSilverlinkModelSelected: () => true,
        async ensureCableOpen() { calls.push('open cable'); state.cableOpen = true; },
        async updateCapabilities() {}, async getDeviceInfo() {},
        isTi92Selected: () => false,
        hasSilverlinkConnected: () => false
    };
    vm.createContext(context);
    for (const name of ['serialPortToDevice', 'isSerialDevice', 'isEvoUsbDevice',
        'isEvoSerialDeviceInfo', 'requestTIEvoSerialDevice', 'getAuthorizedSerialDevices',
        'getAuthorizedEvoSerialDevice', 'requestEvoSerialForUsbDevice',
        'bindSerialPortToModule', 'authorizeDevice', 'connectTI', 'connect']) {
        vm.runInContext(extractFunction(name), context);
    }
    return { context, state, calls, errors, alerts, usbDevice, port };
}

async function main() {
    const permissionStatus = 'status_evo_serial_authorization_required';
    for (const options of [
        { activation: false },
        { serialError: new DOMException('No port selected by the user.', 'NotFoundError') },
        { serialError: new DOMException("Failed to execute 'requestPort' on 'Serial': Must be handling a user gesture to show a permission request.", 'SecurityError') }
    ]) {
        const { context, state, calls, errors, alerts, usbDevice, port } = setup(options);
        await context.connect();
        assert.equal(state.status, permissionStatus);
        assert.equal(state.connected, false);
        assert.equal(state.connectInProgress, false);
        assert.equal(state.loading, false);
        assert.equal(state.pendingEvoUsbDevice, usbDevice);
        assert.equal(errors.length, 0, 'gesture expiry is a recoverable authorization step');
        assert.equal(calls.includes('open cable'), false);
        assert.equal(calls.includes('serial chooser'), true, 'attempt serial authorization automatically');
        assert.equal(calls.filter(call => call === 'serial chooser').length,
            options.serialError?.name === 'NotFoundError' ? 2 : 1,
            'retry a missing selection automatically once, but defer gesture errors to a fresh click');
        assert.deepEqual(alerts, ['alert_evo_serial_authorization_required']);

        context.navigator.userActivation.isActive = true;
        calls.length = 0;
        context.navigator.serial.requestPort = async () => { calls.push('serial chooser'); return port; };
        const retry = context.connect();
        assert.deepEqual(calls, ['serial chooser'], 'retry requests permission synchronously before any await');
        await context.connect(); // Ignore a second click while authorization is running.
        await retry;
        assert.deepEqual(calls, ['serial chooser', 'module', 'open cable']);
        assert.equal(state.status, 'status_connected');
        assert.equal(state.connected, true);
        assert.equal(state.authorizedDevice.serialPort, port);
        assert.equal(state.authorizedDevice.productName, usbDevice.productName);
        assert.equal(state.pendingEvoUsbDevice, null);
        assert.equal(state.loading, false);
        assert.equal(alerts.length, 1, 'successful retry does not repeat the alert');
    }

    for (const family of ['ti', 'numworks', 'hp-prime']) {
        for (const finishEvoConnection of [false, true]) {
            const { context, state, calls, errors, alerts, port } = setup({
                serialError: new DOMException('No port selected by the user.', 'NotFoundError')
            });
            await context.connect();
            assert.equal(state.status, permissionStatus);

            context.navigator.userActivation.isActive = true;
            context.navigator.serial.requestPort = async () => {
                if (finishEvoConnection) return port;
                throw new DOMException('Cancelled', 'NotFoundError');
            };
            await context.connect();
            assert.equal(state.pendingEvoUsbDevice, null,
                'both successful and cancelled serial authorization release the pending selection');
            assert.equal(alerts.length, 1, 'cancelling the fresh-click chooser does not restart the retry flow');
            assert.equal(state.status, finishEvoConnection ? 'status_connected' : 'status_select_device');
            assert.equal(state.loading, false);

            const otherDevice = family === 'ti'
                ? { vendorId: 0x0451, productId: 0xe022 }
                : family === 'numworks'
                    ? { vendorId: 0x0483, productId: 0xa291 }
                    : { vendorId: 0x03f0, productId: 0x2441 };
            calls.length = 0;
            context.requestSupportedWebUsbDevice = async () => { calls.push('usb chooser'); return otherDevice; };
            context.getWebUsbDeviceFamily = () => family;
            context.connectNumWorks = async forcePrompt => {
                assert.equal(forcePrompt, false);
                calls.push('numworks');
            };
            context.connectHPPrime = async (forcePrompt, device) => {
                assert.equal(forcePrompt, true);
                assert.equal(device, otherDevice);
                calls.push('hp-prime');
            };
            context.navigator.serial.requestPort = async () => { throw new Error('Unexpected serial chooser'); };
            await context.connect();
            assert.deepEqual(calls, family === 'ti'
                ? ['usb chooser', 'module', 'open cable']
                : ['usb chooser', family]);
            assert.equal(state.authorizedDevice, otherDevice);
            assert.equal(errors.length, 0);
        }
    }

    const authorized = setup({ activation: false, authorized: true });
    await authorized.context.connect();
    assert.equal(authorized.state.connected, true);
    assert.equal(authorized.calls.includes('serial chooser'), false, 'existing serial grants need no gesture');
    assert.deepEqual(authorized.alerts, []);

    for (const activation of [true, false, undefined]) {
        const automatic = setup({ activation });
        if (activation === undefined) delete automatic.context.navigator.userActivation;
        automatic.context.navigator.serial.requestPort = async () => {
            automatic.calls.push('serial chooser');
            return automatic.port;
        };
        await automatic.context.connect();
        assert.equal(automatic.state.connected, true, 'accept automatic authorization when the browser allows it');
        assert.deepEqual(automatic.calls, ['usb chooser', 'module', 'serial chooser', 'open cable']);
        assert.equal(automatic.state.authorizedDevice.productName, automatic.usbDevice.productName);
        assert.deepEqual(automatic.alerts, []);
    }

    for (const retryNeedsGesture of [false, true]) {
        const automaticRetry = setup();
        let attempts = 0;
        automaticRetry.context.navigator.serial.requestPort = async options => {
            attempts++;
            assert.equal(options.filters[0].usbVendorId, 0x0451);
            assert.equal(options.filters[0].usbProductId, 0xe018);
            if (attempts === 1) throw new DOMException('No port selected by the user.', 'NotFoundError');
            if (retryNeedsGesture) throw new DOMException('Must be handling a user gesture', 'SecurityError');
            return automaticRetry.port;
        };
        await automaticRetry.context.connect();
        assert.equal(attempts, 2);
        assert.equal(automaticRetry.state.connected, !retryNeedsGesture);
        assert.equal(automaticRetry.state.status, retryNeedsGesture ? permissionStatus : 'status_connected');
        assert.deepEqual(automaticRetry.alerts, retryNeedsGesture ? ['alert_evo_serial_authorization_required'] : []);
        assert.equal(automaticRetry.errors.length, 0);
        if (!retryNeedsGesture) assert.equal(automaticRetry.state.authorizedDevice.serialPort, automaticRetry.port);
    }

    const direct = setup();
    const directSelection = direct.context.requestTIEvoSerialDevice();
    assert.deepEqual(direct.calls, ['serial chooser'], 'serial-only authorization prompts before any await');
    assert.equal((await directSelection).serialPort, direct.port);

    const expired = setup({ activation: false });
    await expired.context.connect();
    expired.context.navigator.userActivation.isActive = true;
    expired.context.navigator.serial.requestPort = async () => {
        throw new DOMException('Must be handling a user gesture', 'SecurityError');
    };
    await expired.context.connect();
    assert.equal(expired.state.status, permissionStatus, 'gesture errors on the second click remain recoverable');
    assert.equal(expired.state.pendingEvoUsbDevice, expired.usbDevice);
    assert.equal(expired.errors.length, 0);
    assert.equal(expired.alerts.length, 2);

    for (const name of ['SecurityError', 'NetworkError']) {
        const genuineError = new DOMException('Access denied by permissions policy', name);
        const blocked = setup({ serialError: genuineError });
        await blocked.context.connect();
        assert.equal(blocked.state.status, 'status_connection_failed');
        assert.deepEqual(blocked.alerts, [], 'unrelated errors do not ask for a permission retry');
        assert.ok(blocked.errors.includes(genuineError), 'unrelated errors remain visible');
    }
    console.log('Evo serial authorization frontend tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
