'use strict';

/**
 * features backup. Browser and application dependencies are injected
 * by app.js; importing this module does not start the application.
 * @param {object} dependencies
 * @returns {object}
 */
function createFeaturesBackup(dependencies) {
    function getDirlistFolders() {
        const folders = new Set(['']);
        dependencies.state.dirlist.forEach(entry => {
            if (entry.is_folder === 1 && entry.name) {
                folders.add(dependencies.getEntryFolderPath(entry));
                return;
            }
            if (entry.folder) {
                folders.add(entry.folder);
            }
        });
        return Array.from(folders).filter(folder => folder !== '');
    }

    function estimateBackupSize() {
        let total = 0;
        dependencies.state.dirlist.forEach(entry => {
            if (!entry || entry.is_folder === 1) {
                return;
            }
            if (entry.kind !== 'var' && entry.kind !== 'app') {
                return;
            }
            const size = Number(entry.size);
            if (Number.isFinite(size) && size > 0) {
                total += size;
            }
        });
        return total;
    }

    function isVarFileClass(fileClass) {
        return ['single', 'group', 'regular', 'tigroup'].includes(fileClass);
    }

    async function receiveBackup() {
        if (dependencies.state?.activeFamily === 'sharp') {
            await dependencies.runSharpOperation(dependencies.t('sharp_backup'), async backend => dependencies.saveSharpDownload(await backend.receiveBackup(), backend));
            return;
        }

        dependencies.setButtonLoading(dependencies.els.btnReceiveBackup, true);
        try {
            if (dependencies.isHPLegacyActive()) {
                dependencies.log(dependencies.t('hp_legacy_backup_unavailable'));
                return;
            }
            if (dependencies.isCasioActive()) {
                dependencies.log(dependencies.t('casio_backup_unavailable'));
                return;
            }
            if (dependencies.isHPPrimeActive()) {
                const module = await dependencies.initModule();
                if (!module.FS.analyzePath('/downloads').exists) {
                    module.FS.mkdir('/downloads');
                }
                const target = '/downloads/hp-prime-backup.zip';
                const refresh = dependencies.beginHPPrimeFileSnapshot(module);
                let result;
                try {
                    result = await dependencies.ccallAsync(module, 'hp_prime_backup', 'number', ['string'], [target], {
                        timeoutMs: null,
                        useProgress: true,
                        progressLabel: dependencies.t('hp_prime_progress_receiving_backup')
                    });
                } catch (error) {
                    dependencies.finishHPPrimeFileSnapshot(module, refresh, false);
                    throw error;
                }
                if (result !== 0) {
                    dependencies.finishHPPrimeFileSnapshot(module, refresh, false);
                    dependencies.log(dependencies.tFormat('hp_prime_backup_failed', {
                        error: dependencies.formatHPPrimeError(module, result)
                    }));
                    return;
                }
                const snapshotCount = dependencies.finishHPPrimeFileSnapshot(module, refresh, true);
                const data = module.FS.readFile(target);
                dependencies.triggerDownload('hp-prime-backup.zip', data);
                module.FS.unlink(target);
                dependencies.log(dependencies.tFormat('hp_prime_backup_received', { count: snapshotCount }));
                return;
            }
            if (dependencies.isNumWorksActive()) {
                const data = await dependencies.state.numWorksBackend.readRawStorageImage();
                const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
                dependencies.triggerDownload(`numworks-storage-${stamp}.bin`, data);
                dependencies.log(dependencies.tFormat('numworks_backup_received', { size: data.byteLength }));
                return;
            }
            await dependencies.authorizeDevice();
            const module = await dependencies.initModule();
            const handle = await dependencies.ensureHandle();
            await dependencies.updateCapabilities();
            const allowTigroup = (dependencies.state.features & dependencies.FEATURE_FLAGS.FTS_FLASH) !== 0;
            let defaultFormat = allowTigroup ? 'tigroup' : 'backup';
            let defaultMode = dependencies.TIG_MODE.RAM | dependencies.TIG_MODE.ARCHIVE | dependencies.TIG_MODE.FLASH;
            let backupChoice = null;

            while (true) {
                // Native backups need no directory listing; TIGroup lists in the backend.
                backupChoice = await dependencies.openBackupModal({
                    allowTigroup,
                    defaultFormat,
                    defaultMode
                });
                if (!backupChoice) {
                    return;
                }
                defaultFormat = backupChoice.format;
                defaultMode = backupChoice.mode;

                if (backupChoice.format === 'tigroup' && backupChoice.mode === dependencies.TIG_MODE.NONE) {
                    dependencies.log('Select at least one data type for TIGroup.');
                    defaultFormat = 'tigroup';
                    continue;
                }
                if (backupChoice.format === 'backup') {
                    const estimatedSize = dependencies.estimateBackupSize();
                    if (estimatedSize > 65535) {
                        const proceed = dependencies.confirm(dependencies.t('confirm_large_backup_continue_standard'));
                        if (!proceed) {
                            if (allowTigroup) {
                                defaultFormat = 'tigroup';
                            }
                            continue;
                        }
                    }
                }
                break;
            }
            if (!module.FS.analyzePath('/downloads').exists) {
                module.FS.mkdir('/downloads');
            }
            const isTigroup = backupChoice.format === 'tigroup';
            const extension = isTigroup ? 'tig' : module.ccall('get_backup_ext', 'string', [], []);
            if (!extension) {
                throw new Error('No backup file extension is available for this calculator.');
            }
            const filename = `backup.${extension}`;
            const target = `/downloads/${filename}`;
            const result = isTigroup
                ? await dependencies.ccallAsync(module, 'calc_recv_tigroup', 'number', ['number', 'string', 'number'], [handle, target, backupChoice.mode], { timeoutMs: dependencies.PROGRESS_IDLE_TIMEOUT_MS, useProgress: true, progressLabel: 'Receiving backup (tigroup)' })
                : await dependencies.ccallAsync(module, 'calc_recv_backup', 'number', ['number', 'string'], [handle, target], { timeoutMs: dependencies.PROGRESS_IDLE_TIMEOUT_MS, useProgress: true, progressLabel: 'Receiving backup' });
            if (result !== 0) {
                dependencies.log(`Backup failed (${dependencies.formatErrorResult(module, result)}).`);
                return;
            }
            await dependencies.downloadLastReceived(module, filename);
            dependencies.log(isTigroup ? 'TIGroup backup received.' : 'Backup received.');
        } catch (err) {
            dependencies.logError(err, 'Receive backup failed');
        } finally {
            dependencies.setButtonLoading(dependencies.els.btnReceiveBackup, false);
        }
    }

    async function receiveOs() {
        if (dependencies.state?.activeFamily === 'sharp') { await dependencies.receiveSharpDump(false); return; }

        dependencies.setButtonLoading(dependencies.els.btnReceiveOs, true);
        try {
            if (!dependencies.isNspireActive()) {
                dependencies.log('OS receive is only supported on TI-Nspire calculators.');
                return;
            }
            await dependencies.authorizeDevice();
            const module = await dependencies.initModule();
            const handle = await dependencies.ensureHandle();
            if (!module.FS.analyzePath('/downloads').exists) {
                module.FS.mkdir('/downloads');
            }
            const notice = dependencies.t('confirm_receive_os_notice');
            if (!dependencies.confirm(notice)) {
                return;
            }
            dependencies.state.nspireOsReceiveStarted = true;
            dependencies.updateNspireOsButtons(true, (dependencies.state.features & dependencies.FEATURE_FLAGS.OPS_ROMDUMP) !== 0);
            const extension = dependencies.getFlashOsExtensionFromModule(module);
            const baseName = 'ti-nspire-os';
            const targetName = extension ? `${baseName}.${extension}` : 'ti-nspire-os.tnc';
            const target = `/downloads/${targetName}`;
            dependencies.state.partialOsPath = target;
            const result = await dependencies.ccallAsync(module, 'calc_recv_os', 'number', ['number', 'string'], [handle, target], { timeoutMs: null, useProgress: true, progressLabel: 'Receiving OS' });
            if (result !== 0) {
                dependencies.log(`OS receive failed (${dependencies.formatErrorResult(module, result)}).`);
                return;
            }
            await dependencies.downloadLastReceived(module, 'ti-nspire-os.tnc');
            dependencies.log('OS received as .tnc.');
        } catch (err) {
            dependencies.logError(err, 'Receive OS failed');
        } finally {
            dependencies.setButtonLoading(dependencies.els.btnReceiveOs, false);
        }
    }

    async function downloadPartialOs() {
        dependencies.setButtonLoading(dependencies.els.btnDownloadOsPartial, true);
        try {
            const module = await dependencies.initModule();
            const path = dependencies.state.partialOsPath || '/downloads/ti-nspire-os.tnc';
            if (!module.FS.analyzePath(path).exists) {
                dependencies.log('No partial OS file found yet.');
                return;
            }
            const data = module.FS.readFile(path);
            const name = path.split('/').pop() || 'ti-nspire-os.tnc';
            dependencies.triggerDownload(name, data);
            dependencies.log('Downloaded the current OS image.');
        } catch (err) {
            dependencies.logError(err, 'Download OS so far failed');
        } finally {
            dependencies.setButtonLoading(dependencies.els.btnDownloadOsPartial, false);
        }
    }

    async function dumpRom() {
        if (dependencies.state?.activeFamily === 'sharp') { await dependencies.receiveSharpDump(true); return; }

        dependencies.setButtonLoading(dependencies.els.btnDumpRom, true);
        const notice = dependencies.t('confirm_dump_rom_notice');
        if (!dependencies.confirm(notice)) {
            dependencies.setButtonLoading(dependencies.els.btnDumpRom, false);
            return;
        }

        try {
            await dependencies.authorizeDevice();
            const module = await dependencies.initModule();
            const handle = await dependencies.ensureHandle();
            if (!module.FS.analyzePath('/downloads').exists) {
                module.FS.mkdir('/downloads');
            }

            dependencies.log('Sending ROM dumper...');
            let result = await dependencies.ccallAsync(module, 'calc_dump_rom_1', 'number', ['number'], [handle], { timeoutMs: 30000, useProgress: true, progressLabel: 'Starting ROM dump' });
            if (result !== 0) {
                dependencies.log(`ROM dump step 1 failed (${dependencies.formatErrorResult(module, result)}).`);
                return;
            }

            dependencies.log('Receiving ROM image...');
            const target = '/downloads/romdump.bin';
            result = await dependencies.ccallAsync(module, 'calc_dump_rom_2', 'number', ['number', 'number', 'string'], [handle, 0, target], { timeoutMs: null, useProgress: true, progressLabel: 'Dumping ROM' });
            if (result !== 0) {
                dependencies.log(`ROM dump step 2 failed (${dependencies.formatErrorResult(module, result)}).`);
                return;
            }
            await dependencies.downloadLastReceived(module, (dependencies.state.authorizedDevice?.productName ?? 'ti-calculator') + '_dump.rom');
            dependencies.log('ROM dump completed.');
        } catch (err) {
            dependencies.logError(err, 'ROM dump failed');
        } finally {
            dependencies.setButtonLoading(dependencies.els.btnDumpRom, false);
        }
    }

    async function leaveExamMode() {
        dependencies.setButtonLoading(dependencies.els.btnLeaveExam, true);
        let treatDisconnectAsSuccess = false;
        try {
            await dependencies.authorizeDevice();
            const module = await dependencies.initModule();
            const handle = await dependencies.ensureHandle();
            treatDisconnectAsSuccess = dependencies.isNspireActive();
            const canLeaveExam = module.ccall('calc_leave_exam_mode_supported', 'number', [], []) !== 0;
            if (!canLeaveExam) {
                dependencies.log('Leave exam mode is not supported by this calculator.');
                return;
            }
            const result = await dependencies.ccallAsync(
                module,
                'calc_leave_exam_mode',
                'number',
                ['number'],
                [handle],
                { timeoutMs: dependencies.PROGRESS_IDLE_TIMEOUT_MS, useProgress: true, progressLabel: 'Leaving exam mode' }
            );
            if (result === null || result === undefined || Number.isNaN(Number(result))) {
                if (treatDisconnectAsSuccess) {
                    dependencies.log('Leave exam mode command sent (calculator reset/disconnect is expected).');
                    return;
                }
                dependencies.log('Leave exam mode failed (error (unknown)).');
                return;
            }
            if (result !== 0) {
                // On TI-Nspire, leaving exam mode can immediately reset/disconnect USB.
                // Treat any non-zero result as acceptable for this operation.
                if (treatDisconnectAsSuccess) {
                    dependencies.log('Leave exam mode command sent (calculator reset/disconnect is expected).');
                    return;
                }
                dependencies.log(`Leave exam mode failed (${dependencies.formatErrorResult(module, result)}).`);
                return;
            }
            dependencies.log('Leave exam mode command sent.');
        } catch (err) {
            if (treatDisconnectAsSuccess && dependencies.isAcceptableLeaveExamModeDiscError(err)) {
                dependencies.log('Leave exam mode command sent (calculator reset/disconnect is expected).');
                return;
            }
            dependencies.logError(err, 'Leave exam mode failed');
        } finally {
            dependencies.setButtonLoading(dependencies.els.btnLeaveExam, false);
        }
    }

    async function receiveSharpDump(includeBoot) {
        if (!dependencies.confirm(dependencies.t(includeBoot ? 'sharp_dump_rom_notice' : 'sharp_dump_system_notice'))) return;
        await dependencies.runSharpOperation(dependencies.t('sharp_dump'), async backend => {
            const result = await backend.receiveDump({ includeBoot });
            if (dependencies.state.sharpBackend !== backend) return;
            dependencies.saveSharpDownload(result, backend);
            dependencies.triggerDownload(result.filename + '.json', JSON.stringify(result.manifest, null, 2));
        });
    }

    return { getDirlistFolders, estimateBackupSize, isVarFileClass, receiveBackup, receiveOs, downloadPartialOs, dumpRom, leaveExamMode, receiveSharpDump };
}

module.exports = { createFeaturesBackup };
