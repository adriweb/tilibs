'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../evo_webusb_serial.js'), 'utf8');

function setup(nav = {}) {
    const usb = new EventTarget();
    const context = vm.createContext({
        navigator: { usb, ...nav }, EventTarget, Event, DOMException,
        ReadableStream, WritableStream, Uint8Array, ArrayBuffer, DataView, URLSearchParams,
        console, setTimeout, clearTimeout
    });
    vm.runInContext(source, context);
    return { api: context.EvoWebUsbSerial, usb, context };
}

function mockDevice() {
    // Nonzero interface numbers and alternate settings ensure requests use the
    // descriptors rather than hard-coded endpoint/interface numbers.
    const control = { alternateSetting: 1, interfaceClass: 2, interfaceSubclass: 2, endpoints: [] };
    const data = { alternateSetting: 2, interfaceClass: 10, endpoints: [
        { type: 'bulk', direction: 'in', endpointNumber: 5, packetSize: 64 },
        { type: 'bulk', direction: 'out', endpointNumber: 6, packetSize: 64 }
    ] };
    const configuration = { configurationValue: 2, interfaces: [
        { interfaceNumber: 3, alternates: [control], alternate: { alternateSetting: 0 } },
        { interfaceNumber: 4, alternates: [data], alternate: { alternateSetting: 0 } }
    ] };
    const calls = [];
    const reads = [];
    const waiting = [];
    const device = {
        vendorId: 0x0451, productId: 0xe018, productName: 'TI-84 Evo mock',
        opened: false, configuration: null, configurations: [configuration],
        calls, reads, waiting, writeLimit: Infinity, output: [],
        async open() { calls.push('open'); this.opened = true; },
        async selectConfiguration(value) { assert.equal(value, 2); this.configuration = configuration; },
        async claimInterface(number) {
            calls.push(`claim ${number}`);
            if (this.claimError) throw this.claimError;
        },
        async selectAlternateInterface(number, alternate) {
            calls.push(`alternate ${number}:${alternate}`);
            configuration.interfaces.find(item => item.interfaceNumber === number).alternate = { alternateSetting: alternate };
        },
        async controlTransferOut(request, bytes) {
            calls.push({ request, bytes: [...bytes] });
            return { status: this.controlStatus || 'ok', bytesWritten: bytes.byteLength };
        },
        async transferIn(endpoint, length) {
            assert.equal(endpoint, 5);
            assert.equal(length % 64, 0);
            calls.push('read');
            if (reads.length) return reads.shift();
            return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
        },
        async transferOut(endpoint, bytes) {
            assert.equal(endpoint, 6);
            const count = Math.min(bytes.byteLength, this.writeLimit);
            this.output.push(...bytes.subarray(0, count));
            return { status: this.writeStatus || 'ok', bytesWritten: count };
        },
        async close() {
            calls.push('close');
            this.opened = false;
            for (const item of waiting.splice(0)) item.reject(new DOMException('USB closed', 'NetworkError'));
        },
        async forget() { calls.push('forget'); }
    };
    device.deliver = bytes => {
        const result = { status: 'ok', data: new DataView(Uint8Array.from(bytes).buffer) };
        if (waiting.length) waiting.shift().resolve(result);
        else reads.push(result);
    };
    return device;
}

async function within(promise) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('USB stream operation hung')), 1000);
        })]);
    } finally { clearTimeout(timer); }
}

async function testDetection() {
    const forced = setup({ serial: {}, userAgent: 'Linux desktop' });
    forced.context.location = { search: '?evoSerial=webusb' };
    vm.runInContext(source, forced.context);
    forced.context.location.search = ''; // app.js removes one-shot URL overrides.
    assert.equal(await forced.context.EvoWebUsbSerial.shouldUse(), true);
    forced.context.location.search = '?evoSerial=native';
    vm.runInContext(source, forced.context);
    assert.equal(await forced.context.EvoWebUsbSerial.shouldUse(), false);
    assert.equal(await setup().api.shouldUse(), true, 'USB fallback without native Serial');
    assert.equal(await setup({ usb: undefined }).api.shouldUse(), false);
    assert.equal(await setup({ serial: {}, userAgent: 'Linux desktop' }).api.shouldUse(), false);
    assert.equal(await setup({ serial: {}, userAgent: 'Android 16' }).api.shouldUse(), true);
    for (const version of [16, 17, 18]) {
        const nav = { serial: {}, userAgent: 'Mozilla/5.0 (Linux; Android 10; K)', userAgentData: {
            platform: 'Android', async getHighEntropyValues(keys) {
                assert.deepEqual([...keys], ['platformVersion']);
                return { platformVersion: `${version}.0.0` };
            }
        } };
        assert.equal(await setup(nav).api.shouldUse(), version < 17,
            'Client Hints override Chrome reduced Android 10 user agent');
    }
    for (const getHighEntropyValues of [async () => ({}), async () => { throw new Error('Unavailable'); }]) {
        assert.equal(await setup({ serial: {}, userAgent: 'Android 10', userAgentData: {
            platform: 'Android', getHighEntropyValues
        } }).api.shouldUse(), false, 'Unknown Android version retains native Serial');
    }
}

async function testStreams() {
    const { api } = setup();
    const device = mockDevice();
    const port = api.createPort(device);
    assert.equal(api.createPort(device), port, 'Reconnection reuses the port');
    assert.throws(() => api.createPort({ vendorId: 0x0483, productId: 0xa291 }), /only supports/);
    assert.equal(port.getInfo().usbProductId, 0xe018);
    await assert.rejects(port.open({ baudRate: 0 }), /Invalid/);
    await assert.rejects(port.open({ baudRate: 115200, flowControl: 'hardware' }), { name: 'NotSupportedError' });
    assert.equal(device.calls.length, 0, 'Reject invalid options before touching USB');
    await port.open({ baudRate: 115200 });
    await assert.rejects(port.open({ baudRate: 115200 }), { name: 'InvalidStateError' });
    const coding = device.calls.find(call => call.request?.request === 0x20);
    assert.deepEqual(coding.bytes, [0, 0xc2, 1, 0, 0, 0, 8], '115200 8N1 CDC wire bytes');
    assert.deepEqual({ ...coding.request }, { requestType: 'class', recipient: 'interface', request: 0x20, value: 0, index: 3 });
    assert.ok(device.calls.includes('alternate 3:1'));
    assert.ok(device.calls.includes('alternate 4:2'));
    await port.setSignals({ dataTerminalReady: false });
    assert.equal(device.calls.at(-1).request.value, 2, 'Partial signal updates preserve RTS');
    await port.setSignals({ break: true });
    assert.equal(device.calls.at(-1).request.request, 0x23);
    assert.equal(device.calls.at(-1).request.value, 0xffff);
    await assert.rejects(port.getSignals(), { name: 'NotSupportedError' });

    const reader = port.readable.getReader({ mode: 'byob' });
    await assert.rejects(port.close(), { name: 'InvalidStateError' });
    device.deliver([]); // USB zero-length packets must not strand a pending read.
    device.deliver([1, 2, 3, 4]);
    const first = await within(reader.read(new Uint8Array(2)));
    assert.deepEqual([...first.value], [1, 2]);
    assert.deepEqual([...(await within(reader.read(new Uint8Array(4)))).value], [3, 4]);
    const pending = reader.read(new Uint8Array(8));
    await Promise.resolve();
    await within(reader.cancel());
    assert.equal((await within(pending)).done, true, 'Cancel pending BYOB read immediately');
    reader.releaseLock();

    const writer = port.writable.getWriter();
    device.writeLimit = 2;
    await writer.write(new DataView(Uint8Array.from([9, 8, 7, 6, 5]).buffer, 1, 3));
    assert.deepEqual(device.output, [8, 7, 6], 'BufferSource offsets and partial writes preserve exact bytes');
    await writer.close();
    writer.releaseLock();
    await within(port.close());
    assert.equal(device.opened, false);
    assert.equal(port.readable, null);
    assert.equal(port.writable, null);
    await port.open({ baudRate: 9600, dataBits: 7, stopBits: 2, parity: 'even' });
    assert.deepEqual(device.calls.filter(call => call.request?.request === 0x20).at(-1).bytes,
        [0x80, 0x25, 0, 0, 2, 2, 7]);
    await port.close();
    await port.forget();
    assert.equal(device.calls.at(-1), 'forget');
}

async function testFailures() {
    for (const configure of [device => { device.claimError = new DOMException('Busy', 'NetworkError'); },
        device => { device.controlStatus = 'stall'; }, device => { device.configurations = []; }]) {
        const { api } = setup();
        const device = mockDevice();
        configure(device);
        const port = api.createPort(device);
        await assert.rejects(port.open({ baudRate: 115200 }));
        assert.ok(port.lastOpenError, 'Retain the browser USB failure for connection help');
        assert.equal(device.opened, false, 'Failed open releases the USB device');
        assert.equal(port.readable, null);
    }
    for (const configure of [device => { device.writeLimit = 0; }, device => { device.writeStatus = 'stall'; }]) {
        const { api } = setup();
        const device = mockDevice();
        const port = api.createPort(device);
        await port.open({ baudRate: 115200 });
        configure(device);
        const writer = port.writable.getWriter();
        await assert.rejects(writer.write(new Uint8Array([1])), { name: 'NetworkError' });
        writer.releaseLock();
        await port.close();
    }
    const { api, usb } = setup();
    const device = mockDevice();
    const port = api.createPort(device);
    await port.open({ baudRate: 115200 });
    const reader = port.readable.getReader();
    const read = reader.read();
    const disconnect = new Event('disconnect');
    disconnect.device = device;
    usb.dispatchEvent(disconnect);
    await assert.rejects(read, { name: 'NetworkError' });
    assert.equal(port.connected, false);
    reader.releaseLock();
    assert.equal(port.readable, null, 'Physical disconnect invalidates the streams');
    assert.equal(port.writable, null);
    await device.close(); // Simulate the browser closing the detached USB device.
    await port.open({ baudRate: 115200 });
    assert.equal(port.connected, true, 'A new connection can reopen the cached port');
    await within(port.close());
}

async function testBridge() {
    const { api, context } = setup();
    const device = mockDevice();
    const port = api.createPort(device);
    context.Module = { __ticablesWebSerial: { kind: 1, port } };
    context.HEAPU8 = new Uint8Array(64);
    const bridge = fs.readFileSync(require.resolve('../../libticables/trunk/src/webserial.cc'), 'utf8');
    for (const [name, parameters] of [
        ['open', 'kind, baud_rate, data_bits, stop_bits, require_signals, vid, pid'],
        ['read', 'kind, data, len, timeout_ms'], ['write', 'kind, data, len'], ['close', 'kind']
    ]) {
        const start = bridge.indexOf(`EM_ASYNC_JS(int, webserial_${name}_js,`);
        const body = bridge.slice(bridge.indexOf(' {', start) + 2, bridge.indexOf('\n});', start));
        vm.runInContext(`async function bridge_${name}(${parameters}) {${body}}`, context);
    }
    assert.equal(await context.bridge_open(1, 115200, 8, 1, 0, 0x0451, 0xe018), 0,
        'Real WASM bridge accepts bound CDC port without navigator.serial');
    device.deliver([0x01, 0x20, 0x21, 0x44]);
    assert.equal(await context.bridge_read(1, 0, 4, 500), 4);
    assert.deepEqual([...context.HEAPU8.subarray(0, 4)], [0x01, 0x20, 0x21, 0x44]);
    assert.equal(await context.bridge_write(1, 0, 4), 4);
    assert.deepEqual(device.output, [0x01, 0x20, 0x21, 0x44]);
    assert.equal(await within(context.bridge_close(1)), 0, 'Bridge closes while next USB read is pending');
    assert.equal(device.opened, false);
}

async function testCompiledWasm(path) {
    const { api, context } = setup();
    const device = mockDevice();
    context.navigator.usb.getDevices = async () => [];
    Object.defineProperty(globalThis, 'navigator', { value: context.navigator, configurable: true });
    const module = await require(require('node:path').resolve(path))();
    await module.ccall('init', 'number', [], [], { async: true });
    module._set_cable_model(5);
    module._set_force_cable(1);
    module._set_calc_model(48);
    module._set_force_calc(1);
    module.__ticablesWebSerial = { kind: 1, port: api.createPort(device) };
    const handle = await module.ccall('create_handle', 'number', [], [], { async: true });
    assert.ok(handle);
    assert.equal(await module.ccall('open_cable', 'number', ['number'], [handle], { async: true }), 0);
    assert.equal(device.opened, true);
    assert.equal(await module.ccall('close_cable', 'number', ['number'], [handle], { async: true }), 0);
    assert.equal(device.opened, false);
    console.log('Compiled WASM Evo cable open/close with no native Serial passed');
}

(async () => {
    const html = fs.readFileSync(require.resolve('../webtilp.html'), 'utf8');
    const sw = fs.readFileSync(require.resolve('../sw.js.in'), 'utf8');
    assert.ok(html.indexOf('src="evo_webusb_serial.js"') < html.indexOf('src="app.bundle.js"'),
        'Load the adapter before app initialization');
    assert.match(sw, /'evo_webusb_serial\.js'/, 'Adapter is included in offline and CI site assets');
    await testDetection();
    await testStreams();
    await testFailures();
    await testBridge();
    if (process.argv[2]) await testCompiledWasm(process.argv[2]);
    console.log('Evo WebUSB CDC detection, streams, lifecycle, errors and WASM bridge tests passed');
    if (process.argv[2]) process.exit(0); // Stop the Emscripten pthread pool.
})().catch(error => {
    console.error(error);
    if (process.argv[2]) process.exit(1);
    process.exitCode = 1;
});
