'use strict';

/**
 * ui transfer-dialog. Browser and application dependencies are injected
 * by app.js; importing this module does not start the application.
 * @param {object} dependencies
 * @returns {object}
 */
function createUiTransferDialog(dependencies) {
    function openTransferModal(plan, options) {
        dependencies.els.transferTableBody.innerHTML = '';
        if (dependencies.els.transferOverwriteAll) {
            dependencies.els.transferOverwriteAll.checked = false;
        }
        const folders = options.folders || [];

        dependencies.document.querySelectorAll('.transfer-location').forEach(cell => {
            cell.classList.toggle('hidden', !options.hasArchive);
        });
        dependencies.document.querySelectorAll('.transfer-folder').forEach(cell => {
            cell.classList.toggle('hidden', !options.hasFolder);
        });
        dependencies.document.querySelectorAll('.transfer-select').forEach(cell => {
            cell.classList.toggle('hidden', false);
        });
        dependencies.document.querySelectorAll('.transfer-type').forEach(cell => {
            cell.classList.toggle('hidden', false);
        });
        dependencies.document.querySelectorAll('.transfer-size').forEach(cell => {
            cell.classList.toggle('hidden', false);
        });

        plan.forEach((item, index) => {
            const row = dependencies.document.createElement('tr');
            row.dataset.index = String(index);
            const entryLabel = item.entryCount > 1
                ? `${item.entryCount} entries`
                : (item.entryName || item.file.name);
            const typeLabel = item.entryTypeName
                || (!(["unknown","single","regular"].includes(item.fileClass)) ? item.fileClass : null)
                || (item.entryType != null ? `(type ${item.entryType})` : '-');
            const hasParsedSize = item.entrySize !== null && item.entrySize !== undefined && item.entrySize !== '';
            const parsedSize = hasParsedSize ? Number(item.entrySize) : NaN;
            const sizeLabel = Number.isFinite(parsedSize) && parsedSize >= 0 ? dependencies.formatBytes(parsedSize) : '-';
            const isVar = dependencies.isVarFileClass(item.fileClass);
            let locationCell = `<td class="transfer-location ${options.hasArchive ? '' : 'hidden'}">-</td>`;
            if (item.fileClass === "application") {
                locationCell = `<td class="transfer-location">Archive</td>`;
            } else if (options.hasArchive && isVar) {
                const mask = item.locationMask ?? 3;
                const locationValue = item.locationMode || item.defaultLocation;
                const allowRam = (mask & 1) !== 0;
                const allowArchive = (mask & 2) !== 0;
                if (mask !== 3) {
                    const label = mask === 2 ? 'Archive' : (mask === 1 ? 'RAM' : 'Auto');
                    const titleText = mask === 2
                        ? 'Archive-only variable type.'
                        : (mask === 1 ? 'RAM-only variable type.' : 'Mixed locations detected. Keeping file defaults.');
                    const titleAttr = titleText ? `title="${dependencies.escapeHtml(titleText)}"` : '';
                    locationCell = `<td class="transfer-location" ${titleAttr}>${dependencies.escapeHtml(label)}</td>`;
                } else {
                    let optionsHtml = '';
                    if (allowRam) {
                        optionsHtml += `<option value="ram" ${locationValue === 'ram' ? 'selected' : ''}>RAM</option>`;
                    }
                    if (allowArchive) {
                        optionsHtml += `<option value="archive" ${locationValue === 'archive' ? 'selected' : ''}>Archive</option>`;
                    }
                    locationCell = `<td class="transfer-location"><select class="form-input" data-field="location">${optionsHtml}</select></td>`;
                }
            }
            const folderOptions = ['<option value="">(root)</option>']
                .concat(folders.map(folder => `<option value="${dependencies.escapeHtml(folder)}">${dependencies.escapeHtml(folder)}</option>`))
                .join('');
            const folderCell = options.hasFolder && isVar
                ? `<td class="transfer-folder"><select class="form-input" data-field="folder">${folderOptions}</select></td>`
                : `<td class="transfer-folder ${options.hasFolder ? '' : 'hidden'}">-</td>`;
            const selectedAttr = item.selected === false ? '' : 'checked';
            const selectCell = `<td class="transfer-select"><input type="checkbox" data-field="select" ${selectedAttr}></td>`;
            row.innerHTML = `
                ${selectCell}
                <td>${dependencies.escapeHtml(item.file.name)}</td>
                <td>${dependencies.escapeHtml(entryLabel)}</td>
                <td class="transfer-size">${dependencies.escapeHtml(sizeLabel)}</td>
                <td class="transfer-type">${dependencies.escapeHtml(typeLabel)}</td>
                ${locationCell}
                ${folderCell}
            `;
            row.addEventListener('click', event => {
                const interactive = event.target?.closest?.('input, select, option, button, a, label, textarea');
                if (interactive) {
                    return;
                }
                const checkbox = row.querySelector('[data-field="select"]');
                if (!checkbox || checkbox.disabled) {
                    return;
                }
                checkbox.checked = !checkbox.checked;
            });
            dependencies.els.transferTableBody.appendChild(row);

            if (options.hasFolder) {
                const folderSelect = row.querySelector('[data-field="folder"]');
                if (folderSelect) {
                    folderSelect.value = item.entryFolder || '';
                }
            }
        });

        const hasBulkLocationTargets = plan.length > 1
            && options.hasArchive
            && plan.some(item => dependencies.isVarFileClass(item.fileClass) && (item.locationMask ?? 3) === 3);
        dependencies.els.transferBulkLocationActions?.classList.toggle('hidden', !hasBulkLocationTargets);

        dependencies.els.transferModal.classList.remove('hidden');

        return new Promise(resolve => {
            const setAllLocations = (location) => {
                dependencies.els.transferTableBody.querySelectorAll('select[data-field="location"]').forEach(select => {
                    if (Array.from(select.options).some(option => option.value === location)) {
                        select.value = location;
                    }
                });
            };
            const onAllRam = () => setAllLocations('ram');
            const onAllArchive = () => setAllLocations('archive');
            const cleanup = () => {
                dependencies.els.btnConfirmTransfer.removeEventListener('click', onConfirm);
                dependencies.els.btnCancelTransfer.removeEventListener('click', onCancel);
                dependencies.els.btnCloseTransfer.removeEventListener('click', onCancel);
                dependencies.els.btnTransferAllRam?.removeEventListener('click', onAllRam);
                dependencies.els.btnTransferAllArchive?.removeEventListener('click', onAllArchive);
            };
            const onCancel = () => {
                cleanup();
                dependencies.els.transferModal.classList.add('hidden');
                resolve(null);
            };
            const onConfirm = () => {
                const selections = [];
                let selectedCount = 0;
                plan.forEach((item, index) => {
                    const row = dependencies.els.transferTableBody.querySelector(`tr[data-index="${index}"]`);
                    if (!row) {
                        selections.push({ ...item });
                        selectedCount += 1;
                        return;
                    }
                    const checkbox = row.querySelector('[data-field="select"]');
                    if (checkbox && !checkbox.checked) {
                        return;
                    }
                    const locationSelect = row.querySelector('[data-field="location"]');
                    const location = options.hasArchive && locationSelect
                        ? (locationSelect.value || item.locationMode || item.defaultLocation)
                        : item.defaultLocation;
                    const folder = options.hasFolder
                        ? row.querySelector('[data-field="folder"]')?.value || ''
                        : item.entryFolder;
                    selections.push({
                        ...item,
                        targetLocation: location,
                        targetFolder: folder
                    });
                    selectedCount += 1;
                });
                if (selectedCount === 0) {
                    dependencies.alert(dependencies.t('alert_select_file_to_transfer'));
                    return;
                }
                cleanup();
                dependencies.els.transferModal.classList.add('hidden');
                resolve({
                    selections,
                    overwriteAll: Boolean(dependencies.els.transferOverwriteAll?.checked)
                });
            };
            dependencies.els.btnTransferAllRam?.addEventListener('click', onAllRam);
            dependencies.els.btnTransferAllArchive?.addEventListener('click', onAllArchive);
            dependencies.els.btnConfirmTransfer.addEventListener('click', onConfirm);
            dependencies.els.btnCancelTransfer.addEventListener('click', onCancel);
            dependencies.els.btnCloseTransfer.addEventListener('click', onCancel);
        });
    }

    function setBackupModalLoading(isLoading, message) {
        if (dependencies.els.backupModalOverlay) {
            dependencies.els.backupModalOverlay.classList.toggle('hidden', !isLoading);
        }
        if (dependencies.els.backupModalOverlayText && message) {
            dependencies.els.backupModalOverlayText.textContent = message;
        }
        if (dependencies.els.btnConfirmBackup) {
            dependencies.els.btnConfirmBackup.disabled = isLoading;
        }
        if (dependencies.els.backupFormatBackup) {
            dependencies.els.backupFormatBackup.disabled = isLoading;
        }
        if (dependencies.els.backupFormatTigroup) {
            const allowTigroup = dependencies.els.backupModal?.dataset.allowTigroup === '1';
            dependencies.els.backupFormatTigroup.disabled = isLoading || !allowTigroup;
        }
        if (dependencies.els.backupIncludeRam) {
            dependencies.els.backupIncludeRam.disabled = isLoading;
        }
        if (dependencies.els.backupIncludeArchive) {
            dependencies.els.backupIncludeArchive.disabled = isLoading;
        }
        if (dependencies.els.backupIncludeFlash) {
            dependencies.els.backupIncludeFlash.disabled = isLoading;
        }
    }

    function openBackupModal(options) {
        const allowTigroup = options?.allowTigroup ?? false;
        const defaultFormat = options?.defaultFormat || 'backup';
        const defaultMode = options?.defaultMode ?? (dependencies.TIG_MODE.RAM | dependencies.TIG_MODE.ARCHIVE | dependencies.TIG_MODE.FLASH);

        if (dependencies.els.backupModal) {
            dependencies.els.backupModal.dataset.allowTigroup = allowTigroup ? '1' : '0';
        }
        if (dependencies.els.backupFormatBackup) {
            dependencies.els.backupFormatBackup.checked = defaultFormat !== 'tigroup';
        }
        if (dependencies.els.backupFormatTigroup) {
            dependencies.els.backupFormatTigroup.checked = defaultFormat === 'tigroup';
            dependencies.els.backupFormatTigroup.disabled = !allowTigroup;
        }
        if (dependencies.els.tigroupOptions) {
            dependencies.els.tigroupOptions.classList.toggle('hidden', !allowTigroup || defaultFormat !== 'tigroup');
        }
        if (dependencies.els.backupIncludeRam) {
            dependencies.els.backupIncludeRam.checked = (defaultMode & dependencies.TIG_MODE.RAM) !== 0;
        }
        if (dependencies.els.backupIncludeArchive) {
            dependencies.els.backupIncludeArchive.checked = (defaultMode & dependencies.TIG_MODE.ARCHIVE) !== 0;
        }
        if (dependencies.els.backupIncludeFlash) {
            dependencies.els.backupIncludeFlash.checked = (defaultMode & dependencies.TIG_MODE.FLASH) !== 0;
        }

        const updateModeVisibility = () => {
            const isTigroup = dependencies.els.backupFormatTigroup?.checked && allowTigroup;
            if (dependencies.els.tigroupOptions) {
                dependencies.els.tigroupOptions.classList.toggle('hidden', !isTigroup);
            }
        };

        dependencies.els.backupModal.classList.remove('hidden');
        dependencies.setBackupModalLoading(false);

        return new Promise(resolve => {
            const cleanup = () => {
                dependencies.els.btnConfirmBackup.removeEventListener('click', onConfirm);
                dependencies.els.btnCancelBackup.removeEventListener('click', onCancel);
                dependencies.els.btnCloseBackup.removeEventListener('click', onCancel);
                dependencies.els.backupFormatBackup?.removeEventListener('change', updateModeVisibility);
                dependencies.els.backupFormatTigroup?.removeEventListener('change', updateModeVisibility);
            };
            const onCancel = () => {
                cleanup();
                dependencies.els.backupModal.classList.add('hidden');
                resolve(null);
            };
            const onConfirm = () => {
                const format = dependencies.els.backupFormatTigroup?.checked && allowTigroup ? 'tigroup' : 'backup';
                let mode = dependencies.TIG_MODE.RAM | dependencies.TIG_MODE.ARCHIVE | dependencies.TIG_MODE.FLASH;
                if (format === 'tigroup') {
                    mode = 0;
                    if (dependencies.els.backupIncludeRam?.checked) {
                        mode |= dependencies.TIG_MODE.RAM;
                    }
                    if (dependencies.els.backupIncludeArchive?.checked) {
                        mode |= dependencies.TIG_MODE.ARCHIVE;
                    }
                    if (dependencies.els.backupIncludeFlash?.checked) {
                        mode |= dependencies.TIG_MODE.FLASH;
                    }
                }
                cleanup();
                dependencies.els.backupModal.classList.add('hidden');
                resolve({ format, mode });
            };
            dependencies.els.btnConfirmBackup.addEventListener('click', onConfirm);
            dependencies.els.btnCancelBackup.addEventListener('click', onCancel);
            dependencies.els.btnCloseBackup.addEventListener('click', onCancel);
            dependencies.els.backupFormatBackup?.addEventListener('change', updateModeVisibility);
            dependencies.els.backupFormatTigroup?.addEventListener('change', updateModeVisibility);
        });
    }

    return { openTransferModal, setBackupModalLoading, openBackupModal };
}

module.exports = { createUiTransferDialog };
