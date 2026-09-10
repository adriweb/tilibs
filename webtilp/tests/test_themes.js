'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');

function extractFunction(name) {
    const start = app.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} exists`);
    const bodyStart = app.indexOf(') {', start) + 2;
    let depth = 0;
    for (let i = bodyStart; i < app.length; i++) {
        if (app[i] === '{') depth++;
        if (app[i] === '}') depth--;
        if (!depth) return app.slice(start, i + 1);
    }
    throw new Error(`Unterminated function ${name}`);
}

function decode(text) {
    return text.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => ({
        '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'"
    })[entity]);
}

// This mock models the DOM operations used by theme changes. In particular,
// replacing innerHTML removes the old children, so identity assertions detect
// an accidental rebuild of a button, selection row, or sticky folder header.
class Element {
    constructor(classes = '') {
        this.classes = new Set(classes.split(/\s+/).filter(Boolean));
        this.children = [];
        this.dataset = {};
        this.disabled = false;
        this.classList = {
            add: name => this.classes.add(name),
            remove: name => this.classes.delete(name),
            contains: name => this.classes.has(name)
        };
    }
    set innerHTML(value) {
        this.html = value;
        this.children = [];
        // Parse the generated glyph spans; SVG details stay as their contents.
        for (const match of value.matchAll(/<span class="theme-icon" data-icon="([^"]*)" data-emoji="([^"]*)" aria-hidden="true">([\s\S]*?)<\/span>/g)) {
            const glyph = new Element('theme-icon');
            glyph.dataset = { icon: decode(match[1]), emoji: decode(match[2]) };
            glyph.innerHTML = match[3];
            this.children.push(glyph);
        }
    }
    get innerHTML() { return this.html || ''; }
    set textContent(value) {
        this.text = value;
        this.html = '';
        this.children = [];
    }
    get textContent() { return this.text ?? decode(this.innerHTML.replace(/<[^>]*>/g, '')); }
    appendChild(child) { this.children.push(child); return child; }
    querySelectorAll(selector) {
        assert.ok(selector.startsWith('.'), 'only class selectors are needed');
        return this.children.flatMap(child => [
            ...(child.classes.has(selector.slice(1)) ? [child] : []),
            ...child.querySelectorAll(selector)
        ]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

const body = new Element();
const storage = new Map();
const themeButton = body.appendChild(new Element('btn'));
const context = vm.createContext({
    document: { body, querySelectorAll: selector => body.querySelectorAll(selector) },
    localStorage: { setItem: (key, value) => storage.set(key, value) },
    els: { btnThemeToggle: themeButton },
    t: key => key,
    getOptionLabel: option => option.labelKey,
    applyTranslations() { assert.fail('changing theme must not reset device capabilities or loading controls'); },
    renderDirlist() { assert.fail('changing theme must not rebuild selected rows'); }
});
vm.runInContext(app.slice(app.indexOf('const THEME_STORAGE_KEY ='),
    app.indexOf('function getCalcModelLabel(')), context);
for (const name of ['escapeHtml', 'isMinimalTheme', 'iconMarkup', 'themeIconMarkup',
    'setIconLabel', 'updateThemeIcons', 'applyTheme', 'updateThemeButton',
    'cycleTheme', 'setButtonLoading']) {
    vm.runInContext(extractFunction(name), context);
}

context.applyTheme('dark-modern');
const settings = body.appendChild(new Element('btn'));
const badge = settings.appendChild(new Element('settings-update-dot hidden'));
context.setIconLabel(settings, 'settings', 'Settings & options', '⚙️');
assert.equal(settings.querySelector('.settings-update-dot'), badge);
context.setIconLabel(null, 'settings', 'optional control', '⚙️');

const send = body.appendChild(new Element('btn'));
context.setIconLabel(send, 'upload', 'Send files', '📤');
context.setButtonLoading(send, true);
const hiddenAction = body.appendChild(new Element('btn hidden'));
context.setIconLabel(hiddenAction, 'download', 'Unavailable operation', '⬇️');

const row = body.appendChild(new Element('is-active'));
row.innerHTML = context.themeIconMarkup('eye', '👁️') + context.themeIconMarkup('folder', '📂');
const selection = row.appendChild(new Element());
selection.checked = true;
selection.dataset.name = 'PROGRAM';
const sticky = body.appendChild(new Element('folder-sticky-name'));
sticky.innerHTML = context.themeIconMarkup('folder', '📂') + ' main';
const glyphs = body.querySelectorAll('.theme-icon');
const children = new Map([settings, send, hiddenAction, row, sticky]
    .map(element => [element, [...element.children]]));

// Go through every configured theme and wrap back to the initial theme. This
// includes changing an already rendered row and sticky header in both directions.
const themes = vm.runInContext('THEMES.map(theme => theme.id)', context);
for (let i = 0; i < themes.length * 2; i++) {
    context.cycleTheme();
    const theme = themes[(i + 1) % themes.length];
    assert.equal(body.dataset.theme, theme);
    assert.equal(storage.get('webtilp.theme'), theme);
    for (const glyph of glyphs) {
        if (theme === 'minimal') {
            assert.match(glyph.innerHTML, /<svg class="icon" aria-hidden="true">/);
            assert.ok(glyph.innerHTML.includes(`href="#icon-${glyph.dataset.icon}"`));
        } else {
            assert.equal(glyph.textContent, glyph.dataset.emoji);
        }
    }
    for (const [element, original] of children) {
        assert.equal(element.children.length, original.length);
        element.children.forEach((child, index) => assert.equal(child, original[index], 'controls are not recreated'));
    }
    assert.equal(settings.querySelector('.settings-update-dot'), badge, 'update badge identity survives');
    assert.equal(send.disabled, true, 'an in-flight transfer stays disabled');
    assert.equal(send.classList.contains('loading'), true);
    assert.equal(send.dataset.prevDisabled, '0');
    assert.equal(hiddenAction.classList.contains('hidden'), true);
    assert.equal(selection.checked, true, 'selected variables survive');
    assert.equal(selection.dataset.name, 'PROGRAM');
    assert.equal(row.classList.contains('is-active'), true);
}
context.setButtonLoading(send, false);
assert.equal(send.disabled, false, 'loading cleanup still restores the original state');
context.applyTheme('unknown-theme');
assert.equal(body.dataset.theme, themes[0], 'unknown saved themes use the default');

// Translated labels and emoji metadata are text, including when they contain
// markup delimiters. Switching back to emoji uses textContent, not HTML.
const escaped = body.appendChild(new Element('btn'));
const label = '<img src=x> "quoted" & \'apostrophe\'';
const emoji = '<glyph> " & \' ';
context.setIconLabel(escaped, 'info', label, emoji);
assert.ok(escaped.innerHTML.includes('&lt;img src=x&gt; &quot;quoted&quot; &amp; &#39;apostrophe&#39;'));
assert.equal(escaped.innerHTML.includes('<img'), false);
const escapedGlyph = escaped.querySelector('.theme-icon');
assert.equal(escapedGlyph.dataset.emoji, emoji);
context.applyTheme('minimal');
assert.ok(escapedGlyph.innerHTML.includes('#icon-info'));
context.applyTheme('retro');
assert.equal(escapedGlyph.textContent, emoji);

console.log('Theme switching tests passed (icons, loading controls, selection, badges, escaping)');
