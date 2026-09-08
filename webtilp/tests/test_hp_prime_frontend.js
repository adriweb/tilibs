'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const zlib = require('node:zlib');

const appSource = fs.readFileSync(require.resolve('../app.js'), 'utf8');

function extractFunction(name) {
    const plainMarker = `function ${name}(`;
    const asyncMarker = `async function ${name}(`;
    let start = appSource.indexOf(asyncMarker);
    if (start < 0) {
        start = appSource.indexOf(plainMarker);
    }
    assert.notEqual(start, -1, `function ${name} exists`);
    const bodyStart = appSource.indexOf(') {', start) + 2;
    assert.ok(bodyStart > 1, `function ${name} body exists`);
    let depth = 0;
    for (let index = bodyStart; index < appSource.length; index++) {
        if (appSource[index] === '{') depth += 1;
        if (appSource[index] === '}') depth -= 1;
        if (depth === 0) {
            return appSource.slice(start, index + 1);
        }
    }
    throw new Error(`unterminated function ${name}`);
}

class ClassList {
    constructor() {
        this.values = new Set();
    }
    add(...names) { names.forEach(name => this.values.add(name)); }
    remove(...names) { names.forEach(name => this.values.delete(name)); }
    contains(name) { return this.values.has(name); }
    toggle(name, force) {
        const enabled = force === undefined ? !this.contains(name) : Boolean(force);
        if (enabled) this.add(name);
        else this.remove(name);
        return enabled;
    }
}

function makeElement() {
    return {
        classList: new ClassList(),
        disabled: false,
        title: '',
        textContent: '',
        accept: '',
        attributes: new Map(),
        setAttribute(name, value) { this.attributes.set(name, String(value)); },
        removeAttribute(name) { this.attributes.delete(name); }
    };
}

async function testFamilyUiState() {
    const textElements = {
        dropzoneTitle: makeElement(),
        dropzoneSubtitle: makeElement(),
        panelVarsTitle: makeElement()
    };
    const els = {};
    for (const name of [
        'btnReceiveBackup', 'btnRefreshDirlist', 'btnScreenshot', 'keyCodeInput',
        'fileInput', 'btnSyncClock', 'btnNewFolder', 'btnDeleteSelected',
        'btnIsReady', 'btnReceiveOs', 'btnDownloadOsPartial', 'btnDumpRom',
        'btnLeaveExam', 'btnSendFiles', 'keysPanel'
    ]) {
        els[name] = makeElement();
    }
    const state = {
        activeFamily: 'hp-prime',
        selectedFiles: [],
        nspireOsReceiveStarted: false,
        hpPrimeProtocolVersion: null
    };
    let keyMapClears = 0;
    const translations = new Proxy({}, {
        get(_target, key) { return `translated:${String(key)}`; }
    });
    const context = {
        console,
        state,
        els,
        DEVICE_FAMILY_TI: 'ti',
        DEVICE_FAMILY_HP_PRIME: 'hp-prime',
        DEVICE_FAMILY_NUMWORKS: 'numworks',
        KEYMAP_CONFIG_HP_PRIME: { listId: 'hp-prime-keys', entries: [] },
        document: {
            getElementById(id) { return textElements[id] || null; }
        },
        t(key) { return translations[key]; },
        setTextContent(element, value) { if (element) element.textContent = value; },
        updateKeyControlsState(enabled) {
            els.keysPanel.classList.toggle('hidden', !enabled);
            els.keyCodeInput.disabled = !enabled;
        },
        clearKeyMapDataList() { keyMapClears += 1; },
        populateKeyMapDataList() {},
        updateSendFilesButtonState() {
            els.btnSendFiles.disabled = state.selectedFiles.length === 0;
        },
        updateSelectionActionButtons() {
            els.btnDeleteSelected.disabled = state.activeFamily === 'hp-prime';
        }
    };
    vm.createContext(context);
    for (const name of [
        'isHPPrimeActive', 'isNumWorksActive', 'resetFamilySpecificUiText',
        'setTiUiState', 'setHPPrimeUiState', 'setNumWorksUiState',
        'applyActiveFamilyUiState'
    ]) {
        vm.runInContext(extractFunction(name), context);
    }

    context.applyActiveFamilyUiState();
    assert.equal(textElements.dropzoneTitle.textContent,
        'translated:hp_prime_dropzone_title');
    assert.equal(textElements.panelVarsTitle.textContent,
        'translated:hp_prime_files_title');
    assert.equal(els.btnReceiveBackup.title,
        'translated:hp_prime_backup_tooltip');
    assert.equal(els.btnRefreshDirlist.title,
        'translated:hp_prime_refresh_tooltip');
    assert.equal(els.btnSyncClock.disabled, true);
    assert.equal(els.btnNewFolder.disabled, true);
    assert.equal(els.btnDeleteSelected.disabled, true);
    assert.equal(els.btnScreenshot.disabled, false);
    assert.equal(els.btnIsReady.classList.contains('hidden'), true);
    assert.equal(els.fileInput.accept, '');
    assert.equal(els.keysPanel.classList.contains('hidden'), false,
        'connected HP Prime calculators expose key controls');
    assert.equal(els.keyCodeInput.attributes.get('list'), 'hp-prime-keys',
        'connected HP Prime calculators expose the Prime key map');

    state.hpPrimeProtocolVersion = 1;
    context.applyActiveFamilyUiState();
    assert.equal(els.keysPanel.classList.contains('hidden'), false,
        'legacy HP Prime connections retain the hardware-proven key controls');
    assert.equal(els.keyCodeInput.attributes.get('list'), 'hp-prime-keys',
        'legacy HP Prime connections expose the Prime key map');

    state.hpPrimeProtocolVersion = 2;
    context.applyActiveFamilyUiState();
    assert.equal(els.keysPanel.classList.contains('hidden'), false,
        'all G2 V2 firmware exposes the hardware-proven key controls');
    assert.equal(els.keyCodeInput.attributes.get('list'), 'hp-prime-keys',
        'all G2 V2 firmware exposes the Prime key map');

    textElements.dropzoneTitle.textContent = 'generic translation pass';
    textElements.panelVarsTitle.textContent = 'generic translation pass';
    context.applyActiveFamilyUiState();
    assert.equal(textElements.dropzoneTitle.textContent,
        'translated:hp_prime_dropzone_title');
    assert.equal(textElements.panelVarsTitle.textContent,
        'translated:hp_prime_files_title');

    state.activeFamily = 'ti';
    context.applyActiveFamilyUiState();
    assert.equal(textElements.dropzoneTitle.textContent, 'translated:dropzone_title');
    assert.equal(textElements.panelVarsTitle.textContent,
        'translated:calculator_variables');
    assert.equal(els.btnReceiveBackup.title, '');
    assert.equal(els.btnRefreshDirlist.title, '');
    assert.equal(els.btnSyncClock.disabled, true);
    assert.equal(els.btnNewFolder.disabled, true);
    assert.equal(els.btnDeleteSelected.disabled, true);
    assert.equal(els.btnScreenshot.disabled, true);
    assert.equal(els.btnDumpRom.classList.contains('hidden'), true);
    assert.equal(els.btnLeaveExam.classList.contains('hidden'), true);
    assert.equal(els.fileInput.accept, '');
    assert.equal(els.keysPanel.classList.contains('hidden'), true,
        'an unknown TI calculator starts without key controls');

    // Model what updateCapabilities() does for a connected key-capable TI.
    context.updateKeyControlsState(true);
    els.keyCodeInput.setAttribute('list', 'keyMap834');
    const keyMapClearsBeforeRefresh = keyMapClears;
    els.btnSyncClock.disabled = false;
    els.btnReceiveBackup.title = 'capability-specific tooltip';
    context.applyActiveFamilyUiState({ tiCapabilitiesKnown: true });
    assert.equal(els.btnSyncClock.disabled, false,
        'translation refresh preserves known TI capability state');
    assert.equal(els.btnReceiveBackup.title, 'capability-specific tooltip');
    assert.equal(els.keysPanel.classList.contains('hidden'), false,
        'translation refresh keeps the keys panel of a connected TI calculator');
    assert.equal(els.keyCodeInput.disabled, false,
        'translation refresh keeps the key code input enabled');
    assert.equal(els.keyCodeInput.attributes.get('list'), 'keyMap834',
        'translation refresh keeps the active keymap datalist binding');
    assert.equal(keyMapClears, keyMapClearsBeforeRefresh,
        'translation refresh does not clear the populated keymap datalist');

    state.activeFamily = 'numworks';
    context.applyActiveFamilyUiState();
    assert.equal(textElements.panelVarsTitle.textContent,
        'translated:numworks_scripts_title');
    assert.equal(els.btnScreenshot.disabled, true);
}

async function testTableDropUsesPrimeTransferPath() {
    const files = [{ name: 'BACK.hplist' }];
    let selectedFiles = null;
    let selectedSource = null;
    let primeSends = 0;
    let tiTransfers = 0;
    const context = {
        console,
        log() {},
        logError(error) { throw error; },
        isHPPrimeActive() { return true; },
        isNumWorksActive() { return false; },
        findHPPrimeAppRoot() { return null; },
        setSelectedFiles(selected, source) {
            selectedFiles = selected;
            selectedSource = source;
        },
        async sendSelectedFiles() { primeSends += 1; },
        async sendNumWorksFiles() {
            throw new Error('NumWorks path must not handle an HP Prime drop');
        },
        async processIncomingTransfers() { tiTransfers += 1; },
        t(key) { return key; }
    };
    vm.createContext(context);
    vm.runInContext(extractFunction('sendDroppedFiles'), context);

    await context.sendDroppedFiles(files, 'ignored-for-prime');
    assert.equal(selectedFiles, files,
        'table drop populates the same selection used by the Prime transfer area');
    assert.equal(selectedSource, 'table drop');
    assert.equal(primeSends, 1,
        'table drop dispatches through the connected Prime upload path');
    assert.equal(tiTransfers, 0,
        'table drop never enters the TI path that requests a WebUSB device');
}

async function testApplicationMappingAndDropDispatch() {
    const context = {
        console,
        TextEncoder,
        Uint8Array,
        DataView,
        t(key) { return `translated:${key}`; }
    };
    vm.createContext(context);
    for (const name of [
        'mapHPPrimeFileEntry', 'hpPrimeAppPartTypeName',
        'mapHPPrimeFileEntries'
    ]) {
        vm.runInContext(extractFunction(name), context);
    }
    vm.runInContext(extractFunction('encodeHPPrimeAppResourceManifest'), context);
    const manifest = context.encodeHPPrimeAppResourceManifest([{
        name: 'a', data: Uint8Array.of(1, 2)
    }]);
    assert.equal(Buffer.from(manifest).toString('hex'),
        '000000010000000161000000020102',
        'resource manifest uses bounded big-endian name/data records');
    const mapped = context.mapHPPrimeFileEntries({
        index: 4,
        name: 'synthese',
        type: 2,
        typeName: 'Application',
        extension: 'hpapp',
        size: 11599419,
        invalid: false,
        appContainerValid: true,
        children: [
            { index: 0, name: 'synthese.hpapp', kind: 'descriptor', extension: 'hpapp', size: 200, editable: false },
            { index: 3, name: 'icon.png', kind: 'resource', extension: 'png', size: 4096, editable: true }
        ]
    });
    assert.equal(mapped.length, 3);
    assert.equal(mapped[0].hpAppRoot, true);
    assert.equal(mapped[0].is_folder, 1,
        'a parsed application is represented as an expandable root');
    assert.equal(mapped[1].folder, 'synthese');
    assert.equal(mapped[1].hpIndex, 4);
    assert.equal(mapped[1].hpAppChildIndex, 0);
    assert.equal(mapped[1].hpAppChildEditable, false,
        'core application parts remain read-only');
    assert.equal(mapped[2].hpAppChildEditable, true,
        'ordinary application resources are editable');
    assert.equal(mapped[2].type_name, 'translated:hp_prime_app_resource');

    const files = [{ name: 'new.png' }];
    const appRoot = mapped[0];
    let appDrop = null;
    let topLevelSends = 0;
    const dropContext = {
        console,
        log() {},
        logError(error) { throw error; },
        isHPPrimeActive() { return true; },
        isNumWorksActive() { return false; },
        findHPPrimeAppRoot(path) {
            assert.equal(path, 'synthese');
            return appRoot;
        },
        async sendHPPrimeAppResources(selected, root) {
            appDrop = { selected, root };
        },
        setSelectedFiles() {},
        async sendSelectedFiles() { topLevelSends += 1; },
        async sendNumWorksFiles() {},
        async processIncomingTransfers() {},
        t(key) { return key; }
    };
    vm.createContext(dropContext);
    vm.runInContext(extractFunction('sendDroppedFiles'), dropContext);
    await dropContext.sendDroppedFiles(files, 'synthese');
    assert.equal(appDrop.selected, files);
    assert.equal(appDrop.root, appRoot);
    assert.equal(topLevelSends, 0,
        'dropping on an application dispatches to its resource updater');
    await dropContext.sendDroppedFiles([{ name: 'Gallery.hpapp', hpAppDirectory: true }], 'synthese');
    assert.equal(topLevelSends, 1,
        'a complete app folder dropped on an existing app is installed as an app, not as a resource');
}

async function testApplicationDownloadDispatch() {
    const calls = [];
    const downloads = [];
    const files = new Map();
    const module = {
        FS: {
            analyzePath() { return { exists: true }; },
            mkdir() {},
            readFile(path) { return files.get(path) || Uint8Array.of(1, 2, 3); },
            unlink(path) { files.delete(path); }
        }
    };
    const context = {
        console,
        confirm() { return true; },
        async initModule() { return module; },
        async ccallAsync(_module, name, _returnType, _argTypes, args) {
            calls.push([name, Array.from(args)]);
            files.set(args.at(-1), Uint8Array.of(1, 2, 3));
            return 0;
        },
        triggerDownload(name) { downloads.push(name); },
        log() {},
        t(key) { return key; },
        tFormat(key) { return key; },
        formatHPPrimeError() { return 'mock'; }
    };
    vm.createContext(context);
    vm.runInContext(extractFunction('downloadHPPrimeEntry'), context);
    await context.downloadHPPrimeEntry({
        name: 'synthese', hpIndex: 4, extension: 'hpapp', invalid: false
    });
    await context.downloadHPPrimeEntry({
        name: 'icon.png', hpIndex: 4, hpAppChildIndex: 3,
        extension: 'png', invalid: false
    });
    assert.deepEqual(calls.map(call => call[0]), [
        'hp_prime_download_cached_file',
        'hp_prime_download_cached_app_child'
    ]);
    assert.deepEqual(downloads, ['synthese.hpapp', 'icon.png'],
        'child downloads do not duplicate their extension');
}

async function testApplicationMutationDispatch() {
    const calls = [];
    const state = { expandedFolders: new Set(), hpFileSnapshotLoaded: true };
    const context = {
        console,
        state,
        els: { btnDeleteSelected: {} },
        isNspireActive() { return false; },
        isHPPrimeActive() { return true; },
        isNumWorksActive() { return false; },
        prompt() { return 'renamed.png'; },
        confirm() { return true; },
        setButtonLoading() {},
        async initModule() { return {}; },
        async ccallAsync(_module, name, _returnType, _argTypes, args) {
            calls.push([name, Array.from(args)]);
            return 0;
        },
        applyHPPrimeFileSnapshot() {},
        formatHPPrimeError() { return 'mock'; },
        log() {},
        logError(error) { throw error; },
        t(key) { return key; },
        tFormat(key) { return key; }
    };
    vm.createContext(context);
    vm.runInContext(extractFunction('renameEntry'), context);
    vm.runInContext(extractFunction('deleteEntry'), context);
    const entry = {
        name: 'icon.png',
        folder: 'synthese',
        isFolder: false,
        hpIndex: 4,
        hpAppChildIndex: 3,
        hpAppChildEditable: true
    };
    await context.renameEntry(entry);
    await context.deleteEntry(entry);
    assert.deepEqual(calls, [
        ['hp_prime_rename_cached_app_resource', [4, 3, 'renamed.png']],
        ['hp_prime_delete_cached_app_resource', [4, 3]]
    ], 'application row actions dispatch to the specialized cached-app bridge');
    assert.equal(state.expandedFolders.has('synthese'), true);
}

async function testWebHidRebinding() {
    const removed = [];
    let closed = 0;
    let woke = 0;
    let waiterSawClearedQueue = false;
    let waiterSawRebindError = false;
    const handler = () => {};
    const oldDevice = {
        vendorId: 0x03F0,
        productId: 0x2441,
        opened: true,
        removeEventListener(type, callback) { removed.push([type, callback]); },
        async close() { closed += 1; this.opened = false; }
    };
    const newDevice = {
        vendorId: 0x03F0,
        productId: 0x1541,
        opened: false
    };
    let hidState;
    const waiterArray = [() => {
        woke += 1;
        waiterSawClearedQueue = hidState.queue.length === 0;
        waiterSawRebindError = /being rebound/.test(hidState.error?.message || '');
    }];
    hidState = {
        device: oldDevice,
        inputHandler: handler,
        queue: [Uint8Array.of(0xEE)],
        waiters: waiterArray,
        error: null,
        reportSize: 1024
    };
    const module = { __hplpWebHID: hidState };
    const context = {
        console,
        HP_VENDOR_ID: 0x03F0,
        HP_PRIME_PRODUCT_IDS: new Set([0x0441, 0x1541, 0x2441])
    };
    vm.createContext(context);
    vm.runInContext(extractFunction('isHPPrimeDevice'), context);
    vm.runInContext(extractFunction('bindHPPrimeDeviceToModule'), context);
    await context.bindHPPrimeDeviceToModule(module, newDevice);

    assert.equal(module.__hplpWebHID, hidState, 'state object is preserved');
    assert.equal(hidState.device, newDevice);
    assert.equal(hidState.waiters, waiterArray, 'waiter array is preserved');
    assert.equal(hidState.waiters.length, 0);
    assert.equal(woke, 1, 'pending read is awakened');
    assert.equal(waiterSawClearedQueue, true,
        'stale reports are cleared before pending reads wake');
    assert.equal(waiterSawRebindError, true,
        'pending reads wake with a rebind error');
    assert.equal(closed, 1, 'previous open device is closed before replacement');
    assert.deepEqual(removed, [['inputreport', handler]]);
    assert.equal(hidState.queue.length, 0);
    assert.match(hidState.error?.message || '', /being rebound/,
        'woken readers observe a rebind error until the new transport opens');
    assert.equal(hidState.reportSize, 0);
}

async function testBatchDownloadContinues() {
    const attempted = [];
    const errors = [];
    const context = {
        async downloadHPPrimeEntry(entry) {
            attempted.push(entry.name);
            if (entry.name === 'bad') throw new Error('mock failure');
        },
        logError(error, message) { errors.push([error.message, message]); },
        tFormat(_key, values) { return `failed:${values.name}`; }
    };
    vm.createContext(context);
    vm.runInContext(extractFunction('downloadHPPrimeEntries'), context);
    await context.downloadHPPrimeEntries([
        { name: 'first' }, { name: 'bad' }, { name: 'last' }
    ]);
    assert.deepEqual(attempted, ['first', 'bad', 'last']);
    assert.deepEqual(errors, [['mock failure', 'failed:bad']]);
}

async function testProgressivePrimeFileSnapshot() {
    const frames = [];
    const rendered = [];
    let finalFiles = [];
    const module = {
        ccall(name) {
            assert.equal(name, 'hp_prime_get_files_json');
            return JSON.stringify(finalFiles);
        }
    };
    const state = {
        module,
        activeFamily: 'hp-prime',
        features: 123,
        dirlist: [{ name: 'stale' }],
        hpFileSnapshotLoaded: true,
        hpFileRefreshGeneration: 0,
        hpFileRenderGeneration: 0
    };
    const context = {
        console,
        state,
        DEVICE_FAMILY_HP_PRIME: 'hp-prime',
        t(key) { return key; },
        requestAnimationFrame(callback) {
            frames.push(callback);
            return frames.length;
        },
        renderDirlist(entries) {
            rendered.push(Array.from(entries, entry => ({
                name: entry.name,
                hpIndex: entry.hpIndex
            })));
        }
    };
    vm.createContext(context);
    for (const name of [
        'isHPPrimeActive', 'mapHPPrimeFileEntry', 'hpPrimeAppPartTypeName',
        'mapHPPrimeFileEntries', 'applyHPPrimeFileSnapshot',
        'scheduleHPPrimeProgressRender', 'appendHPPrimeFileArrival',
        'beginHPPrimeFileSnapshot', 'finishHPPrimeFileSnapshot'
    ]) {
        vm.runInContext(extractFunction(name), context);
    }

    const refresh = context.beginHPPrimeFileSnapshot(module);
    assert.equal(state.dirlist.length, 0, 'refresh clears the stale snapshot immediately');
    assert.equal(state.hpFileSnapshotLoaded, false);
    assert.deepEqual(rendered, [[]], 'the loading state is rendered immediately');

    module.__hpPrimeFileArrived(JSON.stringify({
        index: 7,
        name: 'M0',
        type: 4,
        typeName: 'Matrix',
        extension: 'hpmat',
        size: 24,
        invalid: false
    }));
    module.__hpPrimeFileArrived(JSON.stringify({
        index: 11,
        name: 'Notes',
        type: 9,
        typeName: 'Note',
        extension: 'hpnote',
        size: 80,
        invalid: true
    }));
    assert.equal(state.dirlist.length, 2, 'entries append as callbacks arrive');
    assert.equal(state.dirlist[0].hpIndex, 7, 'the bridge cache index stays stable');
    assert.equal(state.dirlist[1].hpIndex, 11, 'non-contiguous supplied indexes are preserved');
    assert.equal(frames.length, 1, 'multiple arrivals coalesce into one animation frame');
    frames.shift()();
    assert.deepEqual(rendered.at(-1), [
        { name: 'M0', hpIndex: 7 },
        { name: 'Notes', hpIndex: 11 }
    ]);

    finalFiles = [{
        index: 0,
        name: 'Authoritative',
        type: 2,
        typeName: 'Program',
        extension: 'hpprgm',
        size: 42,
        invalid: false
    }];
    const count = context.finishHPPrimeFileSnapshot(module, refresh, true);
    assert.equal(count, 1);
    assert.equal(state.hpFileSnapshotLoaded, true);
    assert.equal(state.dirlist[0].name, 'Authoritative',
        'the completed C cache replaces the progressive view');
    assert.equal(module.__hpPrimeFileArrived, null,
        'the operation callback is detached after completion');

    const failedRefresh = context.beginHPPrimeFileSnapshot(module);
    module.__hpPrimeFileArrived(JSON.stringify({
        index: 3,
        name: 'Recovered',
        type: 2,
        typeName: 'Program',
        extension: 'hpprgm',
        size: 9,
        invalid: false
    }));
    assert.equal(context.finishHPPrimeFileSnapshot(module, failedRefresh, false), 1);
    assert.equal(state.dirlist[0].name, 'Recovered',
        'a failed refresh retains already received rows');
    assert.equal(state.hpFileSnapshotLoaded, false,
        'a partial snapshot is not marked authoritative');

    const staleRefresh = context.beginHPPrimeFileSnapshot(module);
    state.module = {};
    assert.equal(staleRefresh.callback(JSON.stringify({
        index: 99,
        name: 'Stale',
        type: 2,
        typeName: 'Program',
        extension: 'hpprgm',
        size: 1,
        invalid: false
    })), false, 'callbacks from a retired module are ignored');
    assert.equal(state.dirlist.length, 0);
}

async function testWebUsbDiscoveryNarrowsWebHidRequest() {
    const discoveryDevice = {
        vendorId: 0x03F0,
        productId: 0x2441,
        productName: 'HP Prime discovery device'
    };
    const hidDevice = {
        vendorId: 0x03F0,
        productId: 0x2441,
        productName: 'HP Prime HID device'
    };
    let requestedFilters = null;
    const context = {
        console,
        HP_VENDOR_ID: 0x03F0,
        HP_PRIME_PRODUCT_IDS: new Set([0x0441, 0x1541, 0x2441]),
        navigator: {
            hid: {
                async requestDevice(options) {
                    requestedFilters = options.filters;
                    return [hidDevice];
                }
            }
        },
        self: { isSecureContext: true },
        t(key) { return key; }
    };
    vm.createContext(context);
    vm.runInContext(extractFunction('isHPPrimeDevice'), context);
    vm.runInContext(extractFunction('requestHPPrimeDevice'), context);

    const selected = await context.requestHPPrimeDevice(discoveryDevice);
    assert.equal(selected, hidDevice,
        'the actual HIDDevice, not the discovery USBDevice, is returned');
    assert.deepEqual(Array.from(requestedFilters, filter => [filter.vendorId, filter.productId]),
        [[0x03F0, 0x2441]],
        'WebHID authorization is narrowed to the product discovered through WebUSB');
}

async function testPrimeFilePreviews() {
    const objectUrls = [];
    const context = {
        console,
        Blob,
        TextDecoder,
        HP_PRIME_TEXT_PREVIEW_EXTENSIONS: new Set([
            'hpappnote', 'hpappprgm', 'hpprgm'
        ]),
        TIVARS_PREVIEW_CALC_MODELS: new Set(),
        EVO_PYTHON_CALC_MODELS: new Map(),
        TIVARS_EVO_PREVIEW_TYPES: new Set(),
        TIVARS_LEGACY_PREVIEW_TYPES: new Set(),
        t(key) {
            return {
                hp_prime_text_preview_invalid: 'incomplete UTF-16LE code unit',
                hp_prime_png_preview_invalid: 'invalid signature'
            }[key] || key;
        },
        URL: {
            createObjectURL(blob) {
                objectUrls.push(blob);
                return 'blob:prime-preview';
            }
        }
    };
    vm.createContext(context);
    for (const name of [
        'getEntryExtension', 'getHPPrimePreviewKind', 'canPreviewVariable',
        'decodeHPPrimeTextPreview', 'createHPPrimePreview',
        'unwrapReadablePreview'
    ]) {
        vm.runInContext(extractFunction(name), context);
    }

    const textEntries = [
        { name: 'Notes.hpappnote', kind: 'hp-app-child' },
        { name: 'Program', extension: '.HPAPPPRGM', kind: 'hp-app-child' },
        { name: 'Standalone', extension: 'hpprgm', kind: 'hp' }
    ];
    for (const entry of textEntries) {
        assert.equal(context.getHPPrimePreviewKind(entry), 'text');
        assert.equal(context.canPreviewVariable({ ...entry, is_folder: 0 }, 0), true);
    }
    assert.equal(context.canPreviewVariable({
        name: 'note', extension: 'hpnote', kind: 'hp', is_folder: 0
    }, 0), false, 'unsupported Prime file types retain no preview action');
    assert.equal(context.canPreviewVariable({
        name: 'Folder', extension: 'hpappprgm', kind: 'hp', is_folder: 1
    }, 0), false, 'folders never receive a preview action');

    const source = 'EXPORT café()\r\nBEGIN\r\n  RETURN "✓";\r\nEND;\u0000';
    const utf16 = Buffer.from(source, 'utf16le');
    const withBom = Buffer.concat([Buffer.from([0xFF, 0xFE]), utf16]);
    assert.equal(context.decodeHPPrimeTextPreview(withBom), source.slice(0, -1),
        'Prime UTF-16LE source drops its BOM and trailing terminator');
    assert.throws(() => context.decodeHPPrimeTextPreview(Uint8Array.of(0x41)),
        /incomplete UTF-16LE/);

    const png = Uint8Array.of(
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
        0x00, 0x00, 0x00, 0x00
    );
    const imagePreview = context.createHPPrimePreview({
        name: 'icon.png', kind: 'hp-app-child'
    }, png);
    assert.equal(imagePreview.objectUrl, 'blob:prime-preview');
    assert.equal(objectUrls.length, 1);
    assert.equal(objectUrls[0].type, 'image/png');
    assert.deepEqual(
        JSON.parse(JSON.stringify(context.unwrapReadablePreview(imagePreview.readable))),
        { content: '', imageDataUrl: 'blob:prime-preview', language: '' },
        'PNG previews reuse the image surface without stray JSON content'
    );
    assert.throws(() => context.createHPPrimePreview({
        name: 'broken.png', kind: 'hp-app-child'
    }, Uint8Array.of(1, 2, 3)), /invalid signature/);
}

async function testPrimePreviewUsesCachedAppChild() {
    const calls = [];
    const opened = [];
    const files = new Map();
    const module = {
        FS: {
            analyzePath() { return { exists: true }; },
            mkdir() {},
            readFile(path) { return files.get(path) || Uint8Array.of(); },
            unlink(path) { files.delete(path); }
        }
    };
    const context = {
        console,
        URL: { revokeObjectURL() {} },
        canPreviewVariable() { return true; },
        getHPPrimePreviewKind() { return 'image'; },
        getEntryExtension() { return 'png'; },
        confirm() { return true; },
        tFormat(key) { return key; },
        formatHPPrimeError() { return 'mock'; },
        setButtonLoading() {},
        async initModule() { return module; },
        async ccallAsync(_module, name, _returnType, _argTypes, args) {
            calls.push([name, Array.from(args)]);
            files.set(args.at(-1), Uint8Array.of(1, 2, 3));
            return 0;
        },
        createHPPrimePreview() {
            return { readable: '{"previewImageDataUrl":"blob:test"}', objectUrl: '' };
        },
        closePreviewModal() {},
        openPreviewModal(entry, readable) { opened.push([entry.name, readable]); },
        log() {},
        logError(error) { throw error; }
    };
    vm.createContext(context);
    vm.runInContext('let previewSession = null;', context);
    vm.runInContext(extractFunction('previewEntry'), context);
    await context.previewEntry({
        name: 'icon.png', typeName: 'Application resource', size: 3,
        kind: 'hp-app-child', isFolder: false, invalid: false,
        hpIndex: 4, hpAppChildIndex: 7, extension: 'png'
    }, {});

    assert.deepEqual(calls, [[
        'hp_prime_download_cached_app_child',
        [4, 7, '/previews/hp-prime-4-child-7.bin']
    ]], 'Prime previews read the already-cached application child');
    assert.equal(opened.length, 1);
    assert.equal(opened[0][0], 'icon.png');
    const session = vm.runInContext('previewSession', context);
    assert.equal(session.downloadName, 'icon.png');
    assert.equal(session.receivedPath, '/previews/hp-prime-4-child-7.bin');
}

function pngChunk(type, data) {
    const chunk = Buffer.alloc(12 + data.length);
    chunk.writeUInt32BE(data.length, 0);
    chunk.write(type, 4, 4, 'ascii');
    data.copy(chunk, 8);
    // The frontend validates framing and pixel data, while the browser PNG
    // decoder remains responsible for CRC validation on ordinary PNGs.
    return chunk;
}

function paethPredictor(left, above, upperLeft) {
    const estimate = left + above - upperLeft;
    const leftDistance = Math.abs(estimate - left);
    const aboveDistance = Math.abs(estimate - above);
    const upperLeftDistance = Math.abs(estimate - upperLeft);
    if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
    return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function makePrimeRgb555Png(width, words, filters) {
    const height = filters.length;
    assert.equal(words.length, width * height);
    const stride = width * 2;
    const raw = Buffer.alloc(stride * height);
    words.forEach((word, index) => raw.writeUInt16LE(word, index * 2));
    const filtered = Buffer.alloc((stride + 1) * height);
    let target = 0;
    for (let y = 0; y < height; y += 1) {
        const filter = filters[y];
        filtered[target++] = filter;
        const rowOffset = y * stride;
        const previousRowOffset = rowOffset - stride;
        for (let x = 0; x < stride; x += 1) {
            const left = x >= 2 ? raw[rowOffset + x - 2] : 0;
            const above = y > 0 ? raw[previousRowOffset + x] : 0;
            const upperLeft = y > 0 && x >= 2 ? raw[previousRowOffset + x - 2] : 0;
            let predictor = 0;
            if (filter === 1) predictor = left;
            else if (filter === 2) predictor = above;
            else if (filter === 3) predictor = Math.floor((left + above) / 2);
            else if (filter === 4) predictor = paethPredictor(left, above, upperLeft);
            filtered[target++] = (raw[rowOffset + x] - predictor) & 0xFF;
        }
    }

    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 16;
    header[9] = 0;
    const compressed = zlib.deflateSync(filtered);
    const split = Math.floor(compressed.length / 2);
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        pngChunk('IHDR', header),
        pngChunk('IDAT', compressed.subarray(0, split)),
        pngChunk('IDAT', compressed.subarray(split)),
        pngChunk('IEND', Buffer.alloc(0))
    ]);
}

async function testPrimeRgb555ScreenshotDecoding() {
    const words = [
        0x7C00, 0x03E0,
        0x001F, 0x7FFF,
        0x0000, 0x4210,
        0x7C1F, 0x03FF,
        0x421F, 0x7FE0
    ];
    const png = makePrimeRgb555Png(2, words, [0, 1, 2, 3, 4]);
    const context = {
        console,
        Blob,
        Response,
        DecompressionStream
    };
    vm.createContext(context);
    for (const name of [
        'hpPrimePngPaethPredictor', 'parseHPPrimeRgb555Png',
        'decodeHPPrimeRgb555Png'
    ]) {
        vm.runInContext(extractFunction(name), context);
    }
    const ContextUint8Array = vm.runInContext('Uint8Array', context);
    const decoded = await context.decodeHPPrimeRgb555Png(new ContextUint8Array(png));
    assert.equal(decoded.width, 2);
    assert.equal(decoded.height, 5);

    const expand = value => (value << 3) | (value >> 2);
    const expected = [];
    for (const word of words) {
        expected.push(
            expand((word >> 10) & 0x1F),
            expand((word >> 5) & 0x1F),
            expand(word & 0x1F),
            0xFF
        );
    }
    assert.deepEqual(expected.slice(0, 16), [
        255, 0, 0, 255,
        0, 255, 0, 255,
        0, 0, 255, 255,
        255, 255, 255, 255
    ], 'Prime RGB555 channel positions decode red, green, blue and white');
    assert.deepEqual(Array.from(decoded.rgba), expected,
        'all PNG filters decode to the original little-endian RGB555 colors');
}

async function testAppDirectoryImport() {
    const { File } = require('node:buffer');
    const context = vm.createContext({
        File, Uint8Array, DataView,
        tFormat: (key, values) => key + ': ' + values.folder
    });
    for (const name of ['getDroppedFiles', 'packHPPrimeAppDirectory',
        'readHPPrimeAppDirectory', 'getDroppedTransferFiles', 'getHPPrimePickedDirectory']) {
        vm.runInContext(extractFunction(name), context);
    }
    const descriptor = new File([Uint8Array.of(0x7c, 0x61, 0x8a, 0xb2)], 'Gallery.hpapp');
    const note = new File(['notes'], 'Gallery.hpappnote');
    const program = new File(['program'], 'Gallery.hpappprgm');
    const resource = new File([Uint8Array.of(0, 255, 17, 0)], 'café🖼.png');
    const app = await context.packHPPrimeAppDirectory('Gallery.hpappdir',
        [resource, program, descriptor, note, new File(['Finder'], '.DS_Store')]);
    assert.equal(app.name, 'Gallery.hpapp');
    assert.equal(app.hpAppDirectory, true);
    const bytes = Buffer.from(await app.arrayBuffer());
    let offset = 0;
    for (const file of [descriptor, note, program]) {
        const size = bytes.readUInt32BE(offset);
        offset += 4;
        assert.deepEqual(bytes.subarray(offset, offset + size), Buffer.from(await file.arrayBuffer()),
            'core sections are ordered descriptor/note/program and preserve exact bytes');
        offset += size;
    }
    const resourceSize = bytes.readUInt32BE(offset);
    offset += 4;
    const encodedName = Buffer.from(resource.name + '\0', 'utf16le');
    assert.equal(resourceSize, encodedName.length + resource.size);
    assert.deepEqual(bytes.subarray(offset, offset + encodedName.length), encodedName);
    offset += encodedName.length;
    assert.deepEqual(bytes.subarray(offset), Buffer.from(await resource.arrayBuffer()));
    const minimal = await context.packHPPrimeAppDirectory('Gallery.hpappdir', [descriptor]);
    assert.equal(minimal.size, 12 + descriptor.size, 'missing note/program produce empty sections');
    for (const [folder, files] of [
        ['Gallery', [descriptor]], ['Gallery.hpappdir', []],
        ['Other.hpappdir', [descriptor]],
        ['Gallery.hpappdir', [descriptor, new File(['x'], 'GALLERY.HPAPP')]],
        ['Gallery.hpappdir', [descriptor, new File(['x'], 'nested/image.png')]],
        ['Gallery.hpappdir', [descriptor, new File(['x'], 'Other.hpappprgm')]]
    ]) {
        await assert.rejects(context.packHPPrimeAppDirectory(folder, files), /hp_prime_app_folder_invalid/);
    }
    const child = file => ({ isFile: true, name: file.name, file: resolve => resolve(file) });
    let reads = 0;
    const batches = [[child(descriptor)], Array.from({ length: 105 }, (_, i) => child(new File([String(i)], i + '.png'))), []];
    const folderEntry = {
        isDirectory: true, name: 'Gallery.hpappdir',
        createReader: () => ({ readEntries: resolve => { reads++; resolve(batches.shift()); } })
    };
    let storeReadable = true;
    const plainFile = new File(['outside'], 'test.hpprgm');
    const pending = context.getDroppedTransferFiles({ dataTransfer: {
        files: [], items: [folderEntry, null].map((entry, i) => ({
            kind: 'file',
            webkitGetAsEntry: () => { assert.ok(storeReadable); return entry; },
            getAsFile: () => { assert.ok(storeReadable); return i ? plainFile : null; }
        }))
    } });
    storeReadable = false;
    const dropped = await pending;
    assert.equal(reads, 3, 'read every batch until an empty batch');
    assert.equal(dropped.length, 2, 'mixed app folders and ordinary files are retained');
    assert.equal(dropped[1], plainFile);
    const picked = new File([await descriptor.arrayBuffer()], descriptor.name);
    Object.defineProperty(picked, 'webkitRelativePath', { value: 'Gallery.hpappdir/Gallery.hpapp' });
    assert.equal((await context.getHPPrimePickedDirectory([picked]))[0].name, 'Gallery.hpapp');
    const nested = new File(['x'], 'x.png');
    Object.defineProperty(nested, 'webkitRelativePath', { value: 'Gallery.hpappdir/sub/x.png' });
    await assert.rejects(context.getHPPrimePickedDirectory([picked, nested]), /hp_prime_app_folder_invalid/,
        'nested directories must not be silently flattened');
    await assert.rejects(context.readHPPrimeAppDirectory({
        name: 'Gallery.hpappdir', createReader: () => ({ readEntries: (_resolve, reject) => reject(new Error('read denied')) })
    }), /read denied/, 'directory read failures are propagated');
}

Promise.all([
    testAppDirectoryImport(),
    testFamilyUiState(),
    testTableDropUsesPrimeTransferPath(),
    testApplicationMappingAndDropDispatch(),
    testApplicationDownloadDispatch(),
    testApplicationMutationDispatch(),
    testWebHidRebinding(),
    testBatchDownloadContinues(),
    testProgressivePrimeFileSnapshot(),
    testWebUsbDiscoveryNarrowsWebHidRequest(),
    testPrimeFilePreviews(),
    testPrimePreviewUsesCachedAppChild(),
    testPrimeRgb555ScreenshotDecoding()
]).then(() => {
    console.log('HP Prime frontend regression tests passed');
}).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
