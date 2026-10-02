'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const section = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
let activeModel = 0;
const queries = [];
const state = {settings: {calcModel: 'auto', convertScriptFiles: true}, activeFamily: 'ti'};
const els = {fileInput: {accept: ''}};
const context = vm.createContext({
    state, els, console,
    CABLE_SILVERLINK: '4', CABLE_GRAYLINK: '1',
    getActiveCalcModelId: () => activeModel
});
vm.runInContext([
    section('const DEVICE_FAMILY_TI =', '// Known TI USB devices'),
    section('const CE_PYTHON_CALC_MODELS =', 'const PID_SILVERLINK ='),
    section('function getPythonConversionKind(', 'function getSelectedConversionModelId('),
    section('function isHPPrimeActive(', 'function resetFamilySpecificUiText('),
    section('function isLegacyTivarsConversionCandidate(', 'async function convertLegacyTivarsFileForEvo(')
].join('\n'), context);

// Model the native bridge for frontend lifecycle and conversion checks.
const nativeExtensions = new Map([
    [2, '82p,82y,82b,82g'], [3, '83p,83y,83b,83g'],
    [4, '8xp,8xv,8xy,8xg,8xk,8xu'], [18, '8xp,8ci,8ca,8cg,8ck,8cu'],
    [19, '8xp,8xv,8ci,8ca,8pu,8ek'], [20, '8xp,8xv,8ci,8ca,8eu,8ek'],
    [28, 'tns,tco'], [32, 'tns,tco2'], [48, '8xp2,8xpy2,8mp2,84b2,84pk2']
]);
const mockModule = {ccall(name, resultType, argTypes, args) {
    assert.equal(name, 'get_file_extensions');
    assert.equal(resultType, 'string');
    assert.deepEqual(Array.from(argTypes), ['number']);
    queries.push(args[0]);
    return nativeExtensions.get(args[0]) || '';
}};
state.module = mockModule;
function accepts(name) {
    return els.fileInput.accept.split(',').filter(Boolean)
        .some(ext => name.endsWith(ext));
}
function select(model) {
    activeModel = model;
    state.activeFamily = 'ti';
    context.updateFileInputAccept();
}
select(0);
assert.equal(els.fileInput.accept, '', 'unknown target stays unrestricted');
select(2);
for (const name of ['program.82p', 'program.82P', 'backup.82B']) assert.ok(accepts(name), name);
assert.ok(!accepts('program.8xp'));
assert.ok(!accepts('readme.txt'));
assert.ok(!accepts('program.py'));
state.settings.calcModel = '20';
select(0);
assert.ok(accepts('demo.Py'), 'use explicitly configured model before identification');
state.settings.calcModel = 'auto';
select(19);
for (const name of ['DEMO.8Xp', 'DEMO.8XP', 'DEMO.8xp', 'demo.pY', 'os.8Pu', 'bundle.B83', 'bundle.b84']) {
    assert.ok(accepts(name), name);
}
assert.ok(!accepts('script.lua'));
assert.ok(!accepts('demo.tns'));
state.settings.convertScriptFiles = false;
context.updateFileInputAccept();
assert.ok(!accepts('demo.py'), 'conversion opt-out hides Python sources');
assert.ok(accepts('demo.8xv'));
state.settings.convertScriptFiles = true;
select(28);
assert.ok(accepts('demo.LuA'));
assert.ok(accepts('demo.TNS'));
assert.ok(!accepts('demo.py'), 'original CX has no Python source conversion');
select(32);
assert.ok(accepts('demo.PY'));
assert.ok(accepts('demo.tCo2'));
select(48);
for (const name of ['demo.8Xp2', 'demo.8MP2', 'demo.8XPy2', 'os.84PK2', 'old.82P', 'old.83p', 'old.8xP', 'old.8Ci']) {
    assert.ok(accepts(name), name);
}
assert.ok(!accepts('old.8XK'), 'legacy flash apps are not converted for Evo');
assert.ok(!accepts('old.8CU'), 'legacy OS files are not converted for Evo');
state.settings.convertScriptFiles = false;
context.updateFileInputAccept();
assert.ok(!accepts('demo.py'));
assert.ok(accepts('old.8xp'), 'legacy variable conversion remains enabled independently');
state.activeFamily = 'hp-prime';
context.updateFileInputAccept();
for (const name of ['demo.HpPrgm', 'demo.HPAPP', 'demo.hpmatrix', 'demo.hpnote']) assert.ok(accepts(name), name);
assert.ok(!accepts('demo.py'));
state.activeFamily = 'numworks';
context.updateFileInputAccept();
assert.ok(accepts('demo.Py'));
assert.ok(!accepts('readme.txt'), 'a text MIME type must not broaden the Python filter');
state.module = null;
select(0);
assert.equal(els.fileInput.accept, '', 'disconnect clears the previous family filter');
state.module = {ccall() { throw new Error('unavailable bridge'); }};
context.console = {warn() {}};
select(20);
assert.equal(els.fileInput.accept, '', 'unavailable metadata does not hide all files');
assert.ok(queries.includes(20));
assert.equal(context.buildFileInputAccept(['8Xp', '.8XP', '8x?', '', 'text/plain']), '.8xp,.8xP,.8Xp,.8XP');

async function checkSettingsChange() {
    state.module = mockModule;
    context.console = console;
    state.settings = {cableModel: 'auto', calcModel: 'auto', cableTimeout: 100,
        cableDelay: 0, language: 'auto', convertScriptFiles: true};
    Object.assign(els, {
        settingCableModel: {value: 'auto'}, settingCalcModel: {value: 'auto'},
        settingTimeout: {value: '100'}, settingDelay: {value: '0'},
        settingLanguage: {value: 'auto'}, settingConvertScriptFiles: {checked: false}
    });
    Object.assign(context, {
        saveSettings() {}, closeSettingsModal() {}, log() {},
        normalizeLanguageCode: value => value,
        applySettingsToModule() { throw new Error('conversion setting must preserve the detected model'); }
    });
    vm.runInContext(section('async function saveSettingsFromModal(', 'function log('), context);
    select(32);
    assert.ok(accepts('demo.py'));
    await context.saveSettingsFromModal();
    assert.equal(activeModel, 32);
    assert.ok(!accepts('demo.py'));
    assert.ok(!accepts('demo.lua'));
    assert.ok(accepts('demo.TNS'));
    els.settingConvertScriptFiles.checked = true;
    await context.saveSettingsFromModal();
    assert.ok(accepts('demo.Py'));
    assert.ok(accepts('demo.LuA'));
}

// Optional verification against a freshly compiled production WASM module.
async function checkNative() {
    if (!process.argv[2]) return;
    const module = await require(path.resolve(process.argv[2]))();
    const extensions = model => new Set(module.ccall('get_file_extensions', 'string', ['number'], [model]).split(','));
    const includes = (model, expected, excluded = []) => {
        const exts = extensions(model);
        for (const ext of expected) assert.ok(exts.has(ext), `model ${model} includes ${ext}`);
        for (const ext of excluded) assert.ok(!exts.has(ext), `model ${model} excludes ${ext}`);
        assert.ok([...exts].every(ext => /^[a-z0-9]+$/.test(ext)), 'no placeholders');
    };
    includes(2, ['82p', '82y', '82b', '82g', 'tig'], ['8xp', '8xu']);
    includes(6, ['85p', '85s', '85b', '85g']);
    includes(13, ['8xp', '8xy', '8xg', '8xk', '8xu'], ['8ci']);
    includes(18, ['8xp', '8ci', '8ca', '8cg', '8cu']);
    includes(19, ['8xp', '8ci', '8pu', '8ek'], ['8eu']);
    includes(20, ['8xp', '8ci', '8eu', '8ek'], ['8pu']);
    includes(8, ['89p', '92p', '9xp', 'v2p', '89u', 'tib'], ['9xu', '92b']);
    includes(10, ['92p', '89p', '92b', '92g'], ['tib', '89u']);
    includes(28, ['tns', 'tco'], ['tcc', '8xp', 'tig']);
    includes(32, ['tns', 'tco2'], ['tco', 'tcc2']);
    includes(33, ['tns', 'tcc2'], ['tco2']);
    for (const [model, os, packageExt] of [[48, '84b2', '84pk2'], [49, '84tb2', '84tpk2'], [50, '83b2', '83pk2']]) {
        includes(model, ['8xp2', '8xpy2', '8mp2', '8ci2', '8ek2', os, packageExt], ['8xp', '8xu']);
    }
    for (const model of [0, 16, 37, 51, -1]) {
        assert.equal(module.ccall('get_file_extensions', 'string', ['number'], [model]), '');
    }
    console.log('Native file-picker extension checks passed');
}
checkSettingsChange().then(checkNative).then(() => {
    console.log('File-picker frontend checks passed');
    process.exit(0);
}).catch(error => { console.error(error); process.exit(1); });
