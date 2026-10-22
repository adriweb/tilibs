'use strict';

const assert = require('node:assert/strict');

// Exercise Chromium's actual permission checks and Electron chooser events from
// real user gestures. The main-process dialog stub always cancels: this test
// never chooses a connected calculator or sends anything to hardware.
async function smokeTransports(application, page) {
  const buttonId = 'webntilp-transport-smoke';
  await application.evaluate(({ dialog }) => {
    if (globalThis.__webntilpTransportSmoke) throw new Error('Transport smoke is already running');
    const state = { original: dialog.showMessageBox, messages: [] };
    globalThis.__webntilpTransportSmoke = state;
    dialog.showMessageBox = function (window, options) {
      if (options?.title === "Web'nTILP" && /^Select a (USB device|HID device|serial port)$/.test(options.message)) {
        state.messages.push(options.message);
        return Promise.resolve({ response: 0, checkboxChecked: false });
      }
      return state.original.apply(this, arguments);
    };
  });

  const results = {};
  try {
    for (const transport of ['usb', 'hid', 'serial']) {
      await page.evaluate(({ buttonId, transport }) => {
        document.getElementById(buttonId)?.remove();
        delete globalThis.__webntilpTransportSmokeResult;
        const button = document.createElement('button');
        button.id = buttonId;
        button.type = 'button';
        button.textContent = `Test ${transport.toUpperCase()} chooser cancellation`;
        Object.assign(button.style, {
          position: 'fixed', top: '0', left: '0', zIndex: '2147483647',
          padding: '12px', display: 'block', visibility: 'visible'
        });
        button.addEventListener('click', async () => {
          try {
            const value = transport === 'serial'
              ? await navigator.serial.requestPort()
              : await navigator[transport].requestDevice({ filters: [] });
            globalThis.__webntilpTransportSmokeResult = {
              resolved: true, selected: transport === 'hid' ? value.length : Number(Boolean(value))
            };
          } catch (error) {
            globalThis.__webntilpTransportSmokeResult = {
              resolved: false, name: error.name, message: error.message
            };
          }
        }, { once: true });
        document.body.appendChild(button);
      }, { buttonId, transport });
      await page.locator(`#${buttonId}`).click({ force: true });
      await page.waitForFunction(() => globalThis.__webntilpTransportSmokeResult !== undefined,
        undefined, { timeout: 15000 });
      results[transport] = await page.evaluate(() => globalThis.__webntilpTransportSmokeResult);
      if (transport === 'hid') {
        assert.deepEqual(results[transport], { resolved: true, selected: 0 },
          `HID chooser cancellation: ${JSON.stringify(results[transport])}`);
      } else {
        assert.equal(results[transport].resolved, false, `${transport} unexpectedly chose a device`);
        assert.equal(results[transport].name, 'NotFoundError',
          `${transport} chooser cancellation: ${JSON.stringify(results[transport])}`);
      }
    }
    const messages = await application.evaluate(() => globalThis.__webntilpTransportSmoke.messages);
    assert.deepEqual(messages, ['Select a USB device', 'Select a HID device', 'Select a serial port'],
      'Every Chromium request must reach the trusted Electron device chooser');
    return results;
  } finally {
    await page.evaluate(buttonId => {
      document.getElementById(buttonId)?.remove();
      delete globalThis.__webntilpTransportSmokeResult;
    }, buttonId);
    await application.evaluate(({ dialog }) => {
      const state = globalThis.__webntilpTransportSmoke;
      if (state) dialog.showMessageBox = state.original;
      delete globalThis.__webntilpTransportSmoke;
    });
  }
}

module.exports = { smokeTransports };
