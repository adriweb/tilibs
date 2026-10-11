'use strict';

const assert = require('node:assert/strict');
const { createWasmClient } = require('../runtime/wasm-client.js');
const { createSession } = require('../session.js');

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

async function flush() {
    // Drain scheduler/timeout/finally microtasks without relying on wall time.
    for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

function clock() {
    let time = 0;
    let nextId = 0;
    const timers = new Map();
    return {
        now: () => time,
        setTimer(callback, delay) {
            const id = ++nextId;
            timers.set(id, { at: time + delay, callback });
            return id;
        },
        clearTimer(id) { timers.delete(id); },
        async advance(ms) {
            const end = time + ms;
            for (;;) {
                const next = [...timers.entries()].filter(([, timer]) => timer.at <= end)
                    .sort((a, b) => a[1].at - b[1].at)[0];
                if (!next) break;
                time = next[1].at;
                timers.delete(next[0]);
                next[1].callback();
                await flush();
            }
            time = end;
            await flush();
        },
        size: () => timers.size
    };
}

function runtime(extra = {}) {
    const timer = clock();
    return { timer, client: createWasmClient({ ...timer, minGapMs: 0, timeoutMs: 10,
        suspendedGraceMs: 20, warn() {}, ...extra }) };
}

async function fifoAndOperationOwnership() {
    const { client } = runtime();
    const native = deferred(), consuming = deferred();
    const events = [];
    const module = { ccall(name) { events.push(name); return name === 'receive' ? native.promise : name; } };
    const first = client.runOperation(module, async (call, operation) => {
        await call('receive', 'number', [], [], { timeoutMs: null });
        operation.assertCurrent();
        events.push('read marker');
        await consuming.promise;
        events.push('read file');
        return 'bytes';
    });
    const second = client.ccallAsync(module, 'next', 'number', [], [], { timeoutMs: null });
    await flush();
    assert.deepEqual(events, ['receive']);
    native.resolve(0);
    await flush();
    assert.deepEqual(events, ['receive', 'read marker']);
    consuming.resolve();
    assert.equal(await first, 'bytes');
    assert.equal(await second, 'next');
    assert.deepEqual(events, ['receive', 'read marker', 'read file', 'next']);
}

async function timedOutSlotAndLateCompletion() {
    for (const rejects of [false, true]) {
        const { client, timer } = runtime();
        const native = deferred();
        const events = [];
        const module = { ccall(name) { events.push(name); return name === 'first' ? native.promise : 7; } };
        const first = client.ccallAsync(module, 'first', 'number', [], [], {
            prepareCall() { events.push('prepare'); return () => events.push('cleanup'); }
        });
        const timedOut = assert.rejects(first, error => error.ccallTimeout === true);
        await flush();
        await timer.advance(10);
        await timedOut;
        const second = client.ccallAsync(module, 'second', 'number', [], [], { timeoutMs: null });
        await flush();
        assert.deepEqual(events, ['prepare', 'first']);
        if (rejects) native.reject(new Error('late failure'));
        else native.resolve(0);
        assert.equal(await second, 7);
        assert.deepEqual(events, ['prepare', 'first', 'cleanup', 'second']);
        assert.equal(timer.size(), 0);
    }
}

async function retirementAndGracePeriod() {
    for (const viaGrace of [false, true]) {
        const native = deferred();
        const fatal = [];
        const { client, timer } = runtime({ onFatal: (module, error) => fatal.push(error.message) });
        let calls = 0;
        const module = { ccall() { calls += 1; return native.promise; } };
        const first = client.ccallAsync(module, 'stuck', 'number', [], [], { timeoutMs: viaGrace ? 10 : null });
        const firstFails = assert.rejects(first, viaGrace ? /timed out/ : /needs reinitialization/);
        const queued = client.ccallAsync(module, 'queued', 'number', [], [], { timeoutMs: null });
        const queuedFails = assert.rejects(queued, /needs reinitialization/);
        await flush();
        if (viaGrace) await timer.advance(30);
        else client.retireModule(module, 'reset');
        await Promise.all([firstFails, queuedFails]);
        assert.equal(calls, 1);
        assert.equal(fatal.length, viaGrace ? 1 : 0);
        await assert.rejects(client.ccallAsync(module, 'future', 'number', [], []), /needs reinitialization/);
        native.resolve(0);
        await client.getModuleCallState(module).tail;
        assert.equal(timer.size(), 0);
    }
}

async function cancellationBeforeNativeEntry() {
    let generation = 0;
    const { client } = runtime({ getGeneration: () => generation });
    const native = deferred();
    const calls = [];
    const module = { ccall(name) { calls.push(name); return native.promise; } };
    const active = client.ccallAsync(module, 'active', 'number', [], [], { timeoutMs: null });
    const activeFails = assert.rejects(active, error => error.silent === true);
    const queued = client.ccallAsync(module, 'queued', 'number', [], [], {
        prepareCall() { assert.fail('cancelled queued call must not prepare a transport scope'); }
    });
    const queuedFails = assert.rejects(queued, error => error.silent === true);
    await flush();
    generation += 1;
    native.resolve(0);
    await Promise.all([activeFails, queuedFails]);
    assert.deepEqual(calls, ['active']);
}

async function progressPollingDuringSuspension() {
    const native = deferred();
    let tick = 0;
    let refreshes = 0;
    const { client, timer } = runtime({ progress: { refresh() { refreshes += 1; } } });
    const module = {
        ccall() { return native.promise; },
        _get_progress_tick_value() { return tick; }
    };
    const active = client.ccallAsync(module, 'transfer', 'number', [], [], { useProgress: true, timeoutMs: 150 });
    await flush();
    await timer.advance(100);
    tick += 1;
    await timer.advance(100);
    assert.equal(refreshes, 1);
    await timer.advance(100);
    native.resolve(4);
    assert.equal(await active, 4);
    assert.equal(timer.size(), 0);
    client.retireModule(module, 'done');
    assert.equal(client.readProgressTick(module), null);
}

async function cachedInitializationAndHandles() {
    const state = { module: null, handle: 0 };
    const { client } = runtime({ getGeneration: () => state.operationEpoch });
    const session = createSession(state, client);
    const factory = deferred(), configure = deferred(), handle = deferred();
    const candidate = {};
    let factories = 0, configurations = 0, handles = 0;
    const init = () => session.initialize(() => { factories += 1; return factory.promise; }, async module => {
        configurations += 1;
        assert.equal(module, candidate);
        await configure.promise;
    });
    const first = init(), second = init();
    assert.equal(first, second);
    factory.resolve(candidate);
    await flush();
    assert.equal(state.module, null, 'uninitialized module is never published');
    assert.equal(init(), first, 'all callers await native initialization');
    configure.resolve();
    assert.equal(await first, candidate);
    assert.equal(state.module, candidate);
    assert.equal(factories, 1);
    assert.equal(configurations, 1);
    const createHandle = () => session.ensureHandle(() => { handles += 1; return handle.promise; });
    const a = createHandle(), b = createHandle();
    assert.equal(a, b);
    handle.resolve(123);
    assert.equal(await a, 123);
    assert.equal(state.handle, 123);
    assert.equal(handles, 1);
}

async function staleInitializationAndResetWhileSuspended() {
    for (const suspended of [false, true]) {
        const state = { module: null, handle: 0 };
        const { client } = runtime({ getGeneration: () => state.operationEpoch });
        const session = createSession(state, client);
        const factory = deferred(), native = deferred();
        const candidate = { ccall() { return native.promise; } };
        const init = session.initialize(() => factory.promise, module =>
            client.ccallAsync(module, 'init', 'number', [], [], { timeoutMs: null }));
        const cancelled = assert.rejects(init, error => error.silent || error.wasmModuleDead);
        if (suspended) {
            factory.resolve(candidate);
            await flush();
            assert.equal(client.getModuleCallState(candidate).pending, 1);
        }
        session.invalidate('emergency reset', { retire: true });
        const replacement = {};
        assert.equal(await session.initialize(() => replacement, () => {}), replacement);
        if (!suspended) factory.resolve(candidate);
        await cancelled;
        assert.equal(state.module, replacement, 'late initialization cannot replace the new session');
        assert.equal(client.getModuleCallState(candidate).dead, true);
        native.resolve(0);
        await flush();
    }
    const state = { module: null, handle: 0 };
    const session = createSession(state);
    await assert.rejects(session.initialize(() => Promise.reject(new Error('load failed')), () => {}), /load failed/);
    const replacement = {};
    assert.equal(await session.initialize(() => replacement, () => {}), replacement);
    const creation = deferred();
    const handle = session.ensureHandle(() => creation.promise);
    const cancelled = assert.rejects(handle, error => error.silent);
    session.invalidate();
    assert.equal(await session.ensureHandle(() => 42), 42);
    creation.resolve(23);
    await cancelled;
    assert.equal(state.handle, 42);
}

async function main() {
    await fifoAndOperationOwnership();
    await timedOutSlotAndLateCompletion();
    await retirementAndGracePeriod();
    await cancellationBeforeNativeEntry();
    await progressPollingDuringSuspension();
    await cachedInitializationAndHandles();
    await staleInitializationAndResetWhileSuspended();
    console.log('WASM runtime and session tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
