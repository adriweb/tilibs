'use strict';

/**
 * runtime diagnostics. Browser and application dependencies are injected
 * by app.js; importing this module does not start the application.
 * @param {object} dependencies
 * @returns {object}
 */
function createRuntimeDiagnostics(dependencies) {
    function sleep(ms) {
        return new Promise(resolve => dependencies.setTimeout(resolve, ms));
    }

    function isErrorMessage(message) {
        if (!message) {
            return false;
        }
        const text = String(message).toLowerCase();
        if (text.startsWith('error:') || text.startsWith('failed')) {
            return true;
        }
        return text.includes('(error') || text.includes('error ') || text.includes('failed');
    }

    function showToast(message, type = 'error') {
        if (!dependencies.els.toastContainer) {
            return;
        }
        const toast = dependencies.document.createElement('div');
        toast.className = `toast ${type}`;
        const title = type === 'error' ? dependencies.t('error_title') : dependencies.t('notice_title');
        const titleEl = dependencies.document.createElement('div');
        titleEl.className = 'toast-title';
        titleEl.textContent = title;
        const messageEl = dependencies.document.createElement('div');
        messageEl.textContent = message;
        toast.appendChild(titleEl);
        toast.appendChild(messageEl);
        dependencies.els.toastContainer.appendChild(toast);
        dependencies.requestAnimationFrame(() => {
            toast.classList.add('show');
        });
        const timeout = type === 'error' ? 6000 : 4000;
        dependencies.setTimeout(() => {
            toast.classList.remove('show');
            dependencies.setTimeout(() => toast.remove(), 250);
        }, timeout);
    }

    function getFallbackErrorMessage(code) {
        return dependencies.ERROR_CODE_FALLBACKS.get(code) || '';
    }

    function getErrorMessage(module, code) {
        if (!module || code === 0) {
            return '';
        }
        try {
            return module.ccall('get_error_message', 'string', ['number'], [code]) || '';
        } catch (err) {
            dependencies.console.warn('[WebTILP] Failed to resolve error message', err);
        }
        return '';
    }

    function formatErrorResult(module, code) {
        if (code === null || code === undefined || Number.isNaN(Number(code))) {
            return 'error (unknown)';
        }
        const numericCode = Number(code);
        const message = dependencies.getErrorMessage(module, code);
        let raw = 0;
        if (module) {
            try {
                raw = module._get_raw_protocol_code(numericCode);
            } catch (err) {
                dependencies.console.warn('[WebTILP] Failed to resolve raw protocol code', err);
                raw = 0;
            }
        }
        let label = raw ? `0x${raw.toString(16).toUpperCase().padStart(4, '0')}` : `${numericCode}`;
        if (raw && numericCode === dependencies.TICALCS_EVO_ERROR) {
            const wireCode = String.fromCharCode((raw >> 8) & 0xFF, raw & 0xFF);
            if (/^[A-Z]{2}$/.test(wireCode)) {
                label = wireCode;
            }
        }
        if (!message) {
            const fallback = dependencies.getFallbackErrorMessage(numericCode);
            return fallback ? `error ${label}: ${fallback}` : `error ${label}`;
        }
        const firstLine = message.split('\n').map(line => line.trim()).find(Boolean) || message;
        const cleaned = firstLine.replace(/^Msg:\s*/i, '').replace(/\.$/, '');
        if (numericCode === dependencies.TICALCS_EVO_ERROR) {
            const match = cleaned.match(/^TI-Evo Kermit result [A-Z]{2}\s+\((.+)\)$/i);
            if (match) {
                return `${label} (${match[1]})`;
            }
        }
        return `error ${label}: ${cleaned}`;
    }

    function formatHPPrimeError(module, code) {
        if (code === null || code === undefined || Number.isNaN(Number(code))) {
            return dependencies.t('hp_prime_error_unknown');
        }
        const numericCode = Number(code);
        let message = '';
        try {
            message = module?.ccall('hp_prime_get_error_message', 'string',
                ['number'], [numericCode]) || '';
        } catch (err) {
            dependencies.console.warn('[WebTILP] Failed to resolve HP Prime error message', err);
        }
        return message ? `${message} (${numericCode})`
            : dependencies.tFormat('hp_prime_error_code', { code: numericCode });
    }

    function formatCasioError(module, code) {
        if (code === null || code === undefined || Number.isNaN(Number(code))) {
            return dependencies.t('casio_error_unknown');
        }
        const numericCode = Number(code);
        let message = '';
        try {
            message = module?.ccall('casio_get_error_message', 'string',
                ['number'], [numericCode]) || '';
        } catch (err) {
            dependencies.console.warn('[WebTILP] Failed to resolve Cahute error message', err);
        }
        return message ? `${message} (${numericCode})`
            : dependencies.tFormat('casio_error_code', { code: numericCode });
    }

    function clearNativeWarnings() {
        if (dependencies.state.module) {
            try {
                dependencies.state.module.ccall('clear_native_warnings', 'void', [], []);
            } catch {
                // Older builds may not expose native warning capture yet.
            }
        }
    }

    function getNativeWarningSuffix(handledErrorCode = null) {
        const warnings = [];
        if (dependencies.state.module) {
            try {
                const nativeWarnings = dependencies.state.module.ccall('get_native_warnings', 'string', [], []);
                if (nativeWarnings) {
                    warnings.push(...nativeWarnings.split(/\n+/));
                }
            } catch {
                // Older builds may not expose native warning capture yet.
            }
        }
        const unique = [];
        const isHandledEvoError = Number(handledErrorCode) === dependencies.TICALCS_EVO_ERROR;
        for (const warning of warnings) {
            const text = String(warning || '').trim();
            if (isHandledEvoError && text.startsWith('TI-Evo Kermit E packet')) {
                continue;
            }
            if (text && !unique.includes(text)) {
                unique.push(text);
            }
        }
        return unique.length ? ` Details: ${unique.join(' ')}` : '';
    }

    function makeModulePrintHandlers(touchProgress = null) {
        return {
            print: (...args) => {
                if (touchProgress) {
                    touchProgress();
                }
                dependencies.console.log(...args);
            },
            printErr: (...args) => {
                if (touchProgress) {
                    touchProgress();
                }
                dependencies.console.error(...args);
            }
        };
    }

    function isAcceptableLeaveExamModeDiscError(err) {
        const text = String(err?.message || err || '').toLowerCase();
        return text.includes('device was disconnected')
            || text.includes('failed to execute')
            || text.includes('transfer error')
            || text.includes('memory access out of bounds')
            || text.includes('runtimeerror');
    }

    function isFatalWasmRuntimeError(err) {
        return dependencies.isFatalRuntimeError(err);
    }

    function handleFatalWasmRuntimeError(err) {
        dependencies.console.error('[WebTILP] Fatal WASM runtime error', err);
        dependencies.clearActiveOperations(undefined, { retire: true });
        // Do not call back into WASM after a fatal runtime error.
        dependencies.state.module = null;
        dependencies.state.handle = 0;
        dependencies.state.cableOpen = false;
        dependencies.state.handlePromise = null;
        dependencies.state.connectInProgress = false;
        dependencies.state.silentReconnectInProgress = false;
        dependencies.setConnected(false);
        dependencies.setStatus('status_connection_lost', false);
        dependencies.log('Connection lost due to calculator reset/disconnect. Please reconnect.');
    }

    function getModuleCallState(module) {
        return dependencies.wasmRuntime.getModuleCallState(module);
    }

    function retireModule(module, reason) {
        dependencies.wasmRuntime.retireModule(module, reason);
    }

    function withTimeout(promise, label, timeoutMs = dependencies.CCALL_TIMEOUT_MS) {
        return dependencies.wasmRuntime.withTimeout(promise, label, timeoutMs);
    }

    function ccallAsync(module, name, returnType, argTypes, args, options = {}) {
        return dependencies.wasmRuntime.ccallAsync(module, name, returnType, argTypes, args, options);
    }

    return { sleep, isErrorMessage, showToast, getFallbackErrorMessage, getErrorMessage, formatErrorResult, formatHPPrimeError, formatCasioError, clearNativeWarnings, getNativeWarningSuffix, makeModulePrintHandlers, isAcceptableLeaveExamModeDiscError, isFatalWasmRuntimeError, handleFatalWasmRuntimeError, getModuleCallState, retireModule, withTimeout, ccallAsync };
}

module.exports = { createRuntimeDiagnostics };
