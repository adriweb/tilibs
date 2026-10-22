'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

// electron-builder removes the top-level runtime notices from macOS builds.
// Preserve the exact target distribution's texts inside the installed app on
// every platform, before the packager renames Electron.app or deletes notices.
module.exports = async ({ appOutDir, electronPlatformName, packager }) => {
  const resources = electronPlatformName === 'darwin'
    ? path.join(appOutDir, packager.info.framework.distMacOsAppName, 'Contents', 'Resources')
    : path.join(appOutDir, 'resources');
  const output = path.join(resources, 'electron-licenses');
  await fs.mkdir(output, { recursive: true });
  const license = electronPlatformName === 'darwin' ? 'LICENSE' : 'LICENSE.electron.txt';
  await fs.copyFile(path.join(appOutDir, license), path.join(output, 'LICENSE'));
  await fs.copyFile(path.join(appOutDir, 'LICENSES.chromium.html'), path.join(output, 'LICENSES.chromium.html'));
};
