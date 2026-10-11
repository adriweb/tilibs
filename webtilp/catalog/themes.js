'use strict';

// Available UI themes and their storage key.
const THEME_STORAGE_KEY = 'webtilp.theme';
const THEMES = [
    { id: 'dark-modern', labelKey: 'theme_dark_modern' },
    { id: 'light-modern', labelKey: 'theme_light_modern' },
    { id: 'retro', labelKey: 'theme_retro' },
    { id: 'professional-light', labelKey: 'theme_professional_light' },
    { id: 'professional-dark', labelKey: 'theme_professional_dark' },
    { id: 'minimal', labelKey: 'theme_minimal' }
];

module.exports = {
    THEME_STORAGE_KEY,
    THEMES
};
