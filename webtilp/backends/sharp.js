'use strict';

function createSharpFileBackend({ runSharpOperation, saveSharpDownload, t }) {
    return {
        family: 'sharp',
        async receiveEntries(entries) {
            await runSharpOperation(t('sharp_receive'), async backend => {
                for (const entry of entries) saveSharpDownload(await backend.receiveVariable(entry.backendRef?.nativeEntry || entry), backend);
            });
        },
        async removeEntries() { return []; }
    };
}

module.exports = { createSharpFileBackend };
