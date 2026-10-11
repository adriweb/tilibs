'use strict';

function cancellationError() {
    const error = new Error('Operation cancelled due to disconnect.');
    error.silent = true;
    error.staleSession = true;
    return error;
}

function makeModuleDeadError(callState) {
    const error = new Error(`WASM module needs reinitialization (${callState.deadReason}). Please reconnect.`);
    error.wasmModuleDead = true;
    return error;
}

function isFatalWasmRuntimeError(error) {
    const text = String(error?.message || error || '').toLowerCase();
    return text.includes('memory access out of bounds')
        || text.includes('cannot use deleted val')
        || (text.includes('runtimeerror') && text.includes('wasm'));
}

/**
 * Owns Asyncify entry for each module. A JavaScript timeout stops waiting for
 * a result; it cannot cancel native execution or release the module's slot.
 * Hooks keep transport/session policy and DOM progress rendering outside it.
 */
function createWasmClient({
    getGeneration = () => 0,
    timeoutMs: defaultTimeoutMs = 12000,
    minGapMs = 100,
    suspendedGraceMs = 20000,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    sleep = ms => new Promise(resolve => setTimer(resolve, ms)),
    progress = {},
    onFatal = () => {},
    onAbandoned = () => {},
    warn = message => console.warn(message)
} = {}) {
    const states = new WeakMap();

    function getModuleCallState(module) {
        let callState = states.get(module);
        if (!callState) {
            let signalDead;
            callState = {
                tail: Promise.resolve(),
                dead: false,
                deadReason: '',
                lastCallTs: null,
                pending: 0,
                deadSignal: new Promise(resolve => { signalDead = resolve; }),
                markDead(reason) {
                    if (!callState.dead) {
                        callState.dead = true;
                        callState.deadReason = reason || 'module retired';
                        signalDead();
                    }
                }
            };
            states.set(module, callState);
        }
        return callState;
    }

    function retireModule(module, reason) {
        if (module) getModuleCallState(module).markDead(reason);
    }

    function assertCurrent(callState, generation) {
        if (generation !== getGeneration()) throw cancellationError();
        if (callState.dead) throw makeModuleDeadError(callState);
    }

    function readProgressTick(module) {
        if (!module || getModuleCallState(module).dead) return null;
        try {
            // This getter only reads native progress memory. It deliberately
            // bypasses Asyncify entry so polling works during suspended calls.
            return module._get_progress_tick_value();
        } catch {
            return null;
        }
    }

    async function withTimeout(promise, label, timeoutMs = defaultTimeoutMs) {
        if (timeoutMs === null) return promise;
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = setTimer(() => {
                const error = new Error(`${label} timed out`);
                error.ccallTimeout = true;
                reject(error);
            }, timeoutMs);
        });
        try { return await Promise.race([promise, timeout]); }
        finally { clearTimer(timer); }
    }

    async function withProgressTimeout(promise, label, timeoutMs = defaultTimeoutMs, module = null) {
        let lastProgress = now();
        let lastTick = readProgressTick(module);
        let poll;
        let done = false;
        const idleTimeout = new Promise((_, reject) => {
            const check = () => {
                if (done) return;
                const tick = readProgressTick(module);
                if (tick !== null && tick !== lastTick) {
                    lastTick = tick;
                    lastProgress = now();
                    progress.touch?.(module);
                    progress.refresh?.(module);
                }
                lastProgress = Math.max(lastProgress, progress.lastProgress?.(module) || 0);
                if (timeoutMs !== null && now() - lastProgress > timeoutMs) {
                    const error = new Error(`${label} timed out`);
                    error.ccallTimeout = true;
                    reject(error);
                } else {
                    poll = setTimer(check, 100);
                }
            };
            poll = setTimer(check, 100);
        });
        try { return await Promise.race([promise, idleTimeout]); }
        finally { done = true; clearTimer(poll); }
    }

    function watchAbandonedCcall(module, name, underlying) {
        const callState = getModuleCallState(module);
        let timer;
        let settled = false;
        const finish = () => { settled = true; clearTimer(timer); };
        underlying.then(finish, finish);
        onAbandoned(module, name);
        warn(`[WebTILP] ${name} timed out on the JS side but is still running in the WASM module; blocking further WASM calls until it returns.`);
        timer = setTimer(() => {
            if (settled || callState.dead) return;
            const error = new Error(`${name} never returned; the WASM module is stuck in a suspended Asyncify call`);
            callState.markDead(error.message);
            onFatal(module, error);
        }, suspendedGraceMs);
    }

    /**
     * Serializes a complete operation, including result-file consumption.
     * `call` enters WASM within this slot; do not recursively call ccallAsync.
     * Native calls within an operation must be awaited sequentially.
     */
    async function runOperation(module, operation) {
        const generation = getGeneration();
        const callState = getModuleCallState(module);
        const check = () => assertCurrent(callState, generation);
        check();
        const previous = callState.tail;
        let release;
        callState.tail = new Promise(resolve => { release = resolve; });
        let entered = false;
        let finished = false;
        let pending = 0;
        let calling = false;
        const releaseIfFinished = () => {
            if (finished && pending === 0) release();
        };
        const dead = callState.deadSignal.then(() => { throw makeModuleDeadError(callState); });

        async function call(name, returnType, argTypes, args, options = {}) {
            check();
            if (calling || pending) throw new Error('Await each WASM call before entering the next call in an operation.');
            calling = true;
            try {
                const gap = callState.lastCallTs === null ? minGapMs : now() - callState.lastCallTs;
                if (gap < minGapMs) {
                    await sleep(minGapMs - gap);
                    check();
                }
            } catch (error) { calling = false; throw error; }
            callState.lastCallTs = now();
            const timeoutMs = Object.hasOwn(options, 'timeoutMs') ? options.timeoutMs : defaultTimeoutMs;
            const label = options.progressLabel || name;
            progress.touch?.(module);
            let cleanup;
            let result;
            try {
                cleanup = options.prepareCall?.();
                result = module.ccall(name, returnType, argTypes, args, { async: true });
            } catch (error) {
                calling = false;
                cleanup?.();
                if (isFatalWasmRuntimeError(error)) {
                    callState.markDead(String(error?.message || error));
                    onFatal(module, error);
                }
                throw error;
            }
            pending += 1;
            callState.pending += 1;
            const resultPromise = Promise.resolve(result);
            const underlying = cleanup ? resultPromise.finally(cleanup) : resultPromise;
            let settled = false;
            const complete = () => {
                settled = true;
                pending -= 1;
                callState.pending -= 1;
                releaseIfFinished();
            };
            underlying.then(complete, complete);
            if (options.useProgress) progress.start?.(label, module);
            try {
                const nativeOrDead = Promise.race([underlying, dead]);
                const value = options.useProgress
                    ? await withProgressTimeout(nativeOrDead, label, timeoutMs, module)
                    : await withTimeout(nativeOrDead, name, timeoutMs);
                check();
                return value;
            } catch (error) {
                if (error?.ccallTimeout && !settled) watchAbandonedCcall(module, name, underlying);
                check();
                if (isFatalWasmRuntimeError(error)) {
                    callState.markDead(String(error?.message || error));
                    onFatal(module, error);
                }
                throw error;
            } finally {
                calling = false;
                if (options.useProgress) progress.stop?.(label, module);
            }
        }

        try {
            await Promise.race([previous, dead]);
            check();
            entered = true;
            const result = await Promise.race([operation(call, { assertCurrent: check }), dead]);
            check();
            return result;
        } finally {
            finished = true;
            if (entered) releaseIfFinished();
            else previous.then(release, release);
        }
    }

    function ccallAsync(module, name, returnType, argTypes, args, options) {
        return runOperation(module, call => call(name, returnType, argTypes, args, options));
    }

    return { ccallAsync, runOperation, retireModule, getModuleCallState, readProgressTick,
        withTimeout, withProgressTimeout };
}

module.exports = { createWasmClient, cancellationError, makeModuleDeadError, isFatalWasmRuntimeError };
