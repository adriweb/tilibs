'use strict';

// A receive includes consuming the native result marker. Keeping both inside
// one runtime operation prevents another receive from replacing the marker.
function createTiFileBackend(deps) {
    const { initModule, authorizeDevice, ensureHandle, runOperation,
        formatErrorResult, idleTimeout } = deps;
    async function prepare() {
        await authorizeDevice();
        return { module: await initModule(), handle: await ensureHandle() };
    }
    return {
        family: 'ti',
        async receiveEntry(entry) {
            const { module, handle } = await prepare();
            return runOperation(module, async (call, operation) => {
                if (!module.FS.analyzePath('/downloads').exists) module.FS.mkdir('/downloads');
                try { module.FS.unlink('/last_recv_path.txt'); } catch { /* No previous result marker. */ }
                const options = { timeoutMs: idleTimeout, useProgress: true,
                    progressLabel: `Receiving ${entry.name}` };
                const result = entry.kind === 'app'
                    ? await call('calc_recv_app', 'number', ['number', 'string', 'number', 'string'],
                        [handle, entry.name, entry.type, '/downloads'], options)
                    : await call('calc_recv_var', 'number', ['number', 'string', 'string', 'number', 'string'],
                        [handle, entry.folder || '', entry.name, entry.type, '/downloads'], options);
                operation.assertCurrent();
                if (result !== 0) throw new Error(formatErrorResult(module, result));
                const path = module.FS.readFile('/last_recv_path.txt', { encoding: 'utf8' }).trim();
                if (!path) throw new Error('No received file found to download.');
                try {
                    return { filename: path.split('/').pop(), data: module.FS.readFile(path).slice() };
                } finally {
                    try { module.FS.unlink(path); } catch { /* Best-effort result cleanup. */ }
                    try { module.FS.unlink('/last_recv_path.txt'); } catch { /* Best-effort marker cleanup. */ }
                }
            });
        },
        async removeEntries(entries) {
            const { module, handle } = await prepare();
            const results = [];
            for (const entry of entries) {
                const folder = entry.isFolder;
                const name = folder ? entry.folderPath || entry.name : entry.name;
                const result = await deps.ccallAsync(module,
                    folder ? 'calc_del_folder' : 'calc_del_var', 'number',
                    folder ? ['number', 'string'] : ['number', 'string', 'string', 'number'],
                    folder ? [handle, name] : [handle, entry.folder || '', name, entry.type],
                    { timeoutMs: idleTimeout, useProgress: true, progressLabel: `Deleting ${name}` });
                results.push({ entry, ok: result === 0, error: result === 0 ? '' : formatErrorResult(module, result) });
            }
            return results;
        }
    };
}

module.exports = { createTiFileBackend };
