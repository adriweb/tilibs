'use strict';

/**
 * features hp-apps. Browser and application dependencies are injected
 * by app.js; importing this module does not start the application.
 * @param {object} dependencies
 * @returns {object}
 */
function createFeaturesHpApps(dependencies) {
    async function packHPPrimeAppDirectory(folder, files) {
        const operationGeneration = dependencies.session.capture();
        const invalid = () => new Error(dependencies.tFormat('hp_prime_app_folder_invalid', { folder }));
        if (!/\.hpappdir$/i.test(folder)) throw invalid();
        const appName = folder.slice(0, -9);
        if (!appName || /[\/\\\x00-\x1f]/.test(appName) || appName.length > 128) throw invalid();
        const entries = new Map();
        for (const file of files) {
            const name = file.name;
            // Finder metadata is not calculator application content.
            if (name === '.DS_Store' || name.startsWith('._')) continue;
            const key = name.toLowerCase();
            if (!name || name === '.' || name === '..' || name.length > 128
                || /[\/\\\x00-\x1f\x7f]/.test(name) || entries.has(key)) throw invalid();
            entries.set(key, file);
        }
        const coreNames = ['.hpapp', '.hpappnote', '.hpappprgm'].map(ext => appName + ext);
        const cores = coreNames.map(name => entries.get(name.toLowerCase()));
        if (!cores[0] || !cores[0].size) throw invalid();
        coreNames.forEach(name => entries.delete(name.toLowerCase()));
        const resources = Array.from(entries.values()).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        if (resources.some(file => /\.(hpapp|hpappnote|hpappprgm)$/i.test(file.name))) throw invalid();
        const size = 12 + cores.reduce((sum, file) => sum + (file?.size || 0), 0)
            + resources.reduce((sum, file) => sum + 4 + file.name.length * 2 + 2 + file.size, 0);
        // Leave room for the outer file message in the 64 MiB transport limit.
        if (size > 64 * 1024 * 1024 - 1024) throw invalid();
        const bytes = new dependencies.Uint8Array(size);
        const view = new dependencies.DataView(bytes.buffer);
        let offset = 0;
        for (const file of cores) {
            const data = file ? new dependencies.Uint8Array(await dependencies.session.wait(file.arrayBuffer(), operationGeneration)) : new dependencies.Uint8Array();
            view.setUint32(offset, data.length, false);
            offset += 4;
            bytes.set(data, offset);
            offset += data.length;
        }
        for (const file of resources) {
            const data = new dependencies.Uint8Array(await dependencies.session.wait(file.arrayBuffer(), operationGeneration));
            view.setUint32(offset, file.name.length * 2 + 2 + data.length, false);
            offset += 4;
            for (let i = 0; i < file.name.length; i++) {
                view.setUint16(offset, file.name.charCodeAt(i), true);
                offset += 2;
            }
            offset += 2;
            bytes.set(data, offset);
            offset += data.length;
        }
        const result = new dependencies.File([bytes], appName + '.hpapp', { type: 'application/octet-stream' });
        result.hpAppDirectory = true;
        return result;
    }

    async function readHPPrimeAppDirectory(entry) {
        const operationGeneration = dependencies.session.capture();
        const reader = entry.createReader();
        const children = [];
        // Chromium returns directory entries in batches (often only 100 at once).
        for (;;) {
            const batch = await dependencies.session.wait(new Promise((resolve, reject) => reader.readEntries(resolve, reject)), operationGeneration);
            if (!batch.length) break;
            children.push(...batch);
        }
        if (children.some(child => !child.isFile)) {
            throw new Error(dependencies.tFormat('hp_prime_app_folder_invalid', { folder: entry.name }));
        }
        const files = await dependencies.session.wait(Promise.all(children.map(child => new Promise((resolve, reject) => child.file(resolve, reject)))), operationGeneration);
        return dependencies.packHPPrimeAppDirectory(entry.name, files);
    }

    async function getDroppedTransferFiles(event) {
        const operationGeneration = dependencies.session.capture();
        // Capture entries AND ordinary files synchronously while the drop event's
        // data store is readable; it is protected after the first await.
        const files = dependencies.getDroppedFiles(event);
        const items = Array.from(event.dataTransfer?.items || []).filter(item => item.kind === 'file');
        const captured = items.map(item => ({ entry: item.webkitGetAsEntry?.(), file: item.getAsFile() }));
        if (!captured.some(item => item.entry?.isDirectory)) return files;
        const result = [];
        for (const item of captured) {
            if (item.entry?.isDirectory) {
                result.push(await dependencies.session.wait(dependencies.readHPPrimeAppDirectory(item.entry), operationGeneration));
            } else if (item.file) {
                result.push(item.file);
            }
        }
        return result;
    }

    async function getHPPrimePickedDirectory(files) {
        const operationGeneration = dependencies.session.capture();
        const selected = Array.from(files);
        if (!selected.length) return [];
        const folder = selected[0].webkitRelativePath.split('/')[0];
        if (selected.some(file => file.webkitRelativePath !== folder + '/' + file.name)) {
            throw new Error(dependencies.tFormat('hp_prime_app_folder_invalid', { folder }));
        }
        return [await dependencies.session.wait(dependencies.packHPPrimeAppDirectory(folder, selected), operationGeneration)];
    }

    function encodeHPPrimeAppResourceManifest(resources) {
        const encoder = new dependencies.TextEncoder();
        const encoded = resources.map(resource => ({
            name: encoder.encode(resource.name),
            data: resource.data
        }));
        let total = 4;
        encoded.forEach(resource => {
            if (resource.name.byteLength > 0xFFFFFFFF
                || resource.data.byteLength > 0xFFFFFFFF) {
                throw new Error(dependencies.t('hp_prime_app_resource_too_large'));
            }
            total += 8 + resource.name.byteLength + resource.data.byteLength;
        });
        if (!Number.isSafeInteger(total)) {
            throw new Error(dependencies.t('hp_prime_app_resource_too_large'));
        }
        const result = new dependencies.Uint8Array(total);
        const view = new dependencies.DataView(result.buffer);
        let offset = 0;
        const writeU32 = value => {
            view.setUint32(offset, value, false);
            offset += 4;
        };
        writeU32(encoded.length);
        encoded.forEach(resource => {
            writeU32(resource.name.byteLength);
            result.set(resource.name, offset);
            offset += resource.name.byteLength;
            writeU32(resource.data.byteLength);
            result.set(resource.data, offset);
            offset += resource.data.byteLength;
        });
        return result;
    }

    function findHPPrimeAppRoot(folderPath) {
        const normalized = dependencies.normalizeFolderPath(folderPath || '');
        if (!normalized) {
            return null;
        }
        return dependencies.state.dirlist.find(entry => entry.hpAppRoot
            && dependencies.normalizeFolderPath(dependencies.getEntryFolderPath(entry)) === normalized) || null;
    }

    async function sendHPPrimeAppResources(files, appRoot) {
        const operationGeneration = dependencies.session.capture();
        if (!dependencies.state.hpFileSnapshotLoaded) {
            dependencies.log(dependencies.t('hp_prime_app_snapshot_required'));
            return;
        }
        const module = await dependencies.session.wait(dependencies.initModule(), operationGeneration);
        const existingChildren = dependencies.state.dirlist.filter(entry => entry.kind === 'hp-app-child'
            && entry.hpIndex === appRoot.hpIndex);
        const pending = [];
        const pendingNames = new Set();
        for (const file of files) {
            let name = String(file.name || '').split(/[\\/]/).pop();
            const coreExtension = name.match(/\.(hpappprgm|hpappnote)$/i)?.[1]?.toLowerCase();
            if (coreExtension) {
                // Core parts belong to the selected app, not to a named resource.
                name = `${appRoot.name}.${coreExtension}`;
            }
            const key = name.toLowerCase();
            if (!name || pendingNames.has(key)) {
                dependencies.log(dependencies.tFormat('hp_prime_app_resource_skipped', { file: file.name }));
                continue;
            }
            const existing = existingChildren.find(entry => entry.name.toLowerCase() === key);
            if (/\.hpapp$/i.test(name)
                || (existing && !existing.hpAppChildEditable && !coreExtension)) {
                dependencies.log(dependencies.tFormat('hp_prime_app_core_upload_rejected', { file: file.name }));
                continue;
            }
            if (existing && !dependencies.confirm(dependencies.tFormat('hp_prime_app_confirm_resource_overwrite', {
                file: file.name,
                app: appRoot.name
            }))) {
                dependencies.log(dependencies.tFormat('hp_prime_overwrite_skipped', { file: file.name }));
                continue;
            }
            pendingNames.add(key);
            pending.push({
                name,
                data: new dependencies.Uint8Array(await dependencies.session.wait(file.arrayBuffer(), operationGeneration))
            });
        }
        if (!pending.length) {
            return;
        }
        const manifestPath = `/hp-prime-app-resources-${appRoot.hpIndex}.bin`;
        try {
            module.FS.writeFile(manifestPath,
                dependencies.encodeHPPrimeAppResourceManifest(pending));
            const result = await dependencies.session.wait(dependencies.ccallAsync(module,
                'hp_prime_send_cached_app_resources', 'number',
                ['number', 'string'], [appRoot.hpIndex, manifestPath], {
                    timeoutMs: null,
                    useProgress: true,
                    progressLabel: dependencies.tFormat('hp_prime_app_progress_updating', {
                        app: appRoot.name
                    })
                }), operationGeneration);
            if (result !== 0) {
                dependencies.log(dependencies.tFormat('hp_prime_app_upload_failed', {
                    app: appRoot.name,
                    error: dependencies.formatHPPrimeError(module, result)
                }));
                return;
            }
            dependencies.state.expandedFolders.add(dependencies.getEntryFolderPath(appRoot));
            dependencies.applyHPPrimeFileSnapshot(module);
            dependencies.log(dependencies.tFormat('hp_prime_app_resources_sent', {
                count: pending.length,
                app: appRoot.name
            }));
            return true;
        } finally {
            try {
                module.FS.unlink(manifestPath);
            } catch {
                // Best-effort cleanup.
            }
        }
    }

    function chooseHPPrimeAppForFile(file) {
        if (!dependencies.state.hpFileSnapshotLoaded) {
            dependencies.log(dependencies.t('hp_prime_app_snapshot_required'));
            return null;
        }
        const apps = dependencies.state.dirlist.filter(entry => entry.hpAppRoot);
        const stem = String(file.name || '').replace(/\.(hpappprgm|hpappnote)$/i, '');
        const suggested = apps.find(entry => entry.name.toLowerCase() === stem.toLowerCase());
        const chosen = apps.length ? dependencies.prompt(dependencies.tFormat('hp_prime_app_target_prompt', {
            file: file.name,
            apps: apps.map(entry => entry.name).join(', ')
        }), suggested?.name || '') : null;
        if (chosen === null && apps.length) return null;
        const app = apps.find(entry => entry.name.toLowerCase() === String(chosen || '').trim().toLowerCase());
        if (!app) dependencies.log(dependencies.tFormat('hp_prime_app_target_missing', { file: file.name }));
        return app || null;
    }

    return { packHPPrimeAppDirectory, readHPPrimeAppDirectory, getDroppedTransferFiles, getHPPrimePickedDirectory, encodeHPPrimeAppResourceManifest, findHPPrimeAppRoot, sendHPPrimeAppResources, chooseHPPrimeAppForFile };
}

module.exports = { createFeaturesHpApps };
