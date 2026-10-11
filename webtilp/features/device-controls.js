'use strict';

/**
 * features device-controls. Browser and application dependencies are injected
 * by app.js; importing this module does not start the application.
 * @param {object} dependencies
 * @returns {object}
 */
function createFeaturesDeviceControls(dependencies) {
    async function isReady() {
        dependencies.setButtonLoading(dependencies.els.btnIsReady, true);
        try {
            await dependencies.authorizeDevice();
            if (dependencies.promptCableMismatchResolution()) {
                return;
            }
            if (!dependencies.ensureSilverlinkModelSelected()) {
                return;
            }
            const module = await dependencies.initModule();
            const handle = await dependencies.ensureCableOpen();
            await dependencies.updateCapabilities();
            const result = await dependencies.ccallAsync(module, 'is_ready', 'number', ['number'], [handle], { timeoutMs: 8000 });
            dependencies.log(`isReady result: ${result}`);
        } catch (err) {
            dependencies.logError(err, 'isReady failed');
        } finally {
            dependencies.setButtonLoading(dependencies.els.btnIsReady, false);
        }
    }

    async function getDeviceInfo() {
        if (dependencies.state?.activeFamily === 'sharp') {
            await dependencies.runSharpOperation(dependencies.t('sharp_info'), async backend => {
                const version = await backend.readVersion();
                if (dependencies.state.sharpBackend !== backend) return;
                dependencies.readSharpInfo(version);
            });
            return;
        }

        dependencies.setButtonLoading(dependencies.els.btnGetInfo, true);
        try {
            if (dependencies.isHPPrimeActive()) {
                const module = await dependencies.initModule();
                dependencies.readHPPrimeInfo(module);
                dependencies.log(dependencies.t('hp_prime_info_refreshed'));
                return;
            }
            if (dependencies.isHPLegacyActive()) {
                dependencies.readHPLegacyInfo();
                dependencies.log(dependencies.t('hp_legacy_info_refreshed'));
                return;
            }
            if (dependencies.isNumWorksActive()) {
                await dependencies.state.numWorksBackend.refresh();
                dependencies.readNumWorksInfo();
                dependencies.applyNumWorksStorageSnapshot();
                dependencies.log(dependencies.t('numworks_info_refreshed'));
                return;
            }
            if (dependencies.isCasioActive()) {
                const module = await dependencies.initModule();
                dependencies.readCasioInfo(module);
                dependencies.log(dependencies.t('casio_info_refreshed'));
                return;
            }
            if (dependencies.isTi92Selected()) {
                const proceed = dependencies.confirm(dependencies.t('confirm_replug_after_device_info'));
                if (!proceed) {
                    dependencies.log('Device info refresh cancelled.');
                    return;
                }
            }
            await dependencies.authorizeDevice();
            if (dependencies.promptCableMismatchResolution()) {
                return;
            }
            if (!dependencies.ensureSilverlinkModelSelected()) {
                return;
            }
            const module = await dependencies.initModule();
            const handle = await dependencies.ensureCableOpen();
            await dependencies.updateCapabilities();
            const infoText = await dependencies.ccallAsync(module, 'calc_get_info_string', 'string', ['number'], [handle], { timeoutMs: 12000 });
            const reopenNeeded = module._consume_cable_reopen_flag();
            if (reopenNeeded) {
                dependencies.state.cableOpen = false;
                dependencies.log('Cable session closed after device info query failure; it will reopen for the next operation.');
            }
            if (!infoText || typeof infoText !== 'string') {
                dependencies.log('Device info unavailable.');
                return;
            }
            const entries = dependencies.parseInfoText(infoText);
            dependencies.state.deviceInfoEntries = entries;
            dependencies.renderDeviceInfo(entries);
            const productName = entries.find(entry => entry.key.toLowerCase() === 'product name');
            if (productName) {
                dependencies.state.deviceModelName = productName.value;
                dependencies.state.deviceInfoProductName = productName.value;
            }
            dependencies.updateDeviceModelDisplay(productName?.value || '');
            const modelUpdateInfo = module.ccall('consume_model_update_info', 'string', [], []);
            if (modelUpdateInfo) {
                try {
                    const info = JSON.parse(modelUpdateInfo);
                    const fromName = info.fromName || 'Unknown';
                    const toName = info.toName || 'Unknown';
                    if (fromName !== toName) {
                        dependencies.log(`Calculator model updated from ${fromName} to ${toName} based on device info.`);
                        dependencies.updateDeviceModelDisplay();
                    }
                } catch (err) {
                    dependencies.console.warn('[WebTILP] Failed to parse model update info', err);
                    dependencies.log('Calculator model updated based on device info.');
                }
            }
            if ((dependencies.state.features & dependencies.FEATURE_FLAGS.OPS_CLOCK) !== 0) {
                const clockInfo = await dependencies.getClockInfo(module, handle);
                const clockText = dependencies.formatClockDisplay(clockInfo);
                const clockKey = dependencies.buildClockRowKey();
                dependencies.appendDeviceInfoRowHtml(clockKey, clockText ? clockText : 'Unknown');
            }
            dependencies.log('Device info retrieved.');
        } catch (err) {
            dependencies.logError(err, 'Device info failed');
        } finally {
            dependencies.setButtonLoading(dependencies.els.btnGetInfo, false);
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
        const clockInfoText = await dependencies.ccallAsync(module, 'calc_get_clock_json', 'string', ['number'], [handle], { timeoutMs: 8000 });
        return dependencies.parseClockInfo(clockInfoText);
    }

    async function syncClockToNow(module, handle, offsetMinutes = 0) {
        return dependencies.ccallAsync(
            module,
            'calc_sync_clock',
            'number',
            ['number', 'number'],
            [handle, offsetMinutes],
            { timeoutMs: dependencies.PROGRESS_IDLE_TIMEOUT_MS, useProgress: true, progressLabel: 'Syncing clock' }
        );
    }

    async function syncClock() {
        dependencies.setButtonLoading(dependencies.els.btnSyncClock, true);
        try {
            await dependencies.authorizeDevice();
            if (dependencies.promptCableMismatchResolution()) {
                return;
            }
            if (!dependencies.ensureSilverlinkModelSelected()) {
                return;
            }
            const module = await dependencies.initModule();
            const handle = await dependencies.ensureCableOpen();
            await dependencies.updateCapabilities();

            if ((dependencies.state.features & dependencies.FEATURE_FLAGS.OPS_CLOCK) === 0) {
                dependencies.log('Clock sync not supported by this calculator.');
                return;
            }

            let result = await dependencies.syncClockToNow(module, handle);
            if (result !== 0) {
                dependencies.log(`Clock sync failed (${dependencies.formatErrorResult(module, result)}).`);
                return;
            }

            let adjusted = false;
            let targetDate = new Date();
            let afterInfo = await dependencies.getClockInfo(module, handle);
            let afterDate = dependencies.clockInfoToDate(afterInfo);
            if (afterDate) {
                const diffMinutes = Math.round((targetDate.getTime() - afterDate.getTime()) / 60000);
                const diffAbs = Math.abs(diffMinutes);
                if (diffAbs >= 30 && diffAbs <= 120) {
                    adjusted = true;
                    result = await dependencies.syncClockToNow(module, handle, diffMinutes);
                    if (result !== 0) {
                        dependencies.log(`Clock sync failed (${dependencies.formatErrorResult(module, result)}).`);
                        return;
                    }
                    targetDate = new Date();
                    afterInfo = await dependencies.getClockInfo(module, handle);
                    afterDate = dependencies.clockInfoToDate(afterInfo);
                }
            }

            const settings = dependencies.normalizeClockSettings(afterInfo);
            const displayDate = afterDate || targetDate;
            if (adjusted) {
                dependencies.log(`Clock synced (timezone corrected) to ${displayDate.toLocaleString()}.`);
            } else {
                dependencies.log(`Clock synced to ${displayDate.toLocaleString()}.`);
            }
            dependencies.updateClockInfoRow(afterInfo, settings, displayDate);
        } catch (err) {
            dependencies.logError(err, 'Clock sync failed');
        } finally {
            dependencies.setButtonLoading(dependencies.els.btnSyncClock, false);
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

    return { isReady, getDeviceInfo, parseClockInfo, normalizeClockSettings, clockInfoToDate, getClockInfo, syncClockToNow, syncClock, parseInfoText };
}

module.exports = { createFeaturesDeviceControls };
