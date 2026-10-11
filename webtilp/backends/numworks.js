'use strict';

function createNumWorksFileBackend({ state, t }) {
    return {
        family: 'numworks',
        async receiveEntry(entry) {
            if (!state.numWorksBackend) throw new Error(t('numworks_backend_not_connected'));
            const script = state.numWorksBackend.getScript(entry.backendRef?.scriptName || entry.numWorksName || entry.name);
            return { filename: script.name, data: new TextEncoder().encode(script.code) };
        },
        async removeEntries(entries) {
            // Storage writes are transactional; a batch needs one flash write.
            await state.numWorksBackend.deleteScripts(entries.map(entry => entry.backendRef?.scriptName || entry.numWorksName || entry.name));
            return entries.map(entry => ({ entry, ok: true }));
        }
    };
}

module.exports = { createNumWorksFileBackend };
