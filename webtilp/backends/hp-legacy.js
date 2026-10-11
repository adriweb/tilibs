'use strict';

function createHpLegacyFileBackend({ state, t }) {
    return {
        family: 'hp-legacy',
        async receiveEntry(entry) {
            if (entry.isFolder) throw new Error(t('hp_legacy_directory_download_unavailable'));
            const received = await state.hpLegacyBackend.receiveFile(entry.name);
            return { filename: String(received.name || entry.name || 'hp-object').replace(/[\\/]/g, '_'),
                data: received.data };
        },
        async removeEntries() { throw new Error(t('hp_legacy_mutation_unavailable')); }
    };
}

module.exports = { createHpLegacyFileBackend };
