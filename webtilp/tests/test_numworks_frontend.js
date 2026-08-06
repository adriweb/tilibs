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

async function testRawBackupBypassesStorageParser() {
    let rawReads = 0;
    let refreshes = 0;
    let download = null;
    const logs = [];
    const state = {
        numWorksBackend: {
            async readRawStorageImage() {
                rawReads += 1;
                return Uint8Array.of(0xBA, 0xDD, 0x0B, 0xEE, 0xFF);
            },
            async refresh() {
                refreshes += 1;
                throw new Error('corrupt storage must not be parsed for backup');
            }
        }
    };
    const context = {
        console,
        state,
        els: { btnReceiveBackup: {} },
        isHPPrimeActive() { return false; },
        isNumWorksActive() { return true; },
        setButtonLoading() {},
        triggerDownload(name, data) { download = { name, data }; },
        tFormat(key, values) { return `${key}:${JSON.stringify(values)}`; },
        log(message) { logs.push(message); }
    };
    vm.createContext(context);
    vm.runInContext(extractFunction('receiveBackup'), context);
    await context.receiveBackup();

    assert.equal(rawReads, 1);
    assert.equal(refreshes, 0, 'raw backup does not refresh or parse script storage');
    assert.match(download?.name || '', /^numworks-storage-.*\.bin$/);
    assert.deepEqual(Array.from(download?.data || []), [0xBA, 0xDD, 0x0B, 0xEE, 0xFF]);
    assert.equal(logs.length, 1);
}

async function testOverwritePreservesDisabledAutoImport() {
    let submitted = null;
    const logs = [];
    const state = {
        dirlist: [{
            name: 'existing',
            kind: 'numworks',
            attr: 0
        }],
        numWorksBackend: {
            async upsertScripts(scripts) {
                submitted = scripts;
            }
        }
    };
    const context = {
        console,
        state,
        WebTILPNumWorks: {
            normalizeScriptName(name) {
                return String(name).replace(/\.py$/i, '').toLowerCase();
            }
        },
        confirm() { return true; },
        t(key) { return key; },
        tFormat(key, values) { return `${key}:${JSON.stringify(values)}`; },
        log(message) { logs.push(message); },
        setSelectedFiles() {},
        readNumWorksInfo() {},
        applyNumWorksStorageSnapshot() {}
    };
    vm.createContext(context);
    vm.runInContext(extractFunction('sendNumWorksFiles'), context);
    await context.sendNumWorksFiles([{
        name: 'Existing.py',
        async text() { return 'print("replacement")\n'; }
    }]);

    assert.equal(submitted?.length, 1);
    assert.equal(submitted?.[0].name, 'existing');
    assert.equal(submitted?.[0].autoImport, false,
        'overwriting a non-auto-import script preserves its flag');
    assert.equal(logs.length, 2);
}

async function testTransportConnectClosesMatchingBackendOnly() {
    let closes = 0;
    let resets = 0;
    const activeDevice = { productName: 'NumWorks Calculator' };
    const backend = {
        device: activeDevice,
        async close() { closes += 1; }
    };
    const state = {
        numWorksBackend: backend,
        silentReconnectInProgress: false,
        module: null,
        activeFamily: 'numworks'
    };
    const context = {
        console,
        state,
        DEVICE_FAMILY_TI: 'ti',
        retireModule() {},
        setConnected() {},
        setStatus() {},
        log() {},
        clearDeviceData() { resets += 1; },
        applyActiveFamilyUiState() {}
    };
    vm.createContext(context);
    vm.runInContext(extractFunction('handleTransportConnect'), context);

    context.handleTransportConnect({ device: { productName: 'Another USB device' } });
    assert.equal(state.numWorksBackend, backend,
        'an unrelated USB connect event leaves the NumWorks session alone');
    assert.equal(closes, 0);
    assert.equal(resets, 0);

    context.handleTransportConnect({ device: activeDevice });
    await Promise.resolve();
    assert.equal(state.numWorksBackend, null);
    assert.equal(closes, 1, 'the matching stale WebUSB session is closed');
    assert.equal(resets, 1);
}

async function testCombinedWebUsbChooserAndFamilyDetection() {
    const tiDevices = [
        { productId: 0xE003 },
        { productId: 0xE022 }
    ];
    const hpProductIds = new Set([0x0441, 0x1541, 0x2441]);
    const selected = { vendorId: 0x0483, productId: 0xA291, productName: 'NumWorks' };
    let requestedFilters = null;
    const context = {
        console,
        TI_USB_DEVICES: tiDevices,
        TI_USB_PRODUCT_IDS: new Set(tiDevices.map(device => device.productId)),
        TI_VENDOR_ID: 0x0451,
        HP_VENDOR_ID: 0x03F0,
        HP_PRIME_PRODUCT_IDS: hpProductIds,
        NUMWORKS_VENDOR_ID: 0x0483,
        NUMWORKS_PRODUCT_ID: 0xA291,
        DEVICE_FAMILY_TI: 'ti',
        DEVICE_FAMILY_HP_PRIME: 'hp-prime',
        DEVICE_FAMILY_NUMWORKS: 'numworks',
        navigator: {
            usb: {
                async requestDevice(options) {
                    requestedFilters = options.filters;
                    return selected;
                }
            }
        },
        t(key) { return key; },
        isNumWorksDevice(device) {
            return device?.vendorId === 0x0483 && device?.productId === 0xA291;
        },
        isHPPrimeDevice(device) {
            return device?.vendorId === 0x03F0 && hpProductIds.has(device?.productId);
        }
    };
    vm.createContext(context);
    for (const name of [
        'getWebUsbDeviceFamily', 'getSupportedWebUsbFilters',
        'requestSupportedWebUsbDevice'
    ]) {
        vm.runInContext(extractFunction(name), context);
    }

    assert.equal(context.getWebUsbDeviceFamily(selected), 'numworks');
    assert.equal(context.getWebUsbDeviceFamily({ vendorId: 0x0451, productId: 0xE022 }), 'ti');
    assert.equal(context.getWebUsbDeviceFamily({ vendorId: 0x03F0, productId: 0x2441 }), 'hp-prime');
    assert.equal(context.getWebUsbDeviceFamily({ vendorId: 0x1234, productId: 0x5678 }), null);
    assert.equal(await context.requestSupportedWebUsbDevice(), selected);
    assert.deepEqual(
        Array.from(requestedFilters, filter => [filter.vendorId, filter.productId]),
        [
            [0x0451, 0xE003], [0x0451, 0xE022],
            [0x03F0, 0x0441], [0x03F0, 0x1541], [0x03F0, 0x2441],
            [0x0483, 0xA291]
        ],
        'the WebUSB chooser receives the union of supported TI, HP, and NumWorks filters'
    );
}

async function testAutoConnectDispatchesSelectedWebUsbFamily() {
    const numWorks = { vendorId: 0x0483, productId: 0xA291 };
    const hpPrime = { vendorId: 0x03F0, productId: 0x2441 };
    const ti = { vendorId: 0x0451, productId: 0xE022 };
    const calls = [];
    const state = {
        settings: { cableModel: 'auto' },
        connected: false,
        cableOpen: false,
        handle: 0,
        authorizedDevice: null,
        activeFamily: 'ti',
        connectInProgress: false
    };
    let selected = numWorks;
    const context = {
        console,
        state,
        els: { btnConnect: {} },
        DEVICE_FAMILY_TI: 'ti',
        DEVICE_FAMILY_HP_PRIME: 'hp-prime',
        DEVICE_FAMILY_NUMWORKS: 'numworks',
        CABLE_GRAYLINK: '1',
        setButtonLoading() {},
        hasWebUsbTransport() { return true; },
        hasHPPrimeWebHidTransport() { return true; },
        hasEvoWebSerialTransport() { return true; },
        async requestSupportedWebUsbDevice() { return selected; },
        getWebUsbDeviceFamily(device) {
            if (device === numWorks) return 'numworks';
            if (device === hpPrime) return 'hp-prime';
            return 'ti';
        },
        async connectNumWorks(forcePrompt) { calls.push(['numworks', forcePrompt]); },
        async connectHPPrime(forcePrompt, discoveryDevice) {
            calls.push(['hp-prime', forcePrompt, discoveryDevice]);
        },
        async connectTI(forcePrompt, device) { calls.push(['ti', forcePrompt, device]); },
        applyActiveFamilyUiState() {},
        setStatus() {},
        logError(error) { throw error; }
    };
    vm.createContext(context);
    vm.runInContext(extractFunction('connect'), context);

    await context.connect();
    assert.deepEqual(calls, [['numworks', false]]);
    assert.equal(state.authorizedDevice, numWorks);

    calls.length = 0;
    selected = hpPrime;
    await context.connect();
    assert.deepEqual(calls, [['hp-prime', true, hpPrime]]);
    assert.equal(state.authorizedDevice, hpPrime,
        'the discovery USBDevice is retained until WebHID authorization replaces it');

    calls.length = 0;
    selected = ti;
    await context.connect();
    assert.deepEqual(calls, [['ti', false, ti]]);
    assert.equal(state.authorizedDevice, ti);
}

function testLegacyFamilySettingIsDiscarded() {
    const defaults = {
        cableModel: 'auto',
        calcModel: 'auto',
        cableTimeout: 50,
        cableDelay: 10,
        language: 'auto',
        convertPythonFiles: true
    };
    const context = {
        console,
        SETTINGS_DEFAULTS: defaults,
        localStorage: {
            getItem() {
                return JSON.stringify({ ...defaults, deviceFamily: 'numworks' });
            }
        },
        normalizeLanguageCode(value) { return value; }
    };
    vm.createContext(context);
    vm.runInContext(extractFunction('loadSettings'), context);
    assert.equal(Object.hasOwn(context.loadSettings(), 'deviceFamily'), false,
        'obsolete family preferences are removed instead of migrated');
}

async function testNumWorksScriptPreview() {
    const opened = [];
    const downloads = [];
    const source = 'from math import sqrt\nprint(sqrt(2))\n';
    const state = {
        numWorksBackend: {
            getScript(name) {
                assert.equal(name, 'roots');
                return { name: 'roots.py', code: source, autoImport: false };
            }
        }
    };
    const context = {
        console,
        state,
        TIVARS_PREVIEW_CALC_MODELS: new Set(),
        EVO_PYTHON_CALC_MODELS: new Map(),
        TIVARS_EVO_PREVIEW_TYPES: new Set(),
        TIVARS_LEGACY_PREVIEW_TYPES: new Set(),
        TextEncoder,
        URL: { revokeObjectURL() {} },
        getHPPrimePreviewKind() { return ''; },
        getActiveCalcModelId() { return 0; },
        t(key) { return key; },
        setButtonLoading() {},
        closePreviewModal() {},
        openPreviewModal(entry, readable) { opened.push([entry, readable]); },
        triggerDownload(name, data) { downloads.push([name, Array.from(data)]); },
        log() {},
        logError(error) { throw error; }
    };
    vm.createContext(context);
    vm.runInContext('let previewSession = null;', context);
    for (const name of [
        'canPreviewVariable', 'previewEntry', 'downloadPreviewFile'
    ]) {
        vm.runInContext(extractFunction(name), context);
    }

    assert.equal(context.canPreviewVariable({
        name: 'roots', kind: 'numworks', is_folder: 0, invalid: false
    }, 0), true);
    assert.equal(context.canPreviewVariable({
        name: 'broken', kind: 'numworks', is_folder: 0, invalid: true
    }, 0), false, 'malformed NumWorks records do not expose a preview action');

    const entry = {
        name: 'roots', numWorksName: 'roots', kind: 'numworks',
        typeName: 'Python script', size: source.length, isFolder: false,
        invalid: false
    };
    await context.previewEntry(entry, {});
    assert.equal(opened.length, 1);
    assert.equal(opened[0][1], source);
    const session = vm.runInContext('previewSession', context);
    assert.equal(session.language, 'python');
    assert.equal(session.downloadName, 'roots.py');
    assert.equal(new TextDecoder().decode(session.data), source);

    context.downloadPreviewFile();
    assert.equal(downloads.length, 1);
    assert.equal(downloads[0][0], 'roots.py');
    assert.equal(new TextDecoder().decode(Uint8Array.from(downloads[0][1])), source,
        'the preview download preserves the exact UTF-8 Python source');
}

Promise.all([
    testRawBackupBypassesStorageParser(),
    testOverwritePreservesDisabledAutoImport(),
    testTransportConnectClosesMatchingBackendOnly(),
    testCombinedWebUsbChooserAndFamilyDetection(),
    testAutoConnectDispatchesSelectedWebUsbFamily(),
    testLegacyFamilySettingIsDiscarded(),
    testNumWorksScriptPreview()
]).then(() => {
    console.log('NumWorks frontend regression tests passed');
}).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
