'use strict';

// Native identities belong to the backend boundary. Views and selection use
// display metadata and an opaque reference retained with the entry model.
function normalizeBackendEntry(entry, family, folderPath) {
    return { ...entry, isFolder: Boolean(entry.isFolder || entry.is_folder === 1),
        typeName: entry.typeName || entry.type_name || '', folderPath: folderPath || entry.folderPath || '',
        backendRef: entry.backendRef || { family, cacheIndex: entry.hpIndex, childIndex: entry.hpAppChildIndex,
            scriptName: entry.numWorksName, nativeEntry: family === 'sharp' ? entry : undefined } };
}

module.exports = { normalizeBackendEntry };
