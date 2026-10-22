'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { stageAssets, precacheAssets, BRANDING_SCRIPT } = require('../scripts/stage-assets.cjs');

const webtilp = path.resolve(__dirname, '../..');
const worker = fs.readFileSync(path.join(webtilp, 'sw.js.in'), 'utf8').replace('__BUILD_ID__', 'fixture-build');
const precache = precacheAssets(worker);
const html = fs.readFileSync(path.join(webtilp, 'webtilp.html'), 'utf8');

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'webntilp-assets-test-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const sourceDir = path.join(temporary, 'source');
  const outputDir = path.join(temporary, 'output');
  for (const name of [...precache, 'sw.js', 'i18n/fa.json']) {
    const filename = path.join(sourceDir, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    let contents = name.endsWith('.wasm') ? Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]) : 'fixture asset\n';
    if (name.endsWith('.json')) contents = JSON.stringify({ welcome_title: 'Bienvenue dans WebTILP !', settings: 'Paramètres' });
    if (name === 'webtilp.html') contents = html;
    if (name === 'sw.js') contents = worker;
    if (name === 'site.webmanifest') contents = fs.readFileSync(path.join(webtilp, name));
    fs.writeFileSync(filename, contents);
  }
  fs.cpSync(path.join(webtilp, 'third_party'), path.join(sourceDir, 'third_party'), { recursive: true });
  return { sourceDir, outputDir };
}

test('packages the complete offline shell, converters, locales and local licenses', t => {
  const options = fixture(t);
  fs.writeFileSync(path.join(options.sourceDir, 'pricing.html'), 'private unrelated file');
  fs.mkdirSync(path.join(options.sourceDir, 'tests'));
  fs.writeFileSync(path.join(options.sourceDir, 'tests/private.txt'), 'private test fixture');
  fs.writeFileSync(path.join(options.sourceDir, 'app.js'), 'unbundled source');
  fs.writeFileSync(path.join(options.sourceDir, 'webtilp.worker.js'), 'worker fixture');
  const result = stageAssets(options);
  for (const name of precache) assert.ok(fs.statSync(path.join(result.outputDir, name)).isFile(), name);
  for (const name of ['TIVarsLib.wasm', 'WebLuna.wasm', 'webtilp.wasm', 'webtilp.worker.js', 'i18n/fa.json', 'licenses.html', 'licenses/libticalcs-COPYING.txt', 'licenses/Luna-LICENSE.txt', 'licenses/wasm-sources.lock', 'third_party/upsilon-js/LICENSE']) {
    assert.ok(result.assets.includes(name), name);
  }
  for (const name of ['pricing.html', 'tests', 'app.js', 'webtilp.cpp']) assert.ok(!fs.existsSync(path.join(result.outputDir, name)), name);
  const stagedHtml = fs.readFileSync(path.join(result.outputDir, 'webtilp.html'), 'utf8');
  for (const [, name] of stagedHtml.matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (/^(https?:|#|data:)/.test(name)) continue;
    assert.ok(fs.existsSync(path.join(result.outputDir, name)), `Missing HTML resource ${name}`);
  }
});

test('desktop branding preserves website files, library API names, attribution and translated copy', t => {
  const options = fixture(t);
  const originalHtml = fs.readFileSync(path.join(options.sourceDir, 'webtilp.html'), 'utf8');
  const originalLocale = fs.readFileSync(path.join(options.sourceDir, 'i18n/fr.json'), 'utf8');
  const javascript = 'globalThis.WebTILPNumWorks = { initialized: true };';
  fs.writeFileSync(path.join(options.sourceDir, 'app.bundle.js'), javascript);
  stageAssets(options);
  const stagedHtml = fs.readFileSync(path.join(options.outputDir, 'webtilp.html'), 'utf8');
  assert.match(stagedHtml, /<title>Web'nTILP<\/title>/);
  assert.match(stagedHtml, /class="brand-title">Web'nTILP<\/div>/);
  assert.match(stagedHtml, /WebTILP made by/);
  assert.match(stagedHtml, /<script src="desktop-branding.js"><\/script>\s*<script src="app.bundle.js">/);
  assert.equal(fs.readFileSync(path.join(options.outputDir, 'app.bundle.js'), 'utf8'), javascript);
  assert.equal(fs.readFileSync(path.join(options.sourceDir, 'webtilp.html'), 'utf8'), originalHtml);
  assert.equal(fs.readFileSync(path.join(options.sourceDir, 'i18n/fr.json'), 'utf8'), originalLocale);
  const locale = JSON.parse(fs.readFileSync(path.join(options.outputDir, 'i18n/fr.json'), 'utf8'));
  assert.equal(locale.welcome_title, "Bienvenue dans Web'nTILP !");
  assert.equal(locale.settings, 'Paramètres');
  assert.equal(JSON.parse(fs.readFileSync(path.join(options.outputDir, 'site.webmanifest'), 'utf8')).name, "Web'nTILP");
});

test('missing generated converters fail before replacing an existing successful output', t => {
  const options = fixture(t);
  fs.mkdirSync(options.outputDir);
  fs.writeFileSync(path.join(options.outputDir, 'previous-build'), 'preserve me');
  fs.rmSync(path.join(options.sourceDir, 'WebLuna.wasm'));
  assert.throws(() => stageAssets(options), /Missing built WebTILP assets or licenses: WebLuna\.wasm/);
  assert.equal(fs.readFileSync(path.join(options.outputDir, 'previous-build'), 'utf8'), 'preserve me');
});

test('rejects invalid WASM and unsafe source/output paths', t => {
  const options = fixture(t);
  fs.writeFileSync(path.join(options.sourceDir, 'TIVarsLib.wasm'), 'not a WASM module');
  assert.throws(() => stageAssets(options), /Invalid WebAssembly asset: TIVarsLib\.wasm/);
  assert.throws(() => stageAssets({ ...options, outputDir: options.sourceDir }), /must not replace or contain/);
  assert.throws(() => stageAssets({ ...options, outputDir: path.dirname(options.sourceDir) }), /must not replace or contain/);
  assert.throws(() => precacheAssets("const PRECACHE_URLS = ['../private.txt'];"), /Unsafe desktop asset path/);
  assert.throws(() => precacheAssets("const PRECACHE_URLS = [getSecret()];"), /only literal relative asset paths/);
});

test('English fallback branding follows translations without modifying transport API globals', () => {
  const title = { textContent: 'Welcome to WebTILP!' };
  const subtitle = { textContent: 'Universal linking, right from your browser!' };
  let observer;
  const scope = {
    document: {
      body: {},
      querySelectorAll: () => [title],
      getElementById: () => subtitle
    },
    MutationObserver: class {
      constructor(callback) { observer = callback; }
      observe() {}
    },
    WebTILPNumWorks: { initialized: true }
  };
  vm.runInNewContext(BRANDING_SCRIPT, scope);
  assert.equal(title.textContent, "Welcome to Web'nTILP!");
  assert.equal(subtitle.textContent, 'Universal linking, offline on your desktop!');
  title.textContent = 'Bienvenue dans WebTILP !';
  subtitle.textContent = 'Transferts universels';
  observer();
  assert.equal(title.textContent, "Bienvenue dans Web'nTILP !");
  assert.equal(subtitle.textContent, 'Transferts universels');
  assert.equal(scope.WebTILPNumWorks.initialized, true);
});
