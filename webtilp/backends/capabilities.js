'use strict';

// Listing sources remain distinct: a backup VAT is a manual snapshot, and
// cached HP Prime files do not imply a native directory-list protocol.
function getBackendCapabilities(state, flags, modelId) {
    const family = state.activeFamily || 'ti';
    const features = Number(state.features) || 0;
    const has = flag => (features & flag) !== 0;
    const base = { family, nativeDirectory: false, backupDirectory: false, cachedDirectory: false,
        receive: false, remove: false, rename: false, batchRemove: false, folders: false,
        screenshot: false, keys: false, backup: false, clock: false, newFolder: false,
        rom: false, ready: false, send: false };
    if (family === 'hp-prime') return { ...base, cachedDirectory: true, receive: true, send: true,
        remove: Boolean(state.hpFileSnapshotLoaded), rename: Boolean(state.hpFileSnapshotLoaded),
        screenshot: true, keys: true, backup: true, folders: true };
    if (family === 'numworks') return { ...base, cachedDirectory: true, receive: true,
        send: true, remove: true, rename: true, batchRemove: true, backup: true };
    if (family === 'casio') return { ...base, nativeDirectory: Boolean(state.casioStorageSupported),
        receive: Boolean(state.casioStorageSupported), send: Boolean(state.casioStorageSupported),
        remove: Boolean(state.casioStorageSupported), rename: Boolean(state.casioStorageSupported),
        batchRemove: Boolean(state.casioStorageSupported), folders: true };
    if (family === 'hp-legacy') return { ...base, nativeDirectory: Boolean(state.hpLegacyKermitEnabled),
        receive: Boolean(state.hpLegacyKermitEnabled), send: Boolean(state.hpLegacyKermitEnabled),
        screenshot: Boolean(state.hpLegacyKermitEnabled) };
    if (family === 'sharp') {
        return { ...base, nativeDirectory: true, receive: true, send: true,
            screenshot: true, backup: true, rom: true };
    }
    const nativeDirectory = has(flags.OPS_DIRLIST);
    const backup = has(flags.OPS_BACKUP) || has(flags.FTS_BACKUP);
    return { ...base, nativeDirectory, backupDirectory: !nativeDirectory && backup && [2, 6].includes(modelId),
        receive: true, send: true, remove: has(flags.OPS_DELVAR), rename: has(flags.OPS_RENAME),
        batchRemove: has(flags.OPS_DELVAR), folders: has(flags.FTS_FOLDER), screenshot: true,
        keys: has(flags.OPS_KEYS), backup, clock: has(flags.OPS_CLOCK), newFolder: has(flags.OPS_NEWFLD),
        rom: has(flags.OPS_ROMDUMP), ready: true };
}

function getEntryPermissions(entry, capabilities) {
    const folder = Boolean(entry?.isFolder || entry?.is_folder === 1);
    const manualBackup = entry?.kind === 'backup-var';
    const hpChild = Boolean(entry?.hpAppChildEditable && Number.isInteger(entry?.hpAppChildIndex));
    const mutable = !manualBackup && !(capabilities.family === 'casio' && folder)
        && !(capabilities.family === 'hp-prime' && !hpChild);
    return { receive: capabilities.receive && !manualBackup
            && !(capabilities.family === 'hp-legacy' && folder),
        remove: capabilities.remove && mutable, rename: capabilities.rename && mutable,
        batchRemove: capabilities.batchRemove && mutable };
}

function deriveSelectionActions(entries, capabilities) {
    const permissions = entries.map(entry => getEntryPermissions(entry, capabilities));
    return { receive: permissions.some(permission => permission.receive),
        remove: permissions.some(permission => permission.batchRemove) };
}

module.exports = { getBackendCapabilities, getEntryPermissions, deriveSelectionActions };
