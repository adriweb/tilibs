'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const SCHEME = 'webntilp';
const ORIGIN = `${SCHEME}://app`;
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm', '.png': 'image/png', '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
  '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8'
};

// Embind generates JS invokers with new Function; the bundled WASM converters
// therefore need unsafe-eval. Renderer Node integration remains disabled.
const HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'"
};

function isAppURL(value) {
  try {
    const url = new URL(value);
    // Node's URL.origin is 'null' for custom schemes, even when Chromium
    // registers them as standard. Compare the components explicitly.
    return url.protocol === `${SCHEME}:` && url.hostname === 'app'
      && !url.port && !url.username && !url.password;
  } catch { return false; }
}

function assetPath(root, value) {
  if (!isAppURL(value)) return null;
  try {
    const pathname = decodeURIComponent(new URL(value).pathname);
    if (pathname.includes('\\') || pathname.includes('\0')) return null;
    const resolved = path.resolve(root, `.${pathname === '/' ? '/webtilp.html' : pathname}`);
    const relative = path.relative(root, resolved);
    return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..'
      && !path.isAbsolute(relative) ? resolved : null;
  } catch { return null; }
}

function createAssetHandler(root) {
  root = path.resolve(root);
  return async request => {
    const respond = (body, status, type = 'text/plain; charset=utf-8') =>
      new Response(request.method === 'HEAD' ? null : body, {
        status, headers: { ...HEADERS, 'Content-Type': type }
      });
    if (!['GET', 'HEAD'].includes(request.method)) return respond('Method not allowed', 405);
    const filename = assetPath(root, request.url);
    if (!filename) return respond('Not found', 404);
    try {
      const real = await fs.realpath(filename);
      const relative = path.relative(await fs.realpath(root), real);
      if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return respond('Not found', 404);
      const body = await fs.readFile(real);
      return respond(body, 200, MIME_TYPES[path.extname(filename)] || 'text/plain; charset=utf-8');
    } catch (error) {
      if (['ENOENT', 'EISDIR', 'ENOTDIR'].includes(error.code)) return respond('Not found', 404);
      console.error('[Web\'nTILP] Could not read bundled asset:', error.message);
      return respond('Could not read bundled asset', 500);
    }
  };
}

module.exports = { SCHEME, ORIGIN, HEADERS, isAppURL, assetPath, createAssetHandler };
