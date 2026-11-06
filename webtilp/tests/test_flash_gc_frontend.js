'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const source = app.slice(app.indexOf('async function withProgressTimeout('), app.indexOf('\n/**', app.indexOf('async function withProgressTimeout(')));

async function run(nativeTimeout, timeout = 60000, restoreOnCompletion = false) {
    let now = 1000;
    let finish;
    const module = {__cableTimeoutMs: nativeTimeout};
    const pending = new Promise(resolve => { finish = resolve; });
    const context = vm.createContext({
        Date: {now: () => now}, Math, Error, CCALL_TIMEOUT_MS: 12000,
        state: {lastProgressTs: now}, readProgressTick: () => null,
        refreshProgressDetails() {},
        async sleep(ms) {
            now += ms;
            if (now >= 121000) {
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
    assert.equal(await run(360000, 60000, true), 42, 'restoring the timeout must not turn successful GC completion into a timeout');
    for (const deadline of [0, 5000]) {
        await assert.rejects(run(deadline), err => err.ccallTimeout === true,
            'restored/default deadlines still detect a stalled transfer');
    }
    assert.equal(await run(360000, null), 42, 'explicitly unbounded operations remain unbounded');
    console.log('Flash GC watchdog deadlines passed.');
})().catch(err => { console.error(err); process.exitCode = 1; });
