'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { MessageChannel } = require('node:worker_threads');

async function testResponses() {
    const events = {};
    const entries = new Map();
    let offline = false;
    let cacheFails = false;
    let missingAsset = '';
    let skipWaitingCalls = 0;
    const requestOptions = new Map();
    const cache = {
        async match(request) { return entries.get(typeof request === 'string' ? request : request.url)?.clone(); },
        async put(request, response) {
            if (cacheFails) throw new Error('Quota exceeded');
            entries.set(typeof request === 'string' ? request : request.url, response.clone());
        }
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../sw.js.in'), 'utf8'), {
        self: {
            location: { origin: 'https://example.test', href: 'https://example.test/tilibs/sw.js' },
            addEventListener(type, fn) { events[type] = fn; },
            skipWaiting() { skipWaitingCalls++; }
        },
        caches: { async open() { return cache; } }, URL, Headers, Response,
        console: { warn() {} },
        async fetch(request, options) {
            if (offline) throw new Error('Offline');
            const url = typeof request === 'string' ? request : request.url;
            requestOptions.set(url, options);
            if (url.endsWith('/' + missingAsset)) return new Response(null, { status: 404 });
            return new Response('payload', { headers: { 'Content-Type': 'text/html' } });
        }
    });
    async function request(url = 'https://example.test/tilibs/webtilp.html', mode = 'navigate') {
        let response;
        events.fetch({ request: { url, method: 'GET', mode }, respondWith(promise) { response = promise; } });
        return response;
    }
    async function check(response, body) {
        assert.equal(response.headers.get('Cross-Origin-Opener-Policy'), 'same-origin');
        assert.equal(response.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp');
        assert.equal(await response.text(), body);
    }
    await check(await request(), 'payload');
    const wasmUrl = 'https://example.test/tilibs/webtilp.wasm?cache-bust=1';
    await check(await request(wasmUrl, 'same-origin'), 'payload');
    assert.equal(requestOptions.get(wasmUrl)?.cache, 'no-store');
    const loaderUrl = 'https://example.test/tilibs/webtilp.js';
    await check(await request(loaderUrl, 'same-origin'), 'payload');
    assert.equal(requestOptions.get(loaderUrl)?.cache, 'no-store');
    offline = true;
    await check(await request(), 'payload'); // Cached before headers were added.
    await check(await request(wasmUrl, 'same-origin'), 'payload');
    entries.set('webtilp.html', new Response('fallback'));
    await check(await request('https://example.test/tilibs/missing'), 'fallback');
    offline = false;
    cacheFails = true;
    await check(await request(), 'payload');
    assert.equal(await request('https://other.test/asset'), undefined);
    let reply;
    events.message({ data: { type: 'GET_ISOLATION_STATUS' }, ports: [{ postMessage(value) { reply = value; } }] });
    assert.equal(reply.type, 'ISOLATION_READY');
    assert.equal(reply.version, '__BUILD_ID__');

    cacheFails = false;
    function install() {
        let result;
        events.install({ waitUntil(promise) { result = promise; } });
        return result;
    }
    missingAsset = 'webtilp.wasm';
    await assert.rejects(install(), /webtilp\.wasm: HTTP 404/);
    assert.equal(skipWaitingCalls, 0);
    missingAsset = 'i18n/fr.json';
    await install();
    assert.equal(skipWaitingCalls, 1);
    assert.ok(entries.has('https://example.test/tilibs/webtilp.wasm'));
}

async function testStartup() {
    const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
    const setup = source.slice(source.indexOf('function waitForIsolationWorker('), source.indexOf('async function bootstrap()'));
    const originalUrl = 'https://example.test/tilibs/webtilp.html?backend=ti#settings';
    const location = { href: originalUrl, replace(url) { this.href = url; reloads++; } };
    let reloads = 0;
    let registrations = 0;
    let reply = true;
    let failRegistration = false;
    const events = new Map();
    const worker = { postMessage(message, ports) {
        if (reply) ports[0].postMessage({ type: 'ISOLATION_READY', version: 'test-build' });
        ports[0].close();
    } };
    const registration = { active: null, addEventListener() {} };
    const context = vm.createContext({
        window: {
            isSecureContext: true, crossOriginIsolated: false, location,
            history: { state: { test: true }, replaceState(state, title, url) {
                assert.equal(state, this.state);
                location.href = url;
            } }
        },
        navigator: { serviceWorker: {
            controller: worker, ready: Promise.resolve(),
            async register(url, options) {
                registrations++;
                assert.equal(url, 'sw.js');
                assert.equal(options.updateViaCache, 'none');
                if (failRegistration) throw new Error('Disabled');
                return registration;
            },
            addEventListener(type, fn) { events.set(type, fn); },
            removeEventListener(type) { events.delete(type); }
        } },
        URL, MessageChannel, setTimeout(fn, ms) { return setTimeout(fn, Math.min(ms, 1000)); }, clearTimeout,
        showOfflineBanner() {}, showOfflineUpdateBanner() {}, console: { warn() {} }
    });
    vm.runInContext(setup, context);
    assert.equal(await context.prepareServiceWorker(), true);
    assert.equal(reloads, 1);
    assert.equal(new URL(location.href).searchParams.get('__webtilp_isolation'), 'test-build');
    assert.equal(await context.prepareServiceWorker(), false); // Isolation still failed: no loop.
    assert.equal(reloads, 1);
    context.window.crossOriginIsolated = true;
    assert.equal(await context.prepareServiceWorker(), false);
    assert.equal(location.href, originalUrl); // Preserve existing query and fragment.
    assert.equal(registrations, 3); // Offline support also registers on header-equipped hosts.
    context.window.crossOriginIsolated = false;
    context.navigator.serviceWorker.controller = null;
    registration.active = worker; // Hard refresh bypassed an already active worker.
    assert.equal(await context.prepareServiceWorker(), true);
    assert.equal(reloads, 2);
    assert.equal(events.size, 0);
    assert.equal(await context.prepareServiceWorker(), false); // Still prevent reload loops.
    assert.equal(reloads, 2);
    context.window.crossOriginIsolated = true;
    assert.equal(await context.prepareServiceWorker(), false);
    context.window.crossOriginIsolated = false;
    registration.active = null;
    context.navigator.serviceWorker.controller = worker;
    reply = false;
    assert.equal(await context.prepareServiceWorker(), false); // Old/unresponsive worker.
    assert.equal(events.size, 0);
    reply = true;
    context.navigator.serviceWorker.controller = null;
    const upgrading = context.prepareServiceWorker();
    setTimeout(() => {
        context.navigator.serviceWorker.controller = worker;
        events.get('controllerchange')();
    }, 10);
    assert.equal(await upgrading, true);
    assert.equal(reloads, 3);
    failRegistration = true;
    assert.equal(await context.prepareServiceWorker(), false);
    assert.equal(reloads, 3);
}

(async () => {
    await testResponses();
    await testStartup();
    console.log('Service worker isolation and startup tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
