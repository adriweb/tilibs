'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..');
const applicationPath = path.join(root, 'app.js');
const applicationRequire = createRequire(applicationPath);
const frontendSource = fs.readFileSync(path.join(root, 'frontend.js'), 'utf8');
const factoryPaths = [...frontendSource.matchAll(/require\('([^']+)'\)/g)]
    .map(match => match[1]);
const factories = new Map();
const unreadableDependencies = new Proxy({}, {
    get(_target, name) {
        throw new Error(`Factories must defer dependency reads until called: ${String(name)}`);
    }
});
for (const file of factoryPaths) {
    const exports = applicationRequire(file);
    for (const factory of Object.values(exports)) {
        const methods = factory(unreadableDependencies);
        for (const name of Object.keys(methods)) {
            assert.ok(!factories.has(name), `${name} is provided by both ${factories.get(name)} and ${file}`);
            factories.set(name, file);
        }
    }
}

// Execute the actual application composition, while stopping bootstrap before it
// performs browser work. This records the provided names without reproducing its
// list of imports, constants, or mutable defaults in the test.
const provided = {};
const startupStubs = {
    initTheme() {},
    async prepareServiceWorker() { return true; },
    loadSettings() { return {}; },
    setStatus() {}
};
const context = new Proxy(provided, {
    get(target, name) {
        if (name === 'provide') return values => {
            for (const key of Object.keys(values)) {
                assert.ok(!Object.hasOwn(target, key), `Duplicate application dependency: ${key}`);
            }
            Object.assign(target, values);
        };
        return startupStubs[name] ?? target[name];
    }
});
const applicationSource = fs.readFileSync(applicationPath, 'utf8');
vm.runInNewContext(applicationSource, {
    require(file) {
        return file === './runtime/context.js'
            ? { createApplicationContext: () => context }
            : applicationRequire(file);
    },
    document: { getElementById() { return null; }, querySelector() { return null; }, addEventListener() {} },
    navigator: { usb: { addEventListener() {} } },
    self: { isSecureContext: true },
    console
}, { filename: applicationPath });

// Browser/host APIs are an explicit exception to application wiring. Some APIs,
// including DecompressionStream and EvoWebUsbSerial, may legitimately be absent
// and are checked by their callers; this test does not require their availability.
const platformNames = new Set([
    'Blob', 'DataTransfer', 'DataView', 'DecompressionStream', 'DOMException',
    'EvoWebUsbSerial', 'File', 'MessageChannel', 'Response', 'TextDecoder',
    'TextEncoder', 'TILibsModule', 'Uint8Array', 'Uint8ClampedArray', 'URL',
    'URLSearchParams', 'alert', 'caches', 'clearTimeout', 'confirm', 'console',
    'createImageBitmap', 'document', 'fetch', 'getComputedStyle', 'globalThis',
    'localStorage', 'navigator', 'prompt', 'requestAnimationFrame', 'self',
    'setTimeout', 'window'
]);
for (const file of factoryPaths) {
    const source = fs.readFileSync(path.resolve(root, file), 'utf8');
    assert.ok(!/\bdependencies\s*(?:\?\.)?\s*\[/.test(source),
        `${file}: computed dependency names need an explicit wiring check`);
    for (const match of source.matchAll(/\bdependencies(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)/g)) {
        const name = match[1];
        assert.ok(Object.hasOwn(provided, name) || platformNames.has(name),
            `${file}: missing application dependency ${name}`);
    }
}
console.log(`PASS: ${factoryPaths.length} frontend factories have complete, unique dependency wiring`);
