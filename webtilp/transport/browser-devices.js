'use strict';

/**
 * transport browser-devices. Browser and application dependencies are injected
 * by app.js; importing this module does not start the application.
 * @param {object} dependencies
 * @returns {object}
 */
function createTransportBrowserDevices(dependencies) {
    function getWebUsbDeviceFamily(device) {
        if (device?.vendorId === dependencies.SHARP_VENDOR_ID && device?.productId === dependencies.SHARP_PRODUCT_ID) return dependencies.DEVICE_FAMILY_SHARP;

        if (dependencies.isHPLegacyDevice(device)) {
            return dependencies.DEVICE_FAMILY_HP_LEGACY;
        }
        if (dependencies.isHPPrimeDevice(device)) {
            return dependencies.DEVICE_FAMILY_HP_PRIME;
        }
        if (dependencies.isNumWorksDevice(device)) {
            return dependencies.DEVICE_FAMILY_NUMWORKS;
        }
        if (dependencies.isCasioDevice(device)) {
            return dependencies.DEVICE_FAMILY_CASIO;
        }
        if (device?.vendorId === dependencies.TI_VENDOR_ID && dependencies.TI_USB_PRODUCT_IDS.has(device.productId)) {
            return dependencies.DEVICE_FAMILY_TI;
        }
        return null;
    }

    function getSupportedWebUsbFilters() {
        return [
            ...dependencies.TI_USB_DEVICES.map(device => ({
                vendorId: dependencies.TI_VENDOR_ID,
                productId: device.productId
            })),
            ...[...dependencies.HP_PRIME_PRODUCT_IDS].map(productId => ({
                vendorId: dependencies.HP_VENDOR_ID,
                productId
            })),
            { vendorId: dependencies.HP_VENDOR_ID, productId: dependencies.HP_LEGACY_PRODUCT_ID },
            { vendorId: dependencies.NUMWORKS_VENDOR_ID, productId: dependencies.NUMWORKS_PRODUCT_ID },
            { vendorId: dependencies.CASIO_VENDOR_ID, productId: dependencies.CASIO_SERIAL_PRODUCT_ID },
            { vendorId: dependencies.SHARP_VENDOR_ID, productId: dependencies.SHARP_PRODUCT_ID }
        ];
    }

    async function requestSupportedWebUsbDevice() {
        if (!dependencies.navigator.usb) {
            throw new Error(dependencies.t('numworks_webusb_required'));
        }
        try {
            return await dependencies.navigator.usb.requestDevice({
                filters: dependencies.getSupportedWebUsbFilters()
            });
        } catch (error) {
            if (error?.name === 'NotFoundError') {
                dependencies.console.warn('No supported WebUSB calculator was selected');
                return null;
            }
            dependencies.console.error('WebUSB device selection failed:', error);
            throw error;
        }
    }

    async function getAuthorizedSupportedWebUsbDevices() {
        if (!dependencies.navigator.usb) {
            return [];
        }
        try {
            return (await dependencies.navigator.usb.getDevices()).filter(device =>
                dependencies.getWebUsbDeviceFamily(device) !== null
            );
        } catch (error) {
            dependencies.console.error('Failed to get authorized WebUSB calculators:', error);
            return [];
        }
    }

    function isHPPrimeDevice(device) {
        return device
            && device.vendorId === dependencies.HP_VENDOR_ID
            && dependencies.HP_PRIME_PRODUCT_IDS.has(device.productId);
    }

    function isHPLegacyDevice(device) {
        return dependencies.globalThis.WebTILPHPLegacy?.isHpLegacyUsbDevice?.(device)
            ?? Boolean(device && device.vendorId === dependencies.HP_VENDOR_ID
                && device.productId === dependencies.HP_LEGACY_PRODUCT_ID);
    }

    async function requestHPPrimeDevice(discoveryUsbDevice = null) {
        if (!dependencies.navigator.hid) {
            throw new Error(dependencies.t('webhid_unsupported_error'));
        }
        if (!dependencies.self.isSecureContext) {
            throw new Error(dependencies.t('webhid_secure_context_error'));
        }
        if (discoveryUsbDevice && !dependencies.isHPPrimeDevice(discoveryUsbDevice)) {
            throw new Error('The selected WebUSB device is not a supported HP Prime.');
        }
        try {
            const productIds = discoveryUsbDevice
                ? [discoveryUsbDevice.productId]
                : [...dependencies.HP_PRIME_PRODUCT_IDS];
            const devices = await dependencies.navigator.hid.requestDevice({
                filters: productIds.map(productId => ({
                    vendorId: dependencies.HP_VENDOR_ID,
                    productId
                }))
            });
            const device = devices.find(candidate => dependencies.isHPPrimeDevice(candidate)
                && (!discoveryUsbDevice || candidate.productId === discoveryUsbDevice.productId)) || null;
            if (!device) {
                dependencies.console.warn('No HP Prime device was selected');
            }
            return device;
        } catch (error) {
            if (error && error.name === 'NotFoundError') {
                dependencies.console.warn('No HP Prime device was selected');
                return null;
            }
            dependencies.console.error('WebHID device selection failed:', error);
            throw error;
        }
    }

    async function getAuthorizedHPPrimeDevices(discoveryUsbDevice = null) {
        if (!dependencies.navigator.hid) {
            return [];
        }
        try {
            const devices = await dependencies.navigator.hid.getDevices();
            return devices.filter(device => dependencies.isHPPrimeDevice(device)
                && (!discoveryUsbDevice || device.productId === discoveryUsbDevice.productId));
        } catch (error) {
            dependencies.console.error('Failed to get authorized HP Prime devices:', error);
            return [];
        }
    }

    async function bindHPPrimeDeviceToModule(module, device) {
        if (!module || !dependencies.isHPPrimeDevice(device)) {
            return;
        }
        const state = module.__hplpWebHID || {};
        const previousDevice = state.device;
        state.queue = [];
        state.error = new Error('HP Prime WebHID device is being rebound');
        const waiters = Array.isArray(state.waiters)
            ? state.waiters.splice(0, state.waiters.length)
            : [];
        state.waiters = Array.isArray(state.waiters) ? state.waiters : [];
        for (const waiter of waiters) {
            waiter();
        }
        if (previousDevice && previousDevice !== device && state.inputHandler) {
            previousDevice.removeEventListener('inputreport', state.inputHandler);
        }
        if (previousDevice && previousDevice !== device && previousDevice.opened) {
            try {
                await previousDevice.close();
            } catch (error) {
                dependencies.console.warn('[WebTILP] Failed to close the previous HP Prime WebHID device.', error);
            }
        }
        state.device = device;
        state.reportSize = 0;
        module.__hplpWebHID = state;
    }

    function isNumWorksDevice(device) {
        return dependencies.globalThis.WebTILPNumWorks?.isNumWorksDevice?.(device)
            ?? Boolean(device
                && device.vendorId === dependencies.NUMWORKS_VENDOR_ID
                && device.productId === dependencies.NUMWORKS_PRODUCT_ID);
    }

    function isCasioDevice(device) {
        return Boolean(device
            && device.vendorId === dependencies.CASIO_VENDOR_ID
            && device.productId === dependencies.CASIO_SERIAL_PRODUCT_ID);
    }

    function getNumWorksBackendClass() {
        const Backend = dependencies.globalThis.WebTILPNumWorks?.NumWorksBackend;
        if (!Backend) {
            throw new Error(dependencies.t('numworks_backend_load_failed'));
        }
        return Backend;
    }

    async function requestNumWorksDevice() {
        if (!dependencies.navigator.usb) {
            throw new Error(dependencies.t('numworks_webusb_required'));
        }
        if (!dependencies.self.isSecureContext) {
            throw new Error('WebUSB requires HTTPS or localhost.');
        }
        try {
            const Backend = dependencies.getNumWorksBackendClass();
            return await Backend.requestDevice();
        } catch (error) {
            if (error?.name === 'NotFoundError') {
                dependencies.console.warn('No NumWorks calculator was selected');
                return null;
            }
            throw error;
        }
    }

    async function getAuthorizedNumWorksDevices() {
        if (!dependencies.navigator.usb) {
            return [];
        }
        const Backend = dependencies.getNumWorksBackendClass();
        return Backend.getAuthorizedDevices();
    }

    async function requestTICalculatorDevice() {
        // Check if WebUSB is supported
        if (!dependencies.navigator.usb) {
            throw new Error("WebUSB is not supported in this browser. Please use a recent version of Chrome/Chromium/Edge/Opera.");
        }

        try {
            const device = await dependencies.navigator.usb.requestDevice({
                filters: dependencies.TI_USB_DEVICES.map(dev => ({
                    vendorId: dependencies.TI_VENDOR_ID,
                    productId: dev.productId
                }))
            });

            dependencies.console.log("TI device selected:", device.productName || "Unknown device");
            dependencies.console.log("  Vendor ID:", "0x" + device.vendorId.toString(16).padStart(4, '0'));
            dependencies.console.log("  Product ID:", "0x" + device.productId.toString(16).padStart(4, '0'));

            return device;
        } catch (error) {
            if (error && error.name === 'NotFoundError') {
                dependencies.console.warn("No TI device was selected");
                return null;
            }
            dependencies.console.error("WebUSB device selection failed:", error);
            throw error;
        }
    }

    async function getAuthorizedDevices() {
        if (!dependencies.navigator.usb) {
            return [];
        }

        try {
            const devices = await dependencies.navigator.usb.getDevices();
            const tiDevices = devices.filter(device => device.vendorId === dependencies.TI_VENDOR_ID);

            dependencies.console.log("Found", tiDevices.length, "authorized TI device(s)");
            tiDevices.forEach((device, index) => {
                dependencies.console.log(`  [${index}] ${device.productName || 'Unknown'} (PID: 0x${device.productId.toString(16)})`);
            });

            return tiDevices;
        } catch (error) {
            dependencies.console.error("Failed to get authorized devices:", error);
            return [];
        }
    }

    function isEvoUsbDevice(device) {
        return device
            && device.vendorId === dependencies.TI_VENDOR_ID
            && device.productId === dependencies.PID_TI84_EVO_SERIAL;
    }

    function serialPortToDevice(port, options = {}) {
        const {
            usbDevice = null,
            serialKind = dependencies.SERIAL_KIND_EVO,
            productName = 'TI-83/84 Evo',
            vendorId = dependencies.TI_VENDOR_ID,
            productId = dependencies.PID_TI84_EVO_SERIAL
        } = options;
        const info = port?.getInfo ? port.getInfo() : {};
        const resolvedVendorId = info.usbVendorId || vendorId;
        const resolvedProductId = info.usbProductId || productId;
        return {
            transport: 'serial',
            serialKind,
            serialPort: port,
            vendorId: resolvedVendorId,
            productId: resolvedProductId,
            productName: usbDevice?.productName || productName,
            reset: async () => {},
            forget: async () => {
                if (port?.forget) {
                    await port.forget();
                }
            }
        };
    }

    function isSerialDevice(device = dependencies.state.authorizedDevice) {
        return device?.transport === 'serial';
    }

    function isGrayLinkSerialDevice(device = dependencies.state.authorizedDevice) {
        return dependencies.isSerialDevice(device) && device.serialKind === dependencies.SERIAL_KIND_GRAYLINK;
    }

    function isHPLegacySerialDevice(device = dependencies.state.authorizedDevice) {
        return dependencies.isSerialDevice(device) && device.serialKind === dependencies.SERIAL_KIND_HP_LEGACY;
    }

    function isHPLegacySerialPortInfo(info) {
        return info && info.usbVendorId === dependencies.HP_VENDOR_ID
            && info.usbProductId === dependencies.HP_LEGACY_PRODUCT_ID;
    }

    function hpLegacySerialPortToDevice(port, usbDevice = null) {
        return dependencies.serialPortToDevice(port, {
            usbDevice,
            serialKind: dependencies.SERIAL_KIND_HP_LEGACY,
            productName: 'Legacy HP calculator (03f0:0121)',
            vendorId: dependencies.HP_VENDOR_ID,
            productId: dependencies.HP_LEGACY_PRODUCT_ID
        });
    }

    async function requestHPLegacySerialDevice(usbDevice = null) {
        if (!dependencies.navigator.serial) throw new Error(dependencies.t('hp_legacy_webserial_required'));
        if (!dependencies.self.isSecureContext) throw new Error(dependencies.t('transport_secure_context_error'));
        const connectionGeneration = dependencies.state.hpLegacyConnectionGeneration;
        try {
            if (usbDevice && dependencies.navigator.userActivation?.isActive === false) {
                throw new dependencies.DOMException('Serial authorization requires a user gesture.', 'SecurityError');
            }
            const port = await dependencies.navigator.serial.requestPort({
                filters: [{ usbVendorId: dependencies.HP_VENDOR_ID, usbProductId: dependencies.HP_LEGACY_PRODUCT_ID }]
            });
            if (dependencies.state.hpLegacyConnectionGeneration !== connectionGeneration) {
                const cancelled = new Error('Old-HP connection attempt was cancelled.');
                cancelled.silent = true;
                cancelled.hpLegacyConnectionCancelled = true;
                throw cancelled;
            }
            return dependencies.hpLegacySerialPortToDevice(port, usbDevice);
        } catch (error) {
            if (dependencies.state.hpLegacyConnectionGeneration !== connectionGeneration) {
                error.silent = true;
                error.hpLegacyConnectionCancelled = true;
                throw error;
            }
            if (usbDevice && error?.name === 'SecurityError'
                && /user gesture|user activation/i.test(error.message)) {
                dependencies.state.pendingHPUsbDevice = usbDevice;
                error.hpLegacySerialAuthorizationRequired = true;
                throw error;
            }
            if (error?.name === 'NotFoundError') return null;
            throw error;
        }
    }

    async function requestSupportedSerialCalculatorDevice() {
        if (!dependencies.navigator.serial) throw new Error('WebSerial is not supported in this browser.');
        if (!dependencies.self.isSecureContext) throw new Error(dependencies.t('transport_secure_context_error'));
        try {
            const port = await dependencies.navigator.serial.requestPort({ filters: [
                { usbVendorId: dependencies.SHARP_VENDOR_ID, usbProductId: dependencies.SHARP_PRODUCT_ID },
                { usbVendorId: dependencies.HP_VENDOR_ID, usbProductId: dependencies.HP_LEGACY_PRODUCT_ID },
                { usbVendorId: dependencies.TI_VENDOR_ID, usbProductId: dependencies.PID_TI84_EVO_SERIAL }
            ] });
            const info = port.getInfo?.() || {};
            if (dependencies.globalThis.WebTILPSharp?.isSharpSerialInfo(info)) return dependencies.sharpSerialDevice(port);
            return dependencies.isHPLegacySerialPortInfo(info)
                ? dependencies.hpLegacySerialPortToDevice(port)
                : dependencies.serialPortToDevice(port, {
                    serialKind: dependencies.SERIAL_KIND_EVO,
                    productName: 'TI-83/84 Evo'
                });
        } catch (error) {
            if (error?.name === 'NotFoundError') return null;
            throw error;
        }
    }

    async function getAuthorizedHPLegacySerialDevices() {
        if (!dependencies.navigator.serial) return [];
        try {
            return (await dependencies.navigator.serial.getPorts())
                .filter(port => dependencies.isHPLegacySerialPortInfo(port.getInfo?.() || {}))
                .map(port => dependencies.hpLegacySerialPortToDevice(port));
        } catch (error) {
            dependencies.console.error('Failed to get authorized old-HP serial devices:', error);
            return [];
        }
    }

    function isEvoSerialDeviceInfo(info) {
        return info
            && info.usbVendorId === dependencies.TI_VENDOR_ID
            && info.usbProductId === dependencies.PID_TI84_EVO_SERIAL;
    }

    async function requestTIEvoSerialDevice(usbDevice = null) {
        const generation = dependencies.session.capture();
        if (!dependencies.navigator.serial) {
            throw new Error('WebSerial is not supported in this browser.');
        }
        if (!dependencies.self.isSecureContext) {
            throw new Error('WebSerial requires HTTPS or localhost.');
        }
        try {
            // Let the browser decide whether the current gesture permits a chooser.
            const port = await dependencies.navigator.serial.requestPort({
                filters: [{ usbVendorId: dependencies.TI_VENDOR_ID, usbProductId: dependencies.PID_TI84_EVO_SERIAL }]
            });
            dependencies.session.assertCurrent(generation);
            return dependencies.serialPortToDevice(port, { serialKind: dependencies.SERIAL_KIND_EVO, productName: 'TI-83/84 Evo' });
        } catch (error) {
            dependencies.session.assertCurrent(generation);
            if (usbDevice && error?.name === 'SecurityError'
                && /user gesture|user activation/i.test(error.message)) {
                dependencies.state.pendingEvoUsbDevice = usbDevice;
                error.evoSerialAuthorizationRequired = true;
                throw error;
            }
            if (error && error.name === 'NotFoundError') {
                dependencies.console.warn('No TI-83/84 Evo serial device was selected');
                return null;
            }
            dependencies.console.error('WebSerial device selection failed:', error);
            throw error;
        }
    }

    async function getAuthorizedSerialDevices() {
        if (await dependencies.shouldUseEvoWebUsbSerial()) {
            const devices = await dependencies.navigator.usb.getDevices();
            return devices.filter(dependencies.isEvoUsbDevice).map(dependencies.evoWebUsbSerialDevice);
        }
        if (!dependencies.navigator.serial) {
            return [];
        }
        try {
            const ports = await dependencies.navigator.serial.getPorts();
            return ports
                .filter(port => dependencies.isEvoSerialDeviceInfo(port.getInfo ? port.getInfo() : {}))
                .map(port => dependencies.serialPortToDevice(port, { serialKind: dependencies.SERIAL_KIND_EVO, productName: 'TI-83/84 Evo' }));
        } catch (error) {
            dependencies.console.error('Failed to get authorized serial devices:', error);
            return [];
        }
    }

    async function getAuthorizedEvoSerialDevice(usbDevice = null) {
        if (usbDevice && dependencies.isEvoUsbDevice(usbDevice) && await dependencies.shouldUseEvoWebUsbSerial()) {
            return dependencies.evoWebUsbSerialDevice(usbDevice);
        }
        const serialDevices = await dependencies.getAuthorizedSerialDevices();
        if (!serialDevices || !serialDevices.length) {
            return null;
        }
        if (!usbDevice) {
            return serialDevices[0];
        }
        return dependencies.serialPortToDevice(serialDevices[0].serialPort, { usbDevice, serialKind: dependencies.SERIAL_KIND_EVO, productName: 'TI-83/84 Evo' });
    }

    async function shouldUseEvoWebUsbSerial() {
        return typeof dependencies.EvoWebUsbSerial !== 'undefined' && await dependencies.EvoWebUsbSerial.shouldUse(dependencies.navigator);
    }

    function evoWebUsbSerialDevice(usbDevice) {
        const port = dependencies.EvoWebUsbSerial.createPort(usbDevice);
        dependencies.log('Using Evo CDC serial over WebUSB (native wired WebSerial unavailable).');
        return dependencies.serialPortToDevice(port, { usbDevice, serialKind: dependencies.SERIAL_KIND_EVO });
    }

    async function requestEvoSerialForUsbDevice(usbDevice) {
        const generation = dependencies.session.capture();
        if (dependencies.isSerialDevice(usbDevice) || !dependencies.isEvoUsbDevice(usbDevice)) {
            return usbDevice;
        }
        const authorizedSerial = await dependencies.getAuthorizedEvoSerialDevice(usbDevice);
        dependencies.session.assertCurrent(generation);
        if (authorizedSerial) {
            return authorizedSerial;
        }
        let serialDevice = await dependencies.requestTIEvoSerialDevice(usbDevice);
        dependencies.session.assertCurrent(generation);
        if (!serialDevice) {
            // A chained chooser can report no selection without appearing. Try
            // once more automatically before asking for a fresh Connect click.
            serialDevice = await dependencies.requestTIEvoSerialDevice(usbDevice);
            dependencies.session.assertCurrent(generation);
        }
        if (!serialDevice) {
            dependencies.state.pendingEvoUsbDevice = usbDevice;
            const error = new Error('TI-83/84 Evo serial port authorization is required.');
            error.evoSerialAuthorizationRequired = true;
            throw error;
        }
        serialDevice.productName = usbDevice.productName || serialDevice.productName;
        return serialDevice;
    }

    async function requestGrayLinkSerialDevice() {
        if (!dependencies.navigator.serial) {
            throw new Error('WebSerial is not supported in this browser.');
        }
        if (!dependencies.self.isSecureContext) {
            throw new Error('WebSerial requires HTTPS or localhost.');
        }
        try {
            const port = await dependencies.navigator.serial.requestPort();
            return dependencies.serialPortToDevice(port, {
                serialKind: dependencies.SERIAL_KIND_GRAYLINK,
                productName: 'GrayLink serial (RS232)',
                vendorId: 0,
                productId: 0
            });
        } catch (error) {
            if (error && error.name === 'NotFoundError') {
                dependencies.console.warn('No GrayLink serial port was selected');
                return null;
            }
            dependencies.console.error('WebSerial GrayLink selection failed:', error);
            throw error;
        }
    }

    function bindSerialPortToModule(module, device) {
        if (!module || !dependencies.isSerialDevice(device) || !device.serialPort) {
            return;
        }
        const current = module.__ticablesWebSerial || {};
        module.__ticablesWebSerial = {
            ...current,
            kind: device.serialKind || dependencies.SERIAL_KIND_EVO,
            port: device.serialPort
        };
    }

    function bindEvoSerialPortToModule(module, device) {
        dependencies.bindSerialPortToModule(module, device);
    }

    function hasWebUsbTransport() {
        return Boolean(dependencies.navigator.usb && dependencies.self.isSecureContext);
    }

    function hasEvoWebSerialTransport() {
        return Boolean(dependencies.navigator.serial && dependencies.self.isSecureContext);
    }

    function hasHPPrimeWebHidTransport() {
        return Boolean(dependencies.navigator.hid && dependencies.self.isSecureContext);
    }

    function hasNumWorksWebUsbTransport() {
        return Boolean(dependencies.navigator.usb && dependencies.self.isSecureContext && dependencies.globalThis.WebTILPNumWorks);
    }

    function hasAnySupportedTransport() {
        return dependencies.hasWebUsbTransport() || dependencies.hasEvoWebSerialTransport()
            || dependencies.hasHPPrimeWebHidTransport() || dependencies.hasNumWorksWebUsbTransport();
    }

    function sharpSerialDevice(port, usbDevice = null) {
        return dependencies.serialPortToDevice(port, { usbDevice, serialKind: dependencies.SERIAL_KIND_SHARP,
            vendorId: dependencies.SHARP_VENDOR_ID, productId: dependencies.SHARP_PRODUCT_ID, productName: 'Sharp EL-99xx' });
    }

    async function getAuthorizedSharpSerialDevices() {
        if (!dependencies.navigator.serial) return [];
        try {
            return (await dependencies.navigator.serial.getPorts())
                .filter(port => dependencies.globalThis.WebTILPSharp?.isSharpSerialInfo(port.getInfo?.() || {}))
                .map(port => dependencies.sharpSerialDevice(port));
        } catch (error) { dependencies.console.warn(error); return []; }
    }

    async function requestSharpSerialDevice(usbDevice = null) {
        if (!dependencies.navigator.serial) throw new Error(dependencies.t('sharp_serial_required'));
        if (!dependencies.self.isSecureContext) throw new Error(dependencies.t('transport_secure_context_error'));
        const generation = dependencies.state.sharpConnectionGeneration;
        try {
            const port = await dependencies.navigator.serial.requestPort({ filters: [{
                usbVendorId: dependencies.SHARP_VENDOR_ID, usbProductId: dependencies.SHARP_PRODUCT_ID
            }] });
            if (generation !== dependencies.state.sharpConnectionGeneration) {
                const error = new Error('Sharp connection cancelled.');
                error.sharpConnectionCancelled = true; throw error;
            }
            return dependencies.sharpSerialDevice(port, usbDevice);
        } catch (error) {
            if (generation !== dependencies.state.sharpConnectionGeneration) {
                error.sharpConnectionCancelled = true; throw error;
            }
            if (usbDevice && error?.name === 'SecurityError') {
                dependencies.state.pendingSharpUsbDevice = usbDevice;
                error.sharpSerialAuthorizationRequired = true;
            }
            if (error?.name === 'NotFoundError') return null;
            throw error;
        }
    }

    return { getWebUsbDeviceFamily, getSupportedWebUsbFilters, requestSupportedWebUsbDevice, getAuthorizedSupportedWebUsbDevices, isHPPrimeDevice, isHPLegacyDevice, requestHPPrimeDevice, getAuthorizedHPPrimeDevices, bindHPPrimeDeviceToModule, isNumWorksDevice, isCasioDevice, getNumWorksBackendClass, requestNumWorksDevice, getAuthorizedNumWorksDevices, requestTICalculatorDevice, getAuthorizedDevices, isEvoUsbDevice, serialPortToDevice, isSerialDevice, isGrayLinkSerialDevice, isHPLegacySerialDevice, isHPLegacySerialPortInfo, hpLegacySerialPortToDevice, requestHPLegacySerialDevice, requestSupportedSerialCalculatorDevice, getAuthorizedHPLegacySerialDevices, isEvoSerialDeviceInfo, requestTIEvoSerialDevice, getAuthorizedSerialDevices, getAuthorizedEvoSerialDevice, shouldUseEvoWebUsbSerial, evoWebUsbSerialDevice, requestEvoSerialForUsbDevice, requestGrayLinkSerialDevice, bindSerialPortToModule, bindEvoSerialPortToModule, hasWebUsbTransport, hasEvoWebSerialTransport, hasHPPrimeWebHidTransport, hasNumWorksWebUsbTransport, hasAnySupportedTransport, sharpSerialDevice, getAuthorizedSharpSerialDevices, requestSharpSerialDevice };
}

module.exports = { createTransportBrowserDevices };
