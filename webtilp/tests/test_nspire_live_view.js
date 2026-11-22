'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const { USBDevice, extract, harness } = require('./ti_link_harness');

async function testNspireLiveScreenResume() {
    const device = new USBDevice();
    device.productId = 0xe022;
    const { state, context } = harness(device, true);
    function button() {
        const classes = new Set();
        return {
            dataset: {},
            disabled: false,
            classList: {
                add: name => classes.add(name),
                remove: name => classes.delete(name),
                contains: name => classes.has(name),
                toggle: (name, on) => on ? classes.add(name) : classes.delete(name)
            }
        };
    }
    const transferButton = button();
    const liveButton = button();
    const calls = [];
    const pending = new Map();
    const module = state.module = {
        ccall(name) {
            calls.push(name);
            if (['nspire_live_screen_next', 'calc_recv_var', 'calc_send_key'].includes(name)) {
                return new Promise(resolve => pending.set(name, resolve));
            }
            return 0;
        },
        _nspire_live_screen_bitmap: () => 0
    };
    const tick = () => new Promise(resolve => setImmediate(resolve));
    async function completeCall(name, value = 0) {
        for (let i = 0; !pending.has(name) && i < 50; i++) await tick();
        assert.ok(pending.has(name), `waiting for ${name}`);
        const complete = pending.get(name);
        pending.delete(name);
        complete(value);
    }
    state.connected = true;
    state.progressOps = new Map();
    Object.assign(context, {
        els: {
            btnNspireLiveScreen: liveButton,
            screenshotCanvas: { getContext: () => ({ createImageData: () => ({}) }) }
        },
        document: {
            querySelector: () => transferButton.classList.contains('loading') ? transferButton : null,
            querySelectorAll: () => []
        },
        NSPIRE_CXII_CALC_MODELS: new Set([34]),
        NSPIRE_LIVE_FRAME_TIMEOUT_MS: 30000,
        ensureCableOpen: async () => state.handle,
        getActiveCalcModelId: () => 34,
        isNspireActive: () => true,
        t: key => key,
        tFormat: key => key,
        setIconLabel: (element, _icon, text) => { element.text = text; },
        updateProgressIndicator() {}
    });
    for (const name of ['clearActiveOperations', 'setButtonLoading', 'updateNspireLiveScreenControl', 'stopNspireLiveScreen',
        'holdNspireLiveScreen', 'resumeNspireLiveScreen', 'runNspireLiveScreen', 'toggleNspireLiveScreen']) {
        vm.runInContext(extract(name), context);
    }

    context.toggleNspireLiveScreen();
    await tick();
    context.setButtonLoading(transferButton, true);
    const first = context.ccallAsync(module, 'calc_recv_var', 'number', [], []);
    await completeCall('nspire_live_screen_next');
    await completeCall('calc_recv_var');
    assert.equal(await first, 0);
    await tick();
    assert.deepEqual(calls, ['nspire_live_screen_start', 'nspire_live_screen_next', 'nspire_live_screen_stop', 'calc_recv_var']);
    assert.equal(liveButton.text, 'nspire_live_view_stop');
    assert.equal(liveButton.disabled, false, 'Stop remains available while paused');

    const second = context.ccallAsync(module, 'calc_recv_var', 'number', [], []);
    await completeCall('calc_recv_var', 7);
    assert.equal(await second, 7);
    await tick();
    assert.equal(calls.at(-1), 'calc_recv_var', 'an individual file result never resumes the batch');
    context.setButtonLoading(transferButton, false);
    await tick();
    assert.deepEqual(calls.slice(-2), ['nspire_live_screen_start', 'nspire_live_screen_next']);

    const key = context.ccallAsync(module, 'calc_send_key', 'number', [], []);
    await completeCall('nspire_live_screen_next');
    await tick();
    assert.equal(calls.at(-1), 'calc_send_key');
    await context.toggleNspireLiveScreen();
    await completeCall('calc_send_key');
    await key;
    await tick();
    assert.equal(calls.at(-1), 'calc_send_key', 'manual Stop cancels pending resume');
    assert.equal(liveButton.text, 'nspire_live_view_start');

    context.toggleNspireLiveScreen();
    await tick();
    const interrupted = context.ccallAsync(module, 'calc_recv_var', 'number', [], []);
    await completeCall('nspire_live_screen_next');
    await tick();
    assert.equal(calls.at(-1), 'calc_recv_var');
    context.clearActiveOperations();
    const cancelled = assert.rejects(interrupted, error => error.silent === true);
    await completeCall('calc_recv_var');
    await cancelled;
    await tick();
    assert.equal(calls.at(-1), 'calc_recv_var', 'disconnect cancels pending resume');
    console.log('Nspire Live View pauses across batches, resumes after completion, and honors Stop and disconnect');
}

testNspireLiveScreenResume().catch(error => { console.error(error); process.exitCode = 1; });
