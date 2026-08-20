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
        isHPLegacyActive() { return false; },
        isCasioActive() { return true; }
    };
    vm.createContext(context);
    vm.runInContext(extractFunction('isTransportEventForActiveDevice'), context);

    assert.equal(context.isTransportEventForActiveDevice({ device: casio }), true);
    assert.equal(context.isTransportEventForActiveDevice({ device: unrelated }), false,
        'an unrelated USB event must not tear down the active Cahute session');
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
    await testUploadConfirmsOverwriteBeforeNativeCall();
    await testFolderDownloadExpandsToFiles();
    console.log('Casio frontend regression tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
