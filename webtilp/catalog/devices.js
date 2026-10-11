'use strict';

// Calculator families, transports, and native capability masks.
const TI_VENDOR_ID = 0x0451; // Texas Instruments
const PID_TI84_EVO_SERIAL = 0xE018;
const SERIAL_KIND_EVO = 1;
const SERIAL_KIND_GRAYLINK = 2;
const SERIAL_KIND_HP_LEGACY = 3;
const SERIAL_KIND_SHARP = 4;
const DEVICE_FAMILY_SHARP = 'sharp';
const SHARP_VENDOR_ID = 0x04FC;
const SHARP_PRODUCT_ID = 0x0201;
const CABLE_GRAYLINK = '1';
const CABLE_SILVERLINK = '4';
const CABLE_DIRECTLINK = '5';
const DEVICE_FAMILY_TI = 'ti';
const DEVICE_FAMILY_HP_PRIME = 'hp-prime';
const DEVICE_FAMILY_HP_LEGACY = 'hp-legacy';
const DEVICE_FAMILY_NUMWORKS = 'numworks';
const DEVICE_FAMILY_CASIO = 'casio';
const HP_VENDOR_ID = 0x03F0;
const HP_LEGACY_PRODUCT_ID = 0x0121;
const HP_PRIME_PRODUCT_IDS = new Set([0x0441, 0x1541, 0x2441]);
const NUMWORKS_VENDOR_ID = 0x0483;
const NUMWORKS_PRODUCT_ID = 0xA291;
const CASIO_VENDOR_ID = 0x07CF;
const CASIO_SERIAL_PRODUCT_ID = 0x6101;

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
 // { productId: 0xE015, name: "TI-Rover BT" },                             // not for us
 // { productId: 0xE016, name: "TI Bluetooth Adapter" },                    // not for us
    { productId: 0xE018, name: "TI-83/84 Evo" },                            // CDC serial: selected through WebUSB, data through WebSerial
    { productId: 0xE01C, name: "Data Collection Sled [Nspire Lab Cradle, Nspire Datatracker Cradle]" },
 // { productId: 0xE01E, name: "Nspire CX Navigator Access Point" },        // not for us
 // { productId: 0xE01F, name: "Python Adapter (firmware install mode)" },  // not for us
 // { productId: 0xE020, name: "Python Adapter" },                          // not for us
    { productId: 0xE022, name: "TI-Nspire CX II Hand-Held" },
];
const TI_USB_PRODUCT_IDS = new Set(TI_USB_DEVICES.map(device => device.productId));

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

const PID_SILVERLINK = 0xe001;
const DIRECTLINK_PIDS = new Set([
    0xe003, // PID_TI84P
    0xe004, // PID_TI89TM
    0xe008, // PID_TI84P_SE
    0xe012, // PID_NSPIRE
    0xe018, // PID_TI84EVO
    0xe01c, // PID_NSPIRE_CRADLE
    0xe022  // PID_NSPIRE_CXII
]);

const NSPIRE_PIDS = new Set([0xE012, 0xE01C, 0xE022]);
const TI84P_FAMILY_PIDS = new Set([0xE003, 0xE008]);

module.exports = {
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
};
