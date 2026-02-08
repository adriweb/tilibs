/**
 * WebUSB Helper for libticables
 *
 * This JavaScript helper provides convenience functions for using libticables
 * with WebUSB in a browser environment. WebUSB requires user interaction to
 * grant device permissions, so applications must call requestTICalculatorDevice()
 * before attempting to enumerate or open cables.
 *
 * Usage:
 *   // In your HTML, attach to a button click or other user gesture:
 *   await Module.requestTICalculatorDevice();
 *
 *   // Now you can use libticables normally:
 *   const handle = Module._ticables_handle_new(Module.CABLE_USB, 1);
 *   Module._ticables_cable_open(handle);
 */

const TI_VENDOR_ID = 0x0451; // Texas Instruments

// Known TI USB devices
const TI_USB_DEVICES = [
    { productId: 0xE001, name: "TI-GRAPH LINK USB (SilverLink)" },
    { productId: 0xE003, name: "TI-84 Plus Hand-Held" },
    { productId: 0xE004, name: "TI-89 Titanium Hand-Held" },
    { productId: 0xE008, name: "TI-84 Plus Silver Edition Hand-Held" },
    { productId: 0xE012, name: "TI-Nspire Hand-Held" },
    { productId: 0xE022, name: "TI-Nspire CX II Hand-Held" }
];

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
        throw new Error("WebUSB is not supported in this browser. Please use Chrome 61+, Edge 79+, or Opera 48+.");
    }

    try {
        const device = await navigator.usb.requestDevice({
            filters: TI_USB_DEVICES.map(dev => ({
                vendorId: TI_VENDOR_ID,
                productId: dev.productId
            }))
        });

        console.log("TI Calculator selected:", device.productName || "Unknown device");
        console.log("  Vendor ID:", "0x" + device.vendorId.toString(16).padStart(4, '0'));
        console.log("  Product ID:", "0x" + device.productId.toString(16).padStart(4, '0'));

        return device;
    } catch (error) {
        if (error && error.name === 'NotFoundError') {
            console.warn("No TI calculator was selected");
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

/**
 * Check if the browser supports WebUSB.
 *
 * @returns {boolean} True if WebUSB is supported
 */
function isWebUSBSupported() {
    return 'usb' in navigator;
}

/**
 * Check if the page is served over HTTPS or localhost.
 * WebUSB requires a secure context.
 *
 * @returns {boolean} True if running in a secure context
 */
function isSecureContext() {
    // Use self instead of window to work in both main thread and Web Workers
    return typeof self !== 'undefined' && self.isSecureContext;
}

// Expose functions to Emscripten Module
// Only initialize in main thread (Web Workers don't have access to navigator.usb)
if (typeof Module !== 'undefined' && typeof importScripts === 'undefined') {
    Module.requestTICalculatorDevice = requestTICalculatorDevice;
    Module.getAuthorizedDevices = getAuthorizedDevices;
    Module.isWebUSBSupported = isWebUSBSupported;
    Module.isSecureContext = isSecureContext;

    Module.preRun = () => {
        //ENV.G_MESSAGES_DEBUG = 'all';
    };

    // Export cable type constant for convenience
    Module.CABLE_USB = 5; // CABLE_USB enum value

    console.log("WebUSB helper loaded for libticables");
    console.log("  WebUSB supported:", isWebUSBSupported());
    console.log("  Secure context:", isSecureContext());
    if (!isSecureContext()) {
        console.warn("  WARNING: WebUSB requires HTTPS or localhost!");
    }
}
