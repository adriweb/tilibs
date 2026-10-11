'use strict';

/**
 * features directory. Browser and application dependencies are injected
 * by app.js; importing this module does not start the application.
 * @param {object} dependencies
 * @returns {object}
 */
function createFeaturesDirectory(dependencies) {
    async function refreshBackupDirlist(module, handle) {
        if (dependencies.state.backupDirlistInProgress) return;
        const hasBackup = (dependencies.state.features & (dependencies.FEATURE_FLAGS.OPS_BACKUP | dependencies.FEATURE_FLAGS.FTS_BACKUP)) !== 0;
        if (!hasBackup || ![2, 6].includes(dependencies.getActiveCalcModelId())) return;
        if (!dependencies.confirm(dependencies.t('confirm_backup_dirlist'))) return;
        dependencies.state.backupDirlistInProgress = true;
        dependencies.setButtonLoading(dependencies.els.btnBackupDirlist, true);
        const epoch = dependencies.state.operationEpoch;
        const backupPath = '/dirlist-backup.bin';
        const jsonPath = '/dirlist-backup.json';
        try {
            const result = await dependencies.ccallAsync(module, 'calc_recv_backup', 'number', ['number', 'string'],
                [handle, backupPath], { timeoutMs: null, useProgress: true, progressLabel: 'Receiving backup for variable listing' });
            if (epoch !== dependencies.state.operationEpoch) return;
            if (result !== 0) {
                dependencies.log(`Backup listing receive failed (${dependencies.formatErrorResult(module, result)}).`);
                return;
            }
            const parsed = await dependencies.ccallAsync(module, 'calc_backup_dirlist_json', 'number', ['string', 'string'],
                [backupPath, jsonPath]);
            if (epoch !== dependencies.state.operationEpoch) return;
            if (parsed !== 0) {
                dependencies.log('Cannot list this backup: its format, checksum, or variable table is invalid or unsupported.');
                return;
            }
            const data = JSON.parse(module.FS.readFile(jsonPath, { encoding: 'utf8' }));
            dependencies.state.dirlist = data.vars;
            dependencies.state.backupDirlistLoaded = true;
            dependencies.renderDirlist(dependencies.state.dirlist);
            dependencies.els.varsPanel?.classList.remove('hidden');
            dependencies.els.backupDirlistNote?.classList.remove('hidden');
            dependencies.log(`Backup variable listing loaded: ${dependencies.state.dirlist.length} entries.`);
        } finally {
            for (const path of [backupPath, jsonPath]) {
                try { module.FS.unlink(path); } catch { /* Best-effort cleanup. */ }
            }
            try {
                if (module.FS.readFile('/last_recv_path.txt', { encoding: 'utf8' }).trim() === backupPath) {
                    module.FS.unlink('/last_recv_path.txt');
                }
            } catch { /* No receive marker. */ }
            dependencies.state.backupDirlistInProgress = false;
            dependencies.setButtonLoading(dependencies.els.btnBackupDirlist, false);
        }
    }

    async function refreshDirlist({ manual = false } = {}) {
        if (dependencies.state?.activeFamily === 'sharp') {
            await dependencies.runSharpOperation(dependencies.t('sharp_list'), async backend => {
                const entries = await backend.listVariables();
                if (dependencies.state.sharpBackend !== backend) return;
                dependencies.state.dirlist = entries; dependencies.renderDirlist(entries);
            });
            return;
        }

        dependencies.setButtonLoading(dependencies.els.btnRefreshDirlist, true);
        try {
            if (dependencies.isHPPrimeActive()) {
                const module = await dependencies.initModule();
                const refresh = dependencies.beginHPPrimeFileSnapshot(module);
                let result;
                try {
                    result = await dependencies.ccallAsync(module, 'hp_prime_refresh_files', 'number', [], [], {
                        timeoutMs: null,
                        useProgress: true,
                        progressLabel: dependencies.t('hp_prime_progress_loading_files')
                    });
                } catch (error) {
                    dependencies.finishHPPrimeFileSnapshot(module, refresh, false);
                    throw error;
                }
                if (result !== 0) {
                    dependencies.finishHPPrimeFileSnapshot(module, refresh, false);
                    dependencies.log(dependencies.tFormat('hp_prime_file_listing_failed', {
                        error: dependencies.formatHPPrimeError(module, result)
                    }));
                    return;
                }
                const count = dependencies.finishHPPrimeFileSnapshot(module, refresh, true);
                dependencies.log(dependencies.tFormat('hp_prime_snapshot_loaded', { count }));
                return;
            }
            if (dependencies.isHPLegacyActive()) {
                if (!dependencies.state.hpLegacyKermitEnabled) {
                    dependencies.log(dependencies.t('hp_legacy_kermit_not_selected'));
                    return;
                }
                const directory = await dependencies.state.hpLegacyBackend.refresh();
                dependencies.state.dirlist = dependencies.state.hpLegacyBackend.listEntries();
                dependencies.renderDirlist(dependencies.state.dirlist);
                dependencies.log(dependencies.tFormat('hp_legacy_files_loaded', {
                    count: dependencies.state.dirlist.length,
                    path: directory.path || 'HOME'
                }));
                return;
            }
            if (dependencies.isNumWorksActive()) {
                await dependencies.state.numWorksBackend.refresh();
                dependencies.readNumWorksInfo();
                const count = dependencies.applyNumWorksStorageSnapshot();
                dependencies.log(dependencies.tFormat('numworks_scripts_refreshed', { count }));
                return;
            }
            if (dependencies.isCasioActive()) {
                if (!dependencies.state.casioStorageSupported) {
                    dependencies.log(dependencies.t('casio_storage_protocol_unavailable'));
                    return;
                }
                const module = await dependencies.initModule();
                dependencies.state.casioFileSnapshotLoaded = false;
                const result = await dependencies.ccallAsync(module, 'casio_refresh_files', 'number', [], [], {
                    timeoutMs: null,
                    useProgress: true,
                    progressLabel: dependencies.t('casio_progress_loading_files')
                });
                if (result !== 0) {
                    dependencies.log(dependencies.tFormat('casio_file_listing_failed', {
                        error: dependencies.formatCasioError(module, result)
                    }));
                    return;
                }
                const count = dependencies.applyCasioStorageSnapshot(module);
                dependencies.readCasioInfo(module);
                dependencies.log(dependencies.tFormat('casio_files_loaded', { count }));
                return;
            }
            await dependencies.authorizeDevice();
            const module = await dependencies.initModule();
            const handle = await dependencies.ensureHandle();
            await dependencies.updateCapabilities();
            if ((dependencies.state.features & dependencies.FEATURE_FLAGS.OPS_DIRLIST) === 0) {
                if (manual) await dependencies.refreshBackupDirlist(module, handle);
                return;
            }
            const result = await dependencies.ccallAsync(module, 'calc_dirlist_json', 'number', ['number', 'string'], [handle, '/dirlist.json'], { timeoutMs: null, useProgress: true, progressLabel: 'Loading directory listing' });
            if (result !== 0) {
                dependencies.log(`Dirlist failed (${dependencies.formatErrorResult(module, result)}).`);
                return;
            }
            const data = module.FS.readFile('/dirlist.json', { encoding: 'utf8' });
            const parsed = JSON.parse(data);
            dependencies.state.dirlist = [...parsed.vars, ...parsed.apps];
            dependencies.renderDirlist(dependencies.state.dirlist);
            if (parsed.memory && parsed.memory.ok) {
                const ramInfo = dependencies.formatMemoryValue(parsed.memory.ram_free);
                const flashInfo = dependencies.formatMemoryValue(parsed.memory.flash_free);
                dependencies.els.memoryInfo.textContent = `RAM ${ramInfo.display} | Flash ${flashInfo.display}`;
                dependencies.els.memoryInfo.title = `RAM ${ramInfo.raw} | Flash ${flashInfo.raw}`;
            }
            dependencies.log(`Dirlist loaded: ${dependencies.state.dirlist.length} entries.`);
        } catch (err) {
            dependencies.logError(err, 'Dirlist failed');
        } finally {
            dependencies.setButtonLoading(dependencies.els.btnRefreshDirlist, false);
        }
    }

    async function ensureDirlistLoadedWithPrompt() {
        if ((dependencies.state.features & dependencies.FEATURE_FLAGS.OPS_DIRLIST) === 0 || dependencies.state.dirlist.length) {
            return;
        }
        if (dependencies.state.dirlistPromptPromise) {
            await dependencies.state.dirlistPromptPromise;
            return;
        }
        dependencies.state.dirlistPromptPromise = (async () => {
            const confirmDirlist = dependencies.confirm(dependencies.t('confirm_load_dirlist_before_transfer'));
            if (confirmDirlist) {
                await dependencies.refreshDirlist();
            }
        })();
        try {
            await dependencies.state.dirlistPromptPromise;
        } finally {
            dependencies.state.dirlistPromptPromise = null;
        }
    }

    async function downloadFolderEntries(folderPath) {
        await dependencies.getFileActions().receiveFolder(folderPath);
    }

    async function createNewFolder() {
        const name = (dependencies.els.newFolderName?.value || '').trim();
        if (!name) {
            dependencies.log('Folder name is required.');
            return;
        }
        const parent = (dependencies.els.newFolderParent?.value || '').trim();
        if (parent && !dependencies.isNspireActive()) {
            dependencies.log('Nested folders are only supported on TI-Nspire.');
            return;
        }
        const folderPath = parent ? `${parent}/${name}` : name;
        dependencies.setButtonLoading(dependencies.els.btnCreateNewFolder, true);
        try {
            await dependencies.authorizeDevice();
            const module = await dependencies.initModule();
            const handle = await dependencies.ensureHandle();
            await dependencies.updateCapabilities();
            if ((dependencies.state.features & dependencies.FEATURE_FLAGS.OPS_NEWFLD) === 0) {
                dependencies.log('Folder creation is not supported by this calculator.');
                return;
            }
            const result = await dependencies.ccallAsync(module, 'calc_new_folder', 'number', ['number', 'string'], [handle, folderPath], { timeoutMs: dependencies.PROGRESS_IDLE_TIMEOUT_MS, useProgress: true, progressLabel: `Creating ${folderPath}` });
            if (result !== 0) {
                dependencies.log(`Failed to create folder (${dependencies.formatErrorResult(module, result)}).`);
                return;
            }
            dependencies.log(`Folder created: ${folderPath}.`);
            dependencies.closeNewFolderModal();
            await dependencies.refreshDirlist();
        } catch (err) {
            dependencies.logError(err, 'Create folder failed');
        } finally {
            dependencies.setButtonLoading(dependencies.els.btnCreateNewFolder, false);
        }
    }

    return { refreshBackupDirlist, refreshDirlist, ensureDirlistLoadedWithPrompt, downloadFolderEntries, createNewFolder };
}

module.exports = { createFeaturesDirectory };
