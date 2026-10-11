'use strict';

/**
 * features preview. Browser and application dependencies are injected
 * by app.js; importing this module does not start the application.
 * @param {object} dependencies
 * @returns {object}
 */
function createFeaturesPreview(dependencies) {
    function getPreviewHighlighter() {
        if (dependencies.window.hljs) {
            return Promise.resolve(dependencies.window.hljs);
        }
        if (!dependencies.previewHighlighterPromise) {
            dependencies.previewHighlighterPromise = new Promise((resolve, reject) => {
                const script = dependencies.document.createElement('script');
                script.src = new dependencies.URL('highlighter.min.js', dependencies.document.baseURI).href;
                script.async = true;
                script.dataset.webtilpHighlighter = 'true';
                script.addEventListener('load', () => {
                    if (dependencies.window.hljs) {
                        resolve(dependencies.window.hljs);
                    } else {
                        reject(new Error('Preview highlighter is unavailable'));
                    }
                }, { once: true });
                script.addEventListener('error', () => {
                    reject(new Error('Failed to load the preview highlighter'));
                }, { once: true });
                dependencies.document.head.appendChild(script);
            }).catch(error => {
                dependencies.previewHighlighterPromise = null;
                throw error;
            });
        }
        return dependencies.previewHighlighterPromise;
    }

    function disposePreviewSession() {
        const session = dependencies.previewSession;
        dependencies.previewSession = null;
        dependencies.previewRenderId += 1;
        if (session?.objectUrl) {
            dependencies.URL.revokeObjectURL(session.objectUrl);
        }
        if (session?.module && session.receivedPath) {
            try {
                session.module.FS.unlink(session.receivedPath);
            } catch (error) {
                dependencies.console.warn('[WebTILP] Failed to remove preview file:', error);
            }
        }
        if (session?.options && typeof session.options.delete === 'function') {
            session.options.delete();
        }
        if (session?.variable && typeof session.variable.delete === 'function') {
            session.variable.delete();
        }
    }

    function closePreviewModal() {
        if (dependencies.els.previewModal) {
            dependencies.els.previewModal.classList.add('hidden');
            dependencies.els.previewModal.setAttribute('aria-hidden', 'true');
        }
        if (dependencies.els.previewImage) {
            dependencies.els.previewImage.removeAttribute('src');
            dependencies.els.previewImage.classList.add('hidden');
        }
        if (dependencies.els.previewControls) {
            dependencies.els.previewControls.classList.add('hidden');
        }
        if (dependencies.els.previewBasicDownloads) {
            dependencies.els.previewBasicDownloads.classList.add('hidden');
        }
        if (dependencies.els.btnDownloadPreview) {
            dependencies.els.btnDownloadPreview.classList.remove('hidden');
        }
        if (dependencies.els.previewReindent) {
            dependencies.els.previewReindent.checked = false;
        }
        dependencies.disposePreviewSession();
    }

    function formatTivarsException(tivars, error) {
        if (tivars?.getExceptionMessage) {
            try {
                const message = tivars.getExceptionMessage(error);
                if (Array.isArray(message)) {
                    const joined = message.filter(Boolean).join(': ');
                    if (joined) {
                        return joined;
                    }
                } else if (message) {
                    return String(message);
                }
            } catch {
                // Fall through to the regular error formatting.
            }
        }
        return error?.message || String(error);
    }

    function unwrapReadablePreview(readable) {
        let content = String(readable ?? '');
        let imageDataUrl = '';
        let language = '';
        try {
            const parsed = JSON.parse(content);
            let displayValue = parsed;
            if (typeof parsed.readableContent === 'string') {
                try {
                    const nested = JSON.parse(parsed.readableContent);
                    if (typeof nested.previewImageDataUrl === 'string') {
                        imageDataUrl = nested.previewImageDataUrl;
                        delete nested.previewImageDataUrl;
                    }
                    displayValue = nested;
                } catch {
                    displayValue = parsed.readableContent;
                }
            } else if (typeof parsed.python?.code === 'string') {
                displayValue = parsed.python.code;
                language = 'python';
            } else if (typeof parsed.code === 'string') {
                displayValue = parsed.code;
            } else if (typeof parsed.previewImageDataUrl === 'string') {
                imageDataUrl = parsed.previewImageDataUrl;
                delete parsed.previewImageDataUrl;
                displayValue = Object.keys(parsed).length ? parsed : '';
            }
            if (typeof displayValue !== 'string') {
                language = 'json';
            }
            content = typeof displayValue === 'string'
                ? displayValue
                : JSON.stringify(displayValue, null, 2);
        } catch {
            // Plain-text readable content needs no additional processing.
        }
        return { content, imageDataUrl, language };
    }

    function decodeHPPrimeTextPreview(data) {
        let bytes = data instanceof dependencies.Uint8Array ? data : new dependencies.Uint8Array(data || 0);
        if (bytes.byteLength >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
            bytes = bytes.subarray(2);
        }
        if ((bytes.byteLength & 1) !== 0) {
            throw new Error(dependencies.t('hp_prime_text_preview_invalid'));
        }
        return new dependencies.TextDecoder('utf-16le', { fatal: true }).decode(bytes)
            .replace(/^\uFEFF/, '')
            .replace(/\u0000+$/, '');
    }

    function createHPPrimePreview(entry, data) {
        const kind = dependencies.getHPPrimePreviewKind(entry);
        if (kind === 'text') {
            return {
                readable: dependencies.decodeHPPrimeTextPreview(data),
                objectUrl: ''
            };
        }
        if (kind === 'image') {
            const bytes = data instanceof dependencies.Uint8Array ? data : new dependencies.Uint8Array(data || 0);
            const pngSignature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
            if (bytes.byteLength < pngSignature.length
                || pngSignature.some((value, index) => bytes[index] !== value)) {
                throw new Error(dependencies.t('hp_prime_png_preview_invalid'));
            }
            const objectUrl = dependencies.URL.createObjectURL(new dependencies.Blob([bytes], { type: 'image/png' }));
            return {
                readable: JSON.stringify({ previewImageDataUrl: objectUrl }),
                objectUrl
            };
        }
        throw new Error(`Preview is not supported for ${entry?.name || 'this HP Prime file'}.`);
    }

    function isTIBasicPreviewEntry(entry, modelId) {
        const typeId = Number(entry.type);
        const typeName = String(entry.typeName || entry.type_name || '').trim().toLowerCase();
        if (typeName && typeName.includes('program') && !typeName.includes('python')) {
            return true;
        }
        return dependencies.EVO_PYTHON_CALC_MODELS.has(modelId)
            ? dependencies.TIVARS_EVO_BASIC_PROGRAM_TYPES.has(typeId)
            : dependencies.TIVARS_LEGACY_BASIC_PROGRAM_TYPES.has(typeId);
    }

    function usesTIBasicPreviewSyntax(entry, modelId) {
        const typeId = Number(entry.type);
        return dependencies.EVO_PYTHON_CALC_MODELS.has(modelId)
            ? dependencies.TIVARS_EVO_BASIC_SYNTAX_TYPES.has(typeId)
            : dependencies.TIVARS_LEGACY_BASIC_SYNTAX_TYPES.has(typeId);
    }

    function renderJsonHighlightedPreview(content) {
        const fragment = dependencies.document.createDocumentFragment();
        const tokenPattern = /"(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\b(?:true|false|null)\b/g;
        let offset = 0;
        for (const match of content.matchAll(tokenPattern)) {
            const index = match.index ?? 0;
            fragment.appendChild(dependencies.document.createTextNode(content.slice(offset, index)));
            const token = match[0];
            const span = dependencies.document.createElement('span');
            if (token.startsWith('"')) {
                span.className = /^\s*:/.test(content.slice(index + token.length))
                    ? 'hljs-attribute'
                    : 'hljs-string';
            } else if (/^(?:true|false|null)$/.test(token)) {
                span.className = 'hljs-literal';
            } else {
                span.className = 'hljs-number';
            }
            span.textContent = token;
            fragment.appendChild(span);
            offset = index + token.length;
        }
        fragment.appendChild(dependencies.document.createTextNode(content.slice(offset)));
        dependencies.els.previewContent.replaceChildren(fragment);
    }

    function renderHighlightedPreview(content, language) {
        if (!dependencies.els.previewContent) {
            return;
        }
        const renderId = ++dependencies.previewRenderId;
        dependencies.els.previewContent.classList.toggle('hljs', Boolean(language));
        dependencies.els.previewContent.textContent = content;
        if (!language) {
            return;
        }
        if (language === 'json') {
            dependencies.renderJsonHighlightedPreview(content);
            return;
        }
        dependencies.getPreviewHighlighter().then(highlighter => {
            if (renderId !== dependencies.previewRenderId || !dependencies.els.previewContent) {
                return;
            }
            dependencies.els.previewContent.innerHTML = highlighter.highlight(language, content).value;
        }).catch(error => {
            dependencies.console.warn('[WebTILP] Preview syntax highlighting unavailable:', error);
        });
    }

    function renderPreviewContent(entry, readable) {
        const preview = dependencies.unwrapReadablePreview(readable);
        const language = dependencies.previewSession?.language || preview.language || '';
        dependencies.renderHighlightedPreview(preview.content, language);
        if (dependencies.els.previewImage) {
            dependencies.els.previewImage.classList.toggle('hidden', !preview.imageDataUrl);
            if (preview.imageDataUrl) {
                dependencies.els.previewImage.src = preview.imageDataUrl;
            } else {
                dependencies.els.previewImage.removeAttribute('src');
            }
            dependencies.els.previewImage.alt = `${dependencies.t('preview')}: ${dependencies.formatVariableDisplayName(entry)}`;
        }
    }

    function openPreviewModal(entry, readable) {
        if (!dependencies.els.previewModal || !dependencies.els.previewContent) {
            return;
        }
        dependencies.els.previewTitle.textContent = `${dependencies.t('preview')}: ${dependencies.formatVariableDisplayName(entry)}`;
        dependencies.els.previewMeta.textContent = `${entry.typeName || `Type ${entry.type}`} · ${dependencies.formatBytes(entry.size)}`;
        if (dependencies.els.previewControls) {
            dependencies.els.previewControls.classList.toggle('hidden', !dependencies.previewSession?.isTIBasic);
        }
        const hasBasicDownloadControls = Boolean(
            dependencies.els.previewBasicDownloads
            && dependencies.els.btnDownloadPreviewEvo
            && dependencies.els.btnDownloadPreviewLegacy
        );
        const showBasicDownloads = Boolean(dependencies.previewSession?.isTIBasic && hasBasicDownloadControls);
        if (dependencies.els.previewBasicDownloads) {
            dependencies.els.previewBasicDownloads.classList.toggle('hidden', !showBasicDownloads);
        }
        if (dependencies.els.btnDownloadPreview) {
            dependencies.els.btnDownloadPreview.classList.toggle('hidden', showBasicDownloads);
        }
        if (dependencies.els.previewReindent) {
            dependencies.els.previewReindent.checked = false;
        }
        dependencies.renderPreviewContent(entry, readable);
        dependencies.els.previewModal.classList.remove('hidden');
        dependencies.els.previewModal.setAttribute('aria-hidden', 'false');
        dependencies.els.btnClosePreview?.focus();
    }

    function refreshPreviewReindent() {
        const session = dependencies.previewSession;
        if (!session?.isTIBasic || !session.variable || !session.options) {
            return;
        }
        try {
            const enabled = dependencies.els.previewReindent?.checked ? 1 : 0;
            session.options.set('prettify', 1);
            session.options.set('reindent', enabled);
            const readable = session.variable.getReadableContent(session.options);
            dependencies.renderPreviewContent(session.entry, readable);
        } catch (error) {
            dependencies.logError(new Error(dependencies.formatTivarsException(session.tivars, error)), 'Preview failed');
        }
    }

    function downloadPreviewFile() {
        const session = dependencies.previewSession;
        if (!session) {
            return;
        }
        try {
            const data = session.data || (session.module && session.receivedPath
                ? session.module.FS.readFile(session.receivedPath) : null);
            if (!data) {
                return;
            }
            dependencies.triggerDownload(session.downloadName, data);
        } catch (error) {
            dependencies.logError(error, 'Preview download failed');
        }
    }

    function downloadTIBasicPreview(targetModel) {
        const session = dependencies.previewSession;
        if (!session?.isTIBasic || !session.module || !session.receivedPath || !session.tivars) {
            return;
        }

        const safeInputName = String(session.downloadName || 'program.8xp').replace(/[\\/]/g, '_');
        const outputBaseName = String(session.entry?.name || safeInputName.replace(/\.[^.]*$/, '') || 'PROGRAM')
            .replace(/[\\/]/g, '_');
        const inputPath = `/preview-download-${Date.now()}-${safeInputName}`;
        let outputPath = '';
        let variable = null;
        try {
            const data = session.module.FS.readFile(session.receivedPath);
            session.tivars.FS.writeFile(inputPath, data, { encoding: 'binary' });
            variable = session.tivars.TIVarFile.loadFromFile(inputPath);
            variable.convertToModel(targetModel, targetModel === '84Evo');
            outputPath = variable.saveVarToFile('.', outputBaseName);
            const converted = session.tivars.FS.readFile(outputPath, { encoding: 'binary' });
            const outputName = outputPath.split('/').pop() || (targetModel === '84Evo' ? 'program.8xp2' : 'program.8xp');
            dependencies.triggerDownload(outputName, converted);
        } catch (error) {
            dependencies.logError(new Error(dependencies.formatTivarsException(session.tivars, error)), 'Preview download failed');
        } finally {
            for (const path of [inputPath, outputPath]) {
                if (!path) {
                    continue;
                }
                try {
                    session.tivars.FS.unlink(path);
                } catch {
                    // ignore
                }
            }
            if (variable && typeof variable.delete === 'function') {
                variable.delete();
            }
        }
    }

    async function previewEntry(entry, actionButton) {
        const operationGeneration = dependencies.session.capture();
        if (!dependencies.canPreviewVariable({
            ...entry,
            type_name: entry.typeName,
            is_folder: entry.isFolder ? 1 : 0
        })) {
            dependencies.log(`Preview is not supported for ${entry.name}.`);
            return;
        }

        dependencies.setButtonLoading(actionButton, true);
        let module = null;
        let receivedPath = '';
        let tivars = null;
        let converterPath = '';
        let variable = null;
        let options = null;
        let objectUrl = '';
        try {
            if (entry.kind === 'numworks') {
                if (!dependencies.state.numWorksBackend) {
                    throw new Error(dependencies.t('numworks_backend_not_connected'));
                }
                const script = dependencies.state.numWorksBackend.getScript(entry.numWorksName || entry.name);
                const data = new dependencies.TextEncoder().encode(script.code);
                dependencies.closePreviewModal();
                dependencies.previewSession = {
                    entry,
                    isTIBasic: false,
                    language: 'python',
                    data,
                    downloadName: script.name
                };
                dependencies.openPreviewModal(entry, script.code);
                dependencies.log(`Previewed ${script.name}.`);
                return;
            }

            const hpPreviewKind = dependencies.getHPPrimePreviewKind(entry);
            if (hpPreviewKind) {
                if (!Number.isInteger(entry.hpIndex) || entry.hpIndex < 0) {
                    throw new Error(dependencies.tFormat('hp_prime_missing_cache_index', { name: entry.name }));
                }
                if (entry.invalid
                    && !dependencies.confirm(dependencies.tFormat('hp_prime_confirm_invalid_crc', { name: entry.name }))) {
                    dependencies.log(dependencies.tFormat('hp_prime_invalid_crc_skipped', { name: entry.name }));
                    return;
                }
                module = await dependencies.session.wait(dependencies.initModule(), operationGeneration);
                if (!module.FS.analyzePath('/previews').exists) {
                    module.FS.mkdir('/previews');
                }
                const isAppChild = Number.isInteger(entry.hpAppChildIndex)
                    && entry.hpAppChildIndex >= 0;
                receivedPath = isAppChild
                    ? `/previews/hp-prime-${entry.hpIndex}-child-${entry.hpAppChildIndex}.bin`
                    : `/previews/hp-prime-${entry.hpIndex}.bin`;
                const result = isAppChild
                    ? await dependencies.session.wait(dependencies.ccallAsync(module, 'hp_prime_download_cached_app_child', 'number',
                        ['number', 'number', 'string'],
                        [entry.hpIndex, entry.hpAppChildIndex, receivedPath], { timeoutMs: 8000 }), operationGeneration)
                    : await dependencies.session.wait(dependencies.ccallAsync(module, 'hp_prime_download_cached_file', 'number',
                        ['number', 'string'], [entry.hpIndex, receivedPath], { timeoutMs: 8000 }), operationGeneration);
                if (result !== 0) {
                    throw new Error(dependencies.tFormat('hp_prime_cached_download_failed', {
                        error: dependencies.formatHPPrimeError(module, result)
                    }));
                }
                const data = module.FS.readFile(receivedPath);
                const extension = dependencies.getEntryExtension(entry);
                const safeName = String(entry.name || 'unnamed').replace(/[\\/\0-\x1F\x7F]/g, '_');
                const downloadName = isAppChild || !extension
                    ? safeName : `${safeName}.${extension}`;
                const preview = dependencies.createHPPrimePreview(entry, data);
                objectUrl = preview.objectUrl;
                dependencies.closePreviewModal();
                dependencies.previewSession = {
                    entry,
                    isTIBasic: false,
                    language: '',
                    module,
                    receivedPath,
                    downloadName,
                    objectUrl
                };
                receivedPath = '';
                objectUrl = '';
                dependencies.openPreviewModal(entry, preview.readable);
                dependencies.log(`Previewed ${entry.name}.`);
                return;
            }

            const modelId = dependencies.getActiveCalcModelId();
            await dependencies.session.wait(dependencies.authorizeDevice(), operationGeneration);
            module = await dependencies.session.wait(dependencies.initModule(), operationGeneration);
            const handle = await dependencies.session.wait(dependencies.ensureHandle(), operationGeneration);
            if (!module.FS.analyzePath('/previews').exists) {
                module.FS.mkdir('/previews');
            }
            const received = await dependencies.session.wait(dependencies.runWasmOperation(module,
                async (call, operation) => {
                    try { module.FS.unlink('/last_recv_path.txt'); } catch { /* No earlier result. */ }
                    const result = await call('calc_recv_var', 'number',
                        ['number', 'string', 'string', 'number', 'string'],
                        [handle, entry.folder, entry.name, entry.type, '/previews'], {
                            timeoutMs: dependencies.PROGRESS_IDLE_TIMEOUT_MS,
                            useProgress: true,
                            progressLabel: `Preparing preview for ${entry.name}`
                        });
                    operation.assertCurrent();
                    if (result !== 0) throw new Error(`Receive failed (${dependencies.formatErrorResult(module, result)})`);
                    const path = module.FS.readFile('/last_recv_path.txt', { encoding: 'utf8' }).trim();
                    if (!path) throw new Error('The received preview file path is unavailable');
                    const data = module.FS.readFile(path).slice();
                    try { module.FS.unlink('/last_recv_path.txt'); } catch { /* Best-effort marker cleanup. */ }
                    return { path, data };
                }), operationGeneration);
            receivedPath = received.path;
            const data = received.data;
            const receivedName = receivedPath.split('/').pop() || 'preview.8x?';

            tivars = await dependencies.session.wait(dependencies.getTivarsLib(), operationGeneration);
            converterPath = `/preview-${Date.now()}-${receivedName.replace(/[\\/]/g, '_')}`;
            tivars.FS.writeFile(converterPath, data, { encoding: 'binary' });
            try {
                variable = tivars.TIVarFile.loadFromFile(converterPath);
                options = new tivars.options_t();
                options.set('prettify', 1);
                options.set('reindent', 0);
                const isTIBasic = dependencies.isTIBasicPreviewEntry(entry, modelId);
                let language = dependencies.usesTIBasicPreviewSyntax(entry, modelId) ? 'basic-z80' : '';
                if (!language && dependencies.EVO_PYTHON_CALC_MODELS.has(modelId) && Number(entry.type) === 15) {
                    language = 'python';
                } else if (!language && Number(entry.type) === 0x15) {
                    options.set('metadata', 1);
                    try {
                        const metadata = JSON.parse(variable.getReadableContent(options));
                        if (metadata?.typeName === 'PythonAppVar') {
                            language = 'python';
                        }
                    } catch {
                        // A regular AppVar has no structured Python metadata.
                    } finally {
                        options.set('metadata', 0);
                    }
                }
                const readable = variable.getReadableContent(options);
                dependencies.closePreviewModal();
                dependencies.previewSession = {
                    entry,
                    tivars,
                    variable,
                    options,
                    isTIBasic,
                    language,
                    module,
                    receivedPath,
                    downloadName: receivedName
                };
                variable = null;
                options = null;
                receivedPath = '';
                dependencies.openPreviewModal(entry, readable);
                dependencies.log(`Previewed ${entry.name}.`);
            } catch (error) {
            if (error?.staleSession) throw error;
                throw new Error(dependencies.formatTivarsException(tivars, error));
            }
        } catch (err) {
            if (err?.staleSession) return;
            dependencies.logError(err, 'Preview failed');
        } finally {
            if (options && typeof options.delete === 'function') {
                options.delete();
            }
            if (variable && typeof variable.delete === 'function') {
                variable.delete();
            }
            if (tivars && converterPath) {
                try {
                    tivars.FS.unlink(converterPath);
                } catch {
                    // ignore
                }
            }
            if (module && receivedPath) {
                try {
                    module.FS.unlink(receivedPath);
                } catch {
                    // ignore
                }
            }
            if (objectUrl) {
                dependencies.URL.revokeObjectURL(objectUrl);
            }
            dependencies.setButtonLoading(actionButton, false);
        }
    }

    return { getPreviewHighlighter, disposePreviewSession, closePreviewModal, formatTivarsException, unwrapReadablePreview, decodeHPPrimeTextPreview, createHPPrimePreview, isTIBasicPreviewEntry, usesTIBasicPreviewSyntax, renderJsonHighlightedPreview, renderHighlightedPreview, renderPreviewContent, openPreviewModal, refreshPreviewReindent, downloadPreviewFile, downloadTIBasicPreview, previewEntry };
}

module.exports = { createFeaturesPreview };
