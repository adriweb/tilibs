'use strict';

/**
 * ui device-info. Browser and application dependencies are injected
 * by app.js; importing this module does not start the application.
 * @param {object} dependencies
 * @returns {object}
 */
function createUiDeviceInfo(dependencies) {
    function renderDeviceInfo(entries) {
        dependencies.els.deviceInfoList.innerHTML = '';
        entries.forEach(entry => {
            const row = dependencies.document.createElement('div');
            row.className = 'info-row';
            const valueClass = / hash$/i.test(entry.key) ? 'value hash-value' : 'value';
            const keyEl = dependencies.document.createElement('div');
            keyEl.className = 'key';
            keyEl.textContent = entry.key;
            const valueEl = dependencies.document.createElement('div');
            valueEl.className = valueClass;
            if (String(entry.key || '').trim().toLowerCase() === 'language id') {
                valueEl.innerHTML = dependencies.formatLanguageIdHtml(entry.value);
            } else {
                valueEl.textContent = entry.value;
            }
            row.appendChild(keyEl);
            row.appendChild(valueEl);
            dependencies.els.deviceInfoList.appendChild(row);
        });
        dependencies.updateMemoryFromDeviceInfo(entries);
    }

    function appendDeviceInfoRow(key, value) {
        if (!dependencies.els.deviceInfoList) {
            return;
        }
        const row = dependencies.document.createElement('div');
        row.className = 'info-row';
        const valueClass = / hash$/i.test(key) ? 'value hash-value' : 'value';
        const keyEl = dependencies.document.createElement('div');
        keyEl.className = 'key';
        keyEl.textContent = key;
        const valueEl = dependencies.document.createElement('div');
        valueEl.className = valueClass;
        valueEl.textContent = value;
        row.appendChild(keyEl);
        row.appendChild(valueEl);
        dependencies.els.deviceInfoList.appendChild(row);
    }

    function appendDeviceInfoRowHtml(keyHtml, valueHtml) {
        if (!dependencies.els.deviceInfoList) {
            return;
        }
        const row = dependencies.document.createElement('div');
        row.className = 'info-row';
        const valueClass = / hash$/i.test(keyHtml) ? 'value hash-value' : 'value';
        row.innerHTML = `<div class="key">${keyHtml}</div><div class="${valueClass}">${valueHtml}</div>`;
        dependencies.els.deviceInfoList.appendChild(row);
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
        const date = dependencies.clockInfoToDate(clockInfo);
        const timeFormatValue = clockInfo?.time_format === 12 ? 12 : 24;
        return dependencies.formatClockDisplayBase(date, timeFormatValue, clockInfo?.date_format);
    }

    function formatClockDisplayFromDate(date, settings) {
        const timeFormatValue = settings?.timeFormat === 12 ? 12 : 24;
        return dependencies.formatClockDisplayBase(date, timeFormatValue, settings?.dateFormat);
    }

    function buildClockRowKey() {
        return `Clock (at <abbr title="${new Date().toLocaleString()}">last refresh</abbr>)`;
    }

    function updateScreenshotCanvasScale() {
        const canvas = dependencies.els.screenshotCanvas;
        if (!canvas || !canvas.width || !canvas.height) {
            return;
        }
        canvas.style.aspectRatio = `${canvas.width} / ${canvas.height}`;
        const parent = canvas.parentElement;
        if (!parent) {
            return;
        }
        const styles = dependencies.getComputedStyle(canvas);
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
        if (!dependencies.els.deviceInfoList) {
            return false;
        }
        const rows = dependencies.els.deviceInfoList.querySelectorAll('.info-row');
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
        const display = dependencies.formatClockDisplay(clockInfo) || dependencies.formatClockDisplayFromDate(fallbackDate, settings);
        keyEl.innerHTML = dependencies.buildClockRowKey();
        valueEl.innerHTML = display ? display : 'Unknown';
        return true;
    }

    function clearDeviceData() {
        dependencies.state.sharpConnectionGeneration = (dependencies.state.sharpConnectionGeneration || 0) + 1;
        dependencies.state.sharpProgress = null;

        dependencies.state.hpLegacyConnectionGeneration += 1;
        dependencies.state.dirlist = [];
        dependencies.state.backupDirlistLoaded = false;
        dependencies.state.hpFileSnapshotLoaded = false;
        dependencies.state.hpFileRefreshGeneration += 1;
        dependencies.state.hpFileRenderGeneration = 0;
        dependencies.state.hpPrimeProtocolVersion = null;
        dependencies.state.hpLegacyKermitEnabled = false;
        dependencies.state.hpLegacyModelInfo = null;
        dependencies.state.casioStorageSupported = false;
        dependencies.state.casioFileSnapshotLoaded = false;
        dependencies.setSelectedFiles([]);
        dependencies.state.nspireOsReceiveStarted = false;
        dependencies.updateNspireOsButtons(false, false);
        dependencies.renderDirlist(dependencies.state.dirlist);
        dependencies.updateSelectionActionButtons();
        dependencies.updateKeyControlsState(false);
        dependencies.els.deviceInfoList.innerHTML = '';
        dependencies.els.deviceModel.textContent = 'Unknown';
        dependencies.state.deviceModelName = '';
        dependencies.state.deviceInfoProductName = '';
        dependencies.state.deviceInfoEntries = [];
        dependencies.els.memoryInfo.textContent = '—';
        dependencies.els.memoryInfo.title = '';
        const canvas = dependencies.els.screenshotCanvas;
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
                const ramBytes = dependencies.parseLeadingBytes(freeRam);
                parts.push(`RAM ${ramBytes !== null ? dependencies.formatBytes(ramBytes) : freeRam}`);
                rawParts.push(`RAM ${ramBytes !== null ? `${ramBytes}B` : freeRam}`);
            }
            if (freeFlash) {
                const flashBytes = dependencies.parseLeadingBytes(freeFlash);
                parts.push(`Flash ${flashBytes !== null ? dependencies.formatBytes(flashBytes) : freeFlash}`);
                rawParts.push(`Flash ${flashBytes !== null ? `${flashBytes}B` : freeFlash}`);
            }
            dependencies.els.memoryInfo.textContent = parts.join(' | ');
            dependencies.els.memoryInfo.title = rawParts.join(' | ');
        }
    }

    function parseLeadingBytes(text) {
        const match = String(text).match(/^\s*(\d+)\s*B/i);
        if (!match) {
            return null;
        }
        return Number(match[1]);
    }

    return { renderDeviceInfo, appendDeviceInfoRow, appendDeviceInfoRowHtml, formatClockDisplayBase, formatClockDisplay, formatClockDisplayFromDate, buildClockRowKey, updateScreenshotCanvasScale, updateClockInfoRow, clearDeviceData, updateMemoryFromDeviceInfo, parseLeadingBytes };
}

module.exports = { createUiDeviceInfo };
