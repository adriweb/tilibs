'use strict';

/**
 * ui selection. Browser and application dependencies are injected
 * by app.js; importing this module does not start the application.
 * @param {object} dependencies
 * @returns {object}
 */
function createUiSelection(dependencies) {
    function setSelectedFiles(files, sourceLabel) {
        dependencies.state.selectedFiles = Array.from(files || []);
        if (dependencies.els.fileInput) {
            if (dependencies.state.selectedFiles.length) {
                try {
                    const dataTransfer = new dependencies.DataTransfer();
                    dependencies.state.selectedFiles.forEach(file => dataTransfer.items.add(file));
                    dependencies.els.fileInput.files = dataTransfer.files;
                } catch {
                    // Some browsers disallow programmatic file assignment.
                }
            } else {
                dependencies.els.fileInput.value = '';
            }
        }
        if (dependencies.state.selectedFiles.length) {
            const suffix = sourceLabel ? ` from ${sourceLabel}` : '';
            dependencies.log(`Loaded ${dependencies.state.selectedFiles.length} file(s)${suffix}.`);
        }
        dependencies.updateSendFilesButtonState();
        if (dependencies.state.selectedFiles.length && (sourceLabel === 'drop' || sourceLabel === 'file picker')) {
            dependencies.sendSelectedFiles();
        }
    }

    function updateSendFilesButtonState() {
        if (!dependencies.els.btnSendFiles) {
            return;
        }
        const hasFiles = dependencies.state.selectedFiles.length || (dependencies.els.fileInput && dependencies.els.fileInput.files && dependencies.els.fileInput.files.length);
        const available = (!dependencies.isCasioActive() || dependencies.state.casioStorageSupported)
            && (!dependencies.isHPLegacyActive() || dependencies.state.hpLegacyKermitEnabled);
        dependencies.els.btnSendFiles.disabled = !hasFiles || !available;
        dependencies.els.btnSendFiles.classList.toggle('primary', !!hasFiles && available);
        dependencies.els.btnSendFiles.classList.toggle('subtle', !hasFiles || !available);
        dependencies.els.btnSendFiles.classList.toggle('send-idle', !hasFiles || !available);
    }

    function updateSelectionActionButtons() {
        dependencies.syncVisibleSelection();
        const actions = dependencies.deriveSelectionActions(dependencies.getSelectedFileEntries(), dependencies.getActiveBackendCapabilities());
        if (dependencies.els.btnRecvSelected) {
            dependencies.els.btnRecvSelected.disabled = !actions.receive;
            dependencies.els.btnRecvSelected.classList.toggle('disabled', !actions.receive);
        }
        if (dependencies.els.btnDeleteSelected) {
            dependencies.els.btnDeleteSelected.disabled = !actions.remove;
            dependencies.els.btnDeleteSelected.classList.toggle('disabled', !actions.remove);
        }
        if (dependencies.els.selectAllVars) {
            const allInputs = Array.from(dependencies.els.varTableBody.querySelectorAll('input[type="checkbox"]:not(:disabled)'));
            if (!allInputs.length) {
                dependencies.els.selectAllVars.checked = false;
                dependencies.els.selectAllVars.indeterminate = false;
            } else {
                const checkedCount = allInputs.filter(input => input.checked).length;
                dependencies.els.selectAllVars.checked = checkedCount === allInputs.length;
                dependencies.els.selectAllVars.indeterminate = checkedCount > 0 && checkedCount < allInputs.length;
            }
        }
    }

    function getSelectedVarInputs() {
        return Array.from(dependencies.els.varTableBody.querySelectorAll('input[type="checkbox"]:checked'));
    }

    function buildSelectionKey(input) {
        return input.dataset.entryId || '';
    }

    function getSelectedVarKeys() {
        return new Set(dependencies.getFileModel().selectedIds);
    }

    function applySelectionKeys(keys, container) {
        if (!keys || !container) return;
        container.querySelectorAll('input[type="checkbox"]').forEach(input => {
            if (input.disabled) return;
            input.checked = keys.has(dependencies.buildSelectionKey(input));
            input.closest('tr')?.classList.toggle('is-active', input.checked);
        });
    }

    function buildEntryFromCheckbox(checkbox) {
        return dependencies.getFileModel().entriesById.get(checkbox.dataset.entryId);
    }

    function getFileModel() {
        if (!dependencies.state.fileModel) dependencies.state.fileModel = dependencies.createFileModel();
        return dependencies.state.fileModel;
    }

    function syncVisibleSelection() {
        const model = dependencies.getFileModel();
        dependencies.els.varTableBody.querySelectorAll('input[type="checkbox"]').forEach(input => {
            if (!input.disabled) model.select(input.dataset.entryId, input.checked);
        });
    }

    function getSelectedFileEntries() {
        dependencies.syncVisibleSelection();
        return dependencies.getSelectedVarInputs().map(dependencies.buildEntryFromCheckbox).filter(Boolean);
    }

    return { getSelectedFileEntries, setSelectedFiles, updateSendFilesButtonState, updateSelectionActionButtons, getSelectedVarInputs, buildSelectionKey, getSelectedVarKeys, applySelectionKeys, buildEntryFromCheckbox, getFileModel, syncVisibleSelection };
}

module.exports = { createUiSelection };
