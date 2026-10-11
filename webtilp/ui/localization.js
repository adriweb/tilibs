'use strict';

/**
 * ui localization. Browser and application dependencies are injected
 * by app.js; importing this module does not start the application.
 * @param {object} dependencies
 * @returns {object}
 */
function createUiLocalization(dependencies) {
    async function loadLocaleDictionary(language) {
        const lang = dependencies.normalizeLanguageCode(language) || 'en';
        if (dependencies.LOCALE_CACHE.has(lang)) {
            return dependencies.LOCALE_CACHE.get(lang);
        }
        try {
            const response = await dependencies.fetch(`${dependencies.LOCALE_BASE_PATH}/${lang}.json`, { cache: 'no-store' });
            if (!response.ok) {
                throw new Error(`HTTP \${response.status}`);
            }
            const data = await response.json();
            dependencies.LOCALE_CACHE.set(lang, data || {});
            return data || {};
        } catch (err) {
            dependencies.console.warn('[WebTILP] Failed to load locale', lang, err);
            dependencies.LOCALE_CACHE.set(lang, {});
            return {};
        }
    }

    function normalizeLanguageCode(code) {
        const raw = String(code || '').trim().toLowerCase();
        if (!raw) {
            return null;
        }
        if (raw === 'zh' || raw.startsWith('zh-') || raw.startsWith('zh_')) {
            return 'zh';
        }
        const base = raw.split(/[-_]/)[0];
        if (dependencies.SUPPORTED_LANGUAGES.includes(raw)) {
            return raw;
        }
        if (dependencies.SUPPORTED_LANGUAGES.includes(base)) {
            return base;
        }
        return null;
    }

    function detectBrowserLanguage() {
        const candidates = [];
        if (Array.isArray(dependencies.navigator.languages)) {
            candidates.push(...dependencies.navigator.languages);
        }
        if (dependencies.navigator.language) {
            candidates.push(dependencies.navigator.language);
        }
        for (const candidate of candidates) {
            const normalized = dependencies.normalizeLanguageCode(candidate);
            if (normalized) {
                return normalized;
            }
        }
        return 'en';
    }

    function resolveUiLanguage(configuredLanguage) {
        const normalizedConfigured = dependencies.normalizeLanguageCode(configuredLanguage);
        if (normalizedConfigured && normalizedConfigured !== 'auto') {
            return normalizedConfigured;
        }
        return dependencies.detectBrowserLanguage();
    }

    function t(key) {
        const language = dependencies.state.uiLanguage || 'en';
        const locale = dependencies.LOCALE_CACHE.get(language);
        if (locale && Object.prototype.hasOwnProperty.call(locale, key)) {
            return locale[key];
        }
        if (Object.prototype.hasOwnProperty.call(dependencies.I18N_EN, key)) {
            return dependencies.I18N_EN[key];
        }
        return key;
    }

    function tFormat(key, vars = {}) {
        let text = String(dependencies.t(key));
        for (const [name, value] of Object.entries(vars)) {
            text = text.replaceAll(`{${name}}`, String(value));
        }
        return text;
    }

    function getOptionLabel(option) {
        if (option.labelKey) {
            return dependencies.t(option.labelKey);
        }
        return option.label;
    }

    function getOptionLabels(option) {
        const labels = [];
        if (option.label) {
            labels.push(String(option.label));
        }
        if (option.labelKey) {
            labels.push(String(dependencies.t(option.labelKey)));
            const englishLabel = dependencies.I18N_EN?.[option.labelKey];
            if (englishLabel) {
                labels.push(String(englishLabel));
            }
        }
        return labels;
    }

    function setTextContent(element, value) {
        if (element) {
            element.textContent = value;
        }
    }

    function getStatusTranslationKey(text) {
        const raw = String(text || '').trim();
        if (!raw) {
            return null;
        }
        return dependencies.STATUS_I18N_KEYS.has(raw) ? raw : null;
    }

    function applyStatusTranslation(text, key = null) {
        const resolvedKey = key || dependencies.getStatusTranslationKey(text);
        if (!resolvedKey) {
            return text;
        }
        return dependencies.t(resolvedKey);
    }

    function syncStatusTranslation(text) {
        if (!dependencies.els.statusText) {
            return;
        }
        const key = dependencies.getStatusTranslationKey(text) || dependencies.getStatusTranslationKey(dependencies.els.statusText.dataset.i18nKey);
        if (key) {
            dependencies.els.statusText.dataset.i18nKey = key;
            dependencies.els.statusText.textContent = dependencies.applyStatusTranslation(key, key);
            return;
        }
        delete dependencies.els.statusText.dataset.i18nKey;
        dependencies.els.statusText.textContent = text;
    }

    async function applyTranslations() {
        dependencies.state.uiLanguage = dependencies.resolveUiLanguage(dependencies.state.settings?.language || 'auto');
        await dependencies.loadLocaleDictionary(dependencies.state.uiLanguage);
        dependencies.document.documentElement.lang = dependencies.state.uiLanguage === 'zh' ? 'zh-CN' : dependencies.state.uiLanguage;
        dependencies.document.documentElement.dir = dependencies.state.uiLanguage === 'fa' ? 'rtl' : 'ltr';

        dependencies.setTextContent(dependencies.document.getElementById('brandSubtitle'), dependencies.t('brand_subtitle'));
        dependencies.setIconLabel(dependencies.els.btnSettings, 'settings', dependencies.t('settings'), '⚙️');
        dependencies.setIconLabel(dependencies.els.btnConnect, 'zap', dependencies.t('connect_calculator'), '🔌');
        dependencies.setTextContent(dependencies.document.getElementById('splashTitle'), dependencies.t('welcome_title'));
        dependencies.setTextContent(dependencies.document.getElementById('splashText'), dependencies.t('welcome_text'));
        dependencies.setTextContent(dependencies.document.getElementById('splashWebUsbWarningTitle'), dependencies.t('webusb_unavailable_title'));
        dependencies.setTextContent(dependencies.document.getElementById('splashWebUsbWarningText'), dependencies.t('webusb_unavailable_text'));
        dependencies.setIconLabel(dependencies.els.btnSplashConnect, 'zap', dependencies.t('connect_calculator'), '🔌');

        dependencies.setTextContent(dependencies.document.getElementById('panelDeviceTitle'), dependencies.t('device'));
        dependencies.setTextContent(dependencies.document.getElementById('labelModel'), dependencies.t('model'));
        dependencies.setTextContent(dependencies.document.getElementById('labelFreeMemory'), dependencies.t('free_memory'));
        dependencies.setIconLabel(dependencies.els.btnGetInfo, 'info', dependencies.t('refresh_device_info'), 'ℹ️');
        dependencies.setIconLabel(dependencies.els.btnSyncClock, 'clock', dependencies.t('sync_clock'), '🕒');

        dependencies.setTextContent(dependencies.document.getElementById('panelTransfersTitle'), dependencies.t('transfers'));
        dependencies.setIconLabel(dependencies.els.btnIsReady, 'check', dependencies.t('is_ready'), '✅');
        dependencies.setTextContent(dependencies.document.getElementById('dropzoneTitle'), dependencies.t('dropzone_title'));
        dependencies.setTextContent(dependencies.document.getElementById('dropzoneSubtitle'), dependencies.t('dropzone_subtitle'));
        dependencies.setIconLabel(dependencies.els.btnSendFiles, 'upload', dependencies.t('send_selected_files'), '📤');
        dependencies.setIconLabel(dependencies.els.btnReceiveBackup, 'archive', dependencies.t('make_backup'), '📥');
        dependencies.setIconLabel(dependencies.els.btnReceiveOs, 'download', dependencies.t('receive_os'), '📥');
        dependencies.setIconLabel(dependencies.els.btnDownloadOsPartial, 'download', dependencies.t('download_os_so_far'), '⬇️');
        dependencies.setIconLabel(dependencies.els.btnDumpRom, 'cpu', dependencies.t('dump_rom'), '🧠');
        dependencies.setIconLabel(dependencies.els.btnLeaveExam, 'log-out', dependencies.t('leave_exam_mode'), '👨‍🎓');
        dependencies.setTextContent(dependencies.els.btnBackupDirlist, dependencies.t('list_from_backup'));
        dependencies.setTextContent(dependencies.els.backupDirlistNote, dependencies.t('backup_dirlist_note'));

        dependencies.setTextContent(dependencies.document.getElementById('panelKeysTitle'), dependencies.t('remote_keys'));
        if (dependencies.els.keyCodeInput) {
            dependencies.els.keyCodeInput.placeholder = dependencies.t('key_input_placeholder');
        }
        dependencies.setIconLabel(dependencies.els.btnSendKey, 'target', dependencies.t('send_key'), '🎯');

        dependencies.setTextContent(dependencies.document.getElementById('panelVarsTitle'), dependencies.t('calculator_variables'));
        if (dependencies.els.filterInput) {
            dependencies.els.filterInput.placeholder = dependencies.t('filter_name_or_type');
        }
        dependencies.setIconLabel(dependencies.els.btnRefreshDirlist, 'refresh-cw', dependencies.t('refresh_list'), '🔄');
        dependencies.setIconLabel(dependencies.els.btnNewFolder, 'folder-plus', dependencies.t('new_folder'), '📁');
        dependencies.setIconLabel(dependencies.els.btnRecvSelected, 'download', dependencies.t('receive_selected'), '⬇️');
        dependencies.setIconLabel(dependencies.els.btnDeleteSelected, 'trash-2', dependencies.t('delete_selected'), '🗑️');
        dependencies.setTextContent(dependencies.document.getElementById('varsHeaderName'), dependencies.t('name'));
        dependencies.setTextContent(dependencies.document.getElementById('varsHeaderType'), dependencies.t('type'));
        dependencies.setTextContent(dependencies.document.getElementById('varsHeaderSize'), dependencies.t('size'));
        dependencies.setTextContent(dependencies.document.getElementById('varsHeaderLocation'), dependencies.t('location'));
        dependencies.setTextContent(dependencies.document.getElementById('varsHeaderFolder'), dependencies.t('folder'));
        dependencies.setTextContent(dependencies.document.getElementById('varsHeaderKind'), dependencies.t('kind'));
        dependencies.setTextContent(dependencies.els.previewReindentLabel, dependencies.t('reindent'));
        dependencies.setIconLabel(dependencies.els.btnDownloadPreview, 'download', dependencies.t('download'), '⬇️');
        dependencies.setTextContent(dependencies.els.previewDownloadLabel, `${dependencies.t('download')}:`);
        dependencies.els.previewBasicDownloads?.setAttribute('aria-label', dependencies.t('download'));
        dependencies.setTextContent(dependencies.els.btnDismissPreview, dependencies.t('close'));

        dependencies.setTextContent(dependencies.document.getElementById('panelScreenshotTitle'), dependencies.t('screenshot'));
        dependencies.setIconLabel(dependencies.els.btnScreenshot, 'camera', dependencies.t('take_screenshot'), '📸');
        dependencies.setIconLabel(dependencies.els.btnDownloadScreenshot, 'download', dependencies.t('download_png'), '⬇️');
        dependencies.setTextContent(dependencies.document.getElementById('panelLogTitle'), dependencies.t('activity_log'));
        dependencies.setIconLabel(dependencies.els.btnClearLog, 'x-circle', dependencies.t('clear_log'), '🧹');

        dependencies.setTextContent(dependencies.document.getElementById('settingsTitle'), dependencies.t('settings_title'));
        dependencies.setTextContent(dependencies.document.getElementById('settingCableLabel'), dependencies.t('cable'));
        dependencies.setTextContent(dependencies.document.getElementById('settingCableHint'), dependencies.t('force_cable_hint'));
        dependencies.setTextContent(dependencies.document.getElementById('settingCalcLabel'), dependencies.t('calculator_model'));
        dependencies.setTextContent(dependencies.document.getElementById('settingTimeoutLabel'), dependencies.t('cable_timeout'));
        dependencies.setTextContent(dependencies.document.getElementById('settingDelayLabel'), dependencies.t('cable_delay'));
        dependencies.setTextContent(dependencies.document.getElementById('settingLanguageLabel'), dependencies.t('language'));
        dependencies.setTextContent(dependencies.document.getElementById('settingConvertScriptFilesLabel'), dependencies.t('convert_script_files'));
        dependencies.setTextContent(dependencies.document.getElementById('settingsNote'), dependencies.t('settings_note'));
        dependencies.setTextContent(dependencies.document.getElementById('offlineBannerText'), dependencies.state.offlineUpdateShown ? dependencies.t('offline_update_available') : dependencies.t('offline_ready'));
        dependencies.setIconLabel(dependencies.els.btnReloadOffline, 'refresh-cw', dependencies.t('reload_for_update'), '↻');
        dependencies.setTextContent(dependencies.els.btnClearOfflineCache, dependencies.t('clear_offline_cache'));
        dependencies.setIconLabel(dependencies.els.btnResetSettings, 'rotate-ccw', dependencies.t('reset_defaults'), '↩️');
        dependencies.setIconLabel(dependencies.els.btnSaveSettings, 'save', dependencies.t('save_settings'), '💾');

        dependencies.setTextContent(dependencies.document.getElementById('transferTitle'), dependencies.t('transfer_options'));
        dependencies.setTextContent(dependencies.document.getElementById('transferHeaderFile'), dependencies.t('file'));
        dependencies.setTextContent(dependencies.document.getElementById('transferHeaderVariable'), dependencies.t('variable'));
        dependencies.setTextContent(dependencies.document.getElementById('transferHeaderSize'), dependencies.t('size'));
        dependencies.setTextContent(dependencies.document.getElementById('transferHeaderType'), dependencies.t('type'));
        dependencies.setTextContent(dependencies.document.getElementById('transferHeaderLocation'), dependencies.t('location'));
        dependencies.setTextContent(dependencies.document.getElementById('transferHeaderFolder'), dependencies.t('folder'));
        dependencies.setTextContent(dependencies.document.getElementById('transferNote'), dependencies.t('transfer_note'));
        dependencies.setTextContent(dependencies.document.getElementById('transferOverwriteAllLabel'), dependencies.t('transfer_overwrite_all'));
        dependencies.setTextContent(dependencies.els.btnTransferAllRam, dependencies.t('transfer_all_ram'));
        dependencies.setTextContent(dependencies.els.btnTransferAllArchive, dependencies.t('transfer_all_archive'));
        dependencies.setTextContent(dependencies.els.btnCancelTransfer, dependencies.t('cancel'));
        dependencies.setIconLabel(dependencies.els.btnConfirmTransfer, 'send', dependencies.t('start_transfer'), '🚀');

        dependencies.setTextContent(dependencies.document.getElementById('newFolderTitle'), dependencies.t('create_folder'));
        dependencies.setTextContent(dependencies.document.getElementById('newFolderNameLabel'), dependencies.t('folder_name'));
        dependencies.setTextContent(dependencies.document.getElementById('newFolderParentLabel'), dependencies.t('parent_folder'));
        if (dependencies.els.newFolderName) {
            dependencies.els.newFolderName.placeholder = dependencies.t('new_folder_placeholder');
        }
        dependencies.setTextContent(dependencies.document.getElementById('newFolderNote'), dependencies.t('new_folder_note'));
        dependencies.setTextContent(dependencies.els.btnCancelNewFolder, dependencies.t('cancel'));
        dependencies.setTextContent(dependencies.els.btnCreateNewFolder, dependencies.t('create'));

        dependencies.setTextContent(dependencies.document.getElementById('backupTitle'), dependencies.t('backup_options'));
        dependencies.setTextContent(dependencies.document.getElementById('backupFormatLabel'), dependencies.t('backup_format'));
        dependencies.setTextContent(dependencies.document.getElementById('backupFormatBackupLabel'), dependencies.t('standard_backup_file'));
        dependencies.setTextContent(dependencies.document.getElementById('backupFormatTigroupLabel'), dependencies.t('tigroup'));
        dependencies.setTextContent(dependencies.document.getElementById('backupIncludeLabel'), dependencies.t('include_in_tigroup'));
        dependencies.setTextContent(dependencies.document.getElementById('backupIncludeRamLabel'), dependencies.t('ram'));
        dependencies.setTextContent(dependencies.document.getElementById('backupIncludeArchiveLabel'), dependencies.t('archive'));
        dependencies.setTextContent(dependencies.document.getElementById('backupIncludeFlashLabel'), dependencies.t('flash_apps'));
        dependencies.setTextContent(dependencies.document.getElementById('backupNote'), dependencies.t('backup_note'));
        dependencies.setTextContent(dependencies.document.getElementById('backupModalOverlayText'), dependencies.t('loading_dirlist'));
        dependencies.setTextContent(dependencies.els.btnCancelBackup, dependencies.t('cancel'));
        dependencies.setIconLabel(dependencies.els.btnConfirmBackup, 'archive', dependencies.t('create_backup'), '📥');
        dependencies.setTextContent(dependencies.els.btnCloseConnectionHelp, dependencies.t('close'));
        dependencies.updateTransportSplashState();

        if (dependencies.els.btnNuke) {
            dependencies.els.btnNuke.title = dependencies.t('force_disconnect_reset');
        }
        if (dependencies.els.btnSettings && dependencies.state.offlineUpdateShown) {
            dependencies.els.btnSettings.title = dependencies.t('update_available');
        }
        if (dependencies.els.statusText) {
            dependencies.syncStatusTranslation(dependencies.els.statusText.dataset.i18nKey);
        }
        dependencies.updateThemeButton();
        dependencies.updateCalcHint(dependencies.els.settingCableModel?.value || dependencies.state.settings?.cableModel || 'auto');
        dependencies.updateSourceConversionSettingAvailability();
        dependencies.applyActiveFamilyUiState({
            tiCapabilitiesKnown: dependencies.state.connected
                && dependencies.state.activeFamily === dependencies.DEVICE_FAMILY_TI
                && Boolean(dependencies.state.handle)
        });
    }

    return { loadLocaleDictionary, normalizeLanguageCode, detectBrowserLanguage, resolveUiLanguage, t, tFormat, getOptionLabel, getOptionLabels, setTextContent, getStatusTranslationKey, applyStatusTranslation, syncStatusTranslation, applyTranslations };
}

module.exports = { createUiLocalization };
