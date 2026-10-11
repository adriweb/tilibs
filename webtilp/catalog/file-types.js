'use strict';

// File conversion, preview, OS, and bundle metadata.
const HP_PRIME_UPLOAD_EXTENSIONS = new Set([
    'hpapp', 'hplist', 'hpmat', 'hpmatrix', 'hpnote', 'hpprgm',
    'hpappnote', 'hpappprgm', 'hpcomplex', 'hpreal'
]);

const CE_PYTHON_CALC_MODELS = new Map([
    [19, '83PCEEP'],
    [20, '84+CEPy'],
    [36, '82AEP']
]);
const EVO_PYTHON_CALC_MODELS = new Map([
    [48, '84Evo'],
    [49, '84Evo'],
    [50, '84Evo']
]);
const NSPIRE_CXII_PYTHON_CALC_MODELS = new Set([32, 33, 34, 35]);
const NSPIRE_LUA_CALC_MODELS = new Set([15, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35]);
const TIVARS_PREVIEW_CALC_MODELS = new Set([
    1, 2, 3, 4, 5, 13, 17, 18, 19, 20, 21, 22, 36, 48, 49, 50
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

const EVO_OS_MODEL_BY_EXTENSION = new Map([
    ['84b2', 'TI-84 Evo'],
    ['84pk2', 'TI-84 Evo'],
    ['83b2', 'TI-83 Evo'],
    ['83pk2', 'TI-83 Evo'],
    ['84tb2', 'TI-84 Evo-T'],
    ['84tpk2', 'TI-84 Evo-T']
]);

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

module.exports = {
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
};
