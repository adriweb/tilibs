'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const appSource = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const header = fs.readFileSync(path.join(__dirname, '../../libticonv/trunk/src/ticonv.h'), 'utf8');
const enumBody = header.match(/\{\s*(CALC_NONE\s*=\s*0,[\s\S]*?)\}\s*CalcModel;/)[1];
const models = {};
let nextValue = 0;
for (const declaration of enumBody.replace(/\/\/[^\n]*/g, '').split(',')) {
    const match = declaration.trim().match(/^(CALC_\w+)(?:\s*=\s*(\d+))?$/);
    assert.ok(match, `valid CalcModel declaration: ${declaration}`);
    models[match[1]] = match[2] === undefined ? nextValue : Number(match[2]);
    nextValue = models[match[1]] + 1;
}

function extractFunction(name) {
    let start = appSource.indexOf(`async function ${name}(`);
    if (start < 0) start = appSource.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `function ${name} exists`);
    const bodyStart = appSource.indexOf(') {', start) + 2;
    let depth = 0;
    for (let index = bodyStart; index < appSource.length; index++) {
        if (appSource[index] === '{') depth++;
        if (appSource[index] === '}') depth--;
        if (!depth) return appSource.slice(start, index + 1);
    }
    throw new Error(`unterminated function ${name}`);
}

let stored = null;
const context = {
    console,
    CABLE_DIRECTLINK: '6', CABLE_SILVERLINK: '5', CABLE_GRAYLINK: '1',
    state: {},
    localStorage: {
        getItem(key) { assert.equal(key, 'webtilp.settings'); return stored; },
        setItem(key, value) { assert.equal(key, 'webtilp.settings'); stored = value; }
    },
    normalizeLanguageCode: value => value,
    navigator: { usb: {} },
    isSerialDevice: device => Boolean(device.serialPort),
    isGrayLinkSerialDevice: () => false,
    bindSerialPortToModule() {}, log() {}, updateDeviceModelDisplay() {},
    hasSilverlinkConnected: () => false,
    deviceMatches: (left, right) => left === right
};
vm.createContext(context);
vm.runInContext(appSource.slice(appSource.indexOf('const SETTINGS_DEFAULTS ='),
    appSource.indexOf('const TIVARS_LEGACY_PREVIEW_TYPES =')), context);
vm.runInContext('globalThis.config = { CALC_MODEL_OPTIONS, DIRECTLINK_CALC_VALUES, EVO_PYTHON_CALC_MODELS, TIVARS_PREVIEW_CALC_MODELS };', context);
for (const name of ['loadSettings', 'saveSettings', 'getEvoCalcModelForDevice',
    'applyWebUsbDeviceCableHint', 'authorizeDevice']) {
    vm.runInContext(extractFunction(name), context);
}

async function main() {
    const labels = {
        'TI Presenter': 'CALC_TIPRESENTER', CBL: 'CALC_CBL', CBR: 'CALC_CBR',
        CBL2: 'CALC_CBL2', CBR2: 'CALC_CBR2', LabPro: 'CALC_LABPRO',
        'TI-84 Evo': 'CALC_TI84EVO_USB', 'TI-84 Evo-T': 'CALC_TI84EVOT_USB', 'TI-83 Evo': 'CALC_TI83EVO_USB'
    };
    for (const [label, name] of Object.entries(labels)) {
        assert.equal(context.config.CALC_MODEL_OPTIONS.find(option => option.label === label)?.value,
            models[name], `${label} matches the native enum`);
    }
    const evoModels = ['CALC_TI84EVO_USB', 'CALC_TI84EVOT_USB', 'CALC_TI83EVO_USB'].map(name => models[name]);
    for (const model of evoModels) {
        assert.ok(context.config.DIRECTLINK_CALC_VALUES.has(model));
        assert.ok(context.config.TIVARS_PREVIEW_CALC_MODELS.has(model));
    }
    assert.deepEqual(Array.from(context.config.EVO_PYTHON_CALC_MODELS.keys()), evoModels);
    for (const model of [models.CALC_LABPRO_USB, models.CALC_EASYTEMP_GOTEMP_USB, models.CALC_EASYLINK_GOLINK_USB]) {
        assert.equal(context.config.TIVARS_PREVIEW_CALC_MODELS.has(model), false, 'USB lab devices are not Evo calculators');
    }
    for (const [productName, expected] of [
        ['TI-83/84 Evo', models.CALC_TI84EVO_USB],
        ['TI-84 Plus Evo', models.CALC_TI84EVO_USB],
        ['TI-84 Evo-T', models.CALC_TI84EVOT_USB],
        ['TI-83 Evo', models.CALC_TI83EVO_USB]
    ]) {
        assert.equal(context.getEvoCalcModelForDevice({ productName }), expected);
    }

    for (const [legacy, expected] of Object.entries({
        37: models.CALC_CBL, 38: models.CALC_CBR, 39: models.CALC_CBL2,
        40: models.CALC_CBR2, 41: models.CALC_LABPRO, 42: models.CALC_TIPRESENTER,
        43: models.CALC_TI84EVO_USB, 44: models.CALC_TI84EVOT_USB, 45: models.CALC_TI83EVO_USB,
        20: models.CALC_TI84PCE_USB, auto: 'auto'
    })) {
        stored = JSON.stringify({ calcModel: legacy, language: 'fr', cableTimeout: 75 });
        const loaded = context.loadSettings();
        assert.equal(loaded.calcModel, String(expected), `migrate old model ${legacy}`);
        assert.equal(loaded.language, 'fr');
        assert.equal(loaded.cableTimeout, 75);
        // The settings UI reconstructs state without the schema field before saving.
        context.state.settings = { calcModel: loaded.calcModel };
        context.saveSettings();
        assert.equal(context.loadSettings().calcModel, String(expected), 'saved models must not migrate twice');
    }
    const currentSchema = JSON.parse(stored).calcModelSchemaVersion;
    for (let model = models.CALC_TIPRESENTER; model < models.CALC_MAX; model++) {
        stored = JSON.stringify({ calcModel: String(model), calcModelSchemaVersion: currentSchema });
        assert.equal(context.loadSettings().calcModel, String(model), 'current model numbering is preserved');
    }
    stored = null;
    assert.equal(context.loadSettings().calcModel, 'auto');

    const usbEvo = { productName: 'TI-84 Plus Evo' };
    const serialEvo = { productName: usbEvo.productName, serialPort: {} };
    context.initModule = async () => ({});
    context.getAuthorizedDevices = async () => [{ productName: 'TI-84 Plus CE' }, usbEvo];
    context.isEvoUsbDevice = device => device === usbEvo;
    context.getAuthorizedEvoSerialDevice = async () => serialEvo;
    for (const model of evoModels) {
        context.state.settings = { calcModel: String(model), cableModel: 'auto' };
        assert.equal(await context.authorizeDevice(), serialEvo, 'manual Evo selection prefers the authorized Evo');
    }
    context.navigator.usb = undefined;
    for (const model of evoModels) {
        context.state.settings = { calcModel: String(model), cableModel: 'auto' };
        await context.applyWebUsbDeviceCableHint({
            _set_cable_model() {}, _set_force_cable() {},
            _set_calc_model() { assert.fail('an explicit Evo model must survive the serial cable hint'); }
        }, serialEvo);
    }
    console.log('Calculator model enum and settings migration tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
