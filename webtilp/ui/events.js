'use strict';

/**
 * ui events. Browser and application dependencies are injected
 * by app.js; importing this module does not start the application.
 * @param {object} dependencies
 * @returns {object}
 */
function createUiEvents(dependencies) {
    function bindEvents() {
        dependencies.els.btnConnect.addEventListener('click', dependencies.connect);
        if (dependencies.els.btnNuke) {
            dependencies.els.btnNuke.addEventListener('click', dependencies.nukeConnection);
        }
        dependencies.els.btnSettings.addEventListener('click', dependencies.openSettingsModal);
        dependencies.els.btnCloseSettings.addEventListener('click', dependencies.closeSettingsModal);
        if (dependencies.els.btnNewFolder) {
            dependencies.els.btnNewFolder.addEventListener('click', dependencies.openNewFolderModal);
        }
        if (dependencies.els.btnCloseNewFolder) {
            dependencies.els.btnCloseNewFolder.addEventListener('click', dependencies.closeNewFolderModal);
        }
        if (dependencies.els.btnCancelNewFolder) {
            dependencies.els.btnCancelNewFolder.addEventListener('click', dependencies.closeNewFolderModal);
        }
        if (dependencies.els.btnCreateNewFolder) {
            dependencies.els.btnCreateNewFolder.addEventListener('click', dependencies.createNewFolder);
        }
        if (dependencies.els.newFolderName) {
            dependencies.els.newFolderName.addEventListener('keydown', event => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    dependencies.createNewFolder();
                }
            });
        }
        dependencies.els.btnSaveSettings.addEventListener('click', dependencies.saveSettingsFromModal);
        dependencies.els.btnResetSettings.addEventListener('click', dependencies.resetSettings);
        dependencies.els.settingCableModel.addEventListener('change', () => {
            const selected = dependencies.els.settingCalcModel.value;
            const options = dependencies.getCalcOptionsForCable(dependencies.els.settingCableModel.value);
            dependencies.populateSelect(dependencies.els.settingCalcModel, options);
            dependencies.updateCalcHint(dependencies.els.settingCableModel.value);
            if (options.some(option => String(option.value) === selected)) {
                dependencies.els.settingCalcModel.value = selected;
            } else {
                dependencies.els.settingCalcModel.value = options.find(option => option.value !== 'auto')?.value ?? 'auto';
            }
            dependencies.updateSourceConversionSettingAvailability();
        });
        dependencies.els.settingCalcModel.addEventListener('change', dependencies.updateSourceConversionSettingAvailability);
        dependencies.els.settingsModal.addEventListener('click', event => {
            if (event.target === dependencies.els.settingsModal) {
                dependencies.closeSettingsModal();
            }
        });
        dependencies.els.btnClosePreview?.addEventListener('click', dependencies.closePreviewModal);
        dependencies.els.btnDownloadPreview?.addEventListener('click', dependencies.downloadPreviewFile);
        dependencies.els.btnDownloadPreviewEvo?.addEventListener('click', () => dependencies.downloadTIBasicPreview('84Evo'));
        dependencies.els.btnDownloadPreviewLegacy?.addEventListener('click', () => dependencies.downloadTIBasicPreview('84+CE'));
        dependencies.els.btnDismissPreview?.addEventListener('click', dependencies.closePreviewModal);
        dependencies.els.previewReindent?.addEventListener('change', dependencies.refreshPreviewReindent);
        dependencies.els.previewModal?.addEventListener('click', event => {
            if (event.target === dependencies.els.previewModal) {
                dependencies.closePreviewModal();
            }
        });
        if (dependencies.els.btnCloseConnectionHelp) {
            dependencies.els.btnCloseConnectionHelp.addEventListener('click', dependencies.closeConnectionHelpModal);
        }
        if (dependencies.els.newFolderModal) {
            dependencies.els.newFolderModal.addEventListener('click', event => {
                if (event.target === dependencies.els.newFolderModal) {
                    dependencies.closeNewFolderModal();
                }
            });
        }
        if (dependencies.els.connectionHelpModal) {
            dependencies.els.connectionHelpModal.addEventListener('click', event => {
                if (event.target === dependencies.els.connectionHelpModal) {
                    dependencies.closeConnectionHelpModal();
                }
            });
        }
        dependencies.els.btnIsReady.addEventListener('click', dependencies.isReady);
        dependencies.els.btnGetInfo.addEventListener('click', dependencies.getDeviceInfo);
        dependencies.els.btnSyncClock.addEventListener('click', dependencies.syncClock);
        dependencies.els.btnRefreshDirlist.addEventListener('click', () => dependencies.refreshDirlist({ manual: true }));
        dependencies.els.btnBackupDirlist?.addEventListener('click', () => dependencies.refreshDirlist({ manual: true }));
        dependencies.els.btnSendFiles.addEventListener('click', dependencies.sendSelectedFiles);
        dependencies.els.btnReceiveBackup.addEventListener('click', dependencies.receiveBackup);
        dependencies.els.btnReceiveOs.addEventListener('click', dependencies.receiveOs);
        dependencies.els.btnDownloadOsPartial.addEventListener('click', dependencies.downloadPartialOs);
        dependencies.els.btnDumpRom.addEventListener('click', dependencies.dumpRom);
        if (dependencies.els.btnLeaveExam) {
            dependencies.els.btnLeaveExam.addEventListener('click', dependencies.leaveExamMode);
        }
        dependencies.els.btnRecvSelected.addEventListener('click', dependencies.receiveSelected);
        dependencies.els.btnDeleteSelected.addEventListener('click', dependencies.deleteSelected);
        dependencies.els.btnScreenshot.addEventListener('click', dependencies.takeScreenshot);
        dependencies.els.btnDownloadScreenshot.addEventListener('click', dependencies.downloadCanvas);
        dependencies.els.btnClearLog.addEventListener('click', dependencies.clearLog);
        if (dependencies.els.btnSendKey) {
            dependencies.els.btnSendKey.addEventListener('click', () => dependencies.sendKey(dependencies.els.keyCodeInput?.value));
        }
        if (dependencies.els.keyCodeInput) {
            dependencies.els.keyCodeInput.addEventListener('keydown', event => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    dependencies.sendKey(dependencies.els.keyCodeInput.value);
                }
            });
        }
        dependencies.document.querySelectorAll('.key-quick').forEach(button => {
            button.addEventListener('click', () => dependencies.sendKey(button.dataset.key));
        });
        if (dependencies.els.btnThemeToggle) {
            dependencies.els.btnThemeToggle.addEventListener('click', dependencies.cycleTheme);
        }
        if (dependencies.els.btnClearOfflineCache) {
            dependencies.els.btnClearOfflineCache.addEventListener('click', () => {
                dependencies.clearOfflineCache().catch(() => {
                    dependencies.log('Failed to clear offline cache.');
                });
            });
        }
        if (dependencies.els.btnReloadOffline) {
            dependencies.els.btnReloadOffline.addEventListener('click', async () => {
                try {
                    const regs = await dependencies.navigator.serviceWorker?.getRegistrations?.() || [];
                    const reg = regs.find(item => item.active);
                    if (reg?.waiting) {
                        reg.waiting.postMessage({ type: 'SKIP_WAITING' });
                        await new Promise(resolve => {
                            dependencies.navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
                        });
                    }
                } catch {
                    // ignore
                }
                dependencies.window.location.reload();
            });
        }
        if (dependencies.els.btnSplashConnect) {
            dependencies.els.btnSplashConnect.addEventListener('click', dependencies.connect);
        }
        if (dependencies.els.selectAllVars) {
            dependencies.els.selectAllVars.addEventListener('change', () => {
                const checkboxes = Array.from(dependencies.els.varTableBody.querySelectorAll('input[type="checkbox"]:not(:disabled)'));
                checkboxes.forEach(input => {
                    input.checked = dependencies.els.selectAllVars.checked;
                    const row = input.closest('tr');
                    if (row) {
                        row.classList.toggle('is-active', input.checked);
                    }
                });
                dependencies.state.lastCheckedIndex = null;
                dependencies.updateSelectionActionButtons();
            });
        }
        dependencies.els.filterInput.addEventListener('input', () => dependencies.renderDirlist(dependencies.state.dirlist));
        dependencies.document.querySelectorAll('th[data-sort]').forEach(header => {
            header.addEventListener('click', () => {
                const key = header.dataset.sort;
                if (dependencies.state.sort.key === key) {
                    dependencies.state.sort.dir = dependencies.state.sort.dir === 'asc' ? 'desc' : 'asc';
                } else {
                    dependencies.state.sort.key = key;
                    dependencies.state.sort.dir = 'asc';
                }
                dependencies.state.sort.userDefined = true;
                dependencies.document.querySelectorAll('th[data-sort]').forEach(th => th.classList.remove('sorted-asc', 'sorted-desc'));
                header.classList.add(dependencies.state.sort.dir === 'asc' ? 'sorted-asc' : 'sorted-desc');
                dependencies.renderDirlist(dependencies.state.dirlist);
            });
        });
        dependencies.els.fileInput.addEventListener('change', () => {
            dependencies.setSelectedFiles(dependencies.els.fileInput.files, 'file picker');
        });
        dependencies.els.fileInput.addEventListener('click', dependencies.updateFileInputAccept);
        const hpAppFolderInput = dependencies.document.getElementById('hpAppFolderInput');
        dependencies.document.getElementById('btnChooseHPAppFolder').addEventListener('click', () => hpAppFolderInput.click());
        hpAppFolderInput.addEventListener('change', async () => {
            try {
                const files = await dependencies.getHPPrimePickedDirectory(hpAppFolderInput.files);
                dependencies.setSelectedFiles(files, 'file picker');
            } catch (error) {
                dependencies.logError(error);
            } finally {
                hpAppFolderInput.value = '';
            }
        });
        const dropzone = dependencies.document.getElementById('dropzone');
        const dropzoneDragEnter = (event) => {
            if (dependencies.hasFileDrag(event)) {
                event.preventDefault();
                dependencies.setDropzoneActive(true);
            }
        };
        const dropzoneDragOver = (event) => {
            if (dependencies.hasFileDrag(event)) {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
                dependencies.setDropzoneActive(true);
            }
        };
        const dropzoneDragLeave = (event) => {
            if (dropzone && event.relatedTarget && dropzone.contains(event.relatedTarget)) {
                return;
            }
            dependencies.setDropzoneActive(false);
        };
        const dropzoneDrop = async (event) => {
            event.preventDefault();
            event.stopPropagation();
            const now = Date.now();
            if (now - dependencies.lastDropTs < 200) {
                return;
            }
            dependencies.lastDropTs = now;
            dependencies.setDropzoneActive(false);
            try {
                const files = await dependencies.getDroppedTransferFiles(event);
                if (files.length) dependencies.setSelectedFiles(files, 'drop');
            } catch (error) {
                dependencies.logError(error);
            }
        };
        dropzone.addEventListener('dragenter', dropzoneDragEnter);
        dropzone.addEventListener('dragover', dropzoneDragOver);
        dropzone.addEventListener('dragleave', dropzoneDragLeave);
        dropzone.addEventListener('drop', dropzoneDrop);
        dependencies.els.fileInput.addEventListener('dragenter', dropzoneDragEnter);
        dependencies.els.fileInput.addEventListener('dragover', dropzoneDragOver);
        dependencies.els.fileInput.addEventListener('dragleave', dropzoneDragLeave);
        dependencies.els.fileInput.addEventListener('drop', dropzoneDrop);
        dependencies.els.varTableBody.addEventListener('click', async event => {
            const toggleButton = event.target.closest('.folder-toggle, .folder-icon');
            if (toggleButton) {
                const folderPath = toggleButton.dataset.folderPath || '';
                if (folderPath) {
                    if (dependencies.state.expandedFolders.has(folderPath)) {
                        dependencies.state.expandedFolders.delete(folderPath);
                    } else {
                        dependencies.state.expandedFolders.add(folderPath);
                    }
                    dependencies.renderDirlist(dependencies.state.dirlist);
                }
                return;
            }
            const actionButton = event.target.closest('button.action-preview, button.action-rename, button.action-delete, button.action-download');
            if (actionButton) {
                const row = actionButton.closest('tr');
                const checkbox = row ? row.querySelector('input[type=\"checkbox\"]') : null;
                if (!checkbox) {
                    return;
                }
                if (row) {
                    row.classList.add('is-active');
                }
                const entry = dependencies.buildEntryFromCheckbox(checkbox);
                try {
                    if (actionButton.classList.contains('action-preview')) {
                        await dependencies.previewEntry(entry, actionButton);
                    } else if (actionButton.classList.contains('action-rename')) {
                        await dependencies.renameEntry(entry);
                    } else if (actionButton.classList.contains('action-download')) {
                        await dependencies.downloadEntry(entry);
                    } else {
                        await dependencies.deleteEntry(entry);
                    }
                } finally {
                    row?.classList.remove('is-active');
                }
                return;
            }
            const toggleFolderSelection = (source) => {
                if (source.dataset.isFolder !== '1') {
                    return;
                }
                const folderPath = dependencies.normalizeFolderPath(source.dataset.folderPath || '');
                if (!folderPath) {
                    return;
                }
                const allCheckboxes = Array.from(dependencies.els.varTableBody.querySelectorAll('input[type="checkbox"]:not(:disabled)'));
                allCheckboxes.forEach(input => {
                    const row = input.closest('tr');
                    const rowPath = dependencies.normalizeFolderPath(row?.dataset.folderPath || input.dataset.folderPath || '');
                    if (!rowPath) {
                        return;
                    }
                    if (rowPath === folderPath || rowPath.startsWith(`${folderPath}/`)) {
                        input.checked = source.checked;
                        if (row) {
                            row.classList.toggle('is-active', input.checked);
                        }
                    }
                });
            };
            const checkbox = event.target.closest('input[type="checkbox"]');
            if (checkbox) {
                if (event.shiftKey) {
                    const checkboxes = Array.from(dependencies.els.varTableBody.querySelectorAll('input[type="checkbox"]:not(:disabled)'));
                    const currentIndex = checkboxes.indexOf(checkbox);
                    if (currentIndex !== -1 && dependencies.state.lastCheckedIndex != null) {
                        const [start, end] = currentIndex > dependencies.state.lastCheckedIndex
                            ? [dependencies.state.lastCheckedIndex, currentIndex]
                            : [currentIndex, dependencies.state.lastCheckedIndex];
                        for (let i = start; i <= end; i++) {
                            checkboxes[i].checked = checkbox.checked;
                            const row = checkboxes[i].closest('tr');
                            if (row) {
                                row.classList.toggle('is-active', checkboxes[i].checked);
                            }
                        }
                    }
                }
                toggleFolderSelection(checkbox);
                const allCheckboxes = Array.from(dependencies.els.varTableBody.querySelectorAll('input[type="checkbox"]:not(:disabled)'));
                dependencies.state.lastCheckedIndex = allCheckboxes.indexOf(checkbox);
                dependencies.updateSelectionActionButtons();
                return;
            }
            const row = event.target.closest('tr');
            if (!row) {
                return;
            }
            row.classList.add('is-active');
            const target = row.querySelector('input[type="checkbox"]');
            if (!target || target.disabled) {
                return;
            }
            target.checked = !target.checked;
            toggleFolderSelection(target);
            const allCheckboxes = Array.from(dependencies.els.varTableBody.querySelectorAll('input[type="checkbox"]:not(:disabled)'));
            dependencies.state.lastCheckedIndex = allCheckboxes.indexOf(target);
            dependencies.updateSelectionActionButtons();
        });
        dependencies.els.varTableBody.addEventListener('change', event => {
            if (event.target && event.target.matches('input[type="checkbox"]')) {
                const row = event.target.closest('tr');
                if (row) {
                    row.classList.toggle('is-active', event.target.checked);
                }
                dependencies.updateSelectionActionButtons();
            }
        });
        if (dependencies.els.tableView) {
            dependencies.els.tableView.addEventListener('scroll', () => {
                dependencies.scheduleStickyUpdate();
            });
        }
        dependencies.window.addEventListener('resize', () => {
            dependencies.scheduleStickyUpdate();
        });
        dependencies.els.tableView.addEventListener('dragenter', event => {
            if (event.dataTransfer && event.dataTransfer.types.includes('Files')) {
                event.preventDefault();
            }
        });
        dependencies.els.tableView.addEventListener('dragover', event => {
            if (event.dataTransfer && event.dataTransfer.types.includes('Files')) {
                event.preventDefault();
                const row = event.target.closest('tr');
                if (row && row.dataset && row.dataset.folderPath) {
                    let folderRow = null;
                    if (row.dataset.isFolder === '1') {
                        folderRow = row;
                    } else {
                        folderRow = Array.from(dependencies.els.varTableBody.querySelectorAll('tr[data-is-folder="1"]'))
                            .find(candidate => candidate.dataset.folderPath === row.dataset.folderPath);
                    }
                    dependencies.setDropHighlight(folderRow || row);
                } else {
                    dependencies.setDropHighlight(row);
                }
            }
        });
        dependencies.els.tableView.addEventListener('dragleave', () => {
            dependencies.clearDropHighlight();
        });
        dependencies.els.tableView.addEventListener('drop', async event => {
            event.preventDefault();
            event.stopPropagation();
            dependencies.clearDropHighlight();
            const folderNode = event.target.closest('[data-folder-path]');
            const row = event.target.closest('tr');
            const folder = folderNode
                ? (folderNode.dataset.folderPath || '')
                : (row ? (row.dataset.folderTarget || '') : '');
            try {
                const files = await dependencies.getDroppedTransferFiles(event);
                if (files.length) await dependencies.sendDroppedFiles(files, folder);
            } catch (error) {
                dependencies.logError(error);
            }
        });
        dependencies.document.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                if (dependencies.els.previewModal && !dependencies.els.previewModal.classList.contains('hidden')) {
                    dependencies.closePreviewModal();
                    return;
                }
                if (dependencies.els.settingsModal && !dependencies.els.settingsModal.classList.contains('hidden')) {
                    dependencies.closeSettingsModal();
                    return;
                }
                if (dependencies.els.newFolderModal && !dependencies.els.newFolderModal.classList.contains('hidden')) {
                    dependencies.closeNewFolderModal();
                }
            }
        });
    }

    return { bindEvents };
}

module.exports = { createUiEvents };
