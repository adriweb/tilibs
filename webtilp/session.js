'use strict';

const { cancellationError } = require('./runtime/wasm-client.js');

/** Connection identity and initialization ownership, independent of the UI. */
function createSession(state, { retireModule = () => {} } = {}) {
    let initialization = null;
    let initializingModule = null;
    let handleCreation = null;
    state.operationEpoch ??= 0;

    function capture() { return state.operationEpoch; }
    function assertCurrent(generation) {
        if (generation !== capture()) throw cancellationError();
    }

    function invalidate(reason = 'device disconnected', { retire = false } = {}) {
        state.operationEpoch += 1;
        retireModule(initializingModule, reason);
        initializingModule = null;
        initialization = null;
        handleCreation = null;
        state.handlePromise = null;
        state.connectAttempt = null;
        state.connectInProgress = false;
        if (retire) {
            retireModule(state.module, reason);
            state.module = null;
        }
        return capture();
    }

    function initialize(factory, configure) {
        if (initialization) return initialization;
        if (state.module) return Promise.resolve(state.module);
        const generation = capture();
        let candidate;
        const pending = (async () => {
            try {
                candidate = await factory();
                assertCurrent(generation);
                initializingModule = candidate;
                await configure(candidate);
                assertCurrent(generation);
                state.module = candidate;
                if (initializingModule === candidate) initializingModule = null;
                return candidate;
            } catch (error) {
                retireModule(candidate, 'module initialization failed or cancelled');
                if (initializingModule === candidate) initializingModule = null;
                throw error;
            }
        })();
        initialization = pending;
        pending.then(() => {
            if (initialization === pending) initialization = null;
        }, () => {
            if (initialization === pending) initialization = null;
        });
        return pending;
    }

    function ensureHandle(factory) {
        if (handleCreation) return handleCreation;
        if (state.handle) return Promise.resolve(state.handle);
        const generation = capture();
        const pending = (async () => {
            const handle = await factory(() => assertCurrent(generation));
            assertCurrent(generation);
            state.handle = handle;
            return handle;
        })();
        handleCreation = pending;
        state.handlePromise = pending;
        const clear = () => {
            if (handleCreation === pending) {
                handleCreation = null;
                state.handlePromise = null;
            }
        };
        pending.then(clear, clear);
        return pending;
    }

    async function run(operation) {
        const generation = capture();
        const result = await operation(() => assertCurrent(generation));
        assertCurrent(generation);
        return result;
    }

    async function wait(promise, generation) {
        const result = await promise;
        assertCurrent(generation);
        return result;
    }

    return { capture, assertCurrent, invalidate, initialize, ensureHandle, run, wait };
}

module.exports = { createSession };
