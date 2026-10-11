'use strict';

/**
 * ui connection. Browser and application dependencies are injected
 * by app.js; importing this module does not start the application.
 * @param {object} dependencies
 * @returns {object}
 */
function createUiConnection(dependencies) {
    function setStatus(text, active) {
        dependencies.syncStatusTranslation(text);
        dependencies.els.statusDot.classList.toggle('is-active', Boolean(active));
    }

    function setConnected(connected) {
        dependencies.state.connected = connected;
        if (dependencies.els.btnNuke) {
            dependencies.els.btnNuke.classList.toggle('hidden', !connected);
        }
        if (dependencies.els.splashScreen && dependencies.els.mainContent) {
            dependencies.els.splashScreen.classList.toggle('hidden', connected);
            dependencies.els.mainContent.classList.toggle('hidden', !connected);
        }
        if (!connected) {
            dependencies.updateTransportSplashState();
        }
    }

    function updateTransportSplashState() {
        const webUsbReady = dependencies.hasWebUsbTransport();
        const evoSerialReady = dependencies.hasEvoWebSerialTransport();
        const hpWebHidReady = dependencies.hasHPPrimeWebHidTransport();
        const supported = dependencies.hasAnySupportedTransport();
        const primaryReady = webUsbReady || evoSerialReady || hpWebHidReady;
        dependencies.setTextContent(dependencies.document.getElementById('splashText'), dependencies.t('welcome_text'));
        if (dependencies.els.splashWebUsbWarning) {
            dependencies.els.splashWebUsbWarning.classList.toggle('hidden', primaryReady);
            if (!primaryReady) {
                dependencies.setTextContent(
                    dependencies.document.getElementById('splashWebUsbWarningTitle'),
                    evoSerialReady ? dependencies.t('webserial_only_title') : dependencies.t('webusb_unavailable_title')
                );
                dependencies.setTextContent(
                    dependencies.document.getElementById('splashWebUsbWarningText'),
                    evoSerialReady ? dependencies.t('webserial_only_text') : dependencies.t('webusb_unavailable_text')
                );
            }
        }
        if (dependencies.els.btnSplashConnect) {
            dependencies.els.btnSplashConnect.classList.toggle('hidden', !supported);
        }
        if (dependencies.els.btnConnect) {
            dependencies.els.btnConnect.classList.toggle('hidden', !supported);
        }
        if (dependencies.els.btnSettings) {
            dependencies.els.btnSettings.classList.toggle('hidden', !dependencies.hasAnySupportedTransport());
        }
    }

    function isWindowsPlatform() {
        const platform = dependencies.navigator.userAgentData?.platform || dependencies.navigator.platform || dependencies.navigator.userAgent || '';
        return /win/i.test(String(platform));
    }

    function isLinuxPlatform() {
        const platform = dependencies.navigator.userAgentData?.platform || dependencies.navigator.platform || dependencies.navigator.userAgent || '';
        return /linux/i.test(String(platform));
    }

    function resetToSplashState() {
        dependencies.clearActiveOperations();
        dependencies.state.handle = 0;
        dependencies.state.activeFamily = dependencies.DEVICE_FAMILY_TI;
        dependencies.state.numWorksBackend = null;
        dependencies.state.cableOpen = false;
        dependencies.state.authorizedDevice = null;
        dependencies.state.pendingEvoUsbDevice = null;
        dependencies.state.pendingHPUsbDevice = null;
        dependencies.state.connectInProgress = false;
        dependencies.state.handlePromise = null;
        dependencies.state.needsReauthorize = false;
        dependencies.state.silentReconnectInProgress = false;
        dependencies.clearDeviceData();
        dependencies.applyActiveFamilyUiState();
        dependencies.setConnected(false);
        if (!dependencies.self.isSecureContext) {
            dependencies.setStatus('status_insecure_context', false);
        } else if (dependencies.hasWebUsbTransport() || dependencies.hasHPPrimeWebHidTransport()) {
            dependencies.setStatus('idle', false);
        } else if (dependencies.hasEvoWebSerialTransport()) {
            dependencies.setStatus('status_webserial_only', false);
        } else {
            dependencies.setStatus('status_webusb_unsupported', false);
        }
    }

    function openConnectionHelpModal(title, html) {
        if (!dependencies.els.connectionHelpModal || !dependencies.els.connectionHelpBody) {
            dependencies.alert(`${title}\n\n${html.replace(/<[^>]+>/g, '')}`);
            return;
        }
        if (dependencies.els.connectionHelpTitle) {
            dependencies.els.connectionHelpTitle.textContent = title;
        }
        dependencies.els.connectionHelpBody.innerHTML = html;
        dependencies.els.connectionHelpModal.classList.remove('hidden');
        dependencies.els.connectionHelpModal.setAttribute('aria-hidden', 'false');
    }

    function closeConnectionHelpModal() {
        if (!dependencies.els.connectionHelpModal) {
            return;
        }
        dependencies.els.connectionHelpModal.classList.add('hidden');
        dependencies.els.connectionHelpModal.setAttribute('aria-hidden', 'true');
    }

    function showCableOpenHelp(result) {
        const code = Number(result);
        const closeAppsReminder = '<p>Before trying again, close any other WebTILP pages, browser tabs, TI tools, terminal sessions, or other apps that may already be using the calculator or cable.</p>';

        const cdcPort = dependencies.isSerialDevice(dependencies.state.authorizedDevice) && dependencies.state.authorizedDevice.serialPort;
        if (cdcPort?.device) {
            const detail = cdcPort.lastOpenError?.message;
            dependencies.openConnectionHelpModal('Evo USB serial connection failed', `
                <p>WebTILP selected the Evo through WebUSB, but could not open its USB CDC serial interfaces.</p>
                ${detail ? `<p>${dependencies.escapeHtml(detail)}</p>` : ''}
                ${closeAppsReminder}
                <p>Unplug and reconnect the Evo, then try again. The browser and phone firmware must allow access to its USB interfaces.</p>
            `);
            return;
        }

        if (dependencies.isLinuxPlatform() && code === 58) {
            dependencies.openConnectionHelpModal('Linux serial permission needed', `
                <p>WebTILP can see the TI-83/84 Evo, but Linux refused to open its serial device.</p>
                <ol>
                    <li>Add your user to the serial device group: <code>sudo usermod -a -G dialout $USER</code></li>
                    <li>Fully log out and log back in, or reboot. Restarting the browser alone is not enough.</li>
                    <li>Unplug and replug the calculator, then try connecting again.</li>
                </ol>
                <p>Some distributions use another serial group such as <code>uucp</code> or <code>lock</code>; check the group on <code>/dev/ttyACM0</code> if <code>dialout</code> is not used.</p>
                ${closeAppsReminder}
            `);
            return;
        }

        if (dependencies.isWindowsPlatform() && code === 37) {
            if (dependencies.is84pFamilyActive() || dependencies.isTI89TActive()) {
                dependencies.openConnectionHelpModal('Install the latest TI Connect™ CE version', `
                    <p>
                    Your browser isn't able to talk to the calculator. Install the latest TI Connect™ CE version, then try again.
                    ${dependencies.isTI89TActive() ? '<br><i>(Yes, even for the TI-89 Titanium: its included driver will make it work.</i>' : ''}
                    </p>
                    <ol>
                        <li>Download and install <a href="https://education.ti.com/en/software/details/en/13312f7cec074a2dafd7ee5646129839/swticonnectcesoftwareforwindows" target="_blank" rel="noopener noreferrer">TI Connect™ CE v6.1</a> or later.</li>
                        <li>Don't launch TI Connect™ CE (if you did, quit it)</li>
                        <li>Unplug and replug the calculator</li>
                        <li>Try connecting again here (refresh this page if needed)</li>
                    </ol>
                    ${closeAppsReminder}
                `);
                return;
            }
            dependencies.openConnectionHelpModal('Install the WinUSB driver with Zadig', `
                <p>Your browser isn't able to talk to the calculator. Install the WinUSB driver for the calculator/cable, then try again.</p>
                <ol>
                    <li>Download and run <a href="https://zadig.akeo.ie/" target="_blank" rel="noopener noreferrer">Zadig</a>.</li>
                    <li>In Zadig, choose <strong>Options</strong> &gt; <strong>List All Devices</strong>.</li>
                    <li>Select the TI calculator or SilverLink cable. Be careful not to select your keyboard, mouse, or USB hub.</li>
                    <li>Choose <strong>WinUSB</strong> as the target driver.</li>
                    <li>Click <strong>Replace Driver</strong> or <strong>Install Driver</strong>.</li>
                    <li>Unplug and replug the calculator</li>
                    <li>Try connecting again here (refresh this page if needed)</li>
                </ol>
                ${closeAppsReminder}
            `);
        }
    }

    function isTI89TActive() {
        const pid = dependencies.state.authorizedDevice?.productId;
        return typeof pid === 'number' && pid === 0xE004;
    }

    function isNspireActive() {
        const pid = dependencies.state.authorizedDevice?.productId;
        return typeof pid === 'number' && dependencies.NSPIRE_PIDS.has(pid);
    }

    function isHPPrimeActive() {
        return dependencies.state.activeFamily === dependencies.DEVICE_FAMILY_HP_PRIME;
    }

    function isHPLegacyActive() {
        return dependencies.state.activeFamily === dependencies.DEVICE_FAMILY_HP_LEGACY;
    }

    function isNumWorksActive() {
        return dependencies.state.activeFamily === dependencies.DEVICE_FAMILY_NUMWORKS;
    }

    function buildFileInputAccept(extensions) {
        // HTML matching is case-insensitive, but some native pickers use literal
        // patterns. Include mixed case too (TI files commonly use e.g. .8Xp).
        const specifiers = new Set();
        for (const extension of extensions) {
            const ext = String(extension).replace(/^\./, '').toLowerCase();
            if (!/^[a-z0-9]+$/i.test(ext)) continue;
            let variants = ['.'];
            for (const char of ext) {
                const cases = char === char.toUpperCase() ? [char] : [char, char.toUpperCase()];
                variants = variants.flatMap(prefix => cases.map(letter => prefix + letter));
            }
            variants.forEach(variant => specifiers.add(variant));
        }
        return Array.from(specifiers).join(',');
    }

    function updateFileInputAccept() {
        if (!dependencies.els.fileInput) return;
        let extensions = [];
        if (dependencies.state?.activeFamily === 'sharp') {
            extensions = ['g4p', 'g4e', 'g4s', 'g4y', 'g4m', 'g4i', 'g4d', 'g4l', 'g4n', 'g4v', 'g4z', 'g4w', 'g4t', 'g4b'];
        } else if (dependencies.isHPPrimeActive()) {
            extensions = Array.from(dependencies.HP_PRIME_UPLOAD_EXTENSIONS);
        } else if (dependencies.isNumWorksActive()) {
            extensions = ['py'];
        } else {
            const modelId = dependencies.getActiveCalcModelId() || Number(dependencies.state.settings?.calcModel) || 0;
            try {
                const getExtensions = model => (dependencies.state.module?.ccall(
                    'get_file_extensions', 'string', ['number'], [model]) || '').split(',').filter(Boolean);
                extensions = getExtensions(modelId);
                if (extensions.length) {
                    if (dependencies.state.settings?.convertScriptFiles !== false) {
                        if (dependencies.getPythonConversionKind(modelId) !== dependencies.PYTHON_CONVERSION_NONE) extensions.push('py', 'mpy');
                        if (dependencies.NSPIRE_LUA_CALC_MODELS.has(modelId)) extensions.push('lua');
                    }
                    if (dependencies.EVO_PYTHON_CALC_MODELS.has(modelId)) {
                        // Evo also accepts legacy variables through TIVarsLib conversion.
                        for (const sourceModel of [2, 3, 4, 18]) {
                            extensions.push(...getExtensions(sourceModel)
                                .filter(ext => dependencies.isLegacyTivarsConversionCandidate(`file.${ext}`)));
                        }
                    }
                    if (modelId === 19 || modelId === 20) extensions.push('b83', 'b84');
                }
            } catch (err) {
                dependencies.console.warn('[WebTILP] Failed to query file-picker extensions', err);
                extensions = [];
            }
        }
        // Leave an unknown target unrestricted until identification succeeds.
        dependencies.els.fileInput.accept = dependencies.buildFileInputAccept(extensions);
    }

    function isCasioActive() {
        return dependencies.state.activeFamily === dependencies.DEVICE_FAMILY_CASIO;
    }

    function resetFamilySpecificUiText(clearActionTitles = true) {
        dependencies.setTextContent(dependencies.document.getElementById('dropzoneTitle'), dependencies.t('dropzone_title'));
        dependencies.setTextContent(dependencies.document.getElementById('dropzoneSubtitle'), dependencies.t('dropzone_subtitle'));
        dependencies.setTextContent(dependencies.document.getElementById('panelVarsTitle'), dependencies.t('calculator_variables'));
        if (clearActionTitles) {
            [dependencies.els.btnIsReady, dependencies.els.btnSyncClock, dependencies.els.btnReceiveBackup,
                dependencies.els.btnRefreshDirlist, dependencies.els.btnNewFolder, dependencies.els.btnDeleteSelected,
                dependencies.els.btnScreenshot, dependencies.els.btnReceiveOs, dependencies.els.btnDownloadOsPartial,
                dependencies.els.btnDumpRom, dependencies.els.btnLeaveExam].forEach(button => {
                if (button) {
                    button.title = '';
                }
            });
        }
    }

    function setTiUiState(capabilitiesKnown = false) {
        dependencies.resetFamilySpecificUiText(!capabilitiesKnown);
        if (dependencies.els.fileInput) {
            dependencies.els.fileInput.disabled = false;
            dependencies.updateFileInputAccept();
        }
        dependencies.updateSendFilesButtonState();
        if (capabilitiesKnown) {
            // updateCapabilities() already resolved the key controls and the
            // per-feature button states for this calculator. Leave them alone, so
            // that a translation refresh cannot hide the keys panel or drop the
            // keymap datalist of a connected calculator.
            dependencies.updateSelectionActionButtons();
            return;
        }
        dependencies.updateKeyControlsState(false);
        if (dependencies.els.keyCodeInput) {
            dependencies.els.keyCodeInput.removeAttribute('list');
        }
        dependencies.clearKeyMapDataList();
        [dependencies.els.btnSyncClock, dependencies.els.btnNewFolder, dependencies.els.btnDeleteSelected,
            dependencies.els.btnReceiveBackup, dependencies.els.btnRefreshDirlist, dependencies.els.btnScreenshot].forEach(button => {
            if (button) {
                button.disabled = true;
                button.classList.add('disabled');
            }
        });
        [dependencies.els.btnIsReady, dependencies.els.btnReceiveOs, dependencies.els.btnDownloadOsPartial,
            dependencies.els.btnDumpRom, dependencies.els.btnLeaveExam].forEach(button => button?.classList.add('hidden'));
    }

    function setHPPrimeUiState() {
        dependencies.updateKeyControlsState(true);
        if (dependencies.els.keyCodeInput) {
            dependencies.els.keyCodeInput.removeAttribute('list');
        }
        dependencies.clearKeyMapDataList();
        dependencies.populateKeyMapDataList(dependencies.KEYMAP_CONFIG_HP_PRIME.listId,
            dependencies.KEYMAP_CONFIG_HP_PRIME.entries);
        dependencies.els.keyCodeInput?.setAttribute('list', dependencies.KEYMAP_CONFIG_HP_PRIME.listId);
        if (dependencies.els.fileInput) {
            dependencies.els.fileInput.disabled = false;
            dependencies.updateFileInputAccept();
        }
        dependencies.updateSendFilesButtonState();
        [dependencies.els.btnSyncClock, dependencies.els.btnNewFolder, dependencies.els.btnDeleteSelected].forEach(button => {
            if (button) {
                button.disabled = true;
                button.classList.add('disabled');
                button.title = '';
            }
        });
        if (dependencies.els.btnScreenshot) {
            dependencies.els.btnScreenshot.disabled = false;
            dependencies.els.btnScreenshot.classList.remove('disabled');
            dependencies.els.btnScreenshot.title = '';
        }
        dependencies.els.btnIsReady?.classList.add('hidden');
        dependencies.els.btnReceiveOs?.classList.add('hidden');
        dependencies.els.btnDownloadOsPartial?.classList.add('hidden');
        dependencies.els.btnDumpRom?.classList.add('hidden');
        dependencies.els.btnLeaveExam?.classList.add('hidden');
        if (dependencies.els.btnReceiveBackup) {
            dependencies.els.btnReceiveBackup.disabled = false;
            dependencies.els.btnReceiveBackup.classList.remove('disabled');
            dependencies.els.btnReceiveBackup.title = dependencies.t('hp_prime_backup_tooltip');
        }
        if (dependencies.els.btnRefreshDirlist) {
            dependencies.els.btnRefreshDirlist.disabled = false;
            dependencies.els.btnRefreshDirlist.classList.remove('disabled');
            dependencies.els.btnRefreshDirlist.title = dependencies.t('hp_prime_refresh_tooltip');
        }
        dependencies.setTextContent(dependencies.document.getElementById('dropzoneTitle'), dependencies.t('hp_prime_dropzone_title'));
        dependencies.setTextContent(dependencies.document.getElementById('dropzoneSubtitle'), dependencies.t('hp_prime_dropzone_subtitle'));
        dependencies.setTextContent(dependencies.document.getElementById('panelVarsTitle'), dependencies.t('hp_prime_files_title'));
        dependencies.updateSelectionActionButtons();
    }

    function setHPLegacyUiState() {
        const kermitAvailable = dependencies.state.hpLegacyKermitEnabled;
        dependencies.updateKeyControlsState(false);
        if (dependencies.els.keyCodeInput) dependencies.els.keyCodeInput.removeAttribute('list');
        dependencies.clearKeyMapDataList();
        if (dependencies.els.fileInput) {
            dependencies.els.fileInput.disabled = !kermitAvailable;
            dependencies.els.fileInput.accept = '';
        }
        [dependencies.els.btnSyncClock, dependencies.els.btnNewFolder, dependencies.els.btnDeleteSelected,
            dependencies.els.btnReceiveBackup].forEach(button => {
            if (!button) return;
            button.disabled = true;
            button.classList.add('disabled');
            button.title = dependencies.t('hp_legacy_feature_unavailable');
        });
        if (dependencies.els.btnScreenshot) {
            dependencies.els.btnScreenshot.disabled = !kermitAvailable;
            dependencies.els.btnScreenshot.classList.toggle('disabled', !kermitAvailable);
            dependencies.els.btnScreenshot.title = kermitAvailable
                ? '' : dependencies.t('hp_legacy_kermit_not_selected');
        }
        if (dependencies.els.btnRefreshDirlist) {
            dependencies.els.btnRefreshDirlist.disabled = !kermitAvailable;
            dependencies.els.btnRefreshDirlist.classList.toggle('disabled', !kermitAvailable);
            dependencies.els.btnRefreshDirlist.title = kermitAvailable
                ? dependencies.t('hp_legacy_refresh_tooltip') : dependencies.t('hp_legacy_kermit_not_selected');
        }
        dependencies.els.btnIsReady?.classList.add('hidden');
        dependencies.els.btnReceiveOs?.classList.add('hidden');
        dependencies.els.btnDownloadOsPartial?.classList.add('hidden');
        dependencies.els.btnDumpRom?.classList.add('hidden');
        dependencies.els.btnLeaveExam?.classList.add('hidden');
        dependencies.setTextContent(dependencies.document.getElementById('dropzoneTitle'), dependencies.t('hp_legacy_dropzone_title'));
        dependencies.setTextContent(dependencies.document.getElementById('dropzoneSubtitle'), kermitAvailable
            ? dependencies.t('hp_legacy_dropzone_subtitle') : dependencies.t('hp_legacy_xmodem_only_hint'));
        dependencies.setTextContent(dependencies.document.getElementById('panelVarsTitle'), dependencies.t('hp_legacy_files_title'));
        dependencies.updateSendFilesButtonState();
        dependencies.updateSelectionActionButtons();
    }

    function setNumWorksUiState() {
        dependencies.updateKeyControlsState(false);
        if (dependencies.els.keyCodeInput) {
            dependencies.els.keyCodeInput.removeAttribute('list');
        }
        dependencies.clearKeyMapDataList();
        if (dependencies.els.fileInput) {
            dependencies.els.fileInput.disabled = false;
            dependencies.updateFileInputAccept();
        }
        dependencies.updateSendFilesButtonState();
        [dependencies.els.btnSyncClock, dependencies.els.btnNewFolder].forEach(button => {
            if (button) {
                button.disabled = true;
                button.classList.add('disabled');
                button.title = '';
            }
        });
        if (dependencies.els.btnScreenshot) {
            dependencies.els.btnScreenshot.disabled = true;
            dependencies.els.btnScreenshot.classList.add('disabled');
            dependencies.els.btnScreenshot.title = dependencies.t('numworks_screenshot_unavailable');
        }
        dependencies.els.btnIsReady?.classList.add('hidden');
        dependencies.els.btnReceiveOs?.classList.add('hidden');
        dependencies.els.btnDownloadOsPartial?.classList.add('hidden');
        dependencies.els.btnDumpRom?.classList.add('hidden');
        dependencies.els.btnLeaveExam?.classList.add('hidden');
        if (dependencies.els.btnReceiveBackup) {
            dependencies.els.btnReceiveBackup.disabled = false;
            dependencies.els.btnReceiveBackup.classList.remove('disabled');
            dependencies.els.btnReceiveBackup.title = dependencies.t('numworks_backup_tooltip');
        }
        if (dependencies.els.btnRefreshDirlist) {
            dependencies.els.btnRefreshDirlist.disabled = false;
            dependencies.els.btnRefreshDirlist.classList.remove('disabled');
            dependencies.els.btnRefreshDirlist.title = dependencies.t('numworks_refresh_tooltip');
        }
        dependencies.setTextContent(dependencies.document.getElementById('dropzoneTitle'), dependencies.t('numworks_dropzone_title'));
        dependencies.setTextContent(dependencies.document.getElementById('dropzoneSubtitle'),
            dependencies.t('numworks_dropzone_subtitle'));
        dependencies.setTextContent(dependencies.document.getElementById('panelVarsTitle'), dependencies.t('numworks_scripts_title'));
        dependencies.updateSelectionActionButtons();
    }

    function setCasioUiState() {
        const storageAvailable = dependencies.state.casioStorageSupported;
        dependencies.updateKeyControlsState(false);
        if (dependencies.els.keyCodeInput) {
            dependencies.els.keyCodeInput.removeAttribute('list');
        }
        dependencies.clearKeyMapDataList();
        if (dependencies.els.fileInput) {
            dependencies.els.fileInput.disabled = !storageAvailable;
            dependencies.els.fileInput.accept = '';
        }
        dependencies.updateSendFilesButtonState();
        [dependencies.els.btnSyncClock, dependencies.els.btnNewFolder, dependencies.els.btnReceiveBackup].forEach(button => {
            if (button) {
                button.disabled = true;
                button.classList.add('disabled');
                button.title = dependencies.t('casio_feature_unavailable');
            }
        });
        if (dependencies.els.btnRefreshDirlist) {
            dependencies.els.btnRefreshDirlist.disabled = !storageAvailable;
            dependencies.els.btnRefreshDirlist.classList.toggle('disabled', !storageAvailable);
            dependencies.els.btnRefreshDirlist.title = storageAvailable
                ? dependencies.t('casio_refresh_tooltip') : dependencies.t('casio_storage_protocol_unavailable');
        }
        if (dependencies.els.btnScreenshot) {
            dependencies.els.btnScreenshot.disabled = true;
            dependencies.els.btnScreenshot.classList.add('disabled');
            dependencies.els.btnScreenshot.title = dependencies.t('casio_screenshot_unavailable');
        }
        dependencies.els.btnIsReady?.classList.add('hidden');
        dependencies.els.btnReceiveOs?.classList.add('hidden');
        dependencies.els.btnDownloadOsPartial?.classList.add('hidden');
        dependencies.els.btnDumpRom?.classList.add('hidden');
        dependencies.els.btnLeaveExam?.classList.add('hidden');
        dependencies.setTextContent(dependencies.document.getElementById('dropzoneTitle'), dependencies.t('casio_dropzone_title'));
        dependencies.setTextContent(dependencies.document.getElementById('dropzoneSubtitle'),
            storageAvailable ? dependencies.t('casio_dropzone_subtitle')
                : dependencies.t('casio_storage_protocol_unavailable'));
        dependencies.setTextContent(dependencies.document.getElementById('panelVarsTitle'), dependencies.t('casio_files_title'));
        dependencies.updateSelectionActionButtons();
    }

    function applyActiveFamilyUiState(options = {}) {
        if (!options.tiCapabilitiesKnown) {
            dependencies.els.varsPanel?.classList.remove('hidden');
            dependencies.els.btnBackupDirlist?.classList.add('hidden');
            dependencies.els.backupDirlistNote?.classList.add('hidden');
        }
        const appFolderButton = dependencies.document.getElementById('btnChooseHPAppFolder');
        if (appFolderButton) {
            appFolderButton.classList.toggle('hidden', !dependencies.isHPPrimeActive());
            appFolderButton.textContent = dependencies.t('hp_prime_choose_app_folder');
        }
        if (dependencies.state?.activeFamily === 'sharp') {
            dependencies.setSharpUiState();
        } else if (dependencies.isHPPrimeActive()) {
            dependencies.setHPPrimeUiState();
        } else if (dependencies.isHPLegacyActive()) {
            dependencies.setHPLegacyUiState();
        } else if (dependencies.isNumWorksActive()) {
            dependencies.setNumWorksUiState();
        } else if (dependencies.isCasioActive()) {
            dependencies.setCasioUiState();
        } else {
            dependencies.setTiUiState(Boolean(options.tiCapabilitiesKnown));
        }
        dependencies.applyBackendControlAvailability(Boolean(options.tiCapabilitiesKnown));
    }

    function is84pFamilyActive() {
        const pid = dependencies.state.authorizedDevice?.productId;
        return typeof pid === 'number' && dependencies.TI84P_FAMILY_PIDS.has(pid);
    }

    function getActiveKeyMapConfig() {
        if (dependencies.isHPPrimeActive()) {
            return dependencies.KEYMAP_CONFIG_HP_PRIME;
        }
        if (dependencies.isHPLegacyActive() || dependencies.isNumWorksActive() || dependencies.isCasioActive()) {
            return null;
        }
        if (dependencies.isNspireActive()) {
            return dependencies.KEYMAP_CONFIG_NSP;
        }
        if (dependencies.is84pFamilyActive()) {
            return dependencies.KEYMAP_CONFIG_8X;
        }
        if (dependencies.isTI89TActive()) {
            return dependencies.KEYMAP_CONFIG_89;
        }
        const calcSetting = dependencies.state.settings?.calcModel ?? 'auto';
        if (calcSetting !== 'auto') {
            return dependencies.KEYMAP_BY_MODEL.get(Number(calcSetting)) || null;
        }
        return null;
    }

    function getFlashOsExtensionFromModule(module) {
        if (!module) {
            return null;
        }
        try {
            return module.ccall('get_flash_os_ext', 'string', ['number'], [0]);
        } catch (err) {
            dependencies.console.warn('[WebTILP] Failed to query flash OS extension', err);
            return null;
        }
    }

    function ensureSupportedTransport() {
        if (!dependencies.self.isSecureContext) {
            throw new Error(dependencies.t('transport_secure_context_error'));
        }
        if (!dependencies.navigator.usb && !dependencies.navigator.serial && !dependencies.navigator.hid) {
            throw new Error(dependencies.t('transport_unavailable_error'));
        }
    }

    async function updateCapabilities() {
        if (!dependencies.state.handle || !dependencies.state.module) {
            return;
        }
        await dependencies.ensureCableOpen();
        const features = await dependencies.ccallAsync(dependencies.state.module, 'calc_features', 'number', ['number'], [dependencies.state.handle], { timeoutMs: 8000 });
        dependencies.state.features = features;
        dependencies.updateFileInputAccept();
        const capabilities = dependencies.getActiveBackendCapabilities();
        const hasDirlist = capabilities.nativeDirectory;
        const hasFolder = capabilities.folders;
        const hasBackup = capabilities.backup;
        const canListBackup = capabilities.backupDirectory;
        const hasClock = capabilities.clock;
        const hasRomDump = capabilities.rom;
        const hasKeys = capabilities.keys;
        const hasNewFolder = capabilities.newFolder;
        const isNspire = dependencies.isNspireActive();
        const canReceiveOs = hasRomDump && isNspire;
        dependencies.els.btnIsReady?.classList.remove('hidden');
        dependencies.els.varsPanel?.classList.toggle('hidden', !hasDirlist && !(canListBackup && dependencies.state.backupDirlistLoaded));
        dependencies.els.btnBackupDirlist?.classList.toggle('hidden', !canListBackup);
        dependencies.els.backupDirlistNote?.classList.toggle('hidden', !(canListBackup && dependencies.state.backupDirlistLoaded));
        if (dependencies.els.btnRefreshDirlist) {
            dependencies.els.btnRefreshDirlist.classList.toggle('disabled', !hasDirlist && !canListBackup);
            dependencies.els.btnRefreshDirlist.disabled = !hasDirlist && !canListBackup;
            dependencies.els.btnRefreshDirlist.title = '';
        }
        if (dependencies.els.btnScreenshot) {
            dependencies.els.btnScreenshot.classList.remove('disabled');
            dependencies.els.btnScreenshot.disabled = false;
            dependencies.els.btnScreenshot.title = '';
        }
        dependencies.updateKeyControlsState(hasKeys);
        if (dependencies.els.keyCodeInput) {
            dependencies.els.keyCodeInput.removeAttribute('list');
        }
        dependencies.clearKeyMapDataList();
        if (hasKeys) {
            const keyConfig = dependencies.getActiveKeyMapConfig();
            if (keyConfig) {
                dependencies.populateKeyMapDataList(keyConfig.listId, keyConfig.entries);
                if (dependencies.els.keyCodeInput) {
                    dependencies.els.keyCodeInput.setAttribute('list', keyConfig.listId);
                }
            }
        }

        if (!hasFolder) {
            // Folder grouping handled in table view only.
        }

        if (!hasBackup) {
            dependencies.els.btnReceiveBackup.classList.add('disabled');
            dependencies.els.btnReceiveBackup.disabled = true;
            dependencies.els.btnReceiveBackup.title = 'Backup not supported by this calculator';
        } else {
            dependencies.els.btnReceiveBackup.classList.remove('disabled');
            dependencies.els.btnReceiveBackup.disabled = false;
            dependencies.els.btnReceiveBackup.title = '';
        }

        dependencies.updateNspireOsButtons(isNspire, canReceiveOs);

        if (!hasNewFolder) {
            dependencies.els.btnNewFolder.classList.add('disabled');
            dependencies.els.btnNewFolder.disabled = true;
            dependencies.els.btnNewFolder.title = 'Folder creation not supported by this calculator';
        } else {
            dependencies.els.btnNewFolder.classList.remove('disabled');
            dependencies.els.btnNewFolder.disabled = false;
            dependencies.els.btnNewFolder.title = '';
        }

        if (!hasClock) {
            dependencies.els.btnSyncClock.classList.add('disabled');
            dependencies.els.btnSyncClock.disabled = true;
            dependencies.els.btnSyncClock.title = 'Clock sync not supported by this calculator';
        } else {
            dependencies.els.btnSyncClock.classList.remove('disabled');
            dependencies.els.btnSyncClock.disabled = false;
            dependencies.els.btnSyncClock.title = '';
        }

        if (isNspire) {
            dependencies.els.btnDumpRom.classList.add('hidden'); // for now
        } else {
            dependencies.els.btnDumpRom.classList.remove('hidden');
            if (!hasRomDump) {
                dependencies.els.btnDumpRom.classList.add('disabled');
                dependencies.els.btnDumpRom.disabled = true;
                dependencies.els.btnDumpRom.title = 'ROM dumping not supported by this calculator';
            } else {
                dependencies.els.btnDumpRom.classList.remove('disabled');
                dependencies.els.btnDumpRom.disabled = false;
                dependencies.els.btnDumpRom.title = '';
            }
        }
        if (dependencies.els.btnLeaveExam) {
            const canLeaveExam = dependencies.state.module.ccall('calc_leave_exam_mode_supported', 'number', [], []) !== 0;
            dependencies.state.leaveExamSupported = canLeaveExam;
            dependencies.els.btnLeaveExam.classList.toggle('hidden', !canLeaveExam);
            dependencies.els.btnLeaveExam.disabled = !canLeaveExam;
            dependencies.els.btnLeaveExam.classList.toggle('disabled', !canLeaveExam);
            dependencies.els.btnLeaveExam.title = canLeaveExam ? '' : 'Leave exam mode is not supported by this calculator';
        }
        dependencies.applyBackendControlAvailability(true);
        dependencies.updateSelectionActionButtons();
    }

    function updateNspireOsButtons(isNspire, canReceiveOs) {
        const showReceive = Boolean(isNspire);
        dependencies.els.btnReceiveOs.classList.toggle('hidden', !showReceive);
        if (!showReceive) {
            dependencies.state.nspireOsReceiveStarted = false;
            dependencies.els.btnReceiveOs.classList.add('disabled');
            dependencies.els.btnReceiveOs.disabled = true;
            dependencies.els.btnReceiveOs.title = 'OS receive is only supported on TI-Nspire models';
        } else if (!canReceiveOs) {
            dependencies.els.btnReceiveOs.classList.add('disabled');
            dependencies.els.btnReceiveOs.disabled = true;
            dependencies.els.btnReceiveOs.title = 'OS receive is not supported by this calculator';
        } else {
            dependencies.els.btnReceiveOs.classList.remove('disabled');
            dependencies.els.btnReceiveOs.disabled = false;
            dependencies.els.btnReceiveOs.title = '';
        }

        const showDownload = showReceive && dependencies.state.nspireOsReceiveStarted;
        dependencies.els.btnDownloadOsPartial.classList.toggle('hidden', !showDownload);
        if (!showDownload) {
            dependencies.els.btnDownloadOsPartial.classList.add('disabled');
            dependencies.els.btnDownloadOsPartial.disabled = true;
            dependencies.els.btnDownloadOsPartial.title = showReceive
                ? 'Press Receive OS to enable downloading.'
                : 'OS receive is only supported on TI-Nspire models';
        } else {
            dependencies.els.btnDownloadOsPartial.classList.remove('disabled');
            dependencies.els.btnDownloadOsPartial.disabled = false;
            dependencies.els.btnDownloadOsPartial.title = '';
        }
    }

    function setSharpUiState() {
        dependencies.resetFamilySpecificUiText(); dependencies.updateKeyControlsState(false); dependencies.clearKeyMapDataList();
        dependencies.els.keyCodeInput?.removeAttribute('list');
        for (const button of [dependencies.els.btnSyncClock, dependencies.els.btnNewFolder, dependencies.els.btnDeleteSelected]) {
            if (!button) continue;
            button.disabled = true; button.classList.add('disabled');
        }
        for (const button of [dependencies.els.btnScreenshot, dependencies.els.btnRefreshDirlist, dependencies.els.btnReceiveBackup,
            dependencies.els.btnReceiveOs, dependencies.els.btnDumpRom]) {
            if (!button) continue;
            button.disabled = false; button.classList.remove('disabled', 'hidden');
        }
        for (const button of [dependencies.els.btnIsReady, dependencies.els.btnDownloadOsPartial, dependencies.els.btnLeaveExam]) button?.classList.add('hidden');
        if (dependencies.els.fileInput) { dependencies.els.fileInput.disabled = false; dependencies.updateFileInputAccept(); }
        dependencies.setTextContent(dependencies.document.getElementById('dropzoneTitle'), dependencies.t('sharp_drop_title'));
        dependencies.setTextContent(dependencies.document.getElementById('dropzoneSubtitle'), dependencies.t('sharp_drop_hint'));
        dependencies.setTextContent(dependencies.document.getElementById('panelVarsTitle'), dependencies.t('sharp_vars_title'));
        dependencies.updateSendFilesButtonState(); dependencies.updateSelectionActionButtons();
    }

    function getActiveBackendCapabilities() {
        return dependencies.getBackendCapabilities(dependencies.state, dependencies.FEATURE_FLAGS, dependencies.getActiveCalcModelId());
    }

    function applyBackendControlAvailability(tiCapabilitiesKnown = false) {
        dependencies.renderControlAvailability(dependencies.els, dependencies.deriveControlAvailability(dependencies.getActiveBackendCapabilities(), {
            tiCapabilitiesKnown,
            nspire: dependencies.isNspireActive(),
            osStarted: dependencies.state.nspireOsReceiveStarted,
            backupLoaded: dependencies.state.backupDirlistLoaded,
            leaveExam: dependencies.state.leaveExamSupported
        }));
    }

    return { setStatus, setConnected, updateTransportSplashState, isWindowsPlatform, isLinuxPlatform, resetToSplashState, openConnectionHelpModal, closeConnectionHelpModal, showCableOpenHelp, isTI89TActive, isNspireActive, isHPPrimeActive, isHPLegacyActive, isNumWorksActive, buildFileInputAccept, updateFileInputAccept, isCasioActive, resetFamilySpecificUiText, setTiUiState, setHPPrimeUiState, setHPLegacyUiState, setNumWorksUiState, setCasioUiState, applyActiveFamilyUiState, is84pFamilyActive, getActiveKeyMapConfig, getFlashOsExtensionFromModule, ensureSupportedTransport, updateCapabilities, updateNspireOsButtons, setSharpUiState, getActiveBackendCapabilities, applyBackendControlAvailability };
}

module.exports = { createUiConnection };
