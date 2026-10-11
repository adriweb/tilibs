'use strict';

/**
 * ui key-controls. Browser and application dependencies are injected
 * by app.js; importing this module does not start the application.
 * @param {object} dependencies
 * @returns {object}
 */
function createUiKeyControls(dependencies) {
    function populateKeyMapDataList(listId, entries) {
        const list = dependencies.document.getElementById(listId);
        if (!list) {
            return;
        }
        list.textContent = '';
        for (const [name, code] of entries) {
            const option = dependencies.document.createElement('option');
            option.value = name;
            option.label = `0x${code.toString(16).toUpperCase()}`;
            list.appendChild(option);
        }
    }

    function clearKeyMapDataList() {
        ['keyMap834', 'nspireKeyMap', 'keyMap86', 'keyMap89', 'keyMap92p', 'hpPrimeKeyMap'].forEach(id => {
            const list = dependencies.document.getElementById(id);
            if (list) {
                list.textContent = '';
            }
        });
    }

    function getCalcModelLabel(value) {
        const entry = dependencies.CALC_MODEL_OPTIONS.find(option => String(option.value) === String(value));
        return entry ? entry.label : '';
    }

    function updateKeyControlsState(enabled) {
        if (!dependencies.els.keysPanel) {
            return;
        }
        dependencies.els.keysPanel.classList.toggle('hidden', !enabled);
        if (dependencies.els.keyCodeInput) {
            dependencies.els.keyCodeInput.disabled = !enabled;
        }
        if (dependencies.els.btnSendKey) {
            dependencies.els.btnSendKey.disabled = !enabled;
        }
        dependencies.document.querySelectorAll('.key-quick').forEach(button => {
            button.disabled = !enabled;
        });
    }

    function parseKeyCode(input) {
        const raw = String(input || '').trim();
        if (!raw) {
            return null;
        }
        const normalized = raw.replace(/\s+/g, '').toLowerCase();
        const config = dependencies.getActiveKeyMapConfig();
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
        if (dependencies.isNumWorksActive()) {
            dependencies.log(dependencies.t('numworks_keys_unavailable'));
            return;
        }
        if (dependencies.isCasioActive()) {
            dependencies.log(dependencies.t('casio_keys_unavailable'));
            return;
        }
        const key = dependencies.parseKeyCode(code);
        if (key === null) {
            dependencies.log('Enter a valid key code (hex like 0x05 or decimal).');
            return;
        }
        try {
            if (dependencies.isHPPrimeActive()) {
                if (key > 50) {
                    dependencies.log(dependencies.t('hp_prime_key_range'));
                    return;
                }
                const module = await dependencies.initModule();
                const result = await dependencies.ccallAsync(module, 'hp_prime_send_key', 'number',
                    ['number'], [key], { timeoutMs: 12000 });
                if (result !== 0) {
                    dependencies.log(dependencies.tFormat('hp_prime_key_send_failed', {
                        error: dependencies.formatHPPrimeError(module, result)
                    }));
                    return;
                }
                dependencies.log(dependencies.tFormat('hp_prime_key_sent', {
                    key,
                    hex: key.toString(16).toUpperCase()
                }));
                return;
            }
            await dependencies.authorizeDevice();
            if (!dependencies.ensureSilverlinkModelSelected()) {
                return;
            }
            const module = await dependencies.initModule();
            const handle = await dependencies.ensureCableOpen();
            if ((dependencies.state.features & dependencies.FEATURE_FLAGS.OPS_KEYS) === 0) {
                dependencies.log('Remote key/action sending is not supported by this calculator.');
                return;
            }
            const result = await dependencies.ccallAsync(module, 'calc_send_key', 'number', ['number', 'number'], [handle, key], { timeoutMs: 12000 });
            if (result !== 0) {
                dependencies.log(`Failed to send key (${dependencies.formatErrorResult(module, result)}).`);
                return;
            }
            dependencies.log(`Sent key 0x${key.toString(16).toUpperCase()}.`);
        } catch (err) {
            dependencies.logError(err, 'Send key failed');
        }
    }

    return { populateKeyMapDataList, clearKeyMapDataList, getCalcModelLabel, updateKeyControlsState, parseKeyCode, sendKey };
}

module.exports = { createUiKeyControls };
