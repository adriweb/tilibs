'use strict';

const assert = require('node:assert/strict');
const { createFileActions, planReceives } = require('../features/file-actions');
const { createFileModel } = require('../features/file-model');
const { getBackendCapabilities, getEntryPermissions, deriveSelectionActions } = require('../backends/capabilities');
const { createFileBackends } = require('../backends');
const { deriveControlAvailability } = require('../features/capability-ui');

const normalize = value => String(value || '').replace(/^\/+|\/+$/g, '');

function testPlansAndSelection() {
    const files = [
        { name: 'one', kind: 'var', folder: 'a', type: 1 },
        { name: 'two', kind: 'var', folder: 'a/b', type: 1 },
        { name: 'other', kind: 'var', folder: 'c', type: 1 }
    ];
    const folders = [{ name: 'a', isFolder: true }, { name: 'a/b', isFolder: true }];
    const plan = planReceives([...folders, files[1], files[2]], files, 'ti', normalize);
    assert.deepEqual(plan.folders, ['a']);
    assert.deepEqual(plan.entries.map(entry => entry.name), ['other', 'one', 'two']);
    const casio = planReceives([{ name: 'a', isFolder: true }],
        files.map(entry => ({ ...entry, kind: 'casio' })), 'casio', normalize);
    assert.deepEqual(casio.entries.map(entry => entry.name), ['one']);
    const hpPlan = planReceives([
        { name: 'app', hpAppRoot: true, hpIndex: 4 },
        { name: 'code', hpIndex: 4, hpAppChildIndex: 1 },
        { name: 'other', hpIndex: 5, hpAppChildIndex: 0 }
    ], [], 'hp-prime', normalize);
    assert.deepEqual(hpPlan.entries.map(entry => entry.name), ['app', 'other']);

    const model = createFileModel();
    model.replace(files, 'ti');
    const id = model.register(files[1], 'ti');
    model.select(id, true);
    model.replace(files.map(entry => ({ ...entry, size: 500 })), 'ti');
    assert.equal(model.selectedEntries()[0].size, 500, 'selection owns current metadata');
    model.replace(files, 'casio');
    assert.equal(model.selectedEntries().length, 0, 'a family transition clears stale selection');
    model.select(model.register(files[0], 'casio'), true);
    model.replace([], 'casio');
    model.pruneSelection();
    assert.equal(model.selectedIds.size, 0, 'removed entries cannot remain selected');
}

function testCapabilities() {
    const flags = { OPS_DIRLIST: 8, OPS_BACKUP: 16, FTS_BACKUP: 1 << 20,
        OPS_DELVAR: 1 << 12, OPS_RENAME: 1 << 14 };
    const backup = getBackendCapabilities({ activeFamily: 'ti', features: flags.OPS_BACKUP }, flags, 2);
    assert.equal(backup.nativeDirectory, false);
    assert.equal(backup.backupDirectory, true);
    assert.equal(getEntryPermissions({ kind: 'backup-var' }, backup).receive, false);
    const backupUi = deriveControlAvailability(backup, { tiCapabilitiesKnown: true, backupLoaded: false });
    assert.equal(backupUi.varsPanel.hidden, true);
    assert.equal(backupUi.btnBackupDirlist.hidden, false);
    assert.equal(backupUi.btnRefreshDirlist.disabled, false);
    assert.equal(deriveControlAvailability(backup, { tiCapabilitiesKnown: true,
        backupLoaded: true }).varsPanel.hidden, false);
    const hp = getBackendCapabilities({ activeFamily: 'hp-prime', hpFileSnapshotLoaded: true }, flags, 0);
    assert.equal(hp.nativeDirectory, false);
    assert.equal(hp.cachedDirectory, true);
    assert.equal(getEntryPermissions({ hpAppRoot: true }, hp).remove, false);
    assert.equal(getEntryPermissions({ hpAppChildEditable: true, hpAppChildIndex: 0 }, hp).remove, true);
    assert.equal(deriveSelectionActions([{ hpAppChildEditable: true, hpAppChildIndex: 0 }], hp).remove, false,
        'HP cache indices can shift on delete; batch remove remains unavailable');
}

function createFixture(family = 'ti') {
    const storage = new Map();
    const calls = [];
    const downloads = [];
    const state = { activeFamily: family, dirlist: [], casioStorageSupported: true,
        hpFileSnapshotLoaded: true, expandedFolders: new Set() };
    const FS = {
        analyzePath: path => ({ exists: storage.has(path) }),
        mkdir: path => storage.set(path, null),
        readFile(path) { if (!storage.has(path)) throw new Error(`missing ${path}`); return storage.get(path); },
        unlink: path => storage.delete(path)
    };
    const module = { FS };
    const call = async (name, _result, _types, args) => {
        calls.push({ name, args });
        if (name === 'calc_recv_var') {
            const path = `/downloads/${args[2]}.8xp`;
            storage.set(path, Uint8Array.of(args[2].charCodeAt(0)));
            storage.set('/last_recv_path.txt', path);
        } else if (name === 'hp_prime_download_cached_file' || name === 'hp_prime_download_cached_app_child'
            || name === 'casio_receive_file') storage.set(args.at(-1), Uint8Array.of(42));
        return 0;
    };
    let queue = Promise.resolve();
    const runOperation = (_module, callback) => {
        const result = queue.then(() => callback(call, { assertCurrent() {} }));
        queue = result.catch(() => {});
        return result;
    };
    const deps = { state, initModule: async () => module, ensureHandle: async () => 7,
        authorizeDevice: async () => {}, runOperation, ccallAsync: async (_module, ...args) => call(...args),
        formatErrorResult: (_module, error) => `TI ${error}`,
        formatCasioError: (_module, error) => `Casio ${error}`,
        formatHPPrimeError: (_module, error) => `HP ${error}`,
        t: key => key, tFormat: (key, args) => `${key} ${JSON.stringify(args)}`, confirm: () => true,
        log() {}, logError(error) { throw error; }, normalizeFolderPath: normalize,
        triggerDownload: (filename, data) => downloads.push({ filename, data }),
        convertReceivedPythonFile: async () => null, idleTimeout: 60000,
        setButtonLoading() {}, els: {}, refreshDirlist: async () => {},
        applyHPPrimeFileSnapshot() {}, applyNumWorksStorageSnapshot() {}, readNumWorksInfo() {},
        runSharpOperation: async (_label, callback) => callback(state.sharpBackend),
        saveSharpDownload: result => downloads.push(result) };
    const backends = createFileBackends(deps);
    return { deps, backends, state, storage, calls, downloads,
        actions: createFileActions({ ...deps, backends }) };
}

async function testTiMarkerAndCleanup() {
    const fixture = createFixture();
    const [a, b] = await Promise.all([
        fixture.backends.ti.receiveEntry({ name: 'A', kind: 'var', type: 1 }),
        fixture.backends.ti.receiveEntry({ name: 'B', kind: 'var', type: 1 })
    ]);
    assert.equal(a.filename, 'A.8xp');
    assert.equal(a.data[0], 65);
    assert.equal(b.filename, 'B.8xp');
    assert.equal(b.data[0], 66);
    assert.equal(fixture.storage.has('/last_recv_path.txt'), false);
    assert.equal([...fixture.storage.keys()].filter(path => path.endsWith('.8xp')).length, 0);

    const broken = createFixture();
    const module = await broken.deps.initModule();
    const readFile = module.FS.readFile;
    module.FS.readFile = path => {
        if (path.endsWith('.8xp')) throw new Error('simulated filesystem read failure');
        return readFile(path);
    };
    await assert.rejects(broken.backends.ti.receiveEntry({ name: 'A', kind: 'var', type: 1 }), /read failure/);
    assert.equal(broken.storage.has('/downloads/A.8xp'), false);
    assert.equal(broken.storage.has('/last_recv_path.txt'), false);
}

async function testStaleResults() {
    const fixture = createFixture('hp-legacy');
    const cancelled = Object.assign(new Error('connection replaced'), { staleSession: true, silent: true });
    let epoch = 1;
    let nativeReceives = 0;
    fixture.state.hpLegacyBackend = { receiveFile: async () => {
        nativeReceives++; epoch++;
        return { name: 'old-object', data: Uint8Array.of(1) };
    } };
    const errors = [];
    const actions = createFileActions({ ...fixture.deps, backends: fixture.backends,
        captureSession: () => epoch, assertSession(token) { if (epoch !== token) throw cancelled; },
        logError: error => errors.push(error) });
    await actions.receiveEntries([{ name: 'first' }, { name: 'second' }]);
    assert.equal(nativeReceives, 1, 'a replaced connection aborts the remaining receive batch');
    assert.equal(fixture.downloads.length, 0, 'stale results cannot reach the browser download');
    assert.deepEqual(errors, [cancelled]);
}

async function testFamilyOperations() {
    const hp = createFixture('hp-prime');
    const cached = await hp.backends['hp-prime'].receiveEntry({ name: 'App', hpIndex: 2, extension: 'hpapp' });
    assert.equal(cached.filename, 'App.hpapp');
    assert.deepEqual(hp.calls.map(call => call.name), ['hp_prime_download_cached_file']);
    assert.equal(hp.storage.has('/downloads/hp-prime-2.bin'), false);
    const child = await hp.backends['hp-prime'].receiveEntry({ name: 'code.hpprgm',
        backendRef: { family: 'hp-prime', cacheIndex: 2, childIndex: 0 } });
    assert.equal(child.filename, 'code.hpprgm');
    assert.equal(hp.calls.at(-1).name, 'hp_prime_download_cached_app_child');

    const nw = createFixture('numworks');
    const batches = [];
    nw.state.numWorksBackend = {
        getScript: name => ({ name: `${name}.py`, code: 'print(1)' }),
        deleteScripts: async names => batches.push(names)
    };
    await nw.actions.receiveEntries([{ name: 'hello' }]);
    assert.equal(nw.downloads[0].filename, 'hello.py');
    await nw.actions.removeEntries([{ name: 'hello' }, { name: 'world' }]);
    assert.deepEqual(batches, [['hello', 'world']]);
    assert.equal(nw.calls.length, 0, 'NumWorks does not dispatch through TI WASM');

    const legacy = createFixture('hp-legacy');
    legacy.state.hpLegacyBackend = { receiveFile: async () => ({ name: '../object', data: Uint8Array.of(1) }) };
    const received = await legacy.backends['hp-legacy'].receiveEntry({ name: 'object' });
    assert.equal(received.filename, '.._object');
    await assert.rejects(legacy.backends['hp-legacy'].receiveEntry({ isFolder: true }), /directory_download/);

    const casio = createFixture('casio');
    await casio.actions.receiveEntries([{ name: 'file.txt', folder: 'MAIN' }]);
    assert.equal(casio.calls[0].name, 'casio_receive_file');
    assert.equal(casio.storage.has('/downloads/casio-0.bin'), false);

    const sharp = createFixture('sharp');
    const native = { name: 'A', selector: Uint8Array.of(1), category: { ext: 'p' } };
    sharp.state.sharpBackend = { receiveVariable: async entry => {
        assert.equal(entry, native); return { filename: 'A.g4p', data: Uint8Array.of(1) };
    } };
    await sharp.actions.receiveEntries([native]);
    assert.equal(sharp.downloads[0].filename, 'A.g4p');
}

(async () => {
    testPlansAndSelection(); testCapabilities();
    await testTiMarkerAndCleanup(); await testStaleResults(); await testFamilyOperations();
    console.log('File adapter, workflow, selection, and capability tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
