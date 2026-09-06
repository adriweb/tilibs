/* global TILibsModule */

const TI_VENDOR_ID = 0x0451; // Texas Instruments
const PID_TI84_EVO_SERIAL = 0xE018;
const SERIAL_KIND_EVO = 1;
const SERIAL_KIND_GRAYLINK = 2;
const CABLE_GRAYLINK = '1';
const CABLE_SILVERLINK = '4';
const CABLE_DIRECTLINK = '5';
const DEVICE_FAMILY_TI = 'ti';
const DEVICE_FAMILY_HP_PRIME = 'hp-prime';
const DEVICE_FAMILY_NUMWORKS = 'numworks';
const HP_VENDOR_ID = 0x03F0;
const HP_PRIME_PRODUCT_IDS = new Set([0x0441, 0x1541, 0x2441]);
const NUMWORKS_VENDOR_ID = 0x0483;
const NUMWORKS_PRODUCT_ID = 0xA291;
const HP_PRIME_UPLOAD_EXTENSIONS = new Set([
    'hpapp', 'hplist', 'hpmat', 'hpmatrix', 'hpnote', 'hpprgm',
    'hpappnote', 'hpappprgm', 'hpcomplex', 'hpreal'
]);

// Known TI USB devices
const TI_USB_DEVICES = [
    { productId: 0xE001, name: "TI-GRAPH LINK USB (SilverLink)" },
    { productId: 0xE003, name: "TI-84 Plus Hand-Held" },
    { productId: 0xE004, name: "TI-89 Titanium Hand-Held" },
    { productId: 0xE008, name: "TI-84 Plus Silver Edition Hand-Held" },
 // { productId: 0xE010, name: "TI SmartPad Keyboard" },                    // not for us, acts as an HID keyboard
 // { productId: 0xE011, name: "Nspire CAS+ prototype" },                   // protocol not supported
    { productId: 0xE012, name: "TI-Nspire Hand-Held" },
 // { productId: 0xE013, name: "Network Bridge" },                          // not for us
 // { productId: 0xE016, name: "TI Bluetooth Adapter" },                    // not for us
    { productId: 0xE018, name: "TI-83/84 Evo" },                            // CDC serial: selected through WebUSB, data through WebSerial
    { productId: 0xE01C, name: "Data Collection Sled [Nspire Lab Cradle, Nspire Datatracker Cradle]" },
 // { productId: 0xE01E, name: "Nspire CX Navigator Access Point" },        // not for us
 // { productId: 0xE01F, name: "Python Adapter (firmware install mode)" },  // not for us
 // { productId: 0xE020, name: "Python Adapter" },                          // not for us
    { productId: 0xE022, name: "TI-Nspire CX II Hand-Held" },
];
const TI_USB_PRODUCT_IDS = new Set(TI_USB_DEVICES.map(device => device.productId));

function getWebUsbDeviceFamily(device) {
    if (isHPPrimeDevice(device)) {
        return DEVICE_FAMILY_HP_PRIME;
    }
    if (isNumWorksDevice(device)) {
        return DEVICE_FAMILY_NUMWORKS;
    }
    if (device?.vendorId === TI_VENDOR_ID && TI_USB_PRODUCT_IDS.has(device.productId)) {
        return DEVICE_FAMILY_TI;
    }
    return null;
}

function getSupportedWebUsbFilters() {
    return [
        ...TI_USB_DEVICES.map(device => ({
            vendorId: TI_VENDOR_ID,
            productId: device.productId
        })),
        ...[...HP_PRIME_PRODUCT_IDS].map(productId => ({
            vendorId: HP_VENDOR_ID,
            productId
        })),
        { vendorId: NUMWORKS_VENDOR_ID, productId: NUMWORKS_PRODUCT_ID }
    ];
}

async function requestSupportedWebUsbDevice() {
    if (!navigator.usb) {
        throw new Error(t('numworks_webusb_required'));
    }
    try {
        return await navigator.usb.requestDevice({
            filters: getSupportedWebUsbFilters()
        });
    } catch (error) {
        if (error?.name === 'NotFoundError') {
            console.warn('No supported WebUSB calculator was selected');
            return null;
        }
        console.error('WebUSB device selection failed:', error);
        throw error;
    }
}

async function getAuthorizedSupportedWebUsbDevices() {
    if (!navigator.usb) {
        return [];
    }
    try {
        return (await navigator.usb.getDevices()).filter(device =>
            getWebUsbDeviceFamily(device) !== null
        );
    } catch (error) {
        console.error('Failed to get authorized WebUSB calculators:', error);
        return [];
    }
}

function isHPPrimeDevice(device) {
    return device
        && device.vendorId === HP_VENDOR_ID
        && HP_PRIME_PRODUCT_IDS.has(device.productId);
}

async function requestHPPrimeDevice(discoveryUsbDevice = null) {
    if (!navigator.hid) {
        throw new Error(t('webhid_unsupported_error'));
    }
    if (!self.isSecureContext) {
        throw new Error(t('webhid_secure_context_error'));
    }
    if (discoveryUsbDevice && !isHPPrimeDevice(discoveryUsbDevice)) {
        throw new Error('The selected WebUSB device is not a supported HP Prime.');
    }
    try {
        const productIds = discoveryUsbDevice
            ? [discoveryUsbDevice.productId]
            : [...HP_PRIME_PRODUCT_IDS];
        const devices = await navigator.hid.requestDevice({
            filters: productIds.map(productId => ({
                vendorId: HP_VENDOR_ID,
                productId
            }))
        });
        const device = devices.find(candidate => isHPPrimeDevice(candidate)
            && (!discoveryUsbDevice || candidate.productId === discoveryUsbDevice.productId)) || null;
        if (!device) {
            console.warn('No HP Prime device was selected');
        }
        return device;
    } catch (error) {
        if (error && error.name === 'NotFoundError') {
            console.warn('No HP Prime device was selected');
            return null;
        }
        console.error('WebHID device selection failed:', error);
        throw error;
    }
}

async function getAuthorizedHPPrimeDevices(discoveryUsbDevice = null) {
    if (!navigator.hid) {
        return [];
    }
    try {
        const devices = await navigator.hid.getDevices();
        return devices.filter(device => isHPPrimeDevice(device)
            && (!discoveryUsbDevice || device.productId === discoveryUsbDevice.productId));
    } catch (error) {
        console.error('Failed to get authorized HP Prime devices:', error);
        return [];
    }
}

async function bindHPPrimeDeviceToModule(module, device) {
    if (!module || !isHPPrimeDevice(device)) {
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
            console.warn('[WebTILP] Failed to close the previous HP Prime WebHID device.', error);
        }
    }
    state.device = device;
    state.reportSize = 0;
    module.__hplpWebHID = state;
}

function isNumWorksDevice(device) {
    return globalThis.WebTILPNumWorks?.isNumWorksDevice?.(device)
        ?? Boolean(device
            && device.vendorId === NUMWORKS_VENDOR_ID
            && device.productId === NUMWORKS_PRODUCT_ID);
}

function getNumWorksBackendClass() {
    const Backend = globalThis.WebTILPNumWorks?.NumWorksBackend;
    if (!Backend) {
        throw new Error(t('numworks_backend_load_failed'));
    }
    return Backend;
}

async function requestNumWorksDevice() {
    if (!navigator.usb) {
        throw new Error(t('numworks_webusb_required'));
    }
    if (!self.isSecureContext) {
        throw new Error('WebUSB requires HTTPS or localhost.');
    }
    try {
        const Backend = getNumWorksBackendClass();
        return await Backend.requestDevice();
    } catch (error) {
        if (error?.name === 'NotFoundError') {
            console.warn('No NumWorks calculator was selected');
            return null;
        }
        throw error;
    }
}

async function getAuthorizedNumWorksDevices() {
    if (!navigator.usb) {
        return [];
    }
    const Backend = getNumWorksBackendClass();
    return Backend.getAuthorizedDevices();
}

/**
 * Request access to a TI calculator via WebUSB.
 * This function must be called from a user gesture (e.g., button click).
 *
 * @returns {Promise<USBDevice>} The selected USB device
 * @throws {Error} If the user cancels device selection or WebUSB is not supported
 */
async function requestTICalculatorDevice() {
    // Check if WebUSB is supported
    if (!navigator.usb) {
        throw new Error("WebUSB is not supported in this browser. Please use a recent version of Chrome/Chromium/Edge/Opera.");
    }

    try {
        const device = await navigator.usb.requestDevice({
            filters: TI_USB_DEVICES.map(dev => ({
                vendorId: TI_VENDOR_ID,
                productId: dev.productId
            }))
        });

        console.log("TI device selected:", device.productName || "Unknown device");
        console.log("  Vendor ID:", "0x" + device.vendorId.toString(16).padStart(4, '0'));
        console.log("  Product ID:", "0x" + device.productId.toString(16).padStart(4, '0'));

        return device;
    } catch (error) {
        if (error && error.name === 'NotFoundError') {
            console.warn("No TI device was selected");
            return null;
        }
        console.error("WebUSB device selection failed:", error);
        throw error;
    }
}

/**
 * Get a list of previously authorized TI calculators.
 *
 * @returns {Promise<USBDevice[]>} Array of authorized devices
 */
async function getAuthorizedDevices() {
    if (!navigator.usb) {
        return [];
    }

    try {
        const devices = await navigator.usb.getDevices();
        const tiDevices = devices.filter(device => device.vendorId === TI_VENDOR_ID);

        console.log("Found", tiDevices.length, "authorized TI device(s)");
        tiDevices.forEach((device, index) => {
            console.log(`  [${index}] ${device.productName || 'Unknown'} (PID: 0x${device.productId.toString(16)})`);
        });

        return tiDevices;
    } catch (error) {
        console.error("Failed to get authorized devices:", error);
        return [];
    }
}

function isEvoUsbDevice(device) {
    return device
        && device.vendorId === TI_VENDOR_ID
        && device.productId === PID_TI84_EVO_SERIAL;
}

function serialPortToDevice(port, options = {}) {
    const {
        usbDevice = null,
        serialKind = SERIAL_KIND_EVO,
        productName = 'TI-83/84 Evo',
        vendorId = TI_VENDOR_ID,
        productId = PID_TI84_EVO_SERIAL
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

function isSerialDevice(device = state.authorizedDevice) {
    return device?.transport === 'serial';
}

function isGrayLinkSerialDevice(device = state.authorizedDevice) {
    return isSerialDevice(device) && device.serialKind === SERIAL_KIND_GRAYLINK;
}

function isEvoSerialDeviceInfo(info) {
    return info
        && info.usbVendorId === TI_VENDOR_ID
        && info.usbProductId === PID_TI84_EVO_SERIAL;
}

async function requestTIEvoSerialDevice() {
    if (!navigator.serial) {
        throw new Error('WebSerial is not supported in this browser.');
    }
    if (!self.isSecureContext) {
        throw new Error('WebSerial requires HTTPS or localhost.');
    }
    try {
        const port = await navigator.serial.requestPort({
            filters: [{ usbVendorId: TI_VENDOR_ID, usbProductId: PID_TI84_EVO_SERIAL }]
        });
        return serialPortToDevice(port, { serialKind: SERIAL_KIND_EVO, productName: 'TI-83/84 Evo' });
    } catch (error) {
        if (error && error.name === 'NotFoundError') {
            console.warn('No TI-83/84 Evo serial device was selected');
            return null;
        }
        console.error('WebSerial device selection failed:', error);
        throw error;
    }
}

async function getAuthorizedSerialDevices() {
    if (!navigator.serial) {
        return [];
    }
    try {
        const ports = await navigator.serial.getPorts();
        return ports
            .filter(port => isEvoSerialDeviceInfo(port.getInfo ? port.getInfo() : {}))
            .map(port => serialPortToDevice(port, { serialKind: SERIAL_KIND_EVO, productName: 'TI-83/84 Evo' }));
    } catch (error) {
        console.error('Failed to get authorized serial devices:', error);
        return [];
    }
}

async function getAuthorizedEvoSerialDevice(usbDevice = null) {
    const serialDevices = await getAuthorizedSerialDevices();
    if (!serialDevices || !serialDevices.length) {
        return null;
    }
    if (!usbDevice) {
        return serialDevices[0];
    }
    return serialPortToDevice(serialDevices[0].serialPort, { usbDevice, serialKind: SERIAL_KIND_EVO, productName: 'TI-83/84 Evo' });
}

async function requestEvoSerialForUsbDevice(usbDevice) {
    if (!isEvoUsbDevice(usbDevice)) {
        return usbDevice;
    }
    const authorizedSerial = await getAuthorizedEvoSerialDevice(usbDevice);
    if (authorizedSerial) {
        return authorizedSerial;
    }
    const serialDevice = await requestTIEvoSerialDevice();
    if (!serialDevice) {
        return null;
    }
    serialDevice.productName = usbDevice.productName || serialDevice.productName;
    return serialDevice;
}

async function requestGrayLinkSerialDevice() {
    if (!navigator.serial) {
        throw new Error('WebSerial is not supported in this browser.');
    }
    if (!self.isSecureContext) {
        throw new Error('WebSerial requires HTTPS or localhost.');
    }
    try {
        const port = await navigator.serial.requestPort();
        return serialPortToDevice(port, {
            serialKind: SERIAL_KIND_GRAYLINK,
            productName: 'GrayLink serial (RS232)',
            vendorId: 0,
            productId: 0
        });
    } catch (error) {
        if (error && error.name === 'NotFoundError') {
            console.warn('No GrayLink serial port was selected');
            return null;
        }
        console.error('WebSerial GrayLink selection failed:', error);
        throw error;
    }
}

function bindSerialPortToModule(module, device) {
    if (!module || !isSerialDevice(device) || !device.serialPort) {
        return;
    }
    const current = module.__ticablesWebSerial || {};
    module.__ticablesWebSerial = {
        ...current,
        kind: device.serialKind || SERIAL_KIND_EVO,
        port: device.serialPort
    };
}

function bindEvoSerialPortToModule(module, device) {
    bindSerialPortToModule(module, device);
}

const state = {
    module: null,
    handle: 0,
    activeFamily: DEVICE_FAMILY_TI,
    connected: false,
    cableOpen: false,
    authorizedDevice: null,
    deviceModelName: '',
    deviceInfoProductName: '',
    deviceInfoEntries: [],
    features: 0,
    dirlist: [],
    hpFileSnapshotLoaded: false,
    hpFileRefreshGeneration: 0,
    hpFileRenderGeneration: 0,
    hpPrimeProtocolVersion: null,
    numWorksBackend: null,
    selectedFiles: [],
    logLines: [],
    sort: { key: 'name', dir: 'asc', userDefined: false },
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

const SUPPORTED_LANGUAGES = ['en', 'fr', 'nl', 'it', 'de', 'es', 'pt', 'sv', 'zh', 'ja', 'ar', 'fa', 'la'];
const LANGUAGE_OPTIONS = [
    { value: 'auto', label: 'Auto' },
    { value: 'en', label: 'English' },
    { value: 'fr', label: 'Français' },
    { value: 'nl', label: 'Nederlands' },
    { value: 'it', label: 'Italiano' },
    { value: 'de', label: 'Deutsch' },
    { value: 'es', label: 'Español' },
    { value: 'pt', label: 'Português' },
    { value: 'sv', label: 'Svenska' },
    { value: 'zh', label: '简体中文' },
    { value: 'ja', label: '日本語' },
    { value: 'ar', label: 'العربية' },
    { value: 'fa', label: 'فارسی' },
    { value: 'la', label: 'Latina' }
];

const I18N_EN = {
    "brand_subtitle": "Universal linking, right from your browser!",
    "settings": "Settings",
    "calculator_family": "Calculator family",
    "calculator_family_auto": "Auto-detect (TI or NumWorks)",
    "calculator_family_auto_hint": "TI and NumWorks are detected from one WebUSB chooser. HP Prime uses WebHID and can be selected here when needed.",
    "hp_prime_family_hint": "HP Prime uses WebHID for info, screenshots, backups, and file transfers.",
    "hp_prime_welcome_text": "Plug in your HP Prime, then click \"Connect Calculator\" and authorize it through WebHID.",
    "webhid_unavailable_title": "WebHID is not available in this browser.",
    "hp_prime_webhid_unavailable_text": "HP Prime access requires WebHID in a secure context; use a recent Chromium-based browser.",
    "webhid_unsupported_error": "WebHID is not supported in this browser. Please use a recent Chromium-based browser.",
    "webhid_secure_context_error": "WebHID requires HTTPS or localhost.",
    "transport_secure_context_error": "WebUSB, WebSerial, and WebHID require HTTPS or localhost.",
    "transport_unavailable_error": "WebUSB, WebSerial, and WebHID are not available in this browser.",
    "hp_prime_webhid_only_mode": "WebHID-only mode supports HP Prime calculators.",
    "hp_prime_backup_tooltip": "Download a read-only HP Prime backup ZIP",
    "hp_prime_refresh_tooltip": "Refresh HP Prime files (retrieves a read-only calculator snapshot)",
    "hp_prime_dropzone_title": "Drop HP Prime files to send",
    "hp_prime_dropzone_subtitle": "Supported extensions include .hpprgm, .hpnote, .hpapp, .hplist, and .hpmat",
    "hp_prime_files_title": "HP Prime Files",
    "hp_prime_error_unknown": "unknown HP Prime error",
    "hp_prime_error_code": "HP Prime error {code}",
    "hp_prime_no_device_selected": "No HP Prime selected.",
    "hp_prime_info_unavailable": "HP Prime device info is unavailable.",
    "hp_prime_info_product_name": "Product name",
    "hp_prime_info_firmware_version": "Firmware version",
    "hp_prime_info_build": "Build",
    "hp_prime_info_serial": "Serial",
    "hp_prime_info_protocol": "Protocol",
    "hp_prime_protocol_legacy": "Legacy",
    "hp_prime_info_v2_capable": "V2 capable",
    "yes": "Yes",
    "no": "No",
    "hp_prime_progress_connecting": "Connecting to HP Prime",
    "hp_prime_connection_failed": "HP Prime connection failed: {error}",
    "hp_prime_connected": "Connected to {model} through WebHID.",
    "hp_prime_progress_reconnecting": "Reconnecting to HP Prime",
    "hp_prime_auto_connected": "Auto-connected to authorized HP Prime.",
    "hp_prime_auto_connect_failed": "HP Prime auto-connect failed",
    "hp_prime_info_refreshed": "HP Prime device info refreshed.",
    "hp_prime_progress_loading_files": "Loading HP Prime files",
    "hp_prime_file_listing_failed": "HP Prime file listing failed: {error}.",
    "hp_prime_snapshot_loaded": "HP Prime file snapshot loaded: {count} entries.",
    "hp_prime_key_range": "HP Prime key codes must be between 0 and 50.",
    "hp_prime_key_send_failed": "Failed to send HP Prime key ({error}).",
    "hp_prime_key_sent": "Sent HP Prime key {key} (0x{hex}).",
    "hp_prime_confirm_unchecked_overwrite": "The HP Prime file list has not been refreshed, so WebTILP cannot detect overwrites. Sending may replace an item with the same name and type. Continue?",
    "hp_prime_upload_cancelled": "HP Prime upload cancelled before overwrite preflight.",
    "hp_prime_unsupported_file": "Unsupported HP Prime filename or extension: {file}.",
    "hp_prime_confirm_overwrite": "\u201c{file}\u201d will replace the existing HP Prime item \u201c{existing}\u201d. Continue?",
    "hp_prime_overwrite_skipped": "Skipped {file}; overwrite was not confirmed.",
    "hp_prime_progress_sending_file": "Sending {file} to HP Prime",
    "hp_prime_file_sent": "Sent {file} to HP Prime.",
    "hp_prime_file_send_failed": "Failed to send {file} to HP Prime: {error}.",
    "hp_prime_progress_receiving_backup": "Receiving HP Prime backup",
    "hp_prime_backup_failed": "HP Prime backup failed: {error}.",
    "hp_prime_backup_received": "HP Prime read-only backup ZIP received; file snapshot synchronized ({count} entries).",
    "hp_prime_missing_cache_index": "No cached HP Prime file index for {name}. Refresh the file list.",
    "hp_prime_confirm_invalid_crc": "\u201c{name}\u201d failed CRC validation and may be corrupt. Download the cached data anyway?",
    "hp_prime_invalid_crc_skipped": "Skipped {name}; CRC-invalid download was not confirmed.",
    "hp_prime_cached_download_failed": "HP Prime cached file download failed: {error}",
    "hp_prime_text_preview_invalid": "The HP Prime text file has an incomplete UTF-16LE code unit.",
    "hp_prime_png_preview_invalid": "The HP Prime PNG file has an invalid signature.",
    "hp_prime_file_received": "Received {file} from HP Prime.",
    "hp_prime_file_download_failed_context": "Failed to receive {name} from HP Prime",
    "hp_prime_download_failed": "HP Prime download failed",
    "hp_prime_app_descriptor": "Application descriptor",
    "hp_prime_app_note": "Application note data",
    "hp_prime_app_program": "Application program data",
    "hp_prime_app_resource": "Application resource",
    "hp_prime_app_invalid_container": "Application contents could not be parsed; whole-app download remains available.",
    "hp_prime_app_folder_hint": "Expand to browse; drop files onto this application to add or replace resources.",
    "hp_prime_app_snapshot_required": "Wait for the HP Prime file snapshot to finish before modifying application contents.",
    "hp_prime_app_core_read_only": "The application descriptor, note, and program parts are read-only here.",
    "hp_prime_app_progress_updating": "Updating {app} application contents",
    "hp_prime_app_rename_failed": "Failed to rename the application resource: {error}.",
    "hp_prime_app_resource_renamed": "Renamed {old} to {name} inside {app}.",
    "hp_prime_app_delete_failed": "Failed to delete the application resource: {error}.",
    "hp_prime_app_resource_deleted": "Deleted {name} from {app}.",
    "hp_prime_app_resource_too_large": "The application resource batch is too large.",
    "hp_prime_app_resource_skipped": "Skipped duplicate or unnamed application resource {file}.",
    "hp_prime_app_core_upload_rejected": "Skipped {file}; core application parts cannot be replaced here.",
    "hp_prime_app_confirm_resource_overwrite": "{file} already exists inside {app}. Replace it?",
    "hp_prime_app_upload_failed": "Failed to update {app}: {error}.",
    "hp_prime_app_resources_sent": "Added or replaced {count} resource(s) inside {app}.",
    "hp_prime_app_upload_failed_short": "HP Prime application resource upload failed",
    "hp_prime_progress_receiving_screenshot": "Receiving HP Prime screenshot",
    "hp_prime_screenshot_failed": "HP Prime screenshot failed: {error}.",
    "hp_prime_screenshot_captured": "HP Prime screenshot captured ({width}x{height}).",
    "numworks_family_hint": "NumWorks uses WebUSB/DFU for device info and Python script storage.",
    "numworks_welcome_text": "Open USB mode on your NumWorks, then click \"Connect Calculator\" and authorize it through WebUSB.",
    "numworks_webusb_unavailable_text": "NumWorks access requires WebUSB in a secure context; use a recent Chromium-based browser.",
    "numworks_backend_load_failed": "The NumWorks WebUSB backend failed to load.",
    "numworks_webusb_required": "NumWorks access requires WebUSB in a recent Chromium-based browser.",
    "numworks_screenshot_unavailable": "NumWorks USB mode does not expose screenshots.",
    "numworks_backup_tooltip": "Download a read-only backup of the complete NumWorks storage image",
    "numworks_refresh_tooltip": "Refresh NumWorks Python scripts",
    "numworks_dropzone_title": "Drop Python scripts to send",
    "numworks_dropzone_subtitle": "NumWorks accepts .py scripts; names are normalized to Epsilon-compatible lowercase names.",
    "numworks_scripts_title": "NumWorks Python Scripts",
    "numworks_no_device_selected": "No NumWorks calculator selected.",
    "numworks_type_python_auto": "Python script (auto-import)",
    "numworks_type_python": "Python script",
    "numworks_info_unavailable": "NumWorks device information is unavailable.",
    "numworks_info_product_name": "Product name",
    "numworks_info_usb_product": "USB product",
    "numworks_info_firmware_version": "Firmware version",
    "numworks_info_commit": "Commit",
    "numworks_info_mode": "Mode",
    "numworks_info_slot": "Slot",
    "numworks_info_serial": "Serial",
    "numworks_info_transfer_size": "DFU transfer size",
    "numworks_info_storage_integrity": "Storage integrity",
    "numworks_info_preserved_records": "Preserved non-script records",
    "valid": "Valid",
    "warning": "Warning",
    "numworks_storage_summary": "Storage {used} / {total}",
    "numworks_storage_usage": "{used}B used; {free}B free; {total}B capacity",
    "numworks_storage_unreadable": "Storage unreadable — raw backup available",
    "numworks_storage_parse_failed": "The NumWorks storage image could not be parsed.",
    "numworks_connected": "Connected to {model} through WebUSB/DFU; {count} Python script(s) loaded.",
    "numworks_storage_recovery_warning": "NumWorks script storage is damaged or full; mutations are disabled, but a raw backup is still available.",
    "numworks_auto_connected": "Auto-connected to authorized NumWorks calculator.",
    "numworks_auto_connect_failed": "NumWorks auto-connect failed",
    "numworks_info_refreshed": "NumWorks device info refreshed.",
    "numworks_scripts_refreshed": "NumWorks script storage refreshed: {count} Python script(s).",
    "numworks_malformed_record": "Malformed Python storage record",
    "numworks_keys_unavailable": "NumWorks USB mode does not expose remote key injection.",
    "numworks_dropped_upload_failed": "Dropped NumWorks script upload failed",
    "numworks_backend_not_connected": "NumWorks backend is not connected.",
    "numworks_unsupported_file": "Unsupported NumWorks file {file}; only .py scripts can be sent.",
    "numworks_duplicate_normalized": "Multiple selected files normalize to {name}.py.",
    "numworks_confirm_overwrite": "“{file}” will replace the existing NumWorks script “{name}.py”. Continue?",
    "numworks_overwrite_skipped": "Skipped {file}; overwrite was not confirmed.",
    "numworks_name_normalized": "NumWorks script name normalized: {file} → {name}.py.",
    "numworks_no_supported_scripts": "No supported NumWorks scripts were selected.",
    "numworks_scripts_sent": "Sent {count} Python script(s) to NumWorks storage.",
    "numworks_upload_failed": "NumWorks script upload failed",
    "numworks_backup_received": "NumWorks read-only storage backup received ({size} bytes).",
    "numworks_file_received": "Received {file} from NumWorks storage.",
    "numworks_receive_selected_failed": "NumWorks receive selected failed",
    "numworks_scripts_deleted": "Deleted {count} NumWorks script(s).",
    "numworks_script_renamed": "Renamed {old}.py to {name}.py.",
    "numworks_script_deleted": "Deleted {name}.py from NumWorks storage.",
    "numworks_download_failed": "NumWorks download failed",
    "connect_calculator": "Connect Calculator",
    "welcome_title": "Welcome to WebTILP!",
    "welcome_text": "Plug in your calculator, then click \"Connect Calculator\"; WebTILP will detect its family automatically.",
    "webusb_unavailable_title": "WebUSB is not available in this browser.",
    "webusb_unavailable_text": "Please use a WebUSB-compatible browser like Chrome, Edge, or Brave.",
    "webserial_only_title": "WebUSB is not available; WebSerial support only.",
    "webserial_only_text": "This browser supports WebSerial, so WebTILP can connect to TI-83/84 Evo calculators or an explicitly selected GrayLink serial cable. Use a WebUSB-enabled browser for all USB calculators.",
    "device": "Device",
    "model": "Model",
    "free_memory": "Free Memory",
    "refresh_device_info": "Refresh Device Info",
    "sync_clock": "Sync Clock",
    "transfers": "Transfers",
    "is_ready": "Is Ready",
    "dropzone_title": "Drop files to send",
    "dropzone_subtitle": "Make sure to select appropriate TI files",
    "send_selected_files": "Send Selected Files",
    "make_backup": "Make Backup",
    "receive_os": "Receive OS",
    "download_os_so_far": "Download OS so far",
    "dump_rom": "Dump ROM",
    "leave_exam_mode": "Leave exam mode",
    "remote_keys": "Remote Key/Action send",
    "key_input_placeholder": "Key name or code (hex/dec)",
    "send_key": "Send Key",
    "calculator_variables": "Calculator Variables",
    "preview": "Preview",
    "reindent": "Reindent",
    "download": "Download",
    "filter_name_or_type": "Filter name or type",
    "refresh_list": "Refresh List",
    "new_folder": "New Folder",
    "receive_selected": "Receive Selected",
    "delete_selected": "Delete Selected",
    "name": "Name",
    "type": "Type",
    "size": "Size",
    "location": "Location",
    "folder": "Folder",
    "kind": "Kind",
    "screenshot": "Screenshot",
    "take_screenshot": "Take Screenshot",
    "download_png": "Download PNG",
    "activity_log": "Activity Log",
    "clear_log": "Clear Log",
    "settings_title": "Settings",
    "cable": "Cable",
    "force_cable_hint": "Force cable to skip probing.",
    "calculator_model": "Calculator model",
    "auto_probe_hint": "Auto uses probing to detect the model.",
    "silverlink_hint": "SilverLink requires manual model selection.",
    "graylink_hint": "GrayLink requires manual model selection and a WebSerial RS232 adapter.",
    "cable_timeout": "Cable timeout (1/10s)",
    "cable_delay": "Cable delay (us)",
    "language": "Language",
    "convert_python_files": "Convert Python files (.py <-> calculator format)",
    "convert_python_files_nspire": "Convert Python files (.py -> .tns)",
    "settings_note": "Changing settings resets the current handle. Reconnect for full effect.",
    "offline_ready": "This app can now run without a network connection.",
    "offline_update_available": "An update is available. Reload to use the latest version.",
    "reload_for_update": "Reload for update",
    "clear_offline_cache": "Clear offline cache",
    "update_available": "Update available",
    "reset_defaults": "Reset Defaults",
    "save_settings": "Save Settings",
    "transfer_options": "Transfer Options",
    "transfer_note": "Location/folder options depend on calculator capabilities. Existing variables are overwritten only if confirmed.",
    "transfer_overwrite_all": "Overwrite all existing items (no per-file confirmation)",
    "transfer_all_ram": "All RAM",
    "transfer_all_archive": "All Archive",
    "file": "File",
    "variable": "Variable",
    "cancel": "Cancel",
    "start_transfer": "Start Transfer",
    "create_folder": "Create Folder",
    "folder_name": "Folder name",
    "parent_folder": "Parent folder",
    "new_folder_placeholder": "New folder name",
    "new_folder_note": "Pick a parent folder or root to create a top-level folder.",
    "create": "Create",
    "backup_options": "Backup Options",
    "backup_format": "Backup format",
    "standard_backup_file": "Standard backup file",
    "tigroup": "TIGroup (.tig)",
    "include_in_tigroup": "Include in TIGroup",
    "ram": "RAM",
    "archive": "Archive",
    "flash_apps": "Flash apps",
    "backup_note": "Standard backups may fail on large memory contents. TIGroup is recommended for big backups.",
    "loading_dirlist": "Loading directory listing...",
    "create_backup": "Create Backup",
    "theme_prefix": "Theme",
    "theme_dark_modern": "Dark Modern",
    "theme_light_modern": "Light Modern",
    "theme_retro": "Retro Terminal",
    "auto": "Auto",
    "directlink_usb": "DirectLink USB",
    "silverlink_usb": "SilverLink (Graph Link USB)",
    "idle": "Idle",
    "error_title": "Error",
    "notice_title": "Notice",
    "status_loading_module": "Loading module...",
    "status_module_ready": "WebTILP ready",
    "status_connected": "Connected",
    "status_connection_failed": "Connection failed",
    "status_disconnected": "Disconnected",
    "status_device_connected": "Device connected",
    "status_webusb_unsupported": "WebUSB unsupported",
    "status_webserial_only": "WebSerial-only mode",
    "status_insecure_context": "Insecure context",
    "status_connection_lost": "Connection lost",
    "status_select_device": "Select device to continue",
    "unknown": "Unknown",
    "root": "(root)",
    "force_disconnect_reset": "Force disconnect and reset",
    "alert_unknown_cable_param": "Unknown cable URL parameter: {value}",
    "alert_unknown_calc_param": "Unknown calc URL parameter: {value}",
    "alert_failed_resolve_calc_param": "Failed to resolve calc URL parameter: {value}",
    "alert_invalid_timeout_param": "Invalid timeout URL parameter: {value}",
    "alert_invalid_delay_param": "Invalid delay URL parameter: {value}",
    "alert_unknown_theme_param": "Unknown theme URL parameter: {value}",
    "alert_silverlink_model_required": "SilverLink detected. Please choose a calculator model in Settings before connecting.",
    "alert_silverlink_choose_model": "SilverLink requires choosing a calculator model.",
    "alert_graylink_model_required": "GrayLink requires choosing a calculator model in Settings before connecting.",
    "alert_bundle_only_files": "Please transfer bundle files by themselves.",
    "alert_bundle_one_at_a_time": "Please transfer one bundle file at a time.",
    "alert_bundle_ce_only": "This bundle can only be installed on TI-84 Plus CE / TI-83 Premium CE calculators.",
    "alert_bundle_no_transferable_files": "Bundle archive contains no transferable files.",
    "alert_select_file_to_transfer": "Select at least one file to transfer.",
    "alert_cannot_overwrite_locked": "Cannot overwrite {name} because it is locked/archived. Unarchive/unlock it on the calculator and retry.",
    "alert_failed_clear_attributes": "Failed to clear attributes for {name} ({error}).",
    "alert_failed_delete_existing": "Failed to delete existing {name} ({error}).",
    "confirm_switch_to_silverlink": "A SilverLink cable is connected but Settings force DirectLink. Switch to SilverLink and choose a model?",
    "confirm_switch_to_directlink": "A DirectLink calculator is connected but Settings force SilverLink. Switch to DirectLink?",
    "confirm_replug_after_device_info": "You will have to physically unplug and replug the cable after that. Continue?",
    "confirm_load_dirlist_before_transfer": "Directory listing has not been loaded yet. It is highly recommended before transfers. Load it now?",
    "confirm_overwrite_existing": "{name} already exists there. Overwrite?",
    "confirm_cross_model_evo_os": "The file {file} is for {source}, but the connected calculator expects an OS for {target}. Sending an OS for another model may fail. Continue anyway?",
    "confirm_large_backup_continue_standard": "Backup data may exceed 65535 bytes and fail. TIGroup is recommended for large backups. Continue with standard backup anyway?",
    "confirm_receive_os_notice": "This will receive the TI-Nspire OS from the calculator. It should take a few minutes.\nYou will then be prompted to save the OS file on your computer.\nTo begin the process, on your Nspire, press [on] then [2] then [menu] then [A] (\"Send OS\").\nOnce done, confirm here / press OK to continue.",
    "confirm_dump_rom_notice": "ROM contents are copyrighted by Texas Instruments.\nYou are not allowed to copy and/or distribute ROM images.\nProceed only if you understand the legal restrictions.\n\nThis will send a dumper program to the calculator and then read back the ROM.\nContinue?",
    "confirm_download_items_from_folders": "Download {items} item(s) from {folders} folder(s)?",
    "confirm_delete_items": "Delete {count} item(s) from the calculator?",
    "confirm_delete_entry": "Delete {kind} {name}?",
    "confirm_download_items_from_target": "Download {count} item(s) from {target}?",
    "prompt_rename_entry": "Rename {kind}:",
    "kind_folder": "folder",
    "kind_item": "item",
    "close": "Close"
};

const LOCALE_CACHE = new Map([['en', I18N_EN]]);
const LOCALE_BASE_PATH = 'i18n';

async function loadLocaleDictionary(language) {
    const lang = normalizeLanguageCode(language) || 'en';
    if (LOCALE_CACHE.has(lang)) {
        return LOCALE_CACHE.get(lang);
    }
    try {
        const response = await fetch(`${LOCALE_BASE_PATH}/${lang}.json`, { cache: 'no-store' });
        if (!response.ok) {
            throw new Error(`HTTP \${response.status}`);
        }
        const data = await response.json();
        LOCALE_CACHE.set(lang, data || {});
        return data || {};
    } catch (err) {
        console.warn('[WebTILP] Failed to load locale', lang, err);
        LOCALE_CACHE.set(lang, {});
        return {};
    }
}


const STATUS_I18N_KEYS = new Set([
    'status_loading_module',
    'status_module_ready',
    'status_connected',
    'status_connection_failed',
    'status_disconnected',
    'status_device_connected',
    'status_webusb_unsupported',
    'status_webserial_only',
    'status_insecure_context',
    'status_connection_lost',
    'status_select_device',
    'idle'
]);

function normalizeLanguageCode(code) {
    const raw = String(code || '').trim().toLowerCase();
    if (!raw) {
        return null;
    }
    if (raw === 'zh' || raw.startsWith('zh-') || raw.startsWith('zh_')) {
        return 'zh';
    }
    const base = raw.split(/[-_]/)[0];
    if (SUPPORTED_LANGUAGES.includes(raw)) {
        return raw;
    }
    if (SUPPORTED_LANGUAGES.includes(base)) {
        return base;
    }
    return null;
}

function detectBrowserLanguage() {
    const candidates = [];
    if (Array.isArray(navigator.languages)) {
        candidates.push(...navigator.languages);
    }
    if (navigator.language) {
        candidates.push(navigator.language);
    }
    for (const candidate of candidates) {
        const normalized = normalizeLanguageCode(candidate);
        if (normalized) {
            return normalized;
        }
    }
    return 'en';
}

function resolveUiLanguage(configuredLanguage) {
    const normalizedConfigured = normalizeLanguageCode(configuredLanguage);
    if (normalizedConfigured && normalizedConfigured !== 'auto') {
        return normalizedConfigured;
    }
    return detectBrowserLanguage();
}

function t(key) {
    const language = state.uiLanguage || 'en';
    const locale = LOCALE_CACHE.get(language);
    if (locale && Object.prototype.hasOwnProperty.call(locale, key)) {
        return locale[key];
    }
    if (Object.prototype.hasOwnProperty.call(I18N_EN, key)) {
        return I18N_EN[key];
    }
    return key;
}

function tFormat(key, vars = {}) {
    let text = String(t(key));
    for (const [name, value] of Object.entries(vars)) {
        text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
}

function getOptionLabel(option) {
    if (option.labelKey) {
        return t(option.labelKey);
    }
    return option.label;
}

function getOptionLabels(option) {
    const labels = [];
    if (option.label) {
        labels.push(String(option.label));
    }
    if (option.labelKey) {
        labels.push(String(t(option.labelKey)));
        const englishLabel = I18N_EN?.[option.labelKey];
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

function setButtonText(element, text) {
    if (!element) {
        return;
    }
    const dot = element.querySelector('.settings-update-dot');
    element.textContent = text;
    if (dot) {
        element.appendChild(dot);
    }
}

function getStatusTranslationKey(text) {
    const raw = String(text || '').trim();
    if (!raw) {
        return null;
    }
    return STATUS_I18N_KEYS.has(raw) ? raw : null;
}

function applyStatusTranslation(text, key = null) {
    const resolvedKey = key || getStatusTranslationKey(text);
    if (!resolvedKey) {
        return text;
    }
    return t(resolvedKey);
}

function syncStatusTranslation(text) {
    if (!els.statusText) {
        return;
    }
    const key = getStatusTranslationKey(text) || getStatusTranslationKey(els.statusText.dataset.i18nKey);
    if (key) {
        els.statusText.dataset.i18nKey = key;
        els.statusText.textContent = applyStatusTranslation(key, key);
        return;
    }
    delete els.statusText.dataset.i18nKey;
    els.statusText.textContent = text;
}

const CCALL_TIMEOUT_MS = 12000;
const CCALL_MIN_GAP_MS = 100;
const SUSPENDED_CCALL_GRACE_MS = 20000;
const CREATE_HANDLE_RETRY_DELAY_MS = 300;
const PROGRESS_IDLE_TIMEOUT_MS = 5000;
const AUTO_QUERY_DELAY_MS = 500;
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

function hasWebUsbTransport() {
    return Boolean(navigator.usb && self.isSecureContext);
}

function hasEvoWebSerialTransport() {
    return Boolean(navigator.serial && self.isSecureContext);
}

function hasHPPrimeWebHidTransport() {
    return Boolean(navigator.hid && self.isSecureContext);
}

function hasNumWorksWebUsbTransport() {
    return Boolean(navigator.usb && self.isSecureContext && globalThis.WebTILPNumWorks);
}

function hasAnySupportedTransport() {
    return hasWebUsbTransport() || hasEvoWebSerialTransport()
        || hasHPPrimeWebHidTransport() || hasNumWorksWebUsbTransport();
}

function showToast(message, type = 'error') {
    if (!els.toastContainer) {
        return;
    }
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const title = type === 'error' ? t('error_title') : t('notice_title');
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
    let label = raw ? `0x${raw.toString(16).toUpperCase().padStart(4, '0')}` : `${numericCode}`;
    if (raw && numericCode === TICALCS_EVO_ERROR) {
        const wireCode = String.fromCharCode((raw >> 8) & 0xFF, raw & 0xFF);
        if (/^[A-Z]{2}$/.test(wireCode)) {
            label = wireCode;
        }
    }
    if (!message) {
        const fallback = getFallbackErrorMessage(numericCode);
        return fallback ? `error ${label}: ${fallback}` : `error ${label}`;
    }
    const firstLine = message.split('\n').map(line => line.trim()).find(Boolean) || message;
    const cleaned = firstLine.replace(/^Msg:\s*/i, '').replace(/\.$/, '');
    if (numericCode === TICALCS_EVO_ERROR) {
        const match = cleaned.match(/^TI-Evo Kermit result [A-Z]{2}\s+\((.+)\)$/i);
        if (match) {
            return `${label} (${match[1]})`;
        }
    }
    return `error ${label}: ${cleaned}`;
}

function formatHPPrimeError(module, code) {
    if (code === null || code === undefined || Number.isNaN(Number(code))) {
        return t('hp_prime_error_unknown');
    }
    const numericCode = Number(code);
    let message = '';
    try {
        message = module?.ccall('hp_prime_get_error_message', 'string',
            ['number'], [numericCode]) || '';
    } catch (err) {
        console.warn('[WebTILP] Failed to resolve HP Prime error message', err);
    }
    return message ? `${message} (${numericCode})`
        : tFormat('hp_prime_error_code', { code: numericCode });
}

function clearNativeWarnings() {
    if (state.module) {
        try {
            state.module.ccall('clear_native_warnings', 'void', [], []);
        } catch {
            // Older builds may not expose native warning capture yet.
        }
    }
}

function getNativeWarningSuffix(handledErrorCode = null) {
    const warnings = [];
    if (state.module) {
        try {
            const nativeWarnings = state.module.ccall('get_native_warnings', 'string', [], []);
            if (nativeWarnings) {
                warnings.push(...nativeWarnings.split(/\n+/));
            }
        } catch {
            // Older builds may not expose native warning capture yet.
        }
    }
    const unique = [];
    const isHandledEvoError = Number(handledErrorCode) === TICALCS_EVO_ERROR;
    for (const warning of warnings) {
        const text = String(warning || '').trim();
        if (isHandledEvoError && text.startsWith('TI-Evo Kermit E packet')) {
            continue;
        }
        if (text && !unique.includes(text)) {
            unique.push(text);
        }
    }
    return unique.length ? ` Details: ${unique.join(' ')}` : '';
}

function makeModulePrintHandlers(touchProgress = null) {
    return {
        print: (...args) => {
            if (touchProgress) {
                touchProgress();
            }
            console.log(...args);
        },
        printErr: (...args) => {
            if (touchProgress) {
                touchProgress();
            }
            console.error(...args);
        }
    };
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
    retireModule(state.module, String(err?.message || err || 'fatal WASM runtime error'));
    clearActiveOperations();
    // Do not call back into WASM after a fatal runtime error.
    state.module = null;
    state.handle = 0;
    state.cableOpen = false;
    state.handlePromise = null;
    state.connectInProgress = false;
    state.silentReconnectInProgress = false;
    setConnected(false);
    setStatus('status_connection_lost', false);
    log('Connection lost due to calculator reset/disconnect. Please reconnect.');
}

/**
 * Per-module Asyncify call bookkeeping. Asyncify supports a single suspended
 * call at a time, so every async ccall is serialized through `tail`, and a
 * call abandoned by the JS side (timeout) keeps the module blocked until the
 * underlying call actually returns. `markDead` permanently retires the module
 * (suspended call that never returned, fatal runtime error, teardown) so
 * queued and future callers fail fast instead of re-entering suspended WASM.
 * @param {any} module
 */
function getModuleCallState(module) {
    let cs = module.__ccallState;
    if (!cs) {
        let signalDead = null;
        const deadSignal = new Promise(resolve => {
            signalDead = resolve;
        });
        cs = {
            tail: Promise.resolve(),
            dead: false,
            deadReason: '',
            deadSignal,
            markDead(reason) {
                if (!cs.dead) {
                    cs.dead = true;
                    cs.deadReason = reason || 'module retired';
                    signalDead();
                }
            }
        };
        module.__ccallState = cs;
    }
    return cs;
}

function makeModuleDeadError(cs) {
    const err = new Error(`WASM module needs reinitialization (${cs.deadReason}). Please reconnect.`);
    err.wasmModuleDead = true;
    return err;
}

function retireModule(module, reason) {
    if (module) {
        getModuleCallState(module).markDead(reason);
    }
}

/**
 * Called when a JS-side timeout fired while the underlying WASM call is still
 * suspended inside Asyncify. The call cannot be cancelled from JS; if it does
 * not return within a grace period, the module is unusable and must be
 * reinitialized.
 * @param {any} module
 * @param {string} name
 * @param {Promise<any>} underlying
 */
function watchAbandonedCcall(module, name, underlying) {
    const cs = getModuleCallState(module);
    let settled = false;
    underlying.then(() => { settled = true; }, () => { settled = true; });
    console.warn(`[WebTILP] ${name} timed out on the JS side but is still running in the WASM module; blocking further WASM calls until it returns.`);
    setTimeout(() => {
        if (settled || cs.dead) {
            return;
        }
        const err = new Error(`${name} never returned; the WASM module is stuck in a suspended Asyncify call`);
        cs.markDead(err.message);
        if (state.module === module) {
            handleFatalWasmRuntimeError(err);
        }
    }, SUSPENDED_CCALL_GRACE_MS);
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {string} label
 * @param {number|null} timeoutMs
 * @returns {Promise<T>}
 */
async function withTimeout(promise, label, timeoutMs = CCALL_TIMEOUT_MS) {
    if (timeoutMs === null) {
        return promise;
    }

    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const err = new Error(`${label} timed out`);
            err.ccallTimeout = true;
            reject(err);
        }, timeoutMs);
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
            const timeoutErr = new Error(`${label} timed out`);
            timeoutErr.ccallTimeout = true;
            throw timeoutErr;
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
    const cs = getModuleCallState(module);
    const throwIfDead = () => {
        if (cs.dead) {
            throw makeModuleDeadError(cs);
        }
    };
    throwIfCancelled();
    throwIfDead();
    // Strict FIFO: take a slot on the module's Asyncify call chain. The slot is
    // released when the underlying WASM call settles — not when a JS-side
    // timeout gives up on it — because Asyncify cannot be re-entered while a
    // call is suspended.
    const prev = cs.tail;
    let release;
    cs.tail = new Promise(resolve => {
        release = resolve;
    });
    let entered = false;
    try {
        await Promise.race([prev, cs.deadSignal]);
        throwIfCancelled();
        throwIfDead();
        const now = Date.now();
        const gap = state.lastCcallTs ? (now - state.lastCcallTs) : CCALL_MIN_GAP_MS;
        if (gap < CCALL_MIN_GAP_MS) {
            await sleep(CCALL_MIN_GAP_MS - gap);
            throwIfCancelled();
            throwIfDead();
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
                cs.markDead(String(err?.message || err));
                handleFatalWasmRuntimeError(err);
            }
            throw err;
        }
        entered = true;
        let settled = false;
        const underlying = Promise.resolve(result);
        underlying.then(
            () => { settled = true; release(); },
            () => { settled = true; release(); }
        );
        const noteAbandonedIfPending = err => {
            if (err?.ccallTimeout && !settled) {
                watchAbandonedCcall(module, name, underlying);
            }
        };
        if (!useProgress) {
            try {
                const value = await withTimeout(underlying, name, timeoutMs);
                throwIfCancelled();
                return value;
            } catch (err) {
                noteAbandonedIfPending(err);
                throwIfCancelled();
                if (isFatalWasmRuntimeError(err)) {
                    cs.markDead(String(err?.message || err));
                    handleFatalWasmRuntimeError(err);
                }
                throw err;
            }
        }
        startProgress(progressLabel);
        try {
            const value = await withProgressTimeout(underlying, progressLabel, timeoutMs);
            throwIfCancelled();
            return value;
        } catch (err) {
            noteAbandonedIfPending(err);
            throwIfCancelled();
            if (isFatalWasmRuntimeError(err)) {
                cs.markDead(String(err?.message || err));
                handleFatalWasmRuntimeError(err);
            }
            throw err;
        } finally {
            stopProgress(progressLabel);
        }
    } finally {
        if (!entered) {
            // Never entered WASM: our slot must not unblock the chain ahead of
            // the previous call, so forward its completion instead.
            prev.then(release, release);
        }
    }
}

const SETTINGS_DEFAULTS = {
    cableModel: 'auto',
    calcModel: 'auto',
    cableTimeout: 50,
    cableDelay: 10,
    language: 'auto',
    convertPythonFiles: true
};

const CABLE_OPTIONS = [
    { value: 'auto', label: 'Auto' },
    { value: CABLE_DIRECTLINK, label: 'DirectLink USB' },
    { value: CABLE_SILVERLINK, label: 'SilverLink (Graph Link USB)' },
    { value: CABLE_GRAYLINK, label: 'GrayLink serial (RS232)' }
];

const SILVERLINK_CALC_VALUES = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 16, 17]);
const DIRECTLINK_CALC_VALUES = new Set([13, 14, 15, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 43, 44, 45]);

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
    { value: 42, label: 'TI Presenter' },
    { value: 43, label: 'TI-84 Evo' },
    { value: 44, label: 'TI-84 Evo-T' },
    { value: 45, label: 'TI-83 Evo' }
];

const CE_PYTHON_CALC_MODELS = new Map([
    [19, '83PCEEP'],
    [20, '84+CEPy'],
    [36, '82AEP']
]);
const EVO_PYTHON_CALC_MODELS = new Map([
    [43, '84Evo'],
    [44, '84Evo'],
    [45, '84Evo']
]);
const NSPIRE_CXII_PYTHON_CALC_MODELS = new Set([32, 33, 34, 35]);
const TIVARS_PREVIEW_CALC_MODELS = new Set([
    1, 2, 3, 4, 5, 13, 17, 18, 19, 20, 21, 22, 36, 43, 44, 45
]);
const TIVARS_LEGACY_PREVIEW_TYPES = new Set([
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
    0x0B, 0x0C, 0x0D, 0x0F, 0x10, 0x11, 0x15, 0x17, 0x18,
    0x1A, 0x1B, 0x1C, 0x1D, 0x1E, 0x1F, 0x20, 0x21
]);
const TIVARS_EVO_PREVIEW_TYPES = new Set([
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15
]);
const TIVARS_LEGACY_BASIC_PROGRAM_TYPES = new Set([0x05, 0x06]);
const TIVARS_EVO_BASIC_PROGRAM_TYPES = new Set([2]);
const TIVARS_LEGACY_BASIC_SYNTAX_TYPES = new Set([
    0x01, 0x02, 0x03, 0x05, 0x06, 0x0B, 0x0D
]);
const TIVARS_EVO_BASIC_SYNTAX_TYPES = new Set([1, 2, 6, 7]);
const HP_PRIME_TEXT_PREVIEW_EXTENSIONS = new Set([
    'hpappnote', 'hpappprgm', 'hpprgm'
]);
const PYTHON_CONVERSION_NONE = 0;
const PYTHON_CONVERSION_CE = 1;
const PYTHON_CONVERSION_EVO = 2;
const PYTHON_CONVERSION_NSPIRE_CXII = 3;
const LEGACY_TIVARS_EXTENSION_RE = /^8(?:2|3|x|c)[a-z]$/i;
const LEGACY_TIVARS_FLASH_EXTENSIONS = new Set([
    '82u', '8xu', '8cu', '8eu', '8pu', '8yu',
    '8xk', '8ck', '8ek', '8xq', '8cq'
]);

const PID_SILVERLINK = 0xe001;
const DIRECTLINK_PIDS = new Set([
    0xe003,
    0xe004,
    0xe008,
    0xe012,
    0xe018, // PID_TI84_EVO_SERIAL
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

// HP Prime physical key IDs, independently cross-checked against the public
// PrimeWeb map and the EC key example in debrouxl/hplp issue #6.
const KEYMAP_HP_PRIME = {
    "APPS": 0, "SYMB": 1, "UP": 2, "HELP": 3, "ESC": 4,
    "HOME": 5, "PLOT": 6, "LEFT": 7, "RIGHT": 8, "VIEW": 9,
    "CAS": 10, "NUM": 11, "DOWN": 12, "MENU": 13, "VARS": 14,
    "TOOLBOX": 15, "SQRT": 16, "X": 17, "ABC": 18,
    "BACKSPACE": 19, "POWER": 20, "SIN": 21, "COS": 22, "TAN": 23,
    "LN": 24, "LOG": 25, "SQUARE": 26, "PLUS_MINUS": 27,
    "PARENTHESES": 28, "COMMA": 29, "ENTER": 30, "EEX": 31,
    "NUM_7": 32, "NUM_8": 33, "NUM_9": 34, "DIVIDE": 35, "ALPHA": 36,
    "NUM_4": 37, "NUM_5": 38, "NUM_6": 39, "MULTIPLY": 40, "SHIFT": 41,
    "NUM_1": 42, "NUM_2": 43, "NUM_3": 44, "MINUS": 45, "ON": 46,
    "NUM_0": 47, "POINT": 48, "SPACE": 49, "PLUS": 50
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

const KEYMAP_HP_PRIME_ENTRIES = Object.entries(KEYMAP_HP_PRIME);
const KEYMAP_HP_PRIME_BY_NAME = new Map();
for (const [name, code] of KEYMAP_HP_PRIME_ENTRIES) {
    KEYMAP_HP_PRIME_BY_NAME.set(name.toLowerCase(), code);
}

const KEYMAP_CONFIG_8X = { entries: KEYMAP_8X_ENTRIES, byName: KEYMAP_8X_BY_NAME, listId: 'keyMap834' };
const KEYMAP_CONFIG_86 = { entries: KEYMAP_86_ENTRIES, byName: KEYMAP_86_BY_NAME, listId: 'keyMap86' };
const KEYMAP_CONFIG_89 = { entries: KEYMAP_89_ENTRIES, byName: KEYMAP_89_BY_NAME, listId: 'keyMap89' };
const KEYMAP_CONFIG_92P = { entries: KEYMAP_92P_ENTRIES, byName: KEYMAP_92P_BY_NAME, listId: 'keyMap92p' };
const KEYMAP_CONFIG_NSP = { entries: KEYMAP_NSP_ENTRIES, byName: KEYMAP_NSP_BY_NAME, listId: 'nspireKeyMap' };
const KEYMAP_CONFIG_HP_PRIME = { entries: KEYMAP_HP_PRIME_ENTRIES, byName: KEYMAP_HP_PRIME_BY_NAME, listId: 'hpPrimeKeyMap' };

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
    ['keyMap834', 'nspireKeyMap', 'keyMap86', 'keyMap89', 'keyMap92p', 'hpPrimeKeyMap'].forEach(id => {
        const list = document.getElementById(id);
        if (list) {
            list.textContent = '';
        }
    });
}

const THEME_STORAGE_KEY = 'webtilp.theme';
const THEMES = [
    { id: 'dark-modern', labelKey: 'theme_dark_modern' },
    { id: 'light-modern', labelKey: 'theme_light_modern' },
    { id: 'retro', labelKey: 'theme_retro' }
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
    settingLanguage: document.getElementById('settingLanguage'),
    settingConvertPythonFiles: document.getElementById('settingConvertPythonFiles'),
    settingConvertPythonFilesField: document.getElementById('settingConvertPythonFilesField'),
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
    els.btnThemeToggle.textContent = `${t('theme_prefix')}: ${getOptionLabel(theme)}`;
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
        els.offlineBannerText.textContent = t('offline_update_available');
    }
    els.btnReloadOffline.classList.remove('hidden');
    els.offlineBanner.classList.remove('hidden');
    if (els.settingsUpdateDot) {
        els.settingsUpdateDot.classList.remove('hidden');
    }
    if (els.btnSettings) {
        els.btnSettings.title = t('update_available');
    }
    state.offlineUpdateShown = true;
}

function hideOfflineUpdateBanner() {
    if (!els.offlineBanner || !els.btnReloadOffline) {
        return;
    }
    if (els.offlineBannerText) {
        els.offlineBannerText.textContent = t('offline_ready');
    }
    els.btnReloadOffline.classList.add('hidden');
    if (els.settingsUpdateDot) {
        els.settingsUpdateDot.classList.add('hidden');
    }
    if (els.btnSettings) {
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
        const { deviceFamily: _legacyDeviceFamily, ...persisted } = parsed;
        return {
            ...SETTINGS_DEFAULTS,
            ...persisted,
            cableModel: String(parsed.cableModel ?? SETTINGS_DEFAULTS.cableModel),
            calcModel: String(parsed.calcModel ?? SETTINGS_DEFAULTS.calcModel),
            cableTimeout: Number(parsed.cableTimeout ?? SETTINGS_DEFAULTS.cableTimeout),
            cableDelay: Number(parsed.cableDelay ?? SETTINGS_DEFAULTS.cableDelay),
            language: normalizeLanguageCode(parsed.language) || 'auto',
            convertPythonFiles: parsed.convertPythonFiles !== false
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
    const byLabel = options.find(option => getOptionLabels(option).some(label => normalizeOptionValue(label) === normalized));
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
    if (normalized === 'graylink' || normalized === 'greylink' || normalized === 'gry' || normalized === 'rs232') {
        return CABLE_GRAYLINK;
    }
    if (normalized === 'silverlink' || normalized === 'dbus') {
        return CABLE_SILVERLINK;
    }
    if (normalized === 'directlink' || normalized === 'dusb') {
        return CABLE_DIRECTLINK;
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
        alert(tFormat('alert_unknown_cable_param', { value: params.get('cable') }));
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
                    const isDbusSerialCable = String(state.settings.cableModel) === CABLE_SILVERLINK
                        || String(state.settings.cableModel) === CABLE_GRAYLINK;
                    if (isDbusSerialCable && !SILVERLINK_CALC_VALUES.has(model)) {
                        shouldOpenSettings = true;
                        openSettingsModal();
                    }
                } else {
                    alert(tFormat('alert_unknown_calc_param', { value: calcParam }));
                }
            } catch (err) {
                console.warn('[WebTILP] Failed to resolve calc URL param', err);
                alert(tFormat('alert_failed_resolve_calc_param', { value: calcParam }));
            }
        })();
    }
    const timeout = Number(params.get('timeout'));
    if (Number.isFinite(timeout) && timeout > 0) {
        nextSettings.cableTimeout = timeout;
    } else if (params.get('timeout')) {
        alert(tFormat('alert_invalid_timeout_param', { value: params.get('timeout') }));
    }
    const delay = Number(params.get('delay'));
    if (Number.isFinite(delay) && delay >= 0) {
        nextSettings.cableDelay = delay;
    } else if (params.get('delay')) {
        alert(tFormat('alert_invalid_delay_param', { value: params.get('delay') }));
    }
    state.settings = nextSettings;

    const isDbusSerialCable = String(state.settings.cableModel) === CABLE_SILVERLINK
        || String(state.settings.cableModel) === CABLE_GRAYLINK;
    const calcModelValue = String(state.settings.calcModel || '');
    const isCalcAuto = !calcParam || calcModelValue === 'auto';
    const isCalcValidForDbusSerial = SILVERLINK_CALC_VALUES.has(Number(calcModelValue));
    if (isDbusSerialCable && (isCalcAuto || !isCalcValidForDbusSerial)) {
        shouldOpenSettings = true;
    }

    const themeParam = params.get('theme');
    if (themeParam) {
        const normalized = normalizeOptionValue(themeParam);
        const target = THEMES.find(theme => normalizeOptionValue(theme.id) === normalized
            || getOptionLabels(theme).some(label => normalizeOptionValue(label) === normalized));
        if (target) {
            applyTheme(target.id);
        } else {
            alert(tFormat('alert_unknown_theme_param', { value: themeParam }));
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
    if (isSerialDevice(device)) {
        bindSerialPortToModule(module, device);
        if (isGrayLinkSerialDevice(device)) {
            module._set_cable_model(Number(CABLE_GRAYLINK));
            module._set_force_cable(1);
            log('Cable hint applied: GrayLink WebSerial');
            return;
        }
        module._set_cable_model(Number(CABLE_DIRECTLINK));
        module._set_force_cable(1);
        const calcSetting = String(state.settings?.calcModel ?? 'auto');
        if (calcSetting === 'auto' || (!navigator.usb && calcSetting !== '43' && calcSetting !== '44' && calcSetting !== '45')) {
            module._set_calc_model(getEvoCalcModelForDevice(device));
            module._set_force_calc(0);
        }
        log('Cable hint applied: TI-83/84 Evo WebSerial');
        return;
    }
    if (state.settings && state.settings.cableModel !== 'auto') {
        return;
    }
    if (device.vendorId !== 0x0451) {
        return;
    }

    if (device.productId === PID_SILVERLINK) {
        module._set_cable_model(Number(CABLE_SILVERLINK));
        module._set_force_cable(1);
        log('Cable hint applied: SilverLink USB');
        return;
    }

    if (DIRECTLINK_PIDS.has(device.productId)) {
        module._set_cable_model(Number(CABLE_DIRECTLINK));
        module._set_force_cable(1);
        log('Cable hint applied: DirectLink USB');
    }
}

function hasSilverlinkConnected() {
    return state.authorizedDevice && state.authorizedDevice.productId === PID_SILVERLINK;
}

function isGrayLinkSelected() {
    return String(state.settings?.cableModel ?? 'auto') === CABLE_GRAYLINK || isGrayLinkSerialDevice();
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

function getActiveCalcModelId() {
    if (!state.module) {
        return 0;
    }
    try {
        return Number(state.module.ccall('get_calc_model_id', 'number', [], [])) || 0;
    } catch (err) {
        return 0;
    }
}

function getPythonConversionKind(model) {
    const modelId = Number(model);
    if (CE_PYTHON_CALC_MODELS.has(modelId)) {
        return PYTHON_CONVERSION_CE;
    }
    if (EVO_PYTHON_CALC_MODELS.has(modelId)) {
        return PYTHON_CONVERSION_EVO;
    }
    if (NSPIRE_CXII_PYTHON_CALC_MODELS.has(modelId)) {
        return PYTHON_CONVERSION_NSPIRE_CXII;
    }
    return PYTHON_CONVERSION_NONE;
}

function getSelectedPythonConversionKind() {
    const selectedModel = els.settingCalcModel?.value ?? state.settings?.calcModel ?? 'auto';
    const modelId = selectedModel === 'auto' ? getActiveCalcModelId() : Number(selectedModel);
    return getPythonConversionKind(modelId);
}

function updatePythonConversionSettingAvailability() {
    if (!els.settingConvertPythonFiles) {
        return;
    }
    const conversionKind = getSelectedPythonConversionKind();
    const supported = conversionKind !== PYTHON_CONVERSION_NONE;
    els.settingConvertPythonFiles.disabled = !supported;
    setTextContent(
        document.getElementById('settingConvertPythonFilesLabel'),
        t(conversionKind === PYTHON_CONVERSION_NSPIRE_CXII ? 'convert_python_files_nspire' : 'convert_python_files')
    );
    if (els.settingConvertPythonFilesField) {
        els.settingConvertPythonFilesField.classList.toggle('disabled', !supported);
        els.settingConvertPythonFilesField.title = supported
            ? ''
            : 'Python source conversion is available only for CE, Evo, and TI-Nspire CX II models.';
    }
}

function resolveDeviceModelName(infoProductName) {
    let calcModelLabel = getActiveCalcModelString() || '';
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
    if (isSerialDevice(a) || isSerialDevice(b)) {
        return isSerialDevice(a)
            && isSerialDevice(b)
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
        return 43;
    }
    if (/ti[-_ ]?83|83\s*evo|83evo/i.test(name)) {
        return 45;
    }
    return /evo[-_ ]?t/i.test(name) ? 44 : 43;
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
    const forcedSilverlink = forcedCable === CABLE_SILVERLINK;
    const forcedDirectlink = forcedCable === CABLE_DIRECTLINK;

    if (isSilverlinkDevice && forcedDirectlink) {
        const confirmSwitch = confirm(t('confirm_switch_to_silverlink'));
        if (confirmSwitch) {
            state.settings.cableModel = CABLE_SILVERLINK;
            state.settings.calcModel = 'auto';
            saveSettings();
            openSettingsModal();
        }
        return true;
    }

    if (isDirectlinkDevice && forcedSilverlink) {
        const confirmSwitch = confirm(t('confirm_switch_to_directlink'));
        if (confirmSwitch) {
            state.settings.cableModel = CABLE_DIRECTLINK;
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
    alert(t('alert_silverlink_model_required'));
    openSettingsModal();
    return false;
}

function ensureGrayLinkModelSelected() {
    if (!isGrayLinkSelected()) {
        return true;
    }
    const calcModel = state.settings?.calcModel ?? 'auto';
    if (calcModel !== 'auto') {
        return true;
    }
    alert(t('alert_graylink_model_required'));
    openSettingsModal();
    return false;
}

function populateSelect(select, options) {
    select.innerHTML = '';
    options.forEach(option => {
        const item = document.createElement('option');
        item.value = String(option.value);
        item.textContent = getOptionLabel(option);
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
    if (String(cableModel) === CABLE_SILVERLINK || String(cableModel) === CABLE_GRAYLINK) {
        return sortCalcOptions(CALC_MODEL_OPTIONS.filter(option => option.value === 'auto' || SILVERLINK_CALC_VALUES.has(Number(option.value))));
    }
    if (String(cableModel) === CABLE_DIRECTLINK) {
        return sortCalcOptions(CALC_MODEL_OPTIONS.filter(option => option.value === 'auto' || DIRECTLINK_CALC_VALUES.has(Number(option.value))));
    }
    return sortCalcOptions(CALC_MODEL_OPTIONS);
}

function updateCalcHint(cableModel) {
    if (!els.settingCalcHint) {
        return;
    }
    if (String(cableModel) === CABLE_SILVERLINK) {
        els.settingCalcHint.textContent = t('silverlink_hint');
        return;
    }
    if (String(cableModel) === CABLE_GRAYLINK) {
        els.settingCalcHint.textContent = t('graylink_hint');
        return;
    }
    els.settingCalcHint.textContent = t('auto_probe_hint');
}

async function applyTranslations() {
    state.uiLanguage = resolveUiLanguage(state.settings?.language || 'auto');
    await loadLocaleDictionary(state.uiLanguage);
    document.documentElement.lang = state.uiLanguage === 'zh' ? 'zh-CN' : state.uiLanguage;
    document.documentElement.dir = state.uiLanguage === 'fa' ? 'rtl' : 'ltr';

    setTextContent(document.getElementById('brandSubtitle'), t('brand_subtitle'));
    setButtonText(els.btnSettings, `⚙️ ${t('settings')}`);
    setTextContent(els.btnConnect, `🔌 ${t('connect_calculator')}`);
    setTextContent(document.getElementById('splashTitle'), t('welcome_title'));
    setTextContent(document.getElementById('splashText'), t('welcome_text'));
    setTextContent(document.getElementById('splashWebUsbWarningTitle'), t('webusb_unavailable_title'));
    setTextContent(document.getElementById('splashWebUsbWarningText'), t('webusb_unavailable_text'));
    setTextContent(els.btnSplashConnect, `🔌 ${t('connect_calculator')}`);

    setTextContent(document.getElementById('panelDeviceTitle'), t('device'));
    setTextContent(document.getElementById('labelModel'), t('model'));
    setTextContent(document.getElementById('labelFreeMemory'), t('free_memory'));
    setTextContent(els.btnGetInfo, `ℹ️ ${t('refresh_device_info')}`);
    setTextContent(els.btnSyncClock, `🕒 ${t('sync_clock')}`);

    setTextContent(document.getElementById('panelTransfersTitle'), t('transfers'));
    setTextContent(els.btnIsReady, `✅ ${t('is_ready')}`);
    setTextContent(document.getElementById('dropzoneTitle'), t('dropzone_title'));
    setTextContent(document.getElementById('dropzoneSubtitle'), t('dropzone_subtitle'));
    setTextContent(els.btnSendFiles, `📤 ${t('send_selected_files')}`);
    setTextContent(els.btnReceiveBackup, `📥  ${t('make_backup')}`);
    setTextContent(els.btnReceiveOs, `📥  ${t('receive_os')}`);
    setTextContent(els.btnDownloadOsPartial, `⬇️  ${t('download_os_so_far')}`);
    setTextContent(els.btnDumpRom, `🧠  ${t('dump_rom')}`);
    setTextContent(els.btnLeaveExam, `👨‍🎓  ${t('leave_exam_mode')}`);

    setTextContent(document.getElementById('panelKeysTitle'), t('remote_keys'));
    if (els.keyCodeInput) {
        els.keyCodeInput.placeholder = t('key_input_placeholder');
    }
    setTextContent(els.btnSendKey, `🎯 ${t('send_key')}`);

    setTextContent(document.getElementById('panelVarsTitle'), t('calculator_variables'));
    if (els.filterInput) {
        els.filterInput.placeholder = t('filter_name_or_type');
    }
    setTextContent(els.btnRefreshDirlist, `🔄 ${t('refresh_list')}`);
    setTextContent(els.btnNewFolder, `📁 ${t('new_folder')}`);
    setTextContent(els.btnRecvSelected, `⬇️ ${t('receive_selected')}`);
    setTextContent(els.btnDeleteSelected, `🗑️ ${t('delete_selected')}`);
    setTextContent(document.getElementById('varsHeaderName'), t('name'));
    setTextContent(document.getElementById('varsHeaderType'), t('type'));
    setTextContent(document.getElementById('varsHeaderSize'), t('size'));
    setTextContent(document.getElementById('varsHeaderLocation'), t('location'));
    setTextContent(document.getElementById('varsHeaderFolder'), t('folder'));
    setTextContent(document.getElementById('varsHeaderKind'), t('kind'));
    setTextContent(els.previewReindentLabel, t('reindent'));
    setTextContent(els.btnDownloadPreview, `⬇️ ${t('download')}`);
    setTextContent(els.previewDownloadLabel, `${t('download')}:`);
    els.previewBasicDownloads?.setAttribute('aria-label', t('download'));
    setTextContent(els.btnDismissPreview, t('close'));

    setTextContent(document.getElementById('panelScreenshotTitle'), t('screenshot'));
    setTextContent(els.btnScreenshot, `📸 ${t('take_screenshot')}`);
    setTextContent(els.btnDownloadScreenshot, `⬇️ ${t('download_png')}`);
    setTextContent(document.getElementById('panelLogTitle'), t('activity_log'));
    setTextContent(els.btnClearLog, `🧹 ${t('clear_log')}`);

    setTextContent(document.getElementById('settingsTitle'), t('settings_title'));
    setTextContent(document.getElementById('settingCableLabel'), t('cable'));
    setTextContent(document.getElementById('settingCableHint'), t('force_cable_hint'));
    setTextContent(document.getElementById('settingCalcLabel'), t('calculator_model'));
    setTextContent(document.getElementById('settingTimeoutLabel'), t('cable_timeout'));
    setTextContent(document.getElementById('settingDelayLabel'), t('cable_delay'));
    setTextContent(document.getElementById('settingLanguageLabel'), t('language'));
    setTextContent(document.getElementById('settingConvertPythonFilesLabel'), t('convert_python_files'));
    setTextContent(document.getElementById('settingsNote'), t('settings_note'));
    setTextContent(document.getElementById('offlineBannerText'), state.offlineUpdateShown ? t('offline_update_available') : t('offline_ready'));
    setTextContent(els.btnReloadOffline, `↻ ${t('reload_for_update')}`);
    setTextContent(els.btnClearOfflineCache, t('clear_offline_cache'));
    setTextContent(els.btnResetSettings, `↩️ ${t('reset_defaults')}`);
    setTextContent(els.btnSaveSettings, `💾 ${t('save_settings')}`);

    setTextContent(document.getElementById('transferTitle'), t('transfer_options'));
    setTextContent(document.getElementById('transferHeaderFile'), t('file'));
    setTextContent(document.getElementById('transferHeaderVariable'), t('variable'));
    setTextContent(document.getElementById('transferHeaderSize'), t('size'));
    setTextContent(document.getElementById('transferHeaderType'), t('type'));
    setTextContent(document.getElementById('transferHeaderLocation'), t('location'));
    setTextContent(document.getElementById('transferHeaderFolder'), t('folder'));
    setTextContent(document.getElementById('transferNote'), t('transfer_note'));
    setTextContent(document.getElementById('transferOverwriteAllLabel'), t('transfer_overwrite_all'));
    setTextContent(els.btnTransferAllRam, t('transfer_all_ram'));
    setTextContent(els.btnTransferAllArchive, t('transfer_all_archive'));
    setTextContent(els.btnCancelTransfer, t('cancel'));
    setTextContent(els.btnConfirmTransfer, `🚀 ${t('start_transfer')}`);

    setTextContent(document.getElementById('newFolderTitle'), t('create_folder'));
    setTextContent(document.getElementById('newFolderNameLabel'), t('folder_name'));
    setTextContent(document.getElementById('newFolderParentLabel'), t('parent_folder'));
    if (els.newFolderName) {
        els.newFolderName.placeholder = t('new_folder_placeholder');
    }
    setTextContent(document.getElementById('newFolderNote'), t('new_folder_note'));
    setTextContent(els.btnCancelNewFolder, t('cancel'));
    setTextContent(els.btnCreateNewFolder, t('create'));

    setTextContent(document.getElementById('backupTitle'), t('backup_options'));
    setTextContent(document.getElementById('backupFormatLabel'), t('backup_format'));
    setTextContent(document.getElementById('backupFormatBackupLabel'), t('standard_backup_file'));
    setTextContent(document.getElementById('backupFormatTigroupLabel'), t('tigroup'));
    setTextContent(document.getElementById('backupIncludeLabel'), t('include_in_tigroup'));
    setTextContent(document.getElementById('backupIncludeRamLabel'), t('ram'));
    setTextContent(document.getElementById('backupIncludeArchiveLabel'), t('archive'));
    setTextContent(document.getElementById('backupIncludeFlashLabel'), t('flash_apps'));
    setTextContent(document.getElementById('backupNote'), t('backup_note'));
    setTextContent(document.getElementById('backupModalOverlayText'), t('loading_dirlist'));
    setTextContent(els.btnCancelBackup, t('cancel'));
    setTextContent(els.btnConfirmBackup, `📥 ${t('create_backup')}`);
    setTextContent(els.btnCloseConnectionHelp, t('close'));
    updateTransportSplashState();

    if (els.btnNuke) {
        els.btnNuke.title = t('force_disconnect_reset');
    }
    if (els.btnSettings && state.offlineUpdateShown) {
        els.btnSettings.title = t('update_available');
    }
    if (els.statusText) {
        syncStatusTranslation(els.statusText.dataset.i18nKey);
    }
    updateThemeButton();
    updateCalcHint(els.settingCableModel?.value || state.settings?.cableModel || 'auto');
    updatePythonConversionSettingAvailability();
    applyActiveFamilyUiState({
        tiCapabilitiesKnown: state.connected
            && state.activeFamily === DEVICE_FAMILY_TI
            && Boolean(state.handle)
    });
}

function seedSettingsForm() {
    populateSelect(els.settingCableModel, CABLE_OPTIONS);
    els.settingCableModel.value = state.settings.cableModel;
    populateSelect(els.settingCalcModel, getCalcOptionsForCable(els.settingCableModel.value));
    els.settingCalcModel.value = state.settings.calcModel;
    els.settingTimeout.value = state.settings.cableTimeout;
    els.settingDelay.value = state.settings.cableDelay;
    populateSelect(els.settingLanguage, LANGUAGE_OPTIONS);
    els.settingLanguage.value = state.settings.language || 'auto';
    if (els.settingConvertPythonFiles) {
        els.settingConvertPythonFiles.checked = state.settings.convertPythonFiles !== false;
    }
    updateCalcHint(els.settingCableModel.value);
    updatePythonConversionSettingAvailability();
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
    rootOption.textContent = t('root');
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

async function saveSettingsFromModal() {
    if (els.settingCableModel.value === CABLE_SILVERLINK && els.settingCalcModel.value === 'auto') {
        alert(t('alert_silverlink_choose_model'));
        return;
    }
    if (els.settingCableModel.value === CABLE_GRAYLINK && els.settingCalcModel.value === 'auto') {
        alert(t('alert_graylink_model_required'));
        return;
    }
    const nextSettings = {
        cableModel: els.settingCableModel.value,
        calcModel: els.settingCalcModel.value,
        cableTimeout: Number(els.settingTimeout.value || SETTINGS_DEFAULTS.cableTimeout),
        cableDelay: Number(els.settingDelay.value || SETTINGS_DEFAULTS.cableDelay),
        language: normalizeLanguageCode(els.settingLanguage.value) || 'auto',
        convertPythonFiles: els.settingConvertPythonFiles ? els.settingConvertPythonFiles.checked : SETTINGS_DEFAULTS.convertPythonFiles
    };
    if (JSON.stringify(state.settings) === JSON.stringify(nextSettings)) {
        closeSettingsModal();
        log('Settings unchanged.');
        return;
    }
    const languageOnlyChange = state.settings
        && state.settings.cableModel === nextSettings.cableModel
        && state.settings.calcModel === nextSettings.calcModel
        && Number(state.settings.cableTimeout) === Number(nextSettings.cableTimeout)
        && Number(state.settings.cableDelay) === Number(nextSettings.cableDelay)
        && state.settings.convertPythonFiles === nextSettings.convertPythonFiles
        && state.settings.language !== nextSettings.language;
    const conversionOnlyChange = state.settings
        && state.settings.cableModel === nextSettings.cableModel
        && state.settings.calcModel === nextSettings.calcModel
        && Number(state.settings.cableTimeout) === Number(nextSettings.cableTimeout)
        && Number(state.settings.cableDelay) === Number(nextSettings.cableDelay)
        && state.settings.language === nextSettings.language
        && state.settings.convertPythonFiles !== nextSettings.convertPythonFiles;
    state.settings = nextSettings;
    saveSettings();
    if (conversionOnlyChange) {
        applySettingsToModule();
        closeSettingsModal();
        log('Python file conversion setting updated.');
        return;
    }
    if (languageOnlyChange) {
        try {
            await applyTranslations();
            seedSettingsForm();
            closeSettingsModal();
            log('Language updated.');
            return;
        } catch (err) {
            console.warn('[WebTILP] Failed to apply language without reload, falling back to page reload.', err);
            // fallthrough
        }
    }
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
    // Note: the per-module Asyncify call chain (getModuleCallState) is left
    // untouched on purpose: a suspended WASM call must never be raced by new
    // calls, even after a disconnect/cancel. Cancelled operations bail out via
    // the epoch check; the chain unblocks when the underlying call settles.
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
    syncStatusTranslation(text);
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
        updateTransportSplashState();
    }
}

function updateTransportSplashState() {
    const webUsbReady = hasWebUsbTransport();
    const evoSerialReady = hasEvoWebSerialTransport();
    const hpWebHidReady = hasHPPrimeWebHidTransport();
    const supported = hasAnySupportedTransport();
    const primaryReady = webUsbReady || evoSerialReady || hpWebHidReady;
    setTextContent(document.getElementById('splashText'), t('welcome_text'));
    if (els.splashWebUsbWarning) {
        els.splashWebUsbWarning.classList.toggle('hidden', primaryReady);
        if (!primaryReady) {
            setTextContent(
                document.getElementById('splashWebUsbWarningTitle'),
                evoSerialReady ? t('webserial_only_title') : t('webusb_unavailable_title')
            );
            setTextContent(
                document.getElementById('splashWebUsbWarningText'),
                evoSerialReady ? t('webserial_only_text') : t('webusb_unavailable_text')
            );
        }
    }
    if (els.btnSplashConnect) {
        els.btnSplashConnect.classList.toggle('hidden', !supported);
    }
    if (els.btnConnect) {
        els.btnConnect.classList.toggle('hidden', !supported);
    }
    if (els.btnSettings) {
        els.btnSettings.classList.toggle('hidden', !hasAnySupportedTransport());
    }
}

function isWindowsPlatform() {
    const platform = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '';
    return /win/i.test(String(platform));
}

function isLinuxPlatform() {
    const platform = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '';
    return /linux/i.test(String(platform));
}

function resetToSplashState() {
    clearActiveOperations();
    state.handle = 0;
    state.activeFamily = DEVICE_FAMILY_TI;
    state.numWorksBackend = null;
    state.cableOpen = false;
    state.authorizedDevice = null;
    state.connectInProgress = false;
    state.handlePromise = null;
    state.needsReauthorize = false;
    state.silentReconnectInProgress = false;
    clearDeviceData();
    applyActiveFamilyUiState();
    setConnected(false);
    if (!self.isSecureContext) {
        setStatus('status_insecure_context', false);
    } else if (hasWebUsbTransport() || hasHPPrimeWebHidTransport()) {
        setStatus('idle', false);
    } else if (hasEvoWebSerialTransport()) {
        setStatus('status_webserial_only', false);
    } else {
        setStatus('status_webusb_unsupported', false);
    }
}

function openConnectionHelpModal(title, html) {
    if (!els.connectionHelpModal || !els.connectionHelpBody) {
        alert(`${title}\n\n${html.replace(/<[^>]+>/g, '')}`);
        return;
    }
    if (els.connectionHelpTitle) {
        els.connectionHelpTitle.textContent = title;
    }
    els.connectionHelpBody.innerHTML = html;
    els.connectionHelpModal.classList.remove('hidden');
    els.connectionHelpModal.setAttribute('aria-hidden', 'false');
}

function closeConnectionHelpModal() {
    if (!els.connectionHelpModal) {
        return;
    }
    els.connectionHelpModal.classList.add('hidden');
    els.connectionHelpModal.setAttribute('aria-hidden', 'true');
}

function showCableOpenHelp(result) {
    const code = Number(result);
    const closeAppsReminder = '<p>Before trying again, close any other WebTILP pages, browser tabs, TI tools, terminal sessions, or other apps that may already be using the calculator or cable.</p>';

    if (isLinuxPlatform() && code === 58) {
        openConnectionHelpModal('Linux serial permission needed', `
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

    if (isWindowsPlatform() && code === 37) {
        openConnectionHelpModal('Install the WinUSB driver with Zadig', `
            <p>Windows could not open the calculator through WebUSB. Install the WinUSB driver for the calculator/cable, then try again.</p>
            <ol>
                <li>Download and run <a href="https://zadig.akeo.ie/" target="_blank" rel="noopener noreferrer">Zadig</a>.</li>
                <li>In Zadig, choose <strong>Options</strong> &gt; <strong>List All Devices</strong>.</li>
                <li>Select the TI calculator or SilverLink cable. Be careful not to select your keyboard, mouse, or USB hub.</li>
                <li>Choose <strong>WinUSB</strong> as the target driver.</li>
                <li>Click <strong>Replace Driver</strong> or <strong>Install Driver</strong>.</li>
                <li>Unplug and replug the calculator, refresh this page if needed, then try again.</li>
            </ol>
            ${closeAppsReminder}
        `);
    }
}

function isNspireActive() {
    const pid = state.authorizedDevice?.productId;
    return typeof pid === 'number' && NSPIRE_PIDS.has(pid);
}

function isHPPrimeActive() {
    return state.activeFamily === DEVICE_FAMILY_HP_PRIME;
}

function isNumWorksActive() {
    return state.activeFamily === DEVICE_FAMILY_NUMWORKS;
}

function resetFamilySpecificUiText(clearActionTitles = true) {
    setTextContent(document.getElementById('dropzoneTitle'), t('dropzone_title'));
    setTextContent(document.getElementById('dropzoneSubtitle'), t('dropzone_subtitle'));
    setTextContent(document.getElementById('panelVarsTitle'), t('calculator_variables'));
    if (clearActionTitles) {
        [els.btnIsReady, els.btnSyncClock, els.btnReceiveBackup,
            els.btnRefreshDirlist, els.btnNewFolder, els.btnDeleteSelected,
            els.btnScreenshot, els.btnReceiveOs, els.btnDownloadOsPartial,
            els.btnDumpRom, els.btnLeaveExam].forEach(button => {
            if (button) {
                button.title = '';
            }
        });
    }
}

function setTiUiState(capabilitiesKnown = false) {
    resetFamilySpecificUiText(!capabilitiesKnown);
    if (els.fileInput) {
        els.fileInput.disabled = false;
        els.fileInput.accept = '';
    }
    updateSendFilesButtonState();
    if (capabilitiesKnown) {
        // updateCapabilities() already resolved the key controls and the
        // per-feature button states for this calculator. Leave them alone, so
        // that a translation refresh cannot hide the keys panel or drop the
        // keymap datalist of a connected calculator.
        updateSelectionActionButtons();
        return;
    }
    updateKeyControlsState(false);
    if (els.keyCodeInput) {
        els.keyCodeInput.removeAttribute('list');
    }
    clearKeyMapDataList();
    [els.btnSyncClock, els.btnNewFolder, els.btnDeleteSelected,
        els.btnReceiveBackup, els.btnRefreshDirlist, els.btnScreenshot].forEach(button => {
        if (button) {
            button.disabled = true;
            button.classList.add('disabled');
        }
    });
    [els.btnIsReady, els.btnReceiveOs, els.btnDownloadOsPartial,
        els.btnDumpRom, els.btnLeaveExam].forEach(button => button?.classList.add('hidden'));
}

function setHPPrimeUiState() {
    updateKeyControlsState(true);
    if (els.keyCodeInput) {
        els.keyCodeInput.removeAttribute('list');
    }
    clearKeyMapDataList();
    populateKeyMapDataList(KEYMAP_CONFIG_HP_PRIME.listId,
        KEYMAP_CONFIG_HP_PRIME.entries);
    els.keyCodeInput?.setAttribute('list', KEYMAP_CONFIG_HP_PRIME.listId);
    if (els.fileInput) {
        els.fileInput.disabled = false;
        els.fileInput.accept = '';
    }
    updateSendFilesButtonState();
    [els.btnSyncClock, els.btnNewFolder, els.btnDeleteSelected].forEach(button => {
        if (button) {
            button.disabled = true;
            button.classList.add('disabled');
            button.title = '';
        }
    });
    if (els.btnScreenshot) {
        els.btnScreenshot.disabled = false;
        els.btnScreenshot.classList.remove('disabled');
        els.btnScreenshot.title = '';
    }
    els.btnIsReady?.classList.add('hidden');
    els.btnReceiveOs?.classList.add('hidden');
    els.btnDownloadOsPartial?.classList.add('hidden');
    els.btnDumpRom?.classList.add('hidden');
    els.btnLeaveExam?.classList.add('hidden');
    if (els.btnReceiveBackup) {
        els.btnReceiveBackup.disabled = false;
        els.btnReceiveBackup.classList.remove('disabled');
        els.btnReceiveBackup.title = t('hp_prime_backup_tooltip');
    }
    if (els.btnRefreshDirlist) {
        els.btnRefreshDirlist.disabled = false;
        els.btnRefreshDirlist.classList.remove('disabled');
        els.btnRefreshDirlist.title = t('hp_prime_refresh_tooltip');
    }
    setTextContent(document.getElementById('dropzoneTitle'), t('hp_prime_dropzone_title'));
    setTextContent(document.getElementById('dropzoneSubtitle'), t('hp_prime_dropzone_subtitle'));
    setTextContent(document.getElementById('panelVarsTitle'), t('hp_prime_files_title'));
    updateSelectionActionButtons();
}

function setNumWorksUiState() {
    updateKeyControlsState(false);
    if (els.keyCodeInput) {
        els.keyCodeInput.removeAttribute('list');
    }
    clearKeyMapDataList();
    if (els.fileInput) {
        els.fileInput.disabled = false;
        els.fileInput.accept = '.py,text/x-python,text/plain';
    }
    updateSendFilesButtonState();
    [els.btnSyncClock, els.btnNewFolder].forEach(button => {
        if (button) {
            button.disabled = true;
            button.classList.add('disabled');
            button.title = '';
        }
    });
    if (els.btnScreenshot) {
        els.btnScreenshot.disabled = true;
        els.btnScreenshot.classList.add('disabled');
        els.btnScreenshot.title = t('numworks_screenshot_unavailable');
    }
    els.btnIsReady?.classList.add('hidden');
    els.btnReceiveOs?.classList.add('hidden');
    els.btnDownloadOsPartial?.classList.add('hidden');
    els.btnDumpRom?.classList.add('hidden');
    els.btnLeaveExam?.classList.add('hidden');
    if (els.btnReceiveBackup) {
        els.btnReceiveBackup.disabled = false;
        els.btnReceiveBackup.classList.remove('disabled');
        els.btnReceiveBackup.title = t('numworks_backup_tooltip');
    }
    if (els.btnRefreshDirlist) {
        els.btnRefreshDirlist.disabled = false;
        els.btnRefreshDirlist.classList.remove('disabled');
        els.btnRefreshDirlist.title = t('numworks_refresh_tooltip');
    }
    setTextContent(document.getElementById('dropzoneTitle'), t('numworks_dropzone_title'));
    setTextContent(document.getElementById('dropzoneSubtitle'),
        t('numworks_dropzone_subtitle'));
    setTextContent(document.getElementById('panelVarsTitle'), t('numworks_scripts_title'));
    updateSelectionActionButtons();
}

function applyActiveFamilyUiState(options = {}) {
    if (isHPPrimeActive()) {
        setHPPrimeUiState();
    } else if (isNumWorksActive()) {
        setNumWorksUiState();
    } else {
        setTiUiState(Boolean(options.tiCapabilitiesKnown));
    }
}

function is84pFamilyActive() {
    const pid = state.authorizedDevice?.productId;
    return typeof pid === 'number' && TI84P_FAMILY_PIDS.has(pid);
}

function getActiveKeyMapConfig() {
    if (isHPPrimeActive()) {
        return KEYMAP_CONFIG_HP_PRIME;
    }
    if (isNumWorksActive()) {
        return null;
    }
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

function getFlashOsExtensionFromModule(module) {
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

const EVO_OS_MODEL_BY_EXTENSION = new Map([
    ['84b2', 'TI-84 Evo'],
    ['84pk2', 'TI-84 Evo'],
    ['83b2', 'TI-83 Evo'],
    ['83pk2', 'TI-83 Evo'],
    ['84tb2', 'TI-84 Evo-T'],
    ['84tpk2', 'TI-84 Evo-T']
]);

function getEvoOsModelFromExtension(extension) {
    return EVO_OS_MODEL_BY_EXTENSION.get(String(extension || '').toLowerCase()) || null;
}

function getEvoOsModelFromFileName(fileName) {
    const match = String(fileName || '').match(/\.([^.]+)$/);
    return getEvoOsModelFromExtension(match?.[1]);
}

function confirmEvoOsModelMismatch(item, module) {
    if (item?.fileClass !== 'os') {
        return true;
    }
    const sourceModel = getEvoOsModelFromFileName(item.file?.name);
    const targetModel = getEvoOsModelFromExtension(getFlashOsExtensionFromModule(module));
    if (!sourceModel || !targetModel || sourceModel === targetModel) {
        return true;
    }
    return confirm(tFormat('confirm_cross_model_evo_os', {
        file: item.file?.name || 'OS file',
        source: sourceModel,
        target: targetModel
    }));
}

function ensureSupportedTransport() {
    if (!self.isSecureContext) {
        throw new Error(t('transport_secure_context_error'));
    }
    if (!navigator.usb && !navigator.serial && !navigator.hid) {
        throw new Error(t('transport_unavailable_error'));
    }
}

async function initModule() {
    ensureSupportedTransport();
    if (state.module) {
        return state.module;
    }
    setStatus('status_loading_module', false);
    const touchProgress = () => {
        state.lastProgressTs = Date.now();
    };
    state.module = await TILibsModule(makeModulePrintHandlers(touchProgress));
    if (!state.progressHooked) {
        state.module.__progressTick = touchProgress;
        if (state.progressTickPtr === null || state.progressTickPtr === undefined) {
            try {
                state.progressTickPtr = state.module._get_progress_tick_ptr();
            } catch (err) {
                console.warn('[WebTILP] progress tick unavailable', err);
            }
        }
        state.progressHooked = true;
    }
    await ccallAsync(state.module, 'init', 'number', [], []);
    applySettingsToModule();
    log('WASM module initialized.');
    setStatus('status_module_ready', true);
    return state.module;
}

async function authorizeDevice(forcePrompt = false, selectedUsbDevice = null) {
    const module = await initModule();
    const mustPrompt = forcePrompt || state.needsReauthorize;
    const selectedCalcModel = String(state.settings?.calcModel ?? '');
    const selectedCableModel = String(state.settings?.cableModel ?? 'auto');
    const wantsGrayLink = selectedCableModel === CABLE_GRAYLINK;
    const wantsEvoSerial = selectedCalcModel === '43' || selectedCalcModel === '44' || selectedCalcModel === '45';
    if (wantsGrayLink) {
        if (!ensureGrayLinkModelSelected()) {
            const modelError = new Error('GrayLink requires a calculator model selection.');
            modelError.silent = true;
            throw modelError;
        }
        let device = !mustPrompt && isGrayLinkSerialDevice(state.authorizedDevice)
            ? state.authorizedDevice
            : null;
        if (!device) {
            device = await requestGrayLinkSerialDevice();
        }
        if (!device) {
            const cancelError = new Error('No GrayLink serial port selected.');
            cancelError.silent = true;
            throw cancelError;
        }
        bindSerialPortToModule(module, device);
        state.authorizedDevice = device;
        state.deviceModelName = device.productName || state.deviceModelName;
        updateDeviceModelDisplay();
        if (state.needsReauthorize) {
            state.needsReauthorize = false;
            state.silentReconnectInProgress = false;
            setStatus('status_connected', true);
        }
        return device;
    }
    if (selectedUsbDevice) {
        if (getWebUsbDeviceFamily(selectedUsbDevice) !== DEVICE_FAMILY_TI) {
            throw new Error('The selected WebUSB device is not a supported TI calculator.');
        }
        const device = await requestEvoSerialForUsbDevice(selectedUsbDevice);
        if (!device) {
            const cancelError = new Error('TI-83/84 Evo serial port authorization is required.');
            cancelError.silent = true;
            throw cancelError;
        }
        if (isSerialDevice(device)) {
            bindSerialPortToModule(module, device);
        }
        state.authorizedDevice = device;
        if (!hasSilverlinkConnected()) {
            state.deviceModelName = device.productName || state.deviceModelName;
        }
        updateDeviceModelDisplay();
        return device;
    }
    if (!navigator.usb) {
        let device = null;
        if (!mustPrompt) {
            device = await getAuthorizedEvoSerialDevice();
        }
        if (!device) {
            device = await requestTIEvoSerialDevice();
        }
        if (!device) {
            const cancelError = new Error('No TI-83/84 Evo serial device selected.');
            cancelError.silent = true;
            throw cancelError;
        }
        bindSerialPortToModule(module, device);
        state.authorizedDevice = device;
        state.deviceModelName = device.productName || state.deviceModelName;
        updateDeviceModelDisplay();
        if (state.needsReauthorize) {
            state.needsReauthorize = false;
            state.silentReconnectInProgress = false;
            setStatus('status_connected', true);
        }
        return device;
    }
    if (!mustPrompt && getAuthorizedDevices) {
        const devices = await getAuthorizedDevices();
        if (devices && devices.length) {
            const usbDevice = wantsEvoSerial
                ? (devices.find(isEvoUsbDevice) || devices[0])
                : devices[0];
            const device = isEvoUsbDevice(usbDevice)
                ? await getAuthorizedEvoSerialDevice(usbDevice)
                : usbDevice;
            if (!device) {
                const cancelError = new Error('TI-83/84 Evo serial port authorization is required.');
                cancelError.silent = true;
                throw cancelError;
            }
            if (!deviceMatches(state.authorizedDevice, device)) {
                log(`Using authorized device: ${device.productName || 'Unknown'}`);
            }
            state.authorizedDevice = device;
            if (!hasSilverlinkConnected()) {
                state.deviceModelName = device.productName || state.deviceModelName;
            }
            updateDeviceModelDisplay();
            return device;
        }
    }
    let device = await requestTICalculatorDevice();
    device = await requestEvoSerialForUsbDevice(device);
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
        setStatus('status_connected', true);
    }
    return device;
}

async function authorizeHPPrimeDevice(forcePrompt = false, discoveryUsbDevice = null) {
    let device = !forcePrompt && isHPPrimeDevice(state.authorizedDevice)
        && (!discoveryUsbDevice || state.authorizedDevice.productId === discoveryUsbDevice.productId)
        ? state.authorizedDevice
        : null;
    if (!device && !forcePrompt) {
        const devices = await getAuthorizedHPPrimeDevices(discoveryUsbDevice);
        device = devices[0] || null;
    }
    if (!device && forcePrompt) {
        device = await requestHPPrimeDevice(discoveryUsbDevice);
    }
    if (!device) {
        const cancelError = new Error(t('hp_prime_no_device_selected'));
        cancelError.silent = true;
        throw cancelError;
    }
    state.authorizedDevice = device;
    return device;
}

function getHPPrimeModelName(device = state.authorizedDevice) {
    if (device?.productId === 0x2441) {
        return 'HP Prime G2';
    }
    if (device?.productId === 0x0441 || device?.productId === 0x1541) {
        return 'HP Prime G1';
    }
    return 'HP Prime';
}

function getHPPrimeUploadIdentity(filename) {
    const leaf = String(filename || '').split(/[\\/]/).pop();
    if (!leaf) {
        return null;
    }
    const lower = leaf.toLowerCase();
    if (lower === 'calc.settings' || lower === 'cas.settings'
        || lower === 'settings' || lower === 'testmodes.hptestmodes') {
        return { name: leaf.replace(/\.[^.]+$/, ''), extension: '' };
    }
    const dot = leaf.lastIndexOf('.');
    if (dot <= 0 || dot === leaf.length - 1) {
        return null;
    }
    const extension = leaf.slice(dot + 1).toLowerCase();
    if (!HP_PRIME_UPLOAD_EXTENSIONS.has(extension)) {
        return null;
    }
    return {
        name: leaf.slice(0, dot),
        extension: extension === 'hpmatrix' ? 'hpmat' : extension
    };
}

function applyHPPrimeFileSnapshot(module) {
    const filesText = module.ccall('hp_prime_get_files_json', 'string', [], []);
    const files = JSON.parse(filesText || '[]');
    state.features = 0;
    state.dirlist = files.flatMap(mapHPPrimeFileEntries);
    state.hpFileSnapshotLoaded = true;
    renderDirlist(state.dirlist);
    return files.length;
}

function mapHPPrimeFileEntry(file) {
    return {
        name: file.name,
        type: file.type,
        type_name: file.typeName,
        size: file.size,
        kind: 'hp',
        folder: '',
        attr: 0,
        is_folder: Array.isArray(file.children) ? 1 : 0,
        hpIndex: file.index,
        extension: file.extension,
        invalid: Boolean(file.invalid),
        hpAppRoot: Array.isArray(file.children),
        hpAppContainerValid: file.appContainerValid !== false
    };
}

function hpPrimeAppPartTypeName(kind) {
    if (kind === 'descriptor') return t('hp_prime_app_descriptor');
    if (kind === 'note') return t('hp_prime_app_note');
    if (kind === 'program') return t('hp_prime_app_program');
    return t('hp_prime_app_resource');
}

function mapHPPrimeFileEntries(file) {
    const root = mapHPPrimeFileEntry(file);
    if (!Array.isArray(file.children)) {
        return [root];
    }
    const children = file.children.map(child => ({
        name: child.name,
        type: file.type,
        type_name: hpPrimeAppPartTypeName(child.kind),
        size: child.size,
        kind: 'hp-app-child',
        folder: file.name,
        attr: 0,
        is_folder: 0,
        hpIndex: file.index,
        hpAppChildIndex: child.index,
        hpAppPartKind: child.kind,
        hpAppChildEditable: Boolean(child.editable),
        extension: child.extension,
        invalid: false
    }));
    return [root, ...children];
}

function scheduleHPPrimeProgressRender(module, generation) {
    if (state.hpFileRenderGeneration === generation) {
        return;
    }
    state.hpFileRenderGeneration = generation;
    requestAnimationFrame(() => {
        if (state.hpFileRenderGeneration !== generation) {
            return;
        }
        state.hpFileRenderGeneration = 0;
        if (state.module !== module
            || state.hpFileRefreshGeneration !== generation
            || !isHPPrimeActive()) {
            return;
        }
        renderDirlist(state.dirlist);
    });
}

function appendHPPrimeFileArrival(module, generation, json) {
    if (state.module !== module
        || state.hpFileRefreshGeneration !== generation
        || !isHPPrimeActive()) {
        return false;
    }
    try {
        state.dirlist.push(...mapHPPrimeFileEntries(JSON.parse(json)));
        scheduleHPPrimeProgressRender(module, generation);
        return true;
    } catch (error) {
        console.warn('[WebTILP] Ignoring invalid HP Prime file update.', error);
        return false;
    }
}

function beginHPPrimeFileSnapshot(module) {
    const generation = ++state.hpFileRefreshGeneration;
    state.hpFileRenderGeneration = 0;
    state.hpFileSnapshotLoaded = false;
    state.dirlist = [];
    renderDirlist(state.dirlist);
    const callback = json => appendHPPrimeFileArrival(module, generation, json);
    module.__hpPrimeFileArrived = callback;
    return { generation, callback };
}

function finishHPPrimeFileSnapshot(module, refresh, successful) {
    if (module.__hpPrimeFileArrived === refresh.callback) {
        module.__hpPrimeFileArrived = null;
    }
    if (state.module !== module
        || state.hpFileRefreshGeneration !== refresh.generation
        || !isHPPrimeActive()) {
        return state.dirlist.length;
    }
    state.hpFileRenderGeneration = 0;
    if (successful) {
        return applyHPPrimeFileSnapshot(module);
    }
    renderDirlist(state.dirlist);
    return state.dirlist.length;
}

function readHPPrimeInfo(module) {
    const infoText = module.ccall('hp_prime_get_info_json', 'string', [], []);
    if (!infoText) {
        throw new Error(t('hp_prime_info_unavailable'));
    }
    const info = JSON.parse(infoText);
    state.hpPrimeProtocolVersion = Number(info.protocol) || null;
    const entries = [
        { key: t('hp_prime_info_product_name'), value: getHPPrimeModelName() },
        { key: t('hp_prime_info_firmware_version'), value: info.version || t('unknown') },
        { key: t('hp_prime_info_build'), value: String(info.build ?? t('unknown')) },
        { key: t('hp_prime_info_serial'), value: info.serial || t('unknown') },
        { key: t('hp_prime_info_protocol'), value: info.protocol === 2 ? 'V2' : t('hp_prime_protocol_legacy') },
        { key: t('hp_prime_info_v2_capable'), value: info.supportsV2 ? t('yes') : t('no') }
    ];
    state.deviceInfoEntries = entries;
    state.deviceModelName = getHPPrimeModelName();
    state.deviceInfoProductName = state.deviceModelName;
    renderDeviceInfo(entries);
    updateDeviceModelDisplay(state.deviceModelName);
    els.memoryInfo.textContent = '—';
    els.memoryInfo.title = '';
    applyActiveFamilyUiState();
    return info;
}

async function authorizeNumWorksDevice(forcePrompt = false) {
    let device = !forcePrompt && isNumWorksDevice(state.authorizedDevice)
        ? state.authorizedDevice
        : null;
    if (!device && !forcePrompt) {
        const devices = await getAuthorizedNumWorksDevices();
        device = devices[0] || null;
    }
    if (!device) {
        device = await requestNumWorksDevice();
    }
    if (!device) {
        const cancelError = new Error(t('numworks_no_device_selected'));
        cancelError.silent = true;
        throw cancelError;
    }
    state.authorizedDevice = device;
    return device;
}

function applyNumWorksStorageSnapshot() {
    const scripts = state.numWorksBackend?.listScripts() || [];
    state.features = FEATURE_FLAGS.OPS_RENAME | FEATURE_FLAGS.OPS_DELVAR;
    state.dirlist = scripts.map(script => ({
        name: script.name,
        type: 0,
        type_name: script.autoImport ? t('numworks_type_python_auto') : t('numworks_type_python'),
        size: script.size,
        kind: 'numworks',
        folder: '',
        attr: script.autoImport ? 1 : 0,
        is_folder: 0,
        extension: 'py',
        numWorksName: script.name,
        invalid: !script.valid
    }));
    renderDirlist(state.dirlist);
    return state.dirlist.length;
}

function readNumWorksInfo() {
    const info = state.numWorksBackend?.getInfo();
    if (!info) {
        throw new Error(t('numworks_info_unavailable'));
    }
    const integrityOk = info.headerIntegrity && info.storageFooterValid && info.storageValid;
    const entries = [
        { key: t('numworks_info_product_name'), value: info.model || info.productName || 'NumWorks' },
        { key: t('numworks_info_usb_product'), value: info.productName || 'NumWorks Calculator' },
        { key: t('numworks_info_firmware_version'), value: info.firmwareVersion || t('unknown') },
        { key: t('numworks_info_commit'), value: info.commit || t('unknown') },
        { key: t('numworks_info_mode'), value: info.mode || t('unknown') },
        { key: t('numworks_info_slot'), value: info.slot || t('unknown') },
        { key: t('numworks_info_serial'), value: info.serialNumber || t('unknown') },
        { key: t('numworks_info_transfer_size'), value: `${info.transferSize} B` },
        { key: t('numworks_info_storage_integrity'), value: integrityOk ? t('valid') : t('warning') },
        { key: t('numworks_info_preserved_records'), value: info.preservedRecordCount == null
            ? t('unknown') : String(info.preservedRecordCount) }
    ];
    state.deviceInfoEntries = entries;
    state.deviceModelName = info.model || 'NumWorks';
    state.deviceInfoProductName = state.deviceModelName;
    renderDeviceInfo(entries);
    updateDeviceModelDisplay(state.deviceModelName);
    if (info.storageValid) {
        els.memoryInfo.textContent = tFormat('numworks_storage_summary', {
            used: formatBytes(info.storageUsed),
            total: formatBytes(info.storageSize)
        });
        els.memoryInfo.title = tFormat('numworks_storage_usage', {
            used: info.storageUsed,
            free: info.storageFree,
            total: info.storageSize
        });
    } else {
        els.memoryInfo.textContent = t('numworks_storage_unreadable');
        els.memoryInfo.title = t('numworks_storage_parse_failed');
    }
    return info;
}

async function connectNumWorks(forcePrompt = true) {
    const device = await authorizeNumWorksDevice(forcePrompt);
    await state.numWorksBackend?.close().catch(error => {
        console.warn('[WebTILP] Failed to close the previous NumWorks session.', error);
    });
    state.numWorksBackend = null;
    const Backend = getNumWorksBackendClass();
    const backend = new Backend({
        onProgress() {
            state.lastProgressTs = Date.now();
        }
    });
    await backend.connect(device);
    state.numWorksBackend = backend;
    state.handle = 0;
    state.cableOpen = true;
    state.activeFamily = DEVICE_FAMILY_NUMWORKS;
    state.hpFileSnapshotLoaded = false;
    applyActiveFamilyUiState();
    readNumWorksInfo();
    const count = applyNumWorksStorageSnapshot();
    setConnected(true);
    setStatus('status_connected', true);
    log(tFormat('numworks_connected', { model: state.deviceModelName, count }));
    if (!backend.getInfo().storageValid) {
        log(t('numworks_storage_recovery_warning'));
    }
}

async function connectHPPrime(forcePrompt = true, discoveryUsbDevice = null) {
    const device = await authorizeHPPrimeDevice(forcePrompt, discoveryUsbDevice);
    const module = await initModule();
    await bindHPPrimeDeviceToModule(module, device);
    const result = await ccallAsync(module, 'hp_prime_connect', 'number', [], [], {
        timeoutMs: 30000,
        useProgress: true,
        progressLabel: t('hp_prime_progress_connecting')
    });
    if (result !== 0) {
        throw new Error(tFormat('hp_prime_connection_failed', {
            error: formatHPPrimeError(module, result)
        }));
    }
    state.handle = 0;
    state.cableOpen = true;
    state.activeFamily = DEVICE_FAMILY_HP_PRIME;
    applyActiveFamilyUiState();
    readHPPrimeInfo(module);
    setConnected(true);
    setStatus('status_connected', true);
    log(tFormat('hp_prime_connected', { model: getHPPrimeModelName() }));
}

async function autoConnectIfAuthorized() {
    if (!hasAnySupportedTransport()) {
        return;
    }
    if (state.connectInProgress) {
        return;
    }
    let autoDetectedTiDevice = null;
    const devices = navigator.usb ? await getAuthorizedSupportedWebUsbDevices() : [];
    if (devices.length > 1) {
        return;
    }
    if (devices.length === 1) {
        const device = devices[0];
        const detectedFamily = getWebUsbDeviceFamily(device);
        if (detectedFamily === DEVICE_FAMILY_NUMWORKS) {
            try {
                state.connectInProgress = true;
                state.authorizedDevice = device;
                await connectNumWorks(false);
                log(t('numworks_auto_connected'));
            } catch (err) {
                logError(err, t('numworks_auto_connect_failed'));
            } finally {
                state.connectInProgress = false;
            }
            return;
        }
        if (detectedFamily === DEVICE_FAMILY_HP_PRIME) {
            const hpDevices = await getAuthorizedHPPrimeDevices(device);
            if (hpDevices.length === 1) {
                try {
                    state.connectInProgress = true;
                    state.authorizedDevice = hpDevices[0];
                    await connectHPPrime(false, device);
                    log(t('hp_prime_auto_connected'));
                } catch (err) {
                    logError(err, t('hp_prime_auto_connect_failed'));
                } finally {
                    state.connectInProgress = false;
                }
            }
            return;
        }
        autoDetectedTiDevice = device;
    } else if (hasHPPrimeWebHidTransport()) {
        const hpDevices = await getAuthorizedHPPrimeDevices();
        if (hpDevices.length === 1) {
            try {
                state.connectInProgress = true;
                state.authorizedDevice = hpDevices[0];
                await connectHPPrime(false);
                log(t('hp_prime_auto_connected'));
            } catch (err) {
                logError(err, t('hp_prime_auto_connect_failed'));
            } finally {
                state.connectInProgress = false;
            }
            return;
        }
    }
    if (String(state.settings?.cableModel ?? 'auto') === CABLE_GRAYLINK) {
        return;
    }
    if (state.connectInProgress) {
        return;
    }
    const module = await initModule();
    if (!navigator.usb) {
        const serialDevice = await getAuthorizedEvoSerialDevice();
        if (!serialDevice) {
            return;
        }
        state.authorizedDevice = serialDevice;
    } else {
        if (!getAuthorizedDevices) {
            return;
        }
        const devices = autoDetectedTiDevice
            ? [autoDetectedTiDevice]
            : await getAuthorizedDevices();
        if (!devices || !devices.length) {
            return;
        }

        const usbDevice = devices[0];
        if (isEvoUsbDevice(usbDevice)) {
            const serialDevice = await getAuthorizedEvoSerialDevice(usbDevice);
            if (!serialDevice) {
                return;
            }
            state.authorizedDevice = serialDevice;
        } else {
            state.authorizedDevice = usbDevice;
        }
    }

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
    const canAutoConnectDirect = DIRECTLINK_PIDS.has(pid) && (cableSetting === CABLE_DIRECTLINK || cableSetting === 'auto');
    const canAutoConnectSilver = pid === PID_SILVERLINK && cableSetting === CABLE_SILVERLINK && calcSetting !== 'auto';

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
        setStatus('status_connected', true);
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
        if (!ensureGrayLinkModelSelected()) {
            throw new Error('GrayLink requires a calculator model selection.');
        }
        let handle = 0;
        let attempts = 0;
        while (!handle && attempts < 3) {
            attempts += 1;
            // Routed through ccallAsync: create_handle can suspend in Asyncify,
            // so it must be serialized with every other async C call.
            handle = await ccallAsync(module, 'create_handle', 'number', [], [], { timeoutMs: 8000 });
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
        showCableOpenHelp(result);
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
    els.btnIsReady?.classList.remove('hidden');
    if (els.btnRefreshDirlist) {
        els.btnRefreshDirlist.classList.remove('disabled');
        els.btnRefreshDirlist.disabled = false;
        els.btnRefreshDirlist.title = '';
    }
    if (els.btnScreenshot) {
        els.btnScreenshot.classList.remove('disabled');
        els.btnScreenshot.disabled = false;
        els.btnScreenshot.title = '';
    }
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
    updateSelectionActionButtons();
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

async function connectTI(forcePrompt = true, selectedUsbDevice = null) {
    state.activeFamily = DEVICE_FAMILY_TI;
    applyActiveFamilyUiState();
    await authorizeDevice(forcePrompt, selectedUsbDevice);
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
    setStatus('status_connected', true);
    log('Device connected.');
}

async function connect() {
    setButtonLoading(els.btnConnect, true);
    const hadWorkingConnection = state.connected || state.cableOpen || Boolean(state.handle);
    try {
        state.connectInProgress = true;
        const wantsGrayLink = String(state.settings?.cableModel ?? 'auto') === CABLE_GRAYLINK;
        if (!wantsGrayLink && hasWebUsbTransport()) {
            const device = await requestSupportedWebUsbDevice();
            if (!device) {
                const cancelError = new Error('No calculator selected.');
                cancelError.silent = true;
                throw cancelError;
            }
            const detectedFamily = getWebUsbDeviceFamily(device);
            state.authorizedDevice = device;
            if (detectedFamily === DEVICE_FAMILY_NUMWORKS) {
                await connectNumWorks(false);
                return;
            }
            if (detectedFamily === DEVICE_FAMILY_HP_PRIME) {
                await connectHPPrime(true, device);
                return;
            }
            if (detectedFamily === DEVICE_FAMILY_TI) {
                await connectTI(false, device);
                return;
            }
            throw new Error('The selected WebUSB calculator is not supported.');
        }
        if (!wantsGrayLink && !hasWebUsbTransport() && hasHPPrimeWebHidTransport()
            && !hasEvoWebSerialTransport()) {
            await connectHPPrime(true);
            return;
        }
        await connectTI(true);
    } catch (err) {
        if (hadWorkingConnection) {
            setStatus('status_connected', true);
        } else {
            state.activeFamily = DEVICE_FAMILY_TI;
            applyActiveFamilyUiState();
            setStatus('status_connection_failed', false);
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
        if (isHPPrimeActive()) {
            const module = await initModule();
            readHPPrimeInfo(module);
            log(t('hp_prime_info_refreshed'));
            return;
        }
        if (isNumWorksActive()) {
            await state.numWorksBackend.refresh();
            readNumWorksInfo();
            applyNumWorksStorageSnapshot();
            log(t('numworks_info_refreshed'));
            return;
        }
        if (isTi92Selected()) {
            const proceed = confirm(t('confirm_replug_after_device_info'));
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
        const reopenNeeded = module._consume_cable_reopen_flag();
        if (reopenNeeded) {
            state.cableOpen = false;
            log('Cable session closed after device info query failure; it will reopen for the next operation.');
        }
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

async function syncClockToNow(module, handle, offsetMinutes = 0) {
    return ccallAsync(
        module,
        'calc_sync_clock',
        'number',
        ['number', 'number'],
        [handle, offsetMinutes],
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

        let result = await syncClockToNow(module, handle);
        if (result !== 0) {
            log(`Clock sync failed (${formatErrorResult(module, result)}).`);
            return;
        }

        let adjusted = false;
        let targetDate = new Date();
        let afterInfo = await getClockInfo(module, handle);
        let afterDate = clockInfoToDate(afterInfo);
        if (afterDate) {
            const diffMinutes = Math.round((targetDate.getTime() - afterDate.getTime()) / 60000);
            const diffAbs = Math.abs(diffMinutes);
            if (diffAbs >= 30 && diffAbs <= 120) {
                adjusted = true;
                result = await syncClockToNow(module, handle, diffMinutes);
                if (result !== 0) {
                    log(`Clock sync failed (${formatErrorResult(module, result)}).`);
                    return;
                }
                targetDate = new Date();
                afterInfo = await getClockInfo(module, handle);
                afterDate = clockInfoToDate(afterInfo);
            }
        }

        const settings = normalizeClockSettings(afterInfo);
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
    canvas.style.aspectRatio = `${canvas.width} / ${canvas.height}`;
    const parent = canvas.parentElement;
    if (!parent) {
        return;
    }
    const styles = getComputedStyle(canvas);
    let maxWidth = parent.clientWidth;
    const cssMaxWidth = parseFloat(styles.maxWidth);
    if (Number.isFinite(cssMaxWidth) && cssMaxWidth > 0) {
        maxWidth = Math.min(maxWidth, cssMaxWidth);
    }
    if (maxWidth <= 0) {
        return;
    }
    const integerScale = Math.floor(maxWidth / canvas.width);
    const displayWidth = integerScale >= 1 ? canvas.width * integerScale : maxWidth;
    canvas.style.width = `${displayWidth}px`;
    canvas.style.height = 'auto';
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
    state.hpFileSnapshotLoaded = false;
    state.hpFileRefreshGeneration += 1;
    state.hpFileRenderGeneration = 0;
    state.hpPrimeProtocolVersion = null;
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
    const canvas = els.screenshotCanvas;
    canvas.width = 0;
    canvas.height = 0;
    canvas.style.removeProperty('width');
    canvas.style.removeProperty('height');
    canvas.style.removeProperty('aspect-ratio');
    canvas.classList.remove('filled');
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
        if (isHPPrimeActive()) {
            const module = await initModule();
            const refresh = beginHPPrimeFileSnapshot(module);
            let result;
            try {
                result = await ccallAsync(module, 'hp_prime_refresh_files', 'number', [], [], {
                    timeoutMs: null,
                    useProgress: true,
                    progressLabel: t('hp_prime_progress_loading_files')
                });
            } catch (error) {
                finishHPPrimeFileSnapshot(module, refresh, false);
                throw error;
            }
            if (result !== 0) {
                finishHPPrimeFileSnapshot(module, refresh, false);
                log(tFormat('hp_prime_file_listing_failed', {
                    error: formatHPPrimeError(module, result)
                }));
                return;
            }
            const count = finishHPPrimeFileSnapshot(module, refresh, true);
            log(tFormat('hp_prime_snapshot_loaded', { count }));
            return;
        }
        if (isNumWorksActive()) {
            await state.numWorksBackend.refresh();
            readNumWorksInfo();
            const count = applyNumWorksStorageSnapshot();
            log(tFormat('numworks_scripts_refreshed', { count }));
            return;
        }
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
    const showLocation = !isNspireActive() && !isHPPrimeActive() && !isNumWorksActive();
    const showKind = !isNspireActive() && !isHPPrimeActive() && !isNumWorksActive();
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

function calcSupportsFolders() {
    return (state.features & FEATURE_FLAGS.FTS_FOLDER) !== 0;
}

function isListEntry(entry) {
    return String(entry.type_name || '').toLowerCase().includes('list');
}

function isMatrixEntry(entry) {
    return String(entry.type_name || '').toLowerCase().includes('matrix');
}

function isBuiltInListName(name) {
    return /^L(?:[1-6]|[₁₂₃₄₅₆])$/i.test(name);
}

function canPreviewVariable(entry, modelId = getActiveCalcModelId()) {
    if (!entry || entry.is_folder === 1) {
        return false;
    }
    if (getHPPrimePreviewKind(entry)) {
        return true;
    }
    if (entry.kind === 'numworks') {
        return !entry.invalid;
    }
    if (entry.kind !== 'var') {
        return false;
    }
    if (!TIVARS_PREVIEW_CALC_MODELS.has(modelId)) {
        return false;
    }
    const typeId = Number(entry.type);
    return EVO_PYTHON_CALC_MODELS.has(modelId)
        ? TIVARS_EVO_PREVIEW_TYPES.has(typeId)
        : TIVARS_LEGACY_PREVIEW_TYPES.has(typeId);
}

function getEntryExtension(entry) {
    const supplied = String(entry?.extension || '').trim().replace(/^\./, '');
    if (supplied) {
        return supplied.toLowerCase();
    }
    const name = String(entry?.name || '');
    const dot = name.lastIndexOf('.');
    return dot >= 0 && dot < name.length - 1
        ? name.slice(dot + 1).toLowerCase() : '';
}

function getHPPrimePreviewKind(entry) {
    if (!entry || (entry.kind !== 'hp' && entry.kind !== 'hp-app-child')) {
        return '';
    }
    const extension = getEntryExtension(entry);
    if (HP_PRIME_TEXT_PREVIEW_EXTENSIONS.has(extension)) {
        return 'text';
    }
    return extension === 'png' ? 'image' : '';
}

function formatVariableDisplayName(entry) {
    const name = entry.name || '';
    if (entry.kind === 'numworks') {
        return `${name}.py`;
    }
    if (calcSupportsFolders() || entry.is_folder === 1) {
        return name;
    }
    if (isListEntry(entry) && !isBuiltInListName(name)) {
        return `ʟ${name}`;
    }
    if (isMatrixEntry(entry)) {
        return /^\[.*\]$/.test(name) ? name : `[${name}]`;
    }
    return name;
}

function renderTableView(entries, filter) {
    const selectionKeys = getSelectedVarKeys();
    const previewModelId = getActiveCalcModelId();
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
        const typeLabel = isFolder
            ? (entry.hpAppRoot ? entry.type_name : 'Directory')
            : (entry.type_name || `Unknown (${entry.type})`);
        const sizeValue = Number(entry.size) || 0;
        const sizeLabel = options.sizeLabel ?? (isFolder ? '-' : formatBytes(sizeValue));
        const indentBars = depth > 0
            ? `<span class="indent-bars">${'<span class="indent-bar"></span>'.repeat(depth)}</span>`
            : '';
        const kindLabel = isFolder
            ? (entry.hpAppRoot ? 'hp' : 'folder')
            : (entry.kind || '');
        const safeTypeLabel = escapeHtml(typeLabel);
        const safeLocation = escapeHtml(isFolder ? '-' : location);
        const safeKindLabel = escapeHtml(kindLabel);
        const safeFolderCell = escapeHtml(entry.folder || '-') || '-';
        const sizeHtml = options.sizeLabel ? options.sizeLabel : escapeHtml(sizeLabel);
        const row = document.createElement('tr');
        const normalizedFolderPath = normalizeFolderPath(getEntryFolderPath(entry));
        const safeName = escapeHtml(formatVariableDisplayName(entry));
        const appContainerInvalid = entry.kind === 'hp'
            && entry.hpAppContainerValid === false;
        const integrityTitle = entry.kind === 'numworks'
            ? t('numworks_malformed_record')
            : (appContainerInvalid
                ? t('hp_prime_app_invalid_container')
                : 'CRC validation failed; the cached data may be corrupt');
        const integrityWarning = entry.invalid || appContainerInvalid
            ? `<span class="integrity-warning" title="${escapeHtml(integrityTitle)}" aria-label="Integrity validation failed">⚠ ${entry.kind === 'numworks' ? 'DATA' : (appContainerInvalid ? 'APP' : 'CRC')}</span>`
            : '';
        const safeFolderPath = escapeHtml(normalizedFolderPath);
        row.dataset.folderTarget = normalizedFolderPath;
        row.dataset.isFolder = isFolder ? '1' : '0';
        row.dataset.folderPath = normalizedFolderPath;
        row.dataset.depth = String(depth);
        row.dataset.hpAppRoot = entry.hpAppRoot ? '1' : '0';
        if (entry.hpAppRoot) {
            row.title = t('hp_prime_app_folder_hint');
        }
        row.classList.toggle('integrity-invalid', Boolean(entry.invalid || appContainerInvalid));
        const canRename = (entry.hpAppChildEditable && state.hpFileSnapshotLoaded)
            || (state.features & FEATURE_FLAGS.OPS_RENAME) !== 0;
        const canDelete = (entry.hpAppChildEditable && state.hpFileSnapshotLoaded)
            || (state.features & FEATURE_FLAGS.OPS_DELVAR) !== 0;
        const canPreview = canPreviewVariable(entry, previewModelId);
        const rowActions = `
            <div class="row-actions">
                ${canPreview ? `<button class="btn ghost btn-inline action-preview" title="${escapeHtml(t('preview'))}" aria-label="${escapeHtml(t('preview'))}">👁️</button>` : ''}
                <button class="btn ghost btn-inline action-download" title="Download">⬇️</button>
                ${canRename ? '<button class="btn ghost btn-inline action-rename" title="Rename">✏️</button>' : ''}
                ${canDelete ? '<button class="btn ghost btn-inline action-delete" title="Delete">🗑️</button>' : ''}
            </div>`;
        const toggleButton = isFolder
            ? `<button class="folder-toggle" type="button" data-folder-path="${safeFolderPath}" aria-label="${options.expanded ? 'Collapse folder' : 'Expand folder'}">${options.expanded ? '▾' : '▸'}</button>`
            : '';
        const displayName = isFolder
            ? `<span class="folder-icon" data-folder-path="${safeFolderPath}">📂</span> ${safeName}`
            : `${safeName}${integrityWarning}`;
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
            checkbox.dataset.typeName = entry.type_name || '';
            checkbox.dataset.size = String(sizeValue);
            checkbox.dataset.hpIndex = entry.hpIndex == null ? '' : String(entry.hpIndex);
            checkbox.dataset.hpAppRoot = entry.hpAppRoot ? '1' : '0';
            checkbox.dataset.hpAppChildIndex = entry.hpAppChildIndex == null
                ? '' : String(entry.hpAppChildIndex);
            checkbox.dataset.hpAppPartKind = entry.hpAppPartKind || '';
            checkbox.dataset.hpAppChildEditable = entry.hpAppChildEditable ? '1' : '0';
            checkbox.dataset.extension = entry.extension || '';
            checkbox.dataset.invalid = entry.invalid ? '1' : '0';
            checkbox.dataset.numWorksName = entry.numWorksName || '';
        }
        els.varTableBody.appendChild(row);
    };

    const sortNodes = (nodes) => {
        const key = state.sort.key;
        const dir = state.sort.dir;
        const useDefaultFlatSort = !state.sort.userDefined && !calcSupportsFolders();
        return [...nodes].sort((a, b) => {
            const entryA = a.entry || buildSyntheticFolderEntry(a);
            const entryB = b.entry || buildSyntheticFolderEntry(b);
            if (useDefaultFlatSort) {
                return compareEntriesByDefaultFlatOrder(entryA, entryB);
            }
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
        const folderEntry = node.entry || buildSyntheticFolderEntry(node);
        const childrenTotal = children.reduce(
            (sum, child) => sum + collectFolderSizes(child), 0);
        const total = folderEntry.hpAppRoot
            ? Number(folderEntry.size) || childrenTotal
            : childrenTotal;
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

function getVariableTypeSortRank(entry) {
    if (entry.kind === 'app') {
        return 8;
    }
    const typeName = String(entry.type_name || '').toLowerCase();
    if (typeName.includes('program')) {
        return 0;
    }
    if (typeName.includes('python')) {
        return 1;
    }
    if (typeName.includes('list')) {
        return 2;
    }
    if (typeName.includes('matrix')) {
        return 3;
    }
    if (typeName.includes('equation')) {
        return 4;
    }
    if (typeName.includes('app var') || typeName.includes('appvar')) {
        return 5;
    }
    if (typeName.includes('real')) {
        return 6;
    }
    if (typeName.includes('string')) {
        return 7;
    }
    return 100;
}

function compareEntriesByDefaultFlatOrder(a, b) {
    const rankDiff = getVariableTypeSortRank(a) - getVariableTypeSortRank(b);
    if (rankDiff !== 0) {
        return rankDiff;
    }
    const nameDiff = String(a.name || '').localeCompare(String(b.name || ''));
    if (nameDiff !== 0) {
        return nameDiff;
    }
    return (Number(a.size) || 0) - (Number(b.size) || 0);
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
        const disabled = !hasSelection || isHPPrimeActive();
        els.btnDeleteSelected.disabled = disabled;
        els.btnDeleteSelected.classList.toggle('disabled', disabled);
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
    if (isNumWorksActive()) {
        log(t('numworks_keys_unavailable'));
        return;
    }
    const key = parseKeyCode(code);
    if (key === null) {
        log('Enter a valid key code (hex like 0x05 or decimal).');
        return;
    }
    try {
        if (isHPPrimeActive()) {
            if (key > 50) {
                log(t('hp_prime_key_range'));
                return;
            }
            const module = await initModule();
            const result = await ccallAsync(module, 'hp_prime_send_key', 'number',
                ['number'], [key], { timeoutMs: 12000 });
            if (result !== 0) {
                log(tFormat('hp_prime_key_send_failed', {
                    error: formatHPPrimeError(module, result)
                }));
                return;
            }
            log(tFormat('hp_prime_key_sent', {
                key,
                hex: key.toString(16).toUpperCase()
            }));
            return;
        }
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
        const result = await ccallAsync(module, 'calc_send_key', 'number', ['number', 'number'], [handle, key], { timeoutMs: 12000 });
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
        typeName: checkbox.dataset.typeName || '',
        size: Number(checkbox.dataset.size) || 0,
        kind: checkbox.dataset.kind,
        isFolder: checkbox.dataset.isFolder === '1',
        folderPath: checkbox.dataset.folderPath || '',
        hpIndex: checkbox.dataset.hpIndex === '' ? null : Number(checkbox.dataset.hpIndex),
        hpAppRoot: checkbox.dataset.hpAppRoot === '1',
        hpAppChildIndex: checkbox.dataset.hpAppChildIndex === ''
            ? null : Number(checkbox.dataset.hpAppChildIndex),
        hpAppPartKind: checkbox.dataset.hpAppPartKind || '',
        hpAppChildEditable: checkbox.dataset.hpAppChildEditable === '1',
        extension: checkbox.dataset.extension || '',
        invalid: checkbox.dataset.invalid === '1',
        numWorksName: checkbox.dataset.numWorksName || ''
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
        const confirmDirlist = confirm(t('confirm_load_dirlist_before_transfer'));
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

function encodeHPPrimeAppResourceManifest(resources) {
    const encoder = new TextEncoder();
    const encoded = resources.map(resource => ({
        name: encoder.encode(resource.name),
        data: resource.data
    }));
    let total = 4;
    encoded.forEach(resource => {
        if (resource.name.byteLength > 0xFFFFFFFF
            || resource.data.byteLength > 0xFFFFFFFF) {
            throw new Error(t('hp_prime_app_resource_too_large'));
        }
        total += 8 + resource.name.byteLength + resource.data.byteLength;
    });
    if (!Number.isSafeInteger(total)) {
        throw new Error(t('hp_prime_app_resource_too_large'));
    }
    const result = new Uint8Array(total);
    const view = new DataView(result.buffer);
    let offset = 0;
    const writeU32 = value => {
        view.setUint32(offset, value, false);
        offset += 4;
    };
    writeU32(encoded.length);
    encoded.forEach(resource => {
        writeU32(resource.name.byteLength);
        result.set(resource.name, offset);
        offset += resource.name.byteLength;
        writeU32(resource.data.byteLength);
        result.set(resource.data, offset);
        offset += resource.data.byteLength;
    });
    return result;
}

function findHPPrimeAppRoot(folderPath) {
    const normalized = normalizeFolderPath(folderPath || '');
    if (!normalized) {
        return null;
    }
    return state.dirlist.find(entry => entry.hpAppRoot
        && normalizeFolderPath(getEntryFolderPath(entry)) === normalized) || null;
}

async function sendHPPrimeAppResources(files, appRoot) {
    if (!state.hpFileSnapshotLoaded) {
        log(t('hp_prime_app_snapshot_required'));
        return;
    }
    const module = await initModule();
    const existingChildren = state.dirlist.filter(entry => entry.kind === 'hp-app-child'
        && entry.hpIndex === appRoot.hpIndex);
    const pending = [];
    const pendingNames = new Set();
    for (const file of files) {
        const name = String(file.name || '').split(/[\\/]/).pop();
        const key = name.toLowerCase();
        if (!name || pendingNames.has(key)) {
            log(tFormat('hp_prime_app_resource_skipped', { file: file.name }));
            continue;
        }
        const existing = existingChildren.find(entry => entry.name.toLowerCase() === key);
        if (existing && !existing.hpAppChildEditable) {
            log(tFormat('hp_prime_app_core_upload_rejected', { file: file.name }));
            continue;
        }
        if (existing && !confirm(tFormat('hp_prime_app_confirm_resource_overwrite', {
            file: file.name,
            app: appRoot.name
        }))) {
            log(tFormat('hp_prime_overwrite_skipped', { file: file.name }));
            continue;
        }
        pendingNames.add(key);
        pending.push({
            name,
            data: new Uint8Array(await file.arrayBuffer())
        });
    }
    if (!pending.length) {
        return;
    }
    const manifestPath = `/hp-prime-app-resources-${appRoot.hpIndex}.bin`;
    try {
        module.FS.writeFile(manifestPath,
            encodeHPPrimeAppResourceManifest(pending));
        const result = await ccallAsync(module,
            'hp_prime_send_cached_app_resources', 'number',
            ['number', 'string'], [appRoot.hpIndex, manifestPath], {
                timeoutMs: null,
                useProgress: true,
                progressLabel: tFormat('hp_prime_app_progress_updating', {
                    app: appRoot.name
                })
            });
        if (result !== 0) {
            log(tFormat('hp_prime_app_upload_failed', {
                app: appRoot.name,
                error: formatHPPrimeError(module, result)
            }));
            return;
        }
        state.expandedFolders.add(getEntryFolderPath(appRoot));
        applyHPPrimeFileSnapshot(module);
        log(tFormat('hp_prime_app_resources_sent', {
            count: pending.length,
            app: appRoot.name
        }));
    } finally {
        try {
            module.FS.unlink(manifestPath);
        } catch {
            // Best-effort cleanup.
        }
    }
}

async function sendDroppedFiles(files, dropFolder) {
    if (!files.length) {
        return;
    }
    log(`Dropped ${files.length} file(s) for transfer.`);
    if (isHPPrimeActive()) {
        const appRoot = findHPPrimeAppRoot(dropFolder);
        if (appRoot) {
            try {
                await sendHPPrimeAppResources(files, appRoot);
            } catch (error) {
                logError(error, t('hp_prime_app_upload_failed_short'));
            }
            return;
        }
        setSelectedFiles(files, 'table drop');
        try {
            await sendSelectedFiles();
        } catch (error) {
            logError(error, 'Dropped transfer failed');
        }
        return;
    }
    if (isNumWorksActive()) {
        try {
            await sendNumWorksFiles(files);
        } catch (error) {
            logError(error, t('numworks_dropped_upload_failed'));
        }
        return;
    }
    await processIncomingTransfers(files, {
        dropFolder,
        checkCableMismatch: true,
        useModal: false,
        errorContext: 'Dropped transfer failed'
    });
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

let tivarsLibPromise = null;
let webLunaPromise = null;
let previewHighlighterPromise = null;

function getPreviewHighlighter() {
    if (window.hljs) {
        return Promise.resolve(window.hljs);
    }
    if (!previewHighlighterPromise) {
        previewHighlighterPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = new URL('highlighter.min.js', document.baseURI).href;
            script.async = true;
            script.dataset.webtilpHighlighter = 'true';
            script.addEventListener('load', () => {
                if (window.hljs) {
                    resolve(window.hljs);
                } else {
                    reject(new Error('Preview highlighter is unavailable'));
                }
            }, { once: true });
            script.addEventListener('error', () => {
                reject(new Error('Failed to load the preview highlighter'));
            }, { once: true });
            document.head.appendChild(script);
        }).catch(error => {
            previewHighlighterPromise = null;
            throw error;
        });
    }
    return previewHighlighterPromise;
}

function loadPythonConverterModule(fileName, factoryName) {
    const moduleUrl = new URL(fileName, document.baseURI).href;
    return import(moduleUrl).then(imported => {
        const factory = imported.default;
        if (typeof factory !== 'function') {
            throw new Error(`${factoryName} factory is unavailable`);
        }
        return factory();
    });
}

function getTivarsLib() {
    if (!tivarsLibPromise) {
        tivarsLibPromise = loadPythonConverterModule('TIVarsLib.js', 'TIVarsLib');
    }
    return tivarsLibPromise;
}

function getWebLuna() {
    if (!webLunaPromise) {
        webLunaPromise = loadPythonConverterModule('WebLuna.js', 'WebLuna');
    }
    return webLunaPromise;
}

function sanitizePythonVarName(fileName) {
    const base = String(fileName || '').replace(/\.[^.]*$/, '');
    let name = base.toUpperCase().replace(/[^A-Z0-9_]/g, '');
    if (!/^[A-Z]/.test(name)) {
        name = `P${name}`;
    }
    name = name.slice(0, 8);
    return /^[A-Z][A-Z0-9_]{0,7}$/.test(name) ? name : 'PYTHON';
}

async function convertTivarsPythonSource(file, data, module, modelId, conversionKind) {
    const tivars = await getTivarsLib();
    const varName = sanitizePythonVarName(file.name);
    const modelName = conversionKind === PYTHON_CONVERSION_EVO
        ? EVO_PYTHON_CALC_MODELS.get(modelId)
        : CE_PYTHON_CALC_MODELS.get(modelId);
    if (!modelName) {
        return '';
    }

    const source = new TextDecoder('utf-8').decode(data);
    const variable = tivars.TIVarFile.createNew('PythonAppVar', varName, modelName);
    let converterPath = '';
    try {
        if (conversionKind === PYTHON_CONVERSION_EVO) {
            variable.setContentFromString(source);
        } else {
            variable.setContentFromString(JSON.stringify({
                typeName: 'PythonAppVar',
                filename: `${varName}.py`,
                code: source
            }));
        }
        converterPath = variable.saveVarToFile('.', varName);
        const converted = tivars.FS.readFile(converterPath, { encoding: 'binary' });
        const extension = conversionKind === PYTHON_CONVERSION_EVO ? '8xpy2' : '8xv';
        const outputPath = `/uploads/${varName}.${extension}`;
        module.FS.writeFile(outputPath, converted);
        return outputPath;
    } finally {
        if (converterPath) {
            try {
                tivars.FS.unlink(converterPath);
            } catch {
                // ignore
            }
        }
        if (typeof variable.delete === 'function') {
            variable.delete();
        }
    }
}

async function convertNspirePythonSource(file, data, module) {
    const luna = await getWebLuna();
    const inputName = String(file.name || 'python.py').replace(/[\\/]/g, '_');
    const outputName = inputName.replace(/\.[^.]*$/, '') + '.tns';
    const inputPath = `/${inputName}`;
    const converterPath = `/${outputName}`;
    try {
        luna.FS.writeFile(inputPath, data, { encoding: 'binary' });
        try {
            luna.FS.unlink(converterPath);
        } catch {
            // ignore
        }
        const result = luna.callMain([inputPath, converterPath]);
        if (result !== 0) {
            throw new Error(`Luna exited with status ${result}`);
        }
        const converted = luna.FS.readFile(converterPath, { encoding: 'binary' });
        const outputPath = `/uploads/${outputName}`;
        module.FS.writeFile(outputPath, converted);
        return outputPath;
    } finally {
        for (const path of [inputPath, converterPath]) {
            try {
                luna.FS.unlink(path);
            } catch {
                // ignore
            }
        }
    }
}

async function convertPythonSourceForCalc(file, data, module, modelId, conversionKind) {
    if (conversionKind === PYTHON_CONVERSION_CE || conversionKind === PYTHON_CONVERSION_EVO) {
        return convertTivarsPythonSource(file, data, module, modelId, conversionKind);
    }
    if (conversionKind === PYTHON_CONVERSION_NSPIRE_CXII) {
        return convertNspirePythonSource(file, data, module);
    }
    return '';
}

function isLegacyTivarsConversionCandidate(fileName) {
    const match = String(fileName || '').toLowerCase().match(/\.([^.]+)$/);
    const extension = match?.[1] || '';
    return LEGACY_TIVARS_EXTENSION_RE.test(extension)
        && !LEGACY_TIVARS_FLASH_EXTENSIONS.has(extension);
}

async function convertLegacyTivarsFileForEvo(file, data, module, modelId) {
    const modelName = EVO_PYTHON_CALC_MODELS.get(modelId);
    if (!modelName || !isLegacyTivarsConversionCandidate(file.name)) {
        return '';
    }

    const tivars = await getTivarsLib();
    const safeInputName = String(file.name || 'variable.8x?').replace(/[\\/]/g, '_');
    const outputBaseName = safeInputName.replace(/\.[^.]*$/, '') || 'VARIABLE';
    const inputPath = `/evo-input-${Date.now()}-${safeInputName}`;
    let outputPath = '';
    let variable = null;
    try {
        tivars.FS.writeFile(inputPath, data, { encoding: 'binary' });
        variable = tivars.TIVarFile.loadFromFile(inputPath);
        if (variable.isEvoFormat()) {
            return '';
        }
        variable.convertToModel(modelName, true);
        outputPath = variable.saveVarToFile('.', outputBaseName);
        const converted = tivars.FS.readFile(outputPath, { encoding: 'binary' });
        const outputName = outputPath.split('/').pop() || `${safeInputName}2`;
        const modulePath = `/uploads/${outputName}`;
        module.FS.writeFile(modulePath, converted);
        return modulePath;
    } finally {
        for (const path of [inputPath, outputPath]) {
            if (!path) {
                continue;
            }
            try {
                tivars.FS.unlink(path);
            } catch {
                // ignore
            }
        }
        if (variable && typeof variable.delete === 'function') {
            variable.delete();
        }
    }
}

async function buildTransferPlan(files, module) {
    if (!module.FS.analyzePath('/uploads').exists) {
        module.FS.mkdir('/uploads');
    }

    const uploadPaths = [];
    const activeModelId = getActiveCalcModelId();
    const pythonConversionKind = getPythonConversionKind(activeModelId);
    for (const file of files) {
        const data = new Uint8Array(await file.arrayBuffer());
        const path = `/uploads/${file.name}`;
        module.FS.writeFile(path, data);
        if (state.settings?.convertPythonFiles !== false
            && pythonConversionKind !== PYTHON_CONVERSION_NONE
            && /\.py$/i.test(file.name)) {
            try {
                const convertedPath = await convertPythonSourceForCalc(
                    file,
                    data,
                    module,
                    activeModelId,
                    pythonConversionKind
                );
                if (convertedPath && convertedPath !== path) {
                    try {
                        module.FS.unlink(path);
                    } catch {
                        // ignore
                    }
                    uploadPaths.push(convertedPath);
                    continue;
                }
            } catch (err) {
                console.warn('[WebTILP] Failed to convert Python source file', err);
            }
        }
        if (EVO_PYTHON_CALC_MODELS.has(activeModelId)
            && isLegacyTivarsConversionCandidate(file.name)) {
            try {
                const convertedPath = await convertLegacyTivarsFileForEvo(file, data, module, activeModelId);
                if (convertedPath && convertedPath !== path) {
                    try {
                        module.FS.unlink(path);
                    } catch {
                        // ignore
                    }
                    uploadPaths.push(convertedPath);
                    continue;
                }
            } catch (err) {
                console.warn(`[WebTILP] Failed to convert ${file.name} for Evo; trying the original file`, err);
            }
        }
        uploadPaths.push(path);
    }

    if (!uploadPaths.length) {
        return [];
    }

    let entries = [];
    try {
        const infoText = await ccallAsync(
            module,
            'files_get_entries_json',
            'string',
            ['string'],
            [uploadPaths.join('\n')],
            { timeoutMs: 12000 }
        );
        if (infoText && typeof infoText === 'string') {
            const parsed = JSON.parse(infoText);
            entries = Array.isArray(parsed?.files) ? parsed.files : [];
        }
    } catch (err) {
        console.warn('[WebTILP] Failed to parse batch file info', err);
    }

    // Keep modal fast and robust: complete missing metadata entries locally.
    const byPath = new Map(entries.map(item => [item.path, item]));
    const normalizedEntries = uploadPaths.map(path => {
        const existing = byPath.get(path);
        if (existing) {
            return existing;
        }
        const name = path.split('/').pop() || path;
        return { name, path, class: 'unknown', entries: [] };
    });
    return buildTransferPlanFromFsEntries(normalizedEntries, module);
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
        const baseName = name.replace(/\.[^.]+$/, '');

        if (!entriesInfo.length) {
            plan.push({
                file,
                path,
                fileClass,
                sourceFileClass: fileClass,
                entries: [],
                entryCount: 0,
                entryName: baseName,
                entryType: null,
                entryTypeName: '',
                entryFolder: '',
                entryAttr: 0,
                entrySize: null,
                defaultLocation: 'ram',
                locationMask: 3,
                locationMode: 'ram',
                sendByEntry: false,
                entryIndex: null,
                containerKind: 0
            });
            continue;
        }

        entriesInfo.forEach((entryInfo, idx) => {
            const containerType = entryInfo.container_type || '';
            const containerKind = containerType === 'app' ? 2 : (containerType === 'var' ? 1 : 0);
            const entryIndex = Number.isInteger(entryInfo.container_index) ? entryInfo.container_index : idx;
            const effectiveClass = containerType === 'app'
                ? 'application'
                : (fileClass === 'group' || fileClass === 'tigroup' ? 'single' : fileClass);
            const defaultName = entryInfo.name || baseName;
            const defaultFolder = entryInfo.folder || '';
            const entrySize = Number.isFinite(Number(entryInfo.size)) ? Number(entryInfo.size) : null;
            const locationMask = entryInfo.location_mask ?? (effectiveClass === 'application' ? 2 : 3);
            const defaultLocation = (entryInfo.attr === 3 || locationMask === 2) ? 'archive' : 'ram';
            const locationMode = locationMask === 1
                ? 'ram'
                : (locationMask === 2 ? 'archive' : (locationMask === 0 ? 'auto' : defaultLocation));

            plan.push({
                file,
                path,
                fileClass: effectiveClass,
                sourceFileClass: fileClass,
                entries: [entryInfo],
                entryCount: 1,
                entryName: defaultName,
                entryType: entryInfo.type ?? null,
                entryTypeName: entryInfo.type_name ?? '',
                entryFolder: defaultFolder,
                entryAttr: entryInfo.attr ?? 0,
                entrySize,
                defaultLocation,
                locationMask,
                locationMode,
                sendByEntry: entriesInfo.length > 1 || fileClass === 'group' || fileClass === 'tigroup',
                entryIndex,
                containerKind
            });
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
        alert(t('alert_bundle_ce_only'));
        return null;
    }

    const cleanupPaths = [];
    let bundleDir = '';
    try {
        const extracted = await extractBundleFiles(bundleFile, module);
        bundleDir = extracted.bundleDir;
        cleanupPaths.push(extracted.bundlePath);

        if (!extracted.files.length) {
            alert(t('alert_bundle_no_transferable_files'));
            return null;
        }

        const plan = await buildTransferPlanFromFsEntries(extracted.files, module);
        extracted.files.forEach(item => {
            if (item.path) {
                cleanupPaths.push(item.path);
            }
        });
        applyBundleDefaults(plan);

        const modalResult = await openTransferModal(plan, {
            hasFolder: options.hasFolder,
            hasArchive: options.hasArchive,
            folders: options.folders
        });
        if (!modalResult) {
            return null;
        }
        const { selections, overwriteAll } = modalResult;

        const nonOs = selections.filter(item => !isCEBundleOSFile(item));
        const osItems = selections.filter(item => isCEBundleOSFile(item));
        const orderedSelections = nonOs.concat(osItems);

        const { successCount } = await performTransfers(orderedSelections, module, {
            hasFolder: options.hasFolder,
            hasArchive: options.hasArchive,
            overwriteAll
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
    if (els.transferOverwriteAll) {
        els.transferOverwriteAll.checked = false;
    }
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
    document.querySelectorAll('.transfer-size').forEach(cell => {
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
        const hasParsedSize = item.entrySize !== null && item.entrySize !== undefined && item.entrySize !== '';
        const parsedSize = hasParsedSize ? Number(item.entrySize) : NaN;
        const sizeLabel = Number.isFinite(parsedSize) && parsedSize >= 0 ? formatBytes(parsedSize) : '-';
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
            <td class="transfer-size">${escapeHtml(sizeLabel)}</td>
            <td class="transfer-type">${escapeHtml(typeLabel)}</td>
            ${locationCell}
            ${folderCell}
        `;
        row.addEventListener('click', event => {
            const interactive = event.target?.closest?.('input, select, option, button, a, label, textarea');
            if (interactive) {
                return;
            }
            const checkbox = row.querySelector('[data-field="select"]');
            if (!checkbox || checkbox.disabled) {
                return;
            }
            checkbox.checked = !checkbox.checked;
        });
        els.transferTableBody.appendChild(row);

        if (options.hasFolder) {
            const folderSelect = row.querySelector('[data-field="folder"]');
            if (folderSelect) {
                folderSelect.value = item.entryFolder || '';
            }
        }
    });

    const hasBulkLocationTargets = plan.length > 1
        && options.hasArchive
        && plan.some(item => isVarFileClass(item.fileClass) && (item.locationMask ?? 3) === 3);
    els.transferBulkLocationActions?.classList.toggle('hidden', !hasBulkLocationTargets);

    els.transferModal.classList.remove('hidden');

    return new Promise(resolve => {
        const setAllLocations = (location) => {
            els.transferTableBody.querySelectorAll('select[data-field="location"]').forEach(select => {
                if (Array.from(select.options).some(option => option.value === location)) {
                    select.value = location;
                }
            });
        };
        const onAllRam = () => setAllLocations('ram');
        const onAllArchive = () => setAllLocations('archive');
        const cleanup = () => {
            els.btnConfirmTransfer.removeEventListener('click', onConfirm);
            els.btnCancelTransfer.removeEventListener('click', onCancel);
            els.btnCloseTransfer.removeEventListener('click', onCancel);
            els.btnTransferAllRam?.removeEventListener('click', onAllRam);
            els.btnTransferAllArchive?.removeEventListener('click', onAllArchive);
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
                alert(t('alert_select_file_to_transfer'));
                return;
            }
            cleanup();
            els.transferModal.classList.add('hidden');
            resolve({
                selections,
                overwriteAll: Boolean(els.transferOverwriteAll?.checked)
            });
        };
        els.btnTransferAllRam?.addEventListener('click', onAllRam);
        els.btnTransferAllArchive?.addEventListener('click', onAllArchive);
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
    const configuredCableTimeout = Number(state.settings?.cableTimeout);
    const originalCableTimeout = Number.isFinite(configuredCableTimeout) && configuredCableTimeout > 0
        ? configuredCableTimeout
        : 50;
    const archiveEntryTimeout = 250; // 25.0s (setting unit is 1/10s)
    const osEntryTimeout = 600; // 60s; can take a while sometimes

    for (const item of plan) {
        if (!item.path) {
            continue;
        }
        try {
            const isVar = isVarFileClass(item.fileClass);
            const displayName = item.entryName ? `${item.file.name} (${item.entryName})` : item.file.name;
            if (!confirmEvoOsModelMismatch(item, module)) {
                log(`Skipped ${item.file.name}, because the cross-model OS transfer was declined.`);
                continue;
            }
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
                    const overwrite = options.overwriteAll
                        ? true
                        : confirm(tFormat('confirm_overwrite_existing', { name: targetName }));
                    if (!overwrite) {
                        log(`Skipped ${item.file.name}, because overwriting was declined.`);
                        continue;
                    }
                    if (existing.attr !== 0 && hasSilverlinkConnected()) {
                        const msg = tFormat('alert_cannot_overwrite_locked', { name: targetName });
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
                                const msg = tFormat('alert_failed_clear_attributes', {
                                    name: targetName,
                                    error: formatErrorResult(module, clearAttrResult)
                                });
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
                                msg = tFormat('alert_cannot_overwrite_locked', { name: targetName });
                            } else {
                                msg = tFormat('alert_failed_delete_existing', {
                                    name: targetName,
                                    error: formatErrorResult(module, deleteResult)
                                });
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

            let locationCode = -1;
            if (isVar && locationMask === 1) {
                locationCode = 0;
            } else if (isVar && locationMask === 2) {
                locationCode = 1;
            } else if (canOverrideLocation && selectionLocation !== item.defaultLocation) {
                locationCode = selectionLocation === 'archive' ? 1 : 0;
            }
            const isArchiveOrFlashTransfer = item.fileClass === 'application'
                || item.fileClass === 'flash'
                || item.fileClass === 'os'
                || (isVar && targetLocation === 'archive');
            const entryCableTimeout = item.fileClass === 'os'
                ? Math.max(originalCableTimeout, osEntryTimeout)
                : isArchiveOrFlashTransfer
                ? Math.max(originalCableTimeout, archiveEntryTimeout)
                : originalCableTimeout;

            let timeoutAdjusted = false;
            if (module && entryCableTimeout !== originalCableTimeout) {
                try {
                    module._set_cable_timeout(entryCableTimeout);
                    timeoutAdjusted = true;
                } catch (err) {
                    console.warn('[WebTILP] Failed to set temporary cable timeout for archive/flash transfer', err);
                }
            }

            let result = 0;
            try {
                clearNativeWarnings();
                if (item.sendByEntry && Number.isInteger(item.entryIndex)) {
                    result = await ccallAsync(
                        module,
                        'send_file_entry_custom',
                        'number',
                        ['number', 'string', 'number', 'number', 'string', 'number'],
                        [handle, item.path, item.entryIndex, item.containerKind || 0, folderOverride, locationCode],
                        { timeoutMs: 60000, useProgress: true, progressLabel: `Sending ${displayName}` }
                    );
                } else {
                    result = await ccallAsync(
                        module,
                        'send_file_custom',
                        'number',
                        ['number', 'string', 'string', 'number'],
                        [handle, item.path, folderOverride, locationCode],
                        { timeoutMs: 60000, useProgress: true, progressLabel: `Sending ${displayName}` }
                    );
                }
            } finally {
                if (timeoutAdjusted) {
                    try {
                        module._set_cable_timeout(originalCableTimeout);
                    } catch (err) {
                        console.warn('[WebTILP] Failed to restore cable timeout after archive/flash transfer', err);
                    }
                }
            }

            if (result === 0) {
                log(`Sent ${displayName} successfully.`);
                successCount += 1;
                if (isVar && targetName && item.entryType != null) {
                    state.dirlist.push({
                        name: targetName,
                        type: item.entryType,
                        folder: targetFolder,
                        attr: targetLocation === 'archive' ? 3 : (targetLocation === 'ram' ? 0 : item.entryAttr),
                        kind: 'var',
                        is_folder: 0,
                        size: item.entries?.[0]?.size ?? item.file.size
                    });
                }
            } else {
                log(`Failed to send ${displayName}: ${formatErrorResult(module, result)}.${getNativeWarningSuffix(result)}`);
            }
        } catch (err) {
            if (err?.silent) {
                throw err;
            }
            const label = item?.entryName ? `${item.file?.name || 'file'} (${item.entryName})` : (item.file?.name || 'file');
            log(`Failed to send ${label}: ${err?.message || 'unknown error'}.${getNativeWarningSuffix()}`);
        }
    }
    return { successCount };
}

async function sendNumWorksFiles(files) {
    const normalizeName = globalThis.WebTILPNumWorks?.normalizeScriptName;
    if (!normalizeName || !state.numWorksBackend) {
        throw new Error(t('numworks_backend_not_connected'));
    }
    const existing = new Map(state.dirlist
        .filter(entry => entry.kind === 'numworks')
        .map(entry => [String(entry.name).toLowerCase(), entry]));
    const pending = [];
    const pendingNames = new Set();
    for (const file of files) {
        if (!/\.py$/i.test(file.name || '')) {
            log(tFormat('numworks_unsupported_file', { file: file.name }));
            continue;
        }
        const normalized = normalizeName(file.name);
        const key = normalized.toLowerCase();
        if (pendingNames.has(key)) {
            throw new Error(tFormat('numworks_duplicate_normalized', { name: normalized }));
        }
        const existingEntry = existing.get(key);
        if (existingEntry
            && !confirm(tFormat('numworks_confirm_overwrite', {
                file: file.name,
                name: normalized
            }))) {
            log(tFormat('numworks_overwrite_skipped', { file: file.name }));
            continue;
        }
        const originalBase = String(file.name).replace(/\.py$/i, '');
        if (originalBase !== normalized) {
            log(tFormat('numworks_name_normalized', {
                file: file.name,
                name: normalized
            }));
        }
        pendingNames.add(key);
        pending.push({
            name: normalized,
            code: await file.text(),
            autoImport: existingEntry ? Boolean(existingEntry.attr) : true
        });
    }
    if (!pending.length) {
        log(t('numworks_no_supported_scripts'));
        return;
    }
    await state.numWorksBackend.upsertScripts(pending);
    setSelectedFiles([]);
    readNumWorksInfo();
    applyNumWorksStorageSnapshot();
    log(tFormat('numworks_scripts_sent', { count: pending.length }));
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
        if (isHPPrimeActive()) {
            const module = await initModule();
            let successCount = 0;
            if (!state.hpFileSnapshotLoaded
                && !confirm(t('hp_prime_confirm_unchecked_overwrite'))) {
                log(t('hp_prime_upload_cancelled'));
                return;
            }
            for (let index = 0; index < files.length; index++) {
                const file = files[index];
                const identity = getHPPrimeUploadIdentity(file.name);
                if (!identity) {
                    log(tFormat('hp_prime_unsupported_file', { file: file.name }));
                    continue;
                }
                const duplicate = state.hpFileSnapshotLoaded
                    ? state.dirlist.find(entry => {
                        const entryExtension = String(entry.extension || '').toLowerCase();
                        const normalizedExtension = entryExtension === 'hpmatrix'
                            ? 'hpmat' : entryExtension;
                        return entry.kind === 'hp' && entry.name === identity.name
                            && normalizedExtension === identity.extension;
                    })
                    : null;
                if (duplicate && !confirm(tFormat('hp_prime_confirm_overwrite', {
                    file: file.name,
                    existing: duplicate.name
                }))) {
                    log(tFormat('hp_prime_overwrite_skipped', { file: file.name }));
                    continue;
                }
                const path = `/hp-prime-upload-${index}.bin`;
                try {
                    module.FS.writeFile(path, new Uint8Array(await file.arrayBuffer()));
                    const result = await ccallAsync(module, 'hp_prime_send_file', 'number',
                        ['string', 'string'], [path, file.name], {
                            timeoutMs: null,
                            useProgress: true,
                            progressLabel: tFormat('hp_prime_progress_sending_file', { file: file.name })
                        });
                    if (result === 0) {
                        successCount += 1;
                        state.hpFileSnapshotLoaded = false;
                        log(tFormat('hp_prime_file_sent', { file: file.name }));
                    } else {
                        log(tFormat('hp_prime_file_send_failed', {
                            file: file.name,
                            error: formatHPPrimeError(module, result)
                        }));
                    }
                } finally {
                    try {
                        module.FS.unlink(path);
                    } catch {
                        // Best-effort cleanup.
                    }
                }
            }
            if (successCount > 0) {
                setSelectedFiles([]);
                await refreshDirlist();
            }
            return;
        }
        if (isNumWorksActive()) {
            try {
                await sendNumWorksFiles(files);
            } catch (error) {
                logError(error, t('numworks_upload_failed'));
            }
            return;
        }
        await processIncomingTransfers(files, {
            checkCableMismatch: false,
            useModal: true,
            errorContext: 'Send files failed'
        });
    } finally {
        setButtonLoading(els.btnSendFiles, false);
        // A completed HP Prime transfer can clear the selected files while the
        // button is still in its loading state. Recompute from the current
        // selection after restoring the button so stale pre-transfer state
        // cannot leave it enabled.
        updateSendFilesButtonState();
    }
}

async function processIncomingTransfers(files, options = {}) {
    const {
        dropFolder = '',
        useModal = true,
        checkCableMismatch = false,
        errorContext = 'Send files failed'
    } = options;

    if (!files.length) {
        return;
    }

    try {
        await authorizeDevice();
        if (checkCableMismatch && promptCableMismatchResolution()) {
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

        if (!useModal && effectiveFolder) {
            log(`Target folder: ${effectiveFolder}`);
        }

        const bundleCandidates = files.filter(isCeBundleFile);
        if (bundleCandidates.length > 0) {
            if (bundleCandidates.length !== files.length) {
                alert(t('alert_bundle_only_files'));
                return;
            }
            if (bundleCandidates.length > 1) {
                alert(t('alert_bundle_one_at_a_time'));
                return;
            }
            const bundleResult = await handleCeBundleTransfer(bundleCandidates[0], module, { hasFolder, hasArchive, folders });
            if (bundleResult?.successCount > 0) {
                setSelectedFiles([]);
            }
            return;
        }

        const plan = await buildTransferPlan(files, module);
        const planPaths = [...new Set(plan.map(item => item.path).filter(Boolean))];
        let selections = [];
        let overwriteAll = false;
        try {
            if (useModal) {
                const modalResult = await openTransferModal(plan, { hasFolder, hasArchive, folders });
                if (!modalResult) {
                    return;
                }
                selections = modalResult.selections;
                overwriteAll = modalResult.overwriteAll;
            } else {
                selections = plan.map(item => ({
                    ...item,
                    targetFolder: effectiveFolder
                }));
            }

            const { successCount } = await performTransfers(selections, module, { hasFolder, hasArchive, overwriteAll });
            const hasOsTransfer = selections.some(item => item.fileClass === 'os');
            if (successCount > 0) {
                setSelectedFiles([]);
                if (!hasOsTransfer) {
                    await refreshDirlist();
                }
            }
        } finally {
            planPaths.forEach(path => {
                try {
                    module.FS.unlink(path);
                } catch {
                    // ignore
                }
            });
        }
    } catch (err) {
        logError(err, errorContext);
    }
}

async function receiveBackup() {
    setButtonLoading(els.btnReceiveBackup, true);
    try {
        if (isHPPrimeActive()) {
            const module = await initModule();
            if (!module.FS.analyzePath('/downloads').exists) {
                module.FS.mkdir('/downloads');
            }
            const target = '/downloads/hp-prime-backup.zip';
            const refresh = beginHPPrimeFileSnapshot(module);
            let result;
            try {
                result = await ccallAsync(module, 'hp_prime_backup', 'number', ['string'], [target], {
                    timeoutMs: null,
                    useProgress: true,
                    progressLabel: t('hp_prime_progress_receiving_backup')
                });
            } catch (error) {
                finishHPPrimeFileSnapshot(module, refresh, false);
                throw error;
            }
            if (result !== 0) {
                finishHPPrimeFileSnapshot(module, refresh, false);
                log(tFormat('hp_prime_backup_failed', {
                    error: formatHPPrimeError(module, result)
                }));
                return;
            }
            const snapshotCount = finishHPPrimeFileSnapshot(module, refresh, true);
            const data = module.FS.readFile(target);
            triggerDownload('hp-prime-backup.zip', data);
            module.FS.unlink(target);
            log(tFormat('hp_prime_backup_received', { count: snapshotCount }));
            return;
        }
        if (isNumWorksActive()) {
            const data = await state.numWorksBackend.readRawStorageImage();
            const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
            triggerDownload(`numworks-storage-${stamp}.bin`, data);
            log(tFormat('numworks_backup_received', { size: data.byteLength }));
            return;
        }
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
                    const proceed = confirm(t('confirm_large_backup_continue_standard'));
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
        const notice = t('confirm_receive_os_notice');
        if (!confirm(notice)) {
            return;
        }
        state.nspireOsReceiveStarted = true;
        updateNspireOsButtons(true, (state.features & FEATURE_FLAGS.OPS_ROMDUMP) !== 0);
        const extension = getFlashOsExtensionFromModule(module);
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
    const notice = t('confirm_dump_rom_notice');
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

async function downloadHPPrimeEntry(entry) {
    if (!Number.isInteger(entry.hpIndex) || entry.hpIndex < 0) {
        throw new Error(tFormat('hp_prime_missing_cache_index', { name: entry.name }));
    }
    if (entry.invalid && !confirm(tFormat('hp_prime_confirm_invalid_crc', { name: entry.name }))) {
        log(tFormat('hp_prime_invalid_crc_skipped', { name: entry.name }));
        return false;
    }
    const module = await initModule();
    if (!module.FS.analyzePath('/downloads').exists) {
        module.FS.mkdir('/downloads');
    }
    const safeName = String(entry.name || 'unnamed').replace(/[\\/\0-\x1F\x7F]/g, '_');
    const extension = String(entry.extension || '').replace(/[^A-Za-z0-9_-]/g, '');
    const isAppChild = Number.isInteger(entry.hpAppChildIndex)
        && entry.hpAppChildIndex >= 0;
    const filename = isAppChild
        ? safeName : (extension ? `${safeName}.${extension}` : safeName);
    const target = isAppChild
        ? `/downloads/hp-prime-${entry.hpIndex}-child-${entry.hpAppChildIndex}.bin`
        : `/downloads/hp-prime-${entry.hpIndex}.bin`;
    const result = isAppChild
        ? await ccallAsync(module, 'hp_prime_download_cached_app_child', 'number',
            ['number', 'number', 'string'],
            [entry.hpIndex, entry.hpAppChildIndex, target], { timeoutMs: 8000 })
        : await ccallAsync(module, 'hp_prime_download_cached_file', 'number',
            ['number', 'string'], [entry.hpIndex, target], { timeoutMs: 8000 });
    if (result !== 0) {
        throw new Error(tFormat('hp_prime_cached_download_failed', {
            error: formatHPPrimeError(module, result)
        }));
    }
    const data = module.FS.readFile(target);
    triggerDownload(filename, data);
    module.FS.unlink(target);
    log(tFormat('hp_prime_file_received', { file: filename }));
    return true;
}

async function downloadHPPrimeEntries(entries) {
    const selectedAppRoots = new Set(entries
        .filter(entry => entry.hpAppRoot && Number.isInteger(entry.hpIndex))
        .map(entry => entry.hpIndex));
    const downloads = entries.filter(entry => !Number.isInteger(entry.hpAppChildIndex)
        || !selectedAppRoots.has(entry.hpIndex));
    for (const entry of downloads) {
        try {
            await downloadHPPrimeEntry(entry);
        } catch (err) {
            logError(err, tFormat('hp_prime_file_download_failed_context', {
                name: entry.name
            }));
        }
    }
}

function downloadNumWorksEntry(entry) {
    if (!state.numWorksBackend) {
        throw new Error(t('numworks_backend_not_connected'));
    }
    const script = state.numWorksBackend.getScript(entry.numWorksName || entry.name);
    triggerDownload(script.name, new TextEncoder().encode(script.code));
    log(tFormat('numworks_file_received', { file: script.name }));
    return true;
}

async function receiveSelected() {
    const selections = getSelectedVarInputs().map(buildEntryFromCheckbox);
    if (!selections.length) {
        log('No variables selected.');
        return;
    }
    if (isHPPrimeActive()) {
        setButtonLoading(els.btnRecvSelected, true);
        try {
            await downloadHPPrimeEntries(selections);
        } finally {
            setButtonLoading(els.btnRecvSelected, false);
        }
        return;
    }
    if (isNumWorksActive()) {
        setButtonLoading(els.btnRecvSelected, true);
        try {
            for (const entry of selections) {
                downloadNumWorksEntry(entry);
            }
        } catch (err) {
            logError(err, t('numworks_receive_selected_failed'));
        } finally {
            setButtonLoading(els.btnRecvSelected, false);
        }
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
            if (!confirm(tFormat('confirm_download_items_from_folders', { items: totalItems, folders: keptFolders.length }))) {
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
    if (!confirm(tFormat('confirm_delete_items', { count: selections.length }))) {
        return;
    }
    setButtonLoading(els.btnDeleteSelected, true);
    try {
        if (isNumWorksActive()) {
            await state.numWorksBackend.deleteScripts(selections.map(entry => entry.name));
            readNumWorksInfo();
            applyNumWorksStorageSnapshot();
            log(tFormat('numworks_scripts_deleted', { count: selections.length }));
            return;
        }
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
    const newName = prompt(tFormat('prompt_rename_entry', { kind: label }), currentName);
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
        if (isHPPrimeActive()) {
            if (!state.hpFileSnapshotLoaded) {
                log(t('hp_prime_app_snapshot_required'));
                return;
            }
            if (!entry.hpAppChildEditable
                || !Number.isInteger(entry.hpIndex)
                || !Number.isInteger(entry.hpAppChildIndex)) {
                log(t('hp_prime_app_core_read_only'));
                return;
            }
            const module = await initModule();
            const result = await ccallAsync(module,
                'hp_prime_rename_cached_app_resource', 'number',
                ['number', 'number', 'string'],
                [entry.hpIndex, entry.hpAppChildIndex, trimmed], {
                    timeoutMs: null,
                    useProgress: true,
                    progressLabel: tFormat('hp_prime_app_progress_updating', {
                        app: entry.folder
                    })
                });
            if (result !== 0) {
                log(tFormat('hp_prime_app_rename_failed', {
                    error: formatHPPrimeError(module, result)
                }));
                return;
            }
            state.expandedFolders.add(entry.folder);
            applyHPPrimeFileSnapshot(module);
            log(tFormat('hp_prime_app_resource_renamed', {
                old: currentName,
                name: trimmed,
                app: entry.folder
            }));
            return;
        }
        if (isNumWorksActive()) {
            const renamed = await state.numWorksBackend.renameScript(currentName, trimmed);
            readNumWorksInfo();
            applyNumWorksStorageSnapshot();
            log(tFormat('numworks_script_renamed', { old: currentName, name: renamed }));
            return;
        }
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
    if (!confirm(tFormat('confirm_delete_entry', {
        kind: t(entry.isFolder ? 'kind_folder' : 'kind_item'),
        name: entry.name
    }))) {
        return;
    }
    setButtonLoading(els.btnDeleteSelected, true);
    try {
        if (isHPPrimeActive()) {
            if (!state.hpFileSnapshotLoaded) {
                log(t('hp_prime_app_snapshot_required'));
                return;
            }
            if (!entry.hpAppChildEditable
                || !Number.isInteger(entry.hpIndex)
                || !Number.isInteger(entry.hpAppChildIndex)) {
                log(t('hp_prime_app_core_read_only'));
                return;
            }
            const module = await initModule();
            const result = await ccallAsync(module,
                'hp_prime_delete_cached_app_resource', 'number',
                ['number', 'number'],
                [entry.hpIndex, entry.hpAppChildIndex], {
                    timeoutMs: null,
                    useProgress: true,
                    progressLabel: tFormat('hp_prime_app_progress_updating', {
                        app: entry.folder
                    })
                });
            if (result !== 0) {
                log(tFormat('hp_prime_app_delete_failed', {
                    error: formatHPPrimeError(module, result)
                }));
                return;
            }
            state.expandedFolders.add(entry.folder);
            applyHPPrimeFileSnapshot(module);
            log(tFormat('hp_prime_app_resource_deleted', {
                name: entry.name,
                app: entry.folder
            }));
            return;
        }
        if (isNumWorksActive()) {
            await state.numWorksBackend.deleteScripts([entry.name]);
            readNumWorksInfo();
            applyNumWorksStorageSnapshot();
            log(tFormat('numworks_script_deleted', { name: entry.name }));
            return;
        }
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
    if (isHPPrimeActive()) {
        setButtonLoading(els.btnRecvSelected, true);
        try {
            await downloadHPPrimeEntry(entry);
        } catch (err) {
            logError(err, t('hp_prime_download_failed'));
        } finally {
            setButtonLoading(els.btnRecvSelected, false);
        }
        return;
    }
    if (isNumWorksActive()) {
        setButtonLoading(els.btnRecvSelected, true);
        try {
            downloadNumWorksEntry(entry);
        } catch (err) {
            logError(err, t('numworks_download_failed'));
        } finally {
            setButtonLoading(els.btnRecvSelected, false);
        }
        return;
    }
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

let previewSession = null;
let previewRenderId = 0;

function disposePreviewSession() {
    const session = previewSession;
    previewSession = null;
    previewRenderId += 1;
    if (session?.objectUrl) {
        URL.revokeObjectURL(session.objectUrl);
    }
    if (session?.module && session.receivedPath) {
        try {
            session.module.FS.unlink(session.receivedPath);
        } catch (error) {
            console.warn('[WebTILP] Failed to remove preview file:', error);
        }
    }
    if (session?.options && typeof session.options.delete === 'function') {
        session.options.delete();
    }
    if (session?.variable && typeof session.variable.delete === 'function') {
        session.variable.delete();
    }
}

function closePreviewModal() {
    if (els.previewModal) {
        els.previewModal.classList.add('hidden');
        els.previewModal.setAttribute('aria-hidden', 'true');
    }
    if (els.previewImage) {
        els.previewImage.removeAttribute('src');
        els.previewImage.classList.add('hidden');
    }
    if (els.previewControls) {
        els.previewControls.classList.add('hidden');
    }
    if (els.previewBasicDownloads) {
        els.previewBasicDownloads.classList.add('hidden');
    }
    if (els.btnDownloadPreview) {
        els.btnDownloadPreview.classList.remove('hidden');
    }
    if (els.previewReindent) {
        els.previewReindent.checked = false;
    }
    disposePreviewSession();
}

function formatTivarsException(tivars, error) {
    if (tivars?.getExceptionMessage) {
        try {
            const message = tivars.getExceptionMessage(error);
            if (Array.isArray(message)) {
                const joined = message.filter(Boolean).join(': ');
                if (joined) {
                    return joined;
                }
            } else if (message) {
                return String(message);
            }
        } catch {
            // Fall through to the regular error formatting.
        }
    }
    return error?.message || String(error);
}

function unwrapReadablePreview(readable) {
    let content = String(readable ?? '');
    let imageDataUrl = '';
    let language = '';
    try {
        const parsed = JSON.parse(content);
        let displayValue = parsed;
        if (typeof parsed.readableContent === 'string') {
            try {
                const nested = JSON.parse(parsed.readableContent);
                if (typeof nested.previewImageDataUrl === 'string') {
                    imageDataUrl = nested.previewImageDataUrl;
                    delete nested.previewImageDataUrl;
                }
                displayValue = nested;
            } catch {
                displayValue = parsed.readableContent;
            }
        } else if (typeof parsed.python?.code === 'string') {
            displayValue = parsed.python.code;
            language = 'python';
        } else if (typeof parsed.code === 'string') {
            displayValue = parsed.code;
        } else if (typeof parsed.previewImageDataUrl === 'string') {
            imageDataUrl = parsed.previewImageDataUrl;
            delete parsed.previewImageDataUrl;
            displayValue = Object.keys(parsed).length ? parsed : '';
        }
        if (typeof displayValue !== 'string') {
            language = 'json';
        }
        content = typeof displayValue === 'string'
            ? displayValue
            : JSON.stringify(displayValue, null, 2);
    } catch {
        // Plain-text readable content needs no additional processing.
    }
    return { content, imageDataUrl, language };
}

function decodeHPPrimeTextPreview(data) {
    let bytes = data instanceof Uint8Array ? data : new Uint8Array(data || 0);
    if (bytes.byteLength >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
        bytes = bytes.subarray(2);
    }
    if ((bytes.byteLength & 1) !== 0) {
        throw new Error(t('hp_prime_text_preview_invalid'));
    }
    return new TextDecoder('utf-16le', { fatal: true }).decode(bytes)
        .replace(/^\uFEFF/, '')
        .replace(/\u0000+$/, '');
}

function createHPPrimePreview(entry, data) {
    const kind = getHPPrimePreviewKind(entry);
    if (kind === 'text') {
        return {
            readable: decodeHPPrimeTextPreview(data),
            objectUrl: ''
        };
    }
    if (kind === 'image') {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data || 0);
        const pngSignature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        if (bytes.byteLength < pngSignature.length
            || pngSignature.some((value, index) => bytes[index] !== value)) {
            throw new Error(t('hp_prime_png_preview_invalid'));
        }
        const objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
        return {
            readable: JSON.stringify({ previewImageDataUrl: objectUrl }),
            objectUrl
        };
    }
    throw new Error(`Preview is not supported for ${entry?.name || 'this HP Prime file'}.`);
}

function isTIBasicPreviewEntry(entry, modelId) {
    const typeId = Number(entry.type);
    const typeName = String(entry.typeName || entry.type_name || '').trim().toLowerCase();
    if (typeName && typeName.includes('program') && !typeName.includes('python')) {
        return true;
    }
    return EVO_PYTHON_CALC_MODELS.has(modelId)
        ? TIVARS_EVO_BASIC_PROGRAM_TYPES.has(typeId)
        : TIVARS_LEGACY_BASIC_PROGRAM_TYPES.has(typeId);
}

function usesTIBasicPreviewSyntax(entry, modelId) {
    const typeId = Number(entry.type);
    return EVO_PYTHON_CALC_MODELS.has(modelId)
        ? TIVARS_EVO_BASIC_SYNTAX_TYPES.has(typeId)
        : TIVARS_LEGACY_BASIC_SYNTAX_TYPES.has(typeId);
}

function renderJsonHighlightedPreview(content) {
    const fragment = document.createDocumentFragment();
    const tokenPattern = /"(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\b(?:true|false|null)\b/g;
    let offset = 0;
    for (const match of content.matchAll(tokenPattern)) {
        const index = match.index ?? 0;
        fragment.appendChild(document.createTextNode(content.slice(offset, index)));
        const token = match[0];
        const span = document.createElement('span');
        if (token.startsWith('"')) {
            span.className = /^\s*:/.test(content.slice(index + token.length))
                ? 'hljs-attribute'
                : 'hljs-string';
        } else if (/^(?:true|false|null)$/.test(token)) {
            span.className = 'hljs-literal';
        } else {
            span.className = 'hljs-number';
        }
        span.textContent = token;
        fragment.appendChild(span);
        offset = index + token.length;
    }
    fragment.appendChild(document.createTextNode(content.slice(offset)));
    els.previewContent.replaceChildren(fragment);
}

function renderHighlightedPreview(content, language) {
    if (!els.previewContent) {
        return;
    }
    const renderId = ++previewRenderId;
    els.previewContent.classList.toggle('hljs', Boolean(language));
    els.previewContent.textContent = content;
    if (!language) {
        return;
    }
    if (language === 'json') {
        renderJsonHighlightedPreview(content);
        return;
    }
    getPreviewHighlighter().then(highlighter => {
        if (renderId !== previewRenderId || !els.previewContent) {
            return;
        }
        els.previewContent.innerHTML = highlighter.highlight(language, content).value;
    }).catch(error => {
        console.warn('[WebTILP] Preview syntax highlighting unavailable:', error);
    });
}

function renderPreviewContent(entry, readable) {
    const preview = unwrapReadablePreview(readable);
    const language = previewSession?.language || preview.language || '';
    renderHighlightedPreview(preview.content, language);
    if (els.previewImage) {
        els.previewImage.classList.toggle('hidden', !preview.imageDataUrl);
        if (preview.imageDataUrl) {
            els.previewImage.src = preview.imageDataUrl;
        } else {
            els.previewImage.removeAttribute('src');
        }
        els.previewImage.alt = `${t('preview')}: ${formatVariableDisplayName(entry)}`;
    }
}

function openPreviewModal(entry, readable) {
    if (!els.previewModal || !els.previewContent) {
        return;
    }
    els.previewTitle.textContent = `${t('preview')}: ${formatVariableDisplayName(entry)}`;
    els.previewMeta.textContent = `${entry.typeName || `Type ${entry.type}`} · ${formatBytes(entry.size)}`;
    if (els.previewControls) {
        els.previewControls.classList.toggle('hidden', !previewSession?.isTIBasic);
    }
    const hasBasicDownloadControls = Boolean(
        els.previewBasicDownloads
        && els.btnDownloadPreviewEvo
        && els.btnDownloadPreviewLegacy
    );
    const showBasicDownloads = Boolean(previewSession?.isTIBasic && hasBasicDownloadControls);
    if (els.previewBasicDownloads) {
        els.previewBasicDownloads.classList.toggle('hidden', !showBasicDownloads);
    }
    if (els.btnDownloadPreview) {
        els.btnDownloadPreview.classList.toggle('hidden', showBasicDownloads);
    }
    if (els.previewReindent) {
        els.previewReindent.checked = false;
    }
    renderPreviewContent(entry, readable);
    els.previewModal.classList.remove('hidden');
    els.previewModal.setAttribute('aria-hidden', 'false');
    els.btnClosePreview?.focus();
}

function refreshPreviewReindent() {
    const session = previewSession;
    if (!session?.isTIBasic || !session.variable || !session.options) {
        return;
    }
    try {
        const enabled = els.previewReindent?.checked ? 1 : 0;
        session.options.set('prettify', 1);
        session.options.set('reindent', enabled);
        const readable = session.variable.getReadableContent(session.options);
        renderPreviewContent(session.entry, readable);
    } catch (error) {
        logError(new Error(formatTivarsException(session.tivars, error)), 'Preview failed');
    }
}

function downloadPreviewFile() {
    const session = previewSession;
    if (!session) {
        return;
    }
    try {
        const data = session.data || (session.module && session.receivedPath
            ? session.module.FS.readFile(session.receivedPath) : null);
        if (!data) {
            return;
        }
        triggerDownload(session.downloadName, data);
    } catch (error) {
        logError(error, 'Preview download failed');
    }
}

function downloadTIBasicPreview(targetModel) {
    const session = previewSession;
    if (!session?.isTIBasic || !session.module || !session.receivedPath || !session.tivars) {
        return;
    }

    const safeInputName = String(session.downloadName || 'program.8xp').replace(/[\\/]/g, '_');
    const outputBaseName = String(session.entry?.name || safeInputName.replace(/\.[^.]*$/, '') || 'PROGRAM')
        .replace(/[\\/]/g, '_');
    const inputPath = `/preview-download-${Date.now()}-${safeInputName}`;
    let outputPath = '';
    let variable = null;
    try {
        const data = session.module.FS.readFile(session.receivedPath);
        session.tivars.FS.writeFile(inputPath, data, { encoding: 'binary' });
        variable = session.tivars.TIVarFile.loadFromFile(inputPath);
        variable.convertToModel(targetModel, targetModel === '84Evo');
        outputPath = variable.saveVarToFile('.', outputBaseName);
        const converted = session.tivars.FS.readFile(outputPath, { encoding: 'binary' });
        const outputName = outputPath.split('/').pop() || (targetModel === '84Evo' ? 'program.8xp2' : 'program.8xp');
        triggerDownload(outputName, converted);
    } catch (error) {
        logError(new Error(formatTivarsException(session.tivars, error)), 'Preview download failed');
    } finally {
        for (const path of [inputPath, outputPath]) {
            if (!path) {
                continue;
            }
            try {
                session.tivars.FS.unlink(path);
            } catch {
                // ignore
            }
        }
        if (variable && typeof variable.delete === 'function') {
            variable.delete();
        }
    }
}

async function previewEntry(entry, actionButton) {
    if (!canPreviewVariable({
        ...entry,
        type_name: entry.typeName,
        is_folder: entry.isFolder ? 1 : 0
    })) {
        log(`Preview is not supported for ${entry.name}.`);
        return;
    }

    setButtonLoading(actionButton, true);
    let module = null;
    let receivedPath = '';
    let tivars = null;
    let converterPath = '';
    let variable = null;
    let options = null;
    let objectUrl = '';
    try {
        if (entry.kind === 'numworks') {
            if (!state.numWorksBackend) {
                throw new Error(t('numworks_backend_not_connected'));
            }
            const script = state.numWorksBackend.getScript(entry.numWorksName || entry.name);
            const data = new TextEncoder().encode(script.code);
            closePreviewModal();
            previewSession = {
                entry,
                isTIBasic: false,
                language: 'python',
                data,
                downloadName: script.name
            };
            openPreviewModal(entry, script.code);
            log(`Previewed ${script.name}.`);
            return;
        }

        const hpPreviewKind = getHPPrimePreviewKind(entry);
        if (hpPreviewKind) {
            if (!Number.isInteger(entry.hpIndex) || entry.hpIndex < 0) {
                throw new Error(tFormat('hp_prime_missing_cache_index', { name: entry.name }));
            }
            if (entry.invalid
                && !confirm(tFormat('hp_prime_confirm_invalid_crc', { name: entry.name }))) {
                log(tFormat('hp_prime_invalid_crc_skipped', { name: entry.name }));
                return;
            }
            module = await initModule();
            if (!module.FS.analyzePath('/previews').exists) {
                module.FS.mkdir('/previews');
            }
            const isAppChild = Number.isInteger(entry.hpAppChildIndex)
                && entry.hpAppChildIndex >= 0;
            receivedPath = isAppChild
                ? `/previews/hp-prime-${entry.hpIndex}-child-${entry.hpAppChildIndex}.bin`
                : `/previews/hp-prime-${entry.hpIndex}.bin`;
            const result = isAppChild
                ? await ccallAsync(module, 'hp_prime_download_cached_app_child', 'number',
                    ['number', 'number', 'string'],
                    [entry.hpIndex, entry.hpAppChildIndex, receivedPath], { timeoutMs: 8000 })
                : await ccallAsync(module, 'hp_prime_download_cached_file', 'number',
                    ['number', 'string'], [entry.hpIndex, receivedPath], { timeoutMs: 8000 });
            if (result !== 0) {
                throw new Error(tFormat('hp_prime_cached_download_failed', {
                    error: formatHPPrimeError(module, result)
                }));
            }
            const data = module.FS.readFile(receivedPath);
            const extension = getEntryExtension(entry);
            const safeName = String(entry.name || 'unnamed').replace(/[\\/\0-\x1F\x7F]/g, '_');
            const downloadName = isAppChild || !extension
                ? safeName : `${safeName}.${extension}`;
            const preview = createHPPrimePreview(entry, data);
            objectUrl = preview.objectUrl;
            closePreviewModal();
            previewSession = {
                entry,
                isTIBasic: false,
                language: '',
                module,
                receivedPath,
                downloadName,
                objectUrl
            };
            receivedPath = '';
            objectUrl = '';
            openPreviewModal(entry, preview.readable);
            log(`Previewed ${entry.name}.`);
            return;
        }

        const modelId = getActiveCalcModelId();
        await authorizeDevice();
        module = await initModule();
        const handle = await ensureHandle();
        if (!module.FS.analyzePath('/previews').exists) {
            module.FS.mkdir('/previews');
        }
        const result = await ccallAsync(
            module,
            'calc_recv_var',
            'number',
            ['number', 'string', 'string', 'number', 'string'],
            [handle, entry.folder, entry.name, entry.type, '/previews'],
            {
                timeoutMs: PROGRESS_IDLE_TIMEOUT_MS,
                useProgress: true,
                progressLabel: `Preparing preview for ${entry.name}`
            }
        );
        if (result !== 0) {
            throw new Error(`Receive failed (${formatErrorResult(module, result)})`);
        }

        receivedPath = module.FS.readFile('/last_recv_path.txt', { encoding: 'utf8' }).trim();
        if (!receivedPath) {
            throw new Error('The received preview file path is unavailable');
        }
        const data = module.FS.readFile(receivedPath);
        const receivedName = receivedPath.split('/').pop() || 'preview.8x?';

        tivars = await getTivarsLib();
        converterPath = `/preview-${Date.now()}-${receivedName.replace(/[\\/]/g, '_')}`;
        tivars.FS.writeFile(converterPath, data, { encoding: 'binary' });
        try {
            variable = tivars.TIVarFile.loadFromFile(converterPath);
            options = new tivars.options_t();
            options.set('prettify', 1);
            options.set('reindent', 0);
            const isTIBasic = isTIBasicPreviewEntry(entry, modelId);
            let language = usesTIBasicPreviewSyntax(entry, modelId) ? 'basic-z80' : '';
            if (!language && EVO_PYTHON_CALC_MODELS.has(modelId) && Number(entry.type) === 15) {
                language = 'python';
            } else if (!language && Number(entry.type) === 0x15) {
                options.set('metadata', 1);
                try {
                    const metadata = JSON.parse(variable.getReadableContent(options));
                    if (metadata?.typeName === 'PythonAppVar') {
                        language = 'python';
                    }
                } catch {
                    // A regular AppVar has no structured Python metadata.
                } finally {
                    options.set('metadata', 0);
                }
            }
            const readable = variable.getReadableContent(options);
            closePreviewModal();
            previewSession = {
                entry,
                tivars,
                variable,
                options,
                isTIBasic,
                language,
                module,
                receivedPath,
                downloadName: receivedName
            };
            variable = null;
            options = null;
            receivedPath = '';
            openPreviewModal(entry, readable);
            log(`Previewed ${entry.name}.`);
        } catch (error) {
            throw new Error(formatTivarsException(tivars, error));
        }
    } catch (err) {
        logError(err, 'Preview failed');
    } finally {
        if (options && typeof options.delete === 'function') {
            options.delete();
        }
        if (variable && typeof variable.delete === 'function') {
            variable.delete();
        }
        if (tivars && converterPath) {
            try {
                tivars.FS.unlink(converterPath);
            } catch {
                // ignore
            }
        }
        if (module && receivedPath) {
            try {
                module.FS.unlink(receivedPath);
            } catch {
                // ignore
            }
        }
        if (objectUrl) {
            URL.revokeObjectURL(objectUrl);
        }
        if (module) {
            try {
                module.FS.unlink('/last_recv_path.txt');
            } catch {
                // ignore
            }
        }
        setButtonLoading(actionButton, false);
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
        if (!confirm(tFormat('confirm_download_items_from_target', {
            count: entries.length,
            target: target || t('root')
        }))) {
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

function hpPrimePngPaethPredictor(left, above, upperLeft) {
    const estimate = left + above - upperLeft;
    const leftDistance = Math.abs(estimate - left);
    const aboveDistance = Math.abs(estimate - above);
    const upperLeftDistance = Math.abs(estimate - upperLeft);
    if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) {
        return left;
    }
    return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function parseHPPrimeRgb555Png(png) {
    const signature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    if (!(png instanceof Uint8Array)
        || png.length < signature.length
        || !signature.every((value, index) => png[index] === value)) {
        throw new Error('The HP Prime returned an invalid PNG screenshot.');
    }

    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    let offset = signature.length;
    let header = null;
    const imageParts = [];
    let imageSize = 0;
    while (offset + 12 <= png.length) {
        const size = view.getUint32(offset, false);
        const dataStart = offset + 8;
        const dataEnd = dataStart + size;
        if (dataEnd + 4 > png.length) {
            throw new Error('The HP Prime returned a truncated PNG screenshot.');
        }
        const type = String.fromCharCode(
            png[offset + 4], png[offset + 5], png[offset + 6], png[offset + 7]
        );
        if (type === 'IHDR') {
            if (size !== 13 || header) {
                throw new Error('The HP Prime returned an invalid PNG header.');
            }
            header = {
                width: view.getUint32(dataStart, false),
                height: view.getUint32(dataStart + 4, false),
                bitDepth: png[dataStart + 8],
                colorType: png[dataStart + 9],
                compression: png[dataStart + 10],
                filter: png[dataStart + 11],
                interlace: png[dataStart + 12]
            };
        } else if (type === 'IDAT') {
            imageParts.push(png.subarray(dataStart, dataEnd));
            imageSize += size;
        } else if (type === 'IEND') {
            break;
        }
        offset = dataEnd + 4;
    }

    if (!header) {
        throw new Error('The HP Prime screenshot has no PNG header.');
    }
    // Prime format 8 labels native little-endian RGB555 words as PNG
    // grayscale-16 samples. Standard PNG decoders therefore show a noisy
    // grayscale image; preserve other formats for the browser to decode.
    if (header.bitDepth !== 16 || header.colorType !== 0) {
        return null;
    }
    if (!header.width || !header.height
        || header.width > 4096 || header.height > 4096
        || header.compression !== 0 || header.filter !== 0
        || header.interlace !== 0 || imageParts.length === 0) {
        throw new Error('The HP Prime returned an unsupported PNG screenshot.');
    }

    const compressed = new Uint8Array(imageSize);
    let imageOffset = 0;
    for (const part of imageParts) {
        compressed.set(part, imageOffset);
        imageOffset += part.length;
    }
    return { ...header, compressed };
}

async function decodeHPPrimeRgb555Png(png) {
    const parsed = parseHPPrimeRgb555Png(png);
    if (!parsed) {
        return null;
    }
    if (typeof DecompressionStream !== 'function') {
        throw new Error('This browser cannot decode HP Prime color screenshots.');
    }

    const stream = new Blob([parsed.compressed])
        .stream()
        .pipeThrough(new DecompressionStream('deflate'));
    const inflated = new Uint8Array(await new Response(stream).arrayBuffer());
    const bytesPerPixel = 2;
    const stride = parsed.width * bytesPerPixel;
    const expectedSize = (stride + 1) * parsed.height;
    if (inflated.length !== expectedSize) {
        throw new Error('The HP Prime returned incomplete PNG pixel data.');
    }

    const raw = new Uint8Array(stride * parsed.height);
    let inputOffset = 0;
    for (let y = 0; y < parsed.height; y += 1) {
        const filter = inflated[inputOffset++];
        if (filter > 4) {
            throw new Error(`The HP Prime returned an unknown PNG filter (${filter}).`);
        }
        const rowOffset = y * stride;
        const previousRowOffset = rowOffset - stride;
        for (let x = 0; x < stride; x += 1) {
            const encoded = inflated[inputOffset++];
            const left = x >= bytesPerPixel ? raw[rowOffset + x - bytesPerPixel] : 0;
            const above = y > 0 ? raw[previousRowOffset + x] : 0;
            const upperLeft = y > 0 && x >= bytesPerPixel
                ? raw[previousRowOffset + x - bytesPerPixel]
                : 0;
            let predictor = 0;
            if (filter === 1) predictor = left;
            else if (filter === 2) predictor = above;
            else if (filter === 3) predictor = Math.floor((left + above) / 2);
            else if (filter === 4) predictor = hpPrimePngPaethPredictor(left, above, upperLeft);
            raw[rowOffset + x] = (encoded + predictor) & 0xFF;
        }
    }

    const rgba = new Uint8ClampedArray(parsed.width * parsed.height * 4);
    for (let source = 0, target = 0; source < raw.length; source += 2, target += 4) {
        const rgb555 = raw[source] | (raw[source + 1] << 8);
        const red = (rgb555 >> 10) & 0x1F;
        const green = (rgb555 >> 5) & 0x1F;
        const blue = rgb555 & 0x1F;
        rgba[target] = (red << 3) | (red >> 2);
        rgba[target + 1] = (green << 3) | (green >> 2);
        rgba[target + 2] = (blue << 3) | (blue >> 2);
        rgba[target + 3] = 0xFF;
    }
    return { width: parsed.width, height: parsed.height, rgba };
}

async function drawHPPrimeScreenshot(canvas, png) {
    const decoded = await decodeHPPrimeRgb555Png(png);
    if (decoded) {
        canvas.width = decoded.width;
        canvas.height = decoded.height;
        const ctx = canvas.getContext('2d');
        const imageData = ctx.createImageData(decoded.width, decoded.height);
        imageData.data.set(decoded.rgba);
        ctx.putImageData(imageData, 0, 0);
        return;
    }

    const bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }));
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close?.();
}

async function takeScreenshot() {
    setButtonLoading(els.btnScreenshot, true);
    try {
        if (isHPPrimeActive()) {
            const module = await initModule();
            const target = '/hp-prime-screenshot.png';
            const result = await ccallAsync(module, 'hp_prime_screenshot', 'number', ['string', 'number'], [target, 8], {
                timeoutMs: null,
                useProgress: true,
                progressLabel: t('hp_prime_progress_receiving_screenshot')
            });
            if (result !== 0) {
                log(tFormat('hp_prime_screenshot_failed', {
                    error: formatHPPrimeError(module, result)
                }));
                return;
            }
            const png = module.FS.readFile(target);
            const canvas = els.screenshotCanvas;
            await drawHPPrimeScreenshot(canvas, png);
            canvas.classList.add('filled');
            updateScreenshotCanvasScale();
            module.FS.unlink(target);
            log(tFormat('hp_prime_screenshot_captured', {
                width: canvas.width,
                height: canvas.height
            }));
            return;
        }
        if (isNumWorksActive()) {
            log(t('numworks_screenshot_unavailable'));
            return;
        }
        await authorizeDevice();
        const module = await initModule();
        const handle = await ensureHandle();
        const result = await ccallAsync(module, 'calc_screenshot', 'number', ['number'], [handle], { timeoutMs: null, useProgress: true, progressLabel: 'Receiving screenshot' });
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

async function convertReceivedPythonFile(filename, data) {
    if (state.settings?.convertPythonFiles === false) {
        return null;
    }
    const conversionKind = getPythonConversionKind(getActiveCalcModelId());
    const isCeCandidate = conversionKind === PYTHON_CONVERSION_CE && /\.8xv$/i.test(filename);
    const isEvoCandidate = conversionKind === PYTHON_CONVERSION_EVO && /\.8xpy2$/i.test(filename);
    if (!isCeCandidate && !isEvoCandidate) {
        return null;
    }

    const safeInputName = String(filename || 'python-var').replace(/[\\/]/g, '_');
    const converterPath = `/${safeInputName}`;
    let tivars = null;
    let variable = null;
    let options = null;
    try {
        tivars = await getTivarsLib();
        tivars.FS.writeFile(converterPath, data, { encoding: 'binary' });
        variable = tivars.TIVarFile.loadFromFile(converterPath);
        options = new tivars.options_t();
        options.set('metadata', 1);
        const metadata = JSON.parse(variable.getReadableContent(options));

        let source = '';
        let sourceName = '';
        if (isCeCandidate && metadata.typeName === 'PythonAppVar' && typeof metadata.code === 'string') {
            source = metadata.code;
            sourceName = metadata.filename || safeInputName.replace(/\.[^.]*$/, '');
        } else if (isEvoCandidate
            && metadata.typeName === 'PythonScript'
            && metadata.python?.compiledModule === false
            && typeof metadata.python.code === 'string') {
            source = metadata.python.code;
            sourceName = metadata.python.name || safeInputName.replace(/\.[^.]*$/, '');
        } else {
            return null;
        }

        sourceName = String(sourceName).replace(/[\\/]/g, '_');
        if (!/\.py$/i.test(sourceName)) {
            sourceName += '.py';
        }
        return {
            filename: sourceName,
            data: new TextEncoder().encode(source)
        };
    } catch {
        return null;
    } finally {
        if (options && typeof options.delete === 'function') {
            options.delete();
        }
        if (variable && typeof variable.delete === 'function') {
            variable.delete();
        }
        if (tivars) {
            try {
                tivars.FS.unlink(converterPath);
            } catch {
                // ignore
            }
        }
    }
}

async function downloadLastReceived(module, fallbackName) {
    let filename = fallbackName || 'download.bin';
    try {
        const lastPath = module.FS.readFile('/last_recv_path.txt', { encoding: 'utf8' }).trim();
        if (lastPath) {
            filename = lastPath.split('/').pop();
            let data = module.FS.readFile(lastPath);
            const converted = await convertReceivedPythonFile(filename, data);
            if (converted) {
                filename = converted.filename;
                data = converted.data;
            }
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
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
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
    const wasHPPrime = isHPPrimeActive();
    const wasNumWorks = isNumWorksActive();
    if (wasHPPrime && state.module) {
        try {
            await ccallAsync(state.module, 'hp_prime_disconnect', 'number', [], [], { timeoutMs: 8000 });
        } catch (err) {
            console.warn('[WebTILP] Failed to close HP Prime WebHID session cleanly', err);
        }
    }
    if (wasNumWorks) {
        try {
            await state.numWorksBackend?.close();
        } catch (err) {
            console.warn('[WebTILP] Failed to close the NumWorks WebUSB session cleanly', err);
        }
    }
    if (!wasHPPrime && !wasNumWorks) {
        try { await state.authorizedDevice?.reset(); } catch (e) {}
    }
    if (isNspireActive()) {
        try { await state.authorizedDevice?.forget(); } catch (e) {}
    }
    try {
        if (state.module && !wasHPPrime && !wasNumWorks) {
            try {
                state.module._notify_usb_disconnect();
            } catch (err) {
                console.warn('[WebTILP] Failed to reset USB state', err);
            }
        }
    } finally {
        retireModule(state.module, 'emergency reset');
        state.handle = 0;
        state.activeFamily = DEVICE_FAMILY_TI;
        state.numWorksBackend = null;
        state.module = null;
        state.cableOpen = false;
        state.authorizedDevice = null;
        state.connectInProgress = false;
        state.handlePromise = null;
        state.needsReauthorize = false;
        state.silentReconnectInProgress = false;
        clearDeviceData();
        applyActiveFamilyUiState();
        setConnected(false);
        setStatus('status_disconnected', false);
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
        setStatus('status_select_device', false);
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
        updatePythonConversionSettingAvailability();
    });
    els.settingCalcModel.addEventListener('change', updatePythonConversionSettingAvailability);
    els.settingsModal.addEventListener('click', event => {
        if (event.target === els.settingsModal) {
            closeSettingsModal();
        }
    });
    els.btnClosePreview?.addEventListener('click', closePreviewModal);
    els.btnDownloadPreview?.addEventListener('click', downloadPreviewFile);
    els.btnDownloadPreviewEvo?.addEventListener('click', () => downloadTIBasicPreview('84Evo'));
    els.btnDownloadPreviewLegacy?.addEventListener('click', () => downloadTIBasicPreview('84+CE'));
    els.btnDismissPreview?.addEventListener('click', closePreviewModal);
    els.previewReindent?.addEventListener('change', refreshPreviewReindent);
    els.previewModal?.addEventListener('click', event => {
        if (event.target === els.previewModal) {
            closePreviewModal();
        }
    });
    if (els.btnCloseConnectionHelp) {
        els.btnCloseConnectionHelp.addEventListener('click', closeConnectionHelpModal);
    }
    if (els.newFolderModal) {
        els.newFolderModal.addEventListener('click', event => {
            if (event.target === els.newFolderModal) {
                closeNewFolderModal();
            }
        });
    }
    if (els.connectionHelpModal) {
        els.connectionHelpModal.addEventListener('click', event => {
            if (event.target === els.connectionHelpModal) {
                closeConnectionHelpModal();
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
            state.sort.userDefined = true;
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
        const actionButton = event.target.closest('button.action-preview, button.action-rename, button.action-delete, button.action-download');
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
                if (actionButton.classList.contains('action-preview')) {
                    await previewEntry(entry, actionButton);
                } else if (actionButton.classList.contains('action-rename')) {
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
            if (els.previewModal && !els.previewModal.classList.contains('hidden')) {
                closePreviewModal();
                return;
            }
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

async function bootstrap() {
    initTheme();
    applyUrlOverrides();
    try {
        await applyTranslations();
    } catch (err) {
        console.warn('[WebTILP] Translation setup failed, continuing with English fallback.', err);
        state.uiLanguage = 'en';
        document.documentElement.lang = 'en';
    }
    bindEvents();
    loadBuildInfo();
    seedSettingsForm();
    updateSendFilesButtonState();
    updateSelectionActionButtons();
    updateKeyControlsState(false);
    updateTransportSplashState();
    autoConnectIfAuthorized();
    window.addEventListener('resize', updateScreenshotCanvasScale);
}

bootstrap().catch(err => {
    console.error('[WebTILP] Bootstrap failed', err);
});

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
function handleTransportDisconnect(event = null) {
    const numWorksBackend = state.numWorksBackend;
    if (numWorksBackend && event?.device && event.device !== numWorksBackend.device) {
        return;
    }
    const silent = state.silentReconnectInProgress;
    clearActiveOperations(silent ? undefined : 'Active operation cancelled due to disconnect.');
    state.handle = 0;
    state.cableOpen = false;
    state.authorizedDevice = null;
    state.connectInProgress = false;
    state.handlePromise = null;
    state.numWorksBackend = null;
    numWorksBackend?.close().catch(error => {
        console.warn('[WebTILP] Failed to close the disconnected NumWorks session.', error);
    });
    if (!silent) {
        state.activeFamily = DEVICE_FAMILY_TI;
        retireModule(state.module, 'device disconnected');
        state.module = null;
        state.needsReauthorize = false;
        clearDeviceData();
        applyActiveFamilyUiState();
        setConnected(false);
        setStatus('status_disconnected', false);
        log('Device disconnected.');
    }
}

function handleTransportConnect(event = null) {
    const numWorksBackend = state.numWorksBackend;
    if (numWorksBackend && event?.device
        && event.device !== numWorksBackend.device) {
        return;
    }
    if (state.silentReconnectInProgress) {
        return;
    }
    retireModule(state.module, 'device reconnected');
    state.handle = 0;
    state.module = null;
    state.cableOpen = false;
    state.authorizedDevice = null;
    state.connectInProgress = false;
    state.numWorksBackend = null;
    numWorksBackend?.close().catch(error => {
        console.warn('[WebTILP] Failed to close the reconnected NumWorks session.', error);
    });
    state.activeFamily = DEVICE_FAMILY_TI;
    setConnected(false);
    setStatus('status_device_connected', false);
    log('Device connected. Reinitialize to use it.');
    clearDeviceData();
    applyActiveFamilyUiState();
}

if (navigator.usb) {
    navigator.usb.addEventListener('disconnect', handleTransportDisconnect);
    navigator.usb.addEventListener('connect', handleTransportConnect);
}
if (navigator.serial) {
    navigator.serial.addEventListener('disconnect', handleTransportDisconnect);
    navigator.serial.addEventListener('connect', handleTransportConnect);
}
if (navigator.hid) {
    navigator.hid.addEventListener('disconnect', event => {
        if (isHPPrimeDevice(event.device)) {
            handleTransportDisconnect(event);
        }
    });
    navigator.hid.addEventListener('connect', event => {
        if (isHPPrimeDevice(event.device)) {
            handleTransportConnect(event);
        }
    });
}
if (!self.isSecureContext) {
    setStatus('status_insecure_context', false);
    log(t('transport_secure_context_error'));
} else if (navigator.usb) {
    setStatus('idle', false);
} else if (navigator.serial) {
    setStatus('status_webserial_only', false);
    log('WebUSB is not available in this browser. WebSerial-only mode supports TI-83/84 Evo calculators and explicitly selected GrayLink serial cables.');
} else if (navigator.hid) {
    setStatus('idle', false);
    log(t('hp_prime_webhid_only_mode'));
} else {
    setStatus('status_webusb_unsupported', false);
    log('WebUSB is not available in this browser. Use a WebUSB-compatible browser for full calculator support.');
}
