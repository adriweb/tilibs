'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const source = app.slice(app.indexOf('async function withProgressTimeout('), app.indexOf('\n/**', app.indexOf('async function withProgressTimeout(')));

async function run(nativeTimeout, timeout = 60000, {restoreOnCompletion = false, manualLinkWait = false, finishAt = 121000} = {}) {
    let now = 1000;
    let finish;
    const module = {__cableTimeoutMs: nativeTimeout, __manualLinkWaiting: manualLinkWait};
    const pending = new Promise(resolve => { finish = resolve; });
    const context = vm.createContext({
        Date: {now: () => now}, Math, Error, CCALL_TIMEOUT_MS: 12000,
        state: {lastProgressTs: now}, readProgressTick: () => null,
        refreshProgressDetails() {},
        async sleep(ms) {
            now += ms;
            if (now >= 91000) module.__manualLinkWaiting = false;
            if (now >= finishAt) {
                if (restoreOnCompletion) module.__cableTimeoutMs = 5000;
                finish(42);
            }
        }
    });
    vm.runInContext(source, context);
    return context.withProgressTimeout(pending, 'Sending app', timeout, 100, module);
}

(async () => {
    assert.equal(await run(360000), 42, 'a Flash GC may remain silent beyond the usual 60-second watchdog');
    assert.equal(await run(360000, 60000, {restoreOnCompletion: true}), 42,
        'restoring the timeout must not turn successful GC completion into a timeout');
    for (const deadline of [0, 5000]) {
        await assert.rejects(run(deadline), err => err.ccallTimeout === true,
            'restored/default deadlines still detect a stalled transfer');
    }
    assert.equal(await run(360000, null), 42, 'explicitly unbounded operations remain unbounded');
    assert.equal(await run(5000, 60000, {manualLinkWait: true}), 42,
        'a 90-second overwrite decision leaves a fresh deadline for the rest of the transfer');
    await assert.rejects(run(5000, 60000, {manualLinkWait: true, finishAt: 160000}), err => err.ccallTimeout === true,
        'a stalled transfer still times out after the overwrite decision');
    console.log('Flash GC and manual link watchdog deadlines passed.');
})().catch(err => { console.error(err); process.exitCode = 1; });
