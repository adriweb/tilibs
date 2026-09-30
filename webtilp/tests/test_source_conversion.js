'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');

function section(start, end) {
    const first = app.indexOf(start);
    const last = app.indexOf(end, first);
    assert.ok(first >= 0 && last > first, `source section ${start} exists`);
    return app.slice(first, last);
}

const source = [
    section('const CE_PYTHON_CALC_MODELS =', 'const PID_SILVERLINK ='),
    section('function getPythonConversionKind(', 'function getSelectedConversionModelId('),
    section('function sanitizePythonVarName(', 'async function extractBundleFiles(')
].join('\n');
const sourceBytes = new TextEncoder().encode('print("source")\n');
const convertedBytes = Uint8Array.of(0x54, 0x4e, 0x53, 0x01);

function memoryFs() {
    const files = new Map();
    const dirs = new Set();
    return {
        files,
        analyzePath: path => ({exists: dirs.has(path) || files.has(path)}),
        mkdir: path => dirs.add(path),
        writeFile: (path, data) => files.set(path, Uint8Array.from(data)),
        readFile(path) {
            assert.ok(files.has(path), `file ${path} exists`);
            return files.get(path);
        },
        stat(path) { return {size: this.readFile(path).length}; },
        unlink(path) {
            if (!files.delete(path)) throw new Error(`missing file: ${path}`);
        }
    };
}

async function run(model, names, settings = {}, failure = '') {
    const module = {FS: memoryFs()};
    const lunaFS = memoryFs();
    const tivarsFS = memoryFs();
    const calls = [];
    const warnings = [];
    let deletedVariables = 0;
    const context = vm.createContext({
        TextDecoder, Uint8Array,
        state: {settings},
        console: {warn: (...args) => warnings.push(args)},
        tFormat: (key, values) => `${key}:${values.name}`,
        getActiveCalcModelId: () => model,
        getWebLuna: async () => ({
            FS: lunaFS,
            callMain(args) {
                const [input, output] = args;
                calls.push({kind: 'luna', input, output});
                assert.deepEqual(lunaFS.readFile(input), sourceBytes);
                assert.ok(!lunaFS.files.has(output), 'stale output is removed before Luna runs');
                if (failure === 'throw') throw new Error('Luna runtime failed');
                if (failure === 'missing-output') return 0;
                lunaFS.writeFile(output, convertedBytes);
                return failure === 'nonzero' ? 1 : 0;
            }
        }),
        getTivarsLib: async () => ({
            FS: tivarsFS,
            TIVarFile: {
                createNew(type, name, target) {
                    const call = {kind: 'tivars', type, name, target};
                    calls.push(call);
                    return {
                        setContentFromString: content => { call.content = content; },
                        saveVarToFile() {
                            tivarsFS.writeFile('/converted', convertedBytes);
                            return '/converted';
                        },
                        delete: () => deletedVariables++
                    };
                }
            }
        }),
        async ccallAsync(_module, name, _type, _types, args) {
            assert.equal(name, 'files_get_entries_json');
            return JSON.stringify({files: args[0].split('\n').map(path => ({
                path, name: path.split('/').pop(), class: 'single', entries: []
            }))});
        }
    });
    vm.runInContext(source, context);
    // Exercise removal of a leftover converter file as well as final cleanup.
    for (const name of names) {
        lunaFS.writeFile(`/${name.replace(/\.[^.]*$/, '')}.tns`, Uint8Array.of(0xff));
    }
    const files = names.map(name => ({name, arrayBuffer: async () => sourceBytes.buffer}));
    const plan = await context.buildTransferPlan(files, module);
    return {plan, module, lunaFS, tivarsFS, calls, warnings, deletedVariables};
}

function assertPaths(result, paths) {
    assert.deepEqual(Array.from(result.plan, item => item.path), paths);
    for (const item of result.plan) {
        assert.equal(item.file.size, result.module.FS.readFile(item.path).length);
    }
}

function testSettings() {
    const settingsSource = [
        section('const SETTINGS_DEFAULTS =', 'const CABLE_OPTIONS ='),
        section('function loadSettings(', 'function normalizeOptionValue(')
    ].join('\n');
    for (const [stored, expected] of [
        [null, true],
        [{}, true],
        [{convertPythonFiles: false}, false],
        [{convertLuaFiles: false}, false],
        [{convertPythonFiles: true, convertLuaFiles: true}, true],
        [{convertScriptFiles: false}, false],
        [{convertScriptFiles: true, convertPythonFiles: false, convertLuaFiles: false}, true],
        [{convertScriptFiles: false, convertPythonFiles: true, convertLuaFiles: true}, false]
    ]) {
        const context = vm.createContext({
            localStorage: {getItem: () => stored === null ? null : JSON.stringify(stored)},
            normalizeLanguageCode: value => value,
            console
        });
        vm.runInContext(settingsSource, context);
        const loaded = context.loadSettings();
        assert.equal(loaded.convertScriptFiles, expected);
        assert.ok(!Object.hasOwn(loaded, 'convertPythonFiles'));
        assert.ok(!Object.hasOwn(loaded, 'convertLuaFiles'));
    }
}

async function testReceiveSetting() {
    const receiveSource = section('async function convertReceivedPythonFile(', 'async function downloadLastReceived(');
    for (const [model, filename] of [[19, 'python.8xv'], [48, 'python.8xpy2']]) {
        for (const enabled of [false, true]) {
            let converterCalls = 0;
            const context = vm.createContext({
                state: {settings: {convertScriptFiles: enabled}},
                getActiveCalcModelId: () => model,
                async getTivarsLib() {
                    converterCalls++;
                    throw new Error('converter unavailable');
                }
            });
            vm.runInContext(source + '\n' + receiveSource, context);
            assert.equal(await context.convertReceivedPythonFile(filename, sourceBytes), null);
            assert.equal(converterCalls, enabled ? 1 : 0,
                'the shared setting gates received Python conversion before loading the converter');
        }
    }
}

async function main() {
    testSettings();
    await testReceiveSetting();
    for (const model of [15, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35]) {
        const result = await run(model, ['demo.LuA']);
        assertPaths(result, ['/uploads/demo.tns']);
        assert.equal(result.calls[0].kind, 'luna');
        assert.deepEqual(result.module.FS.readFile('/uploads/demo.tns'), convertedBytes);
        assert.ok(!result.module.FS.files.has('/uploads/demo.LuA'));
        assert.equal(result.lunaFS.files.size, 0);
    }
    for (const model of [0, 2, 19, 20, 36, 48, 49, 50]) {
        const result = await run(model, ['demo.lua']);
        assertPaths(result, ['/uploads/demo.lua']);
        assert.equal(result.calls.length, 0);
    }
    const alreadyConverted = await run(32, ['document.tns']);
    assertPaths(alreadyConverted, ['/uploads/document.tns']);
    assert.equal(alreadyConverted.calls.length, 0);
    assert.deepEqual(alreadyConverted.module.FS.readFile('/uploads/document.tns'), sourceBytes);
    for (const model of [19, 28, 32, 48]) {
        const disabled = await run(model, ['lua.lua', 'python.py', 'document.tns'], {convertScriptFiles: false});
        assertPaths(disabled, ['/uploads/lua.lua', '/uploads/python.py', '/uploads/document.tns']);
        assert.equal(disabled.calls.length, 0);
    }
    for (const names of [
        ['demo.lua', 'demo.tns'], ['demo.tns', 'demo.lua'],
        ['demo.lua', 'demo.py'], ['demo.py', 'demo.lua'],
        ['DEMO.LUA', 'demo.TNS'], ['demo.TNS', 'DEMO.LUA'],
        ['demo.LuA', 'DEMO.PY'], ['DEMO.PY', 'demo.LuA']
    ]) {
        await assert.rejects(run(32, names), /source_conversion_name_conflict:demo\.tns/i,
            `conflicting output names abort the batch: ${names.join(', ')}`);
    }
    const mixed = await run(32, ['demo.lua', 'different.py', 'native.tns'], {convertScriptFiles: true});
    assertPaths(mixed, ['/uploads/demo.tns', '/uploads/different.tns', '/uploads/native.tns']);
    assert.equal(mixed.calls.length, 2);

    for (const model of [15, 23, 24, 25, 26, 27, 28, 29, 30, 31]) {
        const result = await run(model, ['python.py']);
        assertPaths(result, ['/uploads/python.py']);
        assert.equal(result.calls.length, 0, 'Python remains unsupported on older Nspire models');
    }
    for (const model of [32, 33, 34, 35]) {
        const result = await run(model, ['python.PY']);
        assertPaths(result, ['/uploads/python.tns']);
        assert.equal(result.calls[0].kind, 'luna');
        assert.equal(result.lunaFS.files.size, 0);
    }
    for (const [model, target, extension] of [
        [19, '83PCEEP', '8xv'], [20, '84+CEPy', '8xv'], [36, '82AEP', '8xv'],
        [48, '84Evo', '8xpy2'], [49, '84Evo', '8xpy2'], [50, '84Evo', '8xpy2']
    ]) {
        const result = await run(model, ['python.py']);
        assertPaths(result, [`/uploads/PYTHON.${extension}`]);
        assert.equal(result.calls[0].target, target);
        const code = new TextDecoder().decode(sourceBytes);
        if (extension === '8xpy2') assert.equal(result.calls[0].content, code);
        else assert.equal(JSON.parse(result.calls[0].content).code, code);
        assert.equal(result.deletedVariables, 1);
        assert.equal(result.tivarsFS.files.size, 0);
    }
    for (const failure of ['nonzero', 'throw', 'missing-output']) {
        const result = await run(28, ['failed.lua'], {}, failure);
        assertPaths(result, ['/uploads/failed.lua']);
        assert.deepEqual(result.module.FS.readFile('/uploads/failed.lua'), sourceBytes);
        assert.ok(!result.module.FS.files.has('/uploads/failed.tns'));
        assert.equal(result.lunaFS.files.size, 0, 'Luna failure cleans input and partial output');
        assert.equal(result.warnings.length, 1);
    }
    console.log('Source conversion passed (Nspire Lua, shared setting and migration, Python send/receive routes, filename conflicts, Luna cleanup and fallback).');
}

main().catch(error => {console.error(error); process.exitCode = 1;});
