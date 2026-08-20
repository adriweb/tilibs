#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DESKTOP_DIR = path.resolve(__dirname, '..');
const SOURCE_DIR = path.resolve(DESKTOP_DIR, '..');
const REPO_DIR = path.resolve(SOURCE_DIR, '..');
const BRAND = "Web'nTILP";

// Keep the runtime API names (WebTILPNumWorks, etc.) and the website untouched.
// The observer also covers English fallback strings after a language change.
const BRANDING_SCRIPT = `'use strict';
(() => {
  const brand = ${JSON.stringify(BRAND)};
  function updateBrand() {
    for (const element of document.querySelectorAll('.brand-title, #splashTitle')) {
      const text = element.textContent.replaceAll('WebTILP', brand);
      if (text !== element.textContent) element.textContent = text;
    }
    const subtitle = document.getElementById('brandSubtitle');
    if (subtitle?.textContent === 'Universal linking, right from your browser!') {
      subtitle.textContent = 'Universal linking, offline on your desktop!';
    }
  }
  new MutationObserver(updateBrand).observe(document.body, {
    childList: true, characterData: true, subtree: true
  });
  updateBrand();
})();
`;

function assetPath(name) {
  if (typeof name !== 'string' || !name || name.includes('\\')
      || name.startsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..')
      || !/^[a-zA-Z0-9_./-]+$/.test(name)) {
    throw new Error(`Unsafe desktop asset path: ${JSON.stringify(name)}`);
  }
  return name;
}

function precacheAssets(worker) {
  const match = worker.match(/const\s+PRECACHE_URLS\s*=\s*(\[[\s\S]*?\]);/);
  if (!match) throw new Error('Cannot find PRECACHE_URLS in sw.js; rebuild WebTILP first.');
  const names = [];
  const remainder = match[1].slice(1, -1).replace(/(['"])([a-zA-Z0-9_./-]+)\1/g, (_, quote, name) => {
    names.push(assetPath(name));
    return '';
  });
  if (!names.length || remainder.replace(/[\s,]/g, '')) {
    throw new Error('PRECACHE_URLS must contain only literal relative asset paths.');
  }
  return names;
}

function regularFile(filename) {
  try {
    const info = fs.lstatSync(filename);
    return info.isFile() && info.size > 0;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function filesIn(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const name = prefix + entry.name;
    if (entry.isDirectory()) return filesIn(path.join(directory, entry.name), `${name}/`);
    if (!entry.isFile()) throw new Error(`Expected a regular license file: ${name}`);
    return [assetPath(name)];
  });
}

function rebrandDictionary(value) {
  if (typeof value === 'string') return value.replaceAll('WebTILP', BRAND);
  if (Array.isArray(value)) return value.map(rebrandDictionary);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rebrandDictionary(item)]));
  }
  return value;
}

function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
}

function stageAssets({ sourceDir = SOURCE_DIR, outputDir = path.join(DESKTOP_DIR, 'app'), repoDir = REPO_DIR } = {}) {
  sourceDir = path.resolve(sourceDir);
  outputDir = path.resolve(outputDir);
  repoDir = path.resolve(repoDir);
  const sourceFromOutput = path.relative(outputDir, sourceDir);
  if (!sourceFromOutput || (!sourceFromOutput.startsWith('..' + path.sep) && sourceFromOutput !== '..' && !path.isAbsolute(sourceFromOutput))) {
    throw new Error('Desktop output must not replace or contain the source directory.');
  }
  if (!regularFile(path.join(sourceDir, 'sw.js'))) {
    throw new Error('Missing built WebTILP asset: sw.js. Run make -C webtilp dev (or prod) first.');
  }
  const assets = new Set([...precacheAssets(fs.readFileSync(path.join(sourceDir, 'sw.js'), 'utf8')), 'sw.js']);
  for (const name of fs.readdirSync(path.join(sourceDir, 'i18n'))) {
    if (/^[a-z-]+\.json$/.test(name)) assets.add(`i18n/${name}`);
  }
  for (const name of ['webtilp.worker.js', 'TIVarsLib.worker.js', 'WebLuna.worker.js', 'build-sources.json', 'webtilp-deps.txt', 'NUMWORKS.md']) {
    if (regularFile(path.join(sourceDir, name))) assets.add(name);
  }
  const copies = new Map([...assets].sort().map(name => [assetPath(name), path.join(sourceDir, name)]));
  for (const library of ['libticables', 'libticalcs', 'libtifiles', 'libticonv']) {
    copies.set(`licenses/${library}-COPYING.txt`, path.join(repoDir, library, 'trunk/COPYING'));
  }
  copies.set('licenses/libhpcalcs-COPYING.txt', path.join(repoDir, 'hplp/libhpcalcs/COPYING'));
  copies.set('licenses/cahute-LICENSE.txt', path.join(repoDir, 'cahute/LICENSE.txt'));
  copies.set('licenses/wasm-sources.lock', path.join(repoDir, 'deps/wasm/sources.lock'));
  for (const dependency of ['upsilon-js', 'webdfu', 'feather']) {
    copies.set(`third_party/${dependency}/LICENSE`, path.join(sourceDir, 'third_party', dependency, 'LICENSE'));
  }
  copies.set('third_party/NUMWORKS-PROVENANCE.md', path.join(sourceDir, 'third_party/NUMWORKS-PROVENANCE.md'));
  for (const name of filesIn(path.join(DESKTOP_DIR, 'licenses'))) {
    copies.set(`licenses/${name}`, path.join(DESKTOP_DIR, 'licenses', name));
  }
  const dependencyManifest = path.join(repoDir, 'wasm-deps/webtilp-deps.txt');
  if (!copies.has('webtilp-deps.txt') && regularFile(dependencyManifest)) copies.set('webtilp-deps.txt', dependencyManifest);
  const missing = [...copies].filter(([, filename]) => !regularFile(filename)).map(([name]) => name);
  if (missing.length) {
    throw new Error(`Missing built WebTILP assets or licenses: ${missing.join(', ')}. Build WebTILP before packaging.`);
  }
  // Check before replacing a previous successful staging output.
  JSON.parse(fs.readFileSync(path.join(sourceDir, 'version.json'), 'utf8'));
  for (const name of ['webtilp.wasm', 'TIVarsLib.wasm', 'WebLuna.wasm']) {
    const header = fs.readFileSync(path.join(sourceDir, name)).subarray(0, 4);
    if (!header.equals(Buffer.from([0, 97, 115, 109]))) throw new Error(`Invalid WebAssembly asset: ${name}`);
  }
  fs.mkdirSync(path.dirname(outputDir), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(outputDir), '.webntilp-stage-'));
  try {
    for (const [name, filename] of copies) {
      const destination = path.join(staging, name);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(filename, destination);
    }
    const htmlPath = path.join(staging, 'webtilp.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace('<title>WebTILP</title>', `<title>${BRAND}</title>`)
      .replace(/(<div class="brand-title">)WebTILP(<\/div>)/g, `$1${BRAND}$2`);
    const script = '<script src="app.bundle.js"></script>';
    if (!html.includes(script)) throw new Error('Cannot locate app.bundle.js script in webtilp.html.');
    html = html.replace(script, '<script src="desktop-branding.js"></script>\n    ' + script);
    fs.writeFileSync(htmlPath, html);
    fs.writeFileSync(path.join(staging, 'desktop-branding.js'), BRANDING_SCRIPT);
    for (const name of assets) {
      if (name.startsWith('i18n/') && name.endsWith('.json')) {
        const destination = path.join(staging, name);
        fs.writeFileSync(destination, JSON.stringify(rebrandDictionary(JSON.parse(fs.readFileSync(destination, 'utf8'))), null, 2) + '\n');
      }
    }
    const manifestPath = path.join(staging, 'site.webmanifest');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.name = manifest.short_name = BRAND;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    const licenses = [...copies.keys()].filter(name => name.startsWith('licenses/') || name.startsWith('third_party/')).sort();
    fs.writeFileSync(path.join(staging, 'licenses.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><title>${BRAND} licenses</title><body><h1>${BRAND} licenses</h1><p>WebTILP and its desktop wrapper are GPLv2 software. The dependencies below retain their own licenses.</p><p>Bundled Chromium runtime notices: <a href="runtime-licenses/LICENSE">Electron license</a> and <a href="runtime-licenses/LICENSES.chromium.html">Chromium third-party licenses</a>.</p><p><a href="https://github.com/adriweb/tilibs">Corresponding source and build instructions</a></p><ul>${licenses.map(name => `<li><a href="${encodeURI(name)}">${escapeHtml(name)}</a></li>`).join('')}</ul></body></html>\n`);
    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.renameSync(staging, outputDir);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return { outputDir, assets: [...copies.keys(), 'desktop-branding.js', 'licenses.html'].sort() };
}

if (require.main === module) {
  try {
    const options = {};
    for (let index = 2; index < process.argv.length; index += 2) {
      const name = { '--source': 'sourceDir', '--output': 'outputDir' }[process.argv[index]];
      if (!name || !process.argv[index + 1]) throw new Error('Usage: stage-assets.cjs [--source DIR] [--output DIR]');
      options[name] = process.argv[index + 1];
    }
    const result = stageAssets(options);
    console.log(`Staged ${result.assets.length} offline assets in ${result.outputDir}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { stageAssets, precacheAssets, BRANDING_SCRIPT };
