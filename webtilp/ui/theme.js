'use strict';

/**
 * ui theme. Browser and application dependencies are injected
 * by app.js; importing this module does not start the application.
 * @param {object} dependencies
 * @returns {object}
 */
function createUiTheme(dependencies) {
    function isMinimalTheme() {
        return dependencies.document.body.dataset.theme === 'minimal';
    }

    function iconMarkup(name) {
        return `<svg class="icon" aria-hidden="true"><use href="#icon-${name}"></use></svg>`;
    }

    function themeIconMarkup(name, emoji) {
        const glyph = dependencies.isMinimalTheme() ? dependencies.iconMarkup(name) : dependencies.escapeHtml(emoji);
        return `<span class="theme-icon" data-icon="${dependencies.escapeHtml(name)}" data-emoji="${dependencies.escapeHtml(emoji)}" aria-hidden="true">${glyph}</span>`;
    }

    function updateThemeIcons() {
        // Only replace glyphs: changing theme must preserve controls, loading state,
        // selected variables, and the existing sticky-folder header.
        dependencies.document.querySelectorAll('.theme-icon').forEach(element => {
            if (dependencies.isMinimalTheme()) {
                element.innerHTML = dependencies.iconMarkup(element.dataset.icon);
            } else {
                element.textContent = element.dataset.emoji;
            }
        });
    }

    function setIconLabel(element, iconName, label, emoji) {
        if (!element) {
            return;
        }
        const preserved = element.querySelector('.settings-update-dot');
        element.innerHTML = `${dependencies.themeIconMarkup(iconName, emoji)} ${dependencies.escapeHtml(label)}`;
        if (preserved) {
            element.appendChild(preserved);
        }
    }

    function applyTheme(themeId) {
        const found = dependencies.THEMES.find(theme => theme.id === themeId);
        const target = found ? found.id : dependencies.THEMES[0].id;
        dependencies.document.body.dataset.theme = target;
        dependencies.localStorage.setItem(dependencies.THEME_STORAGE_KEY, target);
        dependencies.updateThemeButton();
        dependencies.updateThemeIcons();
    }

    function updateThemeButton() {
        if (!dependencies.els.btnThemeToggle) {
            return;
        }
        const current = dependencies.document.body.dataset.theme || dependencies.THEMES[0].id;
        const theme = dependencies.THEMES.find(entry => entry.id === current) || dependencies.THEMES[0];
        dependencies.els.btnThemeToggle.textContent = `${dependencies.t('theme_prefix')}: ${dependencies.getOptionLabel(theme)}`;
    }

    function cycleTheme() {
        const current = dependencies.document.body.dataset.theme || dependencies.THEMES[0].id;
        const index = dependencies.THEMES.findIndex(entry => entry.id === current);
        const next = dependencies.THEMES[(index + 1) % dependencies.THEMES.length].id;
        dependencies.applyTheme(next);
    }

    function initTheme() {
        const stored = dependencies.localStorage.getItem(dependencies.THEME_STORAGE_KEY);
        dependencies.applyTheme(stored || dependencies.THEMES[0].id);
    }

    return { isMinimalTheme, iconMarkup, themeIconMarkup, updateThemeIcons, setIconLabel, applyTheme, updateThemeButton, cycleTheme, initTheme };
}

module.exports = { createUiTheme };
