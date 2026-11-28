'use strict';
const createModule = require(require('node:path').resolve(process.argv[2]));
const timeout = setTimeout(() => {
    console.error('Accessory Flash WASM test timed out');
    process.exit(1);
}, 30000);

(async () => {
    const module = await createModule();
    await module.ccall('init', 'number', [], [], {async: true});
    const result = await module.ccall('test_accessory_flash_chain', 'number', [], [], {async: true});
    if (result !== 0) throw new Error(`Accessory Flash test failed: ${result}`);
    clearTimeout(timeout);
    process.exit(0);
})().catch(error => {
    console.error(error);
    process.exit(1);
});
