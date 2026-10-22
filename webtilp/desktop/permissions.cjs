'use strict';

const DEVICE_PERMISSIONS = new Set(['usb', 'hid', 'serial']);

// Node's URL.origin is "null" for custom schemes, even when Electron registers
// them as standard. Compare the parsed scheme/authority instead.
function sameOrigin(url, origin) {
  try {
    const actual = new URL(url);
    const expected = new URL(origin);
    return actual.protocol === expected.protocol && actual.host === expected.host
      && !actual.username && !actual.password;
  } catch {
    return false;
  }
}

function deviceLabel(kind, device) {
  if (kind === 'serial') {
    const name = device.displayName || device.portName || 'Serial port';
    return device.portName && name !== device.portName ? `${name} (${device.portName})` : name;
  }
  const name = device.productName || device.name || `${kind.toUpperCase()} device`;
  const id = [device.vendorId, device.productId]
    .map(value => Number(value).toString(16).padStart(4, '0')).join(':');
  const serial = device.serialNumber ? ` — ${device.serialNumber}` : '';
  return `${name} (${id})${serial}`;
}

/**
 * Keep Chromium's per-device, in-memory grants: only the selected device is
 * authorized, and users select it again after restarting the app. A blanket
 * setDevicePermissionHandler(true) would bypass these native choosers.
 * Returns a cleanup function; the session should belong only to this window.
 */
function configureDevicePermissions({ session, window, origin, dialog = require('electron').dialog }) {
  const contents = window.webContents;
  const listeners = [];
  let pending = null;
  let disposed = false;

  const live = () => !disposed && !window.isDestroyed() && !contents.isDestroyed()
    && sameOrigin(contents.getURL(), origin);
  const allowed = (webContents, permission, requestingOrigin, details = {}) =>
    live() && webContents === contents && DEVICE_PERMISSIONS.has(permission)
      && details.isMainFrame === true && sameOrigin(requestingOrigin, origin)
      && (!details.requestingUrl || sameOrigin(details.requestingUrl, origin));

  session.setPermissionCheckHandler(allowed);
  session.setPermissionRequestHandler((webContents, permission, callback, details = {}) => {
    callback(allowed(webContents, permission, details.requestingUrl, details));
  });
  session.setDevicePermissionHandler(null);

  function listen(emitter, name, listener) {
    emitter.on(name, listener);
    listeners.push(() => emitter.removeListener(name, listener));
  }

  function cancelPending() {
    pending?.finish();
  }

  function select(kind, devices, trusted, callback) {
    const cancelValue = kind === 'serial' ? '' : undefined;
    if (!trusted || !live() || pending) {
      callback(cancelValue);
      return;
    }
    const id = device => kind === 'serial' ? device.portId : device.deviceId;
    const candidates = new Map(devices.filter(device => id(device)).map(device => [id(device), device]));
    let finished = false;
    const request = {
      kind,
      candidates,
      id,
      finish(value = cancelValue) {
        if (finished) return;
        finished = true;
        if (pending === request) pending = null;
        callback(value);
      }
    };
    pending = request;

    // Native dialogs cannot update their buttons. Rescan redraws from the live
    // hotplug list; an unplugged device can never be granted from stale buttons.
    async function choose() {
      try {
        while (!finished && live()) {
          const choices = [...candidates.values()];
          const buttons = ['Cancel', ...choices.map(device => deviceLabel(kind, device)), 'Rescan'];
          const { response } = await dialog.showMessageBox(window, {
            type: 'question',
            title: "Web'nTILP",
            message: `Select a ${kind === 'serial' ? 'serial port' : `${kind.toUpperCase()} device`}`,
            detail: choices.length
              ? 'Choose the calculator or cable to connect. Use Rescan after plugging in a device.'
              : 'No matching devices found. Connect the calculator or cable, then choose Rescan. Check the required driver and device permissions if it is still missing.',
            buttons,
            defaultId: 0,
            cancelId: 0,
            noLink: true,
            normalizeAccessKeys: false
          });
          if (finished) return;
          if (!live() || response === 0 || !Number.isInteger(response)) break;
          if (response === buttons.length - 1) continue;
          const selected = choices[response - 1];
          if (!selected) break;
          if (!candidates.has(id(selected))) continue;
          request.finish(id(selected));
          return;
        }
      } catch {
        // Closing the owner window can reject the native dialog promise.
      }
      request.finish();
    }
    void choose();
  }

  function trustedFrame(frame) {
    return live() && frame === contents.mainFrame && sameOrigin(frame.url, origin);
  }
  for (const kind of ['usb', 'hid']) {
    listen(session, `select-${kind}-device`, (event, details, callback) => {
      event.preventDefault();
      select(kind, details.deviceList, trustedFrame(details.frame), callback);
    });
  }
  listen(session, 'select-serial-port', (event, ports, webContents, callback) => {
    event.preventDefault();
    select('serial', ports, webContents === contents, callback);
  });

  for (const kind of ['usb', 'serial']) {
    const noun = kind === 'serial' ? 'port' : 'device';
    for (const action of ['added', 'removed']) {
      listen(session, `${kind}-${noun}-${action}`, (_event, device, webContents) => {
        if (!pending || pending.kind !== kind || webContents !== contents) return;
        if (action === 'added') pending.candidates.set(pending.id(device), device);
        else pending.candidates.delete(pending.id(device));
      });
    }
  }
  for (const action of ['added', 'removed']) {
    listen(session, `hid-device-${action}`, (_event, details) => {
      if (!pending || pending.kind !== 'hid' || !trustedFrame(details.frame)) return;
      if (action === 'added') pending.candidates.set(pending.id(details.device), details.device);
      else pending.candidates.delete(pending.id(details.device));
    });
  }

  listen(contents, 'did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) cancelPending();
  });
  listen(contents, 'destroyed', cancelPending);
  listen(window, 'closed', cancelPending);

  return function cleanup() {
    disposed = true;
    cancelPending();
    for (const remove of listeners) remove();
    session.setPermissionCheckHandler(null);
    session.setPermissionRequestHandler(null);
    session.setDevicePermissionHandler(null);
  };
}

module.exports = { configureDevicePermissions, sameOrigin };
