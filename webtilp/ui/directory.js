'use strict';

/**
 * ui directory. Browser and application dependencies are injected
 * by app.js; importing this module does not start the application.
 * @param {object} dependencies
 * @returns {object}
 */
function createUiDirectory(dependencies) {
    function renderDirlist(entries) {
        dependencies.getFileModel().replace(entries, dependencies.state.activeFamily, dependencies.getEntryFolderPath);
        const filter = (dependencies.els.filterInput.value || '').toLowerCase();
        const showLocation = !dependencies.isNspireActive() && !dependencies.isHPPrimeActive()
            && !dependencies.isNumWorksActive() && !dependencies.isCasioActive();
        const showKind = !dependencies.isNspireActive() && !dependencies.isHPPrimeActive()
            && !dependencies.isNumWorksActive() && !dependencies.isCasioActive();
        const table = dependencies.els.varTableBody.closest('table');
        if (table) {
            table.classList.toggle('hide-location', !showLocation);
            table.classList.toggle('hide-kind', !showKind);
        }
        if (dependencies.els.folderSticky) {
            dependencies.els.folderSticky.classList.toggle('hide-kind', !showKind);
            dependencies.els.folderSticky.classList.toggle('hide-location', !showLocation);
        }
        dependencies.renderTableView(entries, filter);
        dependencies.getFileModel().pruneSelection();
        dependencies.updateStickyFolderHeader();
        dependencies.updateSelectionActionButtons();
    }

    function calcSupportsFolders() {
        if (dependencies.state?.activeFamily === 'sharp') return false;

        return (dependencies.state.features & dependencies.FEATURE_FLAGS.FTS_FOLDER) !== 0;
    }

    function isListEntry(entry) {
        return String(entry.type_name || '').toLowerCase().includes('list');
    }

    function isMatrixEntry(entry) {
        return String(entry.type_name || '').toLowerCase().includes('matrix');
    }

    function isBuiltInListName(name) {
        return /^L(?:[1-6]|[₁₂₃₄₅₆])$/i.test(name);
    }

    function canPreviewVariable(entry, modelId = dependencies.getActiveCalcModelId()) {
        if (!entry || entry.is_folder === 1) {
            return false;
        }
        if (dependencies.getHPPrimePreviewKind(entry)) {
            return true;
        }
        if (entry.kind === 'numworks') {
            return !entry.invalid;
        }
        if (entry.kind !== 'var') {
            return false;
        }
        if (!dependencies.TIVARS_PREVIEW_CALC_MODELS.has(modelId)) {
            return false;
        }
        const typeId = Number(entry.type);
        return dependencies.EVO_PYTHON_CALC_MODELS.has(modelId)
            ? dependencies.TIVARS_EVO_PREVIEW_TYPES.has(typeId)
            : dependencies.TIVARS_LEGACY_PREVIEW_TYPES.has(typeId);
    }

    function getEntryExtension(entry) {
        const supplied = String(entry?.extension || '').trim().replace(/^\./, '');
        if (supplied) {
            return supplied.toLowerCase();
        }
        const name = String(entry?.name || '');
        const dot = name.lastIndexOf('.');
        return dot >= 0 && dot < name.length - 1
            ? name.slice(dot + 1).toLowerCase() : '';
    }

    function getHPPrimePreviewKind(entry) {
        if (!entry || (entry.kind !== 'hp' && entry.kind !== 'hp-app-child')) {
            return '';
        }
        const extension = dependencies.getEntryExtension(entry);
        if (dependencies.HP_PRIME_TEXT_PREVIEW_EXTENSIONS.has(extension)) {
            return 'text';
        }
        return extension === 'png' ? 'image' : '';
    }

    function formatVariableDisplayName(entry) {
        const name = entry.name || '';
        if (entry.kind === 'sharp' || entry.kind === 'hp-legacy' || entry.kind === 'backup-var') {
            return name;
        }
        if (entry.kind === 'numworks') {
            return `${name}.py`;
        }
        if (dependencies.calcSupportsFolders() || entry.is_folder === 1) {
            return name;
        }
        if (dependencies.isListEntry(entry) && !dependencies.isBuiltInListName(name)) {
            return `ʟ${name}`;
        }
        if (dependencies.isMatrixEntry(entry)) {
            return /^\[.*\]$/.test(name) ? name : `[${name}]`;
        }
        return name;
    }

    function renderTableView(entries, filter) {
        const selectionKeys = dependencies.getSelectedVarKeys();
        const previewModelId = dependencies.getActiveCalcModelId();
        dependencies.els.varTableBody.innerHTML = '';
        const tree = dependencies.buildTree(entries);
        dependencies.state.folderSizeMap = new Map();

        const entryMatchesFilter = (entry) => {
            if (!filter) {
                return true;
            }
            const hay = `${entry.name} ${entry.type} ${entry.type_name || ''} ${entry.kind}`.toLowerCase();
            return hay.includes(filter);
        };

        const nodeHasMatch = (node) => {
            if (!filter) {
                return true;
            }
            if (node.entry) {
                if (node.entry.is_folder === 1) {
                    const nameHay = (node.entry.name || node.name || '').toLowerCase();
                    if (nameHay.includes(filter)) {
                        return true;
                    }
                } else if (entryMatchesFilter(node.entry)) {
                    return true;
                }
            }
            if (node.children) {
                return node.children.some(child => nodeHasMatch(child));
            }
            return false;
        };

        const buildSyntheticFolderEntry = (node) => {
            const path = node.path || node.name || '';
            const parts = path.split('/').filter(Boolean);
            const name = parts.pop() || node.name || 'Folder';
            const folder = parts.join('/');
            return {
                name,
                folder,
                type: 0,
                type_name: 'Directory',
                size: 0,
                kind: 'folder',
                is_folder: 1,
                attr: 0
            };
        };

        const renderTableRow = (entry, depth, options = {}) => {
            const isArchived = entry.attr === 3;
            const isFolder = entry.is_folder === 1;
            const location = entry.kind === 'hp-legacy'
                ? '-' : (entry.kind === 'app' ? 'Flash' : (isArchived ? 'Archive' : 'RAM'));
            const typeLabel = isFolder
                ? (entry.hpAppRoot ? entry.type_name : 'Directory')
                : (entry.type_name || `Unknown (${entry.type})`);
            const sizeValue = Number(entry.size) || 0;
            const sizeLabel = options.sizeLabel ?? (entry.kind === 'sharp' && !entry.size ? '—' : isFolder ? '-'
                : (entry.kind === 'hp-legacy' && entry.hpSize
                    ? `${entry.hpSize}B` : dependencies.formatBytes(sizeValue)));
            const indentBars = depth > 0
                ? `<span class="indent-bars">${'<span class="indent-bar"></span>'.repeat(depth)}</span>`
                : '';
            const kindLabel = isFolder
                ? (entry.hpAppRoot ? 'hp' : 'folder')
                : (entry.kind === 'backup-var' ? 'var' : (entry.kind || ''));
            const safeTypeLabel = dependencies.escapeHtml(typeLabel);
            const safeLocation = dependencies.escapeHtml(isFolder ? '-' : location);
            const safeKindLabel = dependencies.escapeHtml(kindLabel);
            const safeFolderCell = dependencies.escapeHtml(entry.folder || '-') || '-';
            const sizeHtml = options.sizeLabel ? options.sizeLabel : dependencies.escapeHtml(sizeLabel);
            const row = dependencies.document.createElement('tr');
            const normalizedFolderPath = dependencies.normalizeFolderPath(dependencies.getEntryFolderPath(entry));
            const safeName = dependencies.escapeHtml(dependencies.formatVariableDisplayName(entry));
            const appContainerInvalid = entry.kind === 'hp'
                && entry.hpAppContainerValid === false;
            const integrityTitle = entry.kind === 'numworks'
                ? dependencies.t('numworks_malformed_record')
                : (appContainerInvalid
                    ? dependencies.t('hp_prime_app_invalid_container')
                    : 'CRC validation failed; the cached data may be corrupt');
            const integrityWarning = entry.invalid || appContainerInvalid
                ? `<span class="integrity-warning" title="${dependencies.escapeHtml(integrityTitle)}" aria-label="Integrity validation failed">⚠ ${entry.kind === 'numworks' ? 'DATA' : (appContainerInvalid ? 'APP' : 'CRC')}</span>`
                : '';
            const safeFolderPath = dependencies.escapeHtml(normalizedFolderPath);
            row.dataset.folderTarget = normalizedFolderPath;
            row.dataset.isFolder = isFolder ? '1' : '0';
            row.dataset.folderPath = normalizedFolderPath;
            row.dataset.depth = String(depth);
            row.dataset.hpAppRoot = entry.hpAppRoot ? '1' : '0';
            if (entry.hpAppRoot) {
                row.title = dependencies.t('hp_prime_app_folder_hint');
            }
            row.classList.toggle('integrity-invalid', Boolean(entry.invalid || appContainerInvalid));
            const permissions = dependencies.getEntryPermissions(entry, dependencies.getActiveBackendCapabilities());
            const canRename = permissions.rename;
            const canDelete = permissions.remove;
            const canPreview = dependencies.canPreviewVariable(entry, previewModelId);
            const rowActions = `
                <div class="row-actions">
                    ${canPreview ? `<button class="btn ghost btn-inline action-preview" title="${dependencies.escapeHtml(dependencies.t('preview'))}" aria-label="${dependencies.escapeHtml(dependencies.t('preview'))}">${dependencies.themeIconMarkup('eye', '👁️')}</button>` : ''}
                    ${!permissions.receive ? '' : `<button class="btn ghost btn-inline action-download" title="Download">${dependencies.themeIconMarkup('download', '⬇️')}</button>`}
                    ${canRename ? `<button class="btn ghost btn-inline action-rename" title="Rename">${dependencies.themeIconMarkup('edit-2', '✏️')}</button>` : ''}
                    ${canDelete ? `<button class="btn ghost btn-inline action-delete" title="Delete">${dependencies.themeIconMarkup('trash-2', '🗑️')}</button>` : ''}
                </div>`;
            const toggleButton = isFolder
                ? `<button class="folder-toggle" type="button" data-folder-path="${safeFolderPath}" aria-label="${options.expanded ? 'Collapse folder' : 'Expand folder'}">${options.expanded ? '▾' : '▸'}</button>`
                : '';
            const displayName = isFolder
                ? `<span class="folder-icon" data-folder-path="${safeFolderPath}">${dependencies.themeIconMarkup('folder', '📂')}</span> ${safeName}`
                : `${safeName}${integrityWarning}`;
            const summaryText = options.summary ? `<em class="folder-summary">(${options.summary})</em>` : '';
            row.innerHTML = `
                <td><input type="checkbox" ${entry.kind === 'backup-var' ? 'disabled' : ''} data-entry-id="" data-folder-path="" data-is-folder="${isFolder ? '1' : '0'}"></td>
                <td>
                    <div class="name-cell">
                        <div class="name-left">${indentBars}${toggleButton}<span class="name-label">${displayName}${summaryText}</span></div>
                        ${rowActions}
                    </div>
                </td>
                <td>${safeTypeLabel}</td>
                <td title="${isFolder || entry.kind === 'sharp' && !entry.size ? '' : `${sizeValue} bytes`}">${sizeHtml}</td>
                <td>${safeLocation}</td>
                <td>${safeFolderCell}</td>
                <td>${safeKindLabel}</td>
            `;
            const checkbox = row.querySelector('input[type="checkbox"]');
            if (checkbox) {
                checkbox.dataset.entryId = dependencies.getFileModel().register(entry, dependencies.state.activeFamily, normalizedFolderPath);
                checkbox.dataset.folderPath = normalizedFolderPath;
            }
            dependencies.els.varTableBody.appendChild(row);
        };

        const sortNodes = (nodes) => {
            const key = dependencies.state.sort.key;
            const dir = dependencies.state.sort.dir;
            const useDefaultFlatSort = !dependencies.state.sort.userDefined && !dependencies.calcSupportsFolders();
            return [...nodes].sort((a, b) => {
                const entryA = a.entry || buildSyntheticFolderEntry(a);
                const entryB = b.entry || buildSyntheticFolderEntry(b);
                if (useDefaultFlatSort) {
                    return dependencies.compareEntriesByDefaultFlatOrder(entryA, entryB);
                }
                return dependencies.compareEntries(entryA, entryB, key, dir);
            });
        };

        const collectFolderSizes = (node) => {
            const isFolderNode = (node.entry && node.entry.is_folder === 1) || (!node.entry && node.children);
            if (!isFolderNode) {
                if (node.entry) {
                    return Number(node.entry.size) || 0;
                }
                return 0;
            }
            const children = node.children || [];
            const folderEntry = node.entry || buildSyntheticFolderEntry(node);
            const childrenTotal = children.reduce(
                (sum, child) => sum + collectFolderSizes(child), 0);
            const total = folderEntry.hpAppRoot
                ? Number(folderEntry.size) || childrenTotal
                : childrenTotal;
            const folderPath = dependencies.normalizeFolderPath(dependencies.getEntryFolderPath(folderEntry));
            dependencies.state.folderSizeMap.set(folderPath, total);
            return total;
        };

        tree.forEach(node => collectFolderSizes(node));

        const renderTableNode = (node, depth, forceShowChildren) => {
            const isFolderNode = (node.entry && node.entry.is_folder === 1) || (!node.entry && node.children);
            if (isFolderNode) {
                const folderEntry = node.entry || buildSyntheticFolderEntry(node);
                const folderName = folderEntry.name || node.name || 'Folder';
                const matchesFolder = filter ? folderName.toLowerCase().includes(filter) : false;
                const shouldShow = !filter || forceShowChildren || matchesFolder || nodeHasMatch(node);
                if (!shouldShow) {
                    return false;
                }
                const folderPath = dependencies.normalizeFolderPath(dependencies.getEntryFolderPath(folderEntry));
                const expanded = dependencies.state.expandedFolders?.has(folderPath) || (filter && nodeHasMatch(node)) || forceShowChildren;
                const children = node.children || [];
                const childStats = children.reduce((acc, child) => {
                    const childIsFolder = (child.entry && child.entry.is_folder === 1) || (!child.entry && child.children);
                    if (childIsFolder) {
                        acc.folders += 1;
                    } else {
                        acc.files += 1;
                    }
                    return acc;
                }, { folders: 0, files: 0 });
                const summaryParts = [];
                if (childStats.folders) {
                    summaryParts.push(`${childStats.folders} subfolder${childStats.folders === 1 ? '' : 's'}`);
                }
                if (childStats.files) {
                    summaryParts.push(`${childStats.files} file${childStats.files === 1 ? '' : 's'}`);
                }
                const summary = summaryParts.length ? `contains ${summaryParts.join(' and ')}` : 'empty';
                const totalSize = dependencies.state.folderSizeMap.get(folderPath) ?? 0;
                const sizeLabel = `<em class="folder-size">(${dependencies.formatBytes(totalSize)} total)</em>`;
                renderTableRow(folderEntry, depth, { expanded, summary, sizeLabel });
                if (expanded) {
                    const sortedChildren = sortNodes(children);
                    const childForce = forceShowChildren || matchesFolder;
                    sortedChildren.forEach(child => {
                        renderTableNode(child, depth + 1, childForce);
                    });
                }
                return true;
            }

            if (node.entry) {
                if (!forceShowChildren && !entryMatchesFilter(node.entry)) {
                    return false;
                }
                renderTableRow(node.entry, depth);
                return true;
            }

            return false;
        };

        sortNodes(tree).forEach(node => {
            renderTableNode(node, 0, false);
        });
        dependencies.applySelectionKeys(selectionKeys, dependencies.els.varTableBody);
    }

    function getVariableTypeSortRank(entry) {
        if (entry.kind === 'app') {
            return 8;
        }
        const typeName = String(entry.type_name || '').toLowerCase();
        if (typeName.includes('program')) {
            return 0;
        }
        if (typeName.includes('python')) {
            return 1;
        }
        if (typeName.includes('list')) {
            return 2;
        }
        if (typeName.includes('matrix')) {
            return 3;
        }
        if (typeName.includes('equation')) {
            return 4;
        }
        if (typeName.includes('app var') || typeName.includes('appvar')) {
            return 5;
        }
        if (typeName.includes('real')) {
            return 6;
        }
        if (typeName.includes('string')) {
            return 7;
        }
        return 100;
    }

    function compareEntriesByDefaultFlatOrder(a, b) {
        const rankDiff = dependencies.getVariableTypeSortRank(a) - dependencies.getVariableTypeSortRank(b);
        if (rankDiff !== 0) {
            return rankDiff;
        }
        const nameDiff = String(a.name || '').localeCompare(String(b.name || ''));
        if (nameDiff !== 0) {
            return nameDiff;
        }
        return (Number(a.size) || 0) - (Number(b.size) || 0);
    }

    function compareEntries(a, b, key, dir) {
        const factor = dir === 'asc' ? 1 : -1;
        const getLocation = entry => entry.kind === 'app' ? 'Flash' : (entry.attr === 3 ? 'Archive' : 'RAM');
        const getSizeValue = (entry) => {
            if (entry.is_folder === 1) {
                const folderPath = dependencies.normalizeFolderPath(dependencies.getEntryFolderPath(entry));
                return dependencies.state.folderSizeMap?.get(folderPath) ?? 0;
            }
            return Number(entry.size) || 0;
        };
        const valueA = (() => {
            switch (key) {
                case 'name': return a.name || '';
                case 'type': return a.type_name || `Unknown (${a.type})`;
                case 'size': return getSizeValue(a);
                case 'location': return getLocation(a);
                case 'folder': return a.folder || '';
                default: return a.name || '';
            }
        })();
        const valueB = (() => {
            switch (key) {
                case 'name': return b.name || '';
                case 'type': return b.type_name || `Unknown (${b.type})`;
                case 'size': return getSizeValue(b);
                case 'location': return getLocation(b);
                case 'folder': return b.folder || '';
                default: return b.name || '';
            }
        })();

        if (typeof valueA === 'number' && typeof valueB === 'number') {
            const diff = (valueA - valueB) * factor;
            if (diff !== 0) {
                return diff;
            }
            return String(a.name || '').localeCompare(String(b.name || '')) * factor;
        }
        const diff = String(valueA).localeCompare(String(valueB)) * factor;
        if (diff !== 0) {
            return diff;
        }
        return String(a.name || '').localeCompare(String(b.name || '')) * factor;
    }

    function buildTree(entries) {
        const root = new Map();
        const ensureFolderPath = (path, entry = null) => {
            if (!path) {
                return;
            }
            const segments = path.split('/').filter(Boolean);
            let cursor = root;
            segments.forEach((seg, idx) => {
                if (!cursor.has(seg)) {
                    cursor.set(seg, { name: seg, children: new Map(), entries: [], isFolder: true, entry: null });
                }
                if (entry && idx === segments.length - 1) {
                    cursor.get(seg).entry = entry;
                }
                cursor = cursor.get(seg).children;
            });
        };
        entries.forEach(entry => {
            if (entry.is_folder === 1) {
                ensureFolderPath(dependencies.getEntryFolderPath(entry), entry);
                return;
            }
            const folder = entry.folder || '';
            ensureFolderPath(folder);
            const segments = folder ? folder.split('/') : [];
            let cursor = root;
            segments.forEach(seg => {
                cursor = cursor.get(seg).children;
            });
            if (!cursor.has('__entries__')) {
                cursor.set('__entries__', { entries: [] });
            }
            cursor.get('__entries__').entries.push(entry);
        });

        function mapToNodes(map, prefix) {
            const nodes = [];
            map.forEach((value, key) => {
                if (key === '__entries__') {
                    value.entries.forEach(entry => nodes.push({ entry }));
                } else {
                    const path = prefix ? `${prefix}/${value.name}` : value.name;
                    nodes.push({
                        name: value.name,
                        path,
                        children: mapToNodes(value.children, path),
                        entry: value.entry || null
                    });
                }
            });
            return nodes.sort((a, b) => (a.name || a.entry.name).localeCompare(b.name || b.entry.name));
        }

        return mapToNodes(root, '');
    }

    function getEntryFolderPath(entry) {
        const parent = entry.folder || '';
        if (entry.is_folder === 1) {
            return parent ? `${parent}/${entry.name}` : entry.name;
        }
        return parent;
    }

    return { renderDirlist, calcSupportsFolders, isListEntry, isMatrixEntry, isBuiltInListName, canPreviewVariable, getEntryExtension, getHPPrimePreviewKind, formatVariableDisplayName, renderTableView, getVariableTypeSortRank, compareEntriesByDefaultFlatOrder, compareEntries, buildTree, getEntryFolderPath };
}

module.exports = { createUiDirectory };
