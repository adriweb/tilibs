'use strict';

// Only browser harnesses receive access to app internals. Production bundles
// use app.js directly and expose none of these test bindings.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const entry = path.join(root, `.frontend-test-entry-${process.pid}.js`);
const bindings = [
    'state', 'els', 'DEVICE_FAMILY_HP_PRIME', 'DEVICE_FAMILY_HP_LEGACY',
    'HP_VENDOR_ID', 'HP_LEGACY_PRODUCT_ID', 'FEATURE_FLAGS',
    'setConnected', 'applyActiveFamilyUiState', 'readHPLegacyInfo',
    'renderDirlist', 'setStatus', 'updateDeviceModelDisplay',
    'applyTranslations', 'handleTransportDisconnect',
    'triggerDownload', 'updateTransportSplashState'
];
try {
    fs.writeFileSync(entry, fs.readFileSync(path.join(root, 'app.js'), 'utf8')
        + `\nglobalThis.__webtilpTest = Object.freeze({${bindings.map(name => `${name}: context.${name}`).join(',')}});\nexport {};\n`);
    const result = spawnSync(process.argv[2] || 'bun', [
        'build', entry, '--outfile', path.join(root, 'app.test.bundle.js'),
        '--format=iife', '--sourcemap=linked', ...process.argv.slice(3)
    ], { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
} finally {
    fs.rmSync(entry, { force: true });
}
