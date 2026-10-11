'use strict';

/**
 * features ti-transfer-policy. Browser and application dependencies are injected
 * by app.js; importing this module does not start the application.
 * @param {object} dependencies
 * @returns {object}
 */
function createFeaturesTiTransferPolicy(dependencies) {
    function getEvoOsModelFromExtension(extension) {
        return dependencies.EVO_OS_MODEL_BY_EXTENSION.get(String(extension || '').toLowerCase()) || null;
    }

    function getEvoOsModelFromFileName(fileName) {
        const match = String(fileName || '').match(/\.([^.]+)$/);
        return dependencies.getEvoOsModelFromExtension(match?.[1]);
    }

    function confirmEvoOsModelMismatch(item, module) {
        if (item?.fileClass !== 'os') {
            return true;
        }
        const sourceModel = dependencies.getEvoOsModelFromFileName(item.file?.name);
        const targetModel = dependencies.getEvoOsModelFromExtension(dependencies.getFlashOsExtensionFromModule(module));
        if (!sourceModel || !targetModel || sourceModel === targetModel) {
            return true;
        }
        return dependencies.confirm(dependencies.tFormat('confirm_cross_model_evo_os', {
            file: item.file?.name || 'OS file',
            source: sourceModel,
            target: targetModel
        }));
    }

    function normalizeFolderPath(folder) {
        return String(folder || '')
            .replace(/^[\\/]+/, '')
            .replace(/[\\/]+$/, '')
            .replace(/[\\/]+/g, '/');
    }

    function findDirlistMatch(name, type, folder, location) {
        const targetFolder = dependencies.normalizeFolderPath(folder);
        return dependencies.state.dirlist.find(entry => {
            if (entry.kind !== 'var') {
                return false;
            }
            const entryFolder = dependencies.normalizeFolderPath(entry.folder);
            return entry.name === name && entry.type === type && entryFolder === targetFolder;
        });
    }

    return { getEvoOsModelFromExtension, getEvoOsModelFromFileName, confirmEvoOsModelMismatch, normalizeFolderPath, findDirlistMatch };
}

module.exports = { createFeaturesTiTransferPolicy };
