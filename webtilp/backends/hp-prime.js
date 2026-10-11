'use strict';

function createHpPrimeFileBackend(deps) {
    const { initModule, runOperation, t, tFormat, confirm, state, formatHPPrimeError } = deps;
    return {
        family: 'hp-prime',
        async receiveEntry(entry) {
            const cacheIndex = entry.backendRef?.cacheIndex ?? entry.hpIndex;
            const childIndex = entry.backendRef?.childIndex ?? entry.hpAppChildIndex;
            if (!Number.isInteger(cacheIndex) || cacheIndex < 0) {
                throw new Error(tFormat('hp_prime_missing_cache_index', { name: entry.name }));
            }
            if (entry.invalid && !confirm(tFormat('hp_prime_confirm_invalid_crc', { name: entry.name }))) return null;
            const module = await initModule();
            return runOperation(module, async (call, operation) => {
                if (!module.FS.analyzePath('/downloads').exists) module.FS.mkdir('/downloads');
                const safeName = String(entry.name || 'unnamed').replace(/[\\/\0-\x1F\x7F]/g, '_');
                const extension = String(entry.extension || '').replace(/[^A-Za-z0-9_-]/g, '');
                const child = Number.isInteger(childIndex) && childIndex >= 0;
                const target = child ? `/downloads/hp-prime-${cacheIndex}-child-${childIndex}.bin`
                    : `/downloads/hp-prime-${cacheIndex}.bin`;
                try {
                    const result = child
                        ? await call('hp_prime_download_cached_app_child', 'number', ['number', 'number', 'string'],
                            [cacheIndex, childIndex, target], { timeoutMs: 8000 })
                        : await call('hp_prime_download_cached_file', 'number', ['number', 'string'],
                            [cacheIndex, target], { timeoutMs: 8000 });
                    operation.assertCurrent();
                    if (result !== 0) throw new Error(tFormat('hp_prime_cached_download_failed', {
                        error: formatHPPrimeError(module, result) }));
                    return { filename: child || !extension ? safeName : `${safeName}.${extension}`,
                        data: module.FS.readFile(target).slice() };
                } finally {
                    try { module.FS.unlink(target); } catch { /* Best-effort temporary file cleanup. */ }
                }
            });
        },
        async removeEntries(entries) {
            if (!state.hpFileSnapshotLoaded) throw new Error(t('hp_prime_app_snapshot_required'));
            const module = await initModule();
            const results = [];
            for (const entry of entries) {
                const cacheIndex = entry.backendRef?.cacheIndex ?? entry.hpIndex;
                const childIndex = entry.backendRef?.childIndex ?? entry.hpAppChildIndex;
                if (!entry.hpAppChildEditable || !Number.isInteger(cacheIndex)
                    || !Number.isInteger(childIndex)) {
                    results.push({ entry, ok: false, error: t('hp_prime_app_core_read_only') });
                    continue;
                }
                const result = await deps.ccallAsync(module, 'hp_prime_delete_cached_app_resource', 'number',
                    ['number', 'number'], [cacheIndex, childIndex], {
                        timeoutMs: null, useProgress: true,
                        progressLabel: tFormat('hp_prime_app_progress_updating', { app: entry.folder }) });
                results.push({ entry, ok: result === 0, error: result === 0 ? '' : formatHPPrimeError(module, result) });
                if (result === 0) state.expandedFolders.add(entry.folder);
            }
            return results;
        }
    };
}

module.exports = { createHpPrimeFileBackend };
