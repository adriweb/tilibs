'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const sharp = require('../sharp_backend.js');
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
function extract(name) {
    let start = source.indexOf(`async function ${name}(`);
    if (start < 0) start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, name);
    let depth = 0;
    for (let i = source.indexOf(') {', start) + 2; i < source.length; i++) {
        if (source[i] === '{') depth++;
        if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
    }
    throw new Error(`Missing body ${name}`);
}
function element() {
    return { disabled: false, title: '', accept: '', textContent: '', style: {}, removeAttribute() {},
        classList: { set: new Set(), add(...v) { v.forEach(x => this.set.add(x)); }, remove(...v) { v.forEach(x => this.set.delete(x)); },
            toggle(v, active) { if (active) this.set.add(v); else this.set.delete(v); } } };
}
function context(extra = {}) {
    const c = { state: { settings: { calcModel: 'auto', cableModel: 'auto' }, sharpConnectionGeneration: 0 },
        DEVICE_FAMILY_SHARP: 'sharp', SERIAL_KIND_SHARP: 4, SHARP_VENDOR_ID: 0x04FC, SHARP_PRODUCT_ID: 0x0201,
        DEVICE_FAMILY_TI: 'ti', DEVICE_FAMILY_NUMWORKS: 'numworks', DEVICE_FAMILY_CASIO: 'casio',
        DEVICE_FAMILY_HP_PRIME: 'hp-prime', DEVICE_FAMILY_HP_LEGACY: 'hp-legacy',
        CABLE_GRAYLINK: '1', SERIAL_KIND_EVO: 1,
        WebTILPSharp: sharp, navigator: { serial: null }, self: { isSecureContext: true },
        console, Blob, Uint8Array, DOMException,
        t: key => key, tFormat: (key, data) => key + JSON.stringify(data),
        log() {}, logError(error) { throw error; }, alert() {}, confirm: () => true,
        setButtonLoading() {}, setStatus() {}, setConnected(value) { c.state.connected = value; },
        applyActiveFamilyUiState() {}, hasWebUsbTransport: () => true,
        isHPPrimeActive: () => false, isHPLegacyActive: () => false, isNumWorksActive: () => false, isCasioActive: () => false,
        isHPLegacyDevice: () => false, isHPPrimeDevice: () => false, isNumWorksDevice: () => false, isCasioDevice: () => false,
        startProgress() {}, stopProgress() {}, renderDirlist() {}, readSharpInfo() {}, refreshProgressDetails() {},
        FEATURE_FLAGS: { OPS_SCREEN: 4, OPS_DIRLIST: 8, OPS_VARS: 32, OPS_BACKUP: 16, OPS_ROMDUMP: 512, OPS_OS: 8192 },
        els: { btnConnect: element() }, ...extra };
    vm.createContext(c);
    for (const name of ['serialPortToDevice', 'sharpSerialDevice', 'getAuthorizedSharpSerialDevices', 'requestSharpSerialDevice',
        'connectSharp', 'connect', 'getWebUsbDeviceFamily', 'isTransportEventForActiveDevice', 'runSharpOperation',
        'buildEntryFromCheckbox', 'sendSharpFiles', 'saveSharpDownload']) vm.runInContext(extract(name), c);
    return c;
}
async function main() {
    assert.equal(sharp.isSharpUsbDevice({ vendorId: 0x04FC, productId: 0x0201 }), true);
    const c = context();
    assert.equal(c.getWebUsbDeviceFamily({ vendorId: 0x04FC, productId: 0x0201 }), 'sharp');
    // Selected Sharp model bypasses USB and goes directly to serial on the click.
    let requests = 0, opens = 0;
    const port = { getInfo: () => ({ usbVendorId: 0x04FC, usbProductId: 0x0201 }) };
    class Backend {
        constructor(options) { this.options = options; this.port = options.serialPort; this.model = options.model; }
        async connect() { opens++; } async close() { this.closed = true; }
    }
    c.WebTILPSharp = { ...sharp, SharpBackend: Backend };
    c.navigator.serial = { getPorts: async () => [], requestPort: async options => {
        requests++; assert.equal(options.filters[0].usbVendorId, 0x04FC); return port;
    } };
    c.state.settings.calcModel = 'sharp-el9950';
    c.requestSupportedWebUsbDevice = () => { throw new Error('Sharp model must bypass the USB chooser'); };
    await c.connect(); assert.equal(requests, 1); assert.equal(opens, 1); assert.equal(c.state.activeFamily, 'sharp');
    assert.equal(c.state.sharpBackend.model, 'sharp-el9950');
    assert.equal(c.state.features & (1 << 6), 0, 'no flash capability');
    const backend = c.state.sharpBackend;
    // Port and discovery USB events are isolated from unrelated calculators.
    const usb = { vendorId: 0x04FC, productId: 0x0201 };
    c.state.authorizedDevice.usbDevice = usb;
    assert.equal(c.isTransportEventForActiveDevice({ port }), true);
    assert.equal(c.isTransportEventForActiveDevice({ device: usb }), true);
    assert.equal(c.isTransportEventForActiveDevice({ device: {} }), false);
    // Chained chooser SecurityError retains discovery for a fresh-click retry.
    c.state.settings.calcModel = 'auto'; c.state.connected = false; c.state.cableOpen = false;
    c.navigator.serial.requestPort = async () => { throw new DOMException('User activation expired', 'SecurityError'); };
    c.requestSupportedWebUsbDevice = async () => usb;
    await c.connect(); assert.equal(c.state.pendingSharpUsbDevice, usb);
    c.navigator.serial.requestPort = async () => port;
    c.requestSupportedWebUsbDevice = () => { throw new Error('retry must not repeat USB chooser'); };
    await c.connect(); assert.equal(c.state.pendingSharpUsbDevice, null);
    assert.equal(backend.closed, true, 'replacing a Sharp session closes the previous port');
    // Cancel chooser clears pending state without publishing a new backend.
    c.state.pendingSharpUsbDevice = usb;
    c.navigator.serial.requestPort = async () => { throw new DOMException('Cancelled', 'NotFoundError'); };
    await c.connect(); assert.equal(c.state.pendingSharpUsbDevice, null);
    // Ambiguous authorized ports require a chooser rather than picking the first.
    const ambiguous = context(); ambiguous.WebTILPSharp = { ...sharp, SharpBackend: Backend };
    ambiguous.navigator.serial = { getPorts: async () => [port, { ...port }], requestPort: async () => { requests++; return port; } };
    await ambiguous.connectSharp(usb); assert.equal(requests, 2);
    // A late grant after disconnect cannot publish a connection.
    let resolve;
    const stale = context(); stale.navigator.serial = { requestPort: () => new Promise(r => { resolve = r; }) };
    const grant = stale.requestSharpSerialDevice(); stale.state.sharpConnectionGeneration++; resolve(port);
    await assert.rejects(grant, error => error.sharpConnectionCancelled);
    // Opaque selectors survive table checkbox serialization.
    const entry = { kind: 'sharp', name: 'HERON', type: 112, selector: new Uint8Array(11), category: sharp.CATEGORIES[0] };
    c.state.dirlist = [entry];
    assert.equal(c.buildEntryFromCheckbox({ dataset: { kind: 'sharp', name: 'HERON', type: '112' } }), entry);
    // Invalid files cause zero writes; backup restore asks separately for memory replacement.
    let sent = 0, confirms = 0;
    c.confirm = () => { confirms++; return true; };
    c.logError = () => {};
    c.state.sharpBackend = { model: 'sharp-el9950', sendFile: async () => { sent++; } };
    await c.sendSharpFiles([{ name: 'bad.g4p', arrayBuffer: async () => new Uint8Array(3).buffer }]);
    assert.equal(sent, 0); assert.equal(confirms, 0);
    const data = new Uint8Array(54 + sharp.RAM_SIZE); data[0] = 52; data[1] = 98;
    await c.sendSharpFiles([{ name: 'backup.g4b', arrayBuffer: async () => data.buffer }]);
    assert.equal(sent, 1); assert.equal(confirms, 2);
    const programFile = sharp.encodeNative(sharp.CATEGORIES[0], Uint8Array.from([
        21, 0, 0, 0, 48, 0, 0, 0, 72, 69, 76, 76, 79, 0, 0, 0, 0, 0, 0, 0, 255
    ]), Uint8Array.from([72, 69, 76, 76, 79, 0, 0, 0, 0, 0, 0]));
    const backupFile = { name: 'backup.g4b', arrayBuffer: async () => data.buffer };
    const variableFile = { name: 'HELLO.g4p', arrayBuffer: async () => programFile.buffer };
    await c.sendSharpFiles([variableFile, backupFile]);
    assert.equal(sent, 1, 'mixed RAM restore batch is rejected before any writes');
    assert.equal(confirms, 2);
    let downloads = 0;
    c.triggerDownload = () => { downloads++; };
    c.state.connected = true;
    c.saveSharpDownload({ filename: 'HELLO.g4p', data: programFile }, backend);
    assert.equal(downloads, 0, 'a retired backend cannot download into a new connection');
    c.saveSharpDownload({ filename: 'HELLO.g4p', data: programFile }, c.state.sharpBackend);
    assert.equal(downloads, 1);
    c.state.sharpBackend.model = 'sharp-auto';
    await c.sendSharpFiles([backupFile]);
    assert.equal(sent, 1, 'exact model required in preflight');
    c.state.sharpBackend.model = 'sharp-el9950';
    const tagged = new Uint8Array(data);
    tagged.set(new TextEncoder().encode('WebTiLP sharp-el9900'), 13);
    await c.sendSharpFiles([variableFile, { name: 'backup.g4b', arrayBuffer: async () => tagged.buffer }]);
    assert.equal(sent, 1, 'model mismatch blocks all preceding variables');
    assert.equal(confirms, 2);
    // Sharp controls expose only implemented operations, and no TI native enum receives NaN.
    const ui = context(); ui.state.activeFamily = 'sharp';
    for (const name of ['keyCodeInput', 'fileInput', 'btnSyncClock', 'btnNewFolder', 'btnDeleteSelected', 'btnScreenshot',
        'btnRefreshDirlist', 'btnReceiveBackup', 'btnReceiveOs', 'btnDumpRom', 'btnIsReady', 'btnDownloadOsPartial', 'btnLeaveExam']) ui.els[name] = element();
    ui.resetFamilySpecificUiText = () => {}; ui.updateKeyControlsState = () => {}; ui.clearKeyMapDataList = () => {};
    ui.updateFileInputAccept = () => {}; ui.setTextContent = (e, t) => { e.textContent = t; };
    ui.document = { getElementById: () => element() }; ui.updateSendFilesButtonState = () => {}; ui.updateSelectionActionButtons = () => {};
    vm.runInContext(extract('setSharpUiState'), ui); ui.setSharpUiState();
    assert.equal(ui.els.btnDeleteSelected.disabled, true); assert.equal(ui.els.btnScreenshot.disabled, false);
    assert.equal(ui.els.btnDumpRom.classList.set.has('hidden'), false);
    const calls = [];
    ui.state.settings = { calcModel: 'sharp-el9950', cableModel: 'auto', cableTimeout: 10, cableDelay: 10 };
    ui.state.module = new Proxy({}, { get: (_, name) => value => calls.push([name, value]) });
    vm.runInContext(extract('applySettingsToModule'), ui); ui.applySettingsToModule();
    assert.ok(calls.some(([name, value]) => name === '_set_calc_model' && value === 0));
    assert.ok(!calls.some(([, value]) => Number.isNaN(value)));
    console.log('Sharp frontend routing, chooser retry/cancel, ambiguity, stale grants, isolation, selectors, file validation and capability tests passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
