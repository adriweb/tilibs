'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const source = app.slice(app.indexOf('async function performTransfers('), app.indexOf('\nasync function sendNumWorksFiles('));
const snapshotSource = app.slice(app.indexOf('function setBackupDirlist('), app.indexOf('async function refreshBackupDirlist('));

function item(name, extra = {}) {
    return { path: `/${name}.82p`, file: {name, size: 12}, fileClass: 'single', entryName: name,
        entryType: 5, defaultLocation: 'ram', locationMask: 1, ...extra };
}
async function run(model, plan, {finishResult = 0, sendResult = 0, rawResult = 0, rejectSend = false,
    decline = false, previousSnapshot = false, cancelRestore = false, parseResult = 0} = {}) {
    const calls = [];
    let confirmations = 0;
    const state = {settings: {}, operationEpoch: 0, backupDirlistGeneration: 0, backupDirlistLoaded: previousSnapshot,
        dirlist: previousSnapshot ? [{kind: 'backup-var', name: 'OLD'}] : decline ? [{name: 'SKIP'}] : []};
    const module = {_get_raw_protocol_code: () => rawResult,
        FS: {readFile: () => '{"vars":[{"kind":"backup-var","name":"RESTORED"}]}', unlink() {}}};
    const context = vm.createContext({
        state, els: {}, console, Number, Error, TICALCS_EVO_ERROR: 510,
        ensureCableOpen: async () => 1, getActiveCalcModelId: () => model,
        isVarFileClass: type => ['single', 'group', 'regular', 'tigroup'].includes(type),
        confirmEvoOsModelMismatch: () => true,
        findDirlistMatch: name => name === 'SKIP' ? {attr: 0} : null,
        confirm() { confirmations++; return !decline; }, tFormat: name => name,
        hasSilverlinkConnected: () => true, isTI89TActive: () => false,
        clearNativeWarnings() {}, log() {}, getNativeWarningSuffix: () => '',
        formatErrorResult: (_module, result) => String(result),
        renderDirlist() {},
        runGuidedLinkTransfer: async (_direction, _name, operation) => cancelRestore ? null : operation(),
        async ccallAsync(_module, name, _ret, types, args, options) {
            calls.push({name, types: [...types], args: [...args]});
            if (name === 'calc_backup_dirlist_json') return parseResult;
            if (name === 'finish_var_send') return finishResult;
            assert.ok(['send_file_custom', 'send_file_entry_custom'].includes(name));
            assert.equal(types.length, args.length);
            if (args[1].includes('BACKUP')) assert.equal(options.timeoutMs, [2, 6, 7].includes(model) ? null : 60000);
            if (rejectSend) throw new Error('disconnected');
            return sendResult;
        }
    });
    vm.runInContext(snapshotSource + source, context);
    let result, error;
    try { result = await context.performTransfers(plan, module, {}); } catch (err) { error = err; }
    return {calls, result, error, state, confirmations};
}
async function main() {
    for (const model of [2, 3, 6, 7, 13, 50]) {
        for (const failure of [
            {sendResult: 256}, {sendResult: 355, rawResult: 0xCCCC},
            {sendResult: 356, rawResult: 0xCCCD}, {sendResult: 510, rawResult: 0x434E},
            {sendResult: 510, rawResult: 0x5155}
        ]) {
            const cancelled = await run(model, [item('ONE'), item('TWO')], failure);
            assert.equal(cancelled.error?.silent, true);
            assert.equal(cancelled.calls.length, 1, 'calculator cancellation stops the batch without another item or EOT');
        }
    }
    for (const model of [2, 6]) {
        for (const plan of [
            [item('ONE')],
            [item('ONE'), item('TWO')],
            [item('ONE', {sendByEntry: true, entryIndex: 0}), item('TWO', {sendByEntry: true, entryIndex: 1})],
            [item('ONE', {sendByEntry: true, entryIndex: 0, containerKind: 1})]
        ]) {
            const {calls, result, error} = await run(model, plan);
            assert.ifError(error);
            assert.equal(result.successCount, plan.length);
            assert.equal(calls.length, plan.length + 1);
            assert.equal(calls.at(-1).name, 'finish_var_send');
            assert.ok(calls.slice(0, -1).every(call => call.args.at(-1) === 1));
        }
        const skipped = await run(model, [item('ONE'), item('SKIP', {path: ''})]);
        assert.ifError(skipped.error);
        assert.equal(skipped.result.successCount, 1);
        assert.deepEqual(skipped.calls.map(call => call.name), ['send_file_custom', 'finish_var_send']);
        const duplicate = await run(model, [item('SKIP')], {decline: true});
        assert.ifError(duplicate.error);
        assert.equal(duplicate.confirmations, 0, 'the calculator handles non-silent overwrite decisions');
        assert.equal(duplicate.result.successCount, 1);
        for (const plan of [[], [item('NONE', {path: ''})]]) {
            const empty = await run(model, plan, {decline: true});
            assert.ifError(empty.error);
            assert.equal(empty.calls.length, 0);
        }
        const failedAck = await run(model, [item('ONE')], {finishResult: 4});
        assert.match(failedAck.error.message, /Failed to finish transfer: 4/);
        assert.equal(failedAck.result, undefined);
        for (const failure of [{sendResult: 4}, {rejectSend: true}]) {
            const failed = await run(model, [item('ONE'), item('TWO')], failure);
            assert.ok(failed.error);
            assert.equal(failed.calls.length, 1, 'stop on protocol errors without EOT or another VAR');
        }
        const backup = item('BACKUP', {path: model === 2 ? '/BACKUP.82b' : '/BACKUP.85b', fileClass: 'backup'});
        const mixed = await run(model, [item('ONE'), backup], {previousSnapshot: true});
        assert.ifError(mixed.error);
        assert.deepEqual(mixed.calls.map(call => call.name),
            ['send_file_custom', 'finish_var_send', 'send_file_custom', 'calc_backup_dirlist_json']);
        assert.equal(mixed.calls[2].args.at(-1), 0);
        assert.equal(mixed.calls[3].args[0], backup.path);
        assert.equal(mixed.state.dirlist[0].name, 'RESTORED');
        assert.equal(mixed.state.backupDirlistLoaded, true);
        const afterRestore = await run(model, [backup, item('ONE')]);
        assert.ifError(afterRestore.error);
        assert.equal(afterRestore.state.backupDirlistLoaded, false, 'a later variable send invalidates the snapshot');
        assert.equal(afterRestore.state.dirlist.length, 0);
        for (const failure of [{sendResult: 4}, {rejectSend: true}, {sendResult: 256}, {parseResult: -4}]) {
            const failed = await run(model, [backup], {...failure, previousSnapshot: true});
            assert.equal(failed.calls.length, failure.parseResult ? 2 : 1, 'parse only after successful send');
            assert.equal(failed.state.backupDirlistLoaded, false);
            assert.equal(failed.state.dirlist.length, 0);
            if (failure.parseResult) assert.equal(failed.result.successCount, 1, 'a parser failure preserves transfer success');
            else assert.ok(failed.error);
        }
        const cancelledRestore = await run(model, [backup], {previousSnapshot: true, cancelRestore: true});
        assert.equal(cancelledRestore.calls.length, 0);
        assert.equal(cancelledRestore.state.dirlist[0].name, 'OLD');
    }
    for (const model of [3, 7, 13]) {
        const duplicate = await run(model, [item('SKIP')], {decline: true});
        assert.ifError(duplicate.error);
        assert.equal(duplicate.confirmations, 1, 'silent transfers still ask before replacing a variable');
        assert.equal(duplicate.calls.length, 0);
        const backup = await run(model, [item('BACKUP', {fileClass: 'backup'})]);
        assert.ifError(backup.error);
        assert.equal(backup.result.successCount, 1);
        const normal = await run(model, [item('ONE'), item('TWO', {sendByEntry: true, entryIndex: 1})]);
        assert.ifError(normal.error);
        assert.equal(normal.calls.length, 2);
        assert.ok(normal.calls.every(call => call.args.at(-1) === 0));
        const failure = await run(model, [item('ONE'), item('TWO')], {sendResult: 4});
        assert.ifError(failure.error);
        assert.equal(failure.result.successCount, 0);
        assert.equal(failure.calls.length, 2, 'other models retain per-item failure handling');
    }
    console.log('Variable-send sequencing passed (TI-82/85 EOT, skips, errors, groups, other models).');
}
main().catch(error => {console.error(error); process.exitCode = 1;});
