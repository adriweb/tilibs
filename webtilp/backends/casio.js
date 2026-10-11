'use strict';

function createCasioFileBackend(deps) {
    const { state, initModule, runOperation, t, tFormat, formatCasioError } = deps;
    return {
        family: 'casio',
        async receiveEntry(entry, index = 0) {
            if (!state.casioStorageSupported || entry.isFolder) return null;
            const module = await initModule();
            return runOperation(module, async (call, operation) => {
                if (!module.FS.analyzePath('/downloads').exists) module.FS.mkdir('/downloads');
                const target = `/downloads/casio-${index}.bin`;
                try {
                    try { module.FS.unlink(target); } catch { /* Target does not normally exist. */ }
                    const result = await call('casio_receive_file', 'number', ['string', 'string', 'string'],
                        [entry.folder || '', entry.name, target], { timeoutMs: null, useProgress: true,
                            progressLabel: tFormat('casio_progress_receiving_file', { file: entry.name }) });
                    operation.assertCurrent();
                    if (result !== 0) throw new Error(formatCasioError(module, result));
                    return { filename: entry.name, data: module.FS.readFile(target).slice() };
                } finally {
                    try { module.FS.unlink(target); } catch { /* Best-effort temporary file cleanup. */ }
                }
            });
        },
        async removeEntries(entries) {
            const module = await initModule();
            const results = [];
            for (const entry of entries) {
                if (entry.isFolder) {
                    results.push({ entry, ok: false, error: t('casio_directory_delete_unavailable') });
                    continue;
                }
                const result = await deps.ccallAsync(module, 'casio_delete_file', 'number',
                    ['string', 'string'], [entry.folder || '', entry.name], { timeoutMs: null, useProgress: true,
                        progressLabel: tFormat('casio_progress_deleting_file', { file: entry.name }) });
                results.push({ entry, ok: result === 0, error: result === 0 ? '' : formatCasioError(module, result) });
            }
            return results;
        }
    };
}

module.exports = { createCasioFileBackend };
