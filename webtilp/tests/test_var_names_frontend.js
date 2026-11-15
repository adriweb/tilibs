'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
function extract(name) {
    const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
    assert.ok(start >= 0, name);
    const next = /\n(?:async )?function \w+\(/g;
    next.lastIndex = start + 1;
    const end = next.exec(source);
    return source.slice(start, end ? end.index : source.length);
}

async function check() {
    const calls = [], errors = [];
    let selected = [];
    const module = {FS: {analyzePath: () => ({exists: true}), unlink() {}, readFile: () => JSON.stringify({vars: state.dirlist, apps: []})}};
    const state = {activeFamily: 'ti', dirlist: [], settings: {}};
    const context = vm.createContext({
        state, console, Number, Error, URL,
        els: {btnRecvSelected: {}, btnDeleteSelected: {}},
        PROGRESS_IDLE_TIMEOUT_MS: 5000,
        isHPPrimeActive: () => false, isNumWorksActive: () => false,
        isNspireActive: () => false, isTI89TActive: () => true,
        authorizeDevice: async () => {}, initModule: async () => module,
        ensureHandle: async () => 42, ensureCableOpen: async () => 42,
        getActiveCalcModelId: () => 14, canPreviewVariable: () => true,
        getHPPrimePreviewKind: () => '',
        getSelectedVarInputs: () => selected,
        normalizeFolderPath: path => path || '',
        prompt: () => 'NEW', confirm: () => true,
        t: key => key, tFormat: key => key,
        setButtonLoading() {}, log() {}, logError: error => errors.push(error),
        refreshDirlist: async () => {}, updateCapabilities: async () => {},
        downloadLastReceived: async () => {},
        formatErrorResult: (_module, result) => String(result),
        isVarFileClass: () => true, confirmEvoOsModelMismatch: () => true,
        findDirlistMatch: () => state.dirlist[0],
        hasSilverlinkConnected: () => false,
        clearNativeWarnings() {}, getNativeWarningSuffix: () => '',
        async ccallAsync(_module, name, _ret, types, args, options) {
            assert.equal(types.length, args.length, name);
            calls.push({name, args: [...args], options});
            // Stop previews at the receive boundary; other UI paths may finish.
            return args.includes('/previews') ? 4 : 0;
        }
    });
    vm.runInContext(['getVariableReceiveTimeout', 'buildSelectionKey', 'buildEntryFromCheckbox', 'getTiFolderRequestHex', 'receiveSelected',
        'deleteSelected', 'isSameDeleteFolder', 'getEntryFolderPath', 'readTiDeletionDirlist', 'deleteEntriesWithSession', 'renameEntry', 'deleteEntry', 'downloadEntry', 'previewEntry',
        'downloadFolderEntriesWithSession', 'performTransfers'].map(extract).join('\n'), context);
    const checkbox = {dataset: {
        name: 'L₁', folder: 'α', type: '1', kind: 'var',
        nameHex: '5d', folderHex: '80', folderPath: 'α',
        isFolder: '0', hpIndex: '', hpAppChildIndex: ''
    }};
    selected = [checkbox];
    const entry = context.buildEntryFromCheckbox(checkbox);
    assert.equal(entry.name, 'L₁');
    assert.equal(entry.name_hex, '5d');
    assert.equal(entry.folder_hex, '80');
    assert.notEqual(context.buildSelectionKey(checkbox),
        context.buildSelectionKey({dataset: {...checkbox.dataset, nameHex: '5d01'}}));
    state.dirlist = [{...entry, type_name: 'List'}];
    const expect = (name, tail) => {
        const call = calls.findLast(call => call.name === name);
        assert.ok(call, name);
        assert.deepEqual(call.args.slice(-tail.length), tail, name);
    };
    for (const action of [() => context.downloadEntry(entry), () => context.receiveSelected(),
        () => context.downloadFolderEntriesWithSession(module, 42, 'α', false)]) {
        await action();
        expect('calc_recv_var', ['80', '5d']);
    }
    await context.previewEntry(entry, {});
    expect('calc_recv_var', ['/previews', '80', '5d']);
    assert.equal(errors.length, 1);
    assert.equal(errors.pop().message, 'Receive failed (4)');
    for (const action of [() => context.deleteEntry(entry), () => context.deleteSelected()]) {
        await action();
        expect('calc_del_var', ['80', '5d']);
    }
    await context.renameEntry(entry);
    expect('calc_rename_var', ['α', 'NEW', 1, '80', '5d']);
    const appEntry = {...entry, kind: 'app'};
    await context.downloadEntry(appEntry);
    expect('calc_recv_app', ['5d']);
    selected = [{dataset: {...checkbox.dataset, kind: 'app'}}];
    await context.receiveSelected();
    expect('calc_recv_app', ['5d']);

    const folder = {...entry, name: 'α', folder: '', name_hex: '80', folder_hex: '',
        isFolder: true, folderPath: 'α'};
    await context.deleteEntry(folder);
    expect('calc_del_folder', ['α', '80']);
    selected = [{dataset: {...checkbox.dataset, name: 'α', folder: '', nameHex: '80', folderHex: '',
        isFolder: '1', kind: 'folder'}}];
    await context.deleteSelected();
    expect('calc_del_folder', ['α', '80']);
    assert.equal(context.getTiFolderRequestHex({...folder, folder: 'root', folder_hex: '726f6f74'}), '726f6f742f80');

    // The overwrite preflight must address the listed original, even though the
    // outgoing file's metadata only contains a display name.
    state.dirlist = [{...entry, attr: 3}];
    await context.performTransfers([{path: '/NEW.89l', file: {name: 'NEW.89l', size: 12},
        fileClass: 'single', entryName: 'L₁', entryFolder: 'α', entryType: 1,
        locationMask: 3, defaultLocation: 'ram'}], module, {hasArchive: true});
    expect('calc_change_attr', [0, '80', '5d']);
    expect('calc_del_var', ['80', '5d']);
    assert.deepEqual(errors, []);
    // Only the calculator-generated root ZIP may stay silent while the OS
    // prepares it. Single, selected and root-folder downloads must all wait.
    context.isNspireActive = () => true;
    const logs = {...entry, folder: '', folder_hex: '', name: 'NspireLogs.zip', type: 0,
        name_hex: '4e73706972654c6f67732e7a6970', isFolder: false};
    for (const ordinary of [{...logs, name: 'themes.csv'}, {...logs, name: 'NspireLogs'},
        {...logs, folder: 'Examples'}, {...logs, type: 1}]) {
        assert.equal(context.getVariableReceiveTimeout(ordinary), 5000);
    }
    state.dirlist = [logs];
    selected = [{dataset: {name: logs.name, folder: '', type: '0', kind: 'var',
        nameHex: logs.name_hex, folderHex: '', isFolder: '0'}}];
    for (const action of [() => context.downloadEntry(logs), () => context.receiveSelected(),
        () => context.downloadFolderEntriesWithSession(module, 42, '', false)]) {
        calls.length = 0;
        await action();
        const receive = calls.find(call => call.name === 'calc_recv_var');
        assert.ok(receive);
        assert.equal(receive.options.timeoutMs, 125000);
    }
    assert.equal(context.getVariableReceiveTimeout({...logs, filename: 'NspireLogs.zip.tns'}), 5000);
    vm.runInContext(['formatVariableDisplayName', 'findDirlistMatch'].map(extract).join('\n'), context);
    context.calcSupportsFolders = () => true;
    const files = ['config', 'config.tns', 'config.dat', 'config.dat.tns', '.hidden', 'themes.csv'];
    state.dirlist = files.map(filename => ({...logs, filename,
        name: filename.endsWith('.tns') ? filename.slice(0, -4) : filename,
        name_hex: Buffer.from(filename).toString('hex')}));
    assert.equal(context.findDirlistMatch('config', 0, '').filename, 'config.tns');
    assert.equal(context.findDirlistMatch('config.dat', 0, '').filename, 'config.dat.tns');
    for (const file of state.dirlist) {
        assert.equal(context.formatVariableDisplayName(file), file.filename);
        selected = [{dataset: {name: file.name, filename: file.filename, nameHex: file.name_hex,
            folder: '', folderHex: '', type: '0', kind: 'var', isFolder: '0'}}];
        assert.equal(context.buildEntryFromCheckbox(selected[0]).filename, file.filename);
        for (const action of [() => context.downloadEntry(file), () => context.receiveSelected(),
            () => context.deleteEntry(file), () => context.renameEntry(file)]) {
            calls.length = 0;
            await action();
            assert.ok(calls.some(call => call.args.includes(file.name_hex)), file.filename);
        }
    }
    assert.equal(new Set(state.dirlist.map(file => context.buildSelectionKey({dataset: {
        name: file.name, nameHex: file.name_hex, type: '0', kind: 'var'
    }}))).size, files.length, 'same-basename files have distinct selection keys');
    context.isNspireActive = () => false;
    assert.equal(context.getVariableReceiveTimeout(logs), 5000);
    assert.deepEqual(errors, []);
    console.log('Raw variable/folder names survive selection, single/bulk download/delete, preview, rename, app download and overwrite.');
}
check().catch(error => { console.error(error); process.exitCode = 1; });
