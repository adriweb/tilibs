'use strict';

/**
 * features file-controller. Browser and application dependencies are injected
 * by app.js; importing this module does not start the application.
 * @param {object} dependencies
 * @returns {object}
 */
function createFeaturesFileController(dependencies) {
    let fileActions = null;
    async function receiveSelected() {
        await dependencies.getFileActions().receiveEntries(dependencies.getSelectedFileEntries());
    }

    async function deleteSelected() {
        await dependencies.getFileActions().removeEntries(dependencies.getSelectedFileEntries());
    }

    async function renameEntry(entry) {
        if (dependencies.state?.activeFamily === 'sharp') return;

        if (dependencies.isHPLegacyActive()) {
            dependencies.log(dependencies.t('hp_legacy_mutation_unavailable'));
            return;
        }
        if (entry.isFolder && !dependencies.isNspireActive()) {
            dependencies.log('Folder renaming is only supported on TI-Nspire.');
            return;
        }
        const label = entry.isFolder ? 'folder' : 'item';
        const currentName = entry.name || '';
        const newName = dependencies.prompt(dependencies.tFormat('prompt_rename_entry', { kind: label }), currentName);
        if (!newName) {
            dependencies.log('Rename cancelled.');
            return;
        }
        const trimmed = newName.trim();
        if (!trimmed || trimmed === currentName) {
            dependencies.log('Rename cancelled.');
            return;
        }
        if (trimmed.includes('/')) {
            dependencies.log('Folder or item names cannot include "/".');
            return;
        }

        dependencies.setButtonLoading(dependencies.els.btnDeleteSelected, true);
        try {
            if (dependencies.isHPPrimeActive()) {
                if (!dependencies.state.hpFileSnapshotLoaded) {
                    dependencies.log(dependencies.t('hp_prime_app_snapshot_required'));
                    return;
                }
                if (!entry.hpAppChildEditable
                    || !Number.isInteger(entry.hpIndex)
                    || !Number.isInteger(entry.hpAppChildIndex)) {
                    dependencies.log(dependencies.t('hp_prime_app_core_read_only'));
                    return;
                }
                const module = await dependencies.initModule();
                const result = await dependencies.ccallAsync(module,
                    'hp_prime_rename_cached_app_resource', 'number',
                    ['number', 'number', 'string'],
                    [entry.hpIndex, entry.hpAppChildIndex, trimmed], {
                        timeoutMs: null,
                        useProgress: true,
                        progressLabel: dependencies.tFormat('hp_prime_app_progress_updating', {
                            app: entry.folder
                        })
                    });
                if (result !== 0) {
                    dependencies.log(dependencies.tFormat('hp_prime_app_rename_failed', {
                        error: dependencies.formatHPPrimeError(module, result)
                    }));
                    return;
                }
                dependencies.state.expandedFolders.add(entry.folder);
                dependencies.applyHPPrimeFileSnapshot(module);
                dependencies.log(dependencies.tFormat('hp_prime_app_resource_renamed', {
                    old: currentName,
                    name: trimmed,
                    app: entry.folder
                }));
                return;
            }
            if (dependencies.isNumWorksActive()) {
                const renamed = await dependencies.state.numWorksBackend.renameScript(currentName, trimmed);
                dependencies.readNumWorksInfo();
                dependencies.applyNumWorksStorageSnapshot();
                dependencies.log(dependencies.tFormat('numworks_script_renamed', { old: currentName, name: renamed }));
                return;
            }
            if (dependencies.isCasioActive()) {
                if (!dependencies.isValidCasioStorageName(trimmed)) {
                    dependencies.log(dependencies.tFormat('casio_invalid_filename', { file: trimmed }));
                    return;
                }
                const targetExists = dependencies.state.dirlist.some(candidate =>
                    candidate.kind === 'casio' && candidate.is_folder !== 1
                    && (candidate.folder || '') === (entry.folder || '')
                    && candidate.name.toLowerCase() === trimmed.toLowerCase());
                if (targetExists) {
                    dependencies.log(dependencies.tFormat('casio_rename_target_exists', { file: trimmed }));
                    return;
                }
                const module = await dependencies.initModule();
                const result = await dependencies.ccallAsync(module, 'casio_rename_file', 'number',
                    ['string', 'string', 'string', 'string'],
                    [entry.folder || '', currentName, entry.folder || '', trimmed], {
                        timeoutMs: null,
                        useProgress: true,
                        progressLabel: dependencies.tFormat('casio_progress_renaming_file', {
                            file: currentName
                        })
                    });
                await dependencies.refreshDirlist();
                if (result !== 0) {
                    dependencies.log(dependencies.tFormat('casio_file_rename_failed', {
                        file: currentName,
                        error: dependencies.formatCasioError(module, result)
                    }));
                    return;
                }
                dependencies.log(dependencies.tFormat('casio_file_renamed', {
                    old: currentName,
                    name: trimmed
                }));
                return;
            }
            await dependencies.authorizeDevice();
            const module = await dependencies.initModule();
            const handle = await dependencies.ensureHandle();
            const oldFolder = entry.folder || '';
            const newFolder = oldFolder;
            const result = await dependencies.ccallAsync(
                module,
                'calc_rename_var',
                'number',
                ['number', 'string', 'string', 'number', 'string', 'string', 'number'],
                [handle, oldFolder, currentName, entry.type, newFolder, trimmed, entry.type],
                { timeoutMs: dependencies.PROGRESS_IDLE_TIMEOUT_MS, useProgress: true, progressLabel: `Renaming ${currentName}` }
            );
            if (result !== 0) {
                dependencies.log(`Rename failed (${dependencies.formatErrorResult(module, result)}).`);
                return;
            }
            dependencies.log(`Renamed ${currentName} to ${trimmed}.`);
            await dependencies.refreshDirlist();
        } catch (err) {
            dependencies.logError(err, 'Rename failed');
        } finally {
            dependencies.setButtonLoading(dependencies.els.btnDeleteSelected, false);
        }
    }

    async function deleteEntry(entry) {
        await dependencies.getFileActions().removeEntries([entry], { single: true });
    }

    async function downloadEntry(entry) {
        await dependencies.getFileActions().receiveEntries([entry]);
    }

    function getFileActions() {
        if (!fileActions) {
            const deps = {
                state: dependencies.state, initModule: dependencies.initModule, authorizeDevice: dependencies.authorizeDevice, ensureHandle: dependencies.ensureHandle, ccallAsync: dependencies.ccallAsync,
                runOperation: dependencies.runWasmOperation,
                captureSession: () => dependencies.session.capture(),
                assertSession: token => dependencies.session.assertCurrent(token),
                idleTimeout: dependencies.PROGRESS_IDLE_TIMEOUT_MS,
                formatErrorResult: dependencies.formatErrorResult, formatHPPrimeError: dependencies.formatHPPrimeError, formatCasioError: dependencies.formatCasioError,
                t: dependencies.t, tFormat: dependencies.tFormat, confirm: dependencies.confirm, log: dependencies.log, logError: dependencies.logError, normalizeFolderPath: dependencies.normalizeFolderPath,
                triggerDownload: dependencies.triggerDownload, convertReceivedPythonFile: dependencies.convertReceivedPythonFile, setButtonLoading: dependencies.setButtonLoading, els: dependencies.els,
                runSharpOperation: dependencies.runSharpOperation, saveSharpDownload: dependencies.saveSharpDownload, readNumWorksInfo: dependencies.readNumWorksInfo,
                applyNumWorksStorageSnapshot: dependencies.applyNumWorksStorageSnapshot, applyHPPrimeFileSnapshot: dependencies.applyHPPrimeFileSnapshot, refreshDirlist: dependencies.refreshDirlist
            };
            fileActions = dependencies.createFileActions({ ...deps, backends: dependencies.createFileBackends(deps) });
        }
        return fileActions;
    }

    return { receiveSelected, deleteSelected, renameEntry, deleteEntry, downloadEntry, getFileActions };
}

module.exports = { createFeaturesFileController };
