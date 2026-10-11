const { createApplicationContext } = require('./runtime/context.js');
const { createFrontend } = require('./frontend.js');
const context = createApplicationContext();

/* global TILibsModule, EvoWebUsbSerial */

const { createFileBackends } = require('./backends');
const { getBackendCapabilities, getEntryPermissions, deriveSelectionActions } = require('./backends/capabilities');
const { createFileActions } = require('./features/file-actions');
const { createFileModel } = require('./features/file-model');
const { deriveControlAvailability, renderControlAvailability } = require('./features/capability-ui');
const { createWasmClient, isFatalWasmRuntimeError: isFatalRuntimeError } = require('./runtime/wasm-client.js');
const { createSession } = require('./session.js');
const { closeTISerialTransport } = require('./runtime/transports.js');

const {
    TI_VENDOR_ID,
    PID_TI84_EVO_SERIAL,
    SERIAL_KIND_EVO,
    SERIAL_KIND_GRAYLINK,
    SERIAL_KIND_HP_LEGACY,
    SERIAL_KIND_SHARP,
    DEVICE_FAMILY_SHARP,
    SHARP_VENDOR_ID,
    SHARP_PRODUCT_ID,
    CABLE_GRAYLINK,
    CABLE_SILVERLINK,
    CABLE_DIRECTLINK,
    DEVICE_FAMILY_TI,
    DEVICE_FAMILY_HP_PRIME,
    DEVICE_FAMILY_HP_LEGACY,
    DEVICE_FAMILY_NUMWORKS,
    DEVICE_FAMILY_CASIO,
    HP_VENDOR_ID,
    HP_LEGACY_PRODUCT_ID,
    HP_PRIME_PRODUCT_IDS,
    NUMWORKS_VENDOR_ID,
    NUMWORKS_PRODUCT_ID,
    CASIO_VENDOR_ID,
    CASIO_SERIAL_PRODUCT_ID,
    TI_USB_DEVICES,
    TI_USB_PRODUCT_IDS,
    FEATURE_FLAGS,
    TIG_MODE,
    PID_SILVERLINK,
    DIRECTLINK_PIDS,
    NSPIRE_PIDS,
    TI84P_FAMILY_PIDS
} = require('./catalog/devices');
const {
    HP_PRIME_UPLOAD_EXTENSIONS,
    CE_PYTHON_CALC_MODELS,
    EVO_PYTHON_CALC_MODELS,
    NSPIRE_CXII_PYTHON_CALC_MODELS,
    NSPIRE_LUA_CALC_MODELS,
    TIVARS_PREVIEW_CALC_MODELS,
    TIVARS_LEGACY_PREVIEW_TYPES,
    TIVARS_EVO_PREVIEW_TYPES,
    TIVARS_LEGACY_BASIC_PROGRAM_TYPES,
    TIVARS_EVO_BASIC_PROGRAM_TYPES,
    TIVARS_LEGACY_BASIC_SYNTAX_TYPES,
    TIVARS_EVO_BASIC_SYNTAX_TYPES,
    HP_PRIME_TEXT_PREVIEW_EXTENSIONS,
    PYTHON_CONVERSION_NONE,
    PYTHON_CONVERSION_CE,
    PYTHON_CONVERSION_EVO,
    PYTHON_CONVERSION_NSPIRE_CXII,
    LEGACY_TIVARS_EXTENSION_RE,
    LEGACY_TIVARS_FLASH_EXTENSIONS,
    EVO_OS_MODEL_BY_EXTENSION,
    BUNDLE_EXT_RE,
    BUNDLE_LANGUAGE_APPS,
    TI_LANG_CODES
} = require('./catalog/file-types');
const {
    SUPPORTED_LANGUAGES,
    LANGUAGE_OPTIONS,
    I18N_EN,
    LOCALE_BASE_PATH,
    STATUS_I18N_KEYS
} = require('./catalog/locales');
const {
    SETTINGS_DEFAULTS,
    CABLE_OPTIONS,
    SILVERLINK_CALC_VALUES,
    DIRECTLINK_CALC_VALUES,
    CALC_MODEL_OPTIONS
} = require('./catalog/models');
const {
    KEYMAP_CONFIG_8X,
    KEYMAP_CONFIG_89,
    KEYMAP_CONFIG_NSP,
    KEYMAP_CONFIG_HP_PRIME,
    KEYMAP_BY_MODEL
} = require('./catalog/keymaps');
const {
    THEME_STORAGE_KEY,
    THEMES
} = require('./catalog/themes');

const state = {
    module: null,
    handle: 0,
    activeFamily: DEVICE_FAMILY_TI,
    connected: false,
    cableOpen: false,
    authorizedDevice: null,
    pendingEvoUsbDevice: null,
    pendingHPUsbDevice: null,
    deviceModelName: '',
    deviceInfoProductName: '',
    deviceInfoEntries: [],
    features: 0,
    dirlist: [],
    backupDirlistLoaded: false,
    backupDirlistInProgress: false,
    hpFileSnapshotLoaded: false,
    hpFileRefreshGeneration: 0,
    hpFileRenderGeneration: 0,
    hpPrimeProtocolVersion: null,
    casioStorageSupported: false,
    casioFileSnapshotLoaded: false,
    sharpBackend: null,
    sharpConnectionGeneration: 0,
    pendingSharpUsbDevice: null,
    sharpProgress: null,
    hpLegacyBackend: null,
    hpLegacyKermitEnabled: false,
    hpLegacyModelInfo: null,
    hpLegacyConnectionGeneration: 0,
    numWorksBackend: null,
    selectedFiles: [],
    logLines: [],
    sort: { key: 'name', dir: 'asc', userDefined: false },
    settings: null,
    lastProgressTs: 0,
    progressOps: new Map(),
    progressLabel: '',
    connectInProgress: false,
    connectAttempt: null,
    silentReconnectInProgress: false,
    needsReauthorize: false,
    partialOsPath: '',
    nspireOsReceiveStarted: false,
    handlePromise: null,
    expandedFolders: new Set(),
    lastCheckedIndex: null,
    stickyPath: '',
    stickyTableWidth: 0,
    stickyHeaderWidths: [],
    dirlistPromptPromise: null,
    offlineUpdateShown: false,
    operationEpoch: 0,
    uiLanguage: 'en'
};

const MAX_LOG_LINES = 500;

const LOCALE_CACHE = new Map([['en', I18N_EN]]);

// Renders either "<emoji> <label>" (legacy themes) or a Feather-icon + label
// (Minimal theme, which drops emoji in favor of plain glyphs). Preserves any
// child badge nodes (e.g. the settings update dot) across the re-render.

const CCALL_TIMEOUT_MS = 12000;
const CCALL_MIN_GAP_MS = 100;
const SUSPENDED_CCALL_GRACE_MS = 20000;
const CREATE_HANDLE_RETRY_DELAY_MS = 300;
const PROGRESS_IDLE_TIMEOUT_MS = 5000;
const AUTO_QUERY_DELAY_MS = 500;

const wasmRuntime = createWasmClient({
    getGeneration: () => state.operationEpoch,
    timeoutMs: CCALL_TIMEOUT_MS,
    minGapMs: CCALL_MIN_GAP_MS,
    suspendedGraceMs: SUSPENDED_CCALL_GRACE_MS,
    progress: {
        touch: () => { state.lastProgressTs = Date.now(); },
        lastProgress: () => state.lastProgressTs,
        start: label => context.startProgress(label),
        stop: (label, module) => { if (state.module === module) context.stopProgress(label); },
        refresh: module => { if (state.module === module) context.refreshProgressDetails(); }
    },
    onFatal: (module, error) => {
        if (state.module === module) context.handleFatalWasmRuntimeError(error);
    }
});
const session = createSession(state, wasmRuntime);

// Matches libticalcs' reserved detailed Evo Kermit error code.
const TICALCS_EVO_ERROR = 510;

const ERROR_CODE_FALLBACKS = new Map([
    [257, 'Calculator not ready'],
    [269, 'Device is busy'],
    [3, 'Read error'],
    [4, 'Read timeout'],
    [5, 'Write error'],
    [6, 'Write timeout']
]);

// The runtime owns Asyncify scheduling. These facades keep call sites concise.

const els = {
    statusDot: document.getElementById('statusDot'),
    statusText: document.getElementById('statusText'),
    progressIndicator: document.getElementById('progressIndicator'),
    progressLabel: document.getElementById('progressLabel'),
    progressPercent: document.getElementById('progressPercent'),
    progressRate: document.getElementById('progressRate'),
    progressBarFill: document.getElementById('progressBarFill'),
    deviceModel: document.getElementById('deviceModel'),
    memoryInfo: document.getElementById('memoryInfo'),
    deviceInfoList: document.getElementById('deviceInfoList'),
    log: document.getElementById('log'),
    brandMark: document.querySelector('.brand-mark'),
    brandBuildInfo: document.getElementById('brandBuildInfo'),
    fileInput: document.getElementById('fileInput'),
    varTableBody: document.getElementById('varTableBody'),
    filterInput: document.getElementById('filterInput'),
    tableView: document.getElementById('tableView'),
    folderSticky: document.getElementById('folderSticky'),
    btnConnect: document.getElementById('btnConnect'),
    btnNuke: document.getElementById('btnNuke'),
    btnSettings: document.getElementById('btnSettings'),
    settingsUpdateDot: document.getElementById('settingsUpdateDot'),
    btnIsReady: document.getElementById('btnIsReady'),
    btnGetInfo: document.getElementById('btnGetInfo'),
    btnSyncClock: document.getElementById('btnSyncClock'),
    btnRefreshDirlist: document.getElementById('btnRefreshDirlist'),
    varsPanel: document.getElementById('varsPanel'),
    btnNewFolder: document.getElementById('btnNewFolder'),
    btnSendFiles: document.getElementById('btnSendFiles'),
    btnReceiveBackup: document.getElementById('btnReceiveBackup'),
    btnBackupDirlist: document.getElementById('btnBackupDirlist'),
    backupDirlistNote: document.getElementById('backupDirlistNote'),
    btnReceiveOs: document.getElementById('btnReceiveOs'),
    btnDownloadOsPartial: document.getElementById('btnDownloadOsPartial'),
    btnDumpRom: document.getElementById('btnDumpRom'),
    btnLeaveExam: document.getElementById('btnLeaveExam'),
    btnRecvSelected: document.getElementById('btnRecvSelected'),
    btnDeleteSelected: document.getElementById('btnDeleteSelected'),
    btnScreenshot: document.getElementById('btnScreenshot'),
    btnDownloadScreenshot: document.getElementById('btnDownloadScreenshot'),
    btnClearLog: document.getElementById('btnClearLog'),
    offlineBanner: document.getElementById('offlineBanner'),
    btnClearOfflineCache: document.getElementById('btnClearOfflineCache'),
    btnReloadOffline: document.getElementById('btnReloadOffline'),
    offlineBannerText: document.getElementById('offlineBannerText'),
    screenshotCanvas: document.getElementById('screenshotCanvas'),
    keysPanel: document.getElementById('keysPanel'),
    keyCodeInput: document.getElementById('keyCodeInput'),
    btnSendKey: document.getElementById('btnSendKey'),
    settingsModal: document.getElementById('settingsModal'),
    newFolderModal: document.getElementById('newFolderModal'),
    backupModal: document.getElementById('backupModal'),
    splashScreen: document.getElementById('splashScreen'),
    mainContent: document.getElementById('mainContent'),
    btnSplashConnect: document.getElementById('btnSplashConnect'),
    splashWebUsbWarning: document.getElementById('splashWebUsbWarning'),
    btnCloseSettings: document.getElementById('btnCloseSettings'),
    btnCloseNewFolder: document.getElementById('btnCloseNewFolder'),
    btnCloseBackup: document.getElementById('btnCloseBackup'),
    btnSaveSettings: document.getElementById('btnSaveSettings'),
    btnResetSettings: document.getElementById('btnResetSettings'),
    settingCableModel: document.getElementById('settingCableModel'),
    settingCalcModel: document.getElementById('settingCalcModel'),
    settingCalcHint: document.getElementById('settingCalcHint'),
    settingTimeout: document.getElementById('settingTimeout'),
    settingDelay: document.getElementById('settingDelay'),
    settingLanguage: document.getElementById('settingLanguage'),
    settingConvertScriptFiles: document.getElementById('settingConvertScriptFiles'),
    settingConvertScriptFilesField: document.getElementById('settingConvertScriptFilesField'),
    transferModal: document.getElementById('transferModal'),
    transferTableBody: document.getElementById('transferTableBody'),
    transferOverwriteAll: document.getElementById('transferOverwriteAll'),
    transferBulkLocationActions: document.getElementById('transferBulkLocationActions'),
    btnTransferAllRam: document.getElementById('btnTransferAllRam'),
    btnTransferAllArchive: document.getElementById('btnTransferAllArchive'),
    btnCloseTransfer: document.getElementById('btnCloseTransfer'),
    newFolderName: document.getElementById('newFolderName'),
    newFolderParent: document.getElementById('newFolderParent'),
    btnCancelNewFolder: document.getElementById('btnCancelNewFolder'),
    btnCreateNewFolder: document.getElementById('btnCreateNewFolder'),
    btnCancelBackup: document.getElementById('btnCancelBackup'),
    btnConfirmBackup: document.getElementById('btnConfirmBackup'),
    btnCancelTransfer: document.getElementById('btnCancelTransfer'),
    btnConfirmTransfer: document.getElementById('btnConfirmTransfer'),
    btnThemeToggle: document.getElementById('btnThemeToggle'),
    selectAllVars: document.getElementById('selectAllVars'),
    backupFormatBackup: document.getElementById('backupFormatBackup'),
    backupFormatTigroup: document.getElementById('backupFormatTigroup'),
    tigroupOptions: document.getElementById('tigroupOptions'),
    backupIncludeRam: document.getElementById('backupIncludeRam'),
    backupIncludeArchive: document.getElementById('backupIncludeArchive'),
    backupIncludeFlash: document.getElementById('backupIncludeFlash'),
    backupModalOverlay: document.getElementById('backupModalOverlay'),
    backupModalOverlayText: document.getElementById('backupModalOverlayText'),
    toastContainer: document.getElementById('toastContainer'),
    connectionHelpModal: document.getElementById('connectionHelpModal'),
    connectionHelpTitle: document.getElementById('connectionHelpTitle'),
    connectionHelpBody: document.getElementById('connectionHelpBody'),
    btnCloseConnectionHelp: document.getElementById('btnCloseConnectionHelp'),
    previewModal: document.getElementById('previewModal'),
    previewTitle: document.getElementById('previewTitle'),
    previewMeta: document.getElementById('previewMeta'),
    previewControls: document.getElementById('previewControls'),
    previewReindent: document.getElementById('previewReindent'),
    previewReindentLabel: document.getElementById('previewReindentLabel'),
    previewImage: document.getElementById('previewImage'),
    previewContent: document.getElementById('previewContent'),
    btnClosePreview: document.getElementById('btnClosePreview'),
    btnDownloadPreview: document.getElementById('btnDownloadPreview'),
    previewBasicDownloads: document.getElementById('previewBasicDownloads'),
    previewDownloadLabel: document.getElementById('previewDownloadLabel'),
    btnDownloadPreviewEvo: document.getElementById('btnDownloadPreviewEvo'),
    btnDownloadPreviewLegacy: document.getElementById('btnDownloadPreviewLegacy'),
    btnDismissPreview: document.getElementById('btnDismissPreview')
};


document.addEventListener('click', event => {
    const row = event.target.closest('tr');
    if (row && row.closest('#varTableBody')) {
        return;
    }
    document.querySelectorAll('#varTableBody tr.is-active').forEach(activeRow => {
        activeRow.classList.remove('is-active');
    });
});

// CK's .hpappdir representation stores the three core sections separately.
// The calculator receives one APP payload: BE lengths, unchanged core bytes,
// then resource sections containing a NUL-terminated UTF-16LE name and bytes.

// Wait for our isolation-capable worker, including upgrades from the old offline
// worker. A controller alone is insufficient: it may still serve without headers.

async function bootstrap() {
    context.initTheme();
    if (await context.prepareServiceWorker()) return;
    context.applyUrlOverrides();
    try {
        await context.applyTranslations();
    } catch (err) {
        console.warn('[WebTILP] Translation setup failed, continuing with English fallback.', err);
        state.uiLanguage = 'en';
        document.documentElement.lang = 'en';
    }
    context.bindEvents();
    context.loadBuildInfo();
    context.seedSettingsForm();
    context.updateSendFilesButtonState();
    context.updateSelectionActionButtons();
    context.updateKeyControlsState(false);
    context.updateTransportSplashState();
    document.body.classList.remove('initializing');
    document.body.removeAttribute('aria-busy');
    context.autoConnectIfAuthorized().catch(error => context.logError(error, 'Auto-connect failed'));
    window.addEventListener('resize', context.updateScreenshotCanvasScale);
}

context.provide({
    createFileBackends,
    getBackendCapabilities,
    getEntryPermissions,
    deriveSelectionActions,
    createFileActions,
    createFileModel,
    deriveControlAvailability,
    renderControlAvailability,
    createWasmClient,
    isFatalRuntimeError,
    createSession,
    closeTISerialTransport,
    TI_VENDOR_ID,
    PID_TI84_EVO_SERIAL,
    SERIAL_KIND_EVO,
    SERIAL_KIND_GRAYLINK,
    SERIAL_KIND_HP_LEGACY,
    SERIAL_KIND_SHARP,
    DEVICE_FAMILY_SHARP,
    SHARP_VENDOR_ID,
    SHARP_PRODUCT_ID,
    CABLE_GRAYLINK,
    CABLE_SILVERLINK,
    CABLE_DIRECTLINK,
    DEVICE_FAMILY_TI,
    DEVICE_FAMILY_HP_PRIME,
    DEVICE_FAMILY_HP_LEGACY,
    DEVICE_FAMILY_NUMWORKS,
    DEVICE_FAMILY_CASIO,
    HP_VENDOR_ID,
    HP_LEGACY_PRODUCT_ID,
    HP_PRIME_PRODUCT_IDS,
    NUMWORKS_VENDOR_ID,
    NUMWORKS_PRODUCT_ID,
    CASIO_VENDOR_ID,
    CASIO_SERIAL_PRODUCT_ID,
    TI_USB_DEVICES,
    TI_USB_PRODUCT_IDS,
    FEATURE_FLAGS,
    TIG_MODE,
    PID_SILVERLINK,
    DIRECTLINK_PIDS,
    NSPIRE_PIDS,
    TI84P_FAMILY_PIDS,
    HP_PRIME_UPLOAD_EXTENSIONS,
    CE_PYTHON_CALC_MODELS,
    EVO_PYTHON_CALC_MODELS,
    NSPIRE_CXII_PYTHON_CALC_MODELS,
    NSPIRE_LUA_CALC_MODELS,
    TIVARS_PREVIEW_CALC_MODELS,
    TIVARS_LEGACY_PREVIEW_TYPES,
    TIVARS_EVO_PREVIEW_TYPES,
    TIVARS_LEGACY_BASIC_PROGRAM_TYPES,
    TIVARS_EVO_BASIC_PROGRAM_TYPES,
    TIVARS_LEGACY_BASIC_SYNTAX_TYPES,
    TIVARS_EVO_BASIC_SYNTAX_TYPES,
    HP_PRIME_TEXT_PREVIEW_EXTENSIONS,
    PYTHON_CONVERSION_NONE,
    PYTHON_CONVERSION_CE,
    PYTHON_CONVERSION_EVO,
    PYTHON_CONVERSION_NSPIRE_CXII,
    LEGACY_TIVARS_EXTENSION_RE,
    LEGACY_TIVARS_FLASH_EXTENSIONS,
    EVO_OS_MODEL_BY_EXTENSION,
    BUNDLE_EXT_RE,
    BUNDLE_LANGUAGE_APPS,
    TI_LANG_CODES,
    SUPPORTED_LANGUAGES,
    LANGUAGE_OPTIONS,
    I18N_EN,
    LOCALE_BASE_PATH,
    STATUS_I18N_KEYS,
    SETTINGS_DEFAULTS,
    CABLE_OPTIONS,
    SILVERLINK_CALC_VALUES,
    DIRECTLINK_CALC_VALUES,
    CALC_MODEL_OPTIONS,
    KEYMAP_CONFIG_8X,
    KEYMAP_CONFIG_89,
    KEYMAP_CONFIG_NSP,
    KEYMAP_CONFIG_HP_PRIME,
    KEYMAP_BY_MODEL,
    THEME_STORAGE_KEY,
    THEMES,
    state,
    MAX_LOG_LINES,
    currentDropTarget: null,
    stickyHideThreshold: null,
    stickyVisible: false,
    dropzoneActive: false,
    stickyUpdateScheduled: false,
    lastDropTs: 0,
    LOCALE_CACHE,
    CCALL_TIMEOUT_MS,
    CCALL_MIN_GAP_MS,
    SUSPENDED_CCALL_GRACE_MS,
    CREATE_HANDLE_RETRY_DELAY_MS,
    PROGRESS_IDLE_TIMEOUT_MS,
    AUTO_QUERY_DELAY_MS,
    wasmRuntime,
    session,
    TICALCS_EVO_ERROR,
    ERROR_CODE_FALLBACKS,
    els,
    tivarsLibPromise: null,
    webLunaPromise: null,
    previewHighlighterPromise: null,
    previewSession: null,
    previewRenderId: 0,
    bootstrap
});
context.provide(createFrontend(context));
state.settings = context.loadSettings();

bootstrap().catch(err => {
    document.body.classList.remove('initializing');
    document.body.removeAttribute('aria-busy');
    console.error('[WebTILP] Bootstrap failed', err);
});

if (navigator.usb) {
    navigator.usb.addEventListener('disconnect', context.handleTransportDisconnect);
    navigator.usb.addEventListener('connect', context.handleTransportConnect);
}
if (navigator.serial) {
    navigator.serial.addEventListener('disconnect', context.handleTransportDisconnect);
    navigator.serial.addEventListener('connect', context.handleTransportConnect);
}
if (navigator.hid) {
    navigator.hid.addEventListener('disconnect', event => {
        if (context.isHPPrimeDevice(event.device)) {
            context.handleTransportDisconnect(event);
        }
    });
    navigator.hid.addEventListener('connect', event => {
        if (context.isHPPrimeDevice(event.device)) {
            context.handleTransportConnect(event);
        }
    });
}
if (!self.isSecureContext) {
    context.setStatus('status_insecure_context', false);
    context.log(context.t('transport_secure_context_error'));
} else if (navigator.usb) {
    context.setStatus('idle', false);
} else if (navigator.serial) {
    context.setStatus('status_webserial_only', false);
    context.log('WebUSB is not available in this browser. WebSerial-only mode supports TI-83/84 Evo, old HP 03f0:0121 calculators, and explicitly selected GrayLink serial cables.');
} else if (navigator.hid) {
    context.setStatus('idle', false);
    context.log(context.t('hp_prime_webhid_only_mode'));
} else {
    context.setStatus('status_webusb_unsupported', false);
    context.log('WebUSB is not available in this browser. Use a WebUSB-compatible browser for full calculator support.');
}
