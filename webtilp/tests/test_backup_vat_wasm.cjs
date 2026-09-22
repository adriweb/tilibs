'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const createModule = require('../webtilp.js');
const timeout = setTimeout(() => { console.error('Backup VAT WASM test timed out'); process.exit(1); }, 30000);
(async () => {
    const module = await createModule();
    await module.ccall('init', 'number', [], [], { async: true });
    const fixtures = [{model: 2, file: path.resolve(__dirname, '../../libtifiles/trunk/tests/ti82/backup.82b'), count: 73, name: 'POLY', size: 284}];
    if (process.argv[2]) fixtures.push({model: 6, file: path.resolve(process.argv[2]), count: 9, name: 'Organise', size: 4128});
    for (const fixture of fixtures) {
        module.ccall('set_calc_model', null, ['number'], [fixture.model]);
        const bytes = fs.readFileSync(fixture.file);
        module.FS.writeFile('/backup.bin', bytes);
        const parse = () => module.ccall('calc_backup_dirlist_json', 'number', ['string', 'string'], ['/backup.bin', '/vat.json']);
        assert.equal(parse(), 0);
        const result = JSON.parse(module.FS.readFile('/vat.json', {encoding: 'utf8'}));
        assert.equal(result.vars.length, fixture.count);
        assert.ok(result.vars.every(entry => entry.kind === 'backup-var'));
        assert.equal(result.vars.find(entry => entry.name === fixture.name).size, fixture.size);
        if (fixture.model === 2) {
            assert.ok(result.vars.some(entry => entry.name === '[A]'), 'tokenized matrix names use ticonv');
            assert.ok(result.vars.some(entry => entry.name === 'L₁'), 'tokenized list names use ticonv');
        }
        module.FS.unlink('/vat.json');
        bytes[bytes.length - 1] ^= 1;
        module.FS.writeFile('/backup.bin', bytes);
        assert.equal(parse(), -4);
        assert.equal(module.FS.analyzePath('/vat.json').exists, false, 'invalid backup produces no partial JSON');
        console.log(`WASM backup listing passed: ${path.basename(fixture.file)} (${fixture.count} entries)`);
    }
    clearTimeout(timeout);
    process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
