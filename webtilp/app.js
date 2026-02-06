/* global TILibsModule */

const state = {
    module: null,
    handle: 0,
    connected: false,
    cableOpen: false,
    authorizedDevice: null,
    deviceModelName: '',
    deviceInfoProductName: '',
    deviceInfoEntries: [],
    features: 0,
    dirlist: [],
    selectedFiles: [],
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

let currentDropTarget = null;
let stickyHideThreshold = null;
let stickyVisible = false;
let dropzoneActive = false;
let stickyUpdateScheduled = false;
let lastDropTs = 0;

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

const TIG_MODE = {
    NONE: 0,
    RAM: 1 << 0,
    ARCHIVE: 1 << 1,
    FLASH: 1 << 2
};

const CCALL_TIMEOUT_MS = 12000;
const CCALL_MIN_GAP_MS = 100;
const CREATE_HANDLE_RETRY_DELAY_MS = 300;
const PROGRESS_IDLE_TIMEOUT_MS = 5000;
const AUTO_QUERY_DELAY_MS = 500;

const ERROR_CODE_FALLBACKS = new Map([
    [257, 'Calculator not ready'],
    [269, 'Device is busy'],
    [3, 'Read error'],
    [4, 'Read timeout'],
    [5, 'Write error'],
    [6, 'Write timeout']
]);

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isErrorMessage(message) {
    if (!message) {
        return false;
    }
    const text = String(message).toLowerCase();
    if (text.startsWith('error:') || text.startsWith('failed')) {
        return true;
    }
    return text.includes('(error') || text.includes('error ') || text.includes('failed');
}

function showToast(message, type = 'error') {
    if (!els.toastContainer) {
        return;
    }
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const title = type === 'error' ? 'Error' : 'Notice';
    const titleEl = document.createElement('div');
    titleEl.className = 'toast-title';
    titleEl.textContent = title;
    const messageEl = document.createElement('div');
    messageEl.textContent = message;
    toast.appendChild(titleEl);
    toast.appendChild(messageEl);
    els.toastContainer.appendChild(toast);
    requestAnimationFrame(() => {
        toast.classList.add('show');
    });
    const timeout = type === 'error' ? 6000 : 4000;
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 250);
    }, timeout);
}

function getFallbackErrorMessage(code) {
    return ERROR_CODE_FALLBACKS.get(code) || '';
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
    if (code === null || code === undefined || Number.isNaN(Number(code))) {
        return 'error (unknown)';
    }
    const numericCode = Number(code);
    const message = getErrorMessage(module, code);
    let raw = 0;
    if (module) {
        try {
            raw = module._get_raw_protocol_code(numericCode);
        } catch (err) {
            console.warn('[WebTILP] Failed to resolve raw protocol code', err);
            raw = 0;
        }
    }
    const label = raw ? `0x${raw.toString(16).toUpperCase().padStart(4, '0')}` : `${numericCode}`;
    if (!message) {
        const fallback = getFallbackErrorMessage(numericCode);
        return fallback ? `error ${label}: ${fallback}` : `error ${label}`;
    }
    const firstLine = message.split('\n').map(line => line.trim()).find(Boolean) || message;
    const cleaned = firstLine.replace(/^Msg:\s*/i, '');
    return `error ${label}: ${cleaned}`;
}

function isAcceptableLeaveExamModeDiscError(err) {
    const text = String(err?.message || err || '').toLowerCase();
    return text.includes('device was disconnected')
        || text.includes('failed to execute')
        || text.includes('transfer error')
        || text.includes('memory access out of bounds')
        || text.includes('runtimeerror');
}

function isFatalWasmRuntimeError(err) {
    const text = String(err?.message || err || '').toLowerCase();
    return text.includes('memory access out of bounds')
        || text.includes('cannot use deleted val')
        || (text.includes('runtimeerror') && text.includes('wasm'));
}

function handleFatalWasmRuntimeError(err) {
    console.error('[WebTILP] Fatal WASM runtime error', err);
    clearActiveOperations();
    // Do not call back into WASM after a fatal runtime error.
    state.module = null;
    state.handle = 0;
    state.cableOpen = false;
    state.handlePromise = null;
    state.connectInProgress = false;
    state.silentReconnectInProgress = false;
    setConnected(false);
    setStatus('Connection lost', false);
    log('Connection lost due to calculator reset/disconnect. Please reconnect.');
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
 * @param {{timeoutMs?: number|null, useProgress?: boolean, progressLabel?: string}} options
 * @returns {Promise<T>}
 */
async function ccallAsync(module, name, returnType, argTypes, args, options = {}) {
    const opEpoch = state.operationEpoch;
    const throwIfCancelled = () => {
        if (opEpoch !== state.operationEpoch) {
            const err = new Error('Operation cancelled due to disconnect.');
            err.silent = true;
            throw err;
        }
    };
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
    const progressLabel = options.progressLabel || name;
    state.lastProgressTs = Date.now();
    let result;
    try {
        result = module.ccall(name, returnType, argTypes, args, { async: true });
    } catch (err) {
        if (isFatalWasmRuntimeError(err)) {
            handleFatalWasmRuntimeError(err);
        }
        throw err;
    }
    if (!useProgress) {
        try {
            const value = await withTimeout(result, name, timeoutMs);
            throwIfCancelled();
            return value;
        } catch (err) {
            throwIfCancelled();
            if (isFatalWasmRuntimeError(err)) {
                handleFatalWasmRuntimeError(err);
            }
            throw err;
        }
    }
    startProgress(progressLabel);
    try {
        const value = await withProgressTimeout(result, progressLabel, timeoutMs);
        throwIfCancelled();
        return value;
    } catch (err) {
        throwIfCancelled();
        if (isFatalWasmRuntimeError(err)) {
            handleFatalWasmRuntimeError(err);
        }
        throw err;
    } finally {
        stopProgress(progressLabel);
    }
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
const TI89_PIDS = new Set([0xE004]);

const KEYMAP_8X_ = {
    "Right": 0x01,
    "Left": 0x02,
    "Up": 0x03,
    "Down": 0x04,
    "Enter": 0x05,
    "AlphaEnter": 0x06,
    "AlphaUp": 0x07,
    "AlphaDown": 0x08,
    "Clear": 0x09,
    "Del": 0x0A,
    "Ins": 0x0B,
    "Recall": 0x0C,
    "LastEnt": 0x0D,
    "BOL": 0x0E,
    "EOL": 0x0F,
    "SelAll": 0x10,
    "UnselAll": 0x11,
    "LtoTI82": 0x12,
    "Backup": 0x13,
    "Recieve": 0x14,
    "LnkQuit": 0x15,
    "Trans": 0x16,
    "Rename": 0x17,
    "Overw": 0x18,
    "Omit": 0x19,
    "Cont": 0x1A,
    "SendID": 0x1B,
    "SendSW": 0x1C,
    "Yes": 0x1D,
    "NoWay": 0x1E,
    "vSendType": 0x1F,
    "OverWAll": 0x20,
    "No": 0x25,
    "KReset": 0x26,
    "App": 0x27,
    "Doug": 0x28,
    "Listflag": 0x29,
    "enuStart": 0x2B,
    "AreYouSure": 0x2B,
    "AppsMenu": 0x2C,
    "Prgm": 0x2D,
    "Zoom": 0x2E,
    "Draw": 0x2F,
    "SPlot": 0x30,
    "Stat": 0x31,
    "Math": 0x32,
    "Test": 0x33,
    "Char": 0x34,
    "Vars": 0x35,
    "Mem": 0x36,
    "Matrix": 0x37,
    "Dist": 0x38,
    "Angle": 0x39,
    "List": 0x3A,
    "Calc": 0x3B,
    "Fin": 0x3C,
    "enuEnd": 0x3C,
    "Catalog": 0x3E,
    "InputDone": 0x3F,
    "Off": 0x3F,
    "Quit": 0x40,
    "LinkIO": 0x41,
    "MatrixEd": 0x42,
    "StatEd": 0x43,
    "Graph": 0x44,
    "Mode": 0x45,
    "PrgmEd": 0x46,
    "PrgmCr": 0x47,
    "Window": 0x48,
    "Yequ": 0x49,
    "Table": 0x4A,
    "TblSet": 0x4B,
    "ChkRAM": 0x4C,
    "DelMem": 0x4D,
    "ResetMem": 0x4E,
    "ResetDef": 0x4F,
    "PrgmInput": 0x50,
    "ZFactEd": 0x51,
    "Error": 0x52,
    "SolveTVM": 0x53,
    "SolveRoot": 0x54,
    "StatP": 0x55,
    "InfStat": 0x56,
    "Format": 0x57,
    "ExtApps": 0x58,
    "NewApps": 0x59,

    "Trace": 0x5A,
    "ZFit": 0x5B,
    "ZIn": 0x5C,
    "ZOut": 0x5D,
    "ZPrev": 0x5E,
    "Box": 0x5F,
    "Decml": 0x60,
    "SetZm": 0x61,
    "Squar": 0x62,
    "Std": 0x63,
    "Trig": 0x64,
    "UsrZm": 0x65,
    "ZSto": 0x66,
    "ZInt": 0x67,
    "ZStat": 0x68,

    "Select": 0x69,
    "Circl": 0x6A,
    "ClDrw": 0x6B,
    "Line": 0x6C,
    "Pen": 0x6D,
    "PtChg": 0x6E,
    "PtOff": 0x6F,
    "PtOn": 0x70,
    "Vert": 0x71,
    "Horiz": 0x72,
    "Text": 0x73,
    "TanLn": 0x74,
    "Eval": 0x75,
    "Inters": 0x76,
    "DYDX": 0x77,
    "FnIntg": 0x78,
    "RootG": 0x79,
    "DYDT": 0x7A,
    "DXDT": 0x7B,
    "DRDo": 0x7C,
    "GFMin": 0x7D,
    "GFMax": 0x7E,

    "ListName": 0x7F,
    "Add": 0x80,
    "Sub": 0x81,
    "Mul": 0x82,
    "Div": 0x83,
    "Expon": 0x84,
    "LParen": 0x85,
    "RParen": 0x86,
    "LBrack": 0x87,
    "RBrack": 0x88,
    "Shade": 0x89,
    "Store": 0x8A,
    "Comma": 0x8B,
    "Chs": 0x8C,
    "DecPnt": 0x8D,
    "0": 0x8E,
    "1": 0x8F,
    "2": 0x90,
    "3": 0x91,
    "4": 0x92,
    "5": 0x93,
    "6": 0x94,
    "7": 0x95,
    "8": 0x96,
    "9": 0x97,
    "EE": 0x98,
    "Space": 0x99,
    "CapA": 0x9A,
    "CapB": 0x9B,
    "CapC": 0x9C,
    "CapD": 0x9D,
    "CapE": 0x9E,
    "CapF": 0x9F,
    "CapG": 0xA0,
    "CapH": 0xA1,
    "CapI": 0xA2,
    "CapJ": 0xA3,
    "CapK": 0xA4,
    "CapL": 0xA5,
    "CapM": 0xA6,
    "CapN": 0xA7,
    "CapO": 0xA8,
    "CapP": 0xA9,
    "CapQ": 0xAA,
    "CapR": 0xAB,
    "CapS": 0xAC,
    "CapT": 0xAD,
    "CapU": 0xAE,
    "CapV": 0xAF,
    "CapW": 0xB0,
    "CapX": 0xB1,
    "CapY": 0xB2,
    "CapZ": 0xB3,
    "Varx": 0xB4,
    "Pi": 0xB5,
    "Inv": 0xB6,
    "Sin": 0xB7,
    "ASin": 0xB8,
    "Cos": 0xB9,
    "ACos": 0xBA,
    "Tan": 0xBB,
    "ATan": 0xBC,
    "Square": 0xBD,
    "Sqrt": 0xBE,
    "Ln": 0xBF,
    "Exp": 0xC0,
    "Log": 0xC1,
    "ALog": 0xC2,
    "ToABC": 0xC3,
    "ClrTbl": 0xC4,
    "Ans": 0xC5,
    "Colon": 0xC6,
    "NDeriv": 0xC7,
    "FnInt": 0xC8,
    "Root": 0xC9,
    "Quest": 0xCA,
    "Quote": 0xCB,
    "Theta": 0xCC,
    "If": 0xCD,
    "Then": 0xCE,
    "Else": 0xCF,
    "For": 0xD0,
    "While": 0xD1,
    "Repeat": 0xD2,
    "End": 0xD3,
    "Pause": 0xD4,
    "Lbl": 0xD5,
    "Goto": 0xD6,
    "ISG": 0xD7,
    "DSL": 0xD8,
    "Menu": 0xD9,
    "Exec": 0xDA,
    "Return": 0xDB,
    "Stop": 0xDC,
    "Input": 0xDD,
    "Prompt": 0xDE,
    "Disp": 0xDF,
    "DispG": 0xE0,
    "DispT": 0xE1,
    "Output": 0xE2,
    "GetKey": 0xE3,
    "ClrHome": 0xE4,
    "PrtScr": 0xE5,
    "SinH": 0xE6,
    "CosH": 0xE7,
    "TanH": 0xE8,
    "ASinH": 0xE9,
    "ACosH": 0xEA,
    "ATanH": 0xEB,
    "LBrace": 0xEC,
    "RBrace": 0xED,
    "I": 0xEE,
    "CONSTeA": 0xEF,
    "Plot3": 0xF0,
    "FMin": 0xF1,
    "FMax": 0xF2,
    "L1A": 0xF3,
    "L2A": 0xF4,
    "L3A": 0xF5,
    "L4A": 0xF6,
    "L5A": 0xF7,
    "L6A": 0xF8,
    "unA": 0xF9,
    "vnA": 0xFA,
    "wnA": 0xFB,
    "DrawInv": 0xFE00,
    "DrawF": 0xFE01,
    "PixelOn": 0xFE02,
    "PixelOff": 0xFE03,
    "PxlTest": 0xFE04,
    "RCGDB": 0xFE05,
    "RCPic": 0xFE06,
    "STGDB": 0xFE07,
    "STPic": 0xFE08,
    "Abs": 0xFE09,
    "TEqu": 0xFE0A,
    "TNoteQ": 0xFE0B,
    "TGT": 0xFE0C,
    "TGTE": 0xFE0D,
    "TLT": 0xFE0E,
    "TLTE": 0xFE0F,
    "And": 0xFE10,
    "Or": 0xFE11,
    "Xor": 0xFE12,
    "Not": 0xFE13,
    "LR1": 0xFE14,
    "XRoot": 0xFE15,
    "Cube": 0xFE16,
    "CbRt": 0xFE17,
    "ToDec": 0xFE18,
    "CubicR": 0xFE19,
    "QuartR": 0xFE1A,
    "Plot1": 0xFE1B,
    "Plot2": 0xFE1C,
    "Round": 0xFE1D,
    "IPart": 0xFE1E,
    "FPart": 0xFE1F,
    "Int": 0xFE20,
    "Rand": 0xFE21,
    "NPR": 0xFE22,
    "NCR": 0xFE23,
    "XFactorial": 0xFE24,
    "Rad": 0xFE25,
    "Degr": 0xFE26,
    "APost": 0xFE27,
    "ToDMS": 0xFE28,
    "RToPo": 0xFE29,
    "RToPr": 0xFE2A,
    "PToRx": 0xFE2B,
    "PToRy": 0xFE2C,
    "RowSwap": 0xFE2D,
    "RowPlus": 0xFE2E,
    "TimRow": 0xFE2F,
    "TRowP": 0xFE30,
    "SortA": 0xFE31,
    "SortD": 0xFE32,
    "Seq": 0xFE33,
    "Min": 0xFE34,
    "Max": 0xFE35,
    "Mean": 0xFE36,
    "Median": 0xFE37,
    "Sum": 0xFE38,
    "Prod": 0xFE39,
    "Det": 0xFE3A,
    "Transp": 0xFE3B,
    "Dim": 0xFE3C,
    "Fill": 0xFE3D,
    "Ident": 0xFE3E,
    "Randm": 0xFE3F,
    "Aug": 0xFE40,
    "OneVar": 0xFE41,
    "TwoVar": 0xFE42,
    "LR": 0xFE43,
    "LRExp": 0xFE44,
    "LRLn": 0xFE45,
    "LRPwr": 0xFE46,
    "MedMed": 0xFE47,
    "Quad": 0xFE48,
    "ClrLst": 0xFE49,
    "Hist": 0xFE4A,
    "xyLine": 0xFE4B,
    "Scatter": 0xFE4C,
    "mRad": 0xFE4D,
    "mDeg": 0xFE4E,
    "mNormF": 0xFE4F,
    "mSci": 0xFE50,
    "mEng": 0xFE51,
    "mFloat": 0xFE52,
    "Fix": 0xFE53,
    "SplitOn": 0xFE54,
    "FullScreen": 0xFE55,
    "Stndrd": 0xFE56,
    "Param": 0xFE57,
    "Polar": 0xFE58,
    "SeqG": 0xFE59,
    "AFillOn": 0xFE5A,
    "AFillOff": 0xFE5B,
    "ACalcOn": 0xFE5C,
    "ACalcOff": 0xFE5D,
    "FNOn": 0xFE5E,
    "FNOff": 0xFE5F,
    "PlotsOn": 0xFE60,
    "PlotsOff": 0xFE61,
    "PixelChg": 0xFE62,
    "SendMBL": 0xFE63,
    "RecvMBL": 0xFE64,
    "BoxPlot": 0xFE65,
    "BoxIcon": 0xFE66,
    "CrossIcon": 0xFE67,
    "DotIcon": 0xFE68,
    "Seqential": 0xFE69,
    "SimulG": 0xFE6A,
    "PolarG": 0xFE6B,
    "RectG": 0xFE6C,
    "CoordOn": 0xFE6D,
    "CoordOff": 0xFE6E,
    "DrawLine": 0xFE6F,
    "DrawDot": 0xFE70,
    "AxisOn": 0xFE71,
    "AxisOff": 0xFE72,
    "GridOn": 0xFE73,
    "GridOff": 0xFE74,
    "LblOn": 0xFE75,
    "LblOff": 0xFE76,
    "L1": 0xFE77,
    "L2": 0xFE78,
    "L3": 0xFE79,
    "L4": 0xFE7A,
    "L5": 0xFE7B,
    "L6": 0xFE7C,
    "GDB1": 0xFC00,
    "GDB2": 0xFC01,
    "GDB3": 0xFC02,
    "Y1": 0xFC03,
    "Y2": 0xFC04,
    "Y3": 0xFC05,
    "Y4": 0xFC06,
    "Y5": 0xFC07,
    "Y6": 0xFC08,
    "Y7": 0xFC09,
    "Y8": 0xFC0A,
    "Y9": 0xFC0B,
    "Y0": 0xFC0C,
    "X1T": 0xFC0D,
    "Y1T": 0xFC0E,
    "X2T": 0xFC0F,
    "Y2T": 0xFC10,
    "X3T": 0xFC11,
    "Y3T": 0xFC12,
    "X4T": 0xFC13,
    "Y4T": 0xFC14,
    "X5T": 0xFC15,
    "Y5T": 0xFC16,
    "X6T": 0xFC17,
    "Y6T": 0xFC18,
    "R1": 0xFC19,
    "R2": 0xFC1A,
    "R3": 0xFC1B,
    "R4": 0xFC1C,
    "R5": 0xFC1D,
    "R6": 0xFC1E,
    "GDB4": 0xFC1F,
    "GDB5": 0xFC20,
    "GDB6": 0xFC21,
    "Pic4": 0xFC22,
    "Pic5": 0xFC23,
    "Pic6": 0xFC24,
    "GDB7": 0xFC25,
    "GDB8": 0xFC26,
    "GDB9": 0xFC27,
    "GDB0": 0xFC28,
    "Pic7": 0xFC29,
    "Pic8": 0xFC2A,
    "Pic9": 0xFC2B,
    "Pic0": 0xFC2C,
    "StatN": 0xFC2D,
    "XMean": 0xFC2E,
    "Conj": 0xFC2F,
    "Real": 0xFC30,
    "FAngle": 0xFC31,
    "LCM": 0xFC32,
    "GCD": 0xFC33,
    "RandInt": 0xFC34,
    "RandNorm": 0xFC35,
    "ToPolar": 0xFC36,
    "ToRect": 0xFC37,
    "YMean": 0xFC38,
    "StdX": 0xFC39,
    "StdX1": 0xFC3A,
    "w0": 0xFC3B,
    "MatF": 0xFC3C,
    "MatG": 0xFC3D,
    "MatRH": 0xFC3E,
    "MatI": 0xFC3F,
    "MatJ": 0xFC40,
    "YMean1": 0xFC41,
    "StdY": 0xFC42,
    "StdY1": 0xFC43,
    "MatToLst": 0xFC44,
    "LstToMat": 0xFC45,
    "CumSum": 0xFC46,
    "DeltaLst": 0xFC47,
    "StdDev": 0xFC48,
    "Variance": 0xFC49,
    "Length": 0xFC4A,
    "EquToStrng": 0xFC4B,
    "StrngToEqu": 0xFC4C,
    "Expr": 0xFC4D,
    "SubStrng": 0xFC4E,
    "InStrng": 0xFC4F,
    "Str1": 0xFC50,
    "Str2": 0xFC51,
    "Str3": 0xFC52,
    "Str4": 0xFC53,
    "Str5": 0xFC54,
    "Str6": 0xFC55,
    "Str7": 0xFC56,
    "Str8": 0xFC57,
    "Str9": 0xFC58,
    "Str0": 0xFC59,
    "FinN": 0xFC5A,
    "FinI": 0xFC5B,
    "FinPV": 0xFC5C,
    "FinPMT": 0xFC5D,
    "FinFV": 0xFC5E,
    "FinPY": 0xFC5F,
    "FinCY": 0xFC60,
    "FinFPMT": 0xFC61,
    "FinFI": 0xFC62,
    "FinFPV": 0xFC63,
    "FinFN": 0xFC64,
    "FinFFV": 0xFC65,
    "FinNPV": 0xFC66,
    "FinIRR": 0xFC67,
    "FinBAL": 0xFC68,
    "FinPRN": 0xFC69,
    "FinINT": 0xFC6A,
    "SumX": 0xFC6B,
    "SumX2": 0xFC6C,
    "FinToNom": 0xFC6D,
    "FinToEff": 0xFC6E,
    "FinDBD": 0xFC6F,
    "StatVP": 0xFC70,
    "StatZ": 0xFC71,
    "StatT": 0xFC72,
    "StatChi": 0xFC73,
    "StatF": 0xFC74,
    "StatDF": 0xFC75,
    "StatPhat": 0xFC76,
    "StatPhat1": 0xFC77,
    "StatPhat2": 0xFC78,
    "StatMeanX1": 0xFC79,
    "StatMeanX2": 0xFC7A,
    "StatStdX1": 0xFC7B,
    "StatStdX2": 0xFC7C,
    "StatStdXP": 0xFC7D,
    "StatN1": 0xFC7E,
    "StatN2": 0xFC7F,
    "StatLower": 0xFC80,
    "StatUpper": 0xFC81,
    "uw0": 0xFC82,
    "Imag": 0xFC83,
    "SumY": 0xFC84,
    "Xres": 0xFC85,
    "Stat_s": 0xFC86,
    "SumY2": 0xFC87,
    "SumXY": 0xFC88,
    "uXres": 0xFC89,
    "ModBox": 0xFC8A,
    "NormProb": 0xFC8B,
    "NormalPDF": 0xFC8C,
    "TPDF": 0xFC8D,
    "ChiPDF": 0xFC8E,
    "FPDF": 0xFC8F,
    "MinY": 0xFC90,
    "RandBin": 0xFC91,
    "Ref": 0xFC92,
    "RRef": 0xFC93,
    "LRSqr": 0xFC94,
    "BRSqr": 0xFC95,
    "DiagOn": 0xFC96,
    "DiagOff": 0xFC97,
    "un1": 0xFC98,
    "vn1": 0xFC99,
    "Archive": 0xFC9A,
    "Unarchive": 0xFC9B,
    "Asm": 0xFC9C,
    "AsmPrgm": 0xFC9D,
    "AsmComp": 0xFC9E,
    "capAAcute": 0xFC9F,
    "capAGrave": 0xFCA0,
    "capACaret": 0xFCA1,
    "capADier": 0xFCA2,
    "aAcute": 0xFCA3,
    "aGrave": 0xFCA4,
    "aCaret": 0xFCA5,
    "aDier": 0xFCA6,
    "capEAcute": 0xFCA7,
    "capEGrave": 0xFCA8,
    "capECaret": 0xFCA9,
    "capEDier": 0xFCAA,
    "eAcute": 0xFCAB,
    "eGrave": 0xFCAC,
    "eCaret": 0xFCAD,
    "eDier": 0xFCAE,
    "capIAcute": 0xFCAF,
    "capIGrave": 0xFCB0,
    "capICaret": 0xFCB1,
    "capIDier": 0xFCB2,
    "iAcute": 0xFCB3,
    "iGrave": 0xFCB4,
    "iCaret": 0xFCB5,
    "iDier": 0xFCB6,
    "capOAcute": 0xFCB7,
    "capOGrave": 0xFCB8,
    "capOCaret": 0xFCB9,
    "capODier": 0xFCBA,
    "oAcute": 0xFCBB,
    "oGrave": 0xFCBC,
    "oCaret": 0xFCBD,
    "oDier": 0xFCBE,
    "capUAcute": 0xFCBF,
    "capUGrave": 0xFCC0,
    "capUCaret": 0xFCC1,
    "capUDier": 0xFCC2,
    "uAcute": 0xFCC3,
    "uGrave": 0xFCC4,
    "uCaret": 0xFCC5,
    "uDier": 0xFCC6,
    "capCCed": 0xFCC7,
    "cCed": 0xFCC8,
    "capNTilde": 0xFCC9,
    "nTilde": 0xFCCA,
    "accent": 0xFCCB,
    "grave": 0xFCCC,
    "dieresis": 0xFCCD,
    "quesDown": 0xFCCE,
    "exclamDown": 0xFCCF,
    "alpha": 0xFCD0,
    "beta": 0xFCD1,
    "gamma": 0xFCD2,
    "capDelta": 0xFCD3,
    "delta": 0xFCD4,
    "epsilon": 0xFCD5,
    "lambda": 0xFCD6,
    "mu": 0xFCD7,
    "pi2": 0xFCD8,
    "rho": 0xFCD9,
    "capSigma": 0xFCDA,
    "sigma": 0xFCDB,
    "tau": 0xFCDC,
    "phi": 0xFCDD,
    "capOmega": 0xFCDE,
    "phat": 0xFCDF,
    "chi2": 0xFCE0,
    "statF2": 0xFCE1,
    "La": 0xFCE2,
    "Lb": 0xFCE3,
    "Lc": 0xFCE4,
    "Ld": 0xFCE5,
    "Le": 0xFCE6,
    "Lf": 0xFCE7,
    "Lg": 0xFCE8,
    "Lh": 0xFCE9,
    "Li": 0xFCEA,
    "Lj": 0xFCEB,
    "Lk": 0xFCEC,
    "Ll": 0xFCED,
    "Lm": 0xFCEE,
    "Lsmalln": 0xFCEF,
    "Lo": 0xFCF0,
    "Lp": 0xFCF1,
    "Lq": 0xFCF2,
    "Lsmallr": 0xFCF3,
    "Ls": 0xFCF4,
    "Lt": 0xFCF5,
    "Lu": 0xFCF6,
    "Lv": 0xFCF7,
    "Lw": 0xFCF8,
    "Lx": 0xFCF9,
    "Ly": 0xFCFA,
    "Lz": 0xFCFB,
    "GarbageC": 0xFCFC,
    "Backspace": 0x21,
    "Reserved": 0xFB01,
    "AtSign": 0xFB02,
    "Pound": 0xFB03,
    "Dollar": 0xFB04,
    "Ampersand": 0xFB05,
    "BackQuote": 0xFB06,
    "Semicolon": 0xFB07,
    "BackSlash": 0xFB08,
    "VertSlash": 0xFB09,
    "Underscore": 0xFB0A,
    "Tilde": 0xFB0B,
    "Percent": 0xFB0C,
    "Tab": 0xFB0D,
    "ShftTaB": 0xFB0E,
    "ShftDel": 0xFB0F,
    "ShftBack": 0xFB10,
    "ShftPgUp": 0xFB11,
    "ShftPgDn": 0xFB12,
    "ShftLeft": 0xFB13,
    "ShftRight": 0xFB14,
    "ShftUp": 0xFB15,
    "ShftDn": 0xFB16,
    "DiaAdd": 0xFB17,
    "DiaSub": 0xFB18,
    "DiaTilde": 0xFB19,
    "DiaDiv": 0xFB1A,
    "DiaBkSlash": 0xFB1B,
    "DiaColon": 0xFB1C,
    "DiaQuote": 0xFB1D,
    "DiaLBrack": 0xFB1E,
    "DiaRBrack": 0xFB1F,
    "DiaBkSpace": 0xFB20,
    "DiaEnter": 0xFB21,
    "DiaComma": 0xFB22,
    "DiaDel": 0xFB23,
    "DiaDecPnt": 0xFB24,
    "Dia0": 0xFB25,
    "Dia1": 0xFB26,
    "Dia2": 0xFB27,
    "Dia3": 0xFB28,
    "Dia4": 0xFB29,
    "Dia5": 0xFB2A,
    "Dia6": 0xFB2B,
    "Dia7": 0xFB2C,
    "Dia8": 0xFB2D,
    "Dia9": 0xFB2E,
    "DiaTab": 0xFB2F,
    "DiaSpace": 0xFB30,
    "DiaA": 0xFB31,
    "DiaB": 0xFB32,
    "DiaC": 0xFB33,
    "DiaD": 0xFB34,
    "DiaE": 0xFB35,
    "DiaF": 0xFB36,
    "DiaG": 0xFB37,
    "DiaH": 0xFB38,
    "DiaI": 0xFB39,
    "DiaJ": 0xFB3A,
    "DiaK": 0xFB3B,
    "DiaL": 0xFB3C,
    "DiaM": 0xFB3D,
    "DiaN": 0xFB3E,
    "DiaO": 0xFB3F,
    "DiaP": 0xFB40,
    "DiaQ": 0xFB41,
    "DiaR": 0xFB42,
    "DiaS": 0xFB43,
    "DiaT": 0xFB44,
    "DiaU": 0xFB45,
    "DiaV": 0xFB46,
    "DiaW": 0xFB47,
    "DiaX": 0xFB48,
    "DiaY": 0xFB49,
    "DiaZ": 0xFB4A,
    "DiaPgUp": 0xFB4B,
    "DiaPgDn": 0xFB4C,
    "DiaLeft": 0xFB4D,
    "DiaRight": 0xFB4E,
    "DiaUp": 0xFB4F,
    "DiaDn": 0xFB50,
    "SqrAdd": 0xFB51,
    "SqrSub": 0xFB52,
    "SqrTilde": 0xFB53,
    "SqrDiv": 0xFB54,
    "SqrBkSlash": 0xFB55,
    "SqrColon": 0xFB56,
    "SqrQuote": 0xFB57,
    "SqrLBrack": 0xFB58,
    "SqrRBrack": 0xFB59,
    "SqrBkSpace": 0xFB5A,
    "SqrEnter": 0xFB5B,
    "SqrComma": 0xFB5C,
    "SqrDel": 0xFB5D,
    "SqrDecPnt": 0xFB5E,
    "Sqr0": 0xFB5F,
    "Sqr1": 0xFB60,
    "Sqr2": 0xFB61,
    "Sqr3": 0xFB62,
    "Sqr4": 0xFB63,
    "Sqr5": 0xFB64,
    "Sqr6": 0xFB65,
    "Sqr7": 0xFB66,
    "Sqr8": 0xFB67,
    "Sqr9": 0xFB68,
    "SqrTab": 0xFB69,
    "SqrSpace": 0xFB6A,
    "SqrA": 0xFB6B,
    "SqrB": 0xFB6C,
    "SqrC": 0xFB6D,
    "SqrD": 0xFB6E,
    "SqrE": 0xFB6F,
    "SqrF": 0xFB70,
    "SqrG": 0xFB71,
    "SqrH": 0xFB72,
    "SqrI": 0xFB73,
    "SqrJ": 0xFB74,
    "SqrK": 0xFB75,
    "SqrL": 0xFB76,
    "SqrM": 0xFB77,
    "SqrN": 0xFB78,
    "SqrO": 0xFB79,
    "SqrP": 0xFB7A,
    "SqrQ": 0xFB7B,
    "SqrR": 0xFB7C,
    "SqrS": 0xFB7D,
    "SquareT": 0xFB7E,
    "SqrU": 0xFB7F,
    "SqrV": 0xFB80,
    "SqrW": 0xFB81,
    "SqrX": 0xFB82,
    "SqrY": 0xFB83,
    "SqrZ": 0xFB84,
    "SqrPgUp": 0xFB85,
    "SqrPgDn": 0xFB86,
    "SqrLeft": 0xFB87,
    "SqrRight": 0xFB88,
    "SqrUp": 0xFB89,
    "SqrDn": 0xFB8A,
    "UnDef": 0xFB8B,
    "Lellipsis": 0xFB8C,
    "Langle": 0xFB8D,
    "Lss": 0xFB8E,
    "LsupX": 0xFB8F,
    "LsubT": 0xFB90,
    "Lsub0": 0xFB91,
    "Lsub1": 0xFB92,
    "Lsub2": 0xFB93,
    "Lsub3": 0xFB94,
    "Lsub4": 0xFB95,
    "Lsub5": 0xFB96,
    "Lsub6": 0xFB97,
    "Lsub7": 0xFB98,
    "Lsub8": 0xFB99,
    "Lsub9": 0xFB9A,
    "Lten": 0xFB9B,
    "Lleft": 0xFB9C,
    "Lconvert": 0xFB9D,
    "LupArrow": 0xFB9E,
    "LdownArrow": 0xFB9F,
    "Lcross": 0xFBA0,
    "Lintegral": 0xFBA1,
    "LsqUp": 0xFBA2,
    "LsqDown": 0xFBA3,
    "Lroot": 0xFBA4,
    "LinvEQ": 0xFBA5,
    "SetDate": 0xFBA6,
    "SetTime": 0xFBA7,
    "CheckTmr": 0xFBA8,
    "SetDtFmt": 0xFBA9,
    "SetTmFmt": 0xFBAA,
    "TimeCnv": 0xFBAB,
    "DayOfWk": 0xFBAC,
    "GetDtStr": 0xFBAD,
    "GetTmStr": 0xFBAE,
    "GetDate": 0xFBAF,
    "GetTime": 0xFBB0,
    "StartTmr": 0xFBB1,
    "GetDtFmt": 0xFBB2,
    "GetTmFmt": 0xFBB3,
    "IsClockOn": 0xFBB4,
    "ClockOff": 0xFBB5,
    "ClockOn": 0xFBB6,
    "OpenLib": 0xFBB7,
    "ExecLib": 0xFBB8,
    "InvT": 0xFBB9,
    "Chi2GOFTest": 0xFBBA,
    "LinRegTInt": 0xFBBB,
    "ManualFit": 0xFBBD,
    "253_LogBASE": 0xFBBC,
    "253_SumSeq": 0xFBBD,
    "253_FracSlash": 0xFBBF,
    "253_Unit": 0xFBC0,
    "253_MixSimp": 0xFBC1,
    "253_FracDec": 0xFBC2,
    "253_Remainder": 0xFBC3,
    "253_RandIntNoRep": 0xFBC4,
    "253_Placeholder": 0xFBC6,
    "253_MATHPRINT": 0xFBC7,
    "253_CLASSIC": 0xFBC8,
    "253_SimpleMode": 0xFBC9,
    "253_MixedMode": 0xFBCA,
    "253_AUTO": 0xFBCB,
    "253_DEC": 0xFBCC,
    "253_FRAC": 0xFBCD,
    "253_ZQuadrant1": 0xFBCE,
    "253_ZFracOneHalf": 0xFBCF,
    "253_ZFracOneThird": 0xFBD0,
    "253_ZFracOneQuarter": 0xFBD1,
    "253_ZFracOneFifth": 0xFBD2,
    "253_ZFracOneEighth": 0xFBD3,
    "253_ZFracOneTenth": 0xFBD4,
    "253_ManualFit": 0xFBD6,
    "ZQuadrant1": 0xFBC0,
    "ZFracOneHalf": 0xFBC1,
    "ZFracOneThird": 0xFBC2,
    "ZFracOneQuarter": 0xFBC3,
    "ZFracOneFifth": 0xFBC4,
    "ZFracOneEighth": 0xFBC5,
    "ZFracOneTenth": 0xFBC6,
    "LogBASE": 0xFBC7,
    "SumSeq": 0xFBC8,
    "FracSlash": 0xFBCA,
    "Unit": 0xFBCB,
    "MixSimp": 0xFBCC,
    "FracDec": 0xFBCD,
    "Remainder": 0xFBCE,
    "RandIntNoRep": 0xFBCF,
    "Placeholder": 0xFBD1,
    "MATHPRINT": 0xFBD2,
    "CLASSIC": 0xFBD3,
    "SimpleMode": 0xFBD4,
    "MixedMode": 0xFBD5,
    "AUTO": 0xFBD6,
    "DEC": 0xFBD7,
    "FRAC": 0xFBD8,
    "STATWIZARD_ON": 0xFBD9,
    "STATWIZARD_OFF": 0xFBDA,
    "BLUE": 0xFBDB,
    "RED": 0xFBDC,
    "BLACK": 0xFBDD,
    "MAGENTA": 0xFBDE,
    "GREEN": 0xFBDF,
    "ORANGE": 0xFBE0,
    "BROWN": 0xFBE1,
    "NAVY": 0xFBE2,
    "LTBLUE": 0xFBE3,
    "YELLOW": 0xFBE4,
    "WHITE": 0xFBE5,
    "LTGRAY": 0xFBE6,
    "MEDGRAY": 0xFBE7,
    "GRAY": 0xFBE8,
    "DARKGRAY": 0xFBE9,
    "Image1": 0xFBEA,
    "Image2": 0xFBEB,
    "Image3": 0xFBEC,
    "Image4": 0xFBED,
    "Image5": 0xFBEE,
    "Image6": 0xFBEF,
    "Image7": 0xFBF0,
    "Image8": 0xFBF1,
    "Image9": 0xFBF2,
    "Image0": 0xFBF3,
    "GridLine": 0xFBF4,
    "BackgroundOn": 0xFBF5,
    "BackgroundOff": 0xFBF6,
    "GraphColor": 0xFBF7,
    "QuickPlotAndFitEq": 0xFBF8,
    "TextColor": 0xFA01,
    "Asm84PCPrgm": 0xFA02,
    "DetectAsymOn": 0xFA03,
    "DetectAsymOff": 0xFA04,
    "BorderColor": 0xFA05,
    "SmallDotIcon": 0xFA06,
    "Thin": 0xFA07,
    "DotThin": 0xFA08,
};

const KEYMAP_86 = {
    "Right": 0x01,
    "Left": 0x02,
    "Up": 0x03,
    "Down": 0x04,
    "Colon": 0x05,
    "Enter": 0x06,
    "Exit": 0x07,
    "Clear": 0x08,
    "Del": 0x09,
    "Ins": 0x0A,
    "Next": 0x0B,
    "Add": 0x0C,
    "Sub": 0x0D,
    "Mul": 0x0E,
    "Div": 0x0F,
    "Expon": 0x10,
    "LParen": 0x11,
    "RParen": 0x12,
    "LBrack": 0x13,
    "RBrack": 0x14,
    "Equal": 0x15,
    "Store": 0x16,
    "Recall": 0x17,
    "Comma": 0x18,
    "Ang": 0x19,
    "Chs": 0x1A,
    "DecPnt": 0x1B,
    "0": 0x1C,
    "1": 0x1D,
    "2": 0x1E,
    "3": 0x1F,
    "4": 0x20,
    "5": 0x21,
    "6": 0x22,
    "7": 0x23,
    "8": 0x24,
    "9": 0x25,
    "EE": 0x26,
    "Space": 0x27,
    "CapA": 0x28,
    "CapB": 0x29,
    "CapC": 0x2A,
    "CapD": 0x2B,
    "CapE": 0x2C,
    "CapF": 0x2D,
    "CapG": 0x2E,
    "CapH": 0x2F,
    "CapI": 0x30,
    "CapJ": 0x31,
    "CapK": 0x32,
    "CapL": 0x33,
    "CapM": 0x34,
    "CapN": 0x35,
    "CapO": 0x36,
    "CapP": 0x37,
    "CapQ": 0x38,
    "CapR": 0x39,
    "CapS": 0x3A,
    "CapT": 0x3B,
    "CapU": 0x3C,
    "CapV": 0x3D,
    "CapW": 0x3E,
    "CapX": 0x3F,
    "CapY": 0x40,
    "CapZ": 0x41,
    "a": 0x42,
    "b": 0x43,
    "c": 0x44,
    "d": 0x45,
    "e": 0x46,
    "f": 0x47,
    "g": 0x48,
    "h": 0x49,
    "i": 0x4A,
    "j": 0x4B,
    "k": 0x4C,
    "l": 0x4D,
    "m": 0x4E,
    "n": 0x4F,
    "o": 0x50,
    "p": 0x51,
    "q": 0x52,
    "r": 0x53,
    "s": 0x54,
    "t": 0x55,
    "u": 0x56,
    "v": 0x57,
    "w": 0x58,
    "x": 0x59,
    "y": 0x5A,
    "z": 0x5B,
    "Varx": 0x5C,
    "Ans": 0x5D,
    "Pi": 0x5E,
    "Inv": 0x5F,
    "Sin": 0x60,
    "ASin": 0x61,
    "Cos": 0x62,
    "ACos": 0x63,
    "Tan": 0x64,
    "ATan": 0x65,
    "Square": 0x66,
    "Sqrt": 0x67,
    "Ln": 0x68,
    "Exp": 0x69,
    "Log": 0x6A,
    "ALog": 0x6B,
    "Math": 0x6C,
    "Cplx": 0x6D,
    "String": 0x6E,
    "Test": 0x6F,
    "Conv": 0x70,
    "Char": 0x71,
    "Base": 0x72,
    "Custom": 0x73,
    "Vars": 0x74,
    "Catalog": 0x75,
    "Quit": 0x76,
    "LastEnt": 0x77,
    "LinkIO": 0x78,
    "Mem": 0x79,
    "List": 0x7A,
    "Vector": 0x7B,
    "Const": 0x7C,
    "Matrix": 0x7D,
    "Poly": 0x7E,
    "Simult": 0x7F,
    "Stat": 0x80,
    "GrMenu": 0x81,
    "Mode": 0x82,
    "Prgm": 0x83,
    "Calcu": 0x84,
    "Solver": 0x85,
    "Table": 0x86,
    "BOL": 0x87,
    "EOL": 0x88,
    "F1": 0xC2,
    "F2": 0xC3,
    "F3": 0xC4,
    "F4": 0xC5,
    "F5": 0xC6,
    "F6": 0xC7,
    "F7": 0xC8,
    "F8": 0xC9,
    "F9": 0xCA,
    "F10": 0xCB,
};

const KEYMAP_89 = {
    "CR": 0xD,
    "ENTER": 0xD,
    "LP": 0x28,
    "RP": 0x29,
    "MULT": 0x2A,
    "PLUS": 0x2B,
    "COMMA": 0x2C,
    "MINUS": 0x2D,
    "DOT": 0x2E,
    "DIVIDE": 0x2F,
    "0": 0x30,
    "1": 0x31,
    "2": 0x32,
    "3": 0x33,
    "4": 0x34,
    "5": 0x35,
    "6": 0x36,
    "7": 0x37,
    "8": 0x38,
    "9": 0x39,
    "EQUALS": 0x3D,
    "POWER": 0x5E,
    "T": 0x74,
    "X": 0x78,
    "Y": 0x79,
    "Z": 0x7A,
    "TUBE": 0x7C,
    "EE": 0x95,
    "NEG": 0xAD,
    "BS": 0x101,
    "STO": 0x102,
    "CLEAR": 0x107,
    "ESC": 0x108,
    "APPS": 0x109,
    "MODE": 0x10A,
    "ON": 0x10B,
    "F1": 0x10C,
    "F2": 0x10D,
    "F3": 0x10E,
    "F4": 0x10F,
    "F5": 0x110,
    "F6": 0x111,
    "F7": 0x112,
    "F8": 0x113,
    "CHS": 0x114,
    "HOME": 0x115,
    "CATLG": 0x116,
    "LEFT": 0x151,
    "UP": 0x152,
    "RIGHT": 0x154,
    "DOWN": 0x158,
    "2ND": 0x1000,
    "CTRL": 0x2000,
    "SHIFT": 0x4000,
    "ALPHA": 0x8000,
};

const KEYMAP_92P = {
    "CR": 0xD,
    "ENTER": 0xD,
    "SPACE": 0x20,
    "LP": 0x28,
    "RP": 0x29,
    "MULT": 0x2A,
    "PLUS": 0x2B,
    "COMMA": 0x2C,
    "MINUS": 0x2D,
    "DOT": 0x2E,
    "DIVIDE": 0x2F,
    "0": 0x30,
    "1": 0x31,
    "2": 0x32,
    "3": 0x33,
    "4": 0x34,
    "5": 0x35,
    "6": 0x36,
    "7": 0x37,
    "8": 0x38,
    "9": 0x39,
    "EQUALS": 0x3D,
    "A": 0x41,
    "B": 0x42,
    "C": 0x43,
    "D": 0x44,
    "E": 0x45,
    "F": 0x46,
    "G": 0x47,
    "H": 0x48,
    "I": 0x49,
    "J": 0x4A,
    "K": 0x4B,
    "L": 0x4C,
    "M": 0x4D,
    "N": 0x4E,
    "O": 0x4F,
    "P": 0x50,
    "Q": 0x51,
    "R": 0x52,
    "S": 0x53,
    "T": 0x54,
    "U": 0x55,
    "V": 0x56,
    "W": 0x57,
    "X": 0x58,
    "Y": 0x59,
    "Z": 0x5A,
    "POWER": 0x5E,
    "THETA": 0x88,
    "NEG": 0xAD,
    "DELETE": 0x101,
    "STO": 0x102,
    "SIN": 0x103,
    "COS": 0x104,
    "TAN": 0x105,
    "LN": 0x106,
    "CLEAR": 0x107,
    "ESC": 0x108,
    "MENU": 0x109,
    "MODE": 0x10A,
    "ON": 0x10B,
    "F1": 0x10C,
    "F2": 0x10D,
    "F3": 0x10E,
    "F4": 0x10F,
    "F5": 0x110,
    "F6": 0x111,
    "F7": 0x112,
    "F8": 0x113,
    "CHS": 0x114,
    "LEFT": 0x151,
    "UP": 0x152,
    "UP_LF": 0x153,
    "RIGHT": 0x154,
    "UP_RG": 0x156,
    "DOWN": 0x158,
    "DW_LF": 0x159,
    "DW_RG": 0x15C,
    "2ND": 0x1000,
    "CTRL": 0x2000,
    "SHIFT": 0x4000,
    "DRAG": 0x8000,
};

const KEYMAP_NSP = {
    "ESC": 0x1B9600,
    "CTRL_ESC": 0x00EF00,
    "TAB": 0x099500,
    "SHIFT_TAB": 0x7C9500,
    "CTRL_TAB": 0x00ED00,
    "HOME": 0x00FD00,
    "CTRL_HOME": 0x00FE00,
    "MENU": 0x003600,
    "CTRL_MENU": 0x00CE00,
    "MOUSE_CONTEXT_MENU": 0x00A000,
    "CLICK": 0x00AD00,
    "CTRL_CLICK": 0x00AC00,
    "SHIFT_GRAB": 0x00F900,
    "LEFT": 0x000700,
    "SHIFT_LEFT": 0x00F100,
    "SHIFT_HOLD_LEFT": 0x000703,
    "CTRL_LEFT": 0x00DA00,
    "RIGHT": 0x002700,
    "SHIFT_RIGHT": 0x00F200,
    "SHIFT_HOLD_RIGHT": 0x002703,
    "CTRL_RIGHT": 0x00DB00,
    "UP": 0x001700,
    "SHIFT_UP": 0x00F300,
    "SHIFT_HOLD_UP": 0x001703,
    "CTRL_UP": 0x00DC00,
    "DOWN": 0x003700,
    "SHIFT_DOWN": 0x00F400,
    "SHIFT_HOLD_DOWN": 0x003703,
    "CTRL_DOWN": 0x00DD00,
    "EQUAL": 0x3D7500,
    "CTRL_EQUAL": 0x00E900,
    "SUCH_THAT": 0x7CED00,
    "A": 0x616600,
    "SHIFT_A": 0x416600,
    "CTRL_A": 0x616600,
    "B": 0x624600,
    "SHIFT_B": 0x424600,
    "CTRL_B": 0x02B100,
    "C": 0x632600,
    "SHIFT_C": 0x432600,
    "CTRL_C": 0x03B200,
    "FLAG": 0x00A700,
    "CTRL_FLAG": 0x00F800,
    "LESS_THAN": 0x3CA600,
    "CTRL_LESS_THAN": 0x00CF00,
    "D": 0x648500,
    "SHIFT_D": 0x448500,
    "CTRL_D": 0x04B300,
    "E": 0x656500,
    "SHIFT_E": 0x456500,
    "CTRL_E": 0x05B400,
    "F": 0x664500,
    "SHIFT_F": 0x464500,
    "CTRL_F": 0x06B500,
    "G": 0x672500,
    "SHIFT_G": 0x472500,
    "CTRL_G": 0x07B600,
    "TILDE": 0x27F500,
    "CTRL_TILDE": 0x240500,
    "GREATER_THAN": 0x3E8600,
    "CTRL_GREATER_THAN": 0x00DE00,
    "H": 0x688400,
    "SHIFT_H": 0x488400,
    "CTRL_H": 0x08B700,
    "I": 0x696400,
    "SHIFT_I": 0x496400,
    "CTRL_I": 0x09B800,
    "J": 0x6A4400,
    "SHIFT_J": 0x4A4400,
    "CTRL_J": 0x0AB900,
    "K": 0x6B2400,
    "SHIFT_K": 0x4B2400,
    "CTRL_K": 0x0BBA00,
    "QUOTE": 0x22A100,
    "IMAGINARY": 0x00A200,
    "CTRL_IMAGINARY": 0x00A100,
    "L": 0x6C8300,
    "SHIFT_L": 0x4C8300,
    "CTRL_L": 0x0CBB00,
    "M": 0x6D6300,
    "SHIFT_M": 0x4D6300,
    "CTRL_M": 0x0DBC00,
    "N": 0x6E4300,
    "SHIFT_N": 0x4E4300,
    "CTRL_N": 0x0EBD00,
    "O": 0x6F2300,
    "SHIFT_O": 0x4F2300,
    "CTRL_O": 0x0FBE00,
    "COLON": 0x3A0100,
    "CTRL_COLON": 0x3B0200,
    "EXP": 0x00A400,
    "P": 0x708200,
    "SHIFT_P": 0x508200,
    "CTRL_P": 0x10BF00,
    "Q": 0x716200,
    "SHIFT_Q": 0x516200,
    "CTRL_Q": 0x11C000,
    "R": 0x724200,
    "SHIFT_R": 0x524200,
    "CTRL_R": 0x12C100,
    "S": 0x732200,
    "SHIFT_S": 0x532200,
    "CTRL_S": 0x13C200,
    "QUESTION_MARK": 0x3F0300,
    "CTRL_QUESTION_MARK": 0x00CB00,
    "PI": 0x00A300,
    "CTRL_PI": 0x00F400,
    "T": 0x748100,
    "SHIFT_T": 0x548100,
    "CTRL_T": 0x14C300,
    "U": 0x756100,
    "SHIFT_U": 0x556100,
    "CTRL_U": 0x15C400,
    "V": 0x764100,
    "SHIFT_V": 0x564100,
    "CTRL_V": 0x16C500,
    "W": 0x772100,
    "SHIFT_W": 0x572100,
    "CTRL_W": 0x17C600,
    "COMMA": 0x2CA000,
    "THETA": 0x880600,
    "X": 0x788000,
    "SHIFT_X": 0x588000,
    "CTRL_X": 0x18C700,
    "Y": 0x796000,
    "SHIFT_Y": 0x596000,
    "CTRL_Y": 0x19C800,
    "Z": 0x7A4000,
    "SHIFT_Z": 0x5A4000,
    "CTRL_Z": 0x1AC900,
    "SPACE": 0x202000,
    "CTRL_SPACE": 0x00CD00,
    "NEW_LINE": 0x000A00,
    "CTRL": 0x00AA04,
    "SHIFT": 0x00AB03,
    "CTRL_SHIFT": 0x00AB07,
    "BACK_SPACE": 0x081500,
    "SHIFT_BACK_SPACE": 0x081500,
    "CTRL_BACK_SPACE": 0x00E304,
    "VAR": 0x00AF00,
    "CTRL_VAR": 0x00A800,
    "LEFT_PARENTHESES": 0x285500,
    "CTRL_LEFT_PARENTHESES": 0x00E700,
    "RIGHT_PARENTHESES": 0x293500,
    "CTRL_RIGHT_PARENTHESES": 0x00E500,
    "CATALOG": 0x009100,
    "CTRL_CATALOG": 0x00EE00,
    "POWER": 0x5E9300,
    "CTRL_POWER": 0x00EB00,
    "SIN": 0x007400,
    "CTRL_SIN": 0x00E800,
    "COS": 0x005400,
    "CTRL_COS": 0x00E600,
    "TAN": 0x003400,
    "CTRL_TAN": 0x00E400,
    "SLASH": 0x2F1400,
    "CTRL_SLASH": 0x00E200,
    "SQUARE": 0x009300,
    "CTRL_SQUARE": 0x009200,
    "SEVEN": 0x377100,
    "CTRL_SEVEN": 0x00D700,
    "EIGHT": 0x385100,
    "CTRL_EIGHT": 0x00D800,
    "NINE": 0x393100,
    "CTRL_NINE": 0x00D900,
    "TIMES": 0x2A1300,
    "CTRL_TIMES": 0x00E100,
    "TEN_POWER": 0x00EC00,
    "CTRL_TEN_POWER": 0x009400,
    "FOUR": 0x347200,
    "CTRL_FOUR": 0x00D400,
    "FIVE": 0x355200,
    "CTRL_FIVE": 0x00D500,
    "SIX": 0x363200,
    "CTRL_SIX": 0x00D600,
    "MINUS": 0x2D1200,
    "CTRL_MINUS": 0x00E000,
    "E_POWER": 0x00CA00,
    "CTRL_E_POWER": 0x00A900,
    "ONE": 0x317300,
    "CTRL_ONE": 0x00D100,
    "TWO": 0x325300,
    "CTRL_TWO": 0x00D200,
    "THREE": 0x333300,
    "CTRL_THREE": 0x00D300,
    "PLUS": 0x2B1100,
    "CTRL_PLUS": 0x00DF00,
    "ON": 0x000B00,
    "CTRL_ON": 0x00F000,
    "ZERO": 0x305000,
    "CTRL_ZERO": 0x00D000,
    "POINT": 0x2E7000,
    "NEG": 0xB13000,
    "CTRL_NEG": 0x00AE00,
    "ENTER": 0x0D1000,
    "CTRL_ENTER": 0x00A600,
};

const KEYMAP_8X_ENTRIES = Object.entries(KEYMAP_8X_);
const KEYMAP_8X_BY_NAME = new Map();
for (const [name, code] of KEYMAP_8X_ENTRIES) {
    KEYMAP_8X_BY_NAME.set(name.toLowerCase(), code);
}

const KEYMAP_86_ENTRIES = Object.entries(KEYMAP_86);
const KEYMAP_86_BY_NAME = new Map();
for (const [name, code] of KEYMAP_86_ENTRIES) {
    KEYMAP_86_BY_NAME.set(name.toLowerCase(), code);
}

const KEYMAP_89_ENTRIES = Object.entries(KEYMAP_89);
const KEYMAP_89_BY_NAME = new Map();
for (const [name, code] of KEYMAP_89_ENTRIES) {
    KEYMAP_89_BY_NAME.set(name.toLowerCase(), code);
}

const KEYMAP_92P_ENTRIES = Object.entries(KEYMAP_92P);
const KEYMAP_92P_BY_NAME = new Map();
for (const [name, code] of KEYMAP_92P_ENTRIES) {
    KEYMAP_92P_BY_NAME.set(name.toLowerCase(), code);
}

const KEYMAP_NSP_ENTRIES = Object.entries(KEYMAP_NSP);
const KEYMAP_NSP_BY_NAME = new Map();
for (const [name, code] of KEYMAP_NSP_ENTRIES) {
    KEYMAP_NSP_BY_NAME.set(name.toLowerCase(), code);
}

const KEYMAP_CONFIG_8X = { entries: KEYMAP_8X_ENTRIES, byName: KEYMAP_8X_BY_NAME, listId: 'keyMap834' };
const KEYMAP_CONFIG_86 = { entries: KEYMAP_86_ENTRIES, byName: KEYMAP_86_BY_NAME, listId: 'keyMap86' };
const KEYMAP_CONFIG_89 = { entries: KEYMAP_89_ENTRIES, byName: KEYMAP_89_BY_NAME, listId: 'keyMap89' };
const KEYMAP_CONFIG_92P = { entries: KEYMAP_92P_ENTRIES, byName: KEYMAP_92P_BY_NAME, listId: 'keyMap92p' };
const KEYMAP_CONFIG_NSP = { entries: KEYMAP_NSP_ENTRIES, byName: KEYMAP_NSP_BY_NAME, listId: 'nspireKeyMap' };

const KEYMAP_BY_MODEL = new Map([
    [1, KEYMAP_CONFIG_8X],
    [2, KEYMAP_CONFIG_8X],
    [3, KEYMAP_CONFIG_8X],
    [4, KEYMAP_CONFIG_8X],
    [5, KEYMAP_CONFIG_8X],
    [7, KEYMAP_CONFIG_86],
    [8, KEYMAP_CONFIG_89],
    [9, KEYMAP_CONFIG_89],
    [10, KEYMAP_CONFIG_92P],
    [11, KEYMAP_CONFIG_92P],
    [12, KEYMAP_CONFIG_92P],
    [13, KEYMAP_CONFIG_8X],
    [17, KEYMAP_CONFIG_8X],
    [18, KEYMAP_CONFIG_8X],
    [19, KEYMAP_CONFIG_8X],
    [20, KEYMAP_CONFIG_8X],
    [21, KEYMAP_CONFIG_8X],
    [22, KEYMAP_CONFIG_8X],
    [36, KEYMAP_CONFIG_8X],
]);

function populateKeyMapDataList(listId, entries) {
    const list = document.getElementById(listId);
    if (!list) {
        return;
    }
    list.textContent = '';
    for (const [name, code] of entries) {
        const option = document.createElement('option');
        option.value = name;
        option.label = `0x${code.toString(16).toUpperCase()}`;
        list.appendChild(option);
    }
}

function clearKeyMapDataList() {
    ['keyMap834', 'nspireKeyMap', 'keyMap86', 'keyMap89', 'keyMap92p'].forEach(id => {
        const list = document.getElementById(id);
        if (list) {
            list.textContent = '';
        }
    });
}

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
    btnNewFolder: document.getElementById('btnNewFolder'),
    btnSendFiles: document.getElementById('btnSendFiles'),
    btnReceiveBackup: document.getElementById('btnReceiveBackup'),
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
    transferModal: document.getElementById('transferModal'),
    transferTableBody: document.getElementById('transferTableBody'),
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
    toastContainer: document.getElementById('toastContainer')
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

function showOfflineBanner() {
    if (!els.offlineBanner) {
        return;
    }
    els.offlineBanner.classList.remove('hidden');
}

function showOfflineUpdateBanner() {
    if (!els.offlineBanner || !els.btnReloadOffline) {
        return;
    }
    if (els.offlineBannerText) {
        els.offlineBannerText.textContent = 'An update is available. Reload to use the latest version.';
    }
    els.btnReloadOffline.classList.remove('hidden');
    els.offlineBanner.classList.remove('hidden');
    if (els.settingsUpdateDot) {
        els.settingsUpdateDot.classList.remove('hidden');
    }
    if (els.btnSettings) {
        els.btnSettings.title = 'Update available';
    }
    state.offlineUpdateShown = true;
}

function hideOfflineUpdateBanner() {
    if (!els.offlineBanner || !els.btnReloadOffline) {
        return;
    }
    if (els.offlineBannerText) {
        els.offlineBannerText.textContent = 'This app can now run without a network connection.';
    }
    els.btnReloadOffline.classList.add('hidden');
    if (els.settingsUpdateDot) {
        els.settingsUpdateDot.classList.add('hidden');
    }
    if (els.btnSettings && els.btnSettings.title === 'Update available') {
        els.btnSettings.removeAttribute('title');
    }
    if (!state.offlineUpdateShown) {
        return;
    }
    state.offlineUpdateShown = false;
}

async function clearOfflineCache() {
    if (typeof caches !== 'undefined') {
        const keys = await caches.keys();
        await Promise.all(keys.map(key => caches.delete(key)));
    }
    if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(reg => reg.unregister()));
    }
    if (els.offlineBanner) {
        els.offlineBanner.classList.add('hidden');
    }
    log('Offline cache cleared.');
}

async function loadBuildInfo() {
    let info = null;
    try {
        const res = await fetch('version.json', { cache: 'no-store' });
        if (res.ok) {
            info = await res.json();
        }
    } catch {
        // ignore
    }
    if (!info) {
        try {
            const res = await fetch('version.json');
            if (res.ok) {
                info = await res.json();
            }
        } catch {
            return;
        }
    }
    if (!info) {
        return;
    }
    const title = `${info.gitSha || 'unknown'} ${info.buildDate || ''}`.trim();
    if (els.brandMark) {
        els.brandMark.title = title;
    }
    const previous = localStorage.getItem('webtilp.buildId');
    if (info.buildId) {
        if (previous && previous !== info.buildId) {
            showOfflineUpdateBanner();
        } else {
            hideOfflineUpdateBanner();
        }
        localStorage.setItem('webtilp.buildId', info.buildId);
    }
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
    const normalized = normalizeOptionValue(raw);
    const byValue = options.find(option => String(option.value) === raw);
    if (byValue) {
        return String(byValue.value);
    }
    const byLabel = options.find(option => normalizeOptionValue(option.label) === normalized);
    if (byLabel) {
        return String(byLabel.value);
    }
    return null;
}

function resolveCableParam(rawValue) {
    if (!rawValue) {
        return null;
    }
    const normalized = normalizeOptionValue(rawValue);
    if (!normalized) {
        return null;
    }
    if (normalized === 'auto') {
        return 'auto';
    }
    if (normalized === 'silverlink' || normalized === 'dbus') {
        return '4';
    }
    if (normalized === 'directlink' || normalized === 'dusb') {
        return '5';
    }
    return resolveOptionValue(CABLE_OPTIONS, rawValue);
}

function resolveCalcParam(rawValue) {
    if (!rawValue) {
        return null;
    }
    const raw = String(rawValue).trim();
    if (/^\d+$/.test(raw)) {
        return raw;
    }
    return resolveOptionValue(CALC_MODEL_OPTIONS, raw);
}

function applyUrlOverrides() {
    const params = new URLSearchParams(window.location.search);
    if (!params.size) {
        return;
    }

    const nextSettings = { ...state.settings };
    let shouldOpenSettings = false;
    const cableValue = resolveCableParam(params.get('cable'));
    if (cableValue != null) {
        nextSettings.cableModel = cableValue;
    } else if (params.get('cable')) {
        alert(`Unknown cable URL parameter: ${params.get('cable')}`);
    }
    const calcParam = params.get('calc');
    const calcValue = resolveCalcParam(calcParam);
    if (calcValue != null) {
        nextSettings.calcModel = calcValue;
    } else if (calcParam) {
        (async () => {
            try {
                const module = await initModule();
                const model = module.ccall('string_to_calc_model', 'number', ['string'], [calcParam]);
                if (model > 0) {
                    state.settings.calcModel = String(model);
                    if (els.settingCalcModel) {
                        populateSelect(els.settingCalcModel, getCalcOptionsForCable(els.settingCableModel?.value || state.settings.cableModel));
                        els.settingCalcModel.value = state.settings.calcModel;
                        updateCalcHint(els.settingCableModel?.value || state.settings.cableModel);
                    }
                    const isSilverlink = String(state.settings.cableModel) === '4';
                    if (isSilverlink && !SILVERLINK_CALC_VALUES.has(model)) {
                        shouldOpenSettings = true;
                        openSettingsModal();
                    }
                } else {
                    alert(`Unknown calc URL parameter: ${calcParam}`);
                }
            } catch (err) {
                console.warn('[WebTILP] Failed to resolve calc URL param', err);
                alert(`Failed to resolve calc URL parameter: ${calcParam}`);
            }
        })();
    }
    const timeout = Number(params.get('timeout'));
    if (Number.isFinite(timeout) && timeout > 0) {
        nextSettings.cableTimeout = timeout;
    } else if (params.get('timeout')) {
        alert(`Invalid timeout URL parameter: ${params.get('timeout')}`);
    }
    const delay = Number(params.get('delay'));
    if (Number.isFinite(delay) && delay >= 0) {
        nextSettings.cableDelay = delay;
    } else if (params.get('delay')) {
        alert(`Invalid delay URL parameter: ${params.get('delay')}`);
    }
    state.settings = nextSettings;

    const isSilverlink = String(state.settings.cableModel) === '4';
    const calcModelValue = String(state.settings.calcModel || '');
    const isCalcAuto = !calcParam || calcModelValue === 'auto';
    const isCalcValidForSilverlink = SILVERLINK_CALC_VALUES.has(Number(calcModelValue));
    if (isSilverlink && (isCalcAuto || !isCalcValidForSilverlink)) {
        shouldOpenSettings = true;
    }

    const themeParam = params.get('theme');
    if (themeParam) {
        const normalized = normalizeOptionValue(themeParam);
        const target = THEMES.find(theme => normalizeOptionValue(theme.id) === normalized || normalizeOptionValue(theme.label) === normalized);
        if (target) {
            applyTheme(target.id);
        } else {
            alert(`Unknown theme URL parameter: ${themeParam}`);
        }
    }

    const newUrl = `${window.location.pathname}${window.location.hash || ''}`;
    if (window.location.search) {
        window.history.replaceState({}, document.title, newUrl);
    }

    if (shouldOpenSettings) {
        openSettingsModal();
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

function getActiveCalcModelString() {
    if (!state.module) {
        return null;
    }
    try {
        const value = state.module.ccall('get_calc_model_string', 'string', [], []);
        return value || null;
    } catch (err) {
        return null;
    }
}

function resolveDeviceModelName(infoProductName) {
    let calcModelLabel = getActiveCalcModelString();
    if (hasSilverlinkConnected()) {
        const calcModel = state.settings?.calcModel ?? 'auto';
        if (calcModel !== 'auto') {
            return { primary: getCalcModelLabel(calcModel), secondary: calcModelLabel };
        }
        return { primary: 'Unknown', secondary: calcModelLabel };
    } else {
        if (calcModelLabel.endsWith(' USB')) {
            calcModelLabel = calcModelLabel.slice(0, -4);
        }
        if (isCEModelConnected() && (getDeviceInfoValue('Python on board') === 'Yes')) {
            if (is83PCEConnected()) {
                calcModelLabel += ' Edition Python';
            } else {
                calcModelLabel += ' Python';
            }
        }
    }
    const deviceName = state.authorizedDevice?.productName || '';
    const infoName = infoProductName || state.deviceInfoProductName || state.deviceModelName || '';
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
    return a.vendorId === b.vendorId
        && a.productId === b.productId
        && (a.productName || '') === (b.productName || '');
}

function updateDeviceModelDisplay(infoProductName) {
    if (!els.deviceModel) {
        return;
    }
    const resolved = resolveDeviceModelName(infoProductName);
    if (resolved.secondary && resolved.secondary !== resolved.primary) {
        const primary = escapeHtml(resolved.primary);
        const secondary = escapeHtml(resolved.secondary);
        els.deviceModel.innerHTML = `${primary}<div class="device-model-secondary">(${secondary})</div>`;
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

function populateNewFolderParents() {
    if (!els.newFolderParent) {
        return;
    }
    const folders = isNspireActive()
        ? getDirlistFolders().sort((a, b) => a.localeCompare(b))
        : [];
    els.newFolderParent.innerHTML = '';
    const rootOption = document.createElement('option');
    rootOption.value = '';
    rootOption.textContent = '(root)';
    els.newFolderParent.appendChild(rootOption);
    folders.forEach(folder => {
        const option = document.createElement('option');
        option.value = folder;
        option.textContent = folder;
        els.newFolderParent.appendChild(option);
    });
}

function openNewFolderModal() {
    if (!els.newFolderModal) {
        return;
    }
    populateNewFolderParents();
    if (els.newFolderName) {
        els.newFolderName.value = '';
    }
    els.newFolderModal.classList.remove('hidden');
    if (els.newFolderName) {
        els.newFolderName.focus();
    }
}

function closeNewFolderModal() {
    if (!els.newFolderModal) {
        return;
    }
    els.newFolderModal.classList.add('hidden');
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
    if (state.logLines.length > MAX_LOG_LINES) {
        state.logLines.splice(0, state.logLines.length - MAX_LOG_LINES);
    }
    renderLog();
    els.log.scrollTop = els.log.scrollHeight;
    if (isErrorMessage(message)) {
        showToast(message, 'error');
    }
}

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderLog() {
    if (!els.log) {
        return;
    }
    const lines = state.logLines.map(line => {
        const escaped = escapeHtml(line);
        return isErrorMessage(line) ? `<span class="log-error">${escaped}</span>` : escaped;
    });
    els.log.innerHTML = `${lines.join('<br>')}<br>`;
}

function logError(err, context) {
    if (err?.silent) {
        return;
    }
    if (err && err.name === 'NotFoundError') {
        return;
    }
    if (context) {
        console.error(`[WebTILP] ${context}`, err);
    } else {
        console.error('[WebTILP]', err);
    }
    let message = err?.message || err;
    if (typeof message === 'number' || (typeof message === 'string' && /^\d+$/.test(message))) {
        const code = Number(message);
        message = formatErrorResult(state.module, code);
    }
    log(`ERROR: ${message}`);
}

function clearActiveOperations(message) {
    state.operationEpoch += 1;
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

function setButtonLoading(button, loading) {
    if (!button) {
        return;
    }
    if (loading) {
        button.dataset.prevDisabled = button.disabled ? '1' : '0';
        button.disabled = true;
        button.classList.add('loading');
        return;
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

function getActiveKeyMapConfig() {
    if (isNspireActive()) {
        return KEYMAP_CONFIG_NSP;
    }
    if (is84pFamilyActive()) {
        return KEYMAP_CONFIG_8X;
    }
    const pid = state.authorizedDevice?.productId;
    if (typeof pid === 'number' && TI89_PIDS.has(pid)) {
        return KEYMAP_CONFIG_89;
    }
    const calcSetting = state.settings?.calcModel ?? 'auto';
    if (calcSetting !== 'auto') {
        return KEYMAP_BY_MODEL.get(Number(calcSetting)) || null;
    }
    return null;
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
    if (!device) {
        const cancelError = new Error('No device selected.');
        cancelError.silent = true;
        throw cancelError;
    }
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

    if (isNspireActive()) {
        // Nspires can't reconnect automatically, let's USB reset and ask the user for the device again
        console.warn('[WebTILP] Nspire detected, will reset+forget for a fresh start.');
        await ensureCableOpen();
        await nukeConnection(false);
        return;
    }

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
    const hasKeys = (features & FEATURE_FLAGS.OPS_KEYS) !== 0;
    const hasNewFolder = (features & FEATURE_FLAGS.OPS_NEWFLD) !== 0;
    const isNspire = isNspireActive();
    const canReceiveOs = hasRomDump && isNspire;
    updateKeyControlsState(hasKeys);
    if (els.keyCodeInput) {
        els.keyCodeInput.removeAttribute('list');
    }
    clearKeyMapDataList();
    if (hasKeys) {
        const keyConfig = getActiveKeyMapConfig();
        if (keyConfig) {
            populateKeyMapDataList(keyConfig.listId, keyConfig.entries);
            if (els.keyCodeInput) {
                els.keyCodeInput.setAttribute('list', keyConfig.listId);
            }
        }
    }

    if (!hasFolder) {
        // Folder grouping handled in table view only.
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

    if (!hasNewFolder) {
        els.btnNewFolder.classList.add('disabled');
        els.btnNewFolder.disabled = true;
        els.btnNewFolder.title = 'Folder creation not supported by this calculator';
    } else {
        els.btnNewFolder.classList.remove('disabled');
        els.btnNewFolder.disabled = false;
        els.btnNewFolder.title = '';
    }

    if (!hasClock) {
        els.btnSyncClock.classList.add('disabled');
        els.btnSyncClock.disabled = true;
        els.btnSyncClock.title = 'Clock sync not supported by this calculator';
    } else {
        els.btnSyncClock.classList.remove('disabled');
        els.btnSyncClock.disabled = false;
        els.btnSyncClock.title = '';
    }

    if (isNspire) {
        els.btnDumpRom.classList.add('hidden'); // for now
    } else {
        els.btnDumpRom.classList.remove('hidden');
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
    if (els.btnLeaveExam) {
        const canLeaveExam = state.module.ccall('calc_leave_exam_mode_supported', 'number', [], []) !== 0;
        els.btnLeaveExam.classList.toggle('hidden', !canLeaveExam);
        els.btnLeaveExam.disabled = !canLeaveExam;
        els.btnLeaveExam.classList.toggle('disabled', !canLeaveExam);
        els.btnLeaveExam.title = canLeaveExam ? '' : 'Leave exam mode is not supported by this calculator';
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
        state.deviceInfoEntries = entries;
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
                    updateDeviceModelDisplay();
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
            appendDeviceInfoRowHtml(clockKey, clockText ? clockText : 'Unknown');
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
        { timeoutMs: PROGRESS_IDLE_TIMEOUT_MS, useProgress: true, progressLabel: 'Syncing clock' }
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
        const keyEl = document.createElement('div');
        keyEl.className = 'key';
        keyEl.textContent = entry.key;
        const valueEl = document.createElement('div');
        valueEl.className = valueClass;
        if (String(entry.key || '').trim().toLowerCase() === 'language id') {
            valueEl.innerHTML = formatLanguageIdHtml(entry.value);
        } else {
            valueEl.textContent = entry.value;
        }
        row.appendChild(keyEl);
        row.appendChild(valueEl);
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
    const keyEl = document.createElement('div');
    keyEl.className = 'key';
    keyEl.textContent = key;
    const valueEl = document.createElement('div');
    valueEl.className = valueClass;
    valueEl.textContent = value;
    row.appendChild(keyEl);
    row.appendChild(valueEl);
    els.deviceInfoList.appendChild(row);
}

function appendDeviceInfoRowHtml(keyHtml, valueHtml) {
    if (!els.deviceInfoList) {
        return;
    }
    const row = document.createElement('div');
    row.className = 'info-row';
    const valueClass = / hash$/i.test(keyHtml) ? 'value hash-value' : 'value';
    row.innerHTML = `<div class="key">${keyHtml}</div><div class="${valueClass}">${valueHtml}</div>`;
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
    setSelectedFiles([]);
    state.nspireOsReceiveStarted = false;
    updateNspireOsButtons(false, false);
    renderDirlist(state.dirlist);
    updateSelectionActionButtons();
    updateKeyControlsState(false);
    els.deviceInfoList.innerHTML = '';
    els.deviceModel.textContent = 'Unknown';
    state.deviceModelName = '';
    state.deviceInfoProductName = '';
    state.deviceInfoEntries = [];
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
        const result = await ccallAsync(module, 'calc_dirlist_json', 'number', ['number', 'string'], [handle, '/dirlist.json'], { timeoutMs: null, useProgress: true, progressLabel: 'Loading directory listing' });
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
    const showKind = !isNspireActive();
    const table = els.varTableBody.closest('table');
    if (table) {
        table.classList.toggle('hide-location', !showLocation);
        table.classList.toggle('hide-kind', !showKind);
    }
    if (els.folderSticky) {
        els.folderSticky.classList.toggle('hide-kind', !showKind);
        els.folderSticky.classList.toggle('hide-location', !showLocation);
    }
    renderTableView(entries, filter);
    updateStickyFolderHeader();
    updateSelectionActionButtons();
}

function renderTableView(entries, filter) {
    const selectionKeys = getSelectedVarKeys();
    els.varTableBody.innerHTML = '';
    const tree = buildTree(entries);
    state.folderSizeMap = new Map();

    const entryMatchesFilter = (entry) => {
        if (!filter) {
            return true;
        }
        const hay = `${entry.name} ${entry.type} ${entry.type_name || ''} ${entry.kind}`.toLowerCase();
        return hay.includes(filter);
    };

    const nodeHasMatch = (node) => {
        if (!filter) {
            return true;
        }
        if (node.entry) {
            if (node.entry.is_folder === 1) {
                const nameHay = (node.entry.name || node.name || '').toLowerCase();
                if (nameHay.includes(filter)) {
                    return true;
                }
            } else if (entryMatchesFilter(node.entry)) {
                return true;
            }
        }
        if (node.children) {
            return node.children.some(child => nodeHasMatch(child));
        }
        return false;
    };

    const buildSyntheticFolderEntry = (node) => {
        const path = node.path || node.name || '';
        const parts = path.split('/').filter(Boolean);
        const name = parts.pop() || node.name || 'Folder';
        const folder = parts.join('/');
        return {
            name,
            folder,
            type: 0,
            type_name: 'Directory',
            size: 0,
            kind: 'folder',
            is_folder: 1,
            attr: 0
        };
    };

    const renderTableRow = (entry, depth, options = {}) => {
        const isArchived = entry.attr === 3;
        const isFolder = entry.is_folder === 1;
        const location = entry.kind === 'app' ? 'Flash' : (isArchived ? 'Archive' : 'RAM');
        const typeLabel = isFolder ? 'Directory' : (entry.type_name || `Unknown (${entry.type})`);
        const sizeValue = Number(entry.size) || 0;
        const sizeLabel = options.sizeLabel ?? (isFolder ? '-' : formatBytes(sizeValue));
        const indentBars = depth > 0
            ? `<span class="indent-bars">${'<span class="indent-bar"></span>'.repeat(depth)}</span>`
            : '';
        const kindLabel = isFolder ? 'folder' : (entry.kind || '');
        const safeTypeLabel = escapeHtml(typeLabel);
        const safeLocation = escapeHtml(isFolder ? '-' : location);
        const safeKindLabel = escapeHtml(kindLabel);
        const safeFolderCell = escapeHtml(entry.folder || '-') || '-';
        const sizeHtml = options.sizeLabel ? options.sizeLabel : escapeHtml(sizeLabel);
        const row = document.createElement('tr');
        const normalizedFolderPath = normalizeFolderPath(getEntryFolderPath(entry));
        const safeName = escapeHtml(entry.name || '');
        const safeFolderPath = escapeHtml(normalizedFolderPath);
        row.dataset.folderTarget = normalizedFolderPath;
        row.dataset.isFolder = isFolder ? '1' : '0';
        row.dataset.folderPath = normalizedFolderPath;
        row.dataset.depth = String(depth);
        const canRename = (state.features & FEATURE_FLAGS.OPS_RENAME) !== 0;
        const canDelete = (state.features & FEATURE_FLAGS.OPS_DELVAR) !== 0;
        const rowActions = `
            <div class="row-actions">
                <button class="btn ghost btn-inline action-download" title="Download">⬇️</button>
                ${canRename ? '<button class="btn ghost btn-inline action-rename" title="Rename">✏️</button>' : ''}
                ${canDelete ? '<button class="btn ghost btn-inline action-delete" title="Delete">🗑️</button>' : ''}
            </div>`;
        const toggleButton = isFolder
            ? `<button class="folder-toggle" type="button" data-folder-path="${safeFolderPath}" aria-label="${options.expanded ? 'Collapse folder' : 'Expand folder'}">${options.expanded ? '▾' : '▸'}</button>`
            : '';
        const displayName = isFolder
            ? `<span class="folder-icon" data-folder-path="${safeFolderPath}">📂</span> ${safeName}`
            : safeName;
        const summaryText = options.summary ? `<em class="folder-summary">(${options.summary})</em>` : '';
        row.innerHTML = `
            <td><input type="checkbox" data-name="" data-folder="" data-folder-path="" data-is-folder="${isFolder ? '1' : '0'}" data-type="${entry.type}" data-kind=""></td>
            <td>
                <div class="name-cell">
                    <div class="name-left">${indentBars}${toggleButton}<span class="name-label">${displayName}${summaryText}</span></div>
                    ${rowActions}
                </div>
            </td>
            <td>${safeTypeLabel}</td>
            <td title="${isFolder ? '' : `${sizeValue} bytes`}">${sizeHtml}</td>
            <td>${safeLocation}</td>
            <td>${safeFolderCell}</td>
            <td>${safeKindLabel}</td>
        `;
        const checkbox = row.querySelector('input[type="checkbox"]');
        if (checkbox) {
            checkbox.dataset.name = entry.name || '';
            checkbox.dataset.folder = entry.folder || '';
            checkbox.dataset.folderPath = normalizedFolderPath;
            checkbox.dataset.kind = isFolder ? 'folder' : (entry.kind || '');
        }
        els.varTableBody.appendChild(row);
    };

    const sortNodes = (nodes) => {
        const key = state.sort.key;
        const dir = state.sort.dir;
        return [...nodes].sort((a, b) => {
            const entryA = a.entry || buildSyntheticFolderEntry(a);
            const entryB = b.entry || buildSyntheticFolderEntry(b);
            return compareEntries(entryA, entryB, key, dir);
        });
    };

    const collectFolderSizes = (node) => {
        const isFolderNode = (node.entry && node.entry.is_folder === 1) || (!node.entry && node.children);
        if (!isFolderNode) {
            if (node.entry) {
                return Number(node.entry.size) || 0;
            }
            return 0;
        }
        const children = node.children || [];
        const total = children.reduce((sum, child) => sum + collectFolderSizes(child), 0);
        const folderEntry = node.entry || buildSyntheticFolderEntry(node);
        const folderPath = normalizeFolderPath(getEntryFolderPath(folderEntry));
        state.folderSizeMap.set(folderPath, total);
        return total;
    };

    tree.forEach(node => collectFolderSizes(node));

    const renderTableNode = (node, depth, forceShowChildren) => {
        const isFolderNode = (node.entry && node.entry.is_folder === 1) || (!node.entry && node.children);
        if (isFolderNode) {
            const folderEntry = node.entry || buildSyntheticFolderEntry(node);
            const folderName = folderEntry.name || node.name || 'Folder';
            const matchesFolder = filter ? folderName.toLowerCase().includes(filter) : false;
            const shouldShow = !filter || forceShowChildren || matchesFolder || nodeHasMatch(node);
            if (!shouldShow) {
                return false;
            }
            const folderPath = normalizeFolderPath(getEntryFolderPath(folderEntry));
            const expanded = state.expandedFolders?.has(folderPath) || (filter && nodeHasMatch(node)) || forceShowChildren;
            const children = node.children || [];
            const childStats = children.reduce((acc, child) => {
                const childIsFolder = (child.entry && child.entry.is_folder === 1) || (!child.entry && child.children);
                if (childIsFolder) {
                    acc.folders += 1;
                } else {
                    acc.files += 1;
                }
                return acc;
            }, { folders: 0, files: 0 });
            const summaryParts = [];
            if (childStats.folders) {
                summaryParts.push(`${childStats.folders} subfolder${childStats.folders === 1 ? '' : 's'}`);
            }
            if (childStats.files) {
                summaryParts.push(`${childStats.files} file${childStats.files === 1 ? '' : 's'}`);
            }
            const summary = summaryParts.length ? `contains ${summaryParts.join(' and ')}` : 'empty';
            const totalSize = state.folderSizeMap.get(folderPath) ?? 0;
            const sizeLabel = `<em class="folder-size">(${formatBytes(totalSize)} total)</em>`;
            renderTableRow(folderEntry, depth, { expanded, summary, sizeLabel });
            if (expanded) {
                const sortedChildren = sortNodes(children);
                const childForce = forceShowChildren || matchesFolder;
                sortedChildren.forEach(child => {
                    renderTableNode(child, depth + 1, childForce);
                });
            }
            return true;
        }

        if (node.entry) {
            if (!forceShowChildren && !entryMatchesFilter(node.entry)) {
                return false;
            }
            renderTableRow(node.entry, depth);
            return true;
        }

        return false;
    };

    sortNodes(tree).forEach(node => {
        renderTableNode(node, 0, false);
    });
    applySelectionKeys(selectionKeys, els.varTableBody);
}

function compareEntries(a, b, key, dir) {
    const factor = dir === 'asc' ? 1 : -1;
    const getLocation = entry => entry.kind === 'app' ? 'Flash' : (entry.attr === 3 ? 'Archive' : 'RAM');
    const getSizeValue = (entry) => {
        if (entry.is_folder === 1) {
            const folderPath = normalizeFolderPath(getEntryFolderPath(entry));
            return state.folderSizeMap?.get(folderPath) ?? 0;
        }
        return Number(entry.size) || 0;
    };
    const valueA = (() => {
        switch (key) {
            case 'name': return a.name || '';
            case 'type': return a.type_name || `Unknown (${a.type})`;
            case 'size': return getSizeValue(a);
            case 'location': return getLocation(a);
            case 'folder': return a.folder || '';
            default: return a.name || '';
        }
    })();
    const valueB = (() => {
        switch (key) {
            case 'name': return b.name || '';
            case 'type': return b.type_name || `Unknown (${b.type})`;
            case 'size': return getSizeValue(b);
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

function buildTree(entries) {
    const root = new Map();
    const ensureFolderPath = (path, entry = null) => {
        if (!path) {
            return;
        }
        const segments = path.split('/').filter(Boolean);
        let cursor = root;
        segments.forEach((seg, idx) => {
            if (!cursor.has(seg)) {
                cursor.set(seg, { name: seg, children: new Map(), entries: [], isFolder: true, entry: null });
            }
            if (entry && idx === segments.length - 1) {
                cursor.get(seg).entry = entry;
            }
            cursor = cursor.get(seg).children;
        });
    };
    entries.forEach(entry => {
        if (entry.is_folder === 1) {
            ensureFolderPath(getEntryFolderPath(entry), entry);
            return;
        }
        const folder = entry.folder || '';
        ensureFolderPath(folder);
        const segments = folder ? folder.split('/') : [];
        let cursor = root;
        segments.forEach(seg => {
            cursor = cursor.get(seg).children;
        });
        if (!cursor.has('__entries__')) {
            cursor.set('__entries__', { entries: [] });
        }
        cursor.get('__entries__').entries.push(entry);
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
                    children: mapToNodes(value.children, path),
                    entry: value.entry || null
                });
            }
        });
        return nodes.sort((a, b) => (a.name || a.entry.name).localeCompare(b.name || b.entry.name));
    }

    return mapToNodes(root, '');
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

document.addEventListener('click', event => {
    const row = event.target.closest('tr');
    if (row && row.closest('#varTableBody')) {
        return;
    }
    document.querySelectorAll('#varTableBody tr.is-active').forEach(activeRow => {
        activeRow.classList.remove('is-active');
    });
});

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
    const selectionCount = getSelectedVarInputs().length;
    const hasSelection = selectionCount > 0;
    if (els.btnRecvSelected) {
        els.btnRecvSelected.disabled = !hasSelection;
    }
    if (els.btnDeleteSelected) {
        els.btnDeleteSelected.disabled = !hasSelection;
    }
    if (els.selectAllVars) {
        const allInputs = Array.from(els.varTableBody.querySelectorAll('input[type="checkbox"]:not(:disabled)'));
        if (!allInputs.length) {
            els.selectAllVars.checked = false;
            els.selectAllVars.indeterminate = false;
        } else {
            const checkedCount = allInputs.filter(input => input.checked).length;
            els.selectAllVars.checked = checkedCount === allInputs.length;
            els.selectAllVars.indeterminate = checkedCount > 0 && checkedCount < allInputs.length;
        }
    }
}

function updateKeyControlsState(enabled) {
    if (!els.keysPanel) {
        return;
    }
    els.keysPanel.classList.toggle('hidden', !enabled);
    if (els.keyCodeInput) {
        els.keyCodeInput.disabled = !enabled;
    }
    if (els.btnSendKey) {
        els.btnSendKey.disabled = !enabled;
    }
    document.querySelectorAll('.key-quick').forEach(button => {
        button.disabled = !enabled;
    });
}

function parseKeyCode(input) {
    const raw = String(input || '').trim();
    if (!raw) {
        return null;
    }
    const normalized = raw.replace(/\s+/g, '').toLowerCase();
    const config = getActiveKeyMapConfig();
    if (config?.byName) {
        if (config.byName.has(normalized)) {
            return config.byName.get(normalized);
        }
        if (normalized.startsWith('k')) {
            const stripped = normalized.slice(1);
            if (config.byName.has(stripped)) {
                return config.byName.get(stripped);
            }
        }
    }
    const isHex = raw.startsWith('0x') || /[a-f]/i.test(raw);
    const value = Number.parseInt(raw, isHex ? 16 : 10);
    if (!Number.isFinite(value)) {
        return null;
    }
    return value >>> 0;
}

async function sendKey(code) {
    const key = parseKeyCode(code);
    if (key === null) {
        log('Enter a valid key code (hex like 0x05 or decimal).');
        return;
    }
    try {
        await authorizeDevice();
        if (!ensureSilverlinkModelSelected()) {
            return;
        }
        const module = await initModule();
        const handle = await ensureCableOpen();
        if ((state.features & FEATURE_FLAGS.OPS_KEYS) === 0) {
            log('Remote key/action sending is not supported by this calculator.');
            return;
        }
        const result = await ccallAsync(module, 'calc_send_key', 'number', ['number', 'number'], [handle, key], { timeoutMs: 1000 });
        if (result !== 0) {
            log(`Failed to send key (${formatErrorResult(module, result)}).`);
            return;
        }
        log(`Sent key 0x${key.toString(16).toUpperCase()}.`);
    } catch (err) {
        logError(err, 'Send key failed');
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
    return Array.from(els.varTableBody.querySelectorAll('input[type="checkbox"]:checked'));
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
        const row = input.closest('tr');
        if (row) {
            row.classList.toggle('is-active', input.checked);
        }
    });
}

function buildEntryFromCheckbox(checkbox) {
    return {
        name: checkbox.dataset.name,
        folder: checkbox.dataset.folder,
        type: Number(checkbox.dataset.type),
        kind: checkbox.dataset.kind,
        isFolder: checkbox.dataset.isFolder === '1',
        folderPath: checkbox.dataset.folderPath || ''
    };
}

function ensureFolderSticky() {
    if (!els.folderSticky) {
        return;
    }
    if (els.folderSticky.dataset.ready) {
        return;
    }
    els.folderSticky.dataset.ready = '1';
    els.folderSticky.innerHTML = `
        <table class="var-table">
            <colgroup>
                <col><col><col><col><col><col><col>
            </colgroup>
            <tbody></tbody>
        </table>
    `;
}

function updateStickyFolderHeader() {
    if (!els.folderSticky || !els.tableView) {
        return;
    }
    ensureFolderSticky();
    const headerRow = els.tableView.querySelector('thead');
    const table = els.tableView.querySelector('table');
    if (!table) {
        els.folderSticky.classList.add('hidden');
        return;
    }
    const headerHeight = headerRow ? (headerRow.offsetHeight - 1) : 0;
    els.folderSticky.style.top = `${headerHeight}px`;

    const allRows = Array.from(els.varTableBody.querySelectorAll('tr'));
    const folderRows = allRows.filter(row => row.dataset.isFolder === '1');
    if (!folderRows.length) {
        els.folderSticky.classList.add('hidden');
        return;
    }
    const scrollTop = els.tableView.scrollTop + headerHeight;
    let current = null;
    for (const row of folderRows) {
        if (row.offsetTop <= scrollTop) {
            current = row;
        } else {
            break;
        }
    }
    if (!current) {
        els.folderSticky.classList.add('hidden');
        stickyVisible = false;
        state.stickyPath = '';
        return;
    }

    const lastRow = allRows[allRows.length - 1];
    if (lastRow && (lastRow.offsetTop + lastRow.offsetHeight) <= scrollTop) {
        els.folderSticky.classList.add('hidden');
        stickyVisible = false;
        state.stickyPath = '';
        return;
    }

    const currentDepth = Number(current.dataset.depth || 0);
    const currentIndex = allRows.indexOf(current);
    let boundary = Number.POSITIVE_INFINITY;
    for (let i = currentIndex + 1; i < allRows.length; i++) {
        const nextRow = allRows[i];
        const nextDepth = Number(nextRow.dataset.depth || 0);
        if (nextDepth <= currentDepth) {
            boundary = nextRow.offsetTop;
            break;
        }
    }
    const buffer = 8;
    stickyHideThreshold = Number.isFinite(boundary) ? boundary + buffer : null;
    if (stickyHideThreshold != null && scrollTop >= stickyHideThreshold) {
        if (stickyVisible) {
            els.folderSticky.classList.add('hidden');
            stickyVisible = false;
        }
        return;
    }

    const folderInput = current.querySelector('input[type="checkbox"]');
    const fullPath = folderInput?.dataset.folderPath || '';
    if (fullPath === state.stickyPath && stickyVisible) {
        const headerCells = table.querySelectorAll('thead th');
        if (table.offsetWidth !== state.stickyTableWidth || headerCells.length !== state.stickyHeaderWidths.length) {
            state.stickyTableWidth = table.offsetWidth;
            state.stickyHeaderWidths = Array.from(headerCells).map(cell => cell.offsetWidth);
        } else {
            return;
        }
    }
    const parts = fullPath.split('/').filter(Boolean);
    const tbody = els.folderSticky.querySelector('tbody');
    if (!tbody) {
        return;
    }
    tbody.innerHTML = '';
    const label = parts.length ? `📂 ${escapeHtml(parts.join(' > '))}` : '📂';
    const padCell = current.querySelector('td');
    const padWidth = padCell ? padCell.offsetWidth : 0;
    const tr = document.createElement('tr');
    tr.innerHTML = `
        <td style="${padWidth ? `width:${padWidth}px;min-width:${padWidth}px;` : ''}"></td>
        <td class="folder-sticky-name" colspan="6">
            <div class="name-cell">
                <div class="name-left"><span class="name-label">${label}</span></div>
            </div>
        </td>
    `;
    tbody.appendChild(tr);
    els.folderSticky.classList.remove('hidden');
    stickyVisible = true;
    state.stickyPath = fullPath;

    const headerCells = table.querySelectorAll('thead th');
    const stickyTable = els.folderSticky.querySelector('table');
    const colgroup = stickyTable ? stickyTable.querySelector('colgroup') : null;
    if (stickyTable) {
        stickyTable.style.width = `${table.offsetWidth}px`;
        state.stickyTableWidth = table.offsetWidth;
    }
    if (colgroup) {
        const cols = colgroup.querySelectorAll('col');
        headerCells.forEach((cell, idx) => {
            if (cols[idx]) {
                cols[idx].style.width = `${cell.offsetWidth}px`;
            }
        });
        state.stickyHeaderWidths = Array.from(headerCells).map(cell => cell.offsetWidth);
    }
}

function scheduleStickyUpdate() {
    if (stickyUpdateScheduled) {
        return;
    }
    stickyUpdateScheduled = true;
    requestAnimationFrame(() => {
        stickyUpdateScheduled = false;
        updateStickyFolderHeader();
    });
}

async function ensureDirlistLoadedWithPrompt() {
    if (state.dirlist.length) {
        return;
    }
    if (state.dirlistPromptPromise) {
        await state.dirlistPromptPromise;
        return;
    }
    state.dirlistPromptPromise = (async () => {
        const confirmDirlist = confirm('Directory listing has not been loaded yet. It is highly recommended before transfers. Load it now?');
        if (confirmDirlist) {
            await refreshDirlist();
        }
    })();
    try {
        await state.dirlistPromptPromise;
    } finally {
        state.dirlistPromptPromise = null;
    }
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

        await ensureDirlistLoadedWithPrompt();

        const hasFolder = (state.features & FEATURE_FLAGS.FTS_FOLDER) !== 0;
        const hasArchive = (state.features & FEATURE_FLAGS.OPS_CHATTR) !== 0 || (state.features & FEATURE_FLAGS.FTS_FLASH) !== 0;
        const folders = hasFolder ? getDirlistFolders() : [];
        const effectiveFolder = hasFolder ? (dropFolder || '') : '';
        if (effectiveFolder) {
            log(`Target folder: ${effectiveFolder}`);
        }
        const bundleCandidates = files.filter(isCeBundleFile);
        if (bundleCandidates.length > 0) {
            if (bundleCandidates.length !== files.length) {
                alert('Please transfer bundle files by themselves.');
                return;
            }
            if (bundleCandidates.length > 1) {
                alert('Please transfer one bundle file at a time.');
                return;
            }
            const bundleResult = await handleCeBundleTransfer(bundleCandidates[0], module, { hasFolder, hasArchive, folders });
            if (bundleResult) {
                state.selectedFiles = [];
                if (bundleResult.successCount > 0) {
                    setSelectedFiles([]);
                }
            }
            return;
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
        const hasOsTransfer = selections.some(item => item.fileClass === 'os');
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
            folders.add(getEntryFolderPath(entry));
            return;
        }
        if (entry.folder) {
            folders.add(entry.folder);
        }
    });
    return Array.from(folders).filter(folder => folder !== '');
}

function estimateBackupSize() {
    let total = 0;
    state.dirlist.forEach(entry => {
        if (!entry || entry.is_folder === 1) {
            return;
        }
        if (entry.kind !== 'var' && entry.kind !== 'app') {
            return;
        }
        const size = Number(entry.size);
        if (Number.isFinite(size) && size > 0) {
            total += size;
        }
    });
    return total;
}

function isVarFileClass(fileClass) {
    return ['single', 'group', 'regular', 'tigroup'].includes(fileClass);
}

const BUNDLE_EXT_RE = /\.b8[34]$/i;
const BUNDLE_LANGUAGE_APPS = [
    'Portuguese',
    'French',
    'Nederlands',
    'Svenska',
    'Espanol',
    'Deutsch'
];
const TI_LANG_CODES = {
    9: 'English',
    22: 'Portuguese',
    12: 'French',
    19: 'Nederlands',
    29: 'Svenska',
    10: 'Espanol',
    7: 'Deutsch'
};

function parseLanguageId(rawValue) {
    if (!rawValue) {
        return null;
    }
    const match = String(rawValue).match(/\d+/);
    if (!match) {
        return null;
    }
    const value = Number(match[0]);
    return Number.isFinite(value) ? value : null;
}

function formatLanguageIdHtml(rawValue) {
    const code = parseLanguageId(rawValue);
    if (code == null) {
        return escapeHtml(String(rawValue || ''));
    }
    const name = TI_LANG_CODES[code];
    if (name) {
        return `<abbr title="${code}">${name}</abbr>`;
    }
    return escapeHtml(String(code));
}

function getDeviceInfoValue(label) {
    if (!label) {
        return '';
    }
    const target = String(label).trim().toLowerCase();
    if (!state.deviceInfoEntries?.length) {
        return '';
    }
    const entry = state.deviceInfoEntries.find(item => String(item.key || '').trim().toLowerCase() === target);
    return entry?.value ?? '';
}

function getLanguageIdValue() {
    const raw = getDeviceInfoValue('Language ID');
    return parseLanguageId(raw);
}

function isCeBundleFile(file) {
    return Boolean(file && BUNDLE_EXT_RE.test(file.name || ''));
}

function isCEModelConnected() {
    const name = (getActiveCalcModelString() || state.deviceInfoProductName || state.deviceModelName || state.authorizedDevice?.productName || '')
        .toLowerCase()
        .trim();
    if (!name) {
        return false;
    }
    return name.startsWith('ti-83 premium ce') || name.startsWith('ti-84 plus ce');
}

function is83PCEConnected() {
    const name = (getActiveCalcModelString() || state.deviceInfoProductName || state.deviceModelName || state.authorizedDevice?.productName || '')
        .toLowerCase()
        .trim();
    if (!name) {
        return false;
    }
    return name.startsWith('ti-83 premium ce');
}

function getExistingLanguageApps() {
    const langs = new Set();
    const targets = BUNDLE_LANGUAGE_APPS.map(name => name.toLowerCase());
    state.dirlist.forEach(entry => {
        if (!entry || entry.is_folder === 1) {
            return;
        }
        const base = String(entry.name || '').toLowerCase();
        if (targets.includes(base)) {
            langs.add(base);
        }
    });
    return langs;
}

function applyBundleDefaults(plan) {
    const pythonOnBoard = getDeviceInfoValue('Python on board') === 'Yes';
    const is83PCE = is83PCEConnected();
    const languageId = getLanguageIdValue();
    const preferredLang = languageId != null ? (TI_LANG_CODES[languageId] || '') : '';
    const preferredLangLower = preferredLang.toLowerCase();
    const existingLangs = getExistingLanguageApps();
    const languageTargets = new Set(BUNDLE_LANGUAGE_APPS.map(name => name.toLowerCase()));

    plan.forEach(item => {
        const base = String(item.file?.name || '')
            .replace(/\.[^.]+$/, '')
            .toLowerCase();
        item.selected = true;

        if (base === 'python') {
            item.selected = pythonOnBoard;
            return;
        }
        if (base === 'pyadaptr') {
            item.selected = !pythonOnBoard && is83PCE;
            return;
        }
        if (languageTargets.has(base)) {
            if (existingLangs.has(base)) {
                item.selected = true;
            } else if (preferredLangLower && base === preferredLangLower) {
                item.selected = true;
            } else {
                item.selected = false;
            }
        }
    });
}

function isCEBundleOSFile(item) {
    if (!item?.file?.name) {
        return false;
    }
    if (item.fileClass === 'os') {
        return true;
    }
    return /\.8[ep]u$/i.test(item.file.name);
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
        try {
            const infoText = await ccallAsync(module, 'file_get_entries_json', 'string', ['string'], [path], { timeoutMs: 8000 });
            if (infoText && typeof infoText === 'string') {
                const parsed = JSON.parse(infoText);
                fileClass = parsed.class || 'unknown';
                entries = Array.isArray(parsed.entries) ? parsed.entries : [];
            }
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
            entries,
            entryCount: entries.length,
            entryName: defaultName,
            entryType: entry.type ?? null,
            entryTypeName: entry.type_name ?? '',
            entryFolder: defaultFolder,
            entryAttr: entry.attr ?? 0,
            defaultLocation,
            locationMask,
            locationMode
        });
    }

    return plan;
}

async function buildTransferPlanFromFsEntries(entries, module) {
    const plan = [];
    for (const entry of entries) {
        const path = entry.path;
        const name = entry.name;
        if (!path || !name) {
            continue;
        }
        let size = 0;
        try {
            size = module.FS.stat(path).size;
        } catch {
            size = 0;
        }
        const file = { name, size };

        const fileClass = entry.class || 'unknown';
        const entriesInfo = Array.isArray(entry.entries) ? entry.entries : [];

        const entryInfo = entriesInfo[0] || {};
        const baseName = name.replace(/\.[^.]+$/, '');
        const defaultName = entryInfo.name || baseName;
        const defaultFolder = entryInfo.folder || '';
        const defaultLocation = entryInfo.attr === 3 ? 'archive' : 'ram';
        let locationMask = entriesInfo.length
            ? entriesInfo.reduce((mask, item) => mask & (item.location_mask ?? 3), 3)
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
            entries: entriesInfo,
            entryCount: entriesInfo.length,
            entryName: defaultName,
            entryType: entryInfo.type ?? null,
            entryTypeName: entryInfo.type_name ?? '',
            entryFolder: defaultFolder,
            entryAttr: entryInfo.attr ?? 0,
            defaultLocation,
            locationMask,
            locationMode
        });
    }
    return plan;
}

async function extractBundleFiles(bundleFile, module) {
    if (!module.FS.analyzePath('/uploads').exists) {
        module.FS.mkdir('/uploads');
    }
    const data = new Uint8Array(await bundleFile.arrayBuffer());
    const bundlePath = `/uploads/${bundleFile.name}`;
    module.FS.writeFile(bundlePath, data);

    if (!module.FS.analyzePath('/tmp_bundle').exists) {
        module.FS.mkdir('/tmp_bundle');
    }
    const bundleDir = `/tmp_bundle/${Date.now()}_${Math.random().toString(16).slice(2)}`;
    module.FS.mkdir(bundleDir);

    let parsed = null;
    const infoText = await ccallAsync(
        module,
        'bundle_extract_json',
        'string',
        ['string', 'string'],
        [bundlePath, bundleDir],
        { timeoutMs: 15000 }
    );
    if (infoText && typeof infoText === 'string') {
        try {
            parsed = JSON.parse(infoText);
        } catch (err) {
            console.warn('[WebTILP] Failed to parse bundle JSON', err);
        }
    }
    const files = Array.isArray(parsed?.files) ? parsed.files : [];
    return { bundlePath, bundleDir, files };
}

async function handleCeBundleTransfer(bundleFile, module, options) {
    if (!isCEModelConnected()) {
        alert('This bundle can only be installed on TI-84 Plus CE / TI-83 Premium CE calculators.');
        return null;
    }

    const cleanupPaths = [];
    let bundleDir = '';
    try {
        const extracted = await extractBundleFiles(bundleFile, module);
        bundleDir = extracted.bundleDir;
        cleanupPaths.push(extracted.bundlePath);

        if (!extracted.files.length) {
            alert('Bundle archive contains no transferable files.');
            return null;
        }

        const plan = await buildTransferPlanFromFsEntries(extracted.files, module);
        extracted.files.forEach(item => {
            if (item.path) {
                cleanupPaths.push(item.path);
            }
        });
        applyBundleDefaults(plan);

        const selections = await openTransferModal(plan, {
            hasFolder: options.hasFolder,
            hasArchive: options.hasArchive,
            folders: options.folders
        });
        if (!selections) {
            return null;
        }

        const nonOs = selections.filter(item => !isCEBundleOSFile(item));
        const osItems = selections.filter(item => isCEBundleOSFile(item));
        const orderedSelections = nonOs.concat(osItems);

        const { successCount } = await performTransfers(orderedSelections, module, {
            hasFolder: options.hasFolder,
            hasArchive: options.hasArchive
        });

        orderedSelections.forEach(item => {
            try {
                module.FS.unlink(item.path);
            } catch {
                // ignore
            }
        });

        const hasOs = orderedSelections.some(item => isCEBundleOSFile(item));
        if (successCount > 0 && !hasOs) {
            await refreshDirlist();
        }
        return { successCount, hasOs };
    } finally {
        cleanupPaths.forEach(path => {
            try {
                module.FS.unlink(path);
            } catch {
                // ignore
            }
        });
        if (bundleDir) {
            try {
                module.FS.rmdir(bundleDir);
            } catch {
                // ignore
            }
        }
    }
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
    document.querySelectorAll('.transfer-select').forEach(cell => {
        cell.classList.toggle('hidden', false);
    });
    document.querySelectorAll('.transfer-type').forEach(cell => {
        cell.classList.toggle('hidden', false);
    });

    plan.forEach((item, index) => {
        const row = document.createElement('tr');
        row.dataset.index = String(index);
        const entryLabel = item.entryCount > 1
            ? `${item.entryCount} entries`
            : (item.entryName || item.file.name);
        const typeLabel = item.entryTypeName
            || (!(["unknown","single","regular"].includes(item.fileClass)) ? item.fileClass : null)
            || (item.entryType != null ? `(type ${item.entryType})` : '-');
        const isVar = isVarFileClass(item.fileClass);
        let locationCell = `<td class="transfer-location ${options.hasArchive ? '' : 'hidden'}">-</td>`;
        if (item.fileClass === "application") {
            locationCell = `<td class="transfer-location">Archive</td>`;
        } else if (options.hasArchive && isVar) {
            const mask = item.locationMask ?? 3;
            const locationValue = item.locationMode || item.defaultLocation;
            const allowRam = (mask & 1) !== 0;
            const allowArchive = (mask & 2) !== 0;
            if (mask !== 3) {
                const label = mask === 2 ? 'Archive' : (mask === 1 ? 'RAM' : 'Auto');
                const titleText = mask === 2
                    ? 'Archive-only variable type.'
                    : (mask === 1 ? 'RAM-only variable type.' : 'Mixed locations detected. Keeping file defaults.');
                const titleAttr = titleText ? `title="${escapeHtml(titleText)}"` : '';
                locationCell = `<td class="transfer-location" ${titleAttr}>${escapeHtml(label)}</td>`;
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
            .concat(folders.map(folder => `<option value="${escapeHtml(folder)}">${escapeHtml(folder)}</option>`))
            .join('');
        const folderCell = options.hasFolder && isVar
            ? `<td class="transfer-folder"><select class="form-input" data-field="folder">${folderOptions}</select></td>`
            : `<td class="transfer-folder ${options.hasFolder ? '' : 'hidden'}">-</td>`;
        const selectedAttr = item.selected === false ? '' : 'checked';
        const selectCell = `<td class="transfer-select"><input type="checkbox" data-field="select" ${selectedAttr}></td>`;
        row.innerHTML = `
            ${selectCell}
            <td>${escapeHtml(item.file.name)}</td>
            <td>${escapeHtml(entryLabel)}</td>
            <td class="transfer-type">${escapeHtml(typeLabel)}</td>
            ${locationCell}
            ${folderCell}
        `;
        els.transferTableBody.appendChild(row);

        if (options.hasFolder) {
            const folderSelect = row.querySelector('[data-field="folder"]');
            if (folderSelect) {
                folderSelect.value = item.entryFolder || '';
            }
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
            const selections = [];
            let selectedCount = 0;
            plan.forEach((item, index) => {
                const row = els.transferTableBody.querySelector(`tr[data-index="${index}"]`);
                if (!row) {
                    selections.push({ ...item });
                    selectedCount += 1;
                    return;
                }
                const checkbox = row.querySelector('[data-field="select"]');
                if (checkbox && !checkbox.checked) {
                    return;
                }
                const locationSelect = row.querySelector('[data-field="location"]');
                const location = options.hasArchive && locationSelect
                    ? (locationSelect.value || item.locationMode || item.defaultLocation)
                    : item.defaultLocation;
                const folder = options.hasFolder
                    ? row.querySelector('[data-field="folder"]')?.value || ''
                    : item.entryFolder;
                selections.push({
                    ...item,
                    targetLocation: location,
                    targetFolder: folder
                });
                selectedCount += 1;
            });
            if (selectedCount === 0) {
                alert('Select at least one file to transfer.');
                return;
            }
            cleanup();
            els.transferModal.classList.add('hidden');
            resolve(selections);
        };
        els.btnConfirmTransfer.addEventListener('click', onConfirm);
        els.btnCancelTransfer.addEventListener('click', onCancel);
        els.btnCloseTransfer.addEventListener('click', onCancel);
    });
}

function setBackupModalLoading(isLoading, message) {
    if (els.backupModalOverlay) {
        els.backupModalOverlay.classList.toggle('hidden', !isLoading);
    }
    if (els.backupModalOverlayText && message) {
        els.backupModalOverlayText.textContent = message;
    }
    if (els.btnConfirmBackup) {
        els.btnConfirmBackup.disabled = isLoading;
    }
    if (els.backupFormatBackup) {
        els.backupFormatBackup.disabled = isLoading;
    }
    if (els.backupFormatTigroup) {
        const allowTigroup = els.backupModal?.dataset.allowTigroup === '1';
        els.backupFormatTigroup.disabled = isLoading || !allowTigroup;
    }
    if (els.backupIncludeRam) {
        els.backupIncludeRam.disabled = isLoading;
    }
    if (els.backupIncludeArchive) {
        els.backupIncludeArchive.disabled = isLoading;
    }
    if (els.backupIncludeFlash) {
        els.backupIncludeFlash.disabled = isLoading;
    }
}

function openBackupModal(options) {
    const allowTigroup = options?.allowTigroup ?? false;
    const defaultFormat = options?.defaultFormat || 'backup';
    const defaultMode = options?.defaultMode ?? (TIG_MODE.RAM | TIG_MODE.ARCHIVE | TIG_MODE.FLASH);

    if (els.backupModal) {
        els.backupModal.dataset.allowTigroup = allowTigroup ? '1' : '0';
    }
    if (els.backupFormatBackup) {
        els.backupFormatBackup.checked = defaultFormat !== 'tigroup';
    }
    if (els.backupFormatTigroup) {
        els.backupFormatTigroup.checked = defaultFormat === 'tigroup';
        els.backupFormatTigroup.disabled = !allowTigroup;
    }
    if (els.tigroupOptions) {
        els.tigroupOptions.classList.toggle('hidden', !allowTigroup || defaultFormat !== 'tigroup');
    }
    if (els.backupIncludeRam) {
        els.backupIncludeRam.checked = (defaultMode & TIG_MODE.RAM) !== 0;
    }
    if (els.backupIncludeArchive) {
        els.backupIncludeArchive.checked = (defaultMode & TIG_MODE.ARCHIVE) !== 0;
    }
    if (els.backupIncludeFlash) {
        els.backupIncludeFlash.checked = (defaultMode & TIG_MODE.FLASH) !== 0;
    }

    const updateModeVisibility = () => {
        const isTigroup = els.backupFormatTigroup?.checked && allowTigroup;
        if (els.tigroupOptions) {
            els.tigroupOptions.classList.toggle('hidden', !isTigroup);
        }
    };

    els.backupModal.classList.remove('hidden');
    setBackupModalLoading(false);

    return new Promise(resolve => {
        const cleanup = () => {
            els.btnConfirmBackup.removeEventListener('click', onConfirm);
            els.btnCancelBackup.removeEventListener('click', onCancel);
            els.btnCloseBackup.removeEventListener('click', onCancel);
            els.backupFormatBackup?.removeEventListener('change', updateModeVisibility);
            els.backupFormatTigroup?.removeEventListener('change', updateModeVisibility);
        };
        const onCancel = () => {
            cleanup();
            els.backupModal.classList.add('hidden');
            resolve(null);
        };
        const onConfirm = () => {
            const format = els.backupFormatTigroup?.checked && allowTigroup ? 'tigroup' : 'backup';
            let mode = TIG_MODE.RAM | TIG_MODE.ARCHIVE | TIG_MODE.FLASH;
            if (format === 'tigroup') {
                mode = 0;
                if (els.backupIncludeRam?.checked) {
                    mode |= TIG_MODE.RAM;
                }
                if (els.backupIncludeArchive?.checked) {
                    mode |= TIG_MODE.ARCHIVE;
                }
                if (els.backupIncludeFlash?.checked) {
                    mode |= TIG_MODE.FLASH;
                }
            }
            cleanup();
            els.backupModal.classList.add('hidden');
            resolve({ format, mode });
        };
        els.btnConfirmBackup.addEventListener('click', onConfirm);
        els.btnCancelBackup.addEventListener('click', onCancel);
        els.btnCloseBackup.addEventListener('click', onCancel);
        els.backupFormatBackup?.addEventListener('change', updateModeVisibility);
        els.backupFormatTigroup?.addEventListener('change', updateModeVisibility);
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
                            { timeoutMs: PROGRESS_IDLE_TIMEOUT_MS, useProgress: true, progressLabel: `Updating ${targetName}` }
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
                        { timeoutMs: PROGRESS_IDLE_TIMEOUT_MS, useProgress: true, progressLabel: `Deleting ${targetName}` }
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
            { timeoutMs: 60000, useProgress: true, progressLabel: `Sending ${item.file.name}` }
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

        await ensureDirlistLoadedWithPrompt();

        const hasFolder = (state.features & FEATURE_FLAGS.FTS_FOLDER) !== 0;
        const hasArchive = (state.features & FEATURE_FLAGS.OPS_CHATTR) !== 0 || (state.features & FEATURE_FLAGS.FTS_FLASH) !== 0;
        const folders = hasFolder ? getDirlistFolders() : [];
        const bundleCandidates = files.filter(isCeBundleFile);
        if (bundleCandidates.length > 0) {
            if (bundleCandidates.length !== files.length) {
                alert('Please transfer bundle files by themselves.');
                return;
            }
            if (bundleCandidates.length > 1) {
                alert('Please transfer one bundle file at a time.');
                return;
            }
            const bundleResult = await handleCeBundleTransfer(bundleCandidates[0], module, { hasFolder, hasArchive, folders });
            if (bundleResult?.successCount > 0) {
                setSelectedFiles([]);
            }
            return;
        }
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

        const hasOsTransfer = selections.some(item => item.fileClass === 'os');
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
    setButtonLoading(els.btnReceiveBackup, true);
    try {
        await authorizeDevice();
        const module = await initModule();
        const handle = await ensureHandle();
        await updateCapabilities();
        const allowTigroup = (state.features & FEATURE_FLAGS.FTS_FLASH) !== 0;
        let defaultFormat = allowTigroup ? 'tigroup' : 'backup';
        let defaultMode = TIG_MODE.RAM | TIG_MODE.ARCHIVE | TIG_MODE.FLASH;
        let backupChoice = null;

        while (true) {
            const backupChoicePromise = openBackupModal({
                allowTigroup,
                defaultFormat,
                defaultMode
            });
            if (!state.dirlist.length) {
                setBackupModalLoading(true, 'Loading directory listing…');
                try {
                    await refreshDirlist();
                } finally {
                    setBackupModalLoading(false);
                }
            }
            backupChoice = await backupChoicePromise;
            if (!backupChoice) {
                return;
            }
            defaultFormat = backupChoice.format;
            defaultMode = backupChoice.mode;

            if (backupChoice.format === 'tigroup' && backupChoice.mode === TIG_MODE.NONE) {
                log('Select at least one data type for TIGroup.');
                defaultFormat = 'tigroup';
                continue;
            }
            if (backupChoice.format === 'backup') {
                const estimatedSize = estimateBackupSize();
                if (estimatedSize > 65535) {
                    const proceed = confirm('Backup data may exceed 65535 bytes and fail. TIGroup is recommended for large backups. Continue with standard backup anyway?');
                    if (!proceed) {
                        if (allowTigroup) {
                            defaultFormat = 'tigroup';
                        }
                        continue;
                    }
                }
            }
            break;
        }
        if (!module.FS.analyzePath('/downloads').exists) {
            module.FS.mkdir('/downloads');
        }
        const isTigroup = backupChoice.format === 'tigroup';
        const target = isTigroup ? '/downloads/backup.tig' : '/downloads/backup.8xg';
        const result = isTigroup
            ? await ccallAsync(module, 'calc_recv_tigroup', 'number', ['number', 'string', 'number'], [handle, target, backupChoice.mode], { timeoutMs: PROGRESS_IDLE_TIMEOUT_MS, useProgress: true, progressLabel: 'Receiving backup (tigroup)' })
            : await ccallAsync(module, 'calc_recv_backup', 'number', ['number', 'string'], [handle, target], { timeoutMs: PROGRESS_IDLE_TIMEOUT_MS, useProgress: true, progressLabel: 'Receiving backup' });
        if (result !== 0) {
            log(`Backup failed (${formatErrorResult(module, result)}).`);
            return;
        }
        await downloadLastReceived(module, isTigroup ? 'backup.tig' : 'backup.8xg');
        log(isTigroup ? 'TIGroup backup received.' : 'Backup received.');
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
        const result = await ccallAsync(module, 'calc_recv_os', 'number', ['number', 'string'], [handle, target], { timeoutMs: null, useProgress: true, progressLabel: 'Receiving OS' });
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
        let result = await ccallAsync(module, 'calc_dump_rom_1', 'number', ['number'], [handle], { timeoutMs: 30000, useProgress: true, progressLabel: 'Starting ROM dump' });
        if (result !== 0) {
            log(`ROM dump step 1 failed (${formatErrorResult(module, result)}).`);
            return;
        }

        log('Receiving ROM image...');
        const target = '/downloads/romdump.bin';
        result = await ccallAsync(module, 'calc_dump_rom_2', 'number', ['number', 'number', 'string'], [handle, 0, target], { timeoutMs: null, useProgress: true, progressLabel: 'Dumping ROM' });
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

async function leaveExamMode() {
    setButtonLoading(els.btnLeaveExam, true);
    let treatDisconnectAsSuccess = false;
    try {
        await authorizeDevice();
        const module = await initModule();
        const handle = await ensureHandle();
        treatDisconnectAsSuccess = isNspireActive();
        const canLeaveExam = module.ccall('calc_leave_exam_mode_supported', 'number', [], []) !== 0;
        if (!canLeaveExam) {
            log('Leave exam mode is not supported by this calculator.');
            return;
        }
        const result = await ccallAsync(
            module,
            'calc_leave_exam_mode',
            'number',
            ['number'],
            [handle],
            { timeoutMs: PROGRESS_IDLE_TIMEOUT_MS, useProgress: true, progressLabel: 'Leaving exam mode' }
        );
        if (result === null || result === undefined || Number.isNaN(Number(result))) {
            if (treatDisconnectAsSuccess) {
                log('Leave exam mode command sent (calculator reset/disconnect is expected).');
                return;
            }
            log('Leave exam mode failed (error (unknown)).');
            return;
        }
        if (result !== 0) {
            // On TI-Nspire, leaving exam mode can immediately reset/disconnect USB.
            // Treat any non-zero result as acceptable for this operation.
            if (treatDisconnectAsSuccess) {
                log('Leave exam mode command sent (calculator reset/disconnect is expected).');
                return;
            }
            log(`Leave exam mode failed (${formatErrorResult(module, result)}).`);
            return;
        }
        log('Leave exam mode command sent.');
    } catch (err) {
        if (treatDisconnectAsSuccess && isAcceptableLeaveExamModeDiscError(err)) {
            log('Leave exam mode command sent (calculator reset/disconnect is expected).');
            return;
        }
        logError(err, 'Leave exam mode failed');
    } finally {
        setButtonLoading(els.btnLeaveExam, false);
    }
}
async function receiveSelected() {
    const selections = getSelectedVarInputs().map(buildEntryFromCheckbox);
    if (!selections.length) {
        log('No variables selected.');
        return;
    }
    const normalizePath = (value) => normalizeFolderPath(value || '');
    const isUnderFolder = (folder, parent) => {
        if (!parent) {
            return true;
        }
        return folder === parent || folder.startsWith(`${parent}/`);
    };
    const folderSelections = selections
        .filter(entry => entry.isFolder)
        .map(entry => normalizePath(entry.folderPath || entry.name))
        .filter(Boolean)
        .sort((a, b) => a.length - b.length);
    const keptFolders = [];
    folderSelections.forEach(folder => {
        if (!keptFolders.some(parent => isUnderFolder(folder, parent))) {
            keptFolders.push(folder);
        }
    });
    const uniqueSelections = selections.filter(entry => {
        if (entry.isFolder) {
            const folderPath = normalizePath(entry.folderPath || entry.name);
            return keptFolders.includes(folderPath);
        }
        const entryFolder = normalizePath(entry.folder);
        return !keptFolders.some(parent => isUnderFolder(entryFolder, parent));
    });
    setButtonLoading(els.btnRecvSelected, true);
    try {
        await authorizeDevice();
        const module = await initModule();
        const handle = await ensureHandle();
        let receivedAny = false;
        if (!module.FS.analyzePath('/downloads').exists) {
            module.FS.mkdir('/downloads');
        }
        if (keptFolders.length) {
            const totalItems = state.dirlist.filter(entry => {
                if (entry.is_folder === 1) {
                    return false;
                }
                const entryFolder = normalizePath(entry.folder);
                if (!entryFolder) {
                    return keptFolders.includes('');
                }
                return keptFolders.some(parent => entryFolder === parent || entryFolder.startsWith(`${parent}/`));
            }).length;
            if (!confirm(`Download ${totalItems} item(s) from ${keptFolders.length} folder(s)?`)) {
                return;
            }
        }
        for (const entry of uniqueSelections) {
            if (entry.isFolder) {
                const ok = await downloadFolderEntriesWithSession(module, handle, entry.folderPath || entry.name, false);
                receivedAny = receivedAny || ok;
                continue;
            }
            const progressLabel = `Receiving ${entry.name}`;
            const result = entry.kind === 'app'
                ? await ccallAsync(module, 'calc_recv_app', 'number', ['number', 'string', 'number', 'string'], [handle, entry.name, entry.type, '/downloads'], { timeoutMs: PROGRESS_IDLE_TIMEOUT_MS, useProgress: true, progressLabel })
                : await ccallAsync(module, 'calc_recv_var', 'number', ['number', 'string', 'string', 'number', 'string'], [handle, entry.folder, entry.name, entry.type, '/downloads'], { timeoutMs: PROGRESS_IDLE_TIMEOUT_MS, useProgress: true, progressLabel });
            if (result === 0) {
                await downloadLastReceived(module);
                log(`Received ${entry.name}.`);
                receivedAny = true;
            } else {
                log(`Failed to receive ${entry.name} (${formatErrorResult(module, result)}).`);
            }
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
            type: Number(input.dataset.type),
            isFolder: input.dataset.isFolder === '1',
            folderPath: input.dataset.folderPath || ''
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
            if (entry.isFolder) {
                const folderPath = entry.folderPath || entry.name;
                const result = await ccallAsync(module, 'calc_del_folder', 'number', ['number', 'string'], [handle, folderPath], { timeoutMs: PROGRESS_IDLE_TIMEOUT_MS, useProgress: true, progressLabel: `Deleting ${folderPath}` });
                if (result === 0) {
                    log(`Deleted folder ${folderPath}.`);
                } else {
                    log(`Failed to delete folder ${folderPath} (${formatErrorResult(module, result)}).`);
                }
            } else {
                const result = await ccallAsync(module, 'calc_del_var', 'number', ['number', 'string', 'string', 'number'], [handle, entry.folder, entry.name, entry.type], { timeoutMs: PROGRESS_IDLE_TIMEOUT_MS, useProgress: true, progressLabel: `Deleting ${entry.name}` });
                if (result === 0) {
                    log(`Deleted ${entry.name}.`);
                } else {
                    log(`Failed to delete ${entry.name} (${formatErrorResult(module, result)}).`);
                }
            }
        }
        await refreshDirlist();
    } catch (err) {
        logError(err, 'Delete selected failed');
    } finally {
        setButtonLoading(els.btnDeleteSelected, false);
    }
}

async function renameEntry(entry) {
    if (entry.isFolder && !isNspireActive()) {
        log('Folder renaming is only supported on TI-Nspire.');
        return;
    }
    const label = entry.isFolder ? 'folder' : 'item';
    const currentName = entry.name || '';
    const newName = prompt(`Rename ${label}:`, currentName);
    if (!newName) {
        log('Rename cancelled.');
        return;
    }
    const trimmed = newName.trim();
    if (!trimmed || trimmed === currentName) {
        log('Rename cancelled.');
        return;
    }
    if (trimmed.includes('/')) {
        log('Folder or item names cannot include "/".');
        return;
    }

    setButtonLoading(els.btnDeleteSelected, true);
    try {
        await authorizeDevice();
        const module = await initModule();
        const handle = await ensureHandle();
        const oldFolder = entry.folder || '';
        const newFolder = oldFolder;
        const result = await ccallAsync(
            module,
            'calc_rename_var',
            'number',
            ['number', 'string', 'string', 'number', 'string', 'string', 'number'],
            [handle, oldFolder, currentName, entry.type, newFolder, trimmed, entry.type],
            { timeoutMs: PROGRESS_IDLE_TIMEOUT_MS, useProgress: true, progressLabel: `Renaming ${currentName}` }
        );
        if (result !== 0) {
            log(`Rename failed (${formatErrorResult(module, result)}).`);
            return;
        }
        log(`Renamed ${currentName} to ${trimmed}.`);
        await refreshDirlist();
    } catch (err) {
        logError(err, 'Rename failed');
    } finally {
        setButtonLoading(els.btnDeleteSelected, false);
    }
}

async function deleteEntry(entry) {
    if (!confirm(`Delete ${entry.isFolder ? 'folder' : 'item'} ${entry.name}?`)) {
        return;
    }
    setButtonLoading(els.btnDeleteSelected, true);
    try {
        await authorizeDevice();
        const module = await initModule();
        const handle = await ensureHandle();
        if (entry.isFolder) {
            const folderPath = entry.folderPath || entry.name;
            const result = await ccallAsync(module, 'calc_del_folder', 'number', ['number', 'string'], [handle, folderPath], { timeoutMs: PROGRESS_IDLE_TIMEOUT_MS, useProgress: true, progressLabel: `Deleting ${folderPath}` });
            if (result === 0) {
                log(`Deleted folder ${folderPath}.`);
            } else {
                log(`Failed to delete folder ${folderPath} (${formatErrorResult(module, result)}).`);
            }
        } else {
            const result = await ccallAsync(module, 'calc_del_var', 'number', ['number', 'string', 'string', 'number'], [handle, entry.folder, entry.name, entry.type], { timeoutMs: PROGRESS_IDLE_TIMEOUT_MS, useProgress: true, progressLabel: `Deleting ${entry.name}` });
            if (result === 0) {
                log(`Deleted ${entry.name}.`);
            } else {
                log(`Failed to delete ${entry.name} (${formatErrorResult(module, result)}).`);
            }
        }
        await refreshDirlist();
    } catch (err) {
        logError(err, 'Delete failed');
    } finally {
        setButtonLoading(els.btnDeleteSelected, false);
    }
}

async function downloadEntry(entry) {
    if (entry.isFolder) {
        await downloadFolderEntries(entry.folderPath || entry.name);
        return;
    }
    setButtonLoading(els.btnRecvSelected, true);
    try {
        await authorizeDevice();
        const module = await initModule();
        const handle = await ensureHandle();
        if (!module.FS.analyzePath('/downloads').exists) {
            module.FS.mkdir('/downloads');
        }
        const progressLabel = `Receiving ${entry.name}`;
        const result = entry.kind === 'app'
            ? await ccallAsync(module, 'calc_recv_app', 'number', ['number', 'string', 'number', 'string'], [handle, entry.name, entry.type, '/downloads'], { timeoutMs: PROGRESS_IDLE_TIMEOUT_MS, useProgress: true, progressLabel })
            : await ccallAsync(module, 'calc_recv_var', 'number', ['number', 'string', 'string', 'number', 'string'], [handle, entry.folder, entry.name, entry.type, '/downloads'], { timeoutMs: PROGRESS_IDLE_TIMEOUT_MS, useProgress: true, progressLabel });
        if (result === 0) {
            await downloadLastReceived(module);
            log(`Received ${entry.name}.`);
        } else {
            log(`Failed to receive ${entry.name} (${formatErrorResult(module, result)}).`);
        }
    } catch (err) {
        logError(err, 'Download failed');
    } finally {
        setButtonLoading(els.btnRecvSelected, false);
    }
}

async function downloadFolderEntriesWithSession(module, handle, folderPath, confirmDownload) {
    const target = normalizeFolderPath(folderPath);
    const entries = state.dirlist.filter(entry => {
        if (entry.is_folder === 1) {
            return false;
        }
        const entryFolder = normalizeFolderPath(entry.folder);
        if (!target) {
            return entryFolder === '';
        }
        return entryFolder === target || entryFolder.startsWith(`${target}/`);
    });
    if (!entries.length) {
        log(`No items found in folder ${target || '(root)'}.`);
        return false;
    }
    if (confirmDownload) {
        if (!confirm(`Download ${entries.length} item(s) from ${target || 'root'}?`)) {
            return false;
        }
    }
    for (const entry of entries) {
        const result = await ccallAsync(
            module,
            'calc_recv_var',
            'number',
            ['number', 'string', 'string', 'number', 'string'],
            [handle, entry.folder, entry.name, entry.type, '/downloads'],
            { timeoutMs: PROGRESS_IDLE_TIMEOUT_MS, useProgress: true, progressLabel: `Receiving ${entry.name}` }
        );
        if (result === 0) {
            await downloadLastReceived(module);
            log(`Received ${entry.name}.`);
        } else {
            log(`Failed to receive ${entry.name} (${formatErrorResult(module, result)}).`);
        }
    }
    return true;
}

async function downloadFolderEntries(folderPath) {
    setButtonLoading(els.btnRecvSelected, true);
    try {
        await authorizeDevice();
        const module = await initModule();
        const handle = await ensureHandle();
        if (!module.FS.analyzePath('/downloads').exists) {
            module.FS.mkdir('/downloads');
        }
        await downloadFolderEntriesWithSession(module, handle, folderPath, true);
    } catch (err) {
        logError(err, 'Folder download failed');
    } finally {
        setButtonLoading(els.btnRecvSelected, false);
    }
}

async function createNewFolder() {
    const name = (els.newFolderName?.value || '').trim();
    if (!name) {
        log('Folder name is required.');
        return;
    }
    const parent = (els.newFolderParent?.value || '').trim();
    if (parent && !isNspireActive()) {
        log('Nested folders are only supported on TI-Nspire.');
        return;
    }
    const folderPath = parent ? `${parent}/${name}` : name;
    setButtonLoading(els.btnCreateNewFolder, true);
    try {
        await authorizeDevice();
        const module = await initModule();
        const handle = await ensureHandle();
        await updateCapabilities();
        if ((state.features & FEATURE_FLAGS.OPS_NEWFLD) === 0) {
            log('Folder creation is not supported by this calculator.');
            return;
        }
        const result = await ccallAsync(module, 'calc_new_folder', 'number', ['number', 'string'], [handle, folderPath], { timeoutMs: PROGRESS_IDLE_TIMEOUT_MS, useProgress: true, progressLabel: `Creating ${folderPath}` });
        if (result !== 0) {
            log(`Failed to create folder (${formatErrorResult(module, result)}).`);
            return;
        }
        log(`Folder created: ${folderPath}.`);
        closeNewFolderModal();
        await refreshDirlist();
    } catch (err) {
        logError(err, 'Create folder failed');
    } finally {
        setButtonLoading(els.btnCreateNewFolder, false);
    }
}

async function takeScreenshot() {
    setButtonLoading(els.btnScreenshot, true);
    try {
        await authorizeDevice();
        const module = await initModule();
        const handle = await ensureHandle();
        const result = await ccallAsync(module, 'calc_screenshot', 'number', ['number'], [handle], { timeoutMs: PROGRESS_IDLE_TIMEOUT_MS, useProgress: true, progressLabel: 'Receiving screenshot' });
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

async function nukeConnection(tryReconnect = true) {
    if (els.btnNuke) {
        setButtonLoading(els.btnNuke, true);
    }
    clearActiveOperations('Operation cancelled by emergency reset.');
    try { await state.authorizedDevice?.reset(); } catch (e) {}
    if (isNspireActive()) {
        try { await state.authorizedDevice?.forget(); } catch (e) {}
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

    try {
        tryReconnect && await connect();
    } catch (err) {
        console.warn('Failed to reconnect automatically, just do it manually.', err);
    }
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
    if (els.btnNewFolder) {
        els.btnNewFolder.addEventListener('click', openNewFolderModal);
    }
    if (els.btnCloseNewFolder) {
        els.btnCloseNewFolder.addEventListener('click', closeNewFolderModal);
    }
    if (els.btnCancelNewFolder) {
        els.btnCancelNewFolder.addEventListener('click', closeNewFolderModal);
    }
    if (els.btnCreateNewFolder) {
        els.btnCreateNewFolder.addEventListener('click', createNewFolder);
    }
    if (els.newFolderName) {
        els.newFolderName.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                createNewFolder();
            }
        });
    }
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
    if (els.newFolderModal) {
        els.newFolderModal.addEventListener('click', event => {
            if (event.target === els.newFolderModal) {
                closeNewFolderModal();
            }
        });
    }
    els.btnIsReady.addEventListener('click', isReady);
    els.btnGetInfo.addEventListener('click', getDeviceInfo);
    els.btnSyncClock.addEventListener('click', syncClock);
    els.btnRefreshDirlist.addEventListener('click', refreshDirlist);
    els.btnSendFiles.addEventListener('click', sendSelectedFiles);
    els.btnReceiveBackup.addEventListener('click', receiveBackup);
    els.btnReceiveOs.addEventListener('click', receiveOs);
    els.btnDownloadOsPartial.addEventListener('click', downloadPartialOs);
    els.btnDumpRom.addEventListener('click', dumpRom);
    if (els.btnLeaveExam) {
        els.btnLeaveExam.addEventListener('click', leaveExamMode);
    }
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
    if (els.btnClearOfflineCache) {
        els.btnClearOfflineCache.addEventListener('click', () => {
            clearOfflineCache().catch(() => {
                log('Failed to clear offline cache.');
            });
        });
    }
    if (els.btnReloadOffline) {
        els.btnReloadOffline.addEventListener('click', async () => {
            try {
                const regs = await navigator.serviceWorker?.getRegistrations?.() || [];
                const reg = regs.find(item => item.active);
                if (reg?.waiting) {
                    reg.waiting.postMessage({ type: 'SKIP_WAITING' });
                    await new Promise(resolve => {
                        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
                    });
                }
            } catch {
                // ignore
            }
            window.location.reload();
        });
    }
    if (els.btnSplashConnect) {
        els.btnSplashConnect.addEventListener('click', connect);
    }
    if (els.selectAllVars) {
        els.selectAllVars.addEventListener('change', () => {
            const checkboxes = Array.from(els.varTableBody.querySelectorAll('input[type="checkbox"]:not(:disabled)'));
            checkboxes.forEach(input => {
                input.checked = els.selectAllVars.checked;
                const row = input.closest('tr');
                if (row) {
                    row.classList.toggle('is-active', input.checked);
                }
            });
            state.lastCheckedIndex = null;
            updateSelectionActionButtons();
        });
    }
    els.filterInput.addEventListener('input', () => renderDirlist(state.dirlist));
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
        event.stopPropagation();
        const now = Date.now();
        if (now - lastDropTs < 200) {
            return;
        }
        lastDropTs = now;
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
    els.varTableBody.addEventListener('click', async event => {
        const toggleButton = event.target.closest('.folder-toggle, .folder-icon');
        if (toggleButton) {
            const folderPath = toggleButton.dataset.folderPath || '';
            if (folderPath) {
                if (state.expandedFolders.has(folderPath)) {
                    state.expandedFolders.delete(folderPath);
                } else {
                    state.expandedFolders.add(folderPath);
                }
                renderDirlist(state.dirlist);
            }
            return;
        }
        const actionButton = event.target.closest('button.action-rename, button.action-delete, button.action-download');
        if (actionButton) {
            const row = actionButton.closest('tr');
            const checkbox = row ? row.querySelector('input[type=\"checkbox\"]') : null;
            if (!checkbox) {
                return;
            }
            if (row) {
                row.classList.add('is-active');
            }
            const entry = buildEntryFromCheckbox(checkbox);
            try {
                if (actionButton.classList.contains('action-rename')) {
                    await renameEntry(entry);
                } else if (actionButton.classList.contains('action-download')) {
                    await downloadEntry(entry);
                } else {
                    await deleteEntry(entry);
                }
            } finally {
                row?.classList.remove('is-active');
            }
            return;
        }
        const toggleFolderSelection = (source) => {
            if (source.dataset.isFolder !== '1') {
                return;
            }
            const folderPath = normalizeFolderPath(source.dataset.folderPath || '');
            if (!folderPath) {
                return;
            }
            const allCheckboxes = Array.from(els.varTableBody.querySelectorAll('input[type="checkbox"]:not(:disabled)'));
            allCheckboxes.forEach(input => {
                const row = input.closest('tr');
                const rowPath = normalizeFolderPath(row?.dataset.folderPath || input.dataset.folderPath || '');
                if (!rowPath) {
                    return;
                }
                if (rowPath === folderPath || rowPath.startsWith(`${folderPath}/`)) {
                    input.checked = source.checked;
                    if (row) {
                        row.classList.toggle('is-active', input.checked);
                    }
                }
            });
        };
        const checkbox = event.target.closest('input[type="checkbox"]');
        if (checkbox) {
            if (event.shiftKey) {
                const checkboxes = Array.from(els.varTableBody.querySelectorAll('input[type="checkbox"]:not(:disabled)'));
                const currentIndex = checkboxes.indexOf(checkbox);
                if (currentIndex !== -1 && state.lastCheckedIndex != null) {
                    const [start, end] = currentIndex > state.lastCheckedIndex
                        ? [state.lastCheckedIndex, currentIndex]
                        : [currentIndex, state.lastCheckedIndex];
                    for (let i = start; i <= end; i++) {
                        checkboxes[i].checked = checkbox.checked;
                        const row = checkboxes[i].closest('tr');
                        if (row) {
                            row.classList.toggle('is-active', checkboxes[i].checked);
                        }
                    }
                }
            }
            toggleFolderSelection(checkbox);
            const allCheckboxes = Array.from(els.varTableBody.querySelectorAll('input[type="checkbox"]:not(:disabled)'));
            state.lastCheckedIndex = allCheckboxes.indexOf(checkbox);
            updateSelectionActionButtons();
            return;
        }
        const row = event.target.closest('tr');
        if (!row) {
            return;
        }
        row.classList.add('is-active');
        const target = row.querySelector('input[type="checkbox"]');
        if (!target || target.disabled) {
            return;
        }
        target.checked = !target.checked;
        toggleFolderSelection(target);
        const allCheckboxes = Array.from(els.varTableBody.querySelectorAll('input[type="checkbox"]:not(:disabled)'));
        state.lastCheckedIndex = allCheckboxes.indexOf(target);
        updateSelectionActionButtons();
    });
    els.varTableBody.addEventListener('change', event => {
        if (event.target && event.target.matches('input[type="checkbox"]')) {
            const row = event.target.closest('tr');
            if (row) {
                row.classList.toggle('is-active', event.target.checked);
            }
            updateSelectionActionButtons();
        }
    });
    if (els.tableView) {
        els.tableView.addEventListener('scroll', () => {
            scheduleStickyUpdate();
        });
    }
    window.addEventListener('resize', () => {
        scheduleStickyUpdate();
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
            if (row && row.dataset && row.dataset.folderPath) {
                let folderRow = null;
                if (row.dataset.isFolder === '1') {
                    folderRow = row;
                } else {
                    folderRow = Array.from(els.varTableBody.querySelectorAll('tr[data-is-folder="1"]'))
                        .find(candidate => candidate.dataset.folderPath === row.dataset.folderPath);
                }
                setDropHighlight(folderRow || row);
            } else {
                setDropHighlight(row);
            }
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
        const folderNode = event.target.closest('[data-folder-path]');
        const row = event.target.closest('tr');
        const folder = folderNode
            ? (folderNode.dataset.folderPath || '')
            : (row ? (row.dataset.folderTarget || '') : '');
        sendDroppedFiles(files, folder);
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            if (els.settingsModal && !els.settingsModal.classList.contains('hidden')) {
                closeSettingsModal();
                return;
            }
            if (els.newFolderModal && !els.newFolderModal.classList.contains('hidden')) {
                closeNewFolderModal();
            }
        }
    });
}

initTheme();
applyUrlOverrides();
bindEvents();
loadBuildInfo();
seedSettingsForm();
updateSendFilesButtonState();
updateSelectionActionButtons();
updateKeyControlsState(false);
updateWebUsbSplashState();
autoConnectIfAuthorized();
window.addEventListener('resize', updateScreenshotCanvasScale);

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').then(reg => {
            navigator.serviceWorker.ready.then(() => {
                showOfflineBanner();
            }).catch(() => {
                // best-effort
            });
            reg.addEventListener('updatefound', () => {
                const worker = reg.installing;
                if (!worker) {
                    return;
                }
                worker.addEventListener('statechange', () => {
                    if (worker.state === 'installed' && navigator.serviceWorker.controller) {
                        showOfflineUpdateBanner();
                    }
                });
            });
        }).catch(() => {
            // Offline support is best-effort; ignore registration failures.
        });
    });
}
if (navigator.usb) {
    navigator.usb.addEventListener('disconnect', () => {
        const silent = state.silentReconnectInProgress;
        clearActiveOperations(silent ? undefined : 'Active operation cancelled due to disconnect.');
        state.handle = 0;
        state.cableOpen = false;
        state.authorizedDevice = null;
        state.connectInProgress = false;
        state.handlePromise = null;
        if (!silent) {
            state.module = null;
            state.needsReauthorize = false;
            clearDeviceData();
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
