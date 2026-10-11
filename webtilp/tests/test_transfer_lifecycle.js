'use strict';

const assert = require('node:assert/strict');
const { createSession } = require('../session');
const { createFeaturesTransferPlan } = require('../features/transfer-plan');
const { createFeaturesTransfers } = require('../features/transfers');
const { createFileModel } = require('../features/file-model');
const { createUiSelection } = require('../ui/selection');
const { renderControlAvailability } = require('../features/capability-ui');
const fileTypes = require('../catalog/file-types');
const { FEATURE_FLAGS } = require('../catalog/devices');

function deferred() {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return { promise, resolve };
}

async function cancelledFileReadAndConversion() {
    for (const converting of [false, true]) {
        const pending = deferred();
        const started = deferred();
        const writes = [];
        let metadataCalls = 0;
        const state = { settings: { convertScriptFiles: true } };
        const session = createSession(state);
        const module = { FS: {
            analyzePath: () => ({ exists: true }),
            writeFile: path => writes.push(path), unlink() {}
        } };
        const dependencies = {
            ...fileTypes, state, session, Uint8Array, console,
            getActiveCalcModelId: () => 19,
            getPythonConversionKind: () => fileTypes.PYTHON_CONVERSION_CE,
            async convertPythonSourceForCalc() { started.resolve(); return pending.promise; },
            async ccallAsync() { metadataCalls += 1; return ''; }
        };
        const planner = createFeaturesTransferPlan(dependencies);
        const operation = planner.buildTransferPlan([{
            name: converting ? 'demo.py' : 'demo.8xp',
            arrayBuffer() {
                if (converting) return Promise.resolve(Uint8Array.of(1).buffer);
                started.resolve();
                return pending.promise;
            }
        }], module);
        await started.promise;
        session.invalidate('reset during preparation');
        pending.resolve(converting ? '/uploads/converted.8xv' : Uint8Array.of(1).buffer);
        await assert.rejects(operation, error => error.staleSession && error.silent);
        assert.equal(metadataCalls, 0, 'cancelled preparation never enters the native metadata call');
        assert.deepEqual(writes, converting ? ['/uploads/demo.py'] : [],
            'a late file read cannot write into an abandoned operation');
    }
}

async function cancelledTransferDialog() {
    const pending = deferred();
    const opened = deferred();
    let sends = 0;
    const cleanup = [];
    const state = { features: 0, selectedFiles: ['original'] };
    const session = createSession(state);
    const module = { FS: { unlink: path => cleanup.push(path) } };
    const dependencies = {
        state, session, FEATURE_FLAGS,
        authorizeDevice: async () => {}, initModule: async () => module,
        ensureCableOpen: async () => {}, updateCapabilities: async () => {},
        ensureDirlistLoadedWithPrompt: async () => {},
        ensureSilverlinkModelSelected: () => true,
        isCeBundleFile: () => false,
        buildTransferPlan: async () => [{ path: '/uploads/original.8xp' }],
        openTransferModal() { opened.resolve(); return pending.promise; },
        performTransfers() { sends += 1; return { successCount: 1 }; },
        logError() { assert.fail('cancellation must not be reported as a transfer failure'); }
    };
    const operation = createFeaturesTransfers(dependencies).processIncomingTransfers([{}]);
    await opened.promise;
    session.invalidate('reset while choosing destinations');
    pending.resolve({ selections: [{ path: '/uploads/original.8xp' }], overwriteAll: true });
    await assert.rejects(operation, error => error.staleSession);
    assert.equal(sends, 0);
    assert.deepEqual(state.selectedFiles, ['original']);
    assert.deepEqual(cleanup, ['/uploads/original.8xp']);
}

function visibleSelectionAndBusyControls() {
    const model = createFileModel();
    model.replace([{ name: 'VISIBLE', kind: 'var' }, { name: 'HIDDEN', kind: 'var' }], 'ti');
    const [visible, hidden] = [...model.entriesById.keys()];
    model.select(visible, true);
    model.select(hidden, true);
    const checkbox = { dataset: { entryId: visible }, checked: true, disabled: false };
    const dependencies = {
        state: { fileModel: model },
        els: { varTableBody: { querySelectorAll: () => [checkbox] } },
        createFileModel
    };
    Object.assign(dependencies, createUiSelection(dependencies));
    assert.deepEqual(dependencies.getSelectedFileEntries().map(entry => entry.name), ['VISIBLE'],
        'a batch action only includes checked rows in the visible table');

    const classes = new Set(['loading']);
    const button = { disabled: true, dataset: { prevDisabled: '1' }, classList: {
        contains: value => classes.has(value),
        toggle(value, enabled) { if (enabled) classes.add(value); else classes.delete(value); }
    } };
    renderControlAvailability({ button }, { button: { disabled: false } });
    assert.equal(button.disabled, true, 'capability refresh cannot enable an operation already running');
    assert.equal(button.dataset.prevDisabled, '0');
    classes.delete('loading');
    renderControlAvailability({ button }, { button: { disabled: false } });
    assert.equal(button.disabled, false);
}

(async () => {
    await cancelledFileReadAndConversion();
    await cancelledTransferDialog();
    visibleSelectionAndBusyControls();
    console.log('Transfer preparation, dialog cancellation, and selection lifecycle tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
