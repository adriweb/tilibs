'use strict';

const { normalizeBackendEntry } = require('../backends/entries');

function entryId(entry, family) {
    return JSON.stringify([family, entry.kind || '', entry.folder || '', Number(entry.type) || 0,
        entry.name || '', entry.isFolder || entry.is_folder === 1 ? 1 : 0]);
}

function createFileModel() {
    const entriesById = new Map();
    const selectedIds = new Set();
    let family = null;
    return {
        entriesById, selectedIds,
        replace(entries, nextFamily, folderPathOf) {
            if (family !== nextFamily) selectedIds.clear();
            family = nextFamily;
            entriesById.clear();
            for (const entry of entries) this.register(entry, nextFamily, folderPathOf?.(entry));
        },
        pruneSelection() {
            for (const id of selectedIds) if (!entriesById.has(id)) selectedIds.delete(id);
        },
        register(entry, nextFamily = family, folderPath) {
            const normalized = normalizeBackendEntry(entry, nextFamily, folderPath);
            const id = entryId(normalized, nextFamily);
            entriesById.set(id, normalized);
            return id;
        },
        select(id, checked) {
            if (!entriesById.has(id)) return;
            if (checked) selectedIds.add(id);
            else selectedIds.delete(id);
        },
        selectedEntries() {
            return [...selectedIds].map(id => entriesById.get(id)).filter(Boolean);
        }
    };
}

module.exports = { createFileModel, entryId };
