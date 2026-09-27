'use strict';
const assert = require('node:assert/strict');
const createModule = require(require('node:path').resolve(process.argv[2]));
const timeout = setTimeout(() => { console.error('Variable send WASM test timed out'); process.exit(1); }, 30000);
(async () => {
    const module = await createModule();
    await module.ccall('init', 'number', [], [], {async: true});
    assert.equal(await module.ccall('test_var_send_protocol', 'number', [], [], {async: true}), 0);
    clearTimeout(timeout);
    process.exit(0);
})().catch(error => {console.error(error); process.exit(1);});
