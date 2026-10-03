'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const zlib = require('node:zlib');
const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const section = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
const source = [
    section('const CE_PYTHON_CALC_MODELS =', 'const PID_SILVERLINK ='),
    section('function getPythonConversionKind(', 'function getSelectedConversionModelId('),
    section('function validatePythonBytecode(', 'function isLegacyTivarsConversionCandidate('),
    section('async function buildTransferPlan(', 'async function buildTransferPlanFromFsEntries('),
    section('async function sendDroppedFiles(', 'function getDirlistFolders('),
    section('function formatTivarsException(', 'function unwrapReadablePreview(')
].join('\n');
// Project Builder's pinned compiler output for module.py: "value = 42\n".
// MicroPython 1.9.3 / 1.13 / 1.11, 31-bit integers; Evo/Nspire use lookup caching.
const fixtures = {
    ce: Buffer.from('4d03021f14010000000000073400f4000000ffaa24f000115b083c6d6f64756c653e096d6f64756c652e70790576616c75650000', 'hex'),
    evo: Buffer.from('4d05031f2034000a0007126d6f64756c652e707900aa1600a251630000', 'hex'),
    nspire: Buffer.from('4d04031f2050010000000000070700ff000000ffaa2400a2115b0007126d6f64756c652e70790000', 'hex')
};
const outputBytes = Uint8Array.of(1, 2, 3);
function memoryFS() {
    const files = new Map();
    return {files, analyzePath: name => ({exists: files.has(name)}), mkdir: name => files.set(name, null),
        writeFile: (name, data) => files.set(name, Uint8Array.from(data)),
        readFile(name) { assert.ok(files.has(name), name); return files.get(name); },
        unlink(name) { if (!files.delete(name)) throw new Error('missing file'); }
    };
}
async function run(model, inputs, {enabled = true, failure = '', realLibraries, dropped = false} = {}) {
    const module = {FS: memoryFS()};
    const lunaFS = memoryFS(), tivarsFS = memoryFS(), calls = [];
    let deleted = 0, metadataCalls = 0, droppedPlan;
    const context = vm.createContext({
        TextEncoder, Uint8Array, console,
        state: {settings: {convertScriptFiles: enabled}},
        getActiveCalcModelId: () => model,
        t: key => key, tFormat: (key, args) => `${key}: ${JSON.stringify(args)}`,
        getWebLuna: async () => realLibraries?.luna || {FS: lunaFS, callMain(args) {
            calls.push({kind: 'luna', args: Array.from(args), files: new Map(lunaFS.files)});
            assert.ok(!lunaFS.files.has(args.at(-1)), 'remove stale converter output');
            if (failure === 'throw') throw new Error('Luna failed');
            if (failure !== 'missing-output') lunaFS.writeFile(args.at(-1), outputBytes);
            return failure === 'nonzero' ? 1 : 0;
        }},
        getTivarsLib: async () => realLibraries?.tivars || {FS: tivarsFS,
            getExceptionMessage(error) {
                if (error.excPtr) return ['std::invalid_argument', 'Bytecode packaging failed'];
                throw new Error('Not a C++ exception');
            },
            TIVarFile: {createNew(type, name, target) {
            if (failure === 'cpp-create') throw {excPtr: 310440};
            const call = {kind: 'tivars', type, name, target}; calls.push(call);
            return {
                setContentFromString(content) {
                    call.content = JSON.parse(content);
                    if (failure === 'throw') throw new Error('pack failed');
                    if (failure === 'cpp-content') throw {excPtr: 310440};
                },
                convertToEvoPythonFormat: format => { call.format = format; },
                getRawContentHexStr: () => '00'.repeat(failure === 'too-large' ? 65519 : 32),
                setArchived: archived => { call.archived = archived; },
                saveVarToFile() { tivarsFS.writeFile('/converted', outputBytes); return '/converted'; },
                delete() { deleted++; }
            };
        }}},
        isLegacyTivarsConversionCandidate: () => false,
        isHPPrimeActive: () => false, isNumWorksActive: () => false, log() {},
        async ccallAsync(_module, name, _type, _types, args) {
            metadataCalls++;
            assert.equal(name, 'files_get_entries_json');
            return JSON.stringify({files: args[0].split('\n').map(p => ({path: p, name: path.basename(p)}))});
        },
        buildTransferPlanFromFsEntries: entries => entries,
        async processIncomingTransfers(files, options) {
            assert.equal(options.dropFolder, 'library');
            assert.equal(options.useModal, false);
            droppedPlan = await context.buildTransferPlan(files, module);
        }
    });
    vm.runInContext(source, context);
    for (const [name] of inputs) lunaFS.writeFile('/' + name.replace(/\.mpy$/i, '.tns'), outputBytes);
    const files = inputs.map(([name, bytes]) => ({name, arrayBuffer: async () => Uint8Array.from(bytes).buffer}));
    const plan = dropped ? (await context.sendDroppedFiles(files, 'library'), droppedPlan) : await context.buildTransferPlan(files, module);
    return {plan, module, lunaFS, tivarsFS, calls, deleted, metadataCalls};
}
// TNS XML uses TI encryption; ordinary .py/.mpy resources use ZIP deflate.
function tnsMembers(bytes) {
    const buffer = Buffer.from(bytes), members = new Map();
    let offset = buffer.indexOf(Buffer.from('504b0102', 'hex'));
    while (offset >= 0) {
        const nameLength = buffer.readUInt16LE(offset + 28);
        const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString();
        const method = buffer.readUInt16LE(offset + 10), length = buffer.readUInt32LE(offset + 20);
        const local = buffer.readUInt32LE(offset + 42);
        const begin = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
        members.set(name, method === 8 ? zlib.inflateRawSync(buffer.subarray(begin, begin + length)) : null);
        offset = buffer.indexOf(Buffer.from('504b0102', 'hex'), offset + 46 + nameLength
            + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32));
    }
    return members;
}
async function verifyWasm() {
    const create = async name => (await import(pathToFileURL(path.resolve(__dirname, '..', name)).href)).default({print() {}, printErr() {}});
    const realLibraries = {tivars: await create('TIVarsLib.js'), luna: await create('WebLuna.js')};
    for (const [model, target, extension] of [[19, 'ce', '8xv'], [48, 'evo', '8mp2']]) {
        for (const name of ['MiXeD', 'ti_image']) {
            const result = await run(model, [[`${name}.mpy`, fixtures[target]]], {realLibraries, dropped: true});
            const data = result.module.FS.readFile(`/uploads/${name.toUpperCase()}.${extension}`);
            const lib = realLibraries.tivars, input = '/verify.' + extension;
            lib.FS.writeFile(input, data);
            const variable = lib.TIVarFile.loadFromFile(input), options = new lib.options_t();
            try {
                options.set('metadata', 1);
                const decoded = JSON.parse(variable.getReadableContent(options));
                if (target === 'ce') {
                    assert.equal(data[69], 0x80, 'CE AppVar is archived');
                    assert.equal(decoded.typeName, 'PythonModuleAppVar');
                    assert.equal(decoded.filename, name);
                    assert.equal(decoded.compiledDataHex.toLowerCase(), fixtures.ce.toString('hex'));
                } else {
                    assert.equal(decoded.python.compiledModule, true);
                    assert.equal(decoded.python.name, name);
                    assert.equal(decoded.python.bodyHex.toLowerCase(), fixtures.evo.toString('hex'));
                    assert.equal(decoded.typeName, 'PythonModule');
                    assert.equal(decoded.type, 18, 'Evo archive-only PythonModule');
                    assert.equal(decoded.metaData.flags, 1);
                }
            } finally { options.delete(); variable.delete(); lib.FS.unlink(input); }
        }
    }
    for (const name of ['MiXeD.MPY', 'main.mpy', '7module.mpy']) {
        const result = await run(32, [[name, fixtures.nspire]], {realLibraries});
        const stem = name.replace(/\.mpy$/i, '');
        const members = tnsMembers(result.module.FS.readFile(`/uploads/${stem}.tns`));
        const launcher = stem === 'main' ? 'run.py' : 'main.py';
        assert.deepEqual([...members.keys()], ['Document.xml', 'Problem1.xml', launcher, `${stem}.mpy`]);
        assert.deepEqual(members.get(`${stem}.mpy`), fixtures.nspire);
        assert.equal(members.get(launcher).toString(), `__import__('${stem}')\n`);
    }
    console.log('Actual TIVarsLib/Luna bytecode round trips passed (archive flags, import names, exact MPY bytes, Nspire import page).');
}
async function main() {
    for (const [model, target, extension] of [[19, 'ce', '8xv'], [20, 'ce', '8xv'], [36, 'ce', '8xv'],
        [48, 'evo', '8mp2'], [49, 'evo', '8mp2'], [50, 'evo', '8mp2'], [32, 'nspire', 'tns'],
        [33, 'nspire', 'tns'], [34, 'nspire', 'tns'], [35, 'nspire', 'tns']]) {
        const result = await run(model, [['MiXeD.MpY', fixtures[target]]]);
        assert.equal(result.plan[0].path, `/uploads/${target === 'nspire' ? 'MiXeD' : 'MIXED'}.${extension}`);
        const call = result.calls[0];
        if (target === 'nspire') {
            assert.deepEqual(call.args, ['/main.py', '/MiXeD.mpy', '/MiXeD.tns']);
            assert.deepEqual(Buffer.from(call.files.get('/MiXeD.mpy')), fixtures.nspire);
            assert.equal(Buffer.from(call.files.get('/main.py')).toString(), "__import__('MiXeD')\n");
            assert.equal(result.lunaFS.files.size, 0);
        } else {
            assert.equal(call.archived, true);
            assert.equal(target === 'ce' ? call.content.filename : call.content.python.name, 'MiXeD');
            assert.equal(target === 'ce' ? call.content.compiledDataHex : call.content.python.bodyHex, fixtures[target].toString('hex'));
            assert.equal(call.format, target === 'evo' ? '8mp2' : undefined);
            assert.equal(result.deleted, 1);
            assert.equal(result.tivarsFS.files.size, 0);
        }
        const dropped = await run(model, [['demo.mpy', fixtures[target]]], {dropped: true});
        assert.equal(dropped.plan[0].path, `/uploads/${target === 'nspire' ? 'demo' : 'DEMO'}.${extension}`);
        await assert.rejects(run(model, [['demo.mpy', fixtures[target]]], {enabled: false}), /mpy_conversion_disabled/);
        for (const other of Object.keys(fixtures).filter(t => t !== target)) {
            await assert.rejects(run(model, [['demo.mpy', fixtures[other]]]), /mpy_incompatible/);
        }
    }
    for (const model of [0, 2, 13, 28]) await assert.rejects(run(model, [['demo.mpy', fixtures.ce]]), /mpy_unsupported_target/);
    for (const bytes of [[], [0x4d, 3, 2, 31], [0x50, 3, 2, 31, 0], [0x4d, 3, 3, 31, 0], [0x4d, 3, 2, 32, 0]]) {
        await assert.rejects(run(19, [['demo.mpy', bytes]]), /mpy_incompatible/);
    }
    for (const name of ['too_long_name.mpy', '7bad.mpy', 'bad-name.mpy']) {
        await assert.rejects(run(19, [[name, fixtures.ce]]), /mpy_invalid_name/);
    }
    await assert.rejects(run(32, [['bad-name.mpy', fixtures.nspire]]), /mpy_invalid_name/);
    await assert.rejects(run(19, [['demo.mpy', fixtures.ce]], {failure: 'too-large'}), /mpy_ce_too_large/);
    for (const [model, target] of [[19, 'ce'], [48, 'evo'], [32, 'nspire']]) {
        await assert.rejects(run(model, [['demo.mpy', fixtures[target]]], {failure: 'throw'}), /failed/);
    }
    for (const failure of ['cpp-create', 'cpp-content']) {
        await assert.rejects(run(48, [['ti_image.mpy', fixtures.evo]], {failure}),
            /ti_image\.mpy: std::invalid_argument: Bytecode packaging failed/);
    }
    for (const failure of ['nonzero', 'missing-output']) await assert.rejects(run(32, [['demo.mpy', fixtures.nspire]], {failure}));
    await assert.rejects(run(32, [['demo.mpy', fixtures.nspire], ['demo.tns', outputBytes]]), /source_conversion_name_conflict/);
    if (process.argv.includes('--wasm')) await verifyWasm();
    console.log('MPY packaging checks passed (targets, file selection/drop, bytecode compatibility, names, opt-out, errors).');
}
main().catch(error => {console.error(error); process.exitCode = 1;});
