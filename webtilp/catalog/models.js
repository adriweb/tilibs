'use strict';

// Calculator model choices and persisted settings defaults.
const { CABLE_DIRECTLINK, CABLE_SILVERLINK, CABLE_GRAYLINK } = require('./devices');

const SETTINGS_DEFAULTS = {
    calcModelSchemaVersion: 2,
    cableModel: 'auto',
    calcModel: 'auto',
    cableTimeout: 50,
    cableDelay: 10,
    language: 'auto',
    convertScriptFiles: true
};

const CABLE_OPTIONS = [
    { value: 'auto', label: 'Auto' },
    { value: CABLE_DIRECTLINK, label: 'DirectLink USB' },
    { value: CABLE_SILVERLINK, label: 'SilverLink (Graph Link USB)' },
    { value: CABLE_GRAYLINK, label: 'GrayLink serial (RS232)' }
];

const SILVERLINK_CALC_VALUES = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 16, 17]);
const DIRECTLINK_CALC_VALUES = new Set([13, 14, 15, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 48, 49, 50]);

const CALC_MODEL_OPTIONS = [
    { value: 'auto', label: 'Auto' },
    { value: 'sharp-auto', label: 'Sharp EL-99xx (auto)' },
    { value: 'sharp-el9900', label: 'Sharp EL-9900' },
    { value: 'sharp-el9900g', label: 'Sharp EL-9900G' },
    { value: 'sharp-el9900gsii', label: 'Sharp EL-9900G SII' },
    { value: 'sharp-el9950', label: 'Sharp EL-9950' },
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
    { value: 37, label: 'TI Presenter' },
    { value: 38, label: 'CBL' },
    { value: 39, label: 'CBR' },
    { value: 40, label: 'CBL2' },
    { value: 41, label: 'CBR2' },
    { value: 42, label: 'LabPro' },
    { value: 48, label: 'TI-84 Evo' },
    { value: 49, label: 'TI-84 Evo-T' },
    { value: 50, label: 'TI-83 Evo' }
];

module.exports = {
    SETTINGS_DEFAULTS,
    CABLE_OPTIONS,
    SILVERLINK_CALC_VALUES,
    DIRECTLINK_CALC_VALUES,
    CALC_MODEL_OPTIONS
};
