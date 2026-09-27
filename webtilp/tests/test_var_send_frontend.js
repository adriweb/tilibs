'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const source = app.slice(app.indexOf('async function performTransfers('), app.indexOf('\nasync function sendNumWorksFiles('));

function item(name, extra = {}) {
    return { path: `/${name}.82p`, file: {name, size: 12}, fileClass: 'single', entryName: name,
        entryType: 5, defaultLocation: 'ram', locationMask: 1, ...extra };
}
async function run(model, plan, {finishResult = 0, sendResult = 0, rejectSend = false, decline = false} = {}) {
    const calls = [];
    const state = {settings: {}, dirlist: decline ? [{name: 'SKIP'}] : []};
    const context = vm.createContext({
        state, console, Number, Error,
        ensureCableOpen: async () => 1, getActiveCalcModelId: () => model,
        isVarFileClass: type => ['single', 'group', 'regular', 'tigroup'].includes(type),
        confirmEvoOsModelMismatch: () => true,
        findDirlistMatch: name => name === 'SKIP' ? {attr: 0} : null,
        confirm: () => !decline, tFormat: name => name,
        hasSilverlinkConnected: () => true, isTI89TActive: () => false,
        clearNativeWarnings() {}, log() {}, getNativeWarningSuffix: () => '',
        formatErrorResult: (_module, result) => String(result),
        async ccallAsync(_module, name, _ret, types, args) {
            calls.push({name, types: [...types], args: [...args]});
            if (name === 'finish_var_send') return finishResult;
            assert.ok(['send_file_custom', 'send_file_entry_custom'].includes(name));
            assert.equal(types.length, args.length);
            if (rejectSend) throw new Error('disconnected');
            return sendResult;
        }
    });
    vm.runInContext(source, context);
    let result, error;
    try { result = await context.performTransfers(plan, {}, {}); } catch (err) { error = err; }
    return {calls, result, error};
}
async function main() {
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
        const skipped = await run(model, [item('ONE'), item('SKIP')], {decline: true});
        assert.ifError(skipped.error);
        assert.equal(skipped.result.successCount, 1);
        assert.deepEqual(skipped.calls.map(call => call.name), ['send_file_custom', 'finish_var_send']);
        for (const plan of [[], [item('SKIP')], [{...item('NONE'), path: ''}]]) {
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
        const mixed = await run(model, [item('ONE'), item('BACKUP', {fileClass: 'backup'})]);
        assert.ifError(mixed.error);
        assert.deepEqual(mixed.calls.map(call => call.name), ['send_file_custom', 'finish_var_send', 'send_file_custom']);
        assert.equal(mixed.calls.at(-1).args.at(-1), 0);
    }
    for (const model of [3, 7, 13]) {
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
