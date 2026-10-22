'use strict';

const { EventEmitter } = require('node:events');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { configureDevicePermissions, sameOrigin } = require('../permissions.cjs');

const ORIGIN = 'webntilp://app';
const URL = `${ORIGIN}/webtilp.html`;

function fixture() {
  const session = new EventEmitter();
  session.setPermissionCheckHandler = handler => { session.check = handler; };
  session.setPermissionRequestHandler = handler => { session.request = handler; };
  session.setDevicePermissionHandler = handler => { session.device = handler; };
  const contents = new EventEmitter();
  contents.url = URL;
  contents.getURL = () => contents.url;
  contents.isDestroyed = () => false;
  contents.mainFrame = { url: URL };
  const window = new EventEmitter();
  window.webContents = contents;
  window.isDestroyed = () => false;
  const dialogs = [];
  const dialog = {
    showMessageBox(owner, options) {
      return new Promise((resolve, reject) => dialogs.push({ owner, options, resolve, reject }));
    }
  };
  const cleanup = configureDevicePermissions({ session, window, origin: ORIGIN, dialog });
  const replies = [];
  function select(kind, devices = []) {
    let prevented = false;
    const event = { preventDefault() { prevented = true; } };
    const callback = (...args) => replies.push(args[0]);
    if (kind === 'serial') session.emit('select-serial-port', event, devices, contents, callback);
    else session.emit(`select-${kind}-device`, event,
      { deviceList: devices, frame: contents.mainFrame }, callback);
    assert.equal(prevented, true);
  }
  return { session, contents, window, dialogs, cleanup, replies, select };
}

async function respond(dialog, response) {
  dialog.resolve({ response });
  await new Promise(resolve => setImmediate(resolve));
}

test('custom scheme origins are exact despite Node URL.origin returning null', () => {
  assert.equal(sameOrigin(URL, ORIGIN), true);
  for (const url of ['https://app/webtilp.html', 'webntilp://app.evil', 'webntilp://app:123',
    'webntilp://user@app', 'file:///webtilp.html', 'invalid', 'webntilp://evil']) {
    assert.equal(sameOrigin(url, ORIGIN), false, url);
  }
});

test('only hardware permissions in the trusted main frame are allowed', () => {
  const f = fixture();
  const details = { isMainFrame: true, requestingUrl: URL };
  for (const permission of ['usb', 'hid', 'serial']) {
    assert.equal(f.session.check(f.contents, permission, ORIGIN, details), true);
    assert.equal(f.session.check(f.contents, permission, ORIGIN, { ...details, isMainFrame: false }), false);
    assert.equal(f.session.check(f.contents, permission, 'webntilp://app.evil', details), false);
    assert.equal(f.session.check({}, permission, ORIGIN, details), false);
    assert.equal(f.session.check(null, permission, ORIGIN, details), false);
    assert.equal(f.session.check(f.contents, permission, ORIGIN, {}), false);
  }
  for (const permission of ['media', 'clipboard-read', 'geolocation', 'fileSystem', 'unknown']) {
    assert.equal(f.session.check(f.contents, permission, ORIGIN, details), false);
  }
  // Use Electron's per-device selection grants; never grant every USB device.
  assert.equal(f.session.device, null);
  f.cleanup();
});

test('permission request handler applies the same main-frame boundary', () => {
  const f = fixture();
  const replies = [];
  f.session.request(f.contents, 'usb', value => replies.push(value), { isMainFrame: true, requestingUrl: URL });
  f.session.request(f.contents, 'usb', value => replies.push(value), { isMainFrame: false, requestingUrl: URL });
  f.session.request(f.contents, 'usb', value => replies.push(value), { isMainFrame: true, requestingUrl: 'https://example.org' });
  f.session.request(f.contents, 'media', value => replies.push(value), { isMainFrame: true, requestingUrl: URL });
  assert.deepEqual(replies, [true, false, false, false]);
  f.cleanup();
});

test('USB chooser grants exactly the explicitly chosen device', async () => {
  const f = fixture();
  f.select('usb', [
    { deviceId: 'one', productName: 'Calculator A', vendorId: 0x451, productId: 0xe008 },
    { deviceId: 'two', productName: 'Calculator B', vendorId: 0x451, productId: 0xe018 }
  ]);
  assert.equal(f.dialogs[0].owner, f.window);
  assert.match(f.dialogs[0].options.buttons[1], /Calculator A \(0451:e008\)/);
  assert.deepEqual(f.replies, []);
  await respond(f.dialogs[0], 2);
  assert.deepEqual(f.replies, ['two']);
  f.cleanup();
});

test('HID callback receives one device ID, as required by Electron', async () => {
  const f = fixture();
  f.select('hid', [{ deviceId: 'prime', name: 'HP Prime', vendorId: 0x3f0, productId: 0x1541 }]);
  await respond(f.dialogs[0], 1);
  assert.deepEqual(f.replies, ['prime']);
  f.cleanup();
});

test('serial ports with no USB IDs remain selectable', async () => {
  const f = fixture();
  f.select('serial', [{ portId: 'native-serial', portName: '/dev/ttyS0', displayName: 'RS232' }]);
  assert.equal(f.dialogs[0].options.buttons[1], 'RS232 (/dev/ttyS0)');
  await respond(f.dialogs[0], 1);
  assert.deepEqual(f.replies, ['native-serial']);
  f.cleanup();
});

test('native Cancel uses the correct API cancellation value', async () => {
  for (const kind of ['usb', 'hid', 'serial']) {
    const f = fixture();
    f.select(kind);
    await respond(f.dialogs[0], 0);
    assert.deepEqual(f.replies, [kind === 'serial' ? '' : undefined]);
    f.cleanup();
    assert.equal(f.replies.length, 1);
  }
});

test('a main-frame navigation cancels once while its old dialog is open', async () => {
  const f = fixture();
  f.select('usb', [{ deviceId: 'device', vendorId: 1, productId: 2 }]);
  f.contents.emit('did-start-navigation', {}, 'https://example.org', false, true);
  assert.deepEqual(f.replies, [undefined]);
  await respond(f.dialogs[0], 1);
  f.cleanup();
  assert.equal(f.replies.length, 1);
});

test('navigation in a child frame does not cancel a main-frame chooser', async () => {
  const f = fixture();
  f.select('serial', [{ portId: 'port', portName: 'COM3' }]);
  f.contents.emit('did-start-navigation', {}, 'about:blank', false, false);
  assert.deepEqual(f.replies, []);
  await respond(f.dialogs[0], 1);
  assert.deepEqual(f.replies, ['port']);
  f.cleanup();
});

test('a chooser cannot grant after the main page changes origin', async () => {
  const f = fixture();
  f.select('usb', [{ deviceId: 'device', vendorId: 1, productId: 2 }]);
  f.contents.url = 'https://example.org';
  await respond(f.dialogs[0], 1);
  assert.deepEqual(f.replies, [undefined]);
  f.cleanup();
});

test('USB requests from another frame are denied without showing a dialog', () => {
  const f = fixture();
  f.session.emit('select-usb-device', { preventDefault() {} }, {
    deviceList: [], frame: { url: URL }
  }, value => f.replies.push(value));
  assert.deepEqual(f.replies, [undefined]);
  assert.equal(f.dialogs.length, 0);
  f.cleanup();
});

test('Rescan includes hotplugged USB devices without granting them automatically', async () => {
  const f = fixture();
  f.select('usb');
  f.session.emit('usb-device-added', {}, { deviceId: 'new', productName: 'Connected now', vendorId: 1, productId: 2 }, f.contents);
  assert.deepEqual(f.replies, []);
  await respond(f.dialogs[0], 1); // Rescan in the initially empty list.
  assert.match(f.dialogs[1].options.buttons[1], /Connected now/);
  await respond(f.dialogs[1], 1);
  assert.deepEqual(f.replies, ['new']);
  f.cleanup();
});

test('a removed device cannot be selected from stale dialog buttons', async () => {
  const f = fixture();
  const device = { portId: 'port', portName: 'COM3' };
  f.select('serial', [device]);
  f.session.emit('serial-port-removed', {}, device, f.contents);
  await respond(f.dialogs[0], 1);
  assert.deepEqual(f.replies, []);
  assert.equal(f.dialogs[1].options.buttons.length, 2);
  await respond(f.dialogs[1], 0);
  assert.deepEqual(f.replies, ['']);
  f.cleanup();
});

test('parallel requests do not replace or grant the open chooser', async () => {
  const f = fixture();
  f.select('usb', [{ deviceId: 'first', vendorId: 1, productId: 2 }]);
  f.select('hid');
  assert.deepEqual(f.replies, [undefined]);
  assert.equal(f.dialogs.length, 1);
  await respond(f.dialogs[0], 1);
  assert.deepEqual(f.replies, [undefined, 'first']);
  f.cleanup();
});

test('closing the owner window cancels pending access exactly once', async () => {
  const f = fixture();
  f.select('hid');
  f.window.emit('closed');
  assert.deepEqual(f.replies, [undefined]);
  f.dialogs[0].reject(new Error('Owner destroyed'));
  await new Promise(resolve => setImmediate(resolve));
  f.cleanup();
  assert.equal(f.replies.length, 1);
  assert.equal(f.session.listenerCount('select-usb-device'), 0);
  assert.equal(f.contents.listenerCount('did-start-navigation'), 0);
});
