'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
function extract(name) {
    let start = source.indexOf(`async function ${name}(`);
    if (start < 0) start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0);
    const body = source.indexOf(') {', start) + 2;
    let depth = 0;
    for (let i = body; i < source.length; i++) {
        if (source[i] === '{') depth++;
        if (source[i] === '}') depth--;
        if (!depth) return source.slice(start, i + 1);
    }
    throw new Error(name);
}
(async () => {
    for (const calcModel of ['casio-rm7000', 'casio-rm9000']) {
        const context = vm.createContext({ state: { settings: { calcModel } }, window: { location: {} } });
        vm.runInContext(extract('connect'), context);
        vm.runInContext(extract('autoConnectIfAuthorized'), context);
        // Any normal TI/Cahute/USB/serial setup would throw in this context.
        await context.autoConnectIfAuthorized();
        assert.equal(context.window.location.href, undefined, 'native RM never auto-connects or navigates');
        await context.connect();
        assert.equal(context.window.location.href, 'rm-loader.html');
    }
    const context = vm.createContext({ CABLE_SILVERLINK: '4', CABLE_GRAYLINK: '1', CABLE_DIRECTLINK: '5' });
    vm.runInContext(source.slice(source.indexOf('const SILVERLINK_CALC_VALUES ='), source.indexOf('const TIVARS_LEGACY_PREVIEW_TYPES =')), context);
    vm.runInContext(extract('sortCalcOptions'), context);
    vm.runInContext(extract('getCalcOptionsForCable'), context);
    for (const cable of ['auto', '1', '4', '5']) {
        const values = context.getCalcOptionsForCable(cable).map(option => option.value);
        for (const model of ['casio-rm7000', 'casio-rm9000']) assert.ok(values.includes(model), `${model} remains manually selectable with cable ${cable}`);
    }
    console.log('RM frontend: manual model selection routes Connect to the loader; no automatic probing or splash shortcut.');
})().catch(error => { console.error(error); process.exitCode = 1; });
