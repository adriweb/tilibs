# Evo on Android

WebTiLP automatically uses its WebUSB CDC ACM adapter for TI-83/84 Evo
(`0451:e018`) on Android versions below 17, even when `navigator.serial` exists.
It also uses this adapter when WebUSB exists but native Web Serial does not.
Native Web Serial remains the default on desktop and Android 17 or newer.

Chrome's reduced user agent reports Android 10 on newer Android versions.
Detection therefore prefers `navigator.userAgentData.getHighEntropyValues()`
with `platformVersion`. If that API is present but does not reveal a version,
WebTiLP retains native Serial. `?evoSerial=webusb` explicitly selects the CDC
adapter; `?evoSerial=native` explicitly selects native Serial for comparison.

The adapter is an original, Evo-scoped implementation, rather than a vendored
copy of the archived [Google Web Serial polyfill](https://github.com/google/web-serial-polyfill).
It wraps the already-authorized USBDevice, so the fallback does not show a second
serial picker or need a second click. No native API is overwritten.

## API coverage

The port supplies `connected`, `getInfo()`, `open()`, `close()`, `forget()`,
`setSignals()`, readable byte streams (including BYOB), and writable BufferSource
streams to the existing tilibs Web Serial bridge. It supports 7/8 data bits,
1/2 stop bits, none/even/odd parity, DTR, RTS and break. Writes handle partial USB
transfers. Open failures close USB, and close aborts outstanding USB reads.

Hardware flow control and `getSignals()` reject with `NotSupportedError`: CDC ACM
does not expose the full Web Serial input-signal set, including CTS. Evo's
transport does not require these features. This is not a general-purpose Serial
API replacement, and GrayLink stays on native Web Serial.

## Physical test

1. Deploy a production build containing the new JS adapter and rebuilt WASM.
   The service-worker precache list also drives CI's site packaging.
2. On the S26+ / Android 16, reopen WebTiLP and ensure it has loaded the new build.
3. Connect the Evo, tap **Connect Calculator**, and select it in the USB picker.
   There should be no serial picker or serial-authorization retry alert. The log
   should say `Using Evo CDC serial over WebUSB (native wired WebSerial unavailable).`
4. Check device information, refresh the directory, and receive a small variable.
   Then send a disposable variable and verify its contents on the calculator.
5. Disconnect/reconnect, then test switching to another calculator family.
6. If detection stays on native Serial, repeat using `?evoSerial=webusb` and record
   the exact Chrome version and connection error/log. If USB cannot be claimed,
   close other apps using the device and retry.

The USB picker listing the Evo proves enumeration, not that Android will allow
claiming its CDC interfaces. The physical S26+ transfer remains to be verified.

Automated coverage: `make -C webtilp test`, including mocked USB descriptors,
Client Hints, BYOB reads, zero-length packets, partial writes, cancellation,
disconnect/reopen, failures, and the actual JS bodies of the WASM serial bridge.
After building WASM, `node webtilp/tests/test_evo_webusb_serial.js webtilp/webtilp.js`
also checks cable open/close through the compiled module without native Serial;
CI runs this check after the production build.
