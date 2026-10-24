'use strict';
const assert = require('node:assert/strict');
const createModule = require(require('node:path').resolve(process.argv[2]));
const timeout = setTimeout(() => { console.error('Variable-name WASM test timed out'); process.exit(1); }, 30000);
(async () => {
    const module = await createModule({print() {}, printErr() {}});
    await module.ccall('init', 'number', [], [], {async: true});
    module.ccall('test_var_name_files', null, [], []);
    // AppVar headers are literal even when a leading lowercase byte coincides
    // with a built-in token, or the whole name looks like a picture/GDB/string.
    for (const model of [4, 5, 17, 13, 18, 19, 20, 21, 22, 36]) {
        module.ccall('test_var_name_setup', 'string',
            ['number', 'number', 'string', 'string'], [model, 0x15, '41', '']);
        module.ccall('test_var_name_capture', null, [], []);
        const handle = module.ccall('test_var_name_handle', 'number', [], []);
        for (const name of ['atmOS0', 'btmOS0', 'ctmOS0', 'AtmOS0', 'Pic1', 'GDB1', 'Str1', 'abcdefgh']) {
            const path = `/${name}.8xv`;
            const info = JSON.parse(module.ccall('file_get_entries_json', 'string', ['string'], [path]));
            assert.equal(info.entries[0].name, name, `model ${model}: ${path} preview`);
            const batch = JSON.parse(module.ccall('files_get_entries_json', 'string', ['string'], [path]));
            assert.deepEqual(batch.files[0].entries, info.entries);
            for (const [fn, types, args] of [
                ['send_file_custom', ['number', 'string', 'string', 'number', 'number'], [handle, path, '', 1, 0]],
                ['send_file_entry_custom', ['number', 'string', 'number', 'number', 'string', 'number', 'number'],
                    [handle, path, 0, 0, '', 1, 0]]
            ]) {
                assert.equal(await module.ccall(fn, 'number', types, args, {async: true}), 4);
                assert.equal(module.ccall('test_var_name_captured_hex', 'string', ['number'], [0]),
                    Buffer.from(name).toString('hex'), `model ${model}: ${fn} preserves ${name}`);
            }
        }
        module.ccall('test_var_name_teardown', null, [], []);
    }
    console.log('AppVar previews and both send paths preserve literal names across DBUS/USB models.');
    // File names use the reader's charset, regardless of the connected model.
    for (const model of [4, 13, 20]) {
        module.ccall('set_calc_model', null, ['number'], [model]);
        for (const [path, names] of [['/L1.8xl', ['L₁']], ['/lists.8xg', ['L₁', 'L₂']], ['/lists.tig', ['L₁']]]) {
            const info = JSON.parse(module.ccall('file_get_entries_json', 'string', ['string'], [path]));
            assert.deepEqual(info.entries.map(entry => entry.name), names, `model ${model}: ${path}`);
            const batch = JSON.parse(module.ccall('files_get_entries_json', 'string', ['string'], [path]));
            assert.deepEqual(batch.files[0].entries, info.entries);
        }
    }
    for (const model of [8, 14]) {
        module.ccall('set_calc_model', null, ['number'], [model]);
        const info = JSON.parse(module.ccall('file_get_entries_json', 'string', ['string'], ['/theta.89e']));
        assert.equal(info.entries[0].name, 'θ');
        assert.equal(info.entries[0].folder, 'α');
    }
    console.log('File metadata preserves tokenized Z80 and TI-89 names across DBUS/USB models, singles, groups and TIGroup.');
    for (const fixture of [
        {model: 3, type: 1, raw: '5d', display: 'L₁'},
        {model: 3, type: 1, raw: '5d01', display: 'L₂'},
        {model: 3, type: 2, raw: '5c', display: '[A]'},
        {model: 3, type: 3, raw: '5e10', display: 'Y₁'},
        {model: 7, type: 0, raw: '41', display: 'A'},
        {model: 7, type: 0, raw: 'c1', display: 'θ'}
    ]) {
        const jsonPath = module.ccall('test_var_name_setup', 'string',
            ['number', 'number', 'string', 'string'], [fixture.model, fixture.type, fixture.raw, '']);
        const entry = JSON.parse(module.FS.readFile(jsonPath, {encoding: 'utf8'}));
        assert.equal(entry.name, fixture.display);
        assert.equal(entry.name_hex, fixture.raw);
        const handle = module.ccall('test_var_name_handle', 'number', [], []);
        // The scripted cable times out after recording the actual REQ packet.
        await module.ccall('calc_recv_var', 'number',
            ['number', 'string', 'string', 'number', 'string', 'string', 'string'],
            [handle, entry.folder, entry.name, entry.type, '/', entry.folder_hex, entry.name_hex], {async: true});
        const sent = Buffer.from(module.ccall('test_var_name_sent_hex', 'string', [], []), 'hex');
        assert.equal(sent[1], 0xa2, 'REQ command');
        const raw = Buffer.from(fixture.raw, 'hex');
        const nameOffset = fixture.model === 7 ? 8 : 7;
        assert.equal(sent.subarray(nameOffset, nameOffset + raw.length).toString('hex'), fixture.raw,
            `${entry.name}: request must use the listed calculator bytes`);
        if (fixture.model !== 7) {
            assert.ok(sent.subarray(nameOffset + raw.length, nameOffset + 8).every(byte => byte === 0));
        }
        module.ccall('test_var_name_teardown', null, [], []);
        console.log(`${fixture.display}: exact DBUS name bytes ${fixture.raw}`);
    }
    // The real libticalcs dispatcher captures every request-building wrapper.
    // Include charsets whose display conversion cannot be inverted uniquely.
    for (const fixture of [
        {model: 3, type: 1, raw: '5d', folder: ''},
        {model: 4, type: 1, raw: '5d414243', folder: ''}, // named list ABC
        {model: 7, type: 0, raw: '0a', folder: ''}, // TI-86 alternate encoding of A
        {model: 7, type: 0, raw: 'c1', folder: ''},
        {model: 8, type: 0, raw: '88', folder: '80'}, // TI-89 theta in alpha folder
        {model: 13, type: 0, raw: 'ceb8', folder: ''},
        {model: 14, type: 0, raw: 'ceb8', folder: 'ceb1'},
        {model: 32, type: 0, raw: 'c3a9', folder: 'c3a92f737562'},
        {model: 48, type: 0, raw: 'ceb8', folder: ''}
    ]) {
        const jsonPath = module.ccall('test_var_name_setup', 'string',
            ['number', 'number', 'string', 'string'], [fixture.model, fixture.type, fixture.raw, fixture.folder]);
        const entry = JSON.parse(module.FS.readFile(jsonPath, {encoding: 'utf8'}));
        const handle = module.ccall('test_var_name_handle', 'number', [], []);
        module.ccall('test_var_name_capture', null, [], []);
        const captured = field => module.ccall('test_var_name_captured_hex', 'string', ['number'], [field]);
        for (const [name, types, args] of [
            ['calc_recv_var', ['number', 'string', 'string', 'number', 'string', 'string', 'string'],
                [handle, entry.folder, entry.name, entry.type, '/', entry.folder_hex, entry.name_hex]],
            ['calc_recv_app', ['number', 'string', 'number', 'string', 'string'],
                [handle, entry.name, entry.type, '/', entry.name_hex]],
            ['calc_del_var', ['number', 'string', 'string', 'number', 'string', 'string'],
                [handle, entry.folder, entry.name, entry.type, entry.folder_hex, entry.name_hex]],
            ['calc_change_attr', ['number', 'string', 'string', 'number', 'number', 'string', 'string'],
                [handle, entry.folder, entry.name, entry.type, 0, entry.folder_hex, entry.name_hex]],
            ['calc_rename_var', ['number', 'string', 'string', 'number', 'string', 'string', 'number', 'string', 'string'],
                [handle, entry.folder, entry.name, entry.type, entry.folder, 'NEW', entry.type, entry.folder_hex, entry.name_hex]]
        ]) {
            assert.equal(await module.ccall(name, 'number', types, args, {async: true}), 4, name);
            assert.equal(captured(0), fixture.raw, `${name}: preserve name bytes`);
            assert.equal(captured(1), name === 'calc_recv_app' ? '' : fixture.folder, `${name}: preserve folder bytes`);
            if (name === 'calc_rename_var') {
                assert.equal(captured(2), fixture.model === 4 ? '5d4e4557' : '4e4557');
                assert.equal(captured(3), fixture.folder);
            }
        }
        // Moving an item preserves its raw name, including noncanonical aliases.
        assert.equal(await module.ccall('calc_rename_var', 'number',
            ['number', 'string', 'string', 'number', 'string', 'string', 'number', 'string', 'string'],
            [handle, entry.folder, entry.name, entry.type, 'new', entry.name, entry.type, entry.folder_hex, entry.name_hex], {async: true}), 4);
        assert.equal(captured(2), fixture.raw);
        assert.equal(captured(3), '6e6577');
        if (fixture.folder) {
            assert.equal(await module.ccall('calc_del_folder', 'number', ['number', 'string', 'string'],
                [handle, entry.folder, entry.folder_hex], {async: true}), 4);
            assert.equal(captured(1), fixture.folder);
        }
        if (fixture.model === 8 || fixture.model === 14) {
            const theta = fixture.model === 8 ? '88' : 'ceb8';
            const alpha = fixture.model === 8 ? '80' : 'ceb1';
            assert.equal(await module.ccall('calc_rename_var', 'number',
                ['number', 'string', 'string', 'number', 'string', 'string', 'number', 'string', 'string'],
                [handle, entry.folder, entry.name, entry.type, entry.folder, 'θ', entry.type, entry.folder_hex, entry.name_hex], {async: true}), 4);
            assert.equal(captured(2), theta, 'new text uses the target charset');
            assert.equal(captured(3), fixture.folder, 'renaming retains the folder identifier');
            assert.equal(await module.ccall('calc_new_folder', 'number', ['number', 'string'], [handle, 'α'], {async: true}), 4);
            assert.equal(captured(1), alpha);
            if (fixture.model === 8) {
                const before = module.ccall('test_var_name_calls', 'number', [], []);
                for (const text of ['😀', 'A'.repeat(1024)]) {
                    assert.equal(await module.ccall('calc_new_folder', 'number', ['number', 'string'], [handle, text], {async: true}), -1001);
                }
                assert.equal(module.ccall('test_var_name_calls', 'number', [], []), before);
            }
        }
        // Malformed raw identifiers fail before any variable operation.
        const before = module.ccall('test_var_name_calls', 'number', [], []);
        for (const hex of ['5', 'xx', '410042', '41'.repeat(1024), '']) {
            assert.equal(await module.ccall('calc_del_var', 'number',
                ['number', 'string', 'string', 'number', 'string', 'string'],
                [handle, entry.folder, entry.name, entry.type, entry.folder_hex, hex], {async: true}), -1001, `invalid hex ${hex.slice(0, 16)}`);
        }
        assert.equal(module.ccall('test_var_name_calls', 'number', [], []), before);
        module.ccall('test_var_name_teardown', null, [], []);
        console.log(`Model ${fixture.model}: receive/app/delete/attributes/rename/move preserve ${fixture.folder}/${fixture.raw}`);
    }
    // Use the production folder callback: the old no-op returned success and
    // sent nothing, even though the frontend and bridge supplied the name.
    for (const model of [8, 9, 10, 11, 12]) {
        for (const raw of ['617364617364', '80']) {
            module.ccall('test_var_name_setup', 'string',
                ['number', 'number', 'string', 'string'], [model, 0, '41', '']);
            module.ccall('test_var_name_real_folder_delete', null, [], []);
            const handle = module.ccall('test_var_name_handle', 'number', [], []);
            assert.equal(await module.ccall('calc_del_folder', 'number',
                ['number', 'string', 'string'], [handle, 'display', raw], {async: true}), 4);
            const sent = Buffer.from(module.ccall('test_var_name_sent_hex', 'string', [], []), 'hex');
            if (model === 10) {
                // The original TI-92 starts its remote-key sequence with ON.
                // This fixture times out at the first read, so no later keys follow.
                assert.deepEqual(sent, Buffer.from([9, 0x87, 0x0b, 1]));
                module.ccall('test_var_name_teardown', null, [], []);
                continue;
            }
            const folder = Buffer.from(raw, 'hex');
            const payload = Buffer.concat([Buffer.from([0, 0, 0, 0, 0x1f, folder.length]), folder]);
            const sum = payload.reduce((total, byte) => total + byte, 0);
            const expected = Buffer.concat([Buffer.from([8, 0x88, payload.length, 0]),
                payload, Buffer.from([sum & 255, sum >> 8])]);
            assert.deepEqual(sent, expected, `model ${model}: folder DEL must reach the cable`);
            module.ccall('test_var_name_teardown', null, [], []);
        }
    }
    console.log('68k folder deletion uses type 0x1f or original TI-92 remote keys.');
    clearTimeout(timeout);
    process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
