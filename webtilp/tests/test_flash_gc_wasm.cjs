'use strict';
const assert = require('node:assert/strict');
const createModule = require(require('node:path').resolve(process.argv[2]));
const timeout = setTimeout(() => { console.error('Flash GC WASM test timed out'); process.exit(1); }, 45000);
(async () => {
    const module = await createModule();
    await module.ccall('init', 'number', [], [], {async: true});
    assert.equal(await module.ccall('test_flash_gc', 'number', [], [], {async: true}), 0);
    assert.equal(module.__cableTimeoutMs, 25000, 'native GC timeout changes restore the browser deadline');
    clearTimeout(timeout);
    process.exit(0);
})().catch(error => {console.error(error); process.exit(1);});
