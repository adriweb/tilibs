'use strict';

/**
 * features transfers. Browser and application dependencies are injected
 * by app.js; importing this module does not start the application.
 * @param {object} dependencies
 * @returns {object}
 */
function createFeaturesTransfers(dependencies) {
    async function sendDroppedFiles(files, dropFolder) {
        const operationGeneration = dependencies.session.capture();
        if (dependencies.state?.activeFamily === 'sharp') { await dependencies.session.wait(dependencies.sendSharpFiles(files), operationGeneration); return; }

        if (!files.length) {
            return;
        }
        dependencies.log(`Dropped ${files.length} file(s) for transfer.`);
        if (dependencies.isHPLegacyActive()) {
            try {
                await dependencies.session.wait(dependencies.sendHPLegacyFiles(files), operationGeneration);
            } catch (error) {
            if (error?.staleSession) throw error;
                dependencies.logError(error, dependencies.t('hp_legacy_upload_failed'));
            }
            return;
        }
        if (dependencies.isCasioActive()) {
            try {
                await dependencies.session.wait(dependencies.sendCasioFiles(files, dropFolder || ''), operationGeneration);
            } catch (error) {
            if (error?.staleSession) throw error;
                dependencies.logError(error, dependencies.t('casio_upload_failed'));
            }
            return;
        }
        if (dependencies.isHPPrimeActive()) {
            const appRoot = dependencies.findHPPrimeAppRoot(dropFolder);
            if (appRoot && !files.some(file => file.hpAppDirectory)) {
                try {
                    await dependencies.session.wait(dependencies.sendHPPrimeAppResources(files, appRoot), operationGeneration);
                } catch (error) {
            if (error?.staleSession) throw error;
                    dependencies.logError(error, dependencies.t('hp_prime_app_upload_failed_short'));
                }
                return;
            }
            dependencies.setSelectedFiles(files, 'table drop');
            try {
                await dependencies.session.wait(dependencies.sendSelectedFiles(), operationGeneration);
            } catch (error) {
            if (error?.staleSession) throw error;
                dependencies.logError(error, 'Dropped transfer failed');
            }
            return;
        }
        if (dependencies.isNumWorksActive()) {
            try {
                await dependencies.session.wait(dependencies.sendNumWorksFiles(files), operationGeneration);
            } catch (error) {
            if (error?.staleSession) throw error;
                dependencies.logError(error, dependencies.t('numworks_dropped_upload_failed'));
            }
            return;
        }
        await dependencies.session.wait(dependencies.processIncomingTransfers(files, {
            dropFolder,
            checkCableMismatch: true,
            useModal: false,
            errorContext: 'Dropped transfer failed'
        }), operationGeneration);
    }

    async function sendSelectedFiles() {
        const operationGeneration = dependencies.session.capture();
        const files = dependencies.state.selectedFiles.length
            ? dependencies.state.selectedFiles
            : Array.from(dependencies.els.fileInput.files || []);
        if (!files.length) {
            dependencies.log('No files selected.');
            return;
        }
        dependencies.setButtonLoading(dependencies.els.btnSendFiles, true);
        try {
            if (dependencies.state?.activeFamily === 'sharp') { await dependencies.session.wait(dependencies.sendSharpFiles(files), operationGeneration); return; }
            if (dependencies.isHPLegacyActive()) {
                try {
                    await dependencies.session.wait(dependencies.sendHPLegacyFiles(files), operationGeneration);
                } catch (error) {
            if (error?.staleSession) throw error;
                    dependencies.logError(error, dependencies.t('hp_legacy_upload_failed'));
                }
                return;
            }
            if (dependencies.isCasioActive()) {
                try {
                    await dependencies.session.wait(dependencies.sendCasioFiles(files), operationGeneration);
                } catch (error) {
            if (error?.staleSession) throw error;
                    dependencies.logError(error, dependencies.t('casio_upload_failed'));
                }
                return;
            }
            if (dependencies.isHPPrimeActive()) {
                const module = await dependencies.session.wait(dependencies.initModule(), operationGeneration);
                let successCount = 0;
                let appPartsSent = false;
                // Handle app parts while the cache is still valid: top-level sends
                // below invalidate it. Never send these as independent variables.
                for (const file of files.filter(file => /\.(hpappprgm|hpappnote)$/i.test(file.name))) {
                    const app = dependencies.chooseHPPrimeAppForFile(file);
                    if (app && await dependencies.session.wait(dependencies.sendHPPrimeAppResources([file], app), operationGeneration)) appPartsSent = true;
                }
                const topLevelFiles = files.filter(file => !/\.(hpappprgm|hpappnote)$/i.test(file.name));
                if (!topLevelFiles.length) {
                    if (appPartsSent) dependencies.setSelectedFiles([]);
                    return;
                }
                if (!dependencies.state.hpFileSnapshotLoaded
                    && !dependencies.confirm(dependencies.t('hp_prime_confirm_unchecked_overwrite'))) {
                    dependencies.log(dependencies.t('hp_prime_upload_cancelled'));
                    return;
                }
                for (let index = 0; index < topLevelFiles.length; index++) {
                    const file = topLevelFiles[index];
                    const identity = dependencies.getHPPrimeUploadIdentity(file.name);
                    if (!identity) {
                        dependencies.log(dependencies.tFormat('hp_prime_unsupported_file', { file: file.name }));
                        continue;
                    }
                    const duplicate = dependencies.state.hpFileSnapshotLoaded
                        ? dependencies.state.dirlist.find(entry => {
                            const entryExtension = String(entry.extension || '').toLowerCase();
                            const normalizedExtension = entryExtension === 'hpmatrix'
                                ? 'hpmat' : entryExtension;
                            return entry.kind === 'hp' && entry.name === identity.name
                                && normalizedExtension === identity.extension;
                        })
                        : null;
                    if (duplicate && !dependencies.confirm(dependencies.tFormat('hp_prime_confirm_overwrite', {
                        file: file.name,
                        existing: duplicate.name
                    }))) {
                        dependencies.log(dependencies.tFormat('hp_prime_overwrite_skipped', { file: file.name }));
                        continue;
                    }
                    const path = `/hp-prime-upload-${index}.bin`;
                    try {
                        module.FS.writeFile(path, new dependencies.Uint8Array(await dependencies.session.wait(file.arrayBuffer(), operationGeneration)));
                        const result = await dependencies.session.wait(dependencies.ccallAsync(module, 'hp_prime_send_file', 'number',
                            ['string', 'string'], [path, file.name], {
                                timeoutMs: null,
                                useProgress: true,
                                progressLabel: dependencies.tFormat('hp_prime_progress_sending_file', { file: file.name })
                            }), operationGeneration);
                        if (result === 0) {
                            successCount += 1;
                            dependencies.state.hpFileSnapshotLoaded = false;
                            dependencies.log(dependencies.tFormat('hp_prime_file_sent', { file: file.name }));
                        } else {
                            dependencies.log(dependencies.tFormat('hp_prime_file_send_failed', {
                                file: file.name,
                                error: dependencies.formatHPPrimeError(module, result)
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
                return;
            }
            if (dependencies.isNumWorksActive()) {
                try {
                    await dependencies.session.wait(dependencies.sendNumWorksFiles(files), operationGeneration);
                } catch (error) {
            if (error?.staleSession) throw error;
                    dependencies.logError(error, dependencies.t('numworks_upload_failed'));
                }
                return;
            }
            await dependencies.session.wait(dependencies.processIncomingTransfers(files, {
                checkCableMismatch: false,
                useModal: true,
                errorContext: 'Send files failed'
            }), operationGeneration);
        } finally {
            dependencies.setButtonLoading(dependencies.els.btnSendFiles, false);
            // A completed HP Prime transfer can clear the selected files while the
            // button is still in its loading state. Recompute from the current
            // selection after restoring the button so stale pre-transfer state
            // cannot leave it enabled.
            dependencies.updateSendFilesButtonState();
        }
    }

    async function processIncomingTransfers(files, options = {}) {
        const operationGeneration = dependencies.session.capture();
        const {
            dropFolder = '',
            useModal = true,
            checkCableMismatch = false,
            errorContext = 'Send files failed'
        } = options;

        if (!files.length) {
            return;
        }

        try {
            await dependencies.session.wait(dependencies.authorizeDevice(), operationGeneration);
            if (checkCableMismatch && dependencies.promptCableMismatchResolution()) {
                return;
            }
            if (!dependencies.ensureSilverlinkModelSelected()) {
                return;
            }
            const module = await dependencies.session.wait(dependencies.initModule(), operationGeneration);
            await dependencies.session.wait(dependencies.ensureCableOpen(), operationGeneration);
            await dependencies.session.wait(dependencies.updateCapabilities(), operationGeneration);
            await dependencies.session.wait(dependencies.ensureDirlistLoadedWithPrompt(), operationGeneration);

            const hasFolder = (dependencies.state.features & dependencies.FEATURE_FLAGS.FTS_FOLDER) !== 0;
            const hasArchive = (dependencies.state.features & dependencies.FEATURE_FLAGS.OPS_CHATTR) !== 0 || (dependencies.state.features & dependencies.FEATURE_FLAGS.FTS_FLASH) !== 0;
            const folders = hasFolder ? dependencies.getDirlistFolders() : [];
            const effectiveFolder = hasFolder ? (dropFolder || '') : '';

            if (!useModal && effectiveFolder) {
                dependencies.log(`Target folder: ${effectiveFolder}`);
            }

            const bundleCandidates = files.filter(dependencies.isCeBundleFile);
            if (bundleCandidates.length > 0) {
                if (bundleCandidates.length !== files.length) {
                    dependencies.alert(dependencies.t('alert_bundle_only_files'));
                    return;
                }
                if (bundleCandidates.length > 1) {
                    dependencies.alert(dependencies.t('alert_bundle_one_at_a_time'));
                    return;
                }
                const bundleResult = await dependencies.session.wait(dependencies.handleCeBundleTransfer(bundleCandidates[0], module, { hasFolder, hasArchive, folders }), operationGeneration);
                if (bundleResult?.successCount > 0) {
                    dependencies.setSelectedFiles([]);
                }
                return;
            }

            const plan = await dependencies.session.wait(dependencies.buildTransferPlan(files, module), operationGeneration);
            const planPaths = [...new Set(plan.map(item => item.path).filter(Boolean))];
            let selections = [];
            let overwriteAll = false;
            try {
                if (useModal) {
                    const modalResult = await dependencies.session.wait(dependencies.openTransferModal(plan, { hasFolder, hasArchive, folders }), operationGeneration);
                    if (!modalResult) {
                        return;
                    }
                    selections = modalResult.selections;
                    overwriteAll = modalResult.overwriteAll;
                } else {
                    selections = plan.map(item => ({
                        ...item,
                        targetFolder: effectiveFolder
                    }));
                }

                const { successCount } = await dependencies.session.wait(dependencies.performTransfers(selections, module, { hasFolder, hasArchive, overwriteAll }), operationGeneration);
                const hasOsTransfer = selections.some(item => item.fileClass === 'os');
                if (successCount > 0) {
                    dependencies.setSelectedFiles([]);
                    if (!hasOsTransfer && (dependencies.state.features & dependencies.FEATURE_FLAGS.OPS_DIRLIST) !== 0) {
                        await dependencies.session.wait(dependencies.refreshDirlist(), operationGeneration);
                    } else if (dependencies.state.backupDirlistLoaded) {
                        dependencies.state.backupDirlistLoaded = false;
                        dependencies.state.dirlist = [];
                        dependencies.renderDirlist(dependencies.state.dirlist);
                        dependencies.els.varsPanel?.classList.add('hidden');
                        dependencies.els.backupDirlistNote?.classList.add('hidden');
                    }
                }
            } finally {
                planPaths.forEach(path => {
                    try {
                        module.FS.unlink(path);
                    } catch {
                        // ignore
                    }
                });
            }
        } catch (err) {
            if (err?.staleSession) throw err;
            dependencies.logError(err, errorContext);
        }
    }

    async function uiAction(promise) {
        try { return await promise; }
        catch (error) { if (!error?.silent) throw error; }
    }

    return {
        sendDroppedFiles: (...args) => uiAction(sendDroppedFiles(...args)),
        sendSelectedFiles: (...args) => uiAction(sendSelectedFiles(...args)),
        processIncomingTransfers
    };
}

module.exports = { createFeaturesTransfers };
