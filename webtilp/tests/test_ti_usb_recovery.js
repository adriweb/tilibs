'use strict';

const assert = require('node:assert/strict');
const { USBDevice, harness } = require('./ti_link_harness');

async function main() {
    for (const configuredTimeout of [5000, 20000, 60000]) {
        const h = harness();
        h.transport.module = { __configuredCableTimeoutMs: configuredTimeout, __cableTimeoutMs: 360000 };
        const cts = h.device.transferIn(1, 64);
        const feed = setTimeout(() => h.device.feed([0x98, 9, 0, 0]), 35);
        try {
            assert.deepEqual([...new Uint8Array((await cts).data.buffer)], [0x98, 9, 0, 0]);
        } finally { clearTimeout(feed); }
        assert.equal(h.deadlines.at(-1), 360000, 'SilverLink honors the native Flash wait extension');
        assert.equal(h.transport.needsRecovery, false);
        h.transport.module.__cableTimeoutMs = configuredTimeout;
        await assert.rejects(h.device.transferIn(1, 64), { name: 'TimeoutError' });
        assert.equal(h.deadlines.at(-1), 1100, 'ordinary SilverLink reads retain their short deadline');
    }
    {
        const device = new USBDevice(); device.productId = 0xe008;
        let finishClose;
        device.closeGate = new Promise(resolve => { finishClose = resolve; });
        const h = harness(device);
        const calls = [];
        const module = h.state.module = h.transport.module = { __cableTimeoutMs: 50, async ccall(name) {
            calls.push(name);
            if (name === 'is_ready') {
                try { await device.transferIn(1, 64); } catch (_) { return 3; }
            }
            if (name === 'close_cable') { await device.close(); return 0; }
            assert.equal(name, 'open_cable');
            assert.equal(device.waiting.size, 0);
            assert.equal(h.transport.needsRecovery, false);
            return 0;
        } };
        assert.equal(await h.context.ccallAsync(module, 'is_ready', 'number', ['number'], [42]), 3,
            'a slow browser close does not delay the native error');
        assert.equal(h.state.cableOpen, false, 'a retry must reopen the cable after cleanup');
        assert.equal(device.waiting.size, 1, 'the browser can still be cancelling its old read');
        const next = h.context.ccallAsync(module, 'open_cable', 'number', ['number'], [42]);
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(calls, ['is_ready'], 'native close and queued calls wait for the browser close');
        finishClose();
        assert.equal(await next, 0);
    }
    for (const productId of [0xe003, 0xe008]) {
        const device = new USBDevice();
        device.productId = productId;
        const h = harness(device, true);
        const module = h.transport.module = { __cableTimeoutMs: 60 };
        const started = Date.now();
        await assert.rejects(device.transferIn(1, 64), { name: 'TimeoutError' });
        assert.ok(Date.now() - started >= 50, 'DirectLink uses the configured deadline');
        await h.transport.abort();
        assert.equal(device.waiting.size, 0, 'recovery settles outstanding browser reads');
        assert.equal(h.transport.needsRecovery, true);
        device.bytes.push(0xaa, 0xbb); // A stale response must not reach the next command.
        await h.transport.recover();
        assert.equal(device.bytes.length, 0);
        assert.ok(!device.calls.includes('reset'), 'DirectLink recovery must not re-enumerate a CE without a USB serial number');
        assert.ok(device.calls.includes('halt:in:1') && device.calls.includes('halt:out:1'),
            'DirectLink recovery clears endpoint state after a cancelled transfer');
        await device.open(); await device.claimInterface(0);
        module.__cableTimeoutMs = 120; // Temporary/native timeout changes apply to subsequent I/O.
        device.holdWrites = true;
        const writeStarted = Date.now();
        const nativeBytes = new Uint8Array([1]);
        // The browser is allowed to retain the submitted BufferSource while
        // its transfer is pending, even after the native call has timed out.
        await assert.rejects(device.transferOut(1, nativeBytes), { name: 'TimeoutError' });
        nativeBytes[0] = 99;
        assert.deepEqual([...device.retainedWrite], [1], 'late browser writes cannot observe recycled native bytes');
        assert.ok(Date.now() - writeStarted >= 100, 'updated timeout also applies to writes');
        await h.transport.abort();
        assert.equal(device.waiting.size, 0);
        device.holdWrites = false;
        await h.transport.recover();
        await device.open(); await device.claimInterface(0);
        device.feed([42]);
        assert.equal((await device.transferIn(1, 64)).data.getUint8(0), 42);
    }
    {
        const h = harness(new USBDevice(), true);
        const started = Date.now();
        await assert.rejects(h.device.transferIn(1, 64), { name: 'TimeoutError' });
        const elapsed = Date.now() - started;
        assert.ok(elapsed >= 1050 && elapsed < 2500, `actual 1.1-second deadline: ${elapsed}ms`);
        assert.equal(h.device.waiting.size, 0, 'timeout cancels browser I/O before rejecting to native code');
        h.device.bytes.push(0x86, 0x56, 0, 0, 0x15, 0x00);
        await h.transport.recover();
        assert.equal(h.device.bytes.length, 0);
        assert.equal(h.device.opened, false);
        await h.device.open(); await h.device.claimInterface(0);
        h.device.bytes.push(0x86, 0x56, 0, 0);
        assert.deepEqual([...new Uint8Array((await h.device.transferIn(1, 64)).data.buffer)], [0x86, 0x56, 0, 0]);
    }
    {
        const h = harness();
        h.device.holdWrites = true;
        await assert.rejects(h.device.transferOut(1, new Uint8Array([6, 0xa2])), { name: 'TimeoutError' });
        assert.equal(h.device.waiting.size, 0);
        h.device.holdWrites = false;
        await h.transport.recover();
    }
    for (const failReset of [false, true]) {
        const h = harness();
        h.device.failReset = failReset;
        const calls = [];
        let nativeBuffer = [0xa2, 0x15];
        const module = h.state.module = { async ccall(name) {
            calls.push(name);
            if (name === 'close_cable') { nativeBuffer = []; await h.device.close(); return 0; }
            if (name === 'calc_recv_backup') {
                try { await h.device.transferIn(1, 64); } catch (_) { h.device.bytes.push(0x15, 0x00); return 3; }
            }
            assert.equal(name, 'calc_screenshot');
            assert.equal(h.device.bytes.length, 0, 'queued command starts after the hardware drain');
            assert.deepEqual(nativeBuffer, [], 'native cable buffer is discarded too');
            await h.device.open(); await h.device.claimInterface(0);
            h.device.bytes.push(99);
            assert.equal((await h.device.transferIn(1, 64)).data.getUint8(0), 99);
            return 0;
        } };
        const first = h.context.ccallAsync(module, 'calc_recv_backup', 'number', [], []);
        const next = h.context.ccallAsync(module, 'calc_screenshot', 'number', [], []);
        assert.equal(await first, 3, 'original native failure is preserved');
        assert.equal(await next, 0);
        assert.deepEqual(calls, ['calc_recv_backup', 'close_cable', 'calc_screenshot']);
        assert.equal(h.context.getModuleCallState(module).dead, false, 'ordinary timeout preserves the WASM module');
        assert.equal(h.transport.needsRecovery, false, 'a rejected USB reset does not prevent draining and retrying');
    }
    for (const failReset of [false, true]) {
        const h = harness();
        h.device.failReset = failReset;
        let nativeActive = false;
        const module = h.state.module = { async ccall(name) {
            if (name === 'calc_recv_backup') {
                nativeActive = true;
                try { await h.device.transferIn(1, 64); } catch (_) { h.device.bytes.push(0x86, 0x15, 0, 0); }
                nativeActive = false;
                return 3;
            }
            assert.ok(['close_cable', 'notify_usb_disconnect'].includes(name));
            assert.equal(nativeActive, false, 'bomb never re-enters suspended Asyncify');
            await h.device.close();
            return 0;
        } };
        const transfer = h.context.ccallAsync(module, 'calc_recv_backup', 'number', [], []);
        const cancelled = assert.rejects(transfer, error => error.silent === true);
        await new Promise(resolve => setImmediate(resolve));
        await h.context.nukeConnection();
        await cancelled;
        assert.equal(h.state.reconnected, true);
        assert.equal(h.state.module, null);
        assert.equal(h.state.progressHooked, false);
        assert.equal(h.state.progressTickPtr, null);
        assert.equal(h.device.waiting.size, 0);
        assert.equal(h.state.nukeInProgress, false);
        assert.equal(h.transport.needsRecovery, false);
        assert.ok(!h.logs.some(args => args[0] === 'ERROR'), 'bomb recovery succeeds even if USB reset is rejected');
    }
    {
        const h = harness();
        h.state.authorizedDevice = {serialKind: 2};
        let active = false;
        const serial = {queue: [], queuedBytes: 0, waiters: []};
        const module = h.state.module = {
            __ticablesWebSerial: serial,
            async ccall(name) {
                if (name === 'calc_recv_var_ns') {
                    active = true;
                    await new Promise(resolve => serial.waiters.push(resolve));
                    assert.ok(serial.error);
                    active = false;
                    return 3;
                }
                assert.equal(name, 'notify_usb_disconnect');
                assert.equal(active, false, 'GrayLink teardown waits for the receive to leave Asyncify');
                return 0;
            }
        };
        const cancelled = assert.rejects(h.context.ccallAsync(module, 'calc_recv_var_ns', 'number', [], []),
            error => error.silent === true);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(active, true);
        await h.context.nukeConnection(false);
        await cancelled;
        assert.equal(h.state.module, null);
        assert.equal(serial.waiters.length, 0);
    }
    for (const failReset of [false, true]) {
        const h = harness();
        h.device.failReset = failReset;
        h.device.endless = true;
        await assert.rejects(h.transport.recover(), /did not become quiet/);
        await assert.rejects(h.device.transferOut(1, new Uint8Array([1])), /needs buffer recovery/);
    }
    {
        const device = new USBDevice(); device.productId = 0xe004;
        const original = device.transferIn;
        const h = harness(device);
        assert.equal(h.transport, null);
        assert.equal(device.transferIn, original, 'other calculator families retain their transport');
    }
    console.log('TI USB deadlines, native/USB buffer recovery, FIFO and bomb cancellation tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
