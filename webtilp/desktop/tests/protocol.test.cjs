'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ORIGIN, isAppURL, assetPath, createAssetHandler } = require('../protocol.cjs');

test('custom-origin checks reject other hosts, credentials and ports', () => {
  assert.equal(isAppURL(`${ORIGIN}/webtilp.html?lang=fr`), true);
  for (const url of ['https://app/webtilp.html', 'webntilp://other/',
    'webntilp://app.evil/', 'webntilp://user@app/', 'webntilp://app:80/', 'file:///tmp/']) {
    assert.equal(isAppURL(url), false, url);
  }
});

test('asset handler isolates WASM and refuses traversal, symlinks and writes', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'webntilp-protocol-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'app');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'webtilp.html'), '<title>Offline</title>');
  await fs.writeFile(path.join(root, 'test.wasm'), Buffer.from([0, 97, 115, 109]));
  await fs.writeFile(path.join(temp, 'secret.txt'), 'private');
  const handle = createAssetHandler(root);
  const get = (suffix, method = 'GET') => handle({ url: `${ORIGIN}${suffix}`, method });
  const response = await get('/test.wasm');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'application/wasm');
  assert.equal(response.headers.get('Cross-Origin-Opener-Policy'), 'same-origin');
  assert.equal(response.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0, 97, 115, 109]);
  assert.match(await (await get('/')).text(), /Offline/);
  assert.equal(await (await get('/test.wasm', 'HEAD')).text(), '');
  for (const suffix of ['/missing.js', '/%2e%2e%2fsecret.txt', '/%5c..%5csecret.txt', '/bad%00.txt', '/%ZZ']) {
    assert.equal((await get(suffix)).status, 404, suffix);
  }
  assert.equal((await get('/test.wasm', 'POST')).status, 405);
  assert.equal(assetPath(root, `${ORIGIN}/%2e%2e%2fsecret.txt`), null);
  // Windows generally disallows unprivileged symlink creation; traversal above
  // still exercises containment on every platform.
  if (process.platform !== 'win32') {
    await fs.symlink(path.join(temp, 'secret.txt'), path.join(root, 'link.txt'));
    assert.equal((await get('/link.txt')).status, 404);
  }
});
