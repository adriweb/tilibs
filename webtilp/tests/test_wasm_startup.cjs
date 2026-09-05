const assert = require('node:assert/strict');
const path = require('node:path');
const createModule = require(process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../webtilp.js'));
const timeout = setTimeout(() => {
    console.error('WebTILP startup timed out');
    process.exit(1);
}, 30000);
(async () => {
    const module = await createModule();
    const result = await module.ccall('init', 'number', [], [], { async: true });
    // The TI libraries return their initialization reference count, not an error code.
    assert.equal(result, 1);
    const version = module.ccall('get_version', 'string', [], []);
    assert.match(version, /^\d+\.\d+/);
    module.FS.writeFile('/dependency-upgrade-smoke.txt', 'WebTILP dependency upgrade');
    assert.equal(module.FS.readFile('/dependency-upgrade-smoke.txt', { encoding: 'utf8' }), 'WebTILP dependency upgrade');
    module.FS.unlink('/dependency-upgrade-smoke.txt');
    console.log(`PASS: WebTILP module startup, library initialization (${version}), and MEMFS`);
    clearTimeout(timeout);
    process.exit(0);
})().catch(error => {
    console.error(error);
    process.exit(1);
});
