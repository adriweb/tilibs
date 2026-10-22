'use strict';

// Test the real Electron runtime, with all renderer HTTP(S) access blocked by
// main.cjs. A fresh profile proves no service-worker/browser cache is required.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');
const { smokeTransports } = require('./smoke-transports.cjs');

(async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webntilp-smoke-'));
  let application;
  try {
    const options = {
      args: [path.resolve(__dirname, '..'), `--user-data-dir=${profile}`],
      timeout: 60000,
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
    };
    // Also supports checking a packaged binary instead of the development app.
    if (process.env.WEBNTILP_EXECUTABLE) {
      options.executablePath = process.env.WEBNTILP_EXECUTABLE;
      options.args = [`--user-data-dir=${profile}`];
    }
    application = await electron.launch(options);
    const page = await application.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.waitForFunction(() => !document.body.classList.contains('initializing'));
    assert.equal(page.url(), 'webntilp://app/webtilp.html');
    assert.equal(await page.title(), "Web'nTILP");
    await page.locator('#btnSettings').click();
    await page.locator('#settingsModal:not(.hidden)').waitFor();
    await page.locator('#btnCloseSettings').click();
    await page.locator('#settingsModal.hidden').waitFor({ state: 'attached' });
    const result = await page.evaluate(async () => {
      // Use the public WASM factory: production minification renames the
      // frontend's internal initModule/converter helper functions.
      const module = await window.TILibsModule();
      await module.ccall('init', 'number', [], [], { async: true });
      module.FS.writeFile('/desktop-offline.txt', 'offline');
      const file = module.FS.readFile('/desktop-offline.txt', { encoding: 'utf8' });
      module.FS.unlink('/desktop-offline.txt');
      const tivars = await (await import(new URL('TIVarsLib.js', document.baseURI).href)).default();
      const luna = await (await import(new URL('WebLuna.js', document.baseURI).href)).default();
      return {
        secure: window.isSecureContext, isolated: window.crossOriginIsolated,
        sharedMemory: typeof SharedArrayBuffer,
        usb: typeof navigator.usb?.requestDevice,
        serial: typeof navigator.serial?.requestPort,
        hid: typeof navigator.hid?.requestDevice,
        node: typeof window.require,
        version: module.ccall('get_version', 'string', [], []),
        converters: Boolean(tivars.FS && luna.FS), file,
        // The custom protocol deliberately does not support service workers.
        serviceWorkers: await navigator.serviceWorker?.getRegistrations()
          .then(items => items.length).catch(() => 0) ?? 0
      };
    });
    assert.equal(result.secure, true);
    assert.equal(result.isolated, true);
    assert.equal(result.sharedMemory, 'function');
    for (const transport of ['usb', 'serial', 'hid']) assert.equal(result[transport], 'function', transport);
    assert.equal(result.node, 'undefined');
    assert.equal(result.converters, true);
    assert.equal(result.file, 'offline');
    assert.equal(result.serviceWorkers, 0);
    assert.match(result.version, /^\d+\.\d+/);
    // Language files and external-network blocking both go through the actual
    // app protocol/session, alongside WASM pthread and converter initialization.
    assert.equal(await page.evaluate(async () => (await fetch('i18n/fr.json')).ok), true);
    assert.equal(await page.evaluate(async () => (await fetch('runtime-licenses/LICENSE')).ok), true);
    assert.equal(await page.evaluate(async () => (await fetch('runtime-licenses/LICENSES.chromium.html')).ok), true);
    assert.deepEqual(errors, []);
    assert.deepEqual((await page.pageErrors()).map(error => error.message), []);
    assert.deepEqual((await page.consoleMessages()).filter(message => message.type() === 'error')
      .map(message => message.text()), []);
    await smokeTransports(application, page);
    assert.equal(await page.evaluate(async () => {
      try { await fetch('https://example.com'); return false; } catch { return true; }
    }), true);
    if (process.env.WEBNTILP_SCREENSHOT) {
      await page.screenshot({ path: process.env.WEBNTILP_SCREENSHOT, fullPage: true });
    }
    console.log(`PASS: Web'nTILP offline Chromium startup, Settings interaction, isolated WASM ${result.version}, USB/serial/HID APIs and converters`);
  } finally {
    await application?.close();
    await fs.rm(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
