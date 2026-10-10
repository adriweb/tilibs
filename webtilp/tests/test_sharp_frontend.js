'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const sharp = require('../sharp_backend.js');
const codec = require('../sharp_files.js');
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
        WebTILPSharp: sharp, WebTILPSharpFiles: codec, TextDecoder, TextEncoder, navigator: { serial: null }, self: { isSecureContext: true },
        console, Blob, Uint8Array, DOMException,
        t: key => key, tFormat: (key, data) => key + JSON.stringify(data),
        logs: [], log(message) { c.logs.push(message); }, logError(error) { throw error; }, alert() {}, confirm: () => true,
        setButtonLoading() {}, setStatus() {}, setConnected(value) { c.state.connected = value; },
        async releaseDeviceForSwitch() {},
        applyActiveFamilyUiState() {}, hasWebUsbTransport: () => true,
        isHPPrimeActive: () => false, isHPLegacyActive: () => false, isNumWorksActive: () => false, isCasioActive: () => false,
        isHPLegacyDevice: () => false, isHPPrimeDevice: () => false, isNumWorksDevice: () => false, isCasioDevice: () => false,
        startProgress() {}, stopProgress() {}, renderDirlist() {}, readSharpInfo() {}, refreshProgressDetails() {},
        FEATURE_FLAGS: { OPS_SCREEN: 4, OPS_DIRLIST: 8, OPS_VARS: 32, OPS_BACKUP: 16, OPS_ROMDUMP: 512, OPS_OS: 8192 },
        els: { btnConnect: element() }, ...extra };
    vm.createContext(c);
    for (const name of ['isSerialDevice', 'deviceMatches', 'serialPortToDevice', 'sharpSerialDevice', 'logSharpSerialDiagnostics', 'getAuthorizedSharpSerialDevices', 'requestSharpSerialDevice',
        'connectSharp', 'connect', 'getWebUsbDeviceFamily', 'runSharpOperation', 'getDeviceInfo',
        'buildEntryFromCheckbox', 'sendSharpFiles', 'saveSharpDownload', 'receiveSharpDump']) vm.runInContext(extract(name), c);
    return c;
}
async function main() {
    // Dump prompts select the actual REPROGRAM menu choices; recovered headers
    // are disclosed and recorded, and an unsuccessful receive downloads nothing.
    {
        const c = context(), downloads = [], prompts = [], errors = [];
        c.state.connected = true;
        c.confirm = message => { prompts.push(message); return true; };
        c.triggerDownload = (name, data) => downloads.push({name, data});
        c.logError = error => errors.push(error);
        c.state.sharpBackend = {async receiveDump({includeBoot}) {
            return {filename: includeBoot ? 'rom.bin' : 'system.bin', data: new Uint8Array(1),
                manifest: {complete: true, recoveredFirstHeader: includeBoot ? {rawPrefix: [0x18, 0x1C, 0x10, 0xFF]} : null}};
        }};
        await c.receiveSharpDump(false); await c.receiveSharpDump(true);
        assert.deepEqual(prompts, ['sharp_dump_system_notice', 'sharp_dump_rom_notice']);
        assert.deepEqual(downloads.map(d => d.name), ['system.bin', 'system.bin.json', 'rom.bin', 'rom.bin.json']);
        assert.equal(c.logs.filter(l => l === 'sharp_dump_header_recovered').length, 1);
        assert.deepEqual(JSON.parse(downloads.at(-1).data).recoveredFirstHeader.rawPrefix, [0x18, 0x1C, 0x10, 0xFF]);
        c.state.sharpBackend.receiveDump = async () => { throw new Error('bad checksum'); };
        await c.receiveSharpDump(false); assert.equal(downloads.length, 4); assert.equal(errors.length, 1);
    }
    // Auto detection updates the displayed model without changing Settings,
    // and subsequent operations preserve a previously fetched version.
    {
        const c = context(); c.state.activeFamily = 'sharp';
        c.renderDeviceInfo = () => {}; c.updateDeviceModelDisplay = () => {};
        vm.runInContext(extract('readSharpInfo'), c);
        vm.runInContext(extract('getDeviceInfo'), c);
        const backend = c.state.sharpBackend = {model: 'sharp-auto', version: null,
            async readVersion() { this.model = 'sharp-el9950'; this.version = '1.20'; return this.version; }};
        await c.getDeviceInfo();
        assert.equal(c.state.deviceModelName, 'Sharp EL-9950');
        assert.equal(c.state.settings.calcModel, 'auto');
        assert.ok(c.state.deviceInfoEntries.some(e => e.key === 'sharp_version' && e.value === '1.20'));
        await c.runSharpOperation('screenshot', async () => {});
        assert.ok(c.state.deviceInfoEntries.some(e => e.key === 'sharp_version' && e.value === '1.20'));
        await c.runSharpOperation('retired', async () => {
            c.state.sharpConnectionGeneration++; c.state.deviceModelName = 'new connection';
        });
        assert.equal(c.state.deviceModelName, 'new connection', 'late operations cannot overwrite new model info');
        assert.equal(backend.model, 'sharp-el9950');
    }
    // Actual payload progress drives the existing page percentage/bar. Control
    // frames must not erase it; unknown totals remain indeterminate.
    {
        const c = context();
        c.state.activeFamily = 'sharp';
        c.els.progressBarFill = element(); c.els.progressPercent = element(); c.els.progressRate = element();
        vm.runInContext(extract('refreshProgressDetails'), c);
        for (const [progress, expected] of [[{}, ''], [{completed: 0, total: 1056}, '0%'],
            [{completed: 528, total: 1056}, '50%'], [{completed: 1055, total: 1056}, '99%'],
            [{completed: 1056, total: 1056}, '100%'], [{completed: NaN, total: 1056}, '']]) {
            c.state.sharpProgress = progress; c.refreshProgressDetails();
            assert.equal(c.els.progressPercent.textContent, expected);
            assert.equal(c.els.progressBarFill.style.width, expected);
            assert.equal(c.els.progressBarFill.classList.set.has('determinate'), Boolean(expected));
        }
    }
    assert.equal(sharp.isSharpUsbDevice({ vendorId: 0x04FC, productId: 0x0201 }), true);
    const c = context();
    assert.equal(c.getWebUsbDeviceFamily({ vendorId: 0x04FC, productId: 0x0201 }), 'sharp');
    // Selected Sharp model bypasses USB and goes directly to serial on the click.
    let requests = 0, opens = 0;
    const port = { getInfo: () => ({ usbVendorId: 0x04FC, usbProductId: 0x0201 }) };
    class Backend {
        constructor(options) { this.options = options; this.port = options.serialPort; this.model = options.model; }
        async connect() { opens++; } async close() { this.closed = true; }
        async readVersion(options) { this.infoOptions = options; this.infoReads = (this.infoReads || 0) + 1; return null; }
    }
    c.WebTILPSharp = { ...sharp, SharpBackend: Backend };
    c.navigator.serial = { getPorts: async () => [], requestPort: async options => {
        requests++; assert.equal(options, undefined, 'explicit Sharp chooser must be unfiltered'); return port;
    } };
    c.state.settings.calcModel = 'sharp-el9950';
    c.requestSupportedWebUsbDevice = () => { throw new Error('Sharp model must bypass the USB chooser'); };
    await c.connect(); assert.equal(requests, 1); assert.equal(opens, 1); assert.equal(c.state.activeFamily, 'sharp');
    assert.equal(c.state.sharpBackend.model, 'sharp-el9950');
    assert.equal(c.state.sharpBackend.infoReads, 1, 'connection automatically refreshes device information');
    assert.equal(c.state.sharpBackend.infoOptions.keepOpenOnSilentStart, true);
    assert.equal(c.state.features & (1 << 6), 0, 'no flash capability');
    const backend = c.state.sharpBackend;
    const usb = { vendorId: 0x04FC, productId: 0x0201 };
    // Chained chooser SecurityError retains discovery for a fresh-click retry.
    c.state.settings.calcModel = 'auto'; c.state.connected = false; c.state.cableOpen = false;
    c.navigator.serial.requestPort = async () => { throw new DOMException('User activation expired', 'SecurityError'); };
    c.requestSupportedWebUsbDevice = async () => usb;
    await c.connect(); assert.equal(c.state.pendingSharpUsbDevice, usb);
    c.navigator.serial.requestPort = async () => port;
    c.requestSupportedWebUsbDevice = () => { throw new Error('retry must not repeat USB chooser'); };
    await c.connect(); assert.equal(c.state.pendingSharpUsbDevice, null);
    assert.equal(c.state.authorizedDevice.usbDevice, usb, 'fresh-click retry preserves USB discovery');
    assert.equal(backend.closed, true, 'replacing a Sharp session closes the previous port');
    // Cancel chooser clears pending state without publishing a new backend.
    c.state.pendingSharpUsbDevice = usb;
    c.navigator.serial.requestPort = async () => { throw new DOMException('Cancelled', 'NotFoundError'); };
    await c.connect(); assert.equal(c.state.pendingSharpUsbDevice, null);
    // Ambiguous authorized ports require a chooser rather than picking the first.
    const ambiguous = context(); ambiguous.WebTILPSharp = { ...sharp, SharpBackend: Backend };
    ambiguous.navigator.serial = { getPorts: async () => [port, { ...port }], requestPort: async () => { requests++; return port; } };
    await ambiguous.connectSharp(usb); assert.equal(requests, 2);
    // Unknown and alternate serial metadata remain available for manual Sharp
    // selection, but are never automatically identified as authorized Sharps.
    for (const info of [{}, { usbVendorId: 0x1234, usbProductId: 0x5678 }]) {
        const manual = context(); manual.WebTILPSharp = { ...sharp, SharpBackend: Backend };
        const unknownPort = { getInfo: () => info };
        let chooserCalls = 0;
        manual.navigator.serial = { getPorts: async () => [unknownPort], requestPort: async options => {
            assert.equal(options, undefined); chooserCalls++; return unknownPort;
        } };
        assert.equal((await manual.getAuthorizedSharpSerialDevices()).length, 0);
        await manual.connectSharp(usb);
        assert.equal(chooserCalls, 1, 'unknown granted port still requires explicit selection');
        assert.equal(manual.state.authorizedDevice.serialPort, unknownPort);
        assert.equal(manual.state.authorizedDevice.usbDevice, usb);
        assert.deepEqual(manual.state.authorizedDevice.serialInfo, info);
        const message = manual.logs.find(s => s.startsWith('sharp_serial_diagnostics'));
        const details = JSON.parse(JSON.parse(message.slice('sharp_serial_diagnostics'.length)).details);
        assert.deepEqual(details, { selected: info, authorized: [info], usbDiscovery: { vendorId: 0x04FC, productId: 0x0201 } });
        let entries;
        manual.renderDeviceInfo = value => { entries = value; };
        manual.updateDeviceModelDisplay = () => {};
        vm.runInContext(extract('readSharpInfo'), manual); manual.readSharpInfo();
        assert.equal(entries[1].value, info.usbVendorId ? '1234:5678 / WebSerial' : 'sharp_serial_unknown_ids / WebSerial');
    }
    const reuse = context(); reuse.WebTILPSharp = { ...sharp, SharpBackend: Backend };
    reuse.navigator.serial = { getPorts: async () => [port], requestPort: () => { throw new Error('Known Sharp port should be reused'); } };
    await reuse.connectSharp(usb);
    assert.equal(reuse.state.authorizedDevice.serialPort, port);
    // macOS uses the CE-LK4 directly, even when WebSerial exists but has no
    // driver/ports. The USB chooser must belong to the initiating click.
    {
        let usbRequests = 0;
        const usbPort = { device: usb, getInfo: () => port.getInfo() };
        const mac = context({
            WebTILPSharp: { ...sharp, SharpBackend: Backend },
            WebTILPSharpUsb: { shouldUse: () => true, createPort: device => { assert.equal(device, usb); return usbPort; } },
            navigator: { usb: { getDevices: async () => [usb], requestDevice: async options => {
                usbRequests++; assert.equal(options.filters[0].vendorId, 0x04fc); return usb;
            } }, serial: { requestPort() { throw new Error('macOS must not request an unavailable COM port'); } } }
        });
        mac.state.settings.calcModel = 'sharp-el9950';
        await mac.connect();
        assert.equal(usbRequests, 1);
        assert.equal(mac.state.sharpBackend.port, usbPort);
        assert.equal(mac.state.authorizedDevice.usbDevice, usb);
        assert.equal((await mac.getAuthorizedSharpSerialDevices())[0].serialPort, usbPort);
    }
    // A late grant after disconnect cannot publish a connection.
    let resolve;
    const stale = context(); stale.navigator.serial = { getPorts: async () => [], requestPort: () => new Promise(r => { resolve = r; }) };
    const grant = stale.requestSharpSerialDevice(); stale.state.sharpConnectionGeneration++; resolve(port);
    await assert.rejects(grant, error => error.sharpConnectionCancelled);
    // Disconnecting while metadata is being enumerated also retires the grant.
    let metadataStarted, resolveMetadata;
    const metadataReady = new Promise(r => { metadataStarted = r; });
    const staleMetadata = context();
    staleMetadata.navigator.serial = { requestPort: async () => port, getPorts: () => new Promise(r => {
        resolveMetadata = r; metadataStarted();
    }) };
    const metadataGrant = staleMetadata.requestSharpSerialDevice();
    await metadataReady; staleMetadata.state.sharpConnectionGeneration++; resolveMetadata([port]);
    await assert.rejects(metadataGrant, error => error.sharpConnectionCancelled);
    const cancelled = context();
    cancelled.navigator.serial = { getPorts: async () => [port], requestPort: async () => {
        throw new DOMException('Cancelled', 'NotFoundError');
    } };
    assert.equal(await cancelled.requestSharpSerialDevice(usb), null);
    const cancelledLog = cancelled.logs.find(s => s.startsWith('sharp_serial_diagnostics'));
    const cancelledDetails = JSON.parse(JSON.parse(cancelledLog.slice('sharp_serial_diagnostics'.length)).details);
    assert.equal(cancelledDetails.selected, null);
    assert.deepEqual(cancelledDetails.authorized, [port.getInfo()]);
    // Diagnostic enumeration failures do not invalidate a selected port.
    const noEnumeration = context({ console: { warn() {} } });
    noEnumeration.navigator.serial = { getPorts: async () => { throw new Error('Enumeration unavailable'); }, requestPort: async () => port };
    assert.equal((await noEnumeration.requestSharpSerialDevice()).serialPort, port);
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
    // Conversion is available for explicitly selected Sharp models and Auto
    // after Sharp detection, without passing Sharp strings to a TI native enum.
    {
        const c = context({getSelectedConversionModelId: () => 0,
            getPythonConversionKind: () => 0, PYTHON_CONVERSION_NONE: 0, NSPIRE_LUA_CALC_MODELS: new Set()});
        c.els.settingConvertScriptFiles = element(); c.els.settingCalcModel = { value: 'sharp-el9950' };
        vm.runInContext(extract('updateSourceConversionSettingAvailability'), c);
        c.updateSourceConversionSettingAvailability(); assert.equal(c.els.settingConvertScriptFiles.disabled, false);
        c.els.settingCalcModel.value = 'auto'; c.state.activeFamily = 'sharp';
        c.updateSourceConversionSettingAvailability(); assert.equal(c.els.settingConvertScriptFiles.disabled, false);
        c.state.activeFamily = 'ti'; c.updateSourceConversionSettingAvailability();
        assert.equal(c.els.settingConvertScriptFiles.disabled, true);
    }
    // Source conversion honors the shared setting and preflights every input.
    {
        const c = context(), sent = [], errors = [], confirmations = [];
        c.state.connected = true; c.state.activeFamily = 'sharp';
        c.state.sharpBackend = { model: 'sharp-el9950', async sendFile(data, name) { sent.push({ data, name }); } };
        c.logError = error => errors.push(error.message);
        c.confirm = message => { confirmations.push(message); return true; };
        const input = (name, data) => ({ name, arrayBuffer: async () => Uint8Array.from(data).buffer });
        const source = input('HELLO.bas', new TextEncoder().encode('Print "HELLO"\nEnd'));
        await c.sendSharpFiles([source]);
        assert.equal(sent.length, 1); assert.equal(sent[0].name, 'HELLO.g4p');
        assert.match(codec.previewFile(sent[0].data).text, /Print "HELLO"/);
        assert.match(confirmations[0], /HELLO.g4p/);
        await c.sendSharpFiles([source, input('bad.txt', new TextEncoder().encode('🙂'))]);
        assert.equal(sent.length, 1, 'invalid later source prevents sending earlier valid source');
        await c.sendSharpFiles([source, input('HELLO.g4p', sent[0].data)]);
        assert.equal(sent.length, 1, 'converted and native duplicate destinations are rejected');
        c.state.settings.convertScriptFiles = false;
        await c.sendSharpFiles([source]); assert.equal(sent.length, 1);
        assert.ok(errors.includes('sharp_conversion_disabled'));
        c.state.settings.convertScriptFiles = true;
        c.prompt = () => null;
        await c.sendSharpFiles([input('too long program name.txt', [])]);
        assert.equal(sent.length, 1, 'cancelling a program-name prompt sends nothing');
        c.prompt = () => 'OKNAME';
        await c.sendSharpFiles([input('too long program name.txt', new TextEncoder().encode('End'))]);
        assert.equal(sent.at(-1).name, 'OKNAME.g4p');
        const record = new Uint8Array(264 + sent[0].data.length);
        new DataView(record.buffer).setUint32(0, record.length, true);
        record.set(new TextEncoder().encode('HELLO.g4p'), 4); record.set(sent[0].data, 264);
        const group = Uint8Array.from([52, 103, ...record, ...new Uint8Array(264)]);
        await c.sendSharpFiles([input('test.g4g', group)]);
        assert.equal(sent.at(-1).name, 'HELLO.g4p');
        const before = sent.length;
        await c.sendSharpFiles([input('test.g4g', group.slice(0, -1))]);
        assert.equal(sent.length, before, 'truncated group sends no members');
        c.prompt = () => '0'; c.convertSharpImage = async (_, slot) => {
            assert.equal(slot, 0); return codec.pictureFile(new Uint8ClampedArray(127 * 64 * 4).fill(255), slot);
        };
        await c.sendSharpFiles([input('photo.png', [])]);
        assert.equal(sent.at(-1).name, 'Pict0.g4i');
        assert.equal(codec.previewFile(sent.at(-1).data).image.height, 64);
        const old = c.state.sharpBackend;
        await c.sendSharpFiles([{ name: 'late.bas', async arrayBuffer() {
            c.state.sharpConnectionGeneration++; return new TextEncoder().encode('End').buffer;
        } }]);
        assert.equal(sent.at(-1).name, 'Pict0.g4i', 'connection changes retire asynchronous conversions');
        c.state.sharpBackend = old;
    }
    // Sharp preview uses the native backend and shared modal; late receives
    // cannot reopen a closed preview or publish a retired connection's data.
    {
        const c = context(); c.state.connected = true;
        let complete, shown = null;
        c.state.sharpBackend = { receiveVariable: () => new Promise(resolve => { complete = resolve; }) };
        c.createSharpPreview = (data, name) => ({ readable: codec.previewFile(data, name).text, language: '' });
        c.closePreviewModal = () => { c.previewRenderId++; };
        c.openPreviewModal = (entry, readable) => { shown = { entry, readable }; };
        c.previewRenderId = 0;
        vm.runInContext(extract('previewSharpEntry'), c);
        const entry = { kind: 'sharp', name: 'HELLO', category: sharp.CATEGORIES[0] };
        const result = { data: codec.programFile('End', 'HELLO'), filename: 'HELLO.g4p' };
        let pending = c.previewSharpEntry(entry); complete(result); await pending;
        assert.equal(shown.readable, 'End\n'); assert.equal(shown.entry.typeName, 'PROGRAM');
        assert.equal(c.previewSession.downloadName, 'HELLO.g4p');
        shown = null; pending = c.previewSharpEntry(entry); c.closePreviewModal(); complete(result); await pending;
        assert.equal(shown, null);
        pending = c.previewSharpEntry(entry); c.state.sharpConnectionGeneration++; complete(result); await pending;
        assert.equal(shown, null);
    }
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
