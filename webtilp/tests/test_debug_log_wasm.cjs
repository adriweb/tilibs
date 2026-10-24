'use strict';
const assert = require('node:assert/strict');
const createModule = require(require('node:path').resolve(process.argv[2]));
(async () => {
    const module = await createModule({print() {}, printErr() {}});
    await module.ccall('init', 'number', [], [], {async: true});
    const snapshot = () => module.ccall('get_debug_log_path', 'string', [], [], {async: true});
    assert.equal(await snapshot(), '');
    module.ccall('set_force_cable', null, ['number'], [1]);
    module.ccall('set_force_calc', null, ['number'], [1]);
    module.ccall('set_cable_model', null, ['number'], [0]); // Null cable: no device I/O.
    module.ccall('set_calc_model', null, ['number'], [3]);
    const handle = module.ccall('create_handle', 'number', [], []);
    assert.ok(handle);
    assert.equal(await module.ccall('open_cable', 'number', ['number'], [handle], {async: true}), 0);
    for (let count = 1; count <= 2; count++) {
        assert.equal(await module.ccall('send_probe', 'number', ['number'], [handle], {async: true}), 0);
        const path = await snapshot();
        assert.equal(path, '/home/web_user/.ticables/ticables-dbus.pkt');
        const text = module.FS.readFile(path, {encoding: 'utf8'});
        assert.equal((text.match(/PC>TI: RDY \(TI: RDC\)/g) || []).length, count);
    }
    assert.equal(await module.ccall('close_cable', 'number', ['number'], [handle], {async: true}), 0);
    assert.ok(await snapshot());
    console.log('Actual WASM DBUS logger snapshots include buffered bytes and continue logging without a close/reopen.');
    await module.ccall('cleanup', 'number', [], [], {async: true});
    assert.equal(await snapshot(), '/home/web_user/.ticables/ticables-dbus.pkt');
    await module.ccall('init', 'number', [], [], {async: true});
    module.ccall('set_force_cable', null, ['number'], [1]);
    module.ccall('set_force_calc', null, ['number'], [1]);
    module.ccall('set_cable_model', null, ['number'], [5]); // Direct USB, deliberately never opened.
    module.ccall('set_calc_model', null, ['number'], [13]); // TI-84 Plus USB.
    assert.ok(module.ccall('create_handle', 'number', [], []));
    // Exact on-disk logger format; no USB device or synthetic device I/O.
    const writeCapture = bytes => {
        let text = 'TiCables-2 data logger\nVersion test\n\n';
        bytes.forEach((byte, index) => {
            text += byte.toString(16).padStart(2, '0') + ' ';
            if ((index + 1) % 16 === 0) text += '| ABCD0123456789EF\n';
        });
        module.FS.writeFile('/home/web_user/.ticables/ticables-log.hex', text);
    };
    const dusbSnapshot = async bytes => {
        writeCapture(bytes);
        const path = await snapshot();
        assert.equal(path, '/home/web_user/.ticables/ticables-dusb.pkt');
        assert.equal(module.FS.readFile('/home/web_user/.ticables/debug-log-path', {encoding: 'utf8'}), path);
        return module.FS.readFile(path, {encoding: 'utf8'});
    };
    const allocation = [0, 0, 0, 4, 2, 0, 0, 4, 0];
    // Snapshot an incomplete raw header, then the full packet twice.
    await dusbSnapshot(allocation.slice(0, 3));
    const decoded = await dusbSnapshot(allocation);
    assert.match(decoded, /Buffer Size Allocation/);
    assert.match(decoded, /\[00000400\]/);
    assert.equal(await dusbSnapshot(allocation), decoded);
    // A complete virtual packet with a final partial hex line, then one
    // exactly filling a hex line. The last payload byte must survive EOF.
    const virtual = [0, 0, 0, 11, 4, 0, 0, 0, 5, 0, 1, 0x41, 0x42, 0x43, 0x44, 0x45];
    await dusbSnapshot(virtual.slice(0, 12));
    const full = await dusbSnapshot(virtual);
    assert.match(full, /CMD: Ping \/ Set Mode/);
    assert.match(full, /41 42 43 44 45/);
    assert.equal(await dusbSnapshot(virtual), full);
    // No newline and no trailing separator (e.g. an interrupted capture).
    module.FS.writeFile('/home/web_user/.ticables/ticables-log.hex',
        'TiCables-2 data logger\nVersion test\n\n' + virtual.map(b => b.toString(16).padStart(2, '0')).join(' '));
    assert.equal(module.FS.readFile(await snapshot(), {encoding: 'utf8'}), full);
    // Older logger sessions can leave a short first row. Never consume
    // hexadecimal-looking text in that row's ASCII column as packet bytes.
    const toHex = bytes => bytes.map(b => b.toString(16).padStart(2, '0')).join(' ');
    module.FS.writeFile('/home/web_user/.ticables/ticables-log.hex',
        'TiCables-2 data logger\nVersion test\n\n' + toHex(allocation) +
        ' | ABCD0123456789EF\n' + toHex(virtual));
    const combined = module.FS.readFile(await snapshot(), {encoding: 'utf8'});
    assert.match(combined, /Buffer Size Allocation/);
    assert.match(combined, /CMD: Ping \/ Set Mode/);
    assert.match(combined, /41 42 43 44 45/);
    // Cover both Z80/eZ80 and 68k DUSB models.
    for (const model of [13, 14, 18, 19, 20, 21, 22, 36]) {
        module.ccall('set_calc_model', null, ['number'], [model]);
        assert.equal(await snapshot(), '/home/web_user/.ticables/ticables-dusb.pkt');
    }
    // Other direct USB families must not return a stale DBUS/DUSB trace.
    module.ccall('set_calc_model', null, ['number'], [15]); // Nspire.
    assert.equal(await snapshot(), '/home/web_user/.ticables/ticables-log.hex');
    console.log('WASM DUSB snapshots: protocol selection, repeated/partial captures, full lines and final-byte preservation passed.');
    process.exit(0);
})().catch(error => {console.error(error); process.exit(1);});
