'use strict';

/**
 * features connections. Browser and application dependencies are injected
 * by app.js; importing this module does not start the application.
 * @param {object} dependencies
 * @returns {object}
 */
function createFeaturesConnections(dependencies) {
    async function initModule() {
        dependencies.ensureSupportedTransport();
        if (!dependencies.window.crossOriginIsolated) {
            throw new Error('WebTILP could not enable browser isolation. Allow service workers and reload the page.');
        }
        return dependencies.session.initialize(() => {
            dependencies.setStatus('status_loading_module', false);
            const generation = dependencies.session.capture();
            let candidate = null;
            const touchProgress = () => {
                if (generation === dependencies.session.capture() || (candidate && dependencies.state.module === candidate)) {
                    dependencies.state.lastProgressTs = Date.now();
                }
            };
            return Promise.resolve(dependencies.TILibsModule(dependencies.makeModulePrintHandlers(touchProgress))).then(module => {
                candidate = module;
                return module;
            });
        }, async module => {
            module.__progressTick = () => {
                if (dependencies.state.module === module) dependencies.state.lastProgressTs = Date.now();
            };
            // The scheduler owns the suspended initialization call too. The module
            // is published only after native initialization and settings finish.
            await dependencies.ccallAsync(module, 'init', 'number', [], []);
            dependencies.applySettingsToModule(module);
            dependencies.log('WASM module initialized.');
            dependencies.setStatus('status_module_ready', true);
        });
    }

    async function authorizeDevice(forcePrompt = false, selectedUsbDevice = null) {
        const generation = dependencies.session.capture();
        const module = await dependencies.initModule();
        dependencies.session.assertCurrent(generation);
        const mustPrompt = forcePrompt || dependencies.state.needsReauthorize;
        const selectedCalcModel = String(dependencies.state.settings?.calcModel ?? '');
        const selectedCableModel = String(dependencies.state.settings?.cableModel ?? 'auto');
        const wantsGrayLink = selectedCableModel === dependencies.CABLE_GRAYLINK;
        const wantsEvoSerial = selectedCalcModel === '48' || selectedCalcModel === '49' || selectedCalcModel === '50';
        if (wantsGrayLink) {
            if (!dependencies.ensureGrayLinkModelSelected()) {
                const modelError = new Error('GrayLink requires a calculator model selection.');
                modelError.silent = true;
                throw modelError;
            }
            let device = dependencies.isGrayLinkSerialDevice(selectedUsbDevice)
                ? selectedUsbDevice
                : !mustPrompt && dependencies.isGrayLinkSerialDevice(dependencies.state.authorizedDevice)
                    ? dependencies.state.authorizedDevice : null;
            if (!device) {
                device = await dependencies.requestGrayLinkSerialDevice();
                dependencies.session.assertCurrent(generation);
            }
            if (!device) {
                const cancelError = new Error('No GrayLink serial port selected.');
                cancelError.silent = true;
                throw cancelError;
            }
            dependencies.bindSerialPortToModule(module, device);
            dependencies.state.authorizedDevice = device;
            dependencies.state.deviceModelName = device.productName || dependencies.state.deviceModelName;
            dependencies.updateDeviceModelDisplay();
            if (dependencies.state.needsReauthorize) {
                dependencies.state.needsReauthorize = false;
                dependencies.state.silentReconnectInProgress = false;
                dependencies.setStatus('status_connected', true);
            }
            return device;
        }
        if (selectedUsbDevice) {
            if (dependencies.getWebUsbDeviceFamily(selectedUsbDevice) !== dependencies.DEVICE_FAMILY_TI) {
                throw new Error('The selected WebUSB device is not a supported TI calculator.');
            }
            const device = await dependencies.requestEvoSerialForUsbDevice(selectedUsbDevice);
            dependencies.session.assertCurrent(generation);
            if (!device) {
                const cancelError = new Error('TI-83/84 Evo serial port authorization is required.');
                cancelError.silent = true;
                throw cancelError;
            }
            if (dependencies.isSerialDevice(device)) {
                dependencies.bindSerialPortToModule(module, device);
            }
            dependencies.state.authorizedDevice = device;
            if (!dependencies.hasSilverlinkConnected()) {
                dependencies.state.deviceModelName = device.productName || dependencies.state.deviceModelName;
            }
            dependencies.updateDeviceModelDisplay();
            return device;
        }
        if (!dependencies.navigator.usb) {
            let device = null;
            if (!mustPrompt) {
                device = await dependencies.getAuthorizedEvoSerialDevice();
                dependencies.session.assertCurrent(generation);
            }
            if (!device) {
                device = await dependencies.requestTIEvoSerialDevice();
                dependencies.session.assertCurrent(generation);
            }
            if (!device) {
                const cancelError = new Error('No TI-83/84 Evo serial device selected.');
                cancelError.silent = true;
                throw cancelError;
            }
            dependencies.bindSerialPortToModule(module, device);
            dependencies.state.authorizedDevice = device;
            dependencies.state.deviceModelName = device.productName || dependencies.state.deviceModelName;
            dependencies.updateDeviceModelDisplay();
            if (dependencies.state.needsReauthorize) {
                dependencies.state.needsReauthorize = false;
                dependencies.state.silentReconnectInProgress = false;
                dependencies.setStatus('status_connected', true);
            }
            return device;
        }
        if (!mustPrompt && dependencies.getAuthorizedDevices) {
            const devices = await dependencies.getAuthorizedDevices();
            dependencies.session.assertCurrent(generation);
            if (devices && devices.length) {
                const usbDevice = wantsEvoSerial
                    ? (devices.find(dependencies.isEvoUsbDevice) || devices[0])
                    : devices[0];
                const device = dependencies.isEvoUsbDevice(usbDevice)
                    ? await dependencies.getAuthorizedEvoSerialDevice(usbDevice)
                    : usbDevice;
                dependencies.session.assertCurrent(generation);
                if (!device) {
                    const cancelError = new Error('TI-83/84 Evo serial port authorization is required.');
                    cancelError.silent = true;
                    throw cancelError;
                }
                if (!dependencies.deviceMatches(dependencies.state.authorizedDevice, device)) {
                    dependencies.log(`Using authorized device: ${device.productName || 'Unknown'}`);
                }
                dependencies.state.authorizedDevice = device;
                if (!dependencies.hasSilverlinkConnected()) {
                    dependencies.state.deviceModelName = device.productName || dependencies.state.deviceModelName;
                }
                dependencies.updateDeviceModelDisplay();
                return device;
            }
        }
        let device = await dependencies.requestTICalculatorDevice();
        dependencies.session.assertCurrent(generation);
        device = await dependencies.requestEvoSerialForUsbDevice(device);
        dependencies.session.assertCurrent(generation);
        if (!device) {
            const cancelError = new Error('No device selected.');
            cancelError.silent = true;
            throw cancelError;
        }
        dependencies.state.authorizedDevice = device;
        if (!dependencies.hasSilverlinkConnected()) {
            dependencies.state.deviceModelName = device?.productName || dependencies.state.deviceModelName;
        }
        dependencies.updateDeviceModelDisplay();
        if (dependencies.state.needsReauthorize) {
            dependencies.state.needsReauthorize = false;
            dependencies.state.silentReconnectInProgress = false;
            dependencies.setStatus('status_connected', true);
        }
        return device;
    }

    async function authorizeHPPrimeDevice(forcePrompt = false, discoveryUsbDevice = null) {
        const generation = dependencies.session.capture();
        let device = !forcePrompt && dependencies.isHPPrimeDevice(dependencies.state.authorizedDevice)
            && (!discoveryUsbDevice || dependencies.state.authorizedDevice.productId === discoveryUsbDevice.productId)
            ? dependencies.state.authorizedDevice
            : null;
        if (!device && !forcePrompt) {
            const devices = await dependencies.getAuthorizedHPPrimeDevices(discoveryUsbDevice);
            dependencies.session.assertCurrent(generation);
            device = devices[0] || null;
        }
        if (!device && forcePrompt) {
            device = await dependencies.requestHPPrimeDevice(discoveryUsbDevice);
            dependencies.session.assertCurrent(generation);
        }
        if (!device) {
            const cancelError = new Error(dependencies.t('hp_prime_no_device_selected'));
            cancelError.silent = true;
            throw cancelError;
        }
        dependencies.state.authorizedDevice = device;
        return device;
    }

    async function authorizeCasioDevice(forcePrompt = false, selectedUsbDevice = null) {
        const generation = dependencies.session.capture();
        let device = selectedUsbDevice;
        if (device && !dependencies.isCasioDevice(device)) {
            throw new Error(dependencies.t('casio_unsupported_usb_device'));
        }
        if (!device && !forcePrompt && dependencies.isCasioDevice(dependencies.state.authorizedDevice)) {
            device = dependencies.state.authorizedDevice;
        }
        if (!device && !forcePrompt && dependencies.navigator.usb) {
            const devices = await dependencies.navigator.usb.getDevices();
            dependencies.session.assertCurrent(generation);
            device = devices.find(dependencies.isCasioDevice) || null;
        }
        if (!device && forcePrompt) {
            if (!dependencies.navigator.usb || !dependencies.self.isSecureContext) {
                throw new Error(dependencies.t('casio_webusb_required'));
            }
            try {
                device = await dependencies.navigator.usb.requestDevice({
                    filters: [{
                        vendorId: dependencies.CASIO_VENDOR_ID,
                        productId: dependencies.CASIO_SERIAL_PRODUCT_ID
                    }]
                });
                dependencies.session.assertCurrent(generation);
            } catch (error) {
                dependencies.session.assertCurrent(generation);
                if (error?.name !== 'NotFoundError') {
                    throw error;
                }
            }
        }
        if (!device) {
            const cancelError = new Error(dependencies.t('casio_no_device_selected'));
            cancelError.silent = true;
            throw cancelError;
        }
        dependencies.state.authorizedDevice = device;
        return device;
    }

    async function connectHPLegacy(forcePrompt = true, selectedUsbDevice = null,
        selectedSerialDevice = null) {
        const Backend = dependencies.globalThis.WebTILPHPLegacy?.HpLegacyBackend;
        if (!Backend) throw new Error(dependencies.t('hp_legacy_backend_load_failed'));
        const connectionGeneration = ++dependencies.state.hpLegacyConnectionGeneration;
        let enableKermit = false;
        let backend = null;
        let modelInfo = null;
        let activeDevice = selectedSerialDevice || selectedUsbDevice;
        if (selectedSerialDevice) {
            backend = new Backend({ serialPort: selectedSerialDevice.serialPort });
            await backend.connect({ enableKermit: false });
        } else {
            const usbDevice = selectedUsbDevice || (forcePrompt
                ? await dependencies.navigator.usb?.requestDevice({ filters: [{
                    vendorId: dependencies.HP_VENDOR_ID, productId: dependencies.HP_LEGACY_PRODUCT_ID
                }] }) : null);
            if (!usbDevice) throw new Error(dependencies.t('hp_legacy_no_device_selected'));
            activeDevice = usbDevice;
            backend = new Backend({ usbDevice });
            try {
                await backend.connect({ enableKermit: false });
            } catch (usbError) {
                if (!dependencies.navigator.serial) throw usbError;
                const authorized = (await dependencies.getAuthorizedHPLegacySerialDevices())[0] || null;
                if (dependencies.state.hpLegacyConnectionGeneration !== connectionGeneration) {
                    await backend.close().catch(() => {});
                    const cancelled = new Error('Old-HP connection attempt was cancelled.');
                    cancelled.silent = true;
                    cancelled.hpLegacyConnectionCancelled = true;
                    throw cancelled;
                }
                const serialDevice = authorized || await dependencies.requestHPLegacySerialDevice(usbDevice);
                if (!serialDevice) {
                    const cancelled = new Error(dependencies.t('hp_legacy_no_device_selected'));
                    cancelled.silent = true;
                    cancelled.hpLegacySerialSelectionCancelled = true;
                    throw cancelled;
                }
                backend = new Backend({ serialPort: serialDevice.serialPort });
                await backend.connect({ enableKermit: false });
                activeDevice = serialDevice;
                dependencies.log(dependencies.t('hp_legacy_webusb_fallback_serial'));
            }
        }
        if (dependencies.state.hpLegacyConnectionGeneration !== connectionGeneration) {
            await backend.close().catch(() => {});
            const cancelled = new Error('Old-HP connection attempt was cancelled.');
            cancelled.silent = true;
            cancelled.hpLegacyConnectionCancelled = true;
            throw cancelled;
        }
        // Arm the asynchronous USB/serial read before the prompt.  The prompt
        // tells the user to dismiss it before restarting SERVER, so initialize()
        // has sent I0 and is waiting when the fresh session becomes ready.
        enableKermit = dependencies.confirm(dependencies.t('hp_legacy_protocol_prompt'));
        backend.setKermitEnabled(enableKermit);
        if (enableKermit) {
            try {
                modelInfo = await backend.detectModel();
            } catch (error) {
                await backend.close().catch(() => {});
                if (dependencies.state.hpLegacyConnectionGeneration !== connectionGeneration) {
                    const cancelled = new Error('Old-HP connection attempt was cancelled.');
                    cancelled.silent = true;
                    cancelled.hpLegacyConnectionCancelled = true;
                    throw cancelled;
                }
                throw error;
            }
            if (dependencies.state.hpLegacyConnectionGeneration === connectionGeneration) {
                try {
                    modelInfo.serialText = await backend.readSerialNumber();
                } catch (error) {
                    dependencies.log(`HP SERIAL information unavailable: ${error?.message || String(error)}`);
                }
            }
        }
        if (dependencies.state.hpLegacyConnectionGeneration !== connectionGeneration) {
            await backend.close().catch(() => {});
            const cancelled = new Error('Old-HP connection attempt was cancelled.');
            cancelled.silent = true;
            cancelled.hpLegacyConnectionCancelled = true;
            throw cancelled;
        }
        dependencies.state.hpLegacyBackend = backend;
        dependencies.state.hpLegacyKermitEnabled = enableKermit;
        dependencies.state.hpLegacyModelInfo = modelInfo;
        dependencies.state.authorizedDevice = activeDevice;
        dependencies.state.activeFamily = dependencies.DEVICE_FAMILY_HP_LEGACY;
        dependencies.state.handle = 0;
        dependencies.state.cableOpen = true;
        dependencies.state.features = enableKermit
            ? dependencies.FEATURE_FLAGS.OPS_SCREEN | dependencies.FEATURE_FLAGS.OPS_DIRLIST
                | dependencies.FEATURE_FLAGS.OPS_VARS : 0;
        dependencies.state.dirlist = [];
        dependencies.applyActiveFamilyUiState();
        dependencies.readHPLegacyInfo();
        dependencies.renderDirlist([]);
        dependencies.setConnected(true);
        dependencies.setStatus('status_connected', true);
        dependencies.log(enableKermit ? dependencies.t('hp_legacy_connected_kermit')
            : dependencies.t('hp_legacy_connected_transport_only'));
    }

    async function connectCasio(forcePrompt = true, selectedUsbDevice = null) {
        const generation = dependencies.session.capture();
        const device = await dependencies.authorizeCasioDevice(forcePrompt, selectedUsbDevice);
        dependencies.session.assertCurrent(generation);
        const module = await dependencies.initModule();
        dependencies.session.assertCurrent(generation);
        const result = await dependencies.ccallAsync(module, 'casio_connect', 'number', [], [], {
            timeoutMs: 30000,
            useProgress: true,
            progressLabel: dependencies.t('casio_progress_connecting'),
            prepareCall() {
                // Scope exact-device selection to actual native execution, including
                // a suspended call that outlives its JavaScript timeout.
                const hadDeviceFilter = Object.prototype.hasOwnProperty.call(module, 'webusbDeviceFilter');
                const previousDeviceFilter = module.webusbDeviceFilter;
                module.webusbDeviceFilter = candidate => candidate === device;
                return () => {
                    if (hadDeviceFilter) module.webusbDeviceFilter = previousDeviceFilter;
                    else delete module.webusbDeviceFilter;
                };
            }
        });
        dependencies.session.assertCurrent(generation);
        if (result !== 0) {
            throw new Error(dependencies.tFormat('casio_connection_failed', {
                error: dependencies.formatCasioError(module, result)
            }));
        }
        dependencies.state.handle = 0;
        dependencies.state.cableOpen = true;
        dependencies.state.activeFamily = dependencies.DEVICE_FAMILY_CASIO;
        dependencies.state.casioFileSnapshotLoaded = false;
        const info = dependencies.readCasioInfo(module);
        const model = dependencies.state.deviceModelName;
        if (dependencies.state.casioStorageSupported) {
            const listResult = await dependencies.ccallAsync(module, 'casio_refresh_files', 'number', [], [], {
                timeoutMs: null,
                useProgress: true,
                progressLabel: dependencies.t('casio_progress_loading_files')
            });
            if (listResult === 0) {
                const count = dependencies.applyCasioStorageSnapshot(module);
                dependencies.log(dependencies.tFormat('casio_files_loaded', { count }));
            } else {
                dependencies.log(dependencies.tFormat('casio_file_listing_failed', {
                    error: dependencies.formatCasioError(module, listResult)
                }));
            }
        } else {
            dependencies.state.features = 0;
            dependencies.state.dirlist = [];
            dependencies.renderDirlist(dependencies.state.dirlist);
            dependencies.log(dependencies.t('casio_storage_protocol_unavailable'));
        }
        dependencies.setConnected(true);
        dependencies.setStatus('status_connected', true);
        dependencies.log(dependencies.tFormat('casio_connected', { model, protocol: info.protocol }));
    }

    function scheduleHPPrimeProgressRender(module, generation) {
        if (dependencies.state.hpFileRenderGeneration === generation) {
            return;
        }
        dependencies.state.hpFileRenderGeneration = generation;
        dependencies.requestAnimationFrame(() => {
            if (dependencies.state.hpFileRenderGeneration !== generation) {
                return;
            }
            dependencies.state.hpFileRenderGeneration = 0;
            if (dependencies.state.module !== module
                || dependencies.state.hpFileRefreshGeneration !== generation
                || !dependencies.isHPPrimeActive()) {
                return;
            }
            dependencies.renderDirlist(dependencies.state.dirlist);
        });
    }

    async function authorizeNumWorksDevice(forcePrompt = false) {
        const generation = dependencies.session.capture();
        let device = !forcePrompt && dependencies.isNumWorksDevice(dependencies.state.authorizedDevice)
            ? dependencies.state.authorizedDevice
            : null;
        if (!device && !forcePrompt) {
            const devices = await dependencies.getAuthorizedNumWorksDevices();
            dependencies.session.assertCurrent(generation);
            device = devices[0] || null;
        }
        if (!device) {
            device = await dependencies.requestNumWorksDevice();
            dependencies.session.assertCurrent(generation);
        }
        if (!device) {
            const cancelError = new Error(dependencies.t('numworks_no_device_selected'));
            cancelError.silent = true;
            throw cancelError;
        }
        dependencies.state.authorizedDevice = device;
        return device;
    }

    async function connectNumWorks(forcePrompt = true) {
        const generation = dependencies.session.capture();
        const device = await dependencies.authorizeNumWorksDevice(forcePrompt);
        dependencies.session.assertCurrent(generation);
        await dependencies.state.numWorksBackend?.close().catch(error => {
            dependencies.console.warn('[WebTILP] Failed to close the previous NumWorks session.', error);
        });
        dependencies.session.assertCurrent(generation);
        dependencies.state.numWorksBackend = null;
        const Backend = dependencies.getNumWorksBackendClass();
        const backend = new Backend({
            onProgress() {
                dependencies.state.lastProgressTs = Date.now();
            }
        });
        try {
            await backend.connect(device);
            dependencies.session.assertCurrent(generation);
        } catch (error) {
            await backend.close().catch(() => {});
            throw error;
        }
        dependencies.state.numWorksBackend = backend;
        dependencies.state.handle = 0;
        dependencies.state.cableOpen = true;
        dependencies.state.activeFamily = dependencies.DEVICE_FAMILY_NUMWORKS;
        dependencies.state.hpFileSnapshotLoaded = false;
        dependencies.applyActiveFamilyUiState();
        dependencies.readNumWorksInfo();
        const count = dependencies.applyNumWorksStorageSnapshot();
        dependencies.setConnected(true);
        dependencies.setStatus('status_connected', true);
        dependencies.log(dependencies.tFormat('numworks_connected', { model: dependencies.state.deviceModelName, count }));
        if (!backend.getInfo().storageValid) {
            dependencies.log(dependencies.t('numworks_storage_recovery_warning'));
        }
    }

    async function connectHPPrime(forcePrompt = true, discoveryUsbDevice = null) {
        const generation = dependencies.session.capture();
        const device = await dependencies.authorizeHPPrimeDevice(forcePrompt, discoveryUsbDevice);
        dependencies.session.assertCurrent(generation);
        const module = await dependencies.initModule();
        dependencies.session.assertCurrent(generation);
        await dependencies.bindHPPrimeDeviceToModule(module, device);
        dependencies.session.assertCurrent(generation);
        const result = await dependencies.ccallAsync(module, 'hp_prime_connect', 'number', [], [], {
            timeoutMs: 30000,
            useProgress: true,
            progressLabel: dependencies.t('hp_prime_progress_connecting')
        });
        dependencies.session.assertCurrent(generation);
        if (result !== 0) {
            throw new Error(dependencies.tFormat('hp_prime_connection_failed', {
                error: dependencies.formatHPPrimeError(module, result)
            }));
        }
        dependencies.state.handle = 0;
        dependencies.state.cableOpen = true;
        dependencies.state.activeFamily = dependencies.DEVICE_FAMILY_HP_PRIME;
        dependencies.applyActiveFamilyUiState();
        dependencies.readHPPrimeInfo(module);
        dependencies.setConnected(true);
        dependencies.setStatus('status_connected', true);
        dependencies.log(dependencies.tFormat('hp_prime_connected', { model: dependencies.getHPPrimeModelName() }));
    }

    async function autoConnectIfAuthorized() {
        const generation = dependencies.session.capture();
        if (!dependencies.hasAnySupportedTransport()) {
            return;
        }
        if (dependencies.state.connectInProgress) {
            return;
        }
        const sharpPorts = await dependencies.getAuthorizedSharpSerialDevices();
        dependencies.session.assertCurrent(generation);
        if (String(dependencies.state.settings?.calcModel).startsWith('sharp-')) {
            if (sharpPorts.length === 1) {
                dependencies.state.connectInProgress = true;
                try { await dependencies.connectSharp(null, sharpPorts[0]); }
                catch (error) { dependencies.logError(error, dependencies.t('sharp_operation_failed')); }
                finally { if (generation === dependencies.session.capture()) dependencies.state.connectInProgress = false; }
            }
            return;
        }
        let autoDetectedTiDevice = null;
        const devices = dependencies.navigator.usb ? await dependencies.getAuthorizedSupportedWebUsbDevices() : [];
        dependencies.session.assertCurrent(generation);
        if (devices.length > 1) {
            return;
        }
        if (devices.length === 1) {
            const device = devices[0];
            const detectedFamily = dependencies.getWebUsbDeviceFamily(device);
            if (detectedFamily === dependencies.DEVICE_FAMILY_SHARP) {
                if (sharpPorts.length === 1) {
                    dependencies.state.connectInProgress = true;
                    try { await dependencies.connectSharp(device, sharpPorts[0]); }
                    catch (error) { dependencies.logError(error, dependencies.t('sharp_operation_failed')); }
                    finally { if (generation === dependencies.session.capture()) dependencies.state.connectInProgress = false; }
                }
                return;
            }
            if (detectedFamily === dependencies.DEVICE_FAMILY_NUMWORKS) {
                try {
                    dependencies.state.connectInProgress = true;
                    dependencies.state.authorizedDevice = device;
                    await dependencies.connectNumWorks(false);
                    dependencies.session.assertCurrent(generation);
                    dependencies.log(dependencies.t('numworks_auto_connected'));
                } catch (err) {
                    dependencies.logError(err, dependencies.t('numworks_auto_connect_failed'));
                } finally {
                    if (generation === dependencies.session.capture()) dependencies.state.connectInProgress = false;
                }
                return;
            }
            if (detectedFamily === dependencies.DEVICE_FAMILY_CASIO) {
                try {
                    dependencies.state.connectInProgress = true;
                    dependencies.state.authorizedDevice = device;
                    await dependencies.connectCasio(false, device);
                    dependencies.session.assertCurrent(generation);
                    dependencies.log(dependencies.t('casio_auto_connected'));
                } catch (err) {
                    dependencies.logError(err, dependencies.t('casio_auto_connect_failed'));
                } finally {
                    if (generation === dependencies.session.capture()) dependencies.state.connectInProgress = false;
                }
                return;
            }
            if (detectedFamily === dependencies.DEVICE_FAMILY_HP_LEGACY) {
                try {
                    dependencies.state.connectInProgress = true;
                    dependencies.state.authorizedDevice = device;
                    await dependencies.connectHPLegacy(false, device);
                    dependencies.session.assertCurrent(generation);
                    dependencies.log(dependencies.t('hp_legacy_auto_connected'));
                } catch (err) {
                    dependencies.logError(err, dependencies.t('hp_legacy_auto_connect_failed'));
                } finally {
                    if (generation === dependencies.session.capture()) dependencies.state.connectInProgress = false;
                }
                return;
            }
            if (detectedFamily === dependencies.DEVICE_FAMILY_HP_PRIME) {
                const hpDevices = await dependencies.getAuthorizedHPPrimeDevices(device);
                dependencies.session.assertCurrent(generation);
                if (hpDevices.length === 1) {
                    try {
                        dependencies.state.connectInProgress = true;
                        dependencies.state.authorizedDevice = hpDevices[0];
                        await dependencies.connectHPPrime(false, device);
                        dependencies.session.assertCurrent(generation);
                        dependencies.log(dependencies.t('hp_prime_auto_connected'));
                    } catch (err) {
                        dependencies.logError(err, dependencies.t('hp_prime_auto_connect_failed'));
                    } finally {
                        if (generation === dependencies.session.capture()) dependencies.state.connectInProgress = false;
                    }
                }
                return;
            }
            autoDetectedTiDevice = device;
        } else if (dependencies.hasHPPrimeWebHidTransport()) {
            const hpDevices = await dependencies.getAuthorizedHPPrimeDevices();
            dependencies.session.assertCurrent(generation);
            if (hpDevices.length === 1) {
                try {
                    dependencies.state.connectInProgress = true;
                    dependencies.state.authorizedDevice = hpDevices[0];
                    await dependencies.connectHPPrime(false);
                    dependencies.session.assertCurrent(generation);
                    dependencies.log(dependencies.t('hp_prime_auto_connected'));
                } catch (err) {
                    dependencies.logError(err, dependencies.t('hp_prime_auto_connect_failed'));
                } finally {
                    if (generation === dependencies.session.capture()) dependencies.state.connectInProgress = false;
                }
                return;
            }
        }
        if (devices.length === 0 && dependencies.navigator.serial) {
            let ports;
            try { ports = await dependencies.navigator.serial.getPorts(); } catch (error) { dependencies.console.warn(error); return; }
            dependencies.session.assertCurrent(generation);
            const supportedPorts = ports.filter(port => {
                const info = port.getInfo?.() || {};
                return dependencies.globalThis.WebTILPSharp?.isSharpSerialInfo(info)
                    || dependencies.isHPLegacySerialPortInfo(info) || dependencies.isEvoSerialDeviceInfo(info);
            });
            if (supportedPorts.length > 1) return;
            if (sharpPorts.length === 1) {
                dependencies.state.connectInProgress = true;
                try { await dependencies.connectSharp(null, sharpPorts[0]); }
                catch (error) { dependencies.logError(error, dependencies.t('sharp_operation_failed')); }
                finally { if (generation === dependencies.session.capture()) dependencies.state.connectInProgress = false; }
                return;
            }
            const oldHpSerialDevices = await dependencies.getAuthorizedHPLegacySerialDevices();
            dependencies.session.assertCurrent(generation);
            if (oldHpSerialDevices.length === 1) {
                try {
                    dependencies.state.connectInProgress = true;
                    await dependencies.connectHPLegacy(false, null, oldHpSerialDevices[0]);
                    dependencies.session.assertCurrent(generation);
                    dependencies.log(dependencies.t('hp_legacy_auto_connected'));
                } catch (err) {
                    dependencies.logError(err, dependencies.t('hp_legacy_auto_connect_failed'));
                } finally {
                    if (generation === dependencies.session.capture()) dependencies.state.connectInProgress = false;
                }
                return;
            }
        }
        if (String(dependencies.state.settings?.cableModel ?? 'auto') === dependencies.CABLE_GRAYLINK) {
            return;
        }
        if (dependencies.state.connectInProgress) {
            return;
        }
        const module = await dependencies.initModule();
        dependencies.session.assertCurrent(generation);
        if (!dependencies.navigator.usb) {
            const serialDevice = await dependencies.getAuthorizedEvoSerialDevice();
            dependencies.session.assertCurrent(generation);
            if (!serialDevice) {
                return;
            }
            dependencies.state.authorizedDevice = serialDevice;
        } else {
            if (!dependencies.getAuthorizedDevices) {
                return;
            }
            const devices = autoDetectedTiDevice
                ? [autoDetectedTiDevice]
                : await dependencies.getAuthorizedDevices();
            dependencies.session.assertCurrent(generation);
            if (!devices || !devices.length) {
                return;
            }

            const usbDevice = devices[0];
            if (dependencies.isEvoUsbDevice(usbDevice)) {
                const serialDevice = await dependencies.getAuthorizedEvoSerialDevice(usbDevice);
                dependencies.session.assertCurrent(generation);
                if (!serialDevice) {
                    return;
                }
                dependencies.state.authorizedDevice = serialDevice;
            } else {
                dependencies.state.authorizedDevice = usbDevice;
            }
        }

        if (dependencies.isNspireActive()) {
            // Nspires can't reconnect automatically, let's USB reset and ask the user for the device again
            dependencies.console.warn('[WebTILP] Nspire detected, will reset+forget for a fresh start.');
            await dependencies.ensureCableOpen();
            dependencies.session.assertCurrent(generation);
            await dependencies.nukeConnection(false);
            dependencies.session.assertCurrent(generation);
            return;
        }

        const pid = dependencies.state.authorizedDevice.productId;
        const cableSetting = dependencies.state.settings?.cableModel ?? 'auto';
        const calcSetting = dependencies.state.settings?.calcModel ?? 'auto';
        const canAutoConnectDirect = dependencies.DIRECTLINK_PIDS.has(pid) && (cableSetting === dependencies.CABLE_DIRECTLINK || cableSetting === 'auto');
        const canAutoConnectSilver = pid === dependencies.PID_SILVERLINK && cableSetting === dependencies.CABLE_SILVERLINK && calcSetting !== 'auto';

        if (!canAutoConnectDirect && !canAutoConnectSilver) {
            return;
        }

        try {
            if (dependencies.state.connectInProgress) {
                return;
            }
            dependencies.state.connectInProgress = true;
            await dependencies.applyWebUsbDeviceCableHint(module, dependencies.state.authorizedDevice);
            dependencies.session.assertCurrent(generation);
            await dependencies.ensureCableOpen();
            dependencies.session.assertCurrent(generation);
            await dependencies.sleep(dependencies.AUTO_QUERY_DELAY_MS);
            dependencies.session.assertCurrent(generation);
            await dependencies.updateCapabilities();
            dependencies.session.assertCurrent(generation);
            await dependencies.sleep(dependencies.AUTO_QUERY_DELAY_MS);
            dependencies.session.assertCurrent(generation);
            if (!dependencies.isTi92Selected()) {
                await dependencies.getDeviceInfo();
                dependencies.session.assertCurrent(generation);
            } else {
                dependencies.log('Skipping automatic device info query for TI-92.');
            }
            dependencies.setConnected(true);
            dependencies.setStatus('status_connected', true);
            dependencies.log('Auto-connected to authorized device.');
        } catch (err) {
            dependencies.logError(err, 'Auto-connect failed');
        } finally {
            if (generation === dependencies.session.capture()) dependencies.state.connectInProgress = false;
        }
    }

    async function ensureHandle() {
        const generation = dependencies.session.capture();
        const module = await dependencies.initModule();
        dependencies.session.assertCurrent(generation);
        return dependencies.session.ensureHandle(async check => {
            if (dependencies.state.authorizedDevice) {
                await dependencies.applyWebUsbDeviceCableHint(module, dependencies.state.authorizedDevice);
                check();
            }
            if (!dependencies.ensureSilverlinkModelSelected()) {
                throw new Error('SilverLink requires a calculator model selection.');
            }
            if (!dependencies.ensureGrayLinkModelSelected()) {
                throw new Error('GrayLink requires a calculator model selection.');
            }
            let handle = 0;
            for (let attempts = 0; !handle && attempts < 3; attempts += 1) {
                handle = await dependencies.ccallAsync(module, 'create_handle', 'number', [], [], { timeoutMs: 8000 });
                check();
                if (!handle) {
                    await dependencies.sleep(dependencies.CREATE_HANDLE_RETRY_DELAY_MS);
                    check();
                }
            }
            if (!handle) throw new Error('create_handle returned 0');
            dependencies.log(`Handle created: 0x${Number(handle).toString(16)}`);
            dependencies.setConnected(true);
            return handle;
        });
    }

    async function ensureCableOpen() {
        const generation = dependencies.session.capture();
        const module = await dependencies.initModule();
        dependencies.session.assertCurrent(generation);
        const handle = await dependencies.ensureHandle();
        dependencies.session.assertCurrent(generation);
        if (!handle) {
            throw new Error('No cable handle available');
        }
        if (dependencies.state.cableOpen) {
            return handle;
        }
        const result = await dependencies.ccallAsync(module, 'open_cable', 'number', ['number'], [handle], { timeoutMs: 8000 });
        dependencies.session.assertCurrent(generation);
        if (result !== 0) {
            dependencies.showCableOpenHelp(result);
            throw new Error(`open_cable failed with code ${result}`);
        }
        dependencies.state.cableOpen = true;
        dependencies.log('Cable opened.');
        return handle;
    }

    async function connectTI(forcePrompt = true, selectedUsbDevice = null) {
        const generation = dependencies.session.capture();
        dependencies.state.activeFamily = dependencies.DEVICE_FAMILY_TI;
        dependencies.applyActiveFamilyUiState();
        await dependencies.authorizeDevice(forcePrompt, selectedUsbDevice);
        dependencies.session.assertCurrent(generation);
        if (dependencies.promptCableMismatchResolution()) {
            return;
        }
        if (!dependencies.ensureSilverlinkModelSelected()) {
            return;
        }
        await dependencies.ensureCableOpen();
        dependencies.session.assertCurrent(generation);
        await dependencies.updateCapabilities();
        dependencies.session.assertCurrent(generation);
        if (!dependencies.isTi92Selected()) {
            await dependencies.getDeviceInfo();
            dependencies.session.assertCurrent(generation);
        } else {
            dependencies.log('Skipping automatic device info query for TI-92.');
        }
        dependencies.setConnected(true);
        dependencies.setStatus('status_connected', true);
        dependencies.log('Device connected.');
    }

    async function connect() {
        if (dependencies.state.connectInProgress) {
            return;
        }
        const generation = dependencies.session.capture();
        const connectAttempt = {};
        dependencies.state.connectAttempt = connectAttempt;
        dependencies.setButtonLoading(dependencies.els.btnConnect, true);
        const hadWorkingConnection = dependencies.state.connected || dependencies.state.cableOpen || Boolean(dependencies.state.handle);
        try {
            dependencies.state.connectInProgress = true;
            const wantsSharp = String(dependencies.state.settings?.calcModel).startsWith('sharp-');
            if (wantsSharp || dependencies.state.pendingSharpUsbDevice) {
                const usbDevice = dependencies.state.pendingSharpUsbDevice;
                const device = await dependencies.requestSharpSerialDevice(usbDevice);
                dependencies.session.assertCurrent(generation);
                dependencies.state.pendingSharpUsbDevice = null;
                if (!device) return;
                await dependencies.connectSharp(null, device);
                return;
            }
            const wantsGrayLink = String(dependencies.state.settings?.cableModel ?? 'auto') === dependencies.CABLE_GRAYLINK;
            if (wantsGrayLink) {
                dependencies.state.pendingHPUsbDevice = null;
                if (!dependencies.ensureGrayLinkModelSelected()) return;
                const device = await dependencies.requestGrayLinkSerialDevice();
                dependencies.session.assertCurrent(generation);
                if (!device) return;
                await dependencies.connectTI(false, device);
                return;
            }
            if (!wantsGrayLink && dependencies.state.pendingHPUsbDevice) {
                // Start the serial chooser from this fresh click before any await
                // can consume the browser's transient user activation.
                const usbDevice = dependencies.state.pendingHPUsbDevice;
                const device = await dependencies.requestHPLegacySerialDevice(usbDevice);
                dependencies.session.assertCurrent(generation);
                dependencies.state.pendingHPUsbDevice = null;
                if (!device) {
                    dependencies.setStatus(hadWorkingConnection ? 'status_connected' : 'status_select_device', hadWorkingConnection);
                    return;
                }
                await dependencies.connectHPLegacy(false, null, device);
                return;
            }
            if (!wantsGrayLink && dependencies.state.pendingEvoUsbDevice) {
                // Request directly from this fresh click, before module loading or
                // another WebUSB chooser can consume the transient user activation.
                const usbDevice = dependencies.state.pendingEvoUsbDevice;
                const device = await dependencies.requestTIEvoSerialDevice(usbDevice);
                dependencies.session.assertCurrent(generation);
                if (!device) {
                    // Cancelling also abandons this retry, so the next Connect
                    // click can select any calculator, including a non-serial one.
                    dependencies.state.pendingEvoUsbDevice = null;
                    dependencies.state.pendingHPUsbDevice = null;
                    dependencies.setStatus(hadWorkingConnection ? 'status_connected' : 'status_select_device', hadWorkingConnection);
                    return;
                }
                device.productName = usbDevice.productName || device.productName;
                dependencies.state.pendingEvoUsbDevice = null;
                dependencies.state.pendingHPUsbDevice = null;
                await dependencies.connectTI(false, device);
                return;
            }
            if (!wantsGrayLink && dependencies.hasWebUsbTransport()) {
                const device = await dependencies.requestSupportedWebUsbDevice();
                dependencies.session.assertCurrent(generation);
                if (!device) {
                    const cancelError = new Error('No calculator selected.');
                    cancelError.silent = true;
                    throw cancelError;
                }
                dependencies.state.pendingEvoUsbDevice = null;
                dependencies.state.pendingHPUsbDevice = null;
                const detectedFamily = dependencies.getWebUsbDeviceFamily(device);
                dependencies.state.authorizedDevice = device;
                if (detectedFamily === dependencies.DEVICE_FAMILY_SHARP) {
                    await dependencies.connectSharp(device);
                    return;
                }
                if (detectedFamily === dependencies.DEVICE_FAMILY_NUMWORKS) {
                    await dependencies.connectNumWorks(false);
                    return;
                }
                if (detectedFamily === dependencies.DEVICE_FAMILY_CASIO) {
                    await dependencies.connectCasio(false, device);
                    return;
                }
                if (detectedFamily === dependencies.DEVICE_FAMILY_HP_LEGACY) {
                    await dependencies.connectHPLegacy(false, device);
                    return;
                }
                if (detectedFamily === dependencies.DEVICE_FAMILY_HP_PRIME) {
                    await dependencies.connectHPPrime(true, device);
                    return;
                }
                if (detectedFamily === dependencies.DEVICE_FAMILY_TI) {
                    await dependencies.connectTI(false, device);
                    return;
                }
                throw new Error('The selected WebUSB calculator is not supported.');
            }
            if (!wantsGrayLink && !dependencies.hasWebUsbTransport() && dependencies.hasHPPrimeWebHidTransport()
                && !dependencies.hasEvoWebSerialTransport()) {
                await dependencies.connectHPPrime(true);
                return;
            }
            if (!wantsGrayLink && !dependencies.hasWebUsbTransport() && dependencies.navigator.serial) {
                const serialDevice = await dependencies.requestSupportedSerialCalculatorDevice();
                dependencies.session.assertCurrent(generation);
                if (!serialDevice) return;
                if (serialDevice.serialKind === dependencies.SERIAL_KIND_SHARP) {
                    await dependencies.connectSharp(null, serialDevice);
                } else if (dependencies.isHPLegacySerialDevice(serialDevice)) {
                    await dependencies.connectHPLegacy(false, null, serialDevice);
                } else {
                    await dependencies.connectTI(false, serialDevice);
                }
                return;
            }
            await dependencies.connectTI(true);
        } catch (err) {
            if (dependencies.state.connectAttempt !== connectAttempt || err?.hpLegacyConnectionCancelled) {
                return;
            }
            if (err?.sharpConnectionCancelled) return;
            if (err?.sharpSerialAuthorizationRequired) {
                dependencies.setStatus('status_sharp_serial_authorization_required', false);
                dependencies.alert(dependencies.t('status_sharp_serial_authorization_required'));
                return;
            }
            dependencies.state.pendingSharpUsbDevice = null;
            if (err?.hpLegacySerialAuthorizationRequired) {
                dependencies.setStatus('status_hp_legacy_serial_authorization_required', false);
                dependencies.log(dependencies.t('status_hp_legacy_serial_authorization_required'));
                return;
            }
            dependencies.state.pendingHPUsbDevice = null;
            if (err?.hpLegacySerialSelectionCancelled) {
                dependencies.setStatus(hadWorkingConnection ? 'status_connected' : 'status_select_device', hadWorkingConnection);
                return;
            }
            if (err?.evoSerialAuthorizationRequired) {
                dependencies.setStatus('status_evo_serial_authorization_required', false);
                dependencies.log(dependencies.t('status_evo_serial_authorization_required'));
                dependencies.alert(dependencies.t('alert_evo_serial_authorization_required'));
                return;
            }
            if (hadWorkingConnection && (dependencies.state.connected || dependencies.state.cableOpen || Boolean(dependencies.state.handle))) {
                dependencies.setStatus('status_connected', true);
            } else {
                dependencies.state.activeFamily = dependencies.DEVICE_FAMILY_TI;
                dependencies.applyActiveFamilyUiState();
                dependencies.setStatus('status_connection_failed', false);
            }
            dependencies.logError(err, 'Connect failed');
        } finally {
            if (dependencies.state.connectAttempt === connectAttempt) {
                dependencies.state.connectAttempt = null;
                dependencies.state.connectInProgress = false;
                dependencies.setButtonLoading(dependencies.els.btnConnect, false);
            }
        }
    }

    async function nukeConnection(tryReconnect = true) {
        const device = dependencies.state.authorizedDevice;
        const module = dependencies.state.module;
        const wasNspire = dependencies.isNspireActive();
        const wasTI = dependencies.state.activeFamily === dependencies.DEVICE_FAMILY_TI;
        const sharpBackend = dependencies.state.sharpBackend;
        const hpLegacyBackend = dependencies.state.hpLegacyBackend;
        const numWorksBackend = dependencies.state.numWorksBackend;
        // Invalidate before any transport await. A suspended Asyncify call cannot
        // run a queued disconnect, and emergency reset must not wait behind it.
        dependencies.clearActiveOperations('Operation cancelled by emergency reset.', { retire: true });
        const generation = dependencies.session.capture();
        dependencies.state.sharpConnectionGeneration = (dependencies.state.sharpConnectionGeneration || 0) + 1;
        dependencies.state.hpLegacyConnectionGeneration = (dependencies.state.hpLegacyConnectionGeneration || 0) + 1;
        dependencies.state.handle = 0;
        dependencies.state.cableOpen = false;
        dependencies.state.authorizedDevice = null;
        dependencies.state.pendingEvoUsbDevice = null;
        dependencies.state.pendingHPUsbDevice = null;
        dependencies.state.pendingSharpUsbDevice = null;
        dependencies.state.sharpBackend = null;
        dependencies.state.hpLegacyBackend = null;
        dependencies.state.hpLegacyKermitEnabled = false;
        dependencies.state.hpLegacyModelInfo = null;
        dependencies.state.numWorksBackend = null;
        dependencies.state.needsReauthorize = false;
        dependencies.state.silentReconnectInProgress = false;
        dependencies.state.activeFamily = dependencies.DEVICE_FAMILY_TI;
        dependencies.clearDeviceData();
        dependencies.applyActiveFamilyUiState();
        dependencies.setConnected(false);
        dependencies.setStatus('status_disconnected', false);
        dependencies.log('Device disconnected.');
        if (dependencies.els.btnNuke) dependencies.setButtonLoading(dependencies.els.btnNuke, true);
        try {
            // Close browser transports directly. No native entry is safe after the
            // module has been retired; dropping it also covers HP Prime and Cahute.
            const closeTransport = async () => {
                if (sharpBackend) await sharpBackend.close();
                if (hpLegacyBackend) await hpLegacyBackend.close({ finish: true });
                if (numWorksBackend) await numWorksBackend.close();
                if (wasTI) {
                    await dependencies.closeTISerialTransport(module);
                    try { await device?.reset?.(); } catch {}
                }
                if (wasNspire) {
                    try { await device?.forget?.(); } catch {}
                }
                if (device?.opened) await device.close?.();
            };
            await dependencies.withTimeout(closeTransport(), 'Closing calculator transport', 1000);
        } catch (error) {
            dependencies.console.warn('[WebTILP] Emergency transport close did not finish cleanly', error);
        } finally {
            if (generation === dependencies.session.capture() && dependencies.els.btnNuke) dependencies.setButtonLoading(dependencies.els.btnNuke, false);
        }
        // A manual connection or a transport event may have replaced this reset
        // while the old browser transport was closing.
        if (generation !== dependencies.session.capture() || dependencies.state.connectAttempt || dependencies.state.connected) return;
        if (tryReconnect) {
            try { await dependencies.connect(); }
            catch (error) { dependencies.console.warn('Failed to reconnect automatically, just do it manually.', error); }
        }
    }

    async function silentReconnectAfterNspireTransfer() {
        if (!dependencies.isNspireActive() || dependencies.state.silentReconnectInProgress) return;
        const module = dependencies.state.module;
        const device = dependencies.state.authorizedDevice;
        dependencies.state.silentReconnectInProgress = true;
        dependencies.clearActiveOperations();
        dependencies.state.handle = 0;
        dependencies.state.cableOpen = false;
        dependencies.state.authorizedDevice = null;
        dependencies.state.pendingEvoUsbDevice = null;
        dependencies.state.pendingHPUsbDevice = null;
        dependencies.state.needsReauthorize = true;
        dependencies.setStatus('status_select_device', false);
        try { await device?.reset?.(); }
        catch (error) { dependencies.console.warn('[WebTILP] Silent reconnect reset failed', error); }
        // Expected transport events can invalidate operation generations during
        // reset. Module identity and the reconnect flag fence a replacement session.
        if (dependencies.state.module !== module || !dependencies.state.silentReconnectInProgress) return;
        if (module && dependencies.getModuleCallState(module).pending === 0) {
            try { await dependencies.ccallAsync(module, 'notify_usb_disconnect', null, [], [], { timeoutMs: 8000 }); }
            catch (error) { dependencies.console.warn('[WebTILP] Silent reconnect notify failed', error); }
        }
        // silentReconnectInProgress is cleared after successful reauthorization.
    }

    function isTransportEventForActiveDevice(event = null) {
        if (dependencies.state?.activeFamily === 'sharp') {
            const active = dependencies.state.authorizedDevice;
            const candidate = event?.port || event?.device || event?.target;
            return candidate === active?.serialPort || candidate === active?.usbDevice || candidate === active;
        }

        if (!event?.device) {
            if (dependencies.isHPLegacyActive() && event?.target) {
                return event.target === dependencies.state.authorizedDevice?.serialPort
                    || event.target === dependencies.state.authorizedDevice;
            }
            return true;
        }
        if (dependencies.isHPLegacyActive()) return event.device === dependencies.state.authorizedDevice;
        if (dependencies.isCasioActive()) {
            return event.device === dependencies.state.authorizedDevice;
        }
        const numWorksBackend = dependencies.state.numWorksBackend;
        return !numWorksBackend || event.device === numWorksBackend.device;
    }

    function handleTransportDisconnect(event = null) {
        if (!dependencies.isTransportEventForActiveDevice(event)) {
            return;
        }
        const sharpBackend = dependencies.state.sharpBackend;
        dependencies.state.sharpBackend = null;
        dependencies.state.pendingSharpUsbDevice = null;
        dependencies.state.sharpConnectionGeneration = (dependencies.state.sharpConnectionGeneration || 0) + 1;
        sharpBackend?.close().catch(error => dependencies.console.warn(error));
        const numWorksBackend = dependencies.state.numWorksBackend;
        const hpLegacyBackend = dependencies.state.hpLegacyBackend;
        const silent = dependencies.state.silentReconnectInProgress;
        dependencies.clearActiveOperations(silent || event?.operationCompleted ? undefined : 'Active operation cancelled due to disconnect.', { retire: !silent });
        dependencies.state.handle = 0;
        dependencies.state.cableOpen = false;
        dependencies.state.authorizedDevice = null;
        dependencies.state.pendingEvoUsbDevice = null;
        dependencies.state.pendingHPUsbDevice = null;
        dependencies.state.connectInProgress = false;
        dependencies.state.handlePromise = null;
        dependencies.state.numWorksBackend = null;
        dependencies.state.hpLegacyBackend = null;
        dependencies.state.hpLegacyKermitEnabled = false;
        dependencies.state.hpLegacyModelInfo = null;
        hpLegacyBackend?.close().catch(error => {
            dependencies.console.warn('[WebTILP] Failed to close the disconnected old-HP session.', error);
        });
        numWorksBackend?.close().catch(error => {
            dependencies.console.warn('[WebTILP] Failed to close the disconnected NumWorks session.', error);
        });
        if (!silent) {
            dependencies.state.activeFamily = dependencies.DEVICE_FAMILY_TI;

            dependencies.state.needsReauthorize = false;
            dependencies.clearDeviceData();
            dependencies.applyActiveFamilyUiState();
            dependencies.setConnected(false);
            dependencies.setStatus('status_disconnected', false);
            dependencies.log('Device disconnected.');
        }
    }

    function handleTransportConnect(event = null) {
        if (!dependencies.isTransportEventForActiveDevice(event)) {
            return;
        }
        if (dependencies.state.silentReconnectInProgress) return;
        const sharpBackend = dependencies.state.sharpBackend;
        dependencies.state.sharpBackend = null;
        dependencies.state.pendingSharpUsbDevice = null;
        dependencies.state.sharpConnectionGeneration = (dependencies.state.sharpConnectionGeneration || 0) + 1;
        sharpBackend?.close().catch(error => dependencies.console.warn(error));
        const numWorksBackend = dependencies.state.numWorksBackend;
        const hpLegacyBackend = dependencies.state.hpLegacyBackend;
        dependencies.clearActiveOperations(undefined, { retire: true });
        dependencies.state.handle = 0;
        dependencies.state.module = null;
        dependencies.state.cableOpen = false;
        dependencies.state.authorizedDevice = null;
        dependencies.state.pendingEvoUsbDevice = null;
        dependencies.state.pendingHPUsbDevice = null;
        dependencies.state.connectInProgress = false;
        dependencies.state.numWorksBackend = null;
        dependencies.state.hpLegacyBackend = null;
        dependencies.state.hpLegacyKermitEnabled = false;
        dependencies.state.hpLegacyModelInfo = null;
        hpLegacyBackend?.close().catch(error => {
            dependencies.console.warn('[WebTILP] Failed to close the reconnected old-HP session.', error);
        });
        numWorksBackend?.close().catch(error => {
            dependencies.console.warn('[WebTILP] Failed to close the reconnected NumWorks session.', error);
        });
        dependencies.state.activeFamily = dependencies.DEVICE_FAMILY_TI;
        dependencies.setConnected(false);
        dependencies.setStatus('status_device_connected', false);
        dependencies.log('Device connected. Reinitialize to use it.');
        dependencies.clearDeviceData();
        dependencies.applyActiveFamilyUiState();
    }

    async function connectSharp(usbDevice = null, serialDevice = null) {
        const Backend = dependencies.globalThis.WebTILPSharp?.SharpBackend;
        if (!Backend) throw new Error(dependencies.t('sharp_backend_unavailable'));
        const generation = ++dependencies.state.sharpConnectionGeneration;
        const checkGeneration = () => {
            if (generation === dependencies.state.sharpConnectionGeneration) return;
            const error = new Error('Sharp connection cancelled.');
            error.sharpConnectionCancelled = true; throw error;
        };
        if (!serialDevice) {
            const authorized = await dependencies.getAuthorizedSharpSerialDevices();
            checkGeneration();
            serialDevice = authorized.length === 1 ? authorized[0] : await dependencies.requestSharpSerialDevice(usbDevice);
        }
        checkGeneration();
        if (!serialDevice) return;
        if (usbDevice) serialDevice.usbDevice = usbDevice;
        if (dependencies.state.sharpBackend) {
            await dependencies.state.sharpBackend.close();
            dependencies.state.sharpBackend = null;
            dependencies.state.cableOpen = false;
            dependencies.setConnected(false);
            checkGeneration();
        }
        const model = String(dependencies.state.settings?.calcModel).startsWith('sharp-') ? dependencies.state.settings.calcModel : 'sharp-auto';
        const backend = new Backend({ serialPort: serialDevice.serialPort, model,
            onProgress(progress) {
                if (dependencies.state.sharpBackend !== backend) return;
                dependencies.state.sharpProgress = progress; dependencies.refreshProgressDetails();
            }
        });
        try {
            await backend.connect();
            if (generation !== dependencies.state.sharpConnectionGeneration) {
                const error = new Error('Sharp connection cancelled.');
                error.sharpConnectionCancelled = true; throw error;
            }
        } catch (error) { await backend.close().catch(() => {}); throw error; }
        dependencies.state.sharpBackend = backend; dependencies.state.activeFamily = dependencies.DEVICE_FAMILY_SHARP;
        dependencies.state.authorizedDevice = serialDevice; dependencies.state.handle = 0; dependencies.state.cableOpen = true;
        dependencies.state.features = dependencies.FEATURE_FLAGS.OPS_SCREEN | dependencies.FEATURE_FLAGS.OPS_DIRLIST | dependencies.FEATURE_FLAGS.OPS_VARS
            | dependencies.FEATURE_FLAGS.OPS_BACKUP | dependencies.FEATURE_FLAGS.OPS_ROMDUMP | dependencies.FEATURE_FLAGS.OPS_OS;
        dependencies.state.dirlist = []; dependencies.renderDirlist([]); dependencies.readSharpInfo(); dependencies.applyActiveFamilyUiState();
        dependencies.setConnected(true); dependencies.setStatus('status_connected', true); dependencies.log(dependencies.t('sharp_connected'));
    }

    async function runSharpOperation(label, callback) {
        const backend = dependencies.state.sharpBackend, generation = dependencies.state.sharpConnectionGeneration;
        if (!backend || backend.busy) { dependencies.log(dependencies.t('sharp_busy')); return; }
        dependencies.state.sharpProgress = null; dependencies.startProgress(label);
        try {
            await callback(backend);
            if (backend.closed && dependencies.state.sharpBackend === backend && generation === dependencies.state.sharpConnectionGeneration) {
                dependencies.handleTransportDisconnect({ port: backend.port, operationCompleted: true });
            }
        } catch (error) {
            if (dependencies.state.sharpBackend === backend && generation === dependencies.state.sharpConnectionGeneration) {
                dependencies.logError(error, dependencies.t('sharp_operation_failed'));
                if (backend.closed) dependencies.handleTransportDisconnect({ port: backend.port });
            }
        } finally {
            if (generation === dependencies.state.sharpConnectionGeneration) dependencies.stopProgress(label);
        }
    }

    return { initModule, authorizeDevice, authorizeHPPrimeDevice, authorizeCasioDevice, connectHPLegacy, connectCasio, scheduleHPPrimeProgressRender, authorizeNumWorksDevice, connectNumWorks, connectHPPrime, autoConnectIfAuthorized, ensureHandle, ensureCableOpen, connectTI, connect, nukeConnection, silentReconnectAfterNspireTransfer, isTransportEventForActiveDevice, handleTransportDisconnect, handleTransportConnect, connectSharp, runSharpOperation };
}

module.exports = { createFeaturesConnections };
