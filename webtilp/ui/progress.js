'use strict';

/**
 * ui progress. Browser and application dependencies are injected
 * by app.js; importing this module does not start the application.
 * @param {object} dependencies
 * @returns {object}
 */
function createUiProgress(dependencies) {
    function withProgressTimeout(promise, label, timeoutMs = dependencies.CCALL_TIMEOUT_MS) {
        return dependencies.wasmRuntime.withProgressTimeout(promise, label, timeoutMs, dependencies.state.module);
    }

    function clearActiveOperations(message, options = {}) {
        dependencies.session.invalidate(message, options);
        // Note: the per-module Asyncify call chain (getModuleCallState) is left
        // untouched on purpose: a suspended WASM call must never be raced by new
        // calls, even after a disconnect/cancel. Cancelled operations bail out via
        // the epoch check; the chain unblocks when the underlying call settles.
        dependencies.document.querySelectorAll('.btn.loading').forEach(button => {
            dependencies.setButtonLoading(button, false);
        });
        dependencies.state.progressOps.clear();
        dependencies.state.progressLabel = '';
        dependencies.updateProgressIndicator();
        if (message) {
            dependencies.log(message);
        }
    }

    function updateProgressIndicator() {
        if (!dependencies.els.progressIndicator || !dependencies.els.progressLabel) {
            return;
        }
        const active = dependencies.state.progressOps.size > 0;
        dependencies.els.progressIndicator.classList.toggle('hidden', !active);
        if (!active) {
            dependencies.clearProgressDetails();
            return;
        }
        if (!dependencies.state.progressLabel || !dependencies.state.progressOps.has(dependencies.state.progressLabel)) {
            dependencies.state.progressLabel = Array.from(dependencies.state.progressOps.keys()).pop() || 'Working...';
        }
        dependencies.els.progressLabel.textContent = dependencies.state.progressLabel;
        dependencies.refreshProgressDetails();
    }

    function startProgress(label) {
        const text = (label || '').trim() || 'Working...';
        const count = dependencies.state.progressOps.get(text) || 0;
        if (dependencies.state.progressOps.size === 0 && dependencies.state.module) {
            try {
                dependencies.state.module.ccall('reset_progress_info', 'number', [], []);
            } catch (err) {
                dependencies.console.warn('[WebTILP] Failed to reset progress info', err);
            }
        }
        dependencies.state.progressOps.set(text, count + 1);
        dependencies.state.progressLabel = text;
        dependencies.updateProgressIndicator();
    }

    function stopProgress(label) {
        if (!label) {
            dependencies.updateProgressIndicator();
            return;
        }
        const count = dependencies.state.progressOps.get(label);
        if (!count) {
            return;
        }
        if (count === 1) {
            dependencies.state.progressOps.delete(label);
        } else {
            dependencies.state.progressOps.set(label, count - 1);
        }
        if (dependencies.state.progressLabel === label) {
            dependencies.state.progressLabel = Array.from(dependencies.state.progressOps.keys()).pop() || '';
        }
        dependencies.updateProgressIndicator();
    }

    function clearProgressDetails() {
        if (dependencies.els.progressPercent) {
            dependencies.els.progressPercent.textContent = '';
        }
        if (dependencies.els.progressRate) {
            dependencies.els.progressRate.textContent = '';
        }
        if (dependencies.els.progressBarFill) {
            dependencies.els.progressBarFill.classList.remove('determinate');
            dependencies.els.progressBarFill.style.width = '';
        }
    }

    function formatRate(bytesPerMs) {
        if (!Number.isFinite(bytesPerMs) || bytesPerMs <= 0) {
            return '';
        }
        const bytesPerSec = bytesPerMs * 1000;
        const kb = bytesPerSec / 1024;
        if (kb < 1024) {
            return `${kb.toFixed(1)} KB/s`;
        }
        const mb = kb / 1024;
        return `${mb.toFixed(2)} MB/s`;
    }

    function refreshProgressDetails() {
        if (dependencies.state?.activeFamily === 'sharp') {
            const progress = dependencies.state.sharpProgress;
            if (!dependencies.els.progressBarFill) return;
            const percent = progress?.total ? Math.min(100, Math.round(progress.completed / progress.total * 100)) : null;
            dependencies.els.progressBarFill.classList.toggle('determinate', percent !== null);
            dependencies.els.progressBarFill.style.width = percent === null ? '' : `${percent}%`;
            if (dependencies.els.progressPercent) dependencies.els.progressPercent.textContent = percent === null ? '' : `${percent}%`;
            if (dependencies.els.progressRate) dependencies.els.progressRate.textContent = '';
            return;
        }

        if (!dependencies.state.module || !dependencies.els.progressBarFill) {
            return;
        }
        let infoText = '';
        try {
            infoText = dependencies.state.module.ccall('get_progress_info_json', 'string', [], []);
        } catch (err) {
            return;
        }
        if (!infoText) {
            return;
        }
        let info;
        try {
            info = JSON.parse(infoText);
        } catch {
            return;
        }
        if (!info || typeof info !== 'object') {
            return;
        }

        const cnt = Number(info.cnt);
        const max = Number(info.max);
        const rate = Number(info.rate);
        if (Number.isFinite(max) && max > 0 && Number.isFinite(cnt)) {
            const percent = Math.max(0, Math.min(100, Math.round((cnt / max) * 100)));
            dependencies.els.progressBarFill.classList.add('determinate');
            dependencies.els.progressBarFill.style.width = `${percent}%`;
            if (dependencies.els.progressPercent) {
                dependencies.els.progressPercent.textContent = `${percent}%`;
            }
        } else {
            dependencies.els.progressBarFill.classList.remove('determinate');
            dependencies.els.progressBarFill.style.width = '';
            if (dependencies.els.progressPercent) {
                dependencies.els.progressPercent.textContent = '';
            }
        }

        if (dependencies.els.progressRate) {
            const formatted = dependencies.formatRate(rate);
            dependencies.els.progressRate.textContent = formatted || '';
        }
        if (info.text && typeof info.text === 'string' && info.text.trim()) {
            const text = info.text.trim();
            if (text && text !== dependencies.state.progressLabel) {
                dependencies.els.progressLabel.textContent = text;
            }
        }
    }

    function readProgressTick() {
        return dependencies.wasmRuntime.readProgressTick(dependencies.state.module);
    }

    return { withProgressTimeout, clearActiveOperations, updateProgressIndicator, startProgress, stopProgress, clearProgressDetails, formatRate, refreshProgressDetails, readProgressTick };
}

module.exports = { createUiProgress };
