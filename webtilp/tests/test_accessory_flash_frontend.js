'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const start = app.indexOf('async function buildTransferPlanFromFsEntries(');
const end = app.indexOf('\nasync function extractBundleFiles(', start);
const context = vm.createContext({Number});
vm.runInContext(app.slice(start, end), context);

(async () => {
    const entries = [{
        path: '/combined.c2u',
        name: 'combined.c2u',
        class: 'os',
        entries: [
            {name: 'OPERATING_SYSTEM', type: 0x23, entry_class: 'os',
                container_type: 'flash', container_index: 0, attr: 3, location_mask: 2, size: 4},
            {name: 'DATAMATE', type: 0x29, type_name: 'APPL', entry_class: 'application',
                container_type: 'flash', container_index: 1, attr: 3, location_mask: 2, size: 3}
        ]
    }];
    const module = {FS: {stat: () => ({size: 100})}};
    const plan = await context.buildTransferPlanFromFsEntries(entries, module);
    assert.equal(plan.length, 2);
    assert.deepEqual(Array.from(plan, item => item.fileClass), ['os', 'application']);
    assert.deepEqual(Array.from(plan, item => item.sourceFileClass), ['os', 'os']);
    assert.deepEqual(Array.from(plan, item => item.entryIndex), [0, 1]);
    assert.ok(plan.every(item => item.containerKind === 3 && item.sendByEntry));
    assert.ok(plan.every(item => item.locationMode === 'archive'));
    console.log('Accessory Flash frontend planning passed.');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
