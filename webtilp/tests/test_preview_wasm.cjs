'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const app = fs.readFileSync(path.resolve(__dirname, '../app.js'), 'utf8');
function extract(name) {
    const start = app.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
    assert.ok(start >= 0, name);
    const next = /\n(?:async )?function \w+\(/g;
    next.lastIndex = start + 1;
    const end = next.exec(app);
    return app.slice(start, end ? end.index : app.length);
}

// Build a checksummed TI-83+/84+ container independently of the converter so
// stale embedded token tables fail in the same path as received calculator data.
function programFile(name, type, bytes) {
    const raw = Buffer.alloc(bytes.length + 2);
    raw.writeUInt16LE(bytes.length);
    Buffer.from(bytes).copy(raw, 2);
    const entry = Buffer.alloc(17 + raw.length);
    entry.writeUInt16LE(13);
    entry.writeUInt16LE(raw.length, 2);
    entry[4] = type;
    entry.write(name, 5, 8, 'ascii');
    entry.writeUInt16LE(raw.length, 15);
    raw.copy(entry, 17);
    const header = Buffer.alloc(55);
    header.write('**TI83F*', 'ascii');
    header.set([0x1a, 0x0a, 0x00], 8);
    header.writeUInt16LE(entry.length, 53);
    const checksum = Buffer.alloc(2);
    checksum.writeUInt16LE(entry.reduce((sum, byte) => sum + byte, 0) & 0xffff);
    return Buffer.concat([header, entry, checksum]);
}

async function main() {
    const factory = (await import(pathToFileURL(path.resolve(__dirname, '../TIVarsLib.js')).href)).default;
    const tivars = await factory({ print() {}, printErr() {} });
    const files = new Map();
    const module = { FS: {
        analyzePath: name => ({ exists: files.has(name) }),
        mkdir: name => files.set(name, null),
        readFile: (name, options) => {
            assert.ok(files.has(name), name);
            return options?.encoding === 'utf8' ? files.get(name).toString('utf8') : files.get(name);
        },
        unlink: name => assert.ok(files.delete(name), name)
    } };
    const errors = [], previews = [];
    const context = vm.createContext({
        console, URL, Uint8Array,
        EVO_PYTHON_CALC_MODELS: new Map([[48, '84Evo']]),
        TIVARS_LEGACY_BASIC_PROGRAM_TYPES: new Set([5, 6]),
        TIVARS_EVO_BASIC_PROGRAM_TYPES: new Set([2]),
        TIVARS_LEGACY_BASIC_SYNTAX_TYPES: new Set([1, 2, 3, 5, 6, 11, 13]),
        TIVARS_EVO_BASIC_SYNTAX_TYPES: new Set([1, 2, 6, 7]),
        PROGRESS_IDLE_TIMEOUT_MS: 5000,
        canPreviewVariable: () => true,
        getHPPrimePreviewKind: () => '',
        getActiveCalcModelId: () => 20,
        authorizeDevice: async () => {},
        initModule: async () => module,
        ensureHandle: async () => 1,
        getTivarsLib: async () => tivars,
        ccallAsync: async () => 0,
        setButtonLoading() {}, log() {},
        logError: error => errors.push(error.message),
        openPreviewModal: (entry, readable) => previews.push({ entry, readable })
    });
    vm.runInContext('let previewSession = null; let previewRenderId = 0;\n' + [
        'disposePreviewSession', 'formatTivarsException', 'isTIBasicPreviewEntry',
        'usesTIBasicPreviewSyntax', 'unwrapReadablePreview', 'previewEntry'
    ].map(extract).join('\n'), context);
    context.closePreviewModal = () => vm.runInContext('disposePreviewSession()', context);

    for (const fixture of [
        { name: 'BASIC', type: 5, bytes: [0xde, 0x31, 0x3f] },
        { name: 'LOCKED', type: 6, bytes: [0xde, 0x31, 0x3f] },
        { name: 'ASMCE', type: 6, bytes: [0xef, 0x7b, 0x00, 0xc9], cpu: 'eZ80', shell: 'Asm84CEPrgm', variant: 'C' },
        { name: 'ICE', type: 6, bytes: [0xef, 0x7b, 0x7f, 0xc9], cpu: 'eZ80', shell: 'Asm84CEPrgm', variant: 'ICE' },
        { name: 'ASMCSE', type: 6, bytes: [0xef, 0x69, 0xc9], cpu: 'Z80', shell: 'CSE' },
        { name: 'ASMZ80', type: 6, bytes: [0xbb, 0x6d, 0xc9], cpu: 'Z80' }
    ]) {
        const received = `/previews/${fixture.name}.8xp`;
        files.set(received, programFile(fixture.name, fixture.type, fixture.bytes));
        files.set('/last_recv_path.txt', Buffer.from(received));
        await context.previewEntry({ name: fixture.name, type: fixture.type, typeName: 'Program', size: fixture.bytes.length }, {});
        assert.deepEqual(errors, [], `${fixture.name}: converter exceptions`);
        const session = vm.runInContext('previewSession', context);
        const preview = previews.at(-1);
        assert.equal(preview.entry.name, fixture.name);
        assert.equal(session.isTIBasic, !fixture.cpu, 'ASM must not expose BASIC conversion/reindent');
        const displayed = context.unwrapReadablePreview(preview.readable);
        if (fixture.cpu) {
            const metadata = JSON.parse(displayed.content);
            assert.equal(session.language, 'json');
            assert.equal(metadata.isAssembly, true);
            assert.equal(metadata.cpu, fixture.cpu);
            if (fixture.shell) assert.equal(metadata.shell, fixture.shell);
            if (fixture.variant) assert.equal(metadata.variant, fixture.variant);
            assert.equal(metadata.rawDataHex.toLowerCase(), Buffer.from(fixture.bytes).toString('hex'));
        } else {
            assert.equal(session.language, 'basic-z80');
            assert.equal(displayed.content.trim(), 'Disp 1');
        }
        assert.equal(files.has('/last_recv_path.txt'), false);
        context.closePreviewModal();
        assert.equal(files.has(received), false, 'received preview is cleaned up');
        assert.deepEqual(tivars.FS.readdir('/').filter(name => name.startsWith('preview-')), [], 'converter inputs are cleaned up');
    }
    console.log('PASS: real WASM previews for BASIC, protected BASIC, CE C/ICE, CSE, and Z80 ASM');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
