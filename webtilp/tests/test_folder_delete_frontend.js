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
const folder = {name: 'α', name_hex: '80', folder: '', folder_hex: '', type: 31,
    kind: 'folder', isFolder: true, folderPath: 'α'};
const variable = (name, type = 0, extra = {}) => ({name, type, folder: 'α', folder_hex: '80',
    name_hex: Buffer.from(name).toString('hex'), kind: 'var', is_folder: 0, ...extra});
const listedFolder = {...folder, kind: 'var', is_folder: 1, isFolder: undefined};
async function run(selections, vars, options = {}) {
    const calls = [], logs = [], errors = [], confirmations = [];
    let current = structuredClone(vars), refreshes = 0, listingCount = 0;
    const module = {FS: {readFile: () => JSON.stringify({vars: current, apps: [variable('GLOBAL', 36, {kind: 'app'})]})}};
    const checkbox = entry => ({dataset: {name: entry.name, folder: entry.folder,
        nameHex: entry.name_hex || '', folderHex: entry.folder_hex || '', type: String(entry.type),
        kind: entry.kind, isFolder: entry.isFolder ? '1' : '0', folderPath: entry.folderPath || '',
        hpIndex: '', hpAppChildIndex: ''}});
    const context = vm.createContext({
        state: {dirlist: []}, console, Number, Error, Set, JSON,
        els: {btnDeleteSelected: {}}, PROGRESS_IDLE_TIMEOUT_MS: 5000,
        getActiveCalcModelId: () => options.model ?? 9,
        isHPPrimeActive: () => false, isNumWorksActive: () => false,
        isCasioActive: () => false,
        getSelectedVarInputs: () => selections.map(checkbox),
        authorizeDevice: async () => {}, initModule: async () => module, ensureHandle: async () => 42,
        setButtonLoading() {}, refreshDirlist: async () => {refreshes++;},
        confirm: text => {confirmations.push(text); return !options.decline;},
        t: key => key, tFormat: key => key,
        log: text => logs.push(text), logError: error => errors.push(error),
        formatErrorResult: (_m, result) => String(result),
        async ccallAsync(_m, name, _ret, types, args) {
            assert.equal(types.length, args.length);
            calls.push({name, args: [...args]});
            if (name === 'calc_dirlist_json') {
                listingCount++;
                if (options.listFailure === listingCount) return 4;
                return 0;
            }
            const deletes = calls.filter(call => call.name !== 'calc_dirlist_json').length;
            if (deletes === options.throwAt) throw new Error('disconnected');
            if (deletes === options.failAt) return 4;
            if (!options.keepEntries) current = current.filter(entry => name === 'calc_del_folder'
                ? !(entry.is_folder === 1 && entry.name_hex === args[2])
                : !(entry.is_folder !== 1 && entry.name_hex === args[5] && entry.folder_hex === args[4]));
            return 0;
        }
    });
    vm.runInContext(['normalizeFolderPath', 'getEntryFolderPath', 'getTiFolderRequestHex',
        'isSameDeleteFolder', 'readTiDeletionDirlist', 'deleteEntriesWithSession',
        'buildEntryFromCheckbox', 'deleteEntry', 'deleteSelected'].map(extract).join('\n'), context);
    if (options.single) await context.deleteEntry(selections[0]);
    else await context.deleteSelected();
    return {calls, deletes: calls.filter(call => call.name !== 'calc_dirlist_json'), logs, errors, refreshes, confirmations};
}
async function main() {
    const a = variable('A', 4), b = variable('B', 18);
    const globalApp = variable('TIFRA', 36, {kind: 'app'});
    const unrelated = variable('OTHER', 0, {folder: 'αmore', folder_hex: '806d6f7265'});
    const collision = variable('COLLISION', 0, {folder_hex: '81'});
    for (const model of [8, 9, 10, 11, 12, 14]) {
        for (const single of [false, true]) {
            const r = await run([folder], [listedFolder, a, b, globalApp, unrelated, collision], {model, single});
            assert.deepEqual(r.errors, []);
            assert.deepEqual(r.deletes.map(call => [call.name, call.args[1]]),
                [['calc_del_var', 'α'], ['calc_del_var', 'α'], ['calc_del_folder', 'α']]);
            assert.deepEqual(r.deletes[0].args, [42, 'α', 'A', 4, '80', '41']);
            assert.deepEqual(r.deletes[1].args, [42, 'α', 'B', 18, '80', '42']);
            assert.deepEqual(r.deletes[2].args, [42, 'α', '80']);
            assert.equal(r.refreshes, 1);
            assert.match(r.confirmations[0], /contents/);
        }
    }
    for (const selections of [[folder, a, b], [a, folder, b], [a, b, folder]]) {
        const r = await run(selections, [listedFolder, a, b, globalApp]);
        assert.deepEqual(r.deletes.map(call => call.name), ['calc_del_var', 'calc_del_var', 'calc_del_folder']);
    }
    const second = {...folder, name: 'other', name_hex: '6f74686572', folderPath: 'other'};
    const bulk = await run([folder, second], [a, variable('C', 0, {folder: 'other', folder_hex: '6f74686572'})]);
    assert.deepEqual(bulk.deletes.map(call => call.name), ['calc_del_var', 'calc_del_folder', 'calc_del_var', 'calc_del_folder']);
    const empty = await run([folder], [listedFolder, globalApp]);
    assert.deepEqual(empty.deletes.map(call => call.name), ['calc_del_folder']);
    for (const options of [{failAt: 1}, {failAt: 2}, {throwAt: 1}, {throwAt: 2}]) {
        const r = await run([folder, second], [a, b], options);
        assert.equal(r.deletes.length, options.failAt || options.throwAt);
        assert.ok(r.deletes.every(call => call.name === 'calc_del_var'));
        assert.equal(r.refreshes, 1, 'refresh after partial failure');
    }
    const failedListing = await run([folder], [a], {listFailure: 1});
    assert.equal(failedListing.deletes.length, 0);
    assert.match(failedListing.errors[0].message, /Cannot read folder contents/);
    for (const model of [8, 9, 10, 11, 12]) {
        const failedKeys = await run([folder], [listedFolder, a, b], {model, keepEntries: true});
        assert.equal(failedKeys.deletes.length, 1, 'acknowledged but ineffective keys stop the batch');
        assert.ok(failedKeys.logs.some(line => line.includes('still present')));
        assert.ok(!failedKeys.logs.some(line => line.startsWith('Deleted')));
        const failedVerification = await run([folder], [a, b], {model, listFailure: 2});
        assert.equal(failedVerification.deletes.length, 1);
        assert.equal(failedVerification.errors.length, 1);
        const folderRemains = await run([folder], [listedFolder], {model, keepEntries: true});
        assert.ok(folderRemains.logs.some(line => line.includes('still present')));
    }
    const nspire = await run([folder], [a, b], {model: 15});
    assert.deepEqual(nspire.calls.map(call => call.name), ['calc_del_folder'], 'other protocols retain native folder deletion');
    const declined = await run([folder], [a], {decline: true});
    assert.equal(declined.calls.length, 0);
    assert.equal(declined.refreshes, 0);
    console.log('Folder deletion passed: contents first, raw identifiers/types, global apps, overlapping selections, failures and key-result verification.');
}
main().catch(error => {console.error(error); process.exitCode = 1;});
