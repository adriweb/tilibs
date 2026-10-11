'use strict';

/**
 * features settings. Browser and application dependencies are injected
 * by app.js; importing this module does not start the application.
 * @param {object} dependencies
 * @returns {object}
 */
function createFeaturesSettings(dependencies) {
    function loadSettings() {
        const raw = dependencies.localStorage.getItem('webtilp.settings');
        if (!raw) {
            return { ...dependencies.SETTINGS_DEFAULTS };
        }
        try {
            const parsed = JSON.parse(raw);
            const {
                deviceFamily: _legacyDeviceFamily,
                convertPythonFiles: legacyConvertPythonFiles,
                convertLuaFiles: legacyConvertLuaFiles,
                ...persisted
            } = parsed;
            let calcModel = String(parsed.calcModel ?? dependencies.SETTINGS_DEFAULTS.calcModel);
            // experimental2 reordered lab equipment and inserted five USB models before Evo.
            if (Number(parsed.calcModelSchemaVersion ?? 1) < dependencies.SETTINGS_DEFAULTS.calcModelSchemaVersion) {
                const legacyModels = { 37: 38, 38: 39, 39: 40, 40: 41, 41: 42, 42: 37, 43: 48, 44: 49, 45: 50 };
                calcModel = String(legacyModels[calcModel] ?? calcModel);
            }
            return {
                ...dependencies.SETTINGS_DEFAULTS,
                ...persisted,
                cableModel: String(parsed.cableModel ?? dependencies.SETTINGS_DEFAULTS.cableModel),
                calcModelSchemaVersion: dependencies.SETTINGS_DEFAULTS.calcModelSchemaVersion,
                calcModel,
                cableTimeout: Number(parsed.cableTimeout ?? dependencies.SETTINGS_DEFAULTS.cableTimeout),
                cableDelay: Number(parsed.cableDelay ?? dependencies.SETTINGS_DEFAULTS.cableDelay),
                language: dependencies.normalizeLanguageCode(parsed.language) || 'auto',
                // Keep an existing opt-out when merging the old conversion settings.
                convertScriptFiles: typeof parsed.convertScriptFiles === 'boolean'
                    ? parsed.convertScriptFiles
                    : legacyConvertPythonFiles !== false && legacyConvertLuaFiles !== false
            };
        } catch (err) {
            dependencies.console.warn('[WebTILP] Failed to load settings', err);
            return { ...dependencies.SETTINGS_DEFAULTS };
        }
    }

    function normalizeOptionValue(value) {
        return String(value || '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '');
    }

    function resolveOptionValue(options, rawValue) {
        if (!rawValue) {
            return null;
        }
        const raw = String(rawValue).trim();
        const normalized = dependencies.normalizeOptionValue(raw);
        const byValue = options.find(option => String(option.value) === raw);
        if (byValue) {
            return String(byValue.value);
        }
        const byLabel = options.find(option => dependencies.getOptionLabels(option).some(label => dependencies.normalizeOptionValue(label) === normalized));
        if (byLabel) {
            return String(byLabel.value);
        }
        return null;
    }

    function resolveCableParam(rawValue) {
        if (!rawValue) {
            return null;
        }
        const normalized = dependencies.normalizeOptionValue(rawValue);
        if (!normalized) {
            return null;
        }
        if (normalized === 'auto') {
            return 'auto';
        }
        if (normalized === 'graylink' || normalized === 'greylink' || normalized === 'gry' || normalized === 'rs232') {
            return dependencies.CABLE_GRAYLINK;
        }
        if (normalized === 'silverlink' || normalized === 'dbus') {
            return dependencies.CABLE_SILVERLINK;
        }
        if (normalized === 'directlink' || normalized === 'dusb') {
            return dependencies.CABLE_DIRECTLINK;
        }
        return dependencies.resolveOptionValue(dependencies.CABLE_OPTIONS, rawValue);
    }

    function resolveCalcParam(rawValue) {
        if (!rawValue) {
            return null;
        }
        const raw = String(rawValue).trim();
        if (/^\d+$/.test(raw)) {
            return raw;
        }
        return dependencies.resolveOptionValue(dependencies.CALC_MODEL_OPTIONS, raw);
    }

    function applyUrlOverrides() {
        const params = new dependencies.URLSearchParams(dependencies.window.location.search);
        if (!params.size) {
            return;
        }

        const nextSettings = { ...dependencies.state.settings };
        let shouldOpenSettings = false;
        const cableValue = dependencies.resolveCableParam(params.get('cable'));
        if (cableValue != null) {
            nextSettings.cableModel = cableValue;
        } else if (params.get('cable')) {
            dependencies.alert(dependencies.tFormat('alert_unknown_cable_param', { value: params.get('cable') }));
        }
        const calcParam = params.get('calc');
        const calcValue = dependencies.resolveCalcParam(calcParam);
        if (calcValue != null) {
            nextSettings.calcModel = calcValue;
        } else if (calcParam) {
            (async () => {
                try {
                    const module = await dependencies.initModule();
                    const model = module.ccall('string_to_calc_model', 'number', ['string'], [calcParam]);
                    if (model > 0) {
                        dependencies.state.settings.calcModel = String(model);
                        if (dependencies.els.settingCalcModel) {
                            dependencies.populateSelect(dependencies.els.settingCalcModel, dependencies.getCalcOptionsForCable(dependencies.els.settingCableModel?.value || dependencies.state.settings.cableModel));
                            dependencies.els.settingCalcModel.value = dependencies.state.settings.calcModel;
                            dependencies.updateCalcHint(dependencies.els.settingCableModel?.value || dependencies.state.settings.cableModel);
                        }
                        const isDbusSerialCable = String(dependencies.state.settings.cableModel) === dependencies.CABLE_SILVERLINK
                            || String(dependencies.state.settings.cableModel) === dependencies.CABLE_GRAYLINK;
                        if (isDbusSerialCable && !dependencies.SILVERLINK_CALC_VALUES.has(model)) {
                            shouldOpenSettings = true;
                            dependencies.openSettingsModal();
                        }
                    } else {
                        dependencies.alert(dependencies.tFormat('alert_unknown_calc_param', { value: calcParam }));
                    }
                } catch (err) {
                    dependencies.console.warn('[WebTILP] Failed to resolve calc URL param', err);
                    dependencies.alert(dependencies.tFormat('alert_failed_resolve_calc_param', { value: calcParam }));
                }
            })();
        }
        const timeout = Number(params.get('timeout'));
        if (Number.isFinite(timeout) && timeout > 0) {
            nextSettings.cableTimeout = timeout;
        } else if (params.get('timeout')) {
            dependencies.alert(dependencies.tFormat('alert_invalid_timeout_param', { value: params.get('timeout') }));
        }
        const delay = Number(params.get('delay'));
        if (Number.isFinite(delay) && delay >= 0) {
            nextSettings.cableDelay = delay;
        } else if (params.get('delay')) {
            dependencies.alert(dependencies.tFormat('alert_invalid_delay_param', { value: params.get('delay') }));
        }
        dependencies.state.settings = nextSettings;

        const isDbusSerialCable = String(dependencies.state.settings.cableModel) === dependencies.CABLE_SILVERLINK
            || String(dependencies.state.settings.cableModel) === dependencies.CABLE_GRAYLINK;
        const calcModelValue = String(dependencies.state.settings.calcModel || '');
        const isCalcAuto = !calcParam || calcModelValue === 'auto';
        const isCalcValidForDbusSerial = dependencies.SILVERLINK_CALC_VALUES.has(Number(calcModelValue));
        if (isDbusSerialCable && (isCalcAuto || !isCalcValidForDbusSerial)) {
            shouldOpenSettings = true;
        }

        const themeParam = params.get('theme');
        if (themeParam) {
            const normalized = dependencies.normalizeOptionValue(themeParam);
            const target = dependencies.THEMES.find(theme => dependencies.normalizeOptionValue(theme.id) === normalized
                || dependencies.getOptionLabels(theme).some(label => dependencies.normalizeOptionValue(label) === normalized));
            if (target) {
                dependencies.applyTheme(target.id);
            } else {
                dependencies.alert(dependencies.tFormat('alert_unknown_theme_param', { value: themeParam }));
            }
        }

        const newUrl = `${dependencies.window.location.pathname}${dependencies.window.location.hash || ''}`;
        if (dependencies.window.location.search) {
            dependencies.window.history.replaceState({}, dependencies.document.title, newUrl);
        }

        if (shouldOpenSettings) {
            dependencies.openSettingsModal();
        }
    }

    function saveSettings() {
        dependencies.localStorage.setItem('webtilp.settings', JSON.stringify({
            ...dependencies.state.settings,
            calcModelSchemaVersion: dependencies.SETTINGS_DEFAULTS.calcModelSchemaVersion
        }));
    }

    function applySettingsToModule(module = dependencies.state.module) {
        if (!module) {
            return;
        }
        const settings = dependencies.state.settings;
        module._set_cable_timeout(settings.cableTimeout);
        module._set_cable_delay(settings.cableDelay);
        if (settings.cableModel === 'auto') {
            module._set_force_cable(0);
        } else {
            module._set_cable_model(Number(settings.cableModel));
            module._set_force_cable(1);
        }


        if (settings.calcModel === 'auto' || String(settings.calcModel).startsWith('sharp-')) {
            module._set_calc_model(0);
            module._set_force_calc(0);
        } else {
            module._set_calc_model(Number(settings.calcModel));
            module._set_force_calc(1);
        }
    }

    async function applyWebUsbDeviceCableHint(module, device) {
        if (!device || !module) {
            return;
        }
        if (dependencies.isSerialDevice(device)) {
            dependencies.bindSerialPortToModule(module, device);
            if (dependencies.isGrayLinkSerialDevice(device)) {
                module._set_cable_model(Number(dependencies.CABLE_GRAYLINK));
                module._set_force_cable(1);
                dependencies.log('Cable hint applied: GrayLink WebSerial');
                return;
            }
            module._set_cable_model(Number(dependencies.CABLE_DIRECTLINK));
            module._set_force_cable(1);
            const calcSetting = String(dependencies.state.settings?.calcModel ?? 'auto');
            if (calcSetting === 'auto' || (!dependencies.navigator.usb && calcSetting !== '48' && calcSetting !== '49' && calcSetting !== '50')) {
                module._set_calc_model(dependencies.getEvoCalcModelForDevice(device));
                module._set_force_calc(0);
            }
            dependencies.log('Cable hint applied: TI-83/84 Evo WebSerial');
            return;
        }
        if (dependencies.state.settings && dependencies.state.settings.cableModel !== 'auto') {
            return;
        }
        if (device.vendorId !== 0x0451) {
            return;
        }

        if (device.productId === dependencies.PID_SILVERLINK) {
            module._set_cable_model(Number(dependencies.CABLE_SILVERLINK));
            module._set_force_cable(1);
            dependencies.log('Cable hint applied: SilverLink USB');
            return;
        }

        if (dependencies.DIRECTLINK_PIDS.has(device.productId)) {
            module._set_cable_model(Number(dependencies.CABLE_DIRECTLINK));
            module._set_force_cable(1);
            dependencies.log('Cable hint applied: DirectLink USB');
        }
    }

    function hasSilverlinkConnected() {
        return dependencies.state.authorizedDevice && dependencies.state.authorizedDevice.productId === dependencies.PID_SILVERLINK;
    }

    function isGrayLinkSelected() {
        return String(dependencies.state.settings?.cableModel ?? 'auto') === dependencies.CABLE_GRAYLINK || dependencies.isGrayLinkSerialDevice();
    }

    function isTi92Selected() {
        return String(dependencies.state.settings?.calcModel ?? '') === '10';
    }

    function getActiveCalcModelString() {
        if (!dependencies.state.module) {
            return null;
        }
        try {
            const value = dependencies.state.module.ccall('get_calc_model_string', 'string', [], []);
            return value || null;
        } catch (err) {
            return null;
        }
    }

    function getActiveCalcModelId() {
        if (dependencies.state?.activeFamily === 'sharp') return 0;

        if (!dependencies.state.module) {
            return 0;
        }
        try {
            return Number(dependencies.state.module.ccall('get_calc_model_id', 'number', [], [])) || 0;
        } catch (err) {
            return 0;
        }
    }

    function getPythonConversionKind(model) {
        const modelId = Number(model);
        if (dependencies.CE_PYTHON_CALC_MODELS.has(modelId)) {
            return dependencies.PYTHON_CONVERSION_CE;
        }
        if (dependencies.EVO_PYTHON_CALC_MODELS.has(modelId)) {
            return dependencies.PYTHON_CONVERSION_EVO;
        }
        if (dependencies.NSPIRE_CXII_PYTHON_CALC_MODELS.has(modelId)) {
            return dependencies.PYTHON_CONVERSION_NSPIRE_CXII;
        }
        return dependencies.PYTHON_CONVERSION_NONE;
    }

    function getSelectedConversionModelId() {
        const selectedModel = dependencies.els.settingCalcModel?.value ?? dependencies.state.settings?.calcModel ?? 'auto';
        return selectedModel === 'auto' ? dependencies.getActiveCalcModelId() : Number(selectedModel);
    }

    function updateSourceConversionSettingAvailability() {
        if (!dependencies.els.settingConvertScriptFiles) {
            return;
        }
        const modelId = dependencies.getSelectedConversionModelId();
        const supported = dependencies.getPythonConversionKind(modelId) !== dependencies.PYTHON_CONVERSION_NONE
            || dependencies.NSPIRE_LUA_CALC_MODELS.has(modelId);
        dependencies.els.settingConvertScriptFiles.disabled = !supported;
        dependencies.els.settingConvertScriptFilesField?.classList.toggle('disabled', !supported);
    }

    function resolveDeviceModelName(infoProductName) {
        let calcModelLabel = dependencies.getActiveCalcModelString() || '';
        if (dependencies.hasSilverlinkConnected()) {
            const calcModel = dependencies.state.settings?.calcModel ?? 'auto';
            if (calcModel !== 'auto') {
                return { primary: dependencies.getCalcModelLabel(calcModel), secondary: calcModelLabel };
            }
            return { primary: 'Unknown', secondary: calcModelLabel };
        } else {
            if (calcModelLabel.endsWith(' USB')) {
                calcModelLabel = calcModelLabel.slice(0, -4);
            }
            if (dependencies.isCEModelConnected() && (dependencies.getDeviceInfoValue('Python on board') === 'Yes')) {
                if (dependencies.is83PCEConnected()) {
                    calcModelLabel += ' Edition Python';
                } else {
                    calcModelLabel += ' Python';
                }
            }
        }
        const deviceName = dependencies.state.authorizedDevice?.productName || '';
        const infoName = infoProductName || dependencies.state.deviceInfoProductName || dependencies.state.deviceModelName || '';
        if (deviceName && infoName && deviceName !== infoName) {
            return { primary: deviceName, secondary: calcModelLabel || infoName };
        }
        const primary = infoName || deviceName || 'Unknown';
        return { primary, secondary: calcModelLabel };
    }

    function deviceMatches(a, b) {
        if (!a || !b) {
            return false;
        }
        if (dependencies.isSerialDevice(a) || dependencies.isSerialDevice(b)) {
            return dependencies.isSerialDevice(a)
                && dependencies.isSerialDevice(b)
                && a.serialKind === b.serialKind
                && a.vendorId === b.vendorId
                && a.productId === b.productId;
        }
        return a.vendorId === b.vendorId
            && a.productId === b.productId
            && (a.productName || '') === (b.productName || '');
    }

    function getEvoCalcModelForDevice(device) {
        const name = `${device?.productName || ''} ${device?.deviceName || ''}`;
        if (/83\s*\/\s*84\s*evo|evo\s*\/\s*evo[-_ ]?t/i.test(name)) {
            return 48;
        }
        if (/ti[-_ ]?83|83\s*evo|83evo/i.test(name)) {
            return 50;
        }
        return /evo[-_ ]?t/i.test(name) ? 49 : 48;
    }

    function updateDeviceModelDisplay(infoProductName) {
        if (!dependencies.els.deviceModel) {
            return;
        }
        const resolved = dependencies.resolveDeviceModelName(infoProductName);
        if (resolved.secondary && resolved.secondary !== resolved.primary) {
            const primary = dependencies.escapeHtml(resolved.primary);
            const secondary = dependencies.escapeHtml(resolved.secondary);
            dependencies.els.deviceModel.innerHTML = `${primary}<div class="device-model-secondary">(${secondary})</div>`;
        } else {
            dependencies.els.deviceModel.textContent = resolved.primary;
        }
    }

    function promptCableMismatchResolution() {
        if (!dependencies.state.authorizedDevice) {
            return false;
        }
        const pid = dependencies.state.authorizedDevice.productId;
        const isSilverlinkDevice = pid === dependencies.PID_SILVERLINK;
        const isDirectlinkDevice = dependencies.DIRECTLINK_PIDS.has(pid);
        const forcedCable = dependencies.state.settings?.cableModel ?? 'auto';
        const forcedSilverlink = forcedCable === dependencies.CABLE_SILVERLINK;
        const forcedDirectlink = forcedCable === dependencies.CABLE_DIRECTLINK;

        if (isSilverlinkDevice && forcedDirectlink) {
            const confirmSwitch = dependencies.confirm(dependencies.t('confirm_switch_to_silverlink'));
            if (confirmSwitch) {
                dependencies.state.settings.cableModel = dependencies.CABLE_SILVERLINK;
                dependencies.state.settings.calcModel = 'auto';
                dependencies.saveSettings();
                dependencies.openSettingsModal();
            }
            return true;
        }

        if (isDirectlinkDevice && forcedSilverlink) {
            const confirmSwitch = dependencies.confirm(dependencies.t('confirm_switch_to_directlink'));
            if (confirmSwitch) {
                dependencies.state.settings.cableModel = dependencies.CABLE_DIRECTLINK;
                dependencies.state.settings.calcModel = 'auto';
                dependencies.saveSettings();
                dependencies.window.location.reload();
            }
            return true;
        }

        return false;
    }

    function ensureSilverlinkModelSelected() {
        if (!dependencies.hasSilverlinkConnected()) {
            return true;
        }
        const calcModel = dependencies.state.settings?.calcModel ?? 'auto';
        if (calcModel !== 'auto') {
            return true;
        }
        dependencies.alert(dependencies.t('alert_silverlink_model_required'));
        dependencies.openSettingsModal();
        return false;
    }

    function ensureGrayLinkModelSelected() {
        if (!dependencies.isGrayLinkSelected()) {
            return true;
        }
        const calcModel = dependencies.state.settings?.calcModel ?? 'auto';
        if (calcModel !== 'auto') {
            return true;
        }
        dependencies.alert(dependencies.t('alert_graylink_model_required'));
        dependencies.openSettingsModal();
        return false;
    }

    function populateSelect(select, options) {
        select.innerHTML = '';
        options.forEach(option => {
            const item = dependencies.document.createElement('option');
            item.value = String(option.value);
            item.textContent = dependencies.getOptionLabel(option);
            select.appendChild(item);
        });
    }

    function sortCalcOptions(options) {
        const autoOption = options.find(option => String(option.value) === 'auto');
        const rest = options
            .filter(option => String(option.value) !== 'auto')
            .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
        return autoOption ? [autoOption, ...rest] : rest;
    }

    function getCalcOptionsForCable(cableModel) {
        if (String(cableModel) === dependencies.CABLE_SILVERLINK || String(cableModel) === dependencies.CABLE_GRAYLINK) {
            return dependencies.sortCalcOptions(dependencies.CALC_MODEL_OPTIONS.filter(option => option.value === 'auto' || String(option.value).startsWith('sharp-') || dependencies.SILVERLINK_CALC_VALUES.has(Number(option.value))));
        }
        if (String(cableModel) === dependencies.CABLE_DIRECTLINK) {
            return dependencies.sortCalcOptions(dependencies.CALC_MODEL_OPTIONS.filter(option => option.value === 'auto' || String(option.value).startsWith('sharp-') || dependencies.DIRECTLINK_CALC_VALUES.has(Number(option.value))));
        }
        return dependencies.sortCalcOptions(dependencies.CALC_MODEL_OPTIONS);
    }

    function updateCalcHint(cableModel) {
        if (!dependencies.els.settingCalcHint) {
            return;
        }
        if (String(cableModel) === dependencies.CABLE_SILVERLINK) {
            dependencies.els.settingCalcHint.textContent = dependencies.t('silverlink_hint');
            return;
        }
        if (String(cableModel) === dependencies.CABLE_GRAYLINK) {
            dependencies.els.settingCalcHint.textContent = dependencies.t('graylink_hint');
            return;
        }
        dependencies.els.settingCalcHint.textContent = dependencies.t('auto_probe_hint');
    }

    function seedSettingsForm() {
        dependencies.populateSelect(dependencies.els.settingCableModel, dependencies.CABLE_OPTIONS);
        dependencies.els.settingCableModel.value = dependencies.state.settings.cableModel;
        dependencies.populateSelect(dependencies.els.settingCalcModel, dependencies.getCalcOptionsForCable(dependencies.els.settingCableModel.value));
        dependencies.els.settingCalcModel.value = dependencies.state.settings.calcModel;
        dependencies.els.settingTimeout.value = dependencies.state.settings.cableTimeout;
        dependencies.els.settingDelay.value = dependencies.state.settings.cableDelay;
        dependencies.populateSelect(dependencies.els.settingLanguage, dependencies.LANGUAGE_OPTIONS);
        dependencies.els.settingLanguage.value = dependencies.state.settings.language || 'auto';
        if (dependencies.els.settingConvertScriptFiles) {
            dependencies.els.settingConvertScriptFiles.checked = dependencies.state.settings.convertScriptFiles !== false;
        }
        dependencies.updateCalcHint(dependencies.els.settingCableModel.value);
        dependencies.updateSourceConversionSettingAvailability();
    }

    function openSettingsModal() {
        dependencies.seedSettingsForm();

        dependencies.els.settingsModal.classList.remove('hidden');
    }

    function closeSettingsModal() {
        dependencies.els.settingsModal.classList.add('hidden');
    }

    function populateNewFolderParents() {
        if (!dependencies.els.newFolderParent) {
            return;
        }
        const folders = dependencies.isNspireActive()
            ? dependencies.getDirlistFolders().sort((a, b) => a.localeCompare(b))
            : [];
        dependencies.els.newFolderParent.innerHTML = '';
        const rootOption = dependencies.document.createElement('option');
        rootOption.value = '';
        rootOption.textContent = dependencies.t('root');
        dependencies.els.newFolderParent.appendChild(rootOption);
        folders.forEach(folder => {
            const option = dependencies.document.createElement('option');
            option.value = folder;
            option.textContent = folder;
            dependencies.els.newFolderParent.appendChild(option);
        });
    }

    function openNewFolderModal() {
        if (!dependencies.els.newFolderModal) {
            return;
        }
        dependencies.populateNewFolderParents();
        if (dependencies.els.newFolderName) {
            dependencies.els.newFolderName.value = '';
        }
        dependencies.els.newFolderModal.classList.remove('hidden');
        if (dependencies.els.newFolderName) {
            dependencies.els.newFolderName.focus();
        }
    }

    function closeNewFolderModal() {
        if (!dependencies.els.newFolderModal) {
            return;
        }
        dependencies.els.newFolderModal.classList.add('hidden');
    }

    function resetSettings() {
        const current = JSON.stringify(dependencies.state.settings);
        const defaults = JSON.stringify(dependencies.SETTINGS_DEFAULTS);
        if (current === defaults) {
            dependencies.closeSettingsModal();
            dependencies.log('Settings unchanged.');
            return;
        }
        dependencies.state.settings = { ...dependencies.SETTINGS_DEFAULTS };
        dependencies.saveSettings();
        dependencies.log('Settings reset to defaults. Reloading...');
        dependencies.window.location.reload();
    }

    async function saveSettingsFromModal() {
        if (dependencies.els.settingCableModel.value === dependencies.CABLE_SILVERLINK && dependencies.els.settingCalcModel.value === 'auto') {
            dependencies.alert(dependencies.t('alert_silverlink_choose_model'));
            return;
        }
        if (dependencies.els.settingCableModel.value === dependencies.CABLE_GRAYLINK && dependencies.els.settingCalcModel.value === 'auto') {
            dependencies.alert(dependencies.t('alert_graylink_model_required'));
            return;
        }
        const nextSettings = {
            cableModel: dependencies.els.settingCableModel.value,
            calcModel: dependencies.els.settingCalcModel.value,
            cableTimeout: Number(dependencies.els.settingTimeout.value || dependencies.SETTINGS_DEFAULTS.cableTimeout),
            cableDelay: Number(dependencies.els.settingDelay.value || dependencies.SETTINGS_DEFAULTS.cableDelay),
            language: dependencies.normalizeLanguageCode(dependencies.els.settingLanguage.value) || 'auto',
            convertScriptFiles: dependencies.els.settingConvertScriptFiles ? dependencies.els.settingConvertScriptFiles.checked : dependencies.SETTINGS_DEFAULTS.convertScriptFiles
        };
        if (JSON.stringify(dependencies.state.settings) === JSON.stringify(nextSettings)) {
            dependencies.closeSettingsModal();
            dependencies.log('Settings unchanged.');
            return;
        }
        const languageOnlyChange = dependencies.state.settings
            && dependencies.state.settings.cableModel === nextSettings.cableModel
            && dependencies.state.settings.calcModel === nextSettings.calcModel
            && Number(dependencies.state.settings.cableTimeout) === Number(nextSettings.cableTimeout)
            && Number(dependencies.state.settings.cableDelay) === Number(nextSettings.cableDelay)
            && dependencies.state.settings.convertScriptFiles === nextSettings.convertScriptFiles
            && dependencies.state.settings.language !== nextSettings.language;
        const conversionOnlyChange = dependencies.state.settings
            && dependencies.state.settings.cableModel === nextSettings.cableModel
            && dependencies.state.settings.calcModel === nextSettings.calcModel
            && Number(dependencies.state.settings.cableTimeout) === Number(nextSettings.cableTimeout)
            && Number(dependencies.state.settings.cableDelay) === Number(nextSettings.cableDelay)
            && dependencies.state.settings.language === nextSettings.language
            && dependencies.state.settings.convertScriptFiles !== nextSettings.convertScriptFiles;
        dependencies.state.settings = nextSettings;
        dependencies.saveSettings();
        if (conversionOnlyChange) {
            dependencies.updateFileInputAccept();
            dependencies.closeSettingsModal();
            dependencies.log('Source file conversion settings updated.');
            return;
        }
        if (languageOnlyChange) {
            try {
                await dependencies.applyTranslations();
                dependencies.seedSettingsForm();
                dependencies.closeSettingsModal();
                dependencies.log('Language updated.');
                return;
            } catch (err) {
                dependencies.console.warn('[WebTILP] Failed to apply language without reload, falling back to page reload.', err);
                // fallthrough
            }
        }
        dependencies.log('Settings saved. Reloading...');
        dependencies.window.location.reload();
    }

    return { loadSettings, normalizeOptionValue, resolveOptionValue, resolveCableParam, resolveCalcParam, applyUrlOverrides, saveSettings, applySettingsToModule, applyWebUsbDeviceCableHint, hasSilverlinkConnected, isGrayLinkSelected, isTi92Selected, getActiveCalcModelString, getActiveCalcModelId, getPythonConversionKind, getSelectedConversionModelId, updateSourceConversionSettingAvailability, resolveDeviceModelName, deviceMatches, getEvoCalcModelForDevice, updateDeviceModelDisplay, promptCableMismatchResolution, ensureSilverlinkModelSelected, ensureGrayLinkModelSelected, populateSelect, sortCalcOptions, getCalcOptionsForCable, updateCalcHint, seedSettingsForm, openSettingsModal, closeSettingsModal, populateNewFolderParents, openNewFolderModal, closeNewFolderModal, resetSettings, saveSettingsFromModal };
}

module.exports = { createFeaturesSettings };
