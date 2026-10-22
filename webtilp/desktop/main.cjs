'use strict';

const { app, BrowserWindow, Menu, dialog, protocol, session, shell } = require('electron');
const path = require('node:path');
const { SCHEME, ORIGIN, isAppURL, createAssetHandler } = require('./protocol.cjs');
const { configureDevicePermissions } = require('./permissions.cjs');

app.setName("Web'nTILP");
// The same origin and profile survive app upgrades. No HTTP server or installed
// browser is needed; secure Chromium APIs work on this registered local scheme.
protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
}]);

let mainWindow;
let disposePermissions;

function openExternal(value) {
  try {
    const url = new URL(value);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) {
      shell.openExternal(url.href).catch(error => console.error(error));
    }
  } catch { /* Ignore malformed links. */ }
}

function createWindow() {
  const appSession = session.fromPartition('persist:webntilp');
  mainWindow = new BrowserWindow({
    title: "Web'nTILP", width: 1320, height: 920, minWidth: 760, minHeight: 540,
    backgroundColor: '#0d1117', show: false,
    icon: path.join(__dirname, 'app', 'android-chrome-512x512.png'),
    webPreferences: {
      session: appSession, nodeIntegration: false, contextIsolation: true,
      sandbox: true, webSecurity: true, spellcheck: false
    }
  });
  disposePermissions = configureDevicePermissions({ session: appSession, window: mainWindow, origin: ORIGIN });
  const contents = mainWindow.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!isAppURL(url)) { event.preventDefault(); openExternal(url); }
  });
  contents.on('will-redirect', (event, url) => {
    if (!isAppURL(url)) event.preventDefault();
  });
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.on('page-title-updated', event => event.preventDefault());
  contents.on('render-process-gone', (_event, details) => {
    if (details.reason !== 'clean-exit') {
      dialog.showErrorBox("Web'nTILP stopped", 'The app renderer stopped. Restart the app and reconnect your calculator.');
    }
  });
  // Chromium normally chooses a default download folder in Electron. Always
  // offer Save As for backups, variables, ROMs and screenshots instead.
  const saveDownload = (_event, item, source) => {
    if (source === contents) item.setSaveDialogOptions({ title: 'Save calculator file' });
  };
  appSession.on('will-download', saveDownload);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    disposePermissions?.();
    disposePermissions = null;
    appSession.removeListener('will-download', saveDownload);
    mainWindow = null;
  });
  contents.loadURL(`${ORIGIN}/webtilp.html`).catch(error => {
    dialog.showErrorBox("Could not start Web'nTILP", error.message);
    app.quit();
  });
}

function installMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
    { label: 'Help', submenu: [
      { label: "About Web'nTILP", click: () => dialog.showMessageBox(mainWindow, {
        type: 'info', title: "Web'nTILP", message: `Web'nTILP ${app.getVersion()}`,
        detail: 'WebTILP with bundled Chromium. Works offline from the first launch.\n\nGPL v2 or later. See Help > Licenses for third-party notices and source information.'
      }) },
      { label: 'Licenses', click: () => {
        const licenses = new BrowserWindow({
          title: "Web'nTILP licenses", width: 900, height: 700,
          webPreferences: { session: session.fromPartition('persist:webntilp'),
            nodeIntegration: false, contextIsolation: true, sandbox: true }
        });
        licenses.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
        licenses.webContents.on('will-navigate', (event, url) => {
          if (!isAppURL(url)) { event.preventDefault(); openExternal(url); }
        });
        licenses.loadURL(`${ORIGIN}/licenses.html`);
      } },
      { label: 'Source code', click: () => openExternal('https://github.com/adriweb/tilibs') }
    ] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  const appSession = session.fromPartition('persist:webntilp');
  const appAssets = createAssetHandler(path.join(__dirname, 'app'));
  const runtimeLicenses = createAssetHandler(app.isPackaged
    ? path.join(process.resourcesPath, 'electron-licenses')
    : path.join(__dirname, 'node_modules', 'electron', 'dist'));
  await appSession.protocol.handle(SCHEME, request => {
    const prefix = `${ORIGIN}/runtime-licenses/`;
    if (request.url.startsWith(prefix)) {
      return runtimeLicenses({ method: request.method, url: `${ORIGIN}/${request.url.slice(prefix.length)}` });
    }
    return appAssets(request);
  });
  // The desktop app is entirely local. Explicit footer links still open in the
  // user's browser, but renderer/worker requests cannot load remote content.
  appSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = isAppURL(details.url) || /^(blob:|data:)/.test(details.url);
    callback({ cancel: !allowed });
  });
  installMenu();
  createWindow();
  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    else mainWindow.focus();
  });
}).catch(error => {
  dialog.showErrorBox("Could not start Web'nTILP", error.message);
  app.quit();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
