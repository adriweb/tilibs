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

function makeElement() {
    return {
        disabled: false,
        title: '',
        accept: '',
        textContent: '',
        classList: {
            values: new Set(),
            add(name) { this.values.add(name); },
            remove(name) { this.values.delete(name); },
            toggle(name, force) {
                if (force) this.values.add(name);
                else this.values.delete(name);
            },
            contains(name) { return this.values.has(name); }
        },
        removeAttribute() {}
    };
}

function testCas300UiDisablesStorageActions() {
    const els = {};
    for (const name of [
        'fileInput', 'btnSendFiles', 'keyCodeInput', 'btnSyncClock',
        'btnNewFolder', 'btnReceiveBackup', 'btnRefreshDirlist',
        'btnScreenshot', 'btnIsReady', 'btnReceiveOs',
        'btnDownloadOsPartial', 'btnDumpRom', 'btnLeaveExam'
    ]) {
        els[name] = makeElement();
    }
    const text = {
        dropzoneTitle: makeElement(),
        dropzoneSubtitle: makeElement(),
        panelVarsTitle: makeElement()
    };
    const state = { casioStorageSupported: false, selectedFiles: [] };
    const context = {
        state,
        els,
        document: { getElementById(id) { return text[id] || null; } },
        t(key) { return key; },
        setTextContent(element, value) { element.textContent = value; },
        updateKeyControlsState() {},
        clearKeyMapDataList() {},
        updateSelectionActionButtons() {},
        updateSendFilesButtonState() {
            els.btnSendFiles.disabled = !state.casioStorageSupported;
        }
    };
    vm.createContext(context);
    vm.runInContext(extractFunction('setCasioUiState'), context);

    context.setCasioUiState();
    assert.equal(els.fileInput.disabled, true);
    assert.equal(els.btnRefreshDirlist.disabled, true);
    assert.equal(els.btnSendFiles.disabled, true);
    assert.equal(els.btnScreenshot.disabled, true);
    assert.equal(text.dropzoneSubtitle.textContent,
        'casio_storage_protocol_unavailable');

    state.casioStorageSupported = true;
    context.setCasioUiState();
    assert.equal(els.fileInput.disabled, false);
    assert.equal(els.btnRefreshDirlist.disabled, false);
    assert.equal(text.dropzoneSubtitle.textContent, 'casio_dropzone_subtitle');
}

function testStorageNameLimitMatchesCahuteListingLimit() {
    const context = {};
    vm.createContext(context);
    vm.runInContext(extractFunction('isValidCasioStorageName'), context);

    assert.equal(context.isValidCasioStorageName('A'.repeat(22)), true);
    assert.equal(context.isValidCasioStorageName('A'.repeat(23)), false,
        '23-byte names are skipped by Cahute storage listings');
    assert.equal(context.isValidCasioStorageName('folder/name'), false);
    assert.equal(context.isValidCasioStorageName('é'), false);
}

function testTransportEventsAreScopedToActiveCasio() {
    const casio = { vendorId: 0x07CF, productId: 0x6101 };
    const unrelated = { vendorId: 0x0451, productId: 0xE003 };
    const state = { authorizedDevice: casio, numWorksBackend: null };
    const context = {
        state,
        isCasioActive() { return true; }
    };
    vm.createContext(context);
    vm.runInContext(extractFunction('isTransportEventForActiveDevice'), context);

    assert.equal(context.isTransportEventForActiveDevice({ device: casio }), true);
    assert.equal(context.isTransportEventForActiveDevice({ device: unrelated }), false,
        'an unrelated USB event must not tear down the active Cahute session');
}

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function connectionContext(module, selected) {
    const context = {
        state: { operationEpoch: 0, casioStorageSupported: false, deviceModelName: 'Casio' },
        DEVICE_FAMILY_CASIO: 'casio', CCALL_MIN_GAP_MS: 0, CCALL_TIMEOUT_MS: null,
        async authorizeCasioDevice(forcePrompt, device) {
            assert.equal(forcePrompt, false);
            assert.equal(device, selected);
            return device;
        },
        async initModule() { return module; },
        withTimeout: promise => promise,
        withProgressTimeout: promise => promise,
        isFatalWasmRuntimeError: () => false,
        handleFatalWasmRuntimeError() { assert.fail('unexpected fatal WASM error'); },
        watchAbandonedCcall() {},
        startProgress() {}, stopProgress() {},
        readCasioInfo() { return { protocol: 'CAS300' }; },
        formatCasioError() { return 'mock'; },
        renderDirlist() {},
        setConnected(value) { context.state.connected = value; },
        setStatus() {}, log() {},
        t: key => key, tFormat: key => key
    };
    vm.createContext(context);
    for (const name of ['getModuleCallState', 'makeModuleDeadError', 'ccallAsync', 'connectCasio']) {
        vm.runInContext(extractFunction(name), context);
    }
    return context;
}

async function testConnectionUsesSelectedDeviceAndRestoresFilter() {
    for (const outcome of ['success', 'native-error', 'throw', 'reject']) {
        for (const withPreviousFilter of [false, true]) {
            const first = { vendorId: 0x07CF, productId: 0x6101 };
            const selected = { vendorId: 0x07CF, productId: 0x6101 };
            const originalFilter = () => true;
            const module = withPreviousFilter ? { webusbDeviceFilter: originalFilter } : {};
            const expectedError = new Error('mock USB failure');
            module.ccall = name => {
                assert.equal(name, 'casio_connect');
                assert.deepEqual([first, selected].filter(module.webusbDeviceFilter), [selected],
                    'selection must use object identity, not shared vendor/product IDs');
                if (outcome === 'throw') throw expectedError;
                if (outcome === 'reject') return Promise.reject(expectedError);
                return outcome === 'native-error' ? 1 : 0;
            };
            const context = connectionContext(module, selected);
            if (outcome === 'success') {
                await context.connectCasio(false, selected);
                assert.equal(context.state.connected, true);
            } else {
                await assert.rejects(context.connectCasio(false, selected),
                    outcome === 'native-error' ? /casio_connection_failed/ : expectedError);
            }
            assert.equal(module.webusbDeviceFilter,
                withPreviousFilter ? originalFilter : undefined);
            assert.equal(Object.hasOwn(module, 'webusbDeviceFilter'), withPreviousFilter,
                'native return, rejected promise, and synchronous throw restore enumeration scope');
        }
    }
}

async function testFilterFollowsNativeQueueAndTimeoutLifetime() {
    for (const nativeRejects of [false, true]) {
        for (const retireWhilePending of [false, true]) {
            const first = {}, selected = {};
            const originalFilter = () => true;
            const previous = deferred(), native = deferred(), started = deferred(), timeout = deferred();
            const nativeCalls = [];
            const module = { webusbDeviceFilter: originalFilter };
            module.ccall = name => {
                nativeCalls.push(name);
                if (name === 'ti_before') {
                    assert.equal(module.webusbDeviceFilter, originalFilter);
                    return previous.promise;
                }
                if (name === 'casio_connect') {
                    assert.deepEqual([first, selected].filter(module.webusbDeviceFilter), [selected]);
                    started.resolve();
                    return native.promise;
                }
                assert.equal(name, 'ti_after');
                assert.equal(module.webusbDeviceFilter, originalFilter,
                    'cleanup must precede release of the Asyncify queue');
                return 0;
            };
            const context = connectionContext(module, selected);
            let abandoned = 0;
            context.watchAbandonedCcall = () => { abandoned += 1; };
            context.withProgressTimeout = promise => Promise.race([promise, timeout.promise]);
            const before = context.ccallAsync(module, 'ti_before', 'number', [], []);
            const connection = context.connectCasio(false, selected);
            await new Promise(setImmediate);
            assert.deepEqual(nativeCalls, ['ti_before']);
            assert.equal(module.webusbDeviceFilter, originalFilter,
                'a queued Casio connection must not filter earlier TI enumeration');
            previous.resolve(0);
            await before;
            await started.promise;
            context.state.authorizedDevice = first;
            const timeoutError = Object.assign(new Error('mock timeout'), { ccallTimeout: true });
            timeout.reject(timeoutError);
            await assert.rejects(connection, timeoutError);
            assert.equal(abandoned, 1);
            assert.deepEqual([first, selected].filter(module.webusbDeviceFilter), [selected],
                'wrapper timeout must retain the exact selection while native execution is suspended');

            let after;
            if (retireWhilePending) {
                context.getModuleCallState(module).markDead('test retirement');
            } else {
                after = context.ccallAsync(module, 'ti_after', 'number', [], []);
                await new Promise(setImmediate);
                assert.deepEqual(nativeCalls, ['ti_before', 'casio_connect']);
            }
            if (nativeRejects) native.reject(new Error('late native failure'));
            else native.resolve(0);
            await context.getModuleCallState(module).tail;
            if (after) await after;
            assert.equal(module.webusbDeviceFilter, originalFilter,
                'late fulfillment/rejection restores scope even after module retirement');
        }
    }
}

async function testCancelledQueuedConnectionNeverInstallsFilter() {
    for (const retire of [false, true]) {
        const selected = {}, gate = deferred();
        const originalFilter = () => true;
        let filterWrites = 0;
        const module = new Proxy({
            webusbDeviceFilter: originalFilter,
            ccall() { assert.fail('cancelled queued call must never enter WASM'); }
        }, {
            set(target, property, value) {
                if (property === 'webusbDeviceFilter') filterWrites += 1;
                target[property] = value;
                return true;
            }
        });
        const context = connectionContext(module, selected);
        context.getModuleCallState(module).tail = gate.promise;
        const connection = context.connectCasio(false, selected);
        await new Promise(setImmediate);
        if (retire) context.getModuleCallState(module).markDead('queued retirement');
        else context.state.operationEpoch += 1;
        gate.resolve();
        await assert.rejects(connection, retire ? /needs reinitialization/ : /cancelled/);
        assert.equal(module.webusbDeviceFilter, originalFilter,
            'prepareCall must not run for cancellation or retirement before entry');
        assert.equal(filterWrites, 0, 'cancelled queued calls must never install even a temporary filter');
    }
}

async function testUploadConfirmsOverwriteBeforeNativeCall() {
    const nativeCalls = [];
    const logs = [];
    const unlinked = [];
    let confirmResult = false;
    let refreshes = 0;
    const module = {
        FS: {
            writeFile() {},
            unlink(path) { unlinked.push(path); }
        }
    };
    const state = {
        casioStorageSupported: true,
        casioFileSnapshotLoaded: true,
        dirlist: [{
            kind: 'casio', name: 'TEST.g3a', folder: '', is_folder: 0
        }]
    };
    const context = {
        state,
        confirm() { return confirmResult; },
        normalizeFolderPath(value) { return value; },
        async initModule() { return module; },
        async ccallAsync(_module, name, _returnType, _argTypes, args) {
            nativeCalls.push([name, Array.from(args)]);
            return 0;
        },
        async refreshDirlist() { refreshes += 1; },
        setSelectedFiles() {},
        formatCasioError() { return 'mock'; },
        t(key) { return key; },
        tFormat(key) { return key; },
        log(message) { logs.push(message); }
    };
    vm.createContext(context);
    vm.runInContext(extractFunction('isValidCasioStorageName'), context);
    vm.runInContext(extractFunction('sendCasioFiles'), context);
    const file = {
        name: 'TEST.g3a',
        async arrayBuffer() { return Uint8Array.of(1, 2, 3).buffer; }
    };

    await context.sendCasioFiles([file]);
    assert.equal(nativeCalls.length, 0,
        'declining overwrite never reaches the forced Cahute send wrapper');
    assert.equal(refreshes, 0);

    confirmResult = true;
    await context.sendCasioFiles([file]);
    assert.deepEqual(nativeCalls, [[
        'casio_send_file', ['/casio-upload-0.bin', '', 'TEST.g3a']
    ]]);
    assert.equal(refreshes, 1);
    assert.ok(unlinked.includes('/casio-upload-0.bin'));
    assert.ok(logs.includes('casio_file_sent'));
}

async function testBatchUploadConfirmsEachExistingFile() {
    for (const allowOverwrite of [false, true]) {
        const sent = [];
        const confirmations = [];
        const state = {
            casioStorageSupported: true,
            casioFileSnapshotLoaded: true,
            dirlist: [{ kind: 'casio', name: 'B.txt', folder: 'MAIN', is_folder: 0 }]
        };
        const context = {
            state,
            confirm(message) {
                confirmations.push(message);
                return allowOverwrite;
            },
            normalizeFolderPath: value => value,
            async initModule() { return { FS: { writeFile() {}, unlink() {} } }; },
            async ccallAsync(_module, name, _returnType, _argTypes, args) {
                assert.equal(name, 'casio_send_file');
                sent.push(args[2]);
                return 0;
            },
            async refreshDirlist() {},
            setSelectedFiles() {},
            formatCasioError() { return 'mock'; },
            t: key => key,
            tFormat: (key, values) => `${key}:${values.file}`,
            log() {}
        };
        vm.createContext(context);
        vm.runInContext(extractFunction('isValidCasioStorageName'), context);
        vm.runInContext(extractFunction('sendCasioFiles'), context);
        const files = ['A.txt', 'b.TXT'].map(name => ({
            name, async arrayBuffer() { return Uint8Array.of(1).buffer; }
        }));
        await context.sendCasioFiles(files, 'main');
        assert.deepEqual(confirmations, ['casio_confirm_overwrite:b.TXT'],
            'the first successful send must not suppress later collision checks');
        assert.deepEqual(sent, allowOverwrite ? ['A.txt', 'b.TXT'] : ['A.txt']);
        assert.equal(state.casioFileSnapshotLoaded, false,
            'the shared snapshot still becomes stale after a successful send');
    }
}

async function testFolderDownloadExpandsToFiles() {
    const downloaded = [];
    const state = {
        dirlist: [
            { kind: 'casio', name: 'A.g3a', folder: 'main', is_folder: 0 },
            { kind: 'casio', name: 'B.txt', folder: 'main', is_folder: 0 },
            { kind: 'casio', name: 'ROOT.bin', folder: '', is_folder: 0 }
        ]
    };
    const context = {
        state,
        normalizeFolderPath(value) { return value; },
        confirm() { return true; },
        tFormat(key) { return key; },
        async downloadCasioEntry(entry) { downloaded.push(entry.name); },
        log() {}
    };
    vm.createContext(context);
    vm.runInContext(extractFunction('downloadCasioEntries'), context);
    await context.downloadCasioEntries([{
        name: 'main', folderPath: 'main', isFolder: true, kind: 'folder'
    }]);
    assert.deepEqual(downloaded, ['A.g3a', 'B.txt']);
}

(async () => {
    testCas300UiDisablesStorageActions();
    testStorageNameLimitMatchesCahuteListingLimit();
    testTransportEventsAreScopedToActiveCasio();
    await testConnectionUsesSelectedDeviceAndRestoresFilter();
    await testFilterFollowsNativeQueueAndTimeoutLifetime();
    await testCancelledQueuedConnectionNeverInstallsFilter();
    await testUploadConfirmsOverwriteBeforeNativeCall();
    await testBatchUploadConfirmsEachExistingFile();
    await testFolderDownloadExpandsToFiles();
    console.log('Casio frontend regression tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
