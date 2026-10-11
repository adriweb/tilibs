'use strict';

function folderContains(folder, parent, recursive) {
    return folder === parent || (recursive && Boolean(parent) && folder.startsWith(`${parent}/`));
}

function planReceives(selections, entries, family, normalizeFolderPath) {
    if (family === 'hp-prime') {
        const roots = new Set(selections.filter(entry => entry.hpAppRoot).map(entry => entry.hpIndex));
        return { entries: selections.filter(entry => !Number.isInteger(entry.hpAppChildIndex)
            || !roots.has(entry.hpIndex)), folders: [] };
    }
    if (family !== 'ti' && family !== 'casio') {
        return { entries: family === 'hp-legacy' ? selections.filter(entry => !entry.isFolder) : selections,
            folders: [] };
    }
    const recursive = family === 'ti';
    const selectedFolders = selections.filter(entry => entry.isFolder)
        .map(entry => normalizeFolderPath(entry.folderPath || entry.name)).sort((a, b) => a.length - b.length);
    const folders = [];
    for (const folder of selectedFolders) {
        if (!folders.some(parent => folderContains(folder, parent, recursive))) folders.push(folder);
    }
    const files = selections.filter(entry => !entry.isFolder
        && !folders.some(parent => folderContains(normalizeFolderPath(entry.folder || ''), parent, recursive)));
    for (const entry of entries) {
        if (entry.is_folder === 1 || entry.isFolder) continue;
        if (family === 'casio' && entry.kind !== 'casio') continue;
        if (folders.some(parent => folderContains(normalizeFolderPath(entry.folder || ''), parent, recursive))) {
            files.push(entry);
        }
    }
    return { entries: files, folders };
}

function createFileActions(deps) {
    const { state, backends, t, tFormat, log, logError, confirm, normalizeFolderPath,
        triggerDownload, convertReceivedPythonFile, setButtonLoading, els } = deps;
    function backend() { return backends[state.activeFamily || 'ti']; }
    function receivedMessage(entry, file) {
        const family = state.activeFamily;
        if (family === 'hp-prime') return tFormat('hp_prime_file_received', { file });
        if (family === 'numworks') return tFormat('numworks_file_received', { file });
        if (family === 'casio') return tFormat('casio_file_received', { file: entry.name });
        if (family === 'hp-legacy') return tFormat('hp_legacy_file_received', { file: entry.name });
        return `Received ${entry.name}.`;
    }
    async function receiveEntries(selections, { confirmFolders = true, targetFolder } = {}) {
        if (!selections.length) { log('No variables selected.'); return false; }
        const sessionToken = deps.captureSession?.();
        const active = backend();
        const family = active.family;
        const plan = planReceives(selections, state.dirlist, family, normalizeFolderPath);
        if (confirmFolders && plan.folders.length) {
            const prompt = targetFolder !== undefined
                ? tFormat('confirm_download_items_from_target', { count: plan.entries.length,
                    target: targetFolder || t('root') })
                : tFormat('confirm_download_items_from_folders', { items: plan.entries.length,
                    folders: plan.folders.length });
            if (!confirm(prompt)) return false;
        }
        setButtonLoading(els.btnRecvSelected, true);
        try {
            if (active.receiveEntries) { await active.receiveEntries(plan.entries); return true; }
            let received = false;
            for (let index = 0; index < plan.entries.length; index++) {
                const entry = plan.entries[index];
                try {
                    let result = await active.receiveEntry(entry, index);
                    deps.assertSession?.(sessionToken);
                    if (!result) continue;
                    if (family === 'ti') result = await convertReceivedPythonFile(result.filename, result.data) || result;
                    deps.assertSession?.(sessionToken);
                    triggerDownload(result.filename, result.data);
                    log(receivedMessage(entry, result.filename));
                    received = true;
                } catch (error) {
                    if (error?.staleSession) throw error;
                    if (family === 'casio') log(tFormat('casio_file_receive_failed', {
                        file: entry.name, error: error?.message || t('casio_error_unknown') }));
                    else if (family === 'ti') log(`Failed to receive ${entry.name} (${error?.message || error}).`);
                    else logError(error, `Download ${entry.name} failed`);
                }
            }
            return received;
        } catch (error) {
            logError(error, 'Receive failed');
            return false;
        } finally { setButtonLoading(els.btnRecvSelected, false); }
    }
    async function removeEntries(selections, { single = false } = {}) {
        const active = backend();
        const sessionToken = deps.captureSession?.();
        if (active.family === 'sharp') return;
        if (active.family === 'hp-legacy') { log(t('hp_legacy_mutation_unavailable')); return; }
        if (active.family === 'casio') selections = selections.filter(entry => !entry.isFolder);
        if (!selections.length) { log('No variables selected.'); return; }
        const first = selections[0];
        if (!confirm(single ? tFormat('confirm_delete_entry', {
            kind: t(first.isFolder ? 'kind_folder' : 'kind_item'), name: first.name })
            : tFormat('confirm_delete_items', { count: selections.length }))) return;
        setButtonLoading(els.btnDeleteSelected, true);
        try {
            const results = await active.removeEntries(selections);
            deps.assertSession?.(sessionToken);
            for (const { entry, ok, error } of results) {
                if (active.family === 'casio') log(tFormat(ok ? 'casio_file_deleted' : 'casio_file_delete_failed', {
                    file: entry.name, error }));
                else if (active.family === 'hp-prime') log(tFormat(ok ? 'hp_prime_app_resource_deleted'
                    : 'hp_prime_app_delete_failed', { name: entry.name, app: entry.folder, error }));
                else if (active.family === 'numworks') {
                    if (single) log(tFormat('numworks_script_deleted', { name: entry.name }));
                } else {
                    const label = entry.isFolder ? `folder ${entry.folderPath || entry.name}` : entry.name;
                    log(ok ? `Deleted ${label}.` : `Failed to delete ${label} (${error}).`);
                }
            }
            if (active.family === 'numworks') {
                deps.readNumWorksInfo(); deps.applyNumWorksStorageSnapshot();
                if (!single) log(tFormat('numworks_scripts_deleted', { count: selections.length }));
            } else if (active.family === 'hp-prime') deps.applyHPPrimeFileSnapshot(await deps.initModule());
            else await deps.refreshDirlist();
        } catch (error) { logError(error, 'Delete failed'); }
        finally { setButtonLoading(els.btnDeleteSelected, false); }
    }
    return { receiveEntries, removeEntries,
        receiveFolder(folderPath) {
            const target = normalizeFolderPath(folderPath);
            return receiveEntries([{ name: target, folderPath: target, isFolder: true }], { targetFolder: target });
        } };
}

module.exports = { createFileActions, planReceives, folderContains };
