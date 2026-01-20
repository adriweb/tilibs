/* global TILibsModule */

const state = {
    module: null,
    handle: 0,
    connected: false,
    cableOpen: false,
    authorizedDevice: null,
    deviceModelName: '',
    deviceInfoProductName: '',
    features: 0,
    dirlist: [],
    selectedFiles: [],
    treeView: false,
    logLines: [],
    sort: { key: 'name', dir: 'asc' },
    settings: null,
    lastProgressTs: 0,
    progressHooked: false,
    progressTickPtr: 0,
    progressOps: new Map(),
    progressLabel: '',
    connectInProgress: false,
    silentReconnectInProgress: false,
    needsReauthorize: false,
    partialOsPath: '',
    nspireOsReceiveStarted: false,
    lastCcallTs: 0,
    handlePromise: null
};

let currentDropTarget = null;
let dropzoneActive = false;

const FEATURE_FLAGS = {
    OPS_ISREADY : 1 << 0,
    OPS_KEYS    : 1 << 1,
    OPS_SCREEN  : 1 << 2,
    OPS_DIRLIST : 1 << 3,
    OPS_BACKUP  : 1 << 4,
    OPS_VARS    : 1 << 5,
    OPS_FLASH   : 1 << 6,
    OPS_IDLIST  : 1 << 7,
    OPS_CLOCK   : 1 << 8,
    OPS_ROMDUMP : 1 << 9,
    OPS_VERSION : 1 << 10,
    OPS_NEWFLD  : 1 << 11,
    OPS_DELVAR  : 1 << 12,
    OPS_OS      : 1 << 13,
    OPS_RENAME  : 1 << 14,
    OPS_CHATTR  : 1 << 21,

    FTS_FOLDER  : 1 << 16,
    FTS_FLASH   : 1 << 18,
    FTS_BACKUP  : 1 << 20,
};

const CCALL_TIMEOUT_MS = 12000;
const CCALL_MIN_GAP_MS = 100;
const CREATE_HANDLE_RETRY_DELAY_MS = 300;
const PROGRESS_IDLE_TIMEOUT_MS = 5000;
const AUTO_QUERY_DELAY_MS = 500;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getErrorMessage(module, code) {
    if (!module || code === 0) {
        return '';
    }
    try {
        return module.ccall('get_error_message', 'string', ['number'], [code]) || '';
    } catch (err) {
        console.warn('[WebTILP] Failed to resolve error message', err);
    }
    return '';
}

function formatErrorResult(module, code) {
    const message = getErrorMessage(module, code);
    const raw = module ? module._get_raw_protocol_code(code) : 0;
    const label = raw ? `0x${raw.toString(16).toUpperCase().padStart(4, '0')}` : `${code}`;
    if (!message) {
        return `error ${label}`;
    }
    const firstLine = message.split('\n').map(line => line.trim()).find(Boolean) || message;
    const cleaned = firstLine.replace(/^Msg:\s*/i, '');
    return `error ${label}: ${cleaned}`;
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {string} label
 * @param {number|null} timeoutMs
 * @returns {Promise<T>}
 */
async function withTimeout(promise, label, timeoutMs = CCALL_TIMEOUT_MS) {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    });
    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {string} label
 * @param {number|null} timeoutMs
 * @param {number} pollMs
 * @returns {Promise<T>}
 */
async function withProgressTimeout(promise, label, timeoutMs = CCALL_TIMEOUT_MS, pollMs = 100) {
    let done = false;
    let value;
    let error;
    promise
        .then(result => {
            done = true;
            value = result;
        })
        .catch(err => {
            done = true;
            error = err;
        });

    let lastProgress = state.lastProgressTs || Date.now();
    let lastTick = readProgressTick();
    while (!done) {
        await sleep(pollMs);
        const tick = readProgressTick();
        if (tick !== null && tick !== lastTick) {
            lastTick = tick;
            state.lastProgressTs = Date.now();
            refreshProgressDetails();
        }
        if (state.lastProgressTs > lastProgress) {
            lastProgress = state.lastProgressTs;
        }
        if (timeoutMs !== null && Date.now() - lastProgress > timeoutMs) {
            throw new Error(`${label} timed out`);
        }
    }
    if (error) {
        throw error;
    }
    return value;
}

/**
 * @template T
 * @param {any} module
 * @param {string} name
 * @param {string} returnType
 * @param {Array<string>} argTypes
 * @param {Array<any>} args
 * @param {{timeoutMs?: number|null, useProgress?: boolean}} options
 * @returns {Promise<T>}
 */
async function ccallAsync(module, name, returnType, argTypes, args, options = {}) {
    const now = Date.now();
    const gap = state.lastCcallTs ? (now - state.lastCcallTs) : CCALL_MIN_GAP_MS;
    if (gap < CCALL_MIN_GAP_MS) {
        await sleep(CCALL_MIN_GAP_MS - gap);
    }
    state.lastCcallTs = Date.now();
    const timeoutMs = Object.prototype.hasOwnProperty.call(options, 'timeoutMs')
        ? options.timeoutMs
        : CCALL_TIMEOUT_MS;
    const useProgress = options.useProgress ?? false;
    state.lastProgressTs = Date.now();
    const result = module.ccall(name, returnType, argTypes, args, { async: true });
    return useProgress ? withProgressTimeout(result, name, timeoutMs) : withTimeout(result, name, timeoutMs);
}

const SETTINGS_DEFAULTS = {
    cableModel: 'auto',
    calcModel: 'auto',
    cableTimeout: 50,
    cableDelay: 10
};

const CABLE_OPTIONS = [
    { value: 'auto', label: 'Auto' },
    { value: '5', label: 'DirectLink USB' },
    { value: '4', label: 'SilverLink (Graph Link USB)' }
];

const SILVERLINK_CALC_VALUES = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 16, 17]);
const DIRECTLINK_CALC_VALUES = new Set([13, 14, 15, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36]);

const CALC_MODEL_OPTIONS = [
    { value: 'auto', label: 'Auto' },
    { value: 1, label: 'TI-73' },
    { value: 2, label: 'TI-82' },
    { value: 3, label: 'TI-83' },
    { value: 4, label: 'TI-83+' },
    { value: 5, label: 'TI-84+' },
    { value: 6, label: 'TI-85' },
    { value: 7, label: 'TI-86' },
    { value: 8, label: 'TI-89' },
    { value: 9, label: 'TI-89 Titanium' },
    { value: 10, label: 'TI-92' },
    { value: 11, label: 'TI-92+' },
    { value: 12, label: 'Voyage 200' },
    { value: 13, label: 'TI-84+ USB' },
    { value: 14, label: 'TI-89 Titanium USB' },
    { value: 15, label: 'TI-Nspire' },
    { value: 16, label: 'TI-80' },
    { value: 17, label: 'TI-84 Plus C' },
    { value: 18, label: 'TI-84 Plus C USB' },
    { value: 19, label: 'TI-83 Premium CE' },
    { value: 20, label: 'TI-84 Plus CE' },
    { value: 21, label: 'TI-82 Advanced' },
    { value: 22, label: 'TI-84 Plus T' },
    { value: 23, label: 'TI-Nspire Cradle' },
    { value: 24, label: 'TI-Nspire Clickpad' },
    { value: 25, label: 'TI-Nspire Clickpad CAS' },
    { value: 26, label: 'TI-Nspire Touchpad' },
    { value: 27, label: 'TI-Nspire Touchpad CAS' },
    { value: 28, label: 'TI-Nspire CX' },
    { value: 29, label: 'TI-Nspire CX CAS' },
    { value: 30, label: 'TI-Nspire CM-C' },
    { value: 31, label: 'TI-Nspire CM-C CAS' },
    { value: 32, label: 'TI-Nspire CX II' },
    { value: 33, label: 'TI-Nspire CX II CAS' },
    { value: 34, label: 'TI-Nspire CX II-T' },
    { value: 35, label: 'TI-Nspire CX II-T CAS' },
    { value: 36, label: 'TI-82 Advanced Edition Python' },
    { value: 37, label: 'CBL' },
    { value: 38, label: 'CBR' },
    { value: 39, label: 'CBL2' },
    { value: 40, label: 'CBR2' },
    { value: 41, label: 'LabPro' },
    { value: 42, label: 'TI Presenter' }
];

const PID_SILVERLINK = 0xe001;
const DIRECTLINK_PIDS = new Set([
    0xe003,
    0xe004,
    0xe008,
    0xe012,
    0xe01c,
    0xe022
]);

const NSPIRE_PIDS = new Set([0xE012, 0xE01C, 0xE022]);
const TI84P_FAMILY_PIDS = new Set([0xE003, 0xE008]);

const THEME_STORAGE_KEY = 'webtilp.theme';
const THEMES = [
    { id: 'dark-modern', label: 'Dark Modern' },
    { id: 'light-modern', label: 'Light Modern' },
    { id: 'retro', label: 'Retro Terminal' }
];

function getCalcModelLabel(value) {
    const entry = CALC_MODEL_OPTIONS.find(option => String(option.value) === String(value));
    return entry ? entry.label : '';
}

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
    fileInput: document.getElementById('fileInput'),
    varTableBody: document.getElementById('varTableBody'),
    filterInput: document.getElementById('filterInput'),
    treeView: document.getElementById('treeView'),
    tableView: document.getElementById('tableView'),
    btnToggleView: document.getElementById('btnToggleView'),
    btnConnect: document.getElementById('btnConnect'),
    btnNuke: document.getElementById('btnNuke'),
    btnSettings: document.getElementById('btnSettings'),
    btnIsReady: document.getElementById('btnIsReady'),
    btnGetInfo: document.getElementById('btnGetInfo'),
    btnSyncClock: document.getElementById('btnSyncClock'),
    btnRefreshDirlist: document.getElementById('btnRefreshDirlist'),
    btnSendFiles: document.getElementById('btnSendFiles'),
    btnReceiveBackup: document.getElementById('btnReceiveBackup'),
    btnReceiveOs: document.getElementById('btnReceiveOs'),
    btnDownloadOsPartial: document.getElementById('btnDownloadOsPartial'),
    btnDumpRom: document.getElementById('btnDumpRom'),
    btnRecvSelected: document.getElementById('btnRecvSelected'),
    btnDeleteSelected: document.getElementById('btnDeleteSelected'),
    btnScreenshot: document.getElementById('btnScreenshot'),
    btnDownloadScreenshot: document.getElementById('btnDownloadScreenshot'),
    btnClearLog: document.getElementById('btnClearLog'),
    screenshotCanvas: document.getElementById('screenshotCanvas'),
    keyCodeInput: document.getElementById('keyCodeInput'),
    btnSendKey: document.getElementById('btnSendKey'),
    settingsModal: document.getElementById('settingsModal'),
    splashScreen: document.getElementById('splashScreen'),
    mainContent: document.getElementById('mainContent'),
    btnSplashConnect: document.getElementById('btnSplashConnect'),
    splashWebUsbWarning: document.getElementById('splashWebUsbWarning'),
    btnCloseSettings: document.getElementById('btnCloseSettings'),
    btnSaveSettings: document.getElementById('btnSaveSettings'),
    btnResetSettings: document.getElementById('btnResetSettings'),
    settingCableModel: document.getElementById('settingCableModel'),
    settingCalcModel: document.getElementById('settingCalcModel'),
    settingCalcHint: document.getElementById('settingCalcHint'),
    settingTimeout: document.getElementById('settingTimeout'),
    settingDelay: document.getElementById('settingDelay'),
    transferModal: document.getElementById('transferModal'),
    transferTableBody: document.getElementById('transferTableBody'),
    btnCloseTransfer: document.getElementById('btnCloseTransfer'),
    btnCancelTransfer: document.getElementById('btnCancelTransfer'),
    btnConfirmTransfer: document.getElementById('btnConfirmTransfer'),
    btnThemeToggle: document.getElementById('btnThemeToggle')
};

state.settings = loadSettings();

function applyTheme(themeId) {
    const found = THEMES.find(theme => theme.id === themeId);
    const target = found ? found.id : THEMES[0].id;
    document.body.dataset.theme = target;
    localStorage.setItem(THEME_STORAGE_KEY, target);
    updateThemeButton();
}

function updateThemeButton() {
    if (!els.btnThemeToggle) {
        return;
    }
    const current = document.body.dataset.theme || THEMES[0].id;
    const theme = THEMES.find(entry => entry.id === current) || THEMES[0];
    els.btnThemeToggle.textContent = `Theme: ${theme.label}`;
}

function cycleTheme() {
    const current = document.body.dataset.theme || THEMES[0].id;
    const index = THEMES.findIndex(entry => entry.id === current);
    const next = THEMES[(index + 1) % THEMES.length].id;
    applyTheme(next);
}

function initTheme() {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    applyTheme(stored || THEMES[0].id);
}

function loadSettings() {
    const raw = localStorage.getItem('webtilp.settings');
    if (!raw) {
        return { ...SETTINGS_DEFAULTS };
    }
    try {
        const parsed = JSON.parse(raw);
        return {
            ...SETTINGS_DEFAULTS,
            ...parsed,
            cableModel: String(parsed.cableModel ?? SETTINGS_DEFAULTS.cableModel),
            calcModel: String(parsed.calcModel ?? SETTINGS_DEFAULTS.calcModel),
            cableTimeout: Number(parsed.cableTimeout ?? SETTINGS_DEFAULTS.cableTimeout),
            cableDelay: Number(parsed.cableDelay ?? SETTINGS_DEFAULTS.cableDelay)
        };
    } catch (err) {
        console.warn('[WebTILP] Failed to load settings', err);
        return { ...SETTINGS_DEFAULTS };
    }
}

function saveSettings() {
    localStorage.setItem('webtilp.settings', JSON.stringify(state.settings));
}

function applySettingsToModule() {
    if (!state.module) {
        return;
    }
    const module = state.module;
    const settings = state.settings;
    module._set_cable_timeout(settings.cableTimeout);
    module._set_cable_delay(settings.cableDelay);

    if (settings.cableModel === 'auto') {
        module._set_force_cable(0);
    } else {
        module._set_cable_model(Number(settings.cableModel));
        module._set_force_cable(1);
    }


    if (settings.calcModel === 'auto') {
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
    if (state.settings && state.settings.cableModel !== 'auto') {
        return;
    }
    if (device.vendorId !== 0x0451) {
        return;
    }

    if (device.productId === PID_SILVERLINK) {
        module._set_cable_model(4);
        module._set_force_cable(1);
        log('Cable hint applied: SilverLink USB');
        return;
    }

    if (DIRECTLINK_PIDS.has(device.productId)) {
        module._set_cable_model(5);
        module._set_force_cable(1);
        log('Cable hint applied: DirectLink USB');
    }
}

function hasSilverlinkConnected() {
    return state.authorizedDevice && state.authorizedDevice.productId === PID_SILVERLINK;
}

function isTi92Selected() {
    return String(state.settings?.calcModel ?? '') === '10';
}

function resolveDeviceModelName(infoProductName) {
    if (hasSilverlinkConnected()) {
        const calcModel = state.settings?.calcModel ?? 'auto';
        if (calcModel !== 'auto') {
            return { primary: getCalcModelLabel(calcModel), secondary: null };
        }
        return { primary: 'Unknown', secondary: null };
    }
    const deviceName = state.authorizedDevice?.productName || '';
    const infoName = infoProductName || state.deviceInfoProductName || state.deviceModelName || '';
    if (deviceName && infoName && deviceName !== infoName) {
        return { primary: deviceName, secondary: infoName };
    }
    const primary = infoName || deviceName || 'Unknown';
    return { primary, secondary: null };
}

function deviceMatches(a, b) {
    if (!a || !b) {
        return false;
    }
    return a.vendorId === b.vendorId
        && a.productId === b.productId
        && (a.productName || '') === (b.productName || '');
}

function updateDeviceModelDisplay(infoProductName) {
    if (!els.deviceModel) {
        return;
    }
    const resolved = resolveDeviceModelName(infoProductName);
    if (resolved.secondary) {
        els.deviceModel.innerHTML = `${resolved.primary}<div class="device-model-secondary">(${resolved.secondary})</div>`;
    } else {
        els.deviceModel.textContent = resolved.primary;
    }
}

function promptCableMismatchResolution() {
    if (!state.authorizedDevice) {
        return false;
    }
    const pid = state.authorizedDevice.productId;
    const isSilverlinkDevice = pid === PID_SILVERLINK;
    const isDirectlinkDevice = DIRECTLINK_PIDS.has(pid);
    const forcedCable = state.settings?.cableModel ?? 'auto';
    const forcedSilverlink = forcedCable === '4';
    const forcedDirectlink = forcedCable === '5';

    if (isSilverlinkDevice && forcedDirectlink) {
        const confirmSwitch = confirm('A SilverLink cable is connected but Settings force DirectLink. Switch to SilverLink and choose a model?');
        if (confirmSwitch) {
            state.settings.cableModel = '4';
            state.settings.calcModel = 'auto';
            saveSettings();
            openSettingsModal();
        }
        return true;
    }

    if (isDirectlinkDevice && forcedSilverlink) {
        const confirmSwitch = confirm('A DirectLink calculator is connected but Settings force SilverLink. Switch to DirectLink?');
        if (confirmSwitch) {
            state.settings.cableModel = '5';
            state.settings.calcModel = 'auto';
            saveSettings();
            window.location.reload();
        }
        return true;
    }

    return false;
}

function ensureSilverlinkModelSelected() {
    if (!hasSilverlinkConnected()) {
        return true;
    }
    const calcModel = state.settings?.calcModel ?? 'auto';
    if (calcModel !== 'auto') {
        return true;
    }
    alert('SilverLink detected. Please choose a calculator model in Settings before connecting.');
    openSettingsModal();
    return false;
}

function populateSelect(select, options) {
    select.innerHTML = '';
    options.forEach(option => {
        const item = document.createElement('option');
        item.value = String(option.value);
        item.textContent = option.label;
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
    if (String(cableModel) === '4') {
        return sortCalcOptions(CALC_MODEL_OPTIONS.filter(option => option.value === 'auto' || SILVERLINK_CALC_VALUES.has(Number(option.value))));
    }
    if (String(cableModel) === '5') {
        return sortCalcOptions(CALC_MODEL_OPTIONS.filter(option => option.value === 'auto' || DIRECTLINK_CALC_VALUES.has(Number(option.value))));
    }
    return sortCalcOptions(CALC_MODEL_OPTIONS);
}

function updateCalcHint(cableModel) {
    if (!els.settingCalcHint) {
        return;
    }
    if (String(cableModel) === '4') {
        els.settingCalcHint.textContent = 'SilverLink requires manual model selection.';
        return;
    }
    els.settingCalcHint.textContent = 'Auto uses probing to detect the model.';
}

function seedSettingsForm() {
    populateSelect(els.settingCableModel, CABLE_OPTIONS);
    els.settingCableModel.value = state.settings.cableModel;
    populateSelect(els.settingCalcModel, getCalcOptionsForCable(els.settingCableModel.value));
    els.settingCalcModel.value = state.settings.calcModel;
    els.settingTimeout.value = state.settings.cableTimeout;
    els.settingDelay.value = state.settings.cableDelay;
    updateCalcHint(els.settingCableModel.value);
}

function openSettingsModal() {
    seedSettingsForm();

    els.settingsModal.classList.remove('hidden');
}

function closeSettingsModal() {
    els.settingsModal.classList.add('hidden');
}

function resetSettings() {
    const current = JSON.stringify(state.settings);
    const defaults = JSON.stringify(SETTINGS_DEFAULTS);
    if (current === defaults) {
        closeSettingsModal();
        log('Settings unchanged.');
        return;
    }
    state.settings = { ...SETTINGS_DEFAULTS };
    saveSettings();
    log('Settings reset to defaults. Reloading...');
    window.location.reload();
}

function saveSettingsFromModal() {
    if (els.settingCableModel.value === '4' && els.settingCalcModel.value === 'auto') {
        alert('SilverLink requires choosing a calculator model.');
        return;
    }
    const nextSettings = {
        cableModel: els.settingCableModel.value,
        calcModel: els.settingCalcModel.value,
        cableTimeout: Number(els.settingTimeout.value || SETTINGS_DEFAULTS.cableTimeout),
        cableDelay: Number(els.settingDelay.value || SETTINGS_DEFAULTS.cableDelay)
    };
    if (JSON.stringify(state.settings) === JSON.stringify(nextSettings)) {
        closeSettingsModal();
        log('Settings unchanged.');
        return;
    }
    state.settings = nextSettings;
    saveSettings();
    log('Settings saved. Reloading...');
    window.location.reload();
}

function log(message) {
    const timestamp = new Date().toLocaleTimeString();
    state.logLines.push(`[${timestamp}] ${message}`);
    els.log.textContent = `${state.logLines.join('\n')}\n`;
    els.log.scrollTop = els.log.scrollHeight;
}

function logError(err, context) {
    if (context) {
        console.error(`[WebTILP] ${context}`, err);
    } else {
        console.error('[WebTILP]', err);
    }
    log(`ERROR: ${err.message || err}`);
}

function clearActiveOperations(message) {
    document.querySelectorAll('.btn.loading').forEach(button => {
        setButtonLoading(button, false);
    });
    state.progressOps.clear();
    state.progressLabel = '';
    updateProgressIndicator();
    if (message) {
        log(message);
    }
}

function updateProgressIndicator() {
    if (!els.progressIndicator || !els.progressLabel) {
        return;
    }
    const active = state.progressOps.size > 0;
    els.progressIndicator.classList.toggle('hidden', !active);
    if (!active) {
        clearProgressDetails();
        return;
    }
    if (!state.progressLabel || !state.progressOps.has(state.progressLabel)) {
        state.progressLabel = Array.from(state.progressOps.keys()).pop() || 'Working...';
    }
    els.progressLabel.textContent = state.progressLabel;
    refreshProgressDetails();
}

function startProgress(label) {
    const text = (label || '').trim() || 'Working...';
    const count = state.progressOps.get(text) || 0;
    if (state.progressOps.size === 0 && state.module) {
        try {
            state.module.ccall('reset_progress_info', 'number', [], []);
        } catch (err) {
            console.warn('[WebTILP] Failed to reset progress info', err);
        }
    }
    state.progressOps.set(text, count + 1);
    state.progressLabel = text;
    updateProgressIndicator();
}

function stopProgress(label) {
    if (!label) {
        updateProgressIndicator();
        return;
    }
    const count = state.progressOps.get(label);
    if (!count) {
        return;
    }
    if (count === 1) {
        state.progressOps.delete(label);
    } else {
        state.progressOps.set(label, count - 1);
    }
    if (state.progressLabel === label) {
        state.progressLabel = Array.from(state.progressOps.keys()).pop() || '';
    }
    updateProgressIndicator();
}

function clearProgressDetails() {
    if (els.progressPercent) {
        els.progressPercent.textContent = '';
    }
    if (els.progressRate) {
        els.progressRate.textContent = '';
    }
    if (els.progressBarFill) {
        els.progressBarFill.classList.remove('determinate');
        els.progressBarFill.style.width = '';
    }
}

function formatRate(bytesPerMs) {
    if (!Number.isFinite(bytesPerMs) || bytesPerMs <= 0) {
        return '';
    }
    const bytesPerSec = bytesPerMs * 1000;
    const kb = bytesPerSec / 1024;
    if (kb < 1024) {
        return `${kb.toFixed(1)} KB/s`;
    }
    const mb = kb / 1024;
    return `${mb.toFixed(2)} MB/s`;
}

function refreshProgressDetails() {
    if (!state.module || !els.progressBarFill) {
        return;
    }
    let infoText = '';
    try {
        infoText = state.module.ccall('get_progress_info_json', 'string', [], []);
    } catch (err) {
        return;
    }
    if (!infoText) {
        return;
    }
    let info;
    try {
        info = JSON.parse(infoText);
    } catch {
        return;
    }
    if (!info || typeof info !== 'object') {
        return;
    }

    const cnt = Number(info.cnt);
    const max = Number(info.max);
    const rate = Number(info.rate);
    if (Number.isFinite(max) && max > 0 && Number.isFinite(cnt)) {
        const percent = Math.max(0, Math.min(100, Math.round((cnt / max) * 100)));
        els.progressBarFill.classList.add('determinate');
        els.progressBarFill.style.width = `${percent}%`;
        if (els.progressPercent) {
            els.progressPercent.textContent = `${percent}%`;
        }
    } else {
        els.progressBarFill.classList.remove('determinate');
        els.progressBarFill.style.width = '';
        if (els.progressPercent) {
            els.progressPercent.textContent = '';
        }
    }

    if (els.progressRate) {
        const formatted = formatRate(rate);
        els.progressRate.textContent = formatted || '';
    }
    if (info.text && typeof info.text === 'string' && info.text.trim()) {
        const text = info.text.trim();
        if (text && text !== state.progressLabel) {
            els.progressLabel.textContent = text;
        }
    }
}

function setButtonLoading(button, loading, label) {
    if (!button) {
        return;
    }
    if (loading) {
        const progressLabel = (label || button.dataset.progressLabel || button.textContent || '').trim() || 'Working...';
        button.dataset.progressLabel = progressLabel;
        startProgress(progressLabel);
        button.dataset.prevDisabled = button.disabled ? '1' : '0';
        button.disabled = true;
        button.classList.add('loading');
        return;
    }
    if (button.dataset.progressLabel) {
        stopProgress(button.dataset.progressLabel);
        delete button.dataset.progressLabel;
    }
    button.classList.remove('loading');
    if (button.classList.contains('disabled')) {
        button.disabled = true;
        return;
    }
    if (button.dataset.prevDisabled === '0') {
        button.disabled = false;
    }
    delete button.dataset.prevDisabled;
}

function formatBytes(value) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = Number(value);
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex += 1;
    }
    return `${size.toFixed(size < 10 && unitIndex > 0 ? 2 : 1)}${units[unitIndex]}`;
}

function formatMemoryValue(value) {
    if (value === null || value === undefined || value === 0xffffffff) {
        return { display: '?', raw: '?' };
    }
    return { display: formatBytes(value), raw: `${value}B` };
}

function setStatus(text, active) {
    els.statusText.textContent = text;
    els.statusDot.style.background = active ? '#4fd3b4' : '#586178';
    els.statusDot.style.boxShadow = active ? '0 0 0 4px rgba(79, 211, 180, 0.2)' : '0 0 0 4px rgba(88, 97, 120, 0.2)';
}

function setConnected(connected) {
    state.connected = connected;
    if (els.btnNuke) {
        els.btnNuke.classList.toggle('hidden', !connected);
    }
    if (els.splashScreen && els.mainContent) {
        els.splashScreen.classList.toggle('hidden', connected);
        els.mainContent.classList.toggle('hidden', !connected);
    }
    if (!connected) {
        updateWebUsbSplashState();
    }
}

function updateWebUsbSplashState() {
    if (!els.splashWebUsbWarning || !els.btnSplashConnect) {
        return;
    }
    const webUsbReady = navigator.usb && self.isSecureContext;
    els.splashWebUsbWarning.classList.toggle('hidden', !!webUsbReady);
    els.btnSplashConnect.classList.toggle('hidden', !webUsbReady);
}

function isNspireActive() {
    const pid = state.authorizedDevice?.productId;
    return typeof pid === 'number' && NSPIRE_PIDS.has(pid);
}

function is84pFamilyActive() {
    const pid = state.authorizedDevice?.productId;
    return typeof pid === 'number' && TI84P_FAMILY_PIDS.has(pid);
}

function getNspireOsExtensionFromModule(module) {
    if (!module) {
        return null;
    }
    try {
        return module.ccall('get_flash_os_ext', 'string', ['number'], [0]);
    } catch (err) {
        console.warn('[WebTILP] Failed to query flash OS extension', err);
        return null;
    }
}

function ensureWebUsb() {
    if (!navigator.usb) {
        throw new Error('WebUSB is not supported in this browser.');
    }
    if (!self.isSecureContext) {
        throw new Error('WebUSB requires HTTPS or localhost.');
    }
}

async function initModule() {
    ensureWebUsb();
    if (state.module) {
        return state.module;
    }
    setStatus('Loading module...', false);
    state.module = await TILibsModule();
    if (!state.progressHooked) {
        const touchProgress = () => {
            state.lastProgressTs = Date.now();
        };
        state.module.__progressTick = touchProgress;
        if (state.progressTickPtr === null || state.progressTickPtr === undefined) {
            try {
                state.progressTickPtr = state.module._get_progress_tick_ptr();
            } catch (err) {
                console.warn('[WebTILP] progress tick unavailable', err);
            }
        }
        const originalPrint = state.module.print;
        state.module.print = (...args) => {
            touchProgress();
            if (originalPrint) {
                originalPrint(...args);
            }
        };
        const originalPrintErr = state.module.printErr;
        state.module.printErr = (...args) => {
            touchProgress();
            if (originalPrintErr) {
                originalPrintErr(...args);
            }
        };
        state.progressHooked = true;
    }
    await state.module.ccall('init', 'number', [], [], { async: true });
    applySettingsToModule();
    log('WASM module initialized.');
    setStatus('Module ready', true);
    return state.module;
}

async function authorizeDevice(forcePrompt = false) {
    const module = await initModule();
    const mustPrompt = forcePrompt || state.needsReauthorize;
    if (!mustPrompt && module.getAuthorizedDevices) {
        const devices = await module.getAuthorizedDevices();
        if (devices && devices.length) {
            if (!deviceMatches(state.authorizedDevice, devices[0])) {
                log(`Using authorized device: ${devices[0].productName || 'Unknown'}`);
            }
            state.authorizedDevice = devices[0];
            if (!hasSilverlinkConnected()) {
                state.deviceModelName = devices[0].productName || state.deviceModelName;
            }
            updateDeviceModelDisplay();
            return devices[0];
        }
    }
    const device = await module.requestTICalculatorDevice();
    state.authorizedDevice = device;
    if (!hasSilverlinkConnected()) {
        state.deviceModelName = device?.productName || state.deviceModelName;
    }
    updateDeviceModelDisplay();
    if (state.needsReauthorize) {
        state.needsReauthorize = false;
        state.silentReconnectInProgress = false;
        setStatus('Connected', true);
    }
    return device;
}

async function autoConnectIfAuthorized() {
    if (!navigator.usb || !self.isSecureContext) {
        return;
    }
    if (state.connectInProgress) {
        return;
    }
    const module = await initModule();
    if (!module.getAuthorizedDevices) {
        return;
    }
    const devices = await module.getAuthorizedDevices();
    if (!devices || !devices.length) {
        return;
    }

    state.authorizedDevice = devices[0];
    const pid = state.authorizedDevice.productId;
    const cableSetting = state.settings?.cableModel ?? 'auto';
    const calcSetting = state.settings?.calcModel ?? 'auto';
    const canAutoConnectDirect = DIRECTLINK_PIDS.has(pid) && (cableSetting === '5' || cableSetting === 'auto');
    const canAutoConnectSilver = pid === PID_SILVERLINK && cableSetting === '4' && calcSetting !== 'auto';

    if (!canAutoConnectDirect && !canAutoConnectSilver) {
        return;
    }

    try {
        if (state.connectInProgress) {
            return;
        }
        state.connectInProgress = true;
        await applyWebUsbDeviceCableHint(module, state.authorizedDevice);
        await ensureCableOpen();
        await sleep(AUTO_QUERY_DELAY_MS);
        await updateCapabilities();
        await sleep(AUTO_QUERY_DELAY_MS);
        if (!isTi92Selected()) {
            await getDeviceInfo();
        } else {
            log('Skipping automatic device info query for TI-92.');
        }
        setConnected(true);
        setStatus('Connected', true);
        log('Auto-connected to authorized device.');
    } catch (err) {
        logError(err, 'Auto-connect failed');
    } finally {
        state.connectInProgress = false;
    }
}

async function ensureHandle() {
    const module = await initModule();
    if (state.handle) {
        return state.handle;
    }
    if (state.handlePromise) {
        return await state.handlePromise;
    }
    state.handlePromise = (async () => {
        if (state.authorizedDevice) {
            await applyWebUsbDeviceCableHint(module, state.authorizedDevice);
        }
        if (!ensureSilverlinkModelSelected()) {
            throw new Error('SilverLink requires a calculator model selection.');
        }
        let handle = 0;
        let attempts = 0;
        while (!handle && attempts < 3) {
            attempts += 1;
            handle = module._create_handle();
            if (handle && typeof handle.then === 'function') {
                handle = await handle;
            }
            if (!handle) {
                await sleep(CREATE_HANDLE_RETRY_DELAY_MS);
            }
        }
        if (!handle) {
            throw new Error('create_handle returned 0');
        }
        state.handle = handle;
        log(`Handle created: 0x${Number(state.handle).toString(16)}`);
        setConnected(true);
        return handle;
    })();
    try {
        return await state.handlePromise;
    } finally {
        state.handlePromise = null;
    }
}

async function ensureCableOpen() {
    const module = await initModule();
    const handle = await ensureHandle();
    if (!handle) {
        throw new Error('No cable handle available');
    }
    if (state.cableOpen) {
        return handle;
    }
    const result = await ccallAsync(module, 'open_cable', 'number', ['number'], [handle], { timeoutMs: 8000 });
    if (result !== 0) {
        throw new Error(`open_cable failed with code ${result}`);
    }
    state.cableOpen = true;
    log('Cable opened.');
    return handle;
}

async function updateCapabilities() {
    if (!state.handle || !state.module) {
        return;
    }
    await ensureCableOpen();
    const features = await ccallAsync(state.module, 'calc_features', 'number', ['number'], [state.handle], { timeoutMs: 8000 });
    state.features = features;
    const hasFolder = (features & FEATURE_FLAGS.FTS_FOLDER) !== 0;
    const hasBackup = (features & FEATURE_FLAGS.OPS_BACKUP) !== 0 || (features & FEATURE_FLAGS.FTS_BACKUP) !== 0;
    const hasClock = (features & FEATURE_FLAGS.OPS_CLOCK) !== 0;
    const hasRomDump = (features & FEATURE_FLAGS.OPS_ROMDUMP) !== 0;
    const isNspire = isNspireActive();
    const canReceiveOs = hasRomDump && isNspire;

    if (!hasFolder) {
        els.btnToggleView.classList.add('hidden');
        if (state.treeView) {
            state.treeView = false;
            els.btnToggleView.textContent = '🗂️ Tree View';
            els.tableView.classList.remove('hidden');
            els.treeView.classList.add('hidden');
        }
    } else {
        els.btnToggleView.classList.remove('hidden');
    }

    if (!hasBackup) {
        els.btnReceiveBackup.classList.add('disabled');
        els.btnReceiveBackup.disabled = true;
        els.btnReceiveBackup.title = 'Backup not supported by this calculator';
    } else {
        els.btnReceiveBackup.classList.remove('disabled');
        els.btnReceiveBackup.disabled = false;
        els.btnReceiveBackup.title = '';
    }

    updateNspireOsButtons(isNspire, canReceiveOs);

    if (!hasClock) {
        els.btnSyncClock.classList.add('disabled');
        els.btnSyncClock.disabled = true;
        els.btnSyncClock.title = 'Clock sync not supported by this calculator';
    } else {
        els.btnSyncClock.classList.remove('disabled');
        els.btnSyncClock.disabled = false;
        els.btnSyncClock.title = '';
    }

    if (!hasRomDump) {
        els.btnDumpRom.classList.add('disabled');
        els.btnDumpRom.disabled = true;
        els.btnDumpRom.title = 'ROM dumping not supported by this calculator';
    } else {
        els.btnDumpRom.classList.remove('disabled');
        els.btnDumpRom.disabled = false;
        els.btnDumpRom.title = '';
    }
}

function updateNspireOsButtons(isNspire, canReceiveOs) {
    const showReceive = Boolean(isNspire);
    els.btnReceiveOs.classList.toggle('hidden', !showReceive);
    if (!showReceive) {
        state.nspireOsReceiveStarted = false;
        els.btnReceiveOs.classList.add('disabled');
        els.btnReceiveOs.disabled = true;
        els.btnReceiveOs.title = 'OS receive is only supported on TI-Nspire models';
    } else if (!canReceiveOs) {
        els.btnReceiveOs.classList.add('disabled');
        els.btnReceiveOs.disabled = true;
        els.btnReceiveOs.title = 'OS receive is not supported by this calculator';
    } else {
        els.btnReceiveOs.classList.remove('disabled');
        els.btnReceiveOs.disabled = false;
        els.btnReceiveOs.title = '';
    }

    const showDownload = showReceive && state.nspireOsReceiveStarted;
    els.btnDownloadOsPartial.classList.toggle('hidden', !showDownload);
    if (!showDownload) {
        els.btnDownloadOsPartial.classList.add('disabled');
        els.btnDownloadOsPartial.disabled = true;
        els.btnDownloadOsPartial.title = showReceive
            ? 'Press Receive OS to enable downloading.'
            : 'OS receive is only supported on TI-Nspire models';
    } else {
        els.btnDownloadOsPartial.classList.remove('disabled');
        els.btnDownloadOsPartial.disabled = false;
        els.btnDownloadOsPartial.title = '';
    }
}

async function connect() {
    setButtonLoading(els.btnConnect, true);
    const hadWorkingConnection = state.connected || state.cableOpen || Boolean(state.handle);
    try {
        state.connectInProgress = true;
        await authorizeDevice(true);
        if (promptCableMismatchResolution()) {
            return;
        }
        if (!ensureSilverlinkModelSelected()) {
            return;
        }
        await ensureCableOpen();
        await updateCapabilities();
        if (!isTi92Selected()) {
            await getDeviceInfo();
        } else {
            log('Skipping automatic device info query for TI-92.');
        }
        setConnected(true);
        setStatus('Connected', true);
        log('Device connected.');
    } catch (err) {
        if (hadWorkingConnection) {
            setStatus('Connected', true);
        } else {
            setStatus('Connection failed', false);
        }
        logError(err, 'Connect failed');
    } finally {
        state.connectInProgress = false;
        setButtonLoading(els.btnConnect, false);
    }
}

async function isReady() {
    setButtonLoading(els.btnIsReady, true);
    try {
        await authorizeDevice();
        if (promptCableMismatchResolution()) {
            return;
        }
        if (!ensureSilverlinkModelSelected()) {
            return;
        }
        const module = await initModule();
        const handle = await ensureCableOpen();
        await updateCapabilities();
        const result = await ccallAsync(module, 'is_ready', 'number', ['number'], [handle], { timeoutMs: 8000 });
        log(`isReady result: ${result}`);
    } catch (err) {
        logError(err, 'isReady failed');
    } finally {
        setButtonLoading(els.btnIsReady, false);
    }
}

async function getDeviceInfo() {
    setButtonLoading(els.btnGetInfo, true);
    try {
        if (isTi92Selected()) {
            const proceed = confirm('You will have to physically unplug and replug the cable after that. Continue?');
            if (!proceed) {
                log('Device info refresh cancelled.');
                return;
            }
        }
        await authorizeDevice();
        if (promptCableMismatchResolution()) {
            return;
        }
        if (!ensureSilverlinkModelSelected()) {
            return;
        }
        const module = await initModule();
        const handle = await ensureCableOpen();
        await updateCapabilities();
        const infoText = await ccallAsync(module, 'calc_get_info_string', 'string', ['number'], [handle], { timeoutMs: 12000 });
        if (!infoText || typeof infoText !== 'string') {
            log('Device info unavailable.');
            return;
        }
        const entries = parseInfoText(infoText);
        renderDeviceInfo(entries);
        const productName = entries.find(entry => entry.key.toLowerCase() === 'product name');
        if (productName) {
            state.deviceModelName = productName.value;
            state.deviceInfoProductName = productName.value;
        }
        updateDeviceModelDisplay(productName?.value || '');
        const modelUpdateInfo = module.ccall('consume_model_update_info', 'string', [], []);
        if (modelUpdateInfo) {
            try {
                const info = JSON.parse(modelUpdateInfo);
                const fromName = info.fromName || 'Unknown';
                const toName = info.toName || 'Unknown';
                if (fromName !== toName) {
                    log(`Calculator model updated from ${fromName} to ${toName} based on device info.`);
                }
            } catch (err) {
                console.warn('[WebTILP] Failed to parse model update info', err);
                log('Calculator model updated based on device info.');
            }
        }
        const reopenNeeded = module._consume_cable_reopen_flag();
        if (reopenNeeded) {
            state.cableOpen = false;
        }
        if ((state.features & FEATURE_FLAGS.OPS_CLOCK) !== 0) {
            const clockInfo = await getClockInfo(module, handle);
            const clockText = formatClockDisplay(clockInfo);
            const clockKey = buildClockRowKey();
            appendDeviceInfoRow(clockKey, clockText ? clockText : 'Unknown');
        }
        log('Device info retrieved.');
    } catch (err) {
        logError(err, 'Device info failed');
    } finally {
        setButtonLoading(els.btnGetInfo, false);
    }
}

function parseClockInfo(text) {
    if (!text || typeof text !== 'string') {
        return null;
    }
    try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object') {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

function normalizeClockSettings(clockInfo) {
    const timeFormat = clockInfo?.time_format === 12 ? 12 : 24;
    let dateFormat = Number(clockInfo?.date_format);
    if (!Number.isFinite(dateFormat) || dateFormat < 1) {
        dateFormat = 1;
    }
    let state = Number(clockInfo?.state);
    if (!Number.isFinite(state)) {
        state = 1;
    }
    return { timeFormat, dateFormat, state };
}

function clockInfoToDate(clockInfo) {
    if (!clockInfo || typeof clockInfo !== 'object') {
        return null;
    }
    const year = Number(clockInfo.year);
    const month = Number(clockInfo.month);
    const day = Number(clockInfo.day);
    const hours = Number(clockInfo.hours);
    const minutes = Number(clockInfo.minutes);
    const seconds = Number(clockInfo.seconds);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
        return null;
    }
    if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
        return null;
    }
    return new Date(year, Math.max(month - 1, 0), day, hours, minutes, seconds);
}

async function getClockInfo(module, handle) {
    const clockInfoText = await ccallAsync(module, 'calc_get_clock_json', 'string', ['number'], [handle], { timeoutMs: 8000 });
    return parseClockInfo(clockInfoText);
}

async function setClockFromDate(module, handle, date, settings) {
    return ccallAsync(
        module,
        'calc_set_clock',
        'number',
        ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number'],
        [
            handle,
            date.getFullYear(),
            date.getMonth() + 1,
            date.getDate(),
            date.getHours(),
            date.getMinutes(),
            date.getSeconds(),
            settings.timeFormat,
            settings.dateFormat,
            settings.state
        ],
        { timeoutMs: PROGRESS_IDLE_TIMEOUT_MS, useProgress: true }
    );
}

async function syncClock() {
    setButtonLoading(els.btnSyncClock, true);
    try {
        await authorizeDevice();
        if (promptCableMismatchResolution()) {
            return;
        }
        if (!ensureSilverlinkModelSelected()) {
            return;
        }
        const module = await initModule();
        const handle = await ensureCableOpen();
        await updateCapabilities();

        if ((state.features & FEATURE_FLAGS.OPS_CLOCK) === 0) {
            log('Clock sync not supported by this calculator.');
            return;
        }

        const clockInfo = await getClockInfo(module, handle);
        const settings = normalizeClockSettings(clockInfo);
        const baseDate = new Date();
        let targetDate = new Date(baseDate.getTime());
        let result = await setClockFromDate(module, handle, targetDate, settings);
        if (result !== 0) {
            log(`Clock sync failed (${formatErrorResult(module, result)}).`);
            return;
        }

        let adjusted = false;
        let afterInfo = await getClockInfo(module, handle);
        let afterDate = clockInfoToDate(afterInfo);
        if (afterDate) {
            const diffMinutes = Math.round((targetDate.getTime() - afterDate.getTime()) / 60000);
            const diffAbs = Math.abs(diffMinutes);
            if (diffAbs >= 30 && diffAbs <= 120) {
                adjusted = true;
                targetDate = new Date(targetDate.getTime() + diffMinutes * 60000);
                result = await setClockFromDate(module, handle, targetDate, settings);
                if (result !== 0) {
                    log(`Clock sync failed (${formatErrorResult(module, result)}).`);
                    return;
                }
                afterInfo = await getClockInfo(module, handle);
                afterDate = clockInfoToDate(afterInfo);
            }
        }

        const displayDate = afterDate || targetDate;
        if (adjusted) {
            log(`Clock synced (timezone corrected) to ${displayDate.toLocaleString()}.`);
        } else {
            log(`Clock synced to ${displayDate.toLocaleString()}.`);
        }
        updateClockInfoRow(afterInfo, settings, displayDate);
    } catch (err) {
        logError(err, 'Clock sync failed');
    } finally {
        setButtonLoading(els.btnSyncClock, false);
    }
}

function parseInfoText(text) {
    if (typeof text !== 'string') {
        return [];
    }
    return text
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length)
        .map(line => {
            const parts = line.split(':');
            const key = parts.shift().trim();
            const value = parts.join(':').trim();
            return { key, value };
        })
        .filter(entry => entry.key.length && entry.value.length);
}

function renderDeviceInfo(entries) {
    els.deviceInfoList.innerHTML = '';
    entries.forEach(entry => {
        const row = document.createElement('div');
        row.className = 'info-row';
        const valueClass = / hash$/i.test(entry.key) ? 'value hash-value' : 'value';
        row.innerHTML = `<div class="key">${entry.key}</div><div class="${valueClass}">${entry.value}</div>`;
        els.deviceInfoList.appendChild(row);
    });
    updateMemoryFromDeviceInfo(entries);
}

function appendDeviceInfoRow(key, value) {
    if (!els.deviceInfoList) {
        return;
    }
    const row = document.createElement('div');
    row.className = 'info-row';
    const valueClass = / hash$/i.test(key) ? 'value hash-value' : 'value';
    row.innerHTML = `<div class="key">${key}</div><div class="${valueClass}">${value}</div>`;
    els.deviceInfoList.appendChild(row);
}

function formatClockDisplayBase(date, timeFormatValue, dateFormatValue) {
    if (!date) {
        return null;
    }
    const timeFormat = timeFormatValue === 12 ? '12h' : '24h';
    const dateFormat = Number(dateFormatValue);
    const dateFormatLabel = Number.isFinite(dateFormat) ? `D${dateFormat}` : 'D?';
    const timePart = `<abbr title="Clock time format">${timeFormat}</abbr>`;
    const datePart = `<abbr title="Clock date format index">${dateFormatLabel}</abbr>`;
    return `${date.toLocaleString()} (${timePart}, ${datePart})`;
}

function formatClockDisplay(clockInfo) {
    const date = clockInfoToDate(clockInfo);
    const timeFormatValue = clockInfo?.time_format === 12 ? 12 : 24;
    return formatClockDisplayBase(date, timeFormatValue, clockInfo?.date_format);
}

function formatClockDisplayFromDate(date, settings) {
    const timeFormatValue = settings?.timeFormat === 12 ? 12 : 24;
    return formatClockDisplayBase(date, timeFormatValue, settings?.dateFormat);
}

function buildClockRowKey() {
    return `Clock (at <abbr title="${new Date().toLocaleString()}">last refresh</abbr>)`;
}

function updateScreenshotCanvasScale() {
    const canvas = els.screenshotCanvas;
    if (!canvas || !canvas.width || !canvas.height) {
        return;
    }
    const parent = canvas.parentElement;
    if (!parent) {
        return;
    }
    const styles = getComputedStyle(canvas);
    const padX = (parseFloat(styles.paddingLeft) || 0) + (parseFloat(styles.paddingRight) || 0);
    let maxWidth = parent.clientWidth;
    const cssMaxWidth = parseFloat(styles.maxWidth);
    if (Number.isFinite(cssMaxWidth) && cssMaxWidth > 0) {
        maxWidth = Math.min(maxWidth, cssMaxWidth);
    }
    maxWidth -= padX;
    if (maxWidth <= 0) {
        return;
    }
    const scale = Math.max(1, Math.floor(maxWidth / canvas.width));
    canvas.style.width = `${canvas.width * scale}px`;
    canvas.style.height = `${canvas.height * scale}px`;
}

function updateClockInfoRow(clockInfo, settings, fallbackDate) {
    if (!els.deviceInfoList) {
        return false;
    }
    const rows = els.deviceInfoList.querySelectorAll('.info-row');
    let targetRow = null;
    rows.forEach(row => {
        if (targetRow) {
            return;
        }
        const keyEl = row.querySelector('.key');
        if (keyEl && keyEl.textContent.trim().startsWith('Clock (at')) {
            targetRow = row;
        }
    });
    if (!targetRow) {
        return false;
    }
    const keyEl = targetRow.querySelector('.key');
    const valueEl = targetRow.querySelector('.value');
    if (!keyEl || !valueEl) {
        return false;
    }
    const display = formatClockDisplay(clockInfo) || formatClockDisplayFromDate(fallbackDate, settings);
    keyEl.innerHTML = buildClockRowKey();
    valueEl.innerHTML = display ? display : 'Unknown';
    return true;
}

function clearDeviceData() {
    state.dirlist = [];
    state.nspireOsReceiveStarted = false;
    updateNspireOsButtons(false, false);
    renderDirlist(state.dirlist);
    updateSelectionActionButtons();
    updateKeyControlsState(false);
    els.deviceInfoList.innerHTML = '';
    els.deviceModel.textContent = 'Unknown';
    state.deviceModelName = '';
    els.memoryInfo.textContent = '—';
    els.memoryInfo.title = '';
    const ctx = els.screenshotCanvas.getContext('2d');
    els.screenshotCanvas.width = 320;
    els.screenshotCanvas.height = 240;
    els.screenshotCanvas.classList.remove('filled');
    ctx.clearRect(0, 0, els.screenshotCanvas.width, els.screenshotCanvas.height);
}

function updateMemoryFromDeviceInfo(entries) {
    const getValue = (label) => {
        const found = entries.find(entry => entry.key.toLowerCase() === label.toLowerCase());
        return found ? found.value : null;
    };
    const freeRam = getValue('Free RAM');
    const freeFlash = getValue('Free Flash');
    if (freeRam || freeFlash) {
        const parts = [];
        const rawParts = [];
        if (freeRam) {
            const ramBytes = parseLeadingBytes(freeRam);
            parts.push(`RAM ${ramBytes !== null ? formatBytes(ramBytes) : freeRam}`);
            rawParts.push(`RAM ${ramBytes !== null ? `${ramBytes}B` : freeRam}`);
        }
        if (freeFlash) {
            const flashBytes = parseLeadingBytes(freeFlash);
            parts.push(`Flash ${flashBytes !== null ? formatBytes(flashBytes) : freeFlash}`);
            rawParts.push(`Flash ${flashBytes !== null ? `${flashBytes}B` : freeFlash}`);
        }
        els.memoryInfo.textContent = parts.join(' | ');
        els.memoryInfo.title = rawParts.join(' | ');
    }
}

function parseLeadingBytes(text) {
    const match = String(text).match(/^\s*(\d+)\s*B/i);
    if (!match) {
        return null;
    }
    return Number(match[1]);
}

async function refreshDirlist() {
    setButtonLoading(els.btnRefreshDirlist, true);
    try {
        await authorizeDevice();
        const module = await initModule();
        const handle = await ensureHandle();
        await updateCapabilities();
        const result = await ccallAsync(module, 'calc_dirlist_json', 'number', ['number', 'string'], [handle, '/dirlist.json'], { timeoutMs: null, useProgress: true });
        if (result !== 0) {
            log(`Dirlist failed (${formatErrorResult(module, result)}).`);
            return;
        }
        const data = module.FS.readFile('/dirlist.json', { encoding: 'utf8' });
        const parsed = JSON.parse(data);
        state.dirlist = [...parsed.vars, ...parsed.apps];
        renderDirlist(state.dirlist);
        if (parsed.memory && parsed.memory.ok) {
            const ramInfo = formatMemoryValue(parsed.memory.ram_free);
            const flashInfo = formatMemoryValue(parsed.memory.flash_free);
            els.memoryInfo.textContent = `RAM ${ramInfo.display} | Flash ${flashInfo.display}`;
            els.memoryInfo.title = `RAM ${ramInfo.raw} | Flash ${flashInfo.raw}`;
        }
        log(`Dirlist loaded: ${state.dirlist.length} entries.`);
    } catch (err) {
        logError(err, 'Dirlist failed');
    } finally {
        setButtonLoading(els.btnRefreshDirlist, false);
    }
}

function renderDirlist(entries) {
    const filter = (els.filterInput.value || '').toLowerCase();
    const showLocation = !isNspireActive();
    const table = els.varTableBody.closest('table');
    if (table) {
        table.classList.toggle('hide-location', !showLocation);
    }
    if (state.treeView) {
        renderTreeView(entries, filter, showLocation);
    } else {
        renderTableView(entries, filter);
    }
    updateSelectionActionButtons();
}

function renderTableView(entries, filter) {
    els.varTableBody.innerHTML = '';
    const list = entries
        .filter(entry => {
            const hay = `${entry.name} ${entry.type} ${entry.type_name || ''} ${entry.kind}`.toLowerCase();
            return hay.includes(filter);
        });
    list.sort((a, b) => compareEntries(a, b, state.sort.key, state.sort.dir));
    list.forEach(entry => {
            const isArchived = entry.attr === 3;
            const isFolder = entry.is_folder === 1;
            const location = entry.kind === 'app' ? 'Flash' : (isArchived ? 'Archive' : 'RAM');
            const typeLabel = isFolder ? 'Directory' : (entry.type_name || `Unknown (${entry.type})`);
            const row = document.createElement('tr');
            row.dataset.folderTarget = getEntryFolderPath(entry);
            row.dataset.isFolder = isFolder ? '1' : '0';
            row.innerHTML = `
                <td><input type="checkbox" data-name="${entry.name}" data-folder="${entry.folder}" data-type="${entry.type}" data-kind="${entry.kind}" ${isFolder ? 'disabled title="Folder"' : ''}></td>
                <td>${entry.name}</td>
                <td>${typeLabel}</td>
                <td>${entry.size}</td>
                <td>${isFolder ? '-' : location}</td>
                <td>${entry.folder || '-'}</td>
                <td>${entry.kind}</td>
            `;
            els.varTableBody.appendChild(row);
        });
}

function compareEntries(a, b, key, dir) {
    const factor = dir === 'asc' ? 1 : -1;
    const getLocation = entry => entry.kind === 'app' ? 'Flash' : (entry.attr === 3 ? 'Archive' : 'RAM');
    const valueA = (() => {
        switch (key) {
            case 'name': return a.name || '';
            case 'type': return a.type_name || `Unknown (${a.type})`;
            case 'size': return a.size || 0;
            case 'location': return getLocation(a);
            case 'folder': return a.folder || '';
            default: return a.name || '';
        }
    })();
    const valueB = (() => {
        switch (key) {
            case 'name': return b.name || '';
            case 'type': return b.type_name || `Unknown (${b.type})`;
            case 'size': return b.size || 0;
            case 'location': return getLocation(b);
            case 'folder': return b.folder || '';
            default: return b.name || '';
        }
    })();

    if (typeof valueA === 'number' && typeof valueB === 'number') {
        const diff = (valueA - valueB) * factor;
        if (diff !== 0) {
            return diff;
        }
        return String(a.name || '').localeCompare(String(b.name || '')) * factor;
    }
    const diff = String(valueA).localeCompare(String(valueB)) * factor;
    if (diff !== 0) {
        return diff;
    }
    return String(a.name || '').localeCompare(String(b.name || '')) * factor;
}

function renderTreeView(entries, filter, showLocation) {
    els.treeView.innerHTML = '';
    const tree = buildTree(entries);
    tree.forEach(node => {
        els.treeView.appendChild(renderTreeNode(node, filter, showLocation));
    });
}

function buildTree(entries) {
    const root = new Map();
    entries.forEach(entry => {
        const folder = entry.folder || '';
        const segments = folder ? folder.split('/') : [];
        let cursor = root;
        segments.forEach(seg => {
            if (!cursor.has(seg)) {
                cursor.set(seg, { name: seg, children: new Map(), entries: [], isFolder: true });
            }
            cursor = cursor.get(seg).children;
        });
        const parent = cursor;
        if (!parent.has('__entries__')) {
            parent.set('__entries__', { entries: [] });
        }
        parent.get('__entries__').entries.push(entry);
    });

    function mapToNodes(map, prefix) {
        const nodes = [];
        map.forEach((value, key) => {
            if (key === '__entries__') {
                value.entries.forEach(entry => nodes.push({ entry }));
            } else {
                const path = prefix ? `${prefix}/${value.name}` : value.name;
                nodes.push({
                    name: value.name,
                    path,
                    children: mapToNodes(value.children, path)
                });
            }
        });
        return nodes.sort((a, b) => (a.name || a.entry.name).localeCompare(b.name || b.entry.name));
    }

    return mapToNodes(root, '');
}

function renderTreeNode(node, filter, showLocation) {
    if (node.entry) {
        const entry = node.entry;
        if (entry.is_folder === 1) {
            return document.createDocumentFragment();
        }
        const hay = `${entry.name} ${entry.type} ${entry.type_name || ''} ${entry.kind}`.toLowerCase();
        if (filter && !hay.includes(filter)) {
            return document.createDocumentFragment();
        }
        const isArchived = entry.attr === 3;
        const isFolder = entry.is_folder === 1;
        const typeLabel = isFolder ? 'Directory' : (entry.type_name || `Unknown (${entry.type})`);
        const metaParts = [typeLabel];
        if (!isFolder && showLocation) {
            const location = entry.kind === 'app' ? 'Flash' : (isArchived ? 'Archive' : 'RAM');
            metaParts.push(location);
        }
        if (!isFolder) {
            metaParts.push(`${entry.size} bytes`);
        }
        const nodeEl = document.createElement('div');
        nodeEl.className = 'tree-node';
        nodeEl.dataset.folderPath = entry.folder || '';
        nodeEl.innerHTML = `
            <input type="checkbox" data-name="${entry.name}" data-folder="${entry.folder}" data-type="${entry.type}" data-kind="${entry.kind}" ${isFolder ? 'disabled title="Folder"' : ''}>
            <div>
                <div>${entry.name}</div>
                <div class="tree-meta">${metaParts.join(' · ')}</div>
            </div>
        `;
        return nodeEl;
    }

    const nodeEl = document.createElement('div');
    const header = document.createElement('div');
    header.className = 'tree-node';
    header.innerHTML = `<strong>${node.name || 'Root'}</strong>`;
    header.dataset.folderPath = node.path || '';
    nodeEl.appendChild(header);

    const childrenWrap = document.createElement('div');
    childrenWrap.className = 'tree-children';
    node.children.forEach(child => {
        const childEl = renderTreeNode(child, filter, showLocation);
        if (childEl.childNodes.length === 0 && childEl.nodeType === 11) {
            return;
        }
        childrenWrap.appendChild(childEl);
    });
    nodeEl.appendChild(childrenWrap);
    return nodeEl;
}

function getEntryFolderPath(entry) {
    const parent = entry.folder || '';
    if (entry.is_folder === 1) {
        return parent ? `${parent}/${entry.name}` : entry.name;
    }
    return parent;
}

function clearDropHighlight() {
    if (currentDropTarget) {
        currentDropTarget.classList.remove('drop-target');
        currentDropTarget = null;
    }
}

function setDropHighlight(target) {
    if (!target || target === currentDropTarget) {
        return;
    }
    clearDropHighlight();
    currentDropTarget = target;
    currentDropTarget.classList.add('drop-target');
}

function hasFileDrag(event) {
    const dt = event.dataTransfer;
    if (!dt) {
        return false;
    }
    const types = dt.types ? Array.from(dt.types) : [];
    if (types.includes('Files')) {
        return true;
    }
    if (dt.files && dt.files.length) {
        return true;
    }
    if (dt.items && dt.items.length) {
        return Array.from(dt.items).some(item => item.kind === 'file');
    }
    return false;
}

function setSelectedFiles(files, sourceLabel) {
    state.selectedFiles = Array.from(files || []);
    if (els.fileInput) {
        if (state.selectedFiles.length) {
            try {
                const dataTransfer = new DataTransfer();
                state.selectedFiles.forEach(file => dataTransfer.items.add(file));
                els.fileInput.files = dataTransfer.files;
            } catch {
                // Some browsers disallow programmatic file assignment.
            }
        } else {
            els.fileInput.value = '';
        }
    }
    if (state.selectedFiles.length) {
        const suffix = sourceLabel ? ` from ${sourceLabel}` : '';
        log(`Loaded ${state.selectedFiles.length} file(s)${suffix}.`);
    }
    updateSendFilesButtonState();
    if (state.selectedFiles.length && (sourceLabel === 'drop' || sourceLabel === 'file picker')) {
        sendSelectedFiles();
    }
}

function updateSendFilesButtonState() {
    if (!els.btnSendFiles) {
        return;
    }
    const hasFiles = state.selectedFiles.length || (els.fileInput && els.fileInput.files && els.fileInput.files.length);
    els.btnSendFiles.disabled = !hasFiles;
    els.btnSendFiles.classList.toggle('primary', !!hasFiles);
    els.btnSendFiles.classList.toggle('subtle', !hasFiles);
    els.btnSendFiles.classList.toggle('send-idle', !hasFiles);
}

function updateSelectionActionButtons() {
    const hasSelection = getSelectedVarInputs().length > 0;
    if (els.btnRecvSelected) {
        els.btnRecvSelected.disabled = !hasSelection;
    }
    if (els.btnDeleteSelected) {
        els.btnDeleteSelected.disabled = !hasSelection;
    }
}

function setDropzoneActive(active) {
    if (dropzoneActive === active) {
        return;
    }
    dropzoneActive = active;
    const dropzone = document.getElementById('dropzone');
    if (dropzone) {
        dropzone.classList.toggle('drag-over', active);
    }
}

function getDroppedFiles(event) {
    const files = event.dataTransfer?.files;
    if (files && files.length) {
        return Array.from(files);
    }
    const items = event.dataTransfer?.items;
    if (!items || !items.length) {
        return [];
    }
    const result = [];
    Array.from(items).forEach(item => {
        if (item.kind === 'file') {
            const file = item.getAsFile();
            if (file) {
                result.push(file);
            }
        }
    });
    return result;
}

function readProgressTick() {
    if (!state.module) {
        return null;
    }
    try {
        return state.module._get_progress_tick_value();
    } catch {
        return null;
    }
}

function getSelectedVarInputs() {
    const tableInputs = Array.from(els.varTableBody.querySelectorAll('input[type="checkbox"]:checked'));
    const treeInputs = Array.from(els.treeView.querySelectorAll('input[type="checkbox"]:checked'));
    return state.treeView ? treeInputs : tableInputs;
}

function buildSelectionKey(input) {
    const name = input.dataset.name || '';
    const folder = input.dataset.folder || '';
    const type = input.dataset.type || '';
    const kind = input.dataset.kind || '';
    return `${kind}|${folder}|${type}|${name}`;
}

function getSelectedVarKeys() {
    const keys = new Set();
    getSelectedVarInputs().forEach(input => {
        keys.add(buildSelectionKey(input));
    });
    return keys;
}

function applySelectionKeys(keys, container) {
    if (!keys || !container) {
        return;
    }
    container.querySelectorAll('input[type="checkbox"]').forEach(input => {
        if (input.disabled) {
            return;
        }
        input.checked = keys.has(buildSelectionKey(input));
    });
}

async function sendDroppedFiles(files, dropFolder) {
    if (!files.length) {
        return;
    }
    log(`Dropped ${files.length} file(s) for transfer.`);
    try {
        await authorizeDevice();
        if (promptCableMismatchResolution()) {
            return;
        }
        if (!ensureSilverlinkModelSelected()) {
            return;
        }
        const module = await initModule();
        await ensureCableOpen();
        await updateCapabilities();

        if (!state.dirlist.length) {
            const confirmDirlist = confirm('Directory listing has not been loaded yet. It is highly recommended before transfers. Load it now?');
            if (confirmDirlist) {
                await refreshDirlist();
            }
        }

        const hasFolder = (state.features & FEATURE_FLAGS.FTS_FOLDER) !== 0;
        const hasArchive = (state.features & FEATURE_FLAGS.OPS_CHATTR) !== 0 || (state.features & FEATURE_FLAGS.FTS_FLASH) !== 0;
        const effectiveFolder = hasFolder ? (dropFolder || '') : '';
        if (effectiveFolder) {
            log(`Target folder: ${effectiveFolder}`);
        }
        const plan = await buildTransferPlan(files, module);
        const selections = plan.map(item => ({
            ...item,
            targetFolder: effectiveFolder
        }));
        const { successCount } = await performTransfers(selections, module, { hasFolder, hasArchive });
        selections.forEach(item => {
            try {
                module.FS.unlink(item.path);
            } catch {
                // ignore
            }
        });
        const hasOsTransfer = selections.some(item => item.isOs);
        if (successCount > 0) {
            setSelectedFiles([]);
            if (!hasOsTransfer) {
                await refreshDirlist();
            }
        }
    } catch (err) {
        logError(err, 'Dropped transfer failed');
    }
}

function getDirlistFolders() {
    const folders = new Set(['']);
    state.dirlist.forEach(entry => {
        if (entry.is_folder === 1 && entry.name) {
            folders.add(entry.name);
            return;
        }
        if (entry.folder) {
            folders.add(entry.folder);
        }
    });
    return Array.from(folders).filter(folder => folder !== '');
}

function isVarFileClass(fileClass) {
    return ['single', 'group', 'regular', 'tigroup'].includes(fileClass);
}

async function buildTransferPlan(files, module) {
    const plan = [];
    if (!module.FS.analyzePath('/uploads').exists) {
        module.FS.mkdir('/uploads');
    }

    for (const file of files) {
        const data = new Uint8Array(await file.arrayBuffer());
        const path = `/uploads/${file.name}`;
        module.FS.writeFile(path, data);

        let fileClass = 'unknown';
        let entries = [];
        let isOs = false;
        try {
        const infoText = await ccallAsync(module, 'file_get_entries_json', 'string', ['string'], [path], { timeoutMs: 8000 });
            if (infoText && typeof infoText === 'string') {
                const parsed = JSON.parse(infoText);
                fileClass = parsed.class || 'unknown';
                entries = Array.isArray(parsed.entries) ? parsed.entries : [];
            }
            const osResult = await ccallAsync(module, 'file_is_os', 'number', ['string'], [path], { timeoutMs: 3000 });
            isOs = osResult === 1;
        } catch (err) {
            console.warn('[WebTILP] Failed to parse file info', err);
        }

        const entry = entries[0] || {};
        const baseName = file.name.replace(/\.[^.]+$/, '');
        const defaultName = entry.name || baseName;
        const defaultFolder = entry.folder || '';
        const defaultLocation = entry.attr === 3 ? 'archive' : 'ram';
        let locationMask = entries.length
            ? entries.reduce((mask, item) => mask & (item.location_mask ?? 3), 3)
            : 3;
        if (fileClass === 'group') {
            locationMask = 2;
        }
        const locationMode = locationMask === 1
            ? 'ram'
            : (locationMask === 2 ? 'archive' : (locationMask === 0 ? 'auto' : defaultLocation));

        plan.push({
            file,
            path,
            fileClass,
            isOs,
            entries,
            entryCount: entries.length,
            entryName: defaultName,
            entryType: entry.type ?? null,
            entryFolder: defaultFolder,
            entryAttr: entry.attr ?? 0,
            defaultLocation,
            locationMask,
            locationMode
        });
    }

    return plan;
}

function openTransferModal(plan, options) {
    els.transferTableBody.innerHTML = '';
    const folders = options.folders || [];

    document.querySelectorAll('.transfer-location').forEach(cell => {
        cell.classList.toggle('hidden', !options.hasArchive);
    });
    document.querySelectorAll('.transfer-folder').forEach(cell => {
        cell.classList.toggle('hidden', !options.hasFolder);
    });

    plan.forEach((item, index) => {
        const row = document.createElement('tr');
        row.dataset.index = String(index);
        const entryLabel = item.entryCount > 1
            ? `${item.entryCount} entries`
            : (item.entryName || item.file.name);
        const isVar = isVarFileClass(item.fileClass);
        let locationCell = `<td class="transfer-location ${options.hasArchive ? '' : 'hidden'}">-</td>`;
        if (options.hasArchive && isVar) {
            const mask = item.locationMask ?? 3;
            const locationValue = item.locationMode || item.defaultLocation;
            const allowRam = (mask & 1) !== 0;
            const allowArchive = (mask & 2) !== 0;
            if (mask !== 3) {
                const label = mask === 2 ? 'Archive' : (mask === 1 ? 'RAM' : 'Auto');
                const titleText = mask === 2
                    ? 'Archive-only variable type.'
                    : (mask === 1 ? 'RAM-only variable type.' : 'Mixed locations detected. Keeping file defaults.');
                const titleAttr = titleText ? `title="${titleText}"` : '';
                locationCell = `<td class="transfer-location" ${titleAttr}>${label}</td>`;
            } else {
                let optionsHtml = '';
                if (allowRam) {
                    optionsHtml += `<option value="ram" ${locationValue === 'ram' ? 'selected' : ''}>RAM</option>`;
                }
                if (allowArchive) {
                    optionsHtml += `<option value="archive" ${locationValue === 'archive' ? 'selected' : ''}>Archive</option>`;
                }
                locationCell = `<td class="transfer-location"><select class="form-input" data-field="location">${optionsHtml}</select></td>`;
            }
        }
        const folderOptions = ['<option value="">(root)</option>']
            .concat(folders.map(folder => `<option value="${folder}">${folder}</option>`))
            .join('');
        const folderCell = options.hasFolder && isVar
            ? `<td class="transfer-folder"><select class="form-input" data-field="folder">${folderOptions}</select></td>`
            : `<td class="transfer-folder ${options.hasFolder ? '' : 'hidden'}">-</td>`;
        row.innerHTML = `
            <td>${item.file.name}</td>
            <td>${entryLabel}</td>
            ${locationCell}
            ${folderCell}
        `;
        els.transferTableBody.appendChild(row);

        if (options.hasFolder) {
            const folderSelect = row.querySelector('[data-field="folder"]');
            folderSelect.value = item.entryFolder || '';
        }
    });

    els.transferModal.classList.remove('hidden');

    return new Promise(resolve => {
        const cleanup = () => {
            els.btnConfirmTransfer.removeEventListener('click', onConfirm);
            els.btnCancelTransfer.removeEventListener('click', onCancel);
            els.btnCloseTransfer.removeEventListener('click', onCancel);
        };
        const onCancel = () => {
            cleanup();
            els.transferModal.classList.add('hidden');
            resolve(null);
        };
        const onConfirm = () => {
            const selections = plan.map((item, index) => {
                const row = els.transferTableBody.querySelector(`tr[data-index="${index}"]`);
                if (!row) {
                    return { ...item };
                }
                const locationSelect = row.querySelector('[data-field="location"]');
                const location = options.hasArchive && locationSelect
                    ? (locationSelect.value || item.locationMode || item.defaultLocation)
                    : item.defaultLocation;
                const folder = options.hasFolder
                    ? row.querySelector('[data-field="folder"]')?.value || ''
                    : item.entryFolder;
                return {
                    ...item,
                    targetLocation: location,
                    targetFolder: folder
                };
            });
            cleanup();
            els.transferModal.classList.add('hidden');
            resolve(selections);
        };
        els.btnConfirmTransfer.addEventListener('click', onConfirm);
        els.btnCancelTransfer.addEventListener('click', onCancel);
        els.btnCloseTransfer.addEventListener('click', onCancel);
    });
}

function normalizeFolderPath(folder) {
    return String(folder || '')
        .replace(/^[\\/]+/, '')
        .replace(/[\\/]+$/, '')
        .replace(/[\\/]+/g, '/');
}

function findDirlistMatch(name, type, folder, location) {
    const targetFolder = normalizeFolderPath(folder);
    return state.dirlist.find(entry => {
        if (entry.kind !== 'var') {
            return false;
        }
        const entryFolder = normalizeFolderPath(entry.folder);
        return entry.name === name && entry.type === type && entryFolder === targetFolder;
    });
}

async function performTransfers(plan, module, options) {
    const handle = await ensureCableOpen();
    let successCount = 0;

    for (const item of plan) {
        if (!item.path) {
            continue;
        }

        const isVar = isVarFileClass(item.fileClass);
        let targetName = item.entryName || '';
        const targetFolder = options.hasFolder ? (item.targetFolder || item.entryFolder || '') : '';
        const folderOverride = options.hasFolder && isVar && item.targetFolder && item.targetFolder !== item.entryFolder
            ? item.targetFolder
            : '';
        const locationMask = item.locationMask ?? 3;
        const selectionLocation = item.targetLocation || item.locationMode || item.defaultLocation;
        const canOverrideLocation = options.hasArchive && isVar && locationMask === 3;
        const requestedLocation = canOverrideLocation ? selectionLocation : 'auto';
        let targetLocation = selectionLocation;
        if (!canOverrideLocation) {
            if (locationMask === 2) {
                targetLocation = 'archive';
            } else if (locationMask === 1) {
                targetLocation = 'ram';
            } else if (requestedLocation === 'auto') {
                targetLocation = item.entryAttr === 3 ? 'archive' : 'ram';
            }
        }

        let existing = null;
        if (isVar && state.dirlist.length && targetName && item.entryType != null) {
            existing = findDirlistMatch(targetName, item.entryType, targetFolder, targetLocation);
            if (existing) {
                const overwrite = confirm(`${targetName} already exists there. Overwrite?`);
                if (!overwrite) {
                    log(`Skipped ${item.file.name}, because overwriting was declined.`);
                    continue;
                }
                if (existing.attr !== 0 && hasSilverlinkConnected()) {
                    const msg = `Cannot overwrite ${targetName} because it is locked/archived. Unarchive/unlock it on the calculator and retry.`;
                    log(msg);
                    alert(msg);
                    continue;
                }
                const is89t_dusb = state.authorizedDevice?.productId === 0xe004;
                if (is89t_dusb) {
                    if (existing.attr !== 0) {
                        const clearAttrResult = await ccallAsync(
                            module,
                            'calc_change_attr',
                            'number',
                            ['number', 'string', 'string', 'number', 'number'],
                            [handle, targetFolder, targetName, item.entryType, 0],
                            { timeoutMs: PROGRESS_IDLE_TIMEOUT_MS, useProgress: true }
                        );
                        if (clearAttrResult !== 0) {
                            const msg = `Failed to clear attributes for ${targetName} (${formatErrorResult(module, clearAttrResult)}).`;
                            log(msg);
                            alert(msg);
                            continue;
                        }
                    }
                    const deleteResult = await ccallAsync(
                        module,
                        'calc_del_var',
                        'number',
                        ['number', 'string', 'string', 'number'],
                        [handle, targetFolder, targetName, item.entryType],
                        { timeoutMs: PROGRESS_IDLE_TIMEOUT_MS, useProgress: true }
                    );
                    if (deleteResult !== 0) {
                        const deleteRaw = module ? module._get_raw_protocol_code(deleteResult) : 0;
                        let msg = '';
                        if (deleteRaw === 0x0021) {
                            msg = `Cannot overwrite ${targetName} because it is locked/archived. Unarchive/unlock it on the calculator and retry.`;
                        } else {
                            msg = `Failed to delete existing ${targetName} (${formatErrorResult(module, deleteResult)}).`;
                        }
                        log(msg);
                        alert(msg);
                        continue;
                    }
                    state.dirlist = state.dirlist.filter(entry => entry !== existing);
                    existing = null;
                }
            }
        }

        const locationCode = canOverrideLocation && selectionLocation !== item.defaultLocation
            ? (selectionLocation === 'archive' ? 1 : 0)
            : -1;
        const result = await ccallAsync(
            module,
            'send_file_custom',
            'number',
            ['number', 'string', 'string', 'number'],
            [handle, item.path, folderOverride, locationCode],
            { timeoutMs: PROGRESS_IDLE_TIMEOUT_MS, useProgress: true }
        );

        if (result === 0) {
            log(`Sent ${item.file.name} successfully.`);
            successCount += 1;
            if (isVar && targetName && item.entryType != null) {
                state.dirlist.push({
                    name: targetName,
                    type: item.entryType,
                    folder: targetFolder,
                    attr: targetLocation === 'archive' ? 3 : (targetLocation === 'ram' ? 0 : item.entryAttr),
                    kind: 'var',
                    is_folder: 0,
                    size: item.file.size
                });
            }
        } else {
            log(`Failed to send ${item.file.name} (${formatErrorResult(module, result)}).`);
        }
    }
    return { successCount };
}

async function sendSelectedFiles() {
    const files = state.selectedFiles.length
        ? state.selectedFiles
        : Array.from(els.fileInput.files || []);
    if (!files.length) {
        log('No files selected.');
        return;
    }
    setButtonLoading(els.btnSendFiles, true);
    try {
        await authorizeDevice();
        if (!ensureSilverlinkModelSelected()) {
            return;
        }
        const module = await initModule();
        await ensureCableOpen();
        await updateCapabilities();

        if (!state.dirlist.length) {
            const confirmDirlist = confirm('Directory listing has not been loaded yet. It is highly recommended before transfers. Load it now?');
            if (confirmDirlist) {
                await refreshDirlist();
            }
        }

        const hasFolder = (state.features & FEATURE_FLAGS.FTS_FOLDER) !== 0;
        const hasArchive = (state.features & FEATURE_FLAGS.OPS_CHATTR) !== 0 || (state.features & FEATURE_FLAGS.FTS_FLASH) !== 0;
        const folders = hasFolder ? getDirlistFolders() : [];
        const plan = await buildTransferPlan(files, module);
        const selections = await openTransferModal(plan, { hasFolder, hasArchive, folders });
        if (!selections) {
            plan.forEach(item => {
                try {
                    module.FS.unlink(item.path);
                } catch {
                    // ignore
                }
            });
            return;
        }

        const { successCount } = await performTransfers(selections, module, { hasFolder, hasArchive });

        selections.forEach(item => {
            try {
                module.FS.unlink(item.path);
            } catch {
                // ignore
            }
        });
        state.selectedFiles = [];

        const hasOsTransfer = selections.some(item => item.isOs);
        if (successCount > 0) {
            setSelectedFiles([]);
            if (!hasOsTransfer) {
                await refreshDirlist();
            }
        }
    } catch (err) {
        logError(err, 'Send files failed');
    } finally {
        setButtonLoading(els.btnSendFiles, false);
    }
}

async function receiveBackup() {
    if (!confirm('This feature currently tries to make a group file, and it may not work depending on the size of the memory contents. It will be improved soon. Continue anyway?')) {
        return;
    }
    setButtonLoading(els.btnReceiveBackup, true);
    try {
        await authorizeDevice();
        const module = await initModule();
        const handle = await ensureHandle();
        if (!module.FS.analyzePath('/downloads').exists) {
            module.FS.mkdir('/downloads');
        }
        const target = '/downloads/backup.8xg';
        const result = await ccallAsync(module, 'calc_recv_backup', 'number', ['number', 'string'], [handle, target], { timeoutMs: PROGRESS_IDLE_TIMEOUT_MS, useProgress: true });
        if (result !== 0) {
            log(`Backup failed (${formatErrorResult(module, result)}).`);
            return;
        }
        await downloadLastReceived(module, 'backup.8xg');
        log('Backup received.');
    } catch (err) {
        logError(err, 'Receive backup failed');
    } finally {
        setButtonLoading(els.btnReceiveBackup, false);
    }
}

async function receiveOs() {
    setButtonLoading(els.btnReceiveOs, true);
    try {
        if (!isNspireActive()) {
            log('OS receive is only supported on TI-Nspire calculators.');
            return;
        }
        await authorizeDevice();
        const module = await initModule();
        const handle = await ensureHandle();
        if (!module.FS.analyzePath('/downloads').exists) {
            module.FS.mkdir('/downloads');
        }
        const notice = [
            'This will receive the TI-Nspire OS from the calculator. It should take a few minutes.',
            'You will then be prompted to save the OS file on your computer.',
            'To begin the process, on your Nspire, press [on] then [2] then [menu] then [A] ("Send OS").',
            'Once done, confirm here / press OK to continue.'
        ].join('\n');
        if (!confirm(notice)) {
            return;
        }
        state.nspireOsReceiveStarted = true;
        updateNspireOsButtons(true, (state.features & FEATURE_FLAGS.OPS_ROMDUMP) !== 0);
        const extension = getNspireOsExtensionFromModule(module);
        const baseName = 'ti-nspire-os';
        const targetName = extension ? `${baseName}.${extension}` : 'ti-nspire-os.tnc';
        const target = `/downloads/${targetName}`;
        state.partialOsPath = target;
        const result = await ccallAsync(module, 'calc_recv_os', 'number', ['number', 'string'], [handle, target], { timeoutMs: null, useProgress: true });
        if (result !== 0) {
            log(`OS receive failed (${formatErrorResult(module, result)}).`);
            return;
        }
        await downloadLastReceived(module, 'ti-nspire-os.tnc');
        log('OS received as .tnc.');
    } catch (err) {
        logError(err, 'Receive OS failed');
    } finally {
        setButtonLoading(els.btnReceiveOs, false);
    }
}

async function downloadPartialOs() {
    setButtonLoading(els.btnDownloadOsPartial, true);
    try {
        const module = await initModule();
        const path = state.partialOsPath || '/downloads/ti-nspire-os.tnc';
        if (!module.FS.analyzePath(path).exists) {
            log('No partial OS file found yet.');
            return;
        }
        const data = module.FS.readFile(path);
        const name = path.split('/').pop() || 'ti-nspire-os.tnc';
        triggerDownload(name, data);
        log('Downloaded the current OS image.');
    } catch (err) {
        logError(err, 'Download OS so far failed');
    } finally {
        setButtonLoading(els.btnDownloadOsPartial, false);
    }
}

async function dumpRom() {
    setButtonLoading(els.btnDumpRom, true);
    const notice = [
        'ROM contents are copyrighted by Texas Instruments.',
        'You are not allowed to copy and/or distribute ROM images.',
        'Proceed only if you understand the legal restrictions.',
        '',
        'This will send a dumper program to the calculator and then read back the ROM.',
        'Continue?'
    ].join('\n');
    if (!confirm(notice)) {
        setButtonLoading(els.btnDumpRom, false);
        return;
    }

    try {
        await authorizeDevice();
        const module = await initModule();
        const handle = await ensureHandle();
        if (!module.FS.analyzePath('/downloads').exists) {
            module.FS.mkdir('/downloads');
        }

        log('Sending ROM dumper...');
        let result = await ccallAsync(module, 'calc_dump_rom_1', 'number', ['number'], [handle], { timeoutMs: 30000, useProgress: true });
        if (result !== 0) {
            log(`ROM dump step 1 failed (${formatErrorResult(module, result)}).`);
            return;
        }

        log('Receiving ROM image...');
        const target = '/downloads/romdump.bin';
        result = await ccallAsync(module, 'calc_dump_rom_2', 'number', ['number', 'number', 'string'], [handle, 0, target], { timeoutMs: null, useProgress: true });
        if (result !== 0) {
            log(`ROM dump step 2 failed (${formatErrorResult(module, result)}).`);
            return;
        }
        await downloadLastReceived(module, (state.authorizedDevice?.productName ?? 'ti-calculator') + '_dump.rom');
        log('ROM dump completed.');
    } catch (err) {
        logError(err, 'ROM dump failed');
    } finally {
        setButtonLoading(els.btnDumpRom, false);
    }
}
async function receiveSelected() {
    const selections = getSelectedVarInputs()
        .map(input => ({
            name: input.dataset.name,
            folder: input.dataset.folder,
            type: Number(input.dataset.type),
            kind: input.dataset.kind
        }));
    if (!selections.length) {
        log('No variables selected.');
        return;
    }
    setButtonLoading(els.btnRecvSelected, true);
    try {
        await authorizeDevice();
        const module = await initModule();
        const handle = await ensureHandle();
        let receivedAny = false;
        if (!module.FS.analyzePath('/downloads').exists) {
            module.FS.mkdir('/downloads');
        }
        for (const entry of selections) {
            const result = entry.kind === 'app'
                ? await ccallAsync(module, 'calc_recv_app', 'number', ['number', 'string', 'number', 'string'], [handle, entry.name, entry.type, '/downloads'], { timeoutMs: PROGRESS_IDLE_TIMEOUT_MS, useProgress: true })
                : await ccallAsync(module, 'calc_recv_var', 'number', ['number', 'string', 'string', 'number', 'string'], [handle, entry.folder, entry.name, entry.type, '/downloads'], { timeoutMs: PROGRESS_IDLE_TIMEOUT_MS, useProgress: true });
            if (result === 0) {
                await downloadLastReceived(module);
                log(`Received ${entry.name}.`);
                receivedAny = true;
            } else {
                log(`Failed to receive ${entry.name} (${formatErrorResult(module, result)}).`);
            }
        }
        if (receivedAny) {
            await silentReconnectAfterNspireTransfer();
        }
    } catch (err) {
        logError(err, 'Receive selected failed');
    } finally {
        setButtonLoading(els.btnRecvSelected, false);
    }
}

async function deleteSelected() {
    const selections = getSelectedVarInputs()
        .map(input => ({
            name: input.dataset.name,
            folder: input.dataset.folder,
            type: Number(input.dataset.type)
        }));
    if (!selections.length) {
        log('No variables selected.');
        return;
    }
    if (!confirm(`Delete ${selections.length} item(s) from the calculator?`)) {
        return;
    }
    setButtonLoading(els.btnDeleteSelected, true);
    try {
        await authorizeDevice();
        const module = await initModule();
        const handle = await ensureHandle();
        for (const entry of selections) {
            const result = await ccallAsync(module, 'calc_del_var', 'number', ['number', 'string', 'string', 'number'], [handle, entry.folder, entry.name, entry.type], { timeoutMs: PROGRESS_IDLE_TIMEOUT_MS, useProgress: true });
            if (result === 0) {
                log(`Deleted ${entry.name}.`);
            } else {
                log(`Failed to delete ${entry.name} (${formatErrorResult(module, result)}).`);
            }
        }
        await refreshDirlist();
    } catch (err) {
        logError(err, 'Delete selected failed');
    } finally {
        setButtonLoading(els.btnDeleteSelected, false);
    }
}

async function takeScreenshot() {
    setButtonLoading(els.btnScreenshot, true);
    try {
        await authorizeDevice();
        const module = await initModule();
        const handle = await ensureHandle();
        const result = await ccallAsync(module, 'calc_screenshot', 'number', ['number'], [handle], { timeoutMs: PROGRESS_IDLE_TIMEOUT_MS, useProgress: true });
        if (result !== 0) {
            log(`Screenshot error (${formatErrorResult(module, result)}).`);
            return;
        }
        const data = module.FS.readFile('/screenshot.bin');
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const width = view.getUint32(0, true);
        const height = view.getUint32(4, true);
        const rgb = data.subarray(8);
        const canvas = els.screenshotCanvas;
        const ctx = canvas.getContext('2d');
        const imageData = ctx.createImageData(width, height);
        for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
            imageData.data[j] = rgb[i];
            imageData.data[j + 1] = rgb[i + 1];
            imageData.data[j + 2] = rgb[i + 2];
            imageData.data[j + 3] = 255;
        }
        canvas.width = width;
        canvas.height = height;
        ctx.putImageData(imageData, 0, 0);
        els.screenshotCanvas.classList.add('filled');
        updateScreenshotCanvasScale();
        log(`Screenshot captured (${width}x${height}).`);
        try {
            module.FS.unlink('/screenshot.bin');
        } catch (cleanupErr) {
            console.warn(cleanupErr);
        }
    } catch (err) {
        logError(err, 'Screenshot failed');
    } finally {
        setButtonLoading(els.btnScreenshot, false);
    }
}

function downloadCanvas() {
    setButtonLoading(els.btnDownloadScreenshot, true);
    const canvas = els.screenshotCanvas;
    if (!canvas.width || !canvas.height) {
        log('No screenshot to download.');
        setButtonLoading(els.btnDownloadScreenshot, false);
        return;
    }
    const link = document.createElement('a');
    link.download = 'screenshot.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
    setButtonLoading(els.btnDownloadScreenshot, false);
}

async function downloadLastReceived(module, fallbackName) {
    let filename = fallbackName || 'download.bin';
    try {
        const lastPath = module.FS.readFile('/last_recv_path.txt', { encoding: 'utf8' }).trim();
        if (lastPath) {
            filename = lastPath.split('/').pop();
            const data = module.FS.readFile(lastPath);
            triggerDownload(filename, data);
            module.FS.unlink(lastPath);
            return;
        }
    } catch (err) {
        console.warn(err);
    }
    log('No received file found to download.');
}

function triggerDownload(filename, data) {
    const blob = new Blob([data], { type: 'application/octet-stream' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
}

function clearLog() {
    setButtonLoading(els.btnClearLog, true);
    state.logLines = [];
    els.log.textContent = '';
    setButtonLoading(els.btnClearLog, false);
}

async function nukeConnection() {
    if (els.btnNuke) {
        setButtonLoading(els.btnNuke, true);
    }
    clearActiveOperations('Operation cancelled by emergency reset.');
    try {
        await state.authorizedDevice?.reset();
    } catch (err) {
        console.warn('[WebTILP] Emergency reset failed', err);
    }
    try {
        if (state.module) {
            try {
                state.module._notify_usb_disconnect();
            } catch (err) {
                console.warn('[WebTILP] Failed to reset USB state', err);
            }
        }
    } finally {
        state.handle = 0;
        state.module = null;
        state.cableOpen = false;
        state.authorizedDevice = null;
        state.connectInProgress = false;
        state.handlePromise = null;
        state.needsReauthorize = false;
        state.silentReconnectInProgress = false;
        clearDeviceData();
        setConnected(false);
        setStatus('Disconnected', false);
        log('Device disconnected.');
    }
    if (els.btnNuke) {
        setButtonLoading(els.btnNuke, false);
    }
    await connect();
}

async function silentReconnectAfterNspireTransfer() {
    if (!isNspireActive() || state.silentReconnectInProgress) {
        return;
    }
    state.silentReconnectInProgress = true;
    try {
        clearActiveOperations();
        setStatus('Select device to continue', false);
        await state.authorizedDevice?.reset();
    } catch (err) {
        console.warn('[WebTILP] Silent reconnect reset failed', err);
    }
    try {
        if (state.module) {
            try {
                state.module._notify_usb_disconnect();
            } catch (err) {
                console.warn('[WebTILP] Silent reconnect notify failed', err);
            }
        }
        state.handle = 0;
        state.cableOpen = false;
        state.authorizedDevice = null;
        state.connectInProgress = false;
        state.handlePromise = null;
        state.needsReauthorize = true;
    } catch (err) {
        logError(err, 'Silent reconnect failed');
    } finally {
        // cleared after successful reauthorization
    }
}


function bindEvents() {
    els.btnConnect.addEventListener('click', connect);
    if (els.btnNuke) {
        els.btnNuke.addEventListener('click', nukeConnection);
    }
    els.btnSettings.addEventListener('click', openSettingsModal);
    els.btnCloseSettings.addEventListener('click', closeSettingsModal);
    els.btnSaveSettings.addEventListener('click', saveSettingsFromModal);
    els.btnResetSettings.addEventListener('click', resetSettings);
    els.settingCableModel.addEventListener('change', () => {
        const selected = els.settingCalcModel.value;
        const options = getCalcOptionsForCable(els.settingCableModel.value);
        populateSelect(els.settingCalcModel, options);
        updateCalcHint(els.settingCableModel.value);
        if (options.some(option => String(option.value) === selected)) {
            els.settingCalcModel.value = selected;
        } else {
            els.settingCalcModel.value = options.find(option => option.value !== 'auto')?.value ?? 'auto';
        }
    });
    els.settingsModal.addEventListener('click', event => {
        if (event.target === els.settingsModal) {
            closeSettingsModal();
        }
    });
    els.btnIsReady.addEventListener('click', isReady);
    els.btnGetInfo.addEventListener('click', getDeviceInfo);
    els.btnSyncClock.addEventListener('click', syncClock);
    els.btnRefreshDirlist.addEventListener('click', refreshDirlist);
    els.btnSendFiles.addEventListener('click', sendSelectedFiles);
    els.btnReceiveBackup.addEventListener('click', receiveBackup);
    els.btnReceiveOs.addEventListener('click', receiveOs);
    els.btnDownloadOsPartial.addEventListener('click', downloadPartialOs);
    els.btnDumpRom.addEventListener('click', dumpRom);
    els.btnRecvSelected.addEventListener('click', receiveSelected);
    els.btnDeleteSelected.addEventListener('click', deleteSelected);
    els.btnScreenshot.addEventListener('click', takeScreenshot);
    els.btnDownloadScreenshot.addEventListener('click', downloadCanvas);
    els.btnClearLog.addEventListener('click', clearLog);
    if (els.btnSendKey) {
        els.btnSendKey.addEventListener('click', () => sendKey(els.keyCodeInput?.value));
    }
    if (els.keyCodeInput) {
        els.keyCodeInput.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                sendKey(els.keyCodeInput.value);
            }
        });
    }
    document.querySelectorAll('.key-quick').forEach(button => {
        button.addEventListener('click', () => sendKey(button.dataset.key));
    });
    if (els.btnThemeToggle) {
        els.btnThemeToggle.addEventListener('click', cycleTheme);
    }
    if (els.btnSplashConnect) {
        els.btnSplashConnect.addEventListener('click', connect);
    }
    els.filterInput.addEventListener('input', () => renderDirlist(state.dirlist));
    els.btnToggleView.addEventListener('click', () => {
        const selectedKeys = getSelectedVarKeys();
        state.treeView = !state.treeView;
        els.btnToggleView.textContent = state.treeView ? '📋 Table View' : '🗂️ Tree View';
        els.tableView.classList.toggle('hidden', state.treeView);
        els.treeView.classList.toggle('hidden', !state.treeView);
        renderDirlist(state.dirlist);
        if (state.treeView) {
            applySelectionKeys(selectedKeys, els.treeView);
        } else {
            applySelectionKeys(selectedKeys, els.varTableBody);
        }
        updateSelectionActionButtons();
    });
    document.querySelectorAll('th[data-sort]').forEach(header => {
        header.addEventListener('click', () => {
            const key = header.dataset.sort;
            if (state.sort.key === key) {
                state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
            } else {
                state.sort.key = key;
                state.sort.dir = 'asc';
            }
            document.querySelectorAll('th[data-sort]').forEach(th => th.classList.remove('sorted-asc', 'sorted-desc'));
            header.classList.add(state.sort.dir === 'asc' ? 'sorted-asc' : 'sorted-desc');
            renderDirlist(state.dirlist);
        });
    });
    els.fileInput.addEventListener('change', () => {
        setSelectedFiles(els.fileInput.files, 'file picker');
    });
    const dropzone = document.getElementById('dropzone');
    const dropzoneDragEnter = (event) => {
        if (hasFileDrag(event)) {
            event.preventDefault();
            setDropzoneActive(true);
        }
    };
    const dropzoneDragOver = (event) => {
        if (hasFileDrag(event)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            setDropzoneActive(true);
        }
    };
    const dropzoneDragLeave = (event) => {
        if (dropzone && event.relatedTarget && dropzone.contains(event.relatedTarget)) {
            return;
        }
        setDropzoneActive(false);
    };
    const dropzoneDrop = (event) => {
        event.preventDefault();
        const files = getDroppedFiles(event);
        if (!files.length) {
            return;
        }
        setDropzoneActive(false);
        setSelectedFiles(files, 'drop');
    };
    dropzone.addEventListener('dragenter', dropzoneDragEnter);
    dropzone.addEventListener('dragover', dropzoneDragOver);
    dropzone.addEventListener('dragleave', dropzoneDragLeave);
    dropzone.addEventListener('drop', dropzoneDrop);
    els.fileInput.addEventListener('dragenter', dropzoneDragEnter);
    els.fileInput.addEventListener('dragover', dropzoneDragOver);
    els.fileInput.addEventListener('dragleave', dropzoneDragLeave);
    els.fileInput.addEventListener('drop', dropzoneDrop);
    els.varTableBody.addEventListener('click', event => {
        const checkbox = event.target.closest('input[type="checkbox"]');
        if (checkbox) {
            updateSelectionActionButtons();
            return;
        }
        const row = event.target.closest('tr');
        if (!row) {
            return;
        }
        const target = row.querySelector('input[type="checkbox"]');
        if (!target || target.disabled) {
            return;
        }
        target.checked = !target.checked;
        updateSelectionActionButtons();
    });
    els.varTableBody.addEventListener('change', event => {
        if (event.target && event.target.matches('input[type="checkbox"]')) {
            updateSelectionActionButtons();
        }
    });
    els.treeView.addEventListener('click', event => {
        const checkbox = event.target.closest('input[type="checkbox"]');
        if (checkbox) {
            updateSelectionActionButtons();
            return;
        }
        const node = event.target.closest('.tree-node');
        if (!node) {
            return;
        }
        const target = node.querySelector('input[type="checkbox"]');
        if (!target || target.disabled) {
            return;
        }
        target.checked = !target.checked;
        updateSelectionActionButtons();
    });
    els.treeView.addEventListener('change', event => {
        if (event.target && event.target.matches('input[type="checkbox"]')) {
            updateSelectionActionButtons();
        }
    });
    els.tableView.addEventListener('dragenter', event => {
        if (event.dataTransfer && event.dataTransfer.types.includes('Files')) {
            event.preventDefault();
        }
    });
    els.tableView.addEventListener('dragover', event => {
        if (event.dataTransfer && event.dataTransfer.types.includes('Files')) {
            event.preventDefault();
            const row = event.target.closest('tr');
            setDropHighlight(row);
        }
    });
    els.tableView.addEventListener('dragleave', () => {
        clearDropHighlight();
    });
    els.tableView.addEventListener('drop', event => {
        event.preventDefault();
        const files = getDroppedFiles(event);
        if (!files.length) {
            return;
        }
        clearDropHighlight();
        const row = event.target.closest('tr');
        const folder = row ? (row.dataset.folderTarget || '') : '';
        sendDroppedFiles(files, folder);
    });
    els.treeView.addEventListener('dragenter', event => {
        if (event.dataTransfer && event.dataTransfer.types.includes('Files')) {
            event.preventDefault();
        }
    });
    els.treeView.addEventListener('dragover', event => {
        if (event.dataTransfer && event.dataTransfer.types.includes('Files')) {
            event.preventDefault();
            const node = event.target.closest('.tree-node');
            setDropHighlight(node);
        }
    });
    els.treeView.addEventListener('dragleave', () => {
        clearDropHighlight();
    });
    els.treeView.addEventListener('drop', event => {
        event.preventDefault();
        const files = getDroppedFiles(event);
        if (!files.length) {
            return;
        }
        clearDropHighlight();
        const folderNode = event.target.closest('[data-folder-path]');
        const folder = folderNode ? folderNode.dataset.folderPath || '' : '';
        sendDroppedFiles(files, folder);
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !els.settingsModal.classList.contains('hidden')) {
            closeSettingsModal();
        }
    });
}

initTheme();
bindEvents();
seedSettingsForm();
updateSendFilesButtonState();
updateSelectionActionButtons();
updateKeyControlsState(false);
updateWebUsbSplashState();
autoConnectIfAuthorized();
window.addEventListener('resize', updateScreenshotCanvasScale);
if (navigator.usb) {
    navigator.usb.addEventListener('disconnect', () => {
        const silent = state.silentReconnectInProgress;
        if (!silent) {
            clearActiveOperations('Active operation cancelled due to disconnect.');
        }
        if (state.module) {
            try {
                state.module._notify_usb_disconnect();
            } catch (err) {
                console.warn('[WebTILP] Failed to reset USB state', err);
            }
        }
        state.handle = 0;
        state.cableOpen = false;
        state.authorizedDevice = null;
        state.connectInProgress = false;
        if (!silent) {
            state.module = null;
            state.nspireOsReceiveStarted = false;
            updateNspireOsButtons(false, false);
            setConnected(false);
            setStatus('Disconnected', false);
            log('Device disconnected.');
        }
    });
    navigator.usb.addEventListener('connect', () => {
        if (state.silentReconnectInProgress) {
            return;
        }
        state.handle = 0;
        state.module = null;
        state.cableOpen = false;
        state.authorizedDevice = null;
        state.connectInProgress = false;
        setConnected(false);
        setStatus('Device connected', false);
        log('Device connected. Reinitialize to use it.');
        clearDeviceData();
    });
}
if (!navigator.usb) {
    setStatus('WebUSB unsupported', false);
    log('WebUSB is not available in this browser. Only Chrome and derivatives are supported.');
} else if (!self.isSecureContext) {
    setStatus('Insecure context', false);
    log('WebUSB requires HTTPS or localhost.');
} else {
    setStatus('Idle', false);
}
