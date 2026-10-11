'use strict';

/**
 * backends uploads. Browser and application dependencies are injected
 * by app.js; importing this module does not start the application.
 * @param {object} dependencies
 * @returns {object}
 */
function createBackendsUploads(dependencies) {
    async function sendHPLegacyFiles(files) {
        const operationGeneration = dependencies.session.capture();
        if (!dependencies.state.hpLegacyKermitEnabled) {
            throw new Error(dependencies.t('hp_legacy_kermit_not_selected'));
        }
        if (!dependencies.confirm(dependencies.tFormat('hp_legacy_confirm_send', { count: files.length }))) return;
        let successCount = 0;
        for (const file of files) {
            const suggestedName = String(file.name || '').replace(/\.[^.]+$/, '') || 'OBJECT';
            const remoteName = dependencies.prompt(dependencies.tFormat('hp_legacy_prompt_remote_name', {
                file: file.name
            }), suggestedName)?.replace(/^[ \t]+|[ \t]+$/g, '');
            if (!remoteName) {
                dependencies.log(dependencies.tFormat('hp_legacy_send_skipped', { file: file.name }));
                continue;
            }
            await dependencies.session.wait(dependencies.state.hpLegacyBackend.sendFile(remoteName,
                new dependencies.Uint8Array(await dependencies.session.wait(file.arrayBuffer(), operationGeneration))), operationGeneration);
            successCount += 1;
            dependencies.log(dependencies.tFormat('hp_legacy_file_sent', { file: file.name, name: remoteName }));
        }
        if (successCount) {
            dependencies.setSelectedFiles([]);
            await dependencies.session.wait(dependencies.refreshDirlist(), operationGeneration);
        }
    }

    async function sendNumWorksFiles(files) {
        const operationGeneration = dependencies.session.capture();
        const normalizeName = dependencies.globalThis.WebTILPNumWorks?.normalizeScriptName;
        if (!normalizeName || !dependencies.state.numWorksBackend) {
            throw new Error(dependencies.t('numworks_backend_not_connected'));
        }
        const existing = new Map(dependencies.state.dirlist
            .filter(entry => entry.kind === 'numworks')
            .map(entry => [String(entry.name).toLowerCase(), entry]));
        const pending = [];
        const pendingNames = new Set();
        for (const file of files) {
            if (!/\.py$/i.test(file.name || '')) {
                dependencies.log(dependencies.tFormat('numworks_unsupported_file', { file: file.name }));
                continue;
            }
            const normalized = normalizeName(file.name);
            const key = normalized.toLowerCase();
            if (pendingNames.has(key)) {
                throw new Error(dependencies.tFormat('numworks_duplicate_normalized', { name: normalized }));
            }
            const existingEntry = existing.get(key);
            if (existingEntry
                && !dependencies.confirm(dependencies.tFormat('numworks_confirm_overwrite', {
                    file: file.name,
                    name: normalized
                }))) {
                dependencies.log(dependencies.tFormat('numworks_overwrite_skipped', { file: file.name }));
                continue;
            }
            const originalBase = String(file.name).replace(/\.py$/i, '');
            if (originalBase !== normalized) {
                dependencies.log(dependencies.tFormat('numworks_name_normalized', {
                    file: file.name,
                    name: normalized
                }));
            }
            pendingNames.add(key);
            pending.push({
                name: normalized,
                code: await dependencies.session.wait(file.text(), operationGeneration),
                autoImport: existingEntry ? Boolean(existingEntry.attr) : true
            });
        }
        if (!pending.length) {
            dependencies.log(dependencies.t('numworks_no_supported_scripts'));
            return;
        }
        await dependencies.session.wait(dependencies.state.numWorksBackend.upsertScripts(pending), operationGeneration);
        dependencies.setSelectedFiles([]);
        dependencies.readNumWorksInfo();
        dependencies.applyNumWorksStorageSnapshot();
        dependencies.log(dependencies.tFormat('numworks_scripts_sent', { count: pending.length }));
    }

    function isValidCasioStorageName(name) {
        return Boolean(name && name.length <= 22
            && name !== '.' && name !== '..'
            && !/[\\/\x00-\x1F\x7F-\uFFFF]/.test(name));
    }

    async function sendCasioFiles(files, directory = '') {
        const operationGeneration = dependencies.session.capture();
        if (!dependencies.state.casioStorageSupported) {
            throw new Error(dependencies.t('casio_storage_protocol_unavailable'));
        }
        const module = await dependencies.session.wait(dependencies.initModule(), operationGeneration);
        if (!dependencies.state.casioFileSnapshotLoaded
            && !dependencies.confirm(dependencies.t('casio_confirm_unchecked_overwrite'))) {
            dependencies.log(dependencies.t('casio_upload_cancelled'));
            return;
        }
        const normalizedDirectory = dependencies.normalizeFolderPath(directory || '');
        if (normalizedDirectory.includes('/')
            || (normalizedDirectory && !dependencies.isValidCasioStorageName(normalizedDirectory))) {
            throw new Error(dependencies.tFormat('casio_invalid_folder', { folder: directory }));
        }
        // Keep the pre-upload collision set even after a successful send makes the
        // global listing stale. Every later file still needs its own confirmation.
        const existingFiles = dependencies.state.casioFileSnapshotLoaded ? dependencies.state.dirlist.slice() : [];
        const pendingNames = new Set();
        let successCount = 0;
        for (let index = 0; index < files.length; index++) {
            const file = files[index];
            const name = String(file.name || '').split(/[\\/]/).pop();
            const key = `${normalizedDirectory}\u0000${name}`.toLowerCase();
            if (!dependencies.isValidCasioStorageName(name)) {
                dependencies.log(dependencies.tFormat('casio_invalid_filename', { file: file.name }));
                continue;
            }
            if (pendingNames.has(key)) {
                dependencies.log(dependencies.tFormat('casio_duplicate_filename', { file: name }));
                continue;
            }
            pendingNames.add(key);
            const existing = existingFiles.find(entry => entry.kind === 'casio'
                && entry.is_folder !== 1
                && String(entry.folder || '').toLowerCase()
                    === normalizedDirectory.toLowerCase()
                && String(entry.name || '').toLowerCase() === name.toLowerCase());
            if (existing && !dependencies.confirm(dependencies.tFormat('casio_confirm_overwrite', {
                file: name,
                folder: normalizedDirectory || dependencies.t('casio_storage_root')
            }))) {
                dependencies.log(dependencies.tFormat('casio_overwrite_skipped', { file: name }));
                continue;
            }
            const path = `/casio-upload-${index}.bin`;
            try {
                module.FS.writeFile(path, new dependencies.Uint8Array(await dependencies.session.wait(file.arrayBuffer(), operationGeneration)));
                const result = await dependencies.session.wait(dependencies.ccallAsync(module, 'casio_send_file', 'number',
                    ['string', 'string', 'string'],
                    [path, normalizedDirectory, name], {
                        timeoutMs: null,
                        useProgress: true,
                        progressLabel: dependencies.tFormat('casio_progress_sending_file', { file: name })
                    }), operationGeneration);
                if (result === 0) {
                    successCount += 1;
                    dependencies.state.casioFileSnapshotLoaded = false;
                    dependencies.log(dependencies.tFormat('casio_file_sent', { file: name }));
                } else {
                    dependencies.log(dependencies.tFormat('casio_file_send_failed', {
                        file: name,
                        error: dependencies.formatCasioError(module, result)
                    }));
                }
            } finally {
                try {
                    module.FS.unlink(path);
                } catch {
                    // Best-effort cleanup.
                }
            }
        }
        if (successCount > 0) {
            dependencies.setSelectedFiles([]);
            await dependencies.session.wait(dependencies.refreshDirlist(), operationGeneration);
        }
    }

    async function sendSharpFiles(files) {
        const operationGeneration = dependencies.session.capture();
        if (!files.length) return;
        // Check every file before starting any transfer.
        const prepared = [];
        try {
            for (const file of files) {
                const data = new dependencies.Uint8Array(await dependencies.session.wait(file.arrayBuffer(), operationGeneration));
                const decoded = dependencies.globalThis.WebTILPSharp.decodeNative(data, file.name);
                dependencies.globalThis.WebTILPSharp.validateRestore(decoded, dependencies.state.sharpBackend?.model, true);
                prepared.push({ file, data, decoded });
            }
            if (prepared.length > 1 && prepared.some(item => item.decoded.backup)) {
                throw new Error('Send a Sharp RAM backup on its own. Restore requires reconnecting afterward.');
            }
        } catch (error) {
            if (error?.staleSession) throw error; dependencies.logError(error, dependencies.t('sharp_operation_failed')); return; }
        if (!dependencies.confirm(dependencies.tFormat('sharp_confirm_send', { count: prepared.length }))) return;
        if (prepared.some(item => item.decoded.backup) && !dependencies.confirm(dependencies.t('sharp_confirm_restore'))) return;
        await dependencies.session.wait(dependencies.runSharpOperation(dependencies.t('sharp_send'), async backend => {
            for (const item of prepared) {
                await dependencies.session.wait(backend.sendFile(item.data, item.file.name, { allowRestore: item.decoded.backup }), operationGeneration);
                if (dependencies.state.sharpBackend !== backend) return;
                dependencies.log(dependencies.tFormat('sharp_sent', { file: item.file.name }));
            }
            dependencies.state.dirlist = []; dependencies.renderDirlist([]);
        }), operationGeneration);
    }

    return { sendHPLegacyFiles, sendNumWorksFiles, isValidCasioStorageName, sendCasioFiles, sendSharpFiles };
}

module.exports = { createBackendsUploads };
