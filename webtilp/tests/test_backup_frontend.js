'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
function extract(name) {
    const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
    assert.ok(start >= 0);
    const body = source.indexOf(') {', start) + 2;
    let depth = 0;
    for (let i = body; i < source.length; i++) {
        if (source[i] === '{') depth++;
        if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
    }
    throw Error(name);
}
const messages = JSON.parse(source.split('const I18N_EN = ')[1].split(';\n')[0]);
function button() {
    const handlers = {};
    return { dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
        addEventListener(event, fn) { handlers[event] = fn; },
        removeEventListener(event) { delete handlers[event]; },
        click() { handlers.click(); } };
}
async function check(model, format = 'backup', cancel = false) {
    const note = {};
    const els = Object.fromEntries(['backupModal', 'backupFormatBackup', 'backupFormatTigroup',
        'tigroupOptions', 'backupIncludeRam', 'backupIncludeArchive', 'backupIncludeFlash',
        'btnConfirmBackup', 'btnCancelBackup', 'btnCloseBackup', 'btnReceiveBackup'].map(k => [k, button()]));
    const events = [];
    const module = { FS: { analyzePath: () => ({ exists: true }), mkdir() {} }, ccall: () => '86b' };
    const context = vm.createContext({
        state: { features: format === 'tigroup' ? 1 : 0 }, els, document: { getElementById: () => note },
        getActiveCalcModelId: () => model, t: key => messages[key],
        setTextContent: (el, text) => { el.textContent = text; }, setBackupModalLoading() {},
        TIG_MODE: { RAM: 1, ARCHIVE: 2, FLASH: 4, NONE: 0 }, FEATURE_FLAGS: { FTS_FLASH: 1 },
        PROGRESS_IDLE_TIMEOUT_MS: 5000, setButtonLoading() {},
        isHPLegacyActive: () => false, isCasioActive: () => false,
        isHPPrimeActive: () => false, isNumWorksActive: () => false,
        authorizeDevice: async () => {}, initModule: async () => module, ensureHandle: async () => 42,
        updateCapabilities: async () => {}, estimateBackupSize: () => 0,
        log: text => events.push({ log: text }), logError(error) { throw error; },
        ccallAsync: async (_m, name, _r, _types, args, options) => { events.push({ name, args, options }); return 0; },
        downloadLastReceived: async () => events.push({ download: true })
    });
    vm.runInContext(['getNativeBackupSteps', 'getNativeBackupWaitingLabel', 'runGuidedBackup', 'openBackupModal', 'receiveBackup'].map(extract).join('\n'), context);
    const receive = context.receiveBackup();
    // Reach the real modal after authorization/capability setup.
    await new Promise(resolve => setImmediate(resolve));
    const manual = [2, 6, 7].includes(model);
    if (format === 'tigroup' || ![2, 3, 6, 7].includes(model)) assert.equal(note.textContent, messages.backup_note);
    else assert.ok(note.textContent.includes(messages[model === 3 ? 'backup_receive_auto' : model === 2 ? 'backup_receive_82' : 'backup_receive_8586']));
    if (cancel) els.btnCancelBackup.click(); else els.btnConfirmBackup.click();
    await receive;
    const calls = events.filter(e => e.name);
    if (cancel) { assert.equal(calls.length, 0); return; }
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, format === 'tigroup' ? 'calc_recv_tigroup' : 'calc_recv_backup');
    assert.equal(calls[0].options.timeoutMs, manual && format === 'backup' ? null : 5000);
    if (manual && format === 'backup') {
        assert.equal(events[0].log, messages[model === 2 ? 'backup_wait_82' : 'backup_wait_8586'], 'instructions appear before the receive starts');
        assert.equal(calls[0].options.progressLabel, messages[model === 2 ? 'backup_wait_82' : 'backup_wait_8586']);
    }
    assert.ok(events.some(e => e.download));
}
(async () => {
    for (const model of [2, 6, 7, 3, 4, 9]) await check(model);
    await check(7, 'backup', true);
    await check(4, 'tigroup');
    await checkGuides();
    console.log('Manual backup instructions, receive ordering, cancellation and automatic controls passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

async function checkGuides() {
    for (const model of [2, 3, 6, 7]) {
        for (const direction of ['receive', 'restore']) {
            for (const cancelAt of [null, ...(direction === 'restore' ? ['before'] : []), 'during']) {
                const ids = ['backupGuideModal', 'backupGuideTitle', 'backupGuideFile', 'backupGuideWarning',
                    'backupGuideSteps', 'backupGuideVersion', 'backupGuideStatus', 'btnStartBackupRestore',
                    'btnCancelBackupGuide', 'btnCloseBackupGuide'];
                const els = Object.fromEntries(ids.map(id => [id, {
                    ...button(), textContent: '', focus() {}, setAttribute() {},
                    replaceChildren(...children) { this.children = children; }
                }]));
                let transfers = 0, resets = 0, finish;
                const context = vm.createContext({ els, state: {operationEpoch: 0},
                    getActiveCalcModelId: () => model, t: key => messages[key],
                    tFormat: (key, values) => messages[key].replace('{file}', values.file),
                    setTextContent: (el, text) => { el.textContent = text; },
                    document: {createElement: () => ({}), activeElement: null},
                    nukeConnection: async reconnect => { assert.equal(reconnect, false); resets++; finish(0); },
                    logError(error) { throw error; }
                });
                vm.runInContext(['getNativeBackupSteps', 'runGuidedBackup'].map(extract).join('\n'), context);
                const pending = context.runGuidedBackup(direction, direction === 'restore' ? '<test>.82b' : '',
                    () => { transfers++; return new Promise(resolve => { finish = resolve; }); });
                const lines = els.backupGuideSteps.children.map(child => child.textContent);
                assert.ok(lines.includes(messages[direction === 'receive'
                    ? model === 3 ? 'backup_receive_auto' : model === 2 ? 'backup_receive_82' : 'backup_receive_8586'
                    : model === 3 ? 'backup_restore_auto' : model === 2 ? 'backup_restore_82_prepare' : 'backup_restore_8586_prepare']));
                if (direction === 'restore') {
                    assert.equal(transfers, 0, 'no backup is sent before the preparation dialog is confirmed');
                    assert.equal(els.backupGuideFile.textContent, 'Backup file: <test>.82b');
                    if (cancelAt === 'before') {
                        els.btnCancelBackupGuide.click();
                        assert.equal(await pending, null);
                        assert.equal(transfers, 0); assert.equal(resets, 0);
                        continue;
                    }
                    els.btnStartBackupRestore.click();
                    await new Promise(resolve => setImmediate(resolve));
                }
                assert.equal(transfers, 1);
                assert.ok(els.backupGuideStatus.textContent.length, 'instructions remain visible during I/O');
                if (cancelAt === 'during') {
                    els.btnCloseBackupGuide.click();
                    await assert.rejects(pending, error => error.silent === true);
                    assert.equal(resets, 1);
                } else { finish(0); assert.equal(await pending, 0); }
            }
        }
    }
}
