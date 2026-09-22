'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const native = fs.readFileSync(require.resolve('../../libticalcs/trunk/src/calc_8x.cc'), 'utf8');

function extractFunction(name) {
    let start = app.indexOf(`async function ${name}(`);
    if (start < 0) start = app.indexOf(`function ${name}(`);
    assert.notEqual(start, -1);
    const bodyStart = app.indexOf(') {', start) + 2;
    let depth = 0;
    for (let i = bodyStart; i < app.length; i++) {
        if (app[i] === '{') depth++;
        if (app[i] === '}') depth--;
        if (!depth) return app.slice(start, i + 1);
    }
    throw new Error(`Unterminated function ${name}`);
}

function element() {
    const classes = new Set();
    return {
        disabled: false, dataset: {},
        classList: {
            add: name => classes.add(name),
            remove: name => classes.delete(name),
            contains: name => classes.has(name),
            toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }
        }
    };
}

const els = Object.fromEntries([
    'varsPanel', 'btnRefreshDirlist', 'btnIsReady', 'btnScreenshot',
    'btnReceiveBackup', 'btnNewFolder', 'btnSyncClock', 'btnDumpRom',
    'btnBackupDirlist', 'backupDirlistNote'
].map(name => [name, element()]));
let features = 0;
let modelId = 0;
let consent = true;
let receives = 0;
let parses = 0;
let receiveResult = 0;
let parseResult = 0;
let disconnectedDuringReceive = false;
const unlinked = [];
let confirms = 0;
let sends = 0;
let capabilityReads = 0;
let listings = 0;
let rendered = 0;
const state = {
    handle: 1, features: 0, dirlist: [], dirlistPromptPromise: null,
    operationEpoch: 0, backupDirlistLoaded: false,
    module: { FS: { readFile: path => path === '/last_recv_path.txt' ? '/dirlist-backup.bin' : '{"vars":[],"apps":[]}', unlink(path) {unlinked.push(path);} } }
};
const context = vm.createContext({
    state, els,
    document: { getElementById: () => null },
    isHPPrimeActive: () => false, isHPLegacyActive: () => false,
    isNumWorksActive: () => false, isCasioActive: () => false,
    isNspireActive: () => false,
    getActiveCalcModelId: () => modelId,
    formatErrorResult: (_m, result) => String(result),
    ensureCableOpen: async () => 1, ensureHandle: async () => 1,
    initModule: async () => state.module, authorizeDevice: async () => {},
    async ccallAsync(_module, name) {
        if (name === 'calc_features') { capabilityReads++; return features; }
        if (name === 'calc_recv_backup') { receives++; if (disconnectedDuringReceive) state.operationEpoch++; return receiveResult; }
        if (name === 'calc_backup_dirlist_json') { parses++; return parseResult; }
        assert.equal(name, 'calc_dirlist_json');
        listings++;
        return 0;
    },
    updateKeyControlsState() {}, clearKeyMapDataList() {},
    getActiveKeyMapConfig: () => null,
    updateNspireOsButtons() {}, updateSelectionActionButtons() {},
    setTiUiState() {}, setHPPrimeUiState() {}, setNumWorksUiState() {},
    setCasioUiState() {}, setHPLegacyUiState() {},
    renderDirlist() { rendered++; },
    log() {}, logError(error) { throw error; },
    t: value => value, confirm() { confirms++; return consent; },
    ensureSilverlinkModelSelected: () => true,
    isCeBundleFile: () => false,
    buildTransferPlan: async () => [{ path: '/file.82p', fileClass: 'var' }],
    async performTransfers() { sends++; return { successCount: 1 }; },
    setSelectedFiles() {}
});
vm.runInContext(app.slice(app.indexOf('const FEATURE_FLAGS ='), app.indexOf('const TIG_MODE ='))
    + '\nglobalThis.flags = FEATURE_FLAGS;', context);
for (const name of ['setButtonLoading', 'applyActiveFamilyUiState', 'updateCapabilities',
    'formatVariableDisplayName', 'refreshBackupDirlist', 'refreshDirlist', 'ensureDirlistLoadedWithPrompt', 'processIncomingTransfers']) {
    vm.runInContext(extractFunction(name), context);
}

async function main() {
    assert.equal(context.formatVariableDisplayName({kind: 'backup-var', name: 'xStat', type_name: 'List'}), 'xStat');
    for (const model of ['TI82', 'TI85', 'TI83', 'TI86']) {
        const match = native.match(new RegExp(`CALC_${model},[\\s\\S]*?\\n\\s*(OPS_[\\s\\S]*?),\\n\\s*PRODUCT_ID_`));
        assert.ok(match, `${model} native capabilities found`);
        const names = match[1].replace(/\/\*[\s\S]*?\*\//g, '').match(/\b(?:OPS|FTS)_\w+/g);
        features = names.reduce((mask, name) => mask | (context.flags[name] || 0), 0);
        modelId = {TI82: 2, TI85: 6, TI83: 3, TI86: 7}[model];
        const supported = model === 'TI83' || model === 'TI86';
        assert.equal(Boolean(features & context.flags.OPS_DIRLIST), supported, model);
        state.dirlist = [];
        state.backupDirlistLoaded = false;
        await context.updateCapabilities();
        assert.equal(els.varsPanel.classList.contains('hidden'), !supported, model);
        assert.equal(els.btnRefreshDirlist.disabled, false, model);
        assert.equal(els.btnReceiveBackup.disabled, false, 'native backup remains available');
        context.applyActiveFamilyUiState({ tiCapabilitiesKnown: true });
        assert.equal(els.varsPanel.classList.contains('hidden'), !supported, 'translation preserves visibility');

        const oldConfirms = confirms;
        const oldListings = listings;
        await context.ensureDirlistLoadedWithPrompt();
        assert.equal(confirms - oldConfirms, Number(supported), 'only supported models prompt');
        assert.equal(listings - oldListings, Number(supported), 'only supported models list');

        const beforeManual = listings;
        await context.refreshDirlist();
        assert.equal(listings - beforeManual, Number(supported), 'direct refresh also checks capabilities');
        assert.equal(els.btnRefreshDirlist.disabled, false, 'loading cleanup preserves disabled state');
        assert.equal(els.btnRefreshDirlist.classList.contains('loading'), false);

        const beforeSend = { sends, confirms, listings, capabilityReads };
        await context.processIncomingTransfers([{ name: 'file.82p' }], { useModal: false });
        assert.equal(sends - beforeSend.sends, 1, 'transfer still runs');
        assert.equal(confirms - beforeSend.confirms, Number(supported));
        assert.equal(listings - beforeSend.listings, supported ? 2 : 0, 'pre/post transfer listing respects capabilities');
        assert.equal(capabilityReads - beforeSend.capabilityReads, supported ? 3 : 1,
            'unsupported transfers do not enter the post-transfer refresh');


        assert.equal(els.btnBackupDirlist.classList.contains('hidden'), supported);
        if (!supported) {
            const startReceives = receives;
            consent = false;
            await context.refreshDirlist({ manual: true });
            assert.equal(receives, startReceives, 'declining sends no backup request');
            assert.equal(state.backupDirlistLoaded, false);
            consent = true;
            await context.refreshDirlist({ manual: true });
            assert.equal(receives, startReceives + 1);
            assert.equal(state.backupDirlistLoaded, true, 'empty backup listing still counts as loaded');
            assert.equal(els.varsPanel.classList.contains('hidden'), false);
            assert.equal(els.backupDirlistNote.classList.contains('hidden'), false);
            assert.equal(els.btnBackupDirlist.classList.contains('loading'), false);
            assert.ok(unlinked.includes('/dirlist-backup.bin') && unlinked.includes('/dirlist-backup.json'));
            context.applyActiveFamilyUiState({ tiCapabilitiesKnown: true });
            await context.updateCapabilities();
            assert.equal(els.varsPanel.classList.contains('hidden'), false, 'snapshot survives capability/translation refresh');
            await context.processIncomingTransfers([{ name: 'file.82p' }], { useModal: false });
            assert.equal(receives, startReceives + 1, 'sending never fetches another backup');
            assert.equal(state.backupDirlistLoaded, false, 'sending invalidates the old snapshot');
            assert.equal(els.varsPanel.classList.contains('hidden'), true);

            for (const failure of ['receive', 'parse', 'disconnect']) {
                receiveResult = failure === 'receive' ? 42 : 0;
                parseResult = failure === 'parse' ? -4 : 0;
                disconnectedDuringReceive = failure === 'disconnect';
                const oldParses = parses;
                await context.refreshDirlist({ manual: true });
                assert.equal(state.backupDirlistLoaded, false, `${failure} cannot publish a listing`);
                if (failure !== 'parse') assert.equal(parses, oldParses, 'failed or stale receive is not parsed');
                assert.equal(state.backupDirlistInProgress, false);
            }
            receiveResult = parseResult = 0;
            disconnectedDuringReceive = false;
        }

        context.applyActiveFamilyUiState();
        assert.equal(els.varsPanel.classList.contains('hidden'), false, 'next family starts with a visible panel');
    }
    modelId = 2;
    features = 0;
    const unsupportedReceives = receives;
    await context.refreshDirlist({manual: true});
    assert.equal(receives, unsupportedReceives, 'no backup capability means no fallback');
    modelId = 9; features = context.flags.OPS_BACKUP;
    await context.refreshDirlist({manual: true});
    assert.equal(receives, unsupportedReceives, 'unimplemented model format means no fallback');
    assert.ok(rendered > 0, 'supported directory responses still render');
    console.log('TI directory-list capability tests passed (TI-82/85 and TI-83/86 controls)');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
