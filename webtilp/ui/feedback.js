'use strict';

/**
 * ui feedback. Browser and application dependencies are injected
 * by app.js; importing this module does not start the application.
 * @param {object} dependencies
 * @returns {object}
 */
function createUiFeedback(dependencies) {
    function log(message) {
        const timestamp = new Date().toLocaleTimeString();
        dependencies.state.logLines.push(`[${timestamp}] ${message}`);
        if (dependencies.state.logLines.length > dependencies.MAX_LOG_LINES) {
            dependencies.state.logLines.splice(0, dependencies.state.logLines.length - dependencies.MAX_LOG_LINES);
        }
        dependencies.renderLog();
        dependencies.els.log.scrollTop = dependencies.els.log.scrollHeight;
        if (dependencies.isErrorMessage(message)) {
            dependencies.showToast(message, 'error');
        }
    }

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function renderLog() {
        if (!dependencies.els.log) {
            return;
        }
        const lines = dependencies.state.logLines.map(line => {
            const escaped = dependencies.escapeHtml(line);
            return dependencies.isErrorMessage(line) ? `<span class="log-error">${escaped}</span>` : escaped;
        });
        dependencies.els.log.innerHTML = `${lines.join('<br>')}<br>`;
    }

    function logError(err, context) {
        if (err?.silent) {
            return;
        }
        if (err && err.name === 'NotFoundError') {
            return;
        }
        if (context) {
            dependencies.console.error(`[WebTILP] ${context}`, err);
        } else {
            dependencies.console.error('[WebTILP]', err);
        }
        let message = err?.message || err;
        if (typeof message === 'number' || (typeof message === 'string' && /^\d+$/.test(message))) {
            const code = Number(message);
            message = dependencies.formatErrorResult(dependencies.state.module, code);
        }
        dependencies.log(`ERROR: ${message}`);
    }

    function setButtonLoading(button, loading) {
        if (!button) {
            return;
        }
        if (loading) {
            button.dataset.prevDisabled = button.disabled ? '1' : '0';
            button.disabled = true;
            button.classList.add('loading');
            return;
        }
        button.classList.remove('loading');
        if (button.classList.contains('disabled')) {
            button.disabled = true;
            return;
        }
        if (button.dataset.prevDisabled === '0') {
            button.disabled = false;
        }
        delete button.dataset.prevDisabled;
    }

    function formatBytes(value) {
        const units = ['B', 'KB', 'MB', 'GB'];
        let size = Number(value);
        let unitIndex = 0;
        while (size >= 1024 && unitIndex < units.length - 1) {
            size /= 1024;
            unitIndex += 1;
        }
        return `${size.toFixed(size < 10 && unitIndex > 0 ? 2 : 1)}${units[unitIndex]}`;
    }

    function formatMemoryValue(value) {
        if (value === null || value === undefined || value === 0xffffffff) {
            return { display: '?', raw: '?' };
        }
        return { display: dependencies.formatBytes(value), raw: `${value}B` };
    }

    function clearLog() {
        dependencies.setButtonLoading(dependencies.els.btnClearLog, true);
        dependencies.state.logLines = [];
        dependencies.els.log.textContent = '';
        dependencies.setButtonLoading(dependencies.els.btnClearLog, false);
    }

    return { log, escapeHtml, renderLog, logError, setButtonLoading, formatBytes, formatMemoryValue, clearLog };
}

module.exports = { createUiFeedback };
