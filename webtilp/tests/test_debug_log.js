'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
function extract(name) {
    const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
    assert.ok(start >= 0, name);
    const next = /\n(?:async )?function \w+\(/g;
    next.lastIndex = start + 1;
    const end = next.exec(source);
    return source.slice(start, end ? end.index : source.length);
}
(async () => {
    const downloads = [], errors = [], calls = [];
    const state = {module: null};
    const button = {loading: false};
    const status = {classList: {remove() {}}};
    const context = vm.createContext({state,
        els: {btnDownloadDebugLog: button, debugLogStatus: status},
        setButtonLoading: (element, loading) => { element.loading = loading; },
        setTextContent: (element, text) => { element.textContent = text; },
        t: key => key,
        logError: error => errors.push(error),
        triggerDownload: (name, data) => downloads.push({name, data: Array.from(data)}),
        getModuleCallState: module => module.callState,
        async ccallAsync(module, name) {
            assert.equal(button.loading, true);
            assert.equal(name, 'get_debug_log_path');
            assert.equal(module.callState.dead, false);
            calls.push(name);
            return module.snapshot?.();
        }
    });
    vm.runInContext('let lastDebugLog = null;\n' +
        ['readDebugLog', 'retireModule', 'downloadDebugLog'].map(extract).join('\n'), context);
    await context.downloadDebugLog();
    assert.equal(status.textContent, 'debug_log_unavailable');
    assert.equal(downloads.length, 0);
    assert.equal(calls.length, 0); // No module creation or USB connection.

    let bytes = Uint8Array.from([65, 10, 255]);
    let path = '/home/web_user/.ticables/ticables-dbus.pkt';
    state.module = {
        FS: {readFile(request) {
            if (request.endsWith('/debug-log-path')) return path;
            assert.equal(request, path);
            if (!bytes) throw new Error('ENOENT');
            return bytes.slice();
        }},
        callState: {dead: false, markDead() { this.dead = true; }},
        snapshot() { bytes = Uint8Array.from([66, 10, 254]); return path; }
    };
    await context.downloadDebugLog();
    assert.deepEqual(downloads.pop(), {name: 'ticables-dbus.pkt', data: [66, 10, 254]});
    assert.equal(status.textContent, 'debug_log_downloaded');
    // Switching protocols must keep the data and download filename together.
    path = '/home/web_user/.ticables/ticables-dusb.pkt';
    await context.downloadDebugLog();
    assert.deepEqual(downloads.pop(), {name: 'ticables-dusb.pkt', data: [66, 10, 254]});
    // Teardown may have produced newer bytes than the last snapshot.
    bytes = Uint8Array.from([67, 10, 253]);
    context.retireModule(state.module, 'emergency reset');
    await context.downloadDebugLog();
    assert.deepEqual(downloads.pop(), {name: 'ticables-dusb.pkt', data: [67, 10, 253]});
    state.module = null;
    bytes = null;
    await context.downloadDebugLog();
    assert.deepEqual(downloads.pop(), {name: 'ticables-dusb.pkt', data: [67, 10, 253]});
    assert.equal(calls.length, 2); // The retired session needs no native call.
    vm.runInContext('lastDebugLog = null', context);
    state.module = {callState: {dead: true}, FS: {readFile() { throw new Error('ENOENT'); }}};
    await context.downloadDebugLog();
    assert.equal(status.textContent, 'debug_log_unavailable');
    state.module = {callState: {dead: false}, snapshot() { throw new Error('snapshot failed'); }};
    await context.downloadDebugLog();
    assert.equal(status.textContent, 'debug_log_failed');
    assert.equal(errors.length, 1);
    assert.equal(button.loading, false);
    console.log('Debug log download: DBUS/DUSB filenames, fresh bytes, retired sessions, missing logs and failure handling passed.');
})().catch(error => {console.error(error); process.exitCode = 1;});
