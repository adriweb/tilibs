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

async function testFlashDrivePickerDialog() {
    const drive = {};
    const dialog = {
        open: false,
        showModal() { this.open = true; },
        close() { this.open = false; }
    };
    const state = {};
    let finishPicker;
    let rejectPicker;
    const context = {
        state,
        els: { casioFlashDialog: dialog, casioFlashError: {}, btnCancelCasioFlash: {}, btnChooseCasioFlash: {} },
        DEVICE_FAMILY_CASIO: 'casio',
        tFormat: (key, values) => `${key} ${values.error}`,
        setTextContent(element, text) { element.textContent = text; },
        async listCasioFlashFiles(handle) {
            assert.equal(handle, drive);
            assert.equal(dialog.open, false, 'close the instructions as soon as the picker returns');
            return [];
        },
        applyCasioFlashSnapshot() {}, applyActiveFamilyUiState() {}, setStatus() {},
        setConnected(value) { state.connected = value; },
        window: {
            showDirectoryPicker({ mode }) {
                assert.equal(mode, 'readwrite');
                assert.equal(dialog.open, true);
                return new Promise((resolve, reject) => {
                    finishPicker = resolve;
                    rejectPicker = reject;
                });
            }
        }
    };
    vm.createContext(context);
    for (const name of ['openCasioFlashDialog', 'connectCasioFlash']) {
        vm.runInContext(extractFunction(name), context);
    }

    for (const error of [Object.assign(new Error('Canceled'), { name: 'AbortError' }), new Error('Denied'), null]) {
        finishPicker = undefined;
        context.openCasioFlashDialog();
        assert.equal(dialog.open, true);
        assert.equal(finishPicker, undefined, 'opening the instructions must not open the picker');
        const connecting = context.connectCasioFlash();
        assert.equal(typeof finishPicker, 'function', 'the Choose drive click must invoke the picker synchronously');
        assert.equal(context.els.btnChooseCasioFlash.disabled, true);
        if (error) rejectPicker(error);
        else finishPicker(drive);
        await connecting;
        assert.equal(dialog.open, false);
        assert.equal(context.els.btnChooseCasioFlash.disabled, false);
        assert.equal(context.els.btnCancelCasioFlash.disabled, false);
        assert.equal(state.connectInProgress, false);
        assert.equal(context.els.casioFlashError.textContent,
            error?.name === 'Error' ? 'casio_connection_failed Denied' : '');
    }
    assert.equal(state.casioFlashDrive, drive);
    assert.equal(state.connected, true);
}

async function testFlashDriveRowMutations() {
    const file = { name: 'original.g4m', folder: '@MainMem', kind: 'casio', isFolder: false };
    const files = new Map([[file.name, 'source data'], ['Existing.g4m', 'untouched']]);
    const order = [];
    const logs = [];
    let newName = 'replacement.g4m';
    let failCopy = false;
    let failRemove = false;
    let failRefresh = false;
    let allowDelete = true;
    let refreshes = 0;
    const folder = {
        async *keys() { yield* files.keys(); },
        async getFileHandle(name, { create } = {}) {
            if (!files.has(name)) {
                if (!create) throw new DOMException('No such file', 'NotFoundError');
                files.set(name, '');
            }
            return {
                name,
                async getFile() { return new Blob([files.get(name)]); },
                async createWritable() {
                    return new WritableStream({
                        write(bytes) {
                            if (failCopy) throw new Error('disk full');
                            files.set(name, new TextDecoder().decode(bytes));
                        },
                        close() { order.push(`close ${name}`); }
                    });
                }
            };
        },
        async removeEntry(name, options) {
            assert.equal(options, undefined, 'file-row actions must not remove a folder recursively');
            if (failRemove) throw new DOMException('Drive is read-only', 'NotAllowedError');
            order.push(`remove ${name}`);
            files.delete(name);
        }
    };
    const drive = {
        async getDirectoryHandle(name) {
            assert.equal(name, file.folder);
            return folder;
        }
    };
    const context = {
        state: { activeFamily: 'casio', casioFlashDrive: drive },
        els: { btnConnect: {} },
        isHPLegacyActive: () => false,
        normalizeFolderPath: value => value || '',
        prompt(message, currentName) {
            assert.match(message, /casio_flash_mainmem_change/);
            assert.equal(currentName, file.name);
            return newName;
        },
        confirm(message) {
            assert.match(message, /casio_flash_mainmem_change/);
            return allowDelete;
        },
        startProgress() {}, stopProgress() {},
        async refreshCasioFlash(handle) {
            assert.equal(handle, drive);
            refreshes++;
            if (failRefresh) throw new Error('drive listing failed');
        },
        renderDirlist(entries) { logs.push(`render ${Array.from(entries, entry => entry.folder).join(',')}`); },
        t: key => key,
        tFormat: (key, values) => [key, ...Object.values(values)].join(' '),
        log: message => logs.push(message),
        logError: error => logs.push(error.message)
    };
    vm.createContext(context);
    for (const name of [
        'renameEntry', 'deleteEntry', 'getCasioFlashFolder', 'isCasioFlashMainMemory',
        'writeCasioFlashFile', 'renameCasioFlashFile', 'mutateCasioFlashFile'
    ]) {
        vm.runInContext(extractFunction(name), context);
    }

    await context.renameEntry({ ...file, isFolder: true });
    await context.deleteEntry({ ...file, isFolder: true });
    allowDelete = false;
    await context.deleteEntry(file);
    assert.equal(refreshes, 0);
    assert.deepEqual(order, []);

    newName = 'existing.G4M';
    await context.renameEntry(file);
    assert.match(logs.at(-1), /casio_rename_target_exists/);
    assert.equal(files.get('Existing.g4m'), 'untouched');
    assert.equal(files.has(newName), false);

    newName = 'replacement.g4m';
    failCopy = true;
    await context.renameEntry(file);
    assert.match(logs.at(-1), /casio_file_rename_failed.*disk full/);
    assert.equal(files.get(file.name), 'source data');
    assert.equal(files.has(newName), false);
    assert.deepEqual(order.splice(0), [`remove ${newName}`]);

    failCopy = false;
    failRemove = true;
    await context.renameEntry(file);
    assert.match(logs.at(-1), /casio_flash_rename_remove_failed.*Drive is read-only/);
    assert.equal(files.get(file.name), 'source data');
    assert.equal(files.get(newName), 'source data');
    assert.deepEqual(order.splice(0), [`close ${newName}`]);

    failRemove = false;
    newName = 'renamed.g4m';
    await context.renameEntry(file);
    assert.deepEqual(order.splice(0), [`close ${newName}`, `remove ${file.name}`]);
    assert.equal(files.get(newName), 'source data');
    assert.equal(files.has(file.name), false);
    allowDelete = true;
    const renamed = { ...file, name: newName };
    const sameNameElsewhere = { ...renamed, folder: 'Programs' };
    context.state.dirlist = [renamed, sameNameElsewhere];
    failRemove = true;
    await context.deleteEntry(renamed);
    assert.match(logs.at(-1), /casio_file_delete_failed/);
    assert.equal(context.state.dirlist.length, 2, 'a failed delete keeps the row');

    failRemove = false;
    failRefresh = true;
    await context.deleteEntry(renamed);
    assert.deepEqual(order, [`remove ${newName}`]);
    assert.equal(files.has(newName), false);
    assert.deepEqual(context.state.dirlist, [sameNameElsewhere]);
    assert.deepEqual(logs.slice(-3), [
        'render Programs', `casio_file_deleted ${newName}`, 'drive listing failed'
    ], 're-render after confirmed deletion even if the drive scan fails');
    assert.equal(refreshes, 6);
    assert.equal(context.state.casioFlashWriting, false);
    assert.equal(context.els.btnConnect.disabled, false);
}

async function testFlashDriveFamilyDetectionAndDownloads() {
    const makeFile = (name, contents) => ({
        name, kind: 'file', async getFile() { return new File([contents], name); }
    });
    const makeFolder = (name, children) => ({
        name, kind: 'directory',
        async *values() { yield* children; },
        async getDirectoryHandle(name) { return children.find(child => child.name === name); },
        async getFileHandle(name) { return children.find(child => child.name === name); }
    });
    const drive = makeFolder('CASIO', [
        makeFolder('.fseventsd', [makeFile('hidden', 'host metadata')]),
        {
            kind: 'directory', name: 'System Volume Information',
            values() { assert.fail('Windows metadata directory should not be read'); }
        },
        makeFolder('$recycle.bin', [makeFile('deleted.txt', 'recycle bin')]),
        makeFolder('Programs', [
            makeFolder('System Volume Information', [makeFile('example.py', 'calculator data')]),
            makeFile('DESKTOP.INI', 'Explorer settings'),
            makeFile('Thumbs.db', 'thumbnail cache')
        ]),
        makeFolder('@MainMem', [
            makeFile('NUMINEQ.G4M', 'model hint'),
            makeFolder('LISTFILE', [makeFile('LIST01.G4M', 'list data')])
        ]),
        {
            kind: 'file', name: 'gone.g4m',
            async getFile() { throw new DOMException('File disappeared', 'NotFoundError'); }
        },
        makeFile('older.g3m', 'user-supplied storage file')
    ]);
    const downloads = [];
    const state = { casioFlashDrive: drive, casioStorageSupported: true };
    const context = {
        state,
        FEATURE_FLAGS: { FTS_FOLDER: 1, OPS_RENAME: 2, OPS_DELVAR: 4 },
        renderDeviceInfo() {}, updateDeviceModelDisplay() {}, renderDirlist() {},
        normalizeFolderPath: value => value || '',
        confirm: () => true, t: key => key, tFormat: key => key, log() {},
        triggerDownload: (name, file) => downloads.push({ name, file })
    };
    vm.createContext(context);
    for (const name of [
        'listCasioFlashFiles', 'applyCasioFlashSnapshot', 'getCasioFlashFolder',
        'downloadCasioEntry', 'downloadCasioEntries'
    ]) {
        vm.runInContext(extractFunction(name), context);
    }
    const entries = await context.listCasioFlashFiles(drive);
    assert.deepEqual(Array.from(entries, entry => [entry.folder, entry.name].filter(Boolean).join('/')), [
        'Programs', 'Programs/System Volume Information', 'Programs/System Volume Information/example.py',
        '@MainMem', '@MainMem/NUMINEQ.G4M', '@MainMem/LISTFILE', '@MainMem/LISTFILE/LIST01.G4M',
        'older.g3m'
    ]);
    context.applyCasioFlashSnapshot(drive, entries);
    assert.equal(state.deviceModelName, 'Graph Math+ / fx-CG100');
    assert.equal(state.features, 7, 'flash mode enables folder browsing and file row mutations');
    assert.equal(state.deviceInfoEntries[2].value, 'CASIO');
    await context.downloadCasioEntries([{ isFolder: true, folderPath: '@MainMem' }]);
    assert.deepEqual(downloads.map(({ name }) => name), ['NUMINEQ.G4M', 'LIST01.G4M']);
    assert.equal(await downloads[1].file.text(), 'list data');
    context.applyCasioFlashSnapshot(drive, [{ folder: '@MainMem', name: 'SYSTEM.g3m' }]);
    assert.equal(state.deviceModelName, 'fx-CG (G3M)');
    context.applyCasioFlashSnapshot(drive, [{ folder: '', name: 'STORAGE.g4m' }]);
    assert.equal(state.deviceModelName, 'Casio', 'root storage copies do not identify the device');
}

async function testFlashDriveUploadDestinations() {
    const makeFolder = (name, children = []) => ({
        name, kind: 'directory',
        async *values() { yield* children; },
        async getDirectoryHandle(name) {
            const folder = children.find(child => child.kind === 'directory' && child.name === name);
            assert.ok(folder, `Folder exists: ${name}`);
            return folder;
        }
    });
    const lists = makeFolder('LISTFILE');
    const mainMemory = makeFolder('@MAINMEM', [lists, { name: 'EXISTING.g4m', kind: 'file' }]);
    const storage = makeFolder('Programs');
    const drive = makeFolder('CASIO', [mainMemory, storage]);
    const driveWithoutMainMemory = makeFolder('OTHER', [
        { name: '@MainMem', kind: 'file' },
        makeFolder('nested', [makeFolder('@MainMem')])
    ]);
    const writes = [];
    const prompts = [];
    let confirmOverwrite = false;
    const context = {
        state: { casioFlashDrive: drive },
        els: { btnConnect: { disabled: false } },
        t: key => key, tFormat: (key, values) => [key, values],
        confirm(message) { prompts.push(message); return confirmOverwrite; },
        writeCasioFlashFile(folder, name, _file, replace) { writes.push([folder.name, name, replace]); },
        startProgress() {}, stopProgress() {}, setSelectedFiles() {}, refreshDirlist() {}, log() {}
    };
    vm.createContext(context);
    for (const name of ['normalizeFolderPath', 'getCasioFlashFolder', 'sendCasioFlashFiles']) {
        vm.runInContext(extractFunction(name), context);
    }
    const files = [{ name: 'NEW.g4m' }];
    await context.sendCasioFlashFiles(drive, files);
    await context.sendCasioFlashFiles(drive, files, '@MAINMEM/LISTFILE');
    await context.sendCasioFlashFiles(drive, files, 'Programs');
    await context.sendCasioFlashFiles(drive, files, '');
    await context.sendCasioFlashFiles(driveWithoutMainMemory, files);
    await context.sendCasioFlashFiles(drive, [{ name: 'existing.g4m' }]);
    confirmOverwrite = true;
    await context.sendCasioFlashFiles(drive, [{ name: 'existing.g4m' }]);
    assert.deepEqual(writes, [
        ['@MAINMEM', 'NEW.g4m', false],
        ['LISTFILE', 'NEW.g4m', false],
        ['Programs', 'NEW.g4m', false],
        ['CASIO', 'NEW.g4m', false],
        ['OTHER', 'NEW.g4m', false],
        ['@MAINMEM', 'EXISTING.g4m', true]
    ]);
    assert.deepEqual(prompts.map(([key, values]) => [key, values.file, values.folder]), [
        ['casio_confirm_overwrite', 'EXISTING.g4m', '@MAINMEM'],
        ['casio_confirm_overwrite', 'EXISTING.g4m', '@MAINMEM']
    ]);
}

async function testCasioFlashIgnoresSupersededRefresh() {
    const drive = {};
    const state = { casioFlashDrive: drive };
    const rendered = [];
    let finishOldScan;
    const context = {
        state,
        listCasioFlashFiles() {
            if (finishOldScan) return Promise.resolve([]);
            return new Promise(resolve => { finishOldScan = resolve; });
        },
        applyCasioFlashSnapshot(_drive, entries) { rendered.push(entries); }
    };
    vm.createContext(context);
    vm.runInContext(extractFunction('refreshCasioFlash'), context);
    const oldScan = context.refreshCasioFlash(drive);
    await context.refreshCasioFlash(drive);
    finishOldScan([{ name: 'deleted.g4m' }]);
    await oldScan;
    assert.deepEqual(rendered, [[]], 'a scan started before deletion cannot restore the deleted row');
}

(async () => {
    await testFlashDrivePickerDialog();
    await testFlashDriveFamilyDetectionAndDownloads();
    await testFlashDriveUploadDestinations();
    await testFlashDriveRowMutations();
    await testCasioFlashIgnoresSupersededRefresh();
    console.log('Casio flash drive frontend regression tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
