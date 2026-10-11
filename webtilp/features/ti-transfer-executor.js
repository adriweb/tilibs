'use strict';

/**
 * features ti-transfer-executor. Browser and application dependencies are injected
 * by app.js; importing this module does not start the application.
 * @param {object} dependencies
 * @returns {object}
 */
function createFeaturesTiTransferExecutor(dependencies) {
    async function performTransfers(plan, module, options) {
        const operationGeneration = dependencies.session.capture();
        const handle = await dependencies.session.wait(dependencies.ensureCableOpen(), operationGeneration);
        const model = dependencies.getActiveCalcModelId();
        const needsEot = model === 2 || model === 6; // TI-82 / TI-85
        let pendingEot = false;
        const finishVarSend = async () => {
            if (!pendingEot) return;
            pendingEot = false;
            const result = await dependencies.session.wait(dependencies.ccallAsync(module, 'finish_var_send', 'number', ['number'], [handle],
                { timeoutMs: 60000, useProgress: true, progressLabel: 'Finishing transfer' }), operationGeneration);
            if (result !== 0) {
                throw new Error(`Failed to finish transfer: ${dependencies.formatErrorResult(module, result)}`);
            }
        };
        let successCount = 0;
        const configuredCableTimeout = Number(dependencies.state.settings?.cableTimeout);
        const originalCableTimeout = Number.isFinite(configuredCableTimeout) && configuredCableTimeout > 0
            ? configuredCableTimeout
            : 50;
        const archiveEntryTimeout = 250; // 25.0s (setting unit is 1/10s)
        const osEntryTimeout = 600; // 60s; can take a while sometimes

        for (const item of plan) {
            if (!item.path) {
                continue;
            }
            try {
                const isVar = dependencies.isVarFileClass(item.fileClass);
                const displayName = item.entryName ? `${item.file.name} (${item.entryName})` : item.file.name;
                if (!dependencies.confirmEvoOsModelMismatch(item, module)) {
                    dependencies.log(`Skipped ${item.file.name}, because the cross-model OS transfer was declined.`);
                    continue;
                }
                let targetName = item.entryName || '';
                const targetFolder = options.hasFolder ? (item.targetFolder || item.entryFolder || '') : '';
                const folderOverride = options.hasFolder && isVar && item.targetFolder && item.targetFolder !== item.entryFolder
                    ? item.targetFolder
                    : '';
                const locationMask = item.locationMask ?? 3;
                const selectionLocation = item.targetLocation || item.locationMode || item.defaultLocation;
                const canOverrideLocation = options.hasArchive && isVar && locationMask === 3;
                const requestedLocation = canOverrideLocation ? selectionLocation : 'auto';
                let targetLocation = selectionLocation;
                if (!canOverrideLocation) {
                    if (locationMask === 2) {
                        targetLocation = 'archive';
                    } else if (locationMask === 1) {
                        targetLocation = 'ram';
                    } else if (requestedLocation === 'auto') {
                        targetLocation = item.entryAttr === 3 ? 'archive' : 'ram';
                    }
                }

                let existing = null;
                if (isVar && dependencies.state.dirlist.length && targetName && item.entryType != null) {
                    existing = dependencies.findDirlistMatch(targetName, item.entryType, targetFolder, targetLocation);
                    if (existing) {
                        const overwrite = options.overwriteAll
                            ? true
                            : dependencies.confirm(dependencies.tFormat('confirm_overwrite_existing', { name: targetName }));
                        if (!overwrite) {
                            dependencies.log(`Skipped ${item.file.name}, because overwriting was declined.`);
                            continue;
                        }
                        if (existing.attr !== 0 && dependencies.hasSilverlinkConnected()) {
                            const msg = dependencies.tFormat('alert_cannot_overwrite_locked', { name: targetName });
                            dependencies.log(msg);
                            dependencies.alert(msg);
                            continue;
                        }
                        if (dependencies.isTI89TActive()) {
                            if (existing.attr !== 0) {
                                const clearAttrResult = await dependencies.session.wait(dependencies.ccallAsync(
                                    module,
                                    'calc_change_attr',
                                    'number',
                                    ['number', 'string', 'string', 'number', 'number'],
                                    [handle, targetFolder, targetName, item.entryType, 0],
                                    { timeoutMs: dependencies.PROGRESS_IDLE_TIMEOUT_MS, useProgress: true, progressLabel: `Updating ${targetName}` }
                                ), operationGeneration);
                                if (clearAttrResult !== 0) {
                                    const msg = dependencies.tFormat('alert_failed_clear_attributes', {
                                        name: targetName,
                                        error: dependencies.formatErrorResult(module, clearAttrResult)
                                    });
                                    dependencies.log(msg);
                                    dependencies.alert(msg);
                                    continue;
                                }
                            }
                            const deleteResult = await dependencies.session.wait(dependencies.ccallAsync(
                                module,
                                'calc_del_var',
                                'number',
                                ['number', 'string', 'string', 'number'],
                                [handle, targetFolder, targetName, item.entryType],
                                { timeoutMs: dependencies.PROGRESS_IDLE_TIMEOUT_MS, useProgress: true, progressLabel: `Deleting ${targetName}` }
                            ), operationGeneration);
                            if (deleteResult !== 0) {
                                const deleteRaw = module ? module._get_raw_protocol_code(deleteResult) : 0;
                                let msg = '';
                                if (deleteRaw === 0x0021) {
                                    msg = dependencies.tFormat('alert_cannot_overwrite_locked', { name: targetName });
                                } else {
                                    msg = dependencies.tFormat('alert_failed_delete_existing', {
                                        name: targetName,
                                        error: dependencies.formatErrorResult(module, deleteResult)
                                    });
                                }
                                dependencies.log(msg);
                                dependencies.alert(msg);
                                continue;
                            }
                            dependencies.state.dirlist = dependencies.state.dirlist.filter(entry => entry !== existing);
                            existing = null;
                        }
                    }
                }

                let locationCode = -1;
                if (isVar && locationMask === 1) {
                    locationCode = 0;
                } else if (isVar && locationMask === 2) {
                    locationCode = 1;
                } else if (canOverrideLocation && selectionLocation !== item.defaultLocation) {
                    locationCode = selectionLocation === 'archive' ? 1 : 0;
                }
                const isArchiveOrFlashTransfer = item.fileClass === 'application'
                    || item.fileClass === 'flash'
                    || item.fileClass === 'os'
                    || (isVar && targetLocation === 'archive');
                const entryCableTimeout = item.fileClass === 'os'
                    ? Math.max(originalCableTimeout, osEntryTimeout)
                    : isArchiveOrFlashTransfer
                    ? Math.max(originalCableTimeout, archiveEntryTimeout)
                    : originalCableTimeout;

                let timeoutAdjusted = false;
                if (module && entryCableTimeout !== originalCableTimeout) {
                    try {
                        module._set_cable_timeout(entryCableTimeout);
                        timeoutAdjusted = true;
                    } catch (err) {
            if (err?.staleSession) throw err;
                        dependencies.console.warn('[WebTILP] Failed to set temporary cable timeout for archive/flash transfer', err);
                    }
                }

                let result = 0;
                try {
                    const deferEot = needsEot && isVar;
                    if (!deferEot) await dependencies.session.wait(finishVarSend(), operationGeneration);
                    // A failed send may leave the protocol out of sync. Only
                    // finalize after a successful data exchange, never after abort.
                    pendingEot = false;
                    dependencies.clearNativeWarnings();
                    if (item.sendByEntry && Number.isInteger(item.entryIndex)) {
                        result = await dependencies.session.wait(dependencies.ccallAsync(
                            module,
                            'send_file_entry_custom',
                            'number',
                            ['number', 'string', 'number', 'number', 'string', 'number', 'number'],
                            [handle, item.path, item.entryIndex, item.containerKind || 0, folderOverride, locationCode, Number(deferEot)],
                            { timeoutMs: 60000, useProgress: true, progressLabel: `Sending ${displayName}` }
                        ), operationGeneration);
                    } else {
                        result = await dependencies.session.wait(dependencies.ccallAsync(
                            module,
                            'send_file_custom',
                            'number',
                            ['number', 'string', 'string', 'number', 'number'],
                            [handle, item.path, folderOverride, locationCode, Number(deferEot)],
                            { timeoutMs: 60000, useProgress: true, progressLabel: `Sending ${displayName}` }
                        ), operationGeneration);
                    }
                    pendingEot = deferEot && result === 0;
                } finally {
                    if (timeoutAdjusted) {
                        try {
                            module._set_cable_timeout(originalCableTimeout);
                        } catch (err) {
            if (err?.staleSession) throw err;
                            dependencies.console.warn('[WebTILP] Failed to restore cable timeout after archive/flash transfer', err);
                        }
                    }
                }

                if (result === 0) {
                    dependencies.log(`Sent ${displayName} successfully.`);
                    successCount += 1;
                    if (isVar && targetName && item.entryType != null) {
                        dependencies.state.dirlist.push({
                            name: targetName,
                            type: item.entryType,
                            folder: targetFolder,
                            attr: targetLocation === 'archive' ? 3 : (targetLocation === 'ram' ? 0 : item.entryAttr),
                            kind: 'var',
                            is_folder: 0,
                            size: item.entries?.[0]?.size ?? item.file.size
                        });
                    }
                } else {
                    if (needsEot) {
                        throw new Error(`Failed to send ${displayName}: ${dependencies.formatErrorResult(module, result)}.${dependencies.getNativeWarningSuffix(result)}`);
                    }
                    dependencies.log(`Failed to send ${displayName}: ${dependencies.formatErrorResult(module, result)}.${dependencies.getNativeWarningSuffix(result)}`);
                }
            } catch (err) {
            if (err?.staleSession) throw err;
                if (err?.silent || needsEot) {
                    throw err;
                }
                const label = item?.entryName ? `${item.file?.name || 'file'} (${item.entryName})` : (item.file?.name || 'file');
                dependencies.log(`Failed to send ${label}: ${err?.message || 'unknown error'}.${dependencies.getNativeWarningSuffix()}`);
            }
        }
        // Close even when trailing entries were skipped (e.g. overwrite declined).
        // Do not report a successful batch until the calculator acknowledges EOT.
        await dependencies.session.wait(finishVarSend(), operationGeneration);
        return { successCount };
    }

    return { performTransfers };
}

module.exports = { createFeaturesTiTransferExecutor };
