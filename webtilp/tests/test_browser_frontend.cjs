'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const artifacts = process.env.WEBTILP_TEST_ARTIFACTS
    || fs.mkdtempSync(path.join(os.tmpdir(), 'webtilp-browser-'));
fs.mkdirSync(artifacts, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path.resolve(root, `.${pathname}`);
    if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    response.setHeader('Cache-Control', 'no-store');
    fs.readFile(file, (error, bytes) => {
        if (error) { response.writeHead(404).end(); return; }
        response.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
        response.end(bytes);
    });
});

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ headless: true });
    try {
        async function scenario(name, route, interact, viewport = { width: 1440, height: 1000 }) {
            const context = await browser.newContext({ viewport, serviceWorkers: 'allow', acceptDownloads: true });
            const page = await context.newPage();
            const failures = [];
            page.on('pageerror', error => failures.push(error.message));
            page.on('console', message => {
                if (message.type() === 'error') failures.push(message.text());
            });
            try {
                await page.goto(origin + route);
                await page.waitForFunction(() => !document.body.classList.contains('initializing'));
                assert.equal(await page.title(), 'WebTILP');
                assert.equal(new URL(page.url()).pathname, route);
                assert.ok(await page.locator('.brand-title').first().textContent());
                assert.equal(await page.locator('vite-error-overlay, nextjs-portal').count(), 0);
                await interact(page);
                await page.screenshot({ path: path.join(artifacts, `${name}.png`), fullPage: false });
                assert.deepEqual(failures, [], `${name} has no browser errors`);
                console.log(`PASS: ${name}`);
            } catch (error) {
                await page.screenshot({ path: path.join(artifacts, `${name}-failed.png`), fullPage: false });
                console.error(`${name}: ${JSON.stringify({ failures,
                    activity: await page.locator('#log').textContent() })}`);
                throw error;
            } finally { await context.close(); }
        }
        await scenario('production-splash', '/webtilp.html', async page => {
            await page.locator('#splashScreen').waitFor({ state: 'visible' });
            assert.equal(await page.evaluate(() => globalThis.__webtilpTest), undefined);
            await page.locator('#btnSettings').click();
            await page.locator('#settingsModal').waitFor({ state: 'visible' });
            await page.locator('#btnCloseSettings').click();
            await page.locator('#settingsModal').waitFor({ state: 'hidden' });
        });
        await scenario('mobile-splash', '/webtilp.html', async page => {
            await page.locator('#splashScreen').waitFor({ state: 'visible' });
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
            assert.equal(overflow, false, 'mobile splash has no horizontal overflow');
        }, { width: 390, height: 844 });
        await scenario('hp-prime', '/tests/hp_prime_frontend.html', async page => {
            await page.locator('#testActivateHPPrime').click();
            await page.locator('#mainContent').waitFor({ state: 'visible' });
            assert.match(await page.locator('#deviceModel').textContent(), /HP Prime G2/);
            assert.equal(await page.locator('#btnSyncClock').isDisabled(), true);
            await page.locator('#testFrench').click();
            await page.waitForFunction(() => document.documentElement.lang === 'fr');
            await page.locator('#testDisconnect').click();
            await page.locator('#splashScreen').waitFor({ state: 'visible' });
        });
        await scenario('hp-legacy', '/tests/hp_legacy_frontend.html', async page => {
            await page.locator('#testActivateHPLegacyTransport').click();
            await page.locator('#mainContent').waitFor({ state: 'visible' });
            assert.equal(await page.locator('#btnRefreshDirlist').isDisabled(), true);
            await page.locator('#testActivateHPLegacyKermit').click();
            await page.waitForFunction(() => document.querySelectorAll('#varTableBody tr').length === 2);
            assert.match(await page.locator('#varTableBody').textContent(), /IOPAR/);
            assert.equal(await page.locator('#btnRefreshDirlist').isDisabled(), false);
            await page.locator('#btnScreenshot').click();
            await page.waitForFunction(() => document.querySelector('#screenshotCanvas').width === 131);
            await page.locator('#testDisconnectHPLegacy').click();
            await page.locator('#splashScreen').waitFor({ state: 'visible' });
        });
        await scenario('numworks', '/tests/numworks_frontend.html', async page => {
            await page.locator('#mainContent').waitFor({ state: 'visible' });
            await page.locator('#btnRefreshDirlist').click();
            await page.waitForFunction(() => document.querySelector('#varTableBody').textContent.includes('hello.py'));
            await page.locator('#varTableBody input[type=checkbox]').first().check();
            const download = page.waitForEvent('download');
            await page.locator('#btnRecvSelected').click();
            assert.match((await download).suggestedFilename(), /hello\.py$/);
            page.on('dialog', dialog => dialog.accept());
            await page.locator('#btnDeleteSelected').click();
            await page.waitForFunction(() => !document.querySelector('#varTableBody').textContent.includes('hello.py'));
        });
        await scenario('sharp', '/tests/sharp_frontend.html', async page => {
            await page.locator('#btnSettings').click();
            await page.locator('#settingCalcModel').selectOption('sharp-el9950');
            const reload = page.waitForNavigation();
            await page.locator('#btnSaveSettings').click();
            await reload;
            await page.waitForFunction(() => !document.body.classList.contains('initializing'));
            await page.locator('#btnSplashConnect').click();
            await page.locator('#mainContent').waitFor({ state: 'visible' });
            await page.locator('#btnRefreshDirlist').click();
            await page.waitForFunction(() => document.querySelector('#varTableBody').textContent.includes('HELLO'));
            await page.locator('#varTableBody input[type=checkbox]').first().check();
            const download = page.waitForEvent('download');
            await page.locator('#btnRecvSelected').click();
            assert.equal((await download).suggestedFilename(), 'HELLO.g4p');
            await page.locator('#btnScreenshot').click();
            await page.waitForFunction(() => document.querySelector('#screenshotCanvas').width === 132);
        });
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
    console.log(`Browser evidence: ${artifacts}`);
})().catch(error => {
    console.error(error);
    server.close();
    process.exitCode = 1;
});
