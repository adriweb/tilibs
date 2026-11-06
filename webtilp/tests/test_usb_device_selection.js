'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');

function extract(name) {
    let start = source.indexOf(`async function ${name}(`);
    if (start < 0) start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, name);
    const body = source.indexOf(') {', start) + 2;
    let depth = 0;
    for (let i = body; i < source.length; i++) {
        if (source[i] === '{') depth++;
        if (source[i] === '}') depth--;
        if (!depth) return source.slice(start, i + 1);
    }
    throw new Error(`Unterminated ${name}`);
}

async function main() {
    const evo = {vendorId: 0x0451, productId: 0xe018, productName: 'TI-84 Evo'};
    const ce = {vendorId: 0x0451, productId: 0xe008, productName: 'TI-84 Plus CE'};
    const secondCe = {...ce};
    let devices = [evo, ce, secondCe], enumerations = 0, prompts = 0;
    const state = {settings: {calcModel: 'auto', cableModel: 'auto'}, progressOps: new Map()};
    const calls = [];
    const context = vm.createContext({
        state, console, webUsbSelections: new WeakMap(),
        navigator: {usb: {async getDevices() { enumerations++; return devices.slice(); }}},
        CABLE_GRAYLINK: '1', DEVICE_FAMILY_TI: 'ti',
        getWebUsbDeviceFamily: device => device.vendorId === 0x0451 ? 'ti' : null,
        isEvoUsbDevice: device => device.productId === 0xe018,
        initModule: async () => ({}), hasSilverlinkConnected: () => false,
        requestTICalculatorDevice: async () => { prompts++; return ce; },
        requestEvoSerialForUsbDevice: async device => device,
        log() {}, updateDeviceModelDisplay() {},
        hasAnySupportedTransport: () => true,
        getAuthorizedSupportedWebUsbDevices: async () => devices,
        setStatus: status => calls.push(status),
        DEVICE_FAMILY_NUMWORKS: 'numworks', DEVICE_FAMILY_HP_PRIME: 'hp-prime',
        retireModule: () => calls.push('retire'), clearDeviceData: () => calls.push('clear'),
        applyActiveFamilyUiState() {}, clearActiveOperations() {},
        setConnected: value => { state.connected = value; },
        isHPPrimeActive: () => false,
        getModuleCallState: () => ({tail: Promise.resolve()}),
        ccallAsync: async (_module, name) => calls.push(name)
    });
    for (const name of ['getAuthorizedWebUsbDevices', 'bindWebUsbDeviceSelection',
        'getAuthorizedDevices', 'isSerialDevice', 'deviceMatches', 'authorizeDevice',
        'autoConnectIfAuthorized', 'releaseDeviceForSwitch', 'isUnrelatedTransportEvent',
        'handleTransportConnect', 'handleTransportDisconnect']) {
        vm.runInContext(extract(name), context);
    }

    context.bindWebUsbDeviceSelection(ce);
    assert.deepEqual([...(await context.navigator.usb.getDevices())], [ce]);
    assert.deepEqual([...(await context.getAuthorizedWebUsbDevices())], devices,
        'permission discovery still includes every calculator');
    context.bindWebUsbDeviceSelection(secondCe);
    assert.deepEqual([...(await context.navigator.usb.getDevices())], [secondCe],
        'identical model names do not conflate two USB devices');
    devices = [evo, ce];
    assert.deepEqual([...(await context.navigator.usb.getDevices())], [],
        'unplugging the selection cannot route I/O to another calculator');

    context.bindWebUsbDeviceSelection(ce);
    const pending = context.navigator.usb.getDevices();
    context.bindWebUsbDeviceSelection(evo);
    assert.deepEqual([...(await pending)], [], 'switching invalidates an in-flight enumeration');
    context.bindWebUsbDeviceSelection(ce);
    state.authorizedDevice = ce;
    state.connected = true;
    const before = enumerations;
    assert.equal(await context.authorizeDevice(), ce);
    assert.equal(enumerations, before, 'operations preserve the established session without choosing again');
    state.connected = false;
    assert.equal(await context.authorizeDevice(), ce, 'reopening preserves the exact selection');

    state.authorizedDevice = null;
    assert.equal(await context.authorizeDevice(), ce);
    assert.equal(prompts, 1, 'several permitted devices require an explicit choice');
    state.authorizedDevice = secondCe;
    assert.equal(await context.authorizeDevice(), ce);
    assert.equal(prompts, 2, 'a missing previous device requires another explicit choice');

    state.authorizedDevice = null;
    await context.autoConnectIfAuthorized();
    assert.equal(calls.pop(), 'status_select_device');
    assert.equal(state.authorizedDevice, null, 'multiple devices do not auto-connect');

    state.authorizedDevice = ce;
    state.connected = true;
    const module = state.module = {};
    context.handleTransportConnect({device: evo});
    context.handleTransportDisconnect({device: secondCe});
    assert.equal(state.module, module);
    assert.equal(state.authorizedDevice, ce);
    assert.equal(state.connected, true, 'other calculators may connect/disconnect without disturbing this session');

    const port = {};
    state.authorizedDevice = {transport: 'serial', serialKind: 1, serialPort: port, usbDevice: evo};
    assert.equal(context.isUnrelatedTransportEvent({port: {}}), true);
    assert.equal(context.isUnrelatedTransportEvent({port}), false);
    assert.equal(context.isUnrelatedTransportEvent({device: ce}), true);
    assert.equal(context.isUnrelatedTransportEvent({device: evo}), false);

    state.authorizedDevice = ce;
    calls.length = 0;
    await context.releaseDeviceForSwitch(ce);
    assert.deepEqual(calls, [], 'choosing the same device keeps its working connection');
    await context.releaseDeviceForSwitch(evo);
    assert.deepEqual(calls, ['cleanup', 'retire', 'clear']);
    assert.equal(state.module, null);
    assert.equal(state.authorizedDevice, null);
    assert.equal(state.connected, false);

    context.isHPPrimeDevice = device => device?.family === 'hp';
    context.isNumWorksDevice = device => device?.family === 'nw';
    const hp = {family: 'hp'}, nw = {family: 'nw'};
    context.getAuthorizedHPPrimeDevices = async () => [{family: 'hp'}, hp];
    context.getAuthorizedNumWorksDevices = async () => [{family: 'nw'}, nw];
    context.requestHPPrimeDevice = async () => hp;
    context.requestNumWorksDevice = async () => nw;
    context.t = key => key;
    vm.runInContext(extract('authorizeHPPrimeDevice'), context);
    vm.runInContext(extract('authorizeNumWorksDevice'), context);
    assert.equal(await context.authorizeHPPrimeDevice(), hp, 'multiple HP Primes use the chooser');
    state.authorizedDevice = null;
    assert.equal(await context.authorizeNumWorksDevice(), nw, 'multiple NumWorks devices use the chooser');
    console.log('USB device selection: exact binding, ambiguity, disconnects, switching and session retention passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
