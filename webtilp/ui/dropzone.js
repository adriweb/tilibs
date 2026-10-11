'use strict';

/**
 * ui dropzone. Browser and application dependencies are injected
 * by app.js; importing this module does not start the application.
 * @param {object} dependencies
 * @returns {object}
 */
function createUiDropzone(dependencies) {
    function clearDropHighlight() {
        if (dependencies.currentDropTarget) {
            dependencies.currentDropTarget.classList.remove('drop-target');
            dependencies.currentDropTarget = null;
        }
    }

    function setDropHighlight(target) {
        if (!target || target === dependencies.currentDropTarget) {
            return;
        }
        dependencies.clearDropHighlight();
        dependencies.currentDropTarget = target;
        dependencies.currentDropTarget.classList.add('drop-target');
    }

    function hasFileDrag(event) {
        const dt = event.dataTransfer;
        if (!dt) {
            return false;
        }
        const types = dt.types ? Array.from(dt.types) : [];
        if (types.includes('Files')) {
            return true;
        }
        if (dt.files && dt.files.length) {
            return true;
        }
        if (dt.items && dt.items.length) {
            return Array.from(dt.items).some(item => item.kind === 'file');
        }
        return false;
    }

    function setDropzoneActive(active) {
        if (dependencies.dropzoneActive === active) {
            return;
        }
        dependencies.dropzoneActive = active;
        const dropzone = dependencies.document.getElementById('dropzone');
        if (dropzone) {
            dropzone.classList.toggle('drag-over', active);
        }
    }

    function getDroppedFiles(event) {
        const files = event.dataTransfer?.files;
        if (files && files.length) {
            return Array.from(files);
        }
        const items = event.dataTransfer?.items;
        if (!items || !items.length) {
            return [];
        }
        const result = [];
        Array.from(items).forEach(item => {
            if (item.kind === 'file') {
                const file = item.getAsFile();
                if (file) {
                    result.push(file);
                }
            }
        });
        return result;
    }

    function ensureFolderSticky() {
        if (!dependencies.els.folderSticky) {
            return;
        }
        if (dependencies.els.folderSticky.dataset.ready) {
            return;
        }
        dependencies.els.folderSticky.dataset.ready = '1';
        dependencies.els.folderSticky.innerHTML = `
            <table class="var-table">
                <colgroup>
                    <col><col><col><col><col><col><col>
                </colgroup>
                <tbody></tbody>
            </table>
        `;
    }

    function updateStickyFolderHeader() {
        if (!dependencies.els.folderSticky || !dependencies.els.tableView) {
            return;
        }
        dependencies.ensureFolderSticky();
        const headerRow = dependencies.els.tableView.querySelector('thead');
        const table = dependencies.els.tableView.querySelector('table');
        if (!table) {
            dependencies.els.folderSticky.classList.add('hidden');
            return;
        }
        const headerHeight = headerRow ? (headerRow.offsetHeight - 1) : 0;
        dependencies.els.folderSticky.style.top = `${headerHeight}px`;

        const allRows = Array.from(dependencies.els.varTableBody.querySelectorAll('tr'));
        const folderRows = allRows.filter(row => row.dataset.isFolder === '1');
        if (!folderRows.length) {
            dependencies.els.folderSticky.classList.add('hidden');
            return;
        }
        const scrollTop = dependencies.els.tableView.scrollTop + headerHeight;
        let current = null;
        for (const row of folderRows) {
            if (row.offsetTop <= scrollTop) {
                current = row;
            } else {
                break;
            }
        }
        if (!current) {
            dependencies.els.folderSticky.classList.add('hidden');
            dependencies.stickyVisible = false;
            dependencies.state.stickyPath = '';
            return;
        }

        const lastRow = allRows[allRows.length - 1];
        if (lastRow && (lastRow.offsetTop + lastRow.offsetHeight) <= scrollTop) {
            dependencies.els.folderSticky.classList.add('hidden');
            dependencies.stickyVisible = false;
            dependencies.state.stickyPath = '';
            return;
        }

        const currentDepth = Number(current.dataset.depth || 0);
        const currentIndex = allRows.indexOf(current);
        let boundary = Number.POSITIVE_INFINITY;
        for (let i = currentIndex + 1; i < allRows.length; i++) {
            const nextRow = allRows[i];
            const nextDepth = Number(nextRow.dataset.depth || 0);
            if (nextDepth <= currentDepth) {
                boundary = nextRow.offsetTop;
                break;
            }
        }
        const buffer = 8;
        dependencies.stickyHideThreshold = Number.isFinite(boundary) ? boundary + buffer : null;
        if (dependencies.stickyHideThreshold != null && scrollTop >= dependencies.stickyHideThreshold) {
            if (dependencies.stickyVisible) {
                dependencies.els.folderSticky.classList.add('hidden');
                dependencies.stickyVisible = false;
            }
            return;
        }

        const folderInput = current.querySelector('input[type="checkbox"]');
        const fullPath = folderInput?.dataset.folderPath || '';
        if (fullPath === dependencies.state.stickyPath && dependencies.stickyVisible) {
            const headerCells = table.querySelectorAll('thead th');
            if (table.offsetWidth !== dependencies.state.stickyTableWidth || headerCells.length !== dependencies.state.stickyHeaderWidths.length) {
                dependencies.state.stickyTableWidth = table.offsetWidth;
                dependencies.state.stickyHeaderWidths = Array.from(headerCells).map(cell => cell.offsetWidth);
            } else {
                return;
            }
        }
        const parts = fullPath.split('/').filter(Boolean);
        const tbody = dependencies.els.folderSticky.querySelector('tbody');
        if (!tbody) {
            return;
        }
        tbody.innerHTML = '';
        const folderGlyph = dependencies.themeIconMarkup('folder', '📂');
        const label = parts.length ? `${folderGlyph} ${dependencies.escapeHtml(parts.join(' > '))}` : folderGlyph;
        const padCell = current.querySelector('td');
        const padWidth = padCell ? padCell.offsetWidth : 0;
        const tr = dependencies.document.createElement('tr');
        tr.innerHTML = `
            <td style="${padWidth ? `width:${padWidth}px;min-width:${padWidth}px;` : ''}"></td>
            <td class="folder-sticky-name" colspan="6">
                <div class="name-cell">
                    <div class="name-left"><span class="name-label">${label}</span></div>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
        dependencies.els.folderSticky.classList.remove('hidden');
        dependencies.stickyVisible = true;
        dependencies.state.stickyPath = fullPath;

        const headerCells = table.querySelectorAll('thead th');
        const stickyTable = dependencies.els.folderSticky.querySelector('table');
        const colgroup = stickyTable ? stickyTable.querySelector('colgroup') : null;
        if (stickyTable) {
            stickyTable.style.width = `${table.offsetWidth}px`;
            dependencies.state.stickyTableWidth = table.offsetWidth;
        }
        if (colgroup) {
            const cols = colgroup.querySelectorAll('col');
            headerCells.forEach((cell, idx) => {
                if (cols[idx]) {
                    cols[idx].style.width = `${cell.offsetWidth}px`;
                }
            });
            dependencies.state.stickyHeaderWidths = Array.from(headerCells).map(cell => cell.offsetWidth);
        }
    }

    function scheduleStickyUpdate() {
        if (dependencies.stickyUpdateScheduled) {
            return;
        }
        dependencies.stickyUpdateScheduled = true;
        dependencies.requestAnimationFrame(() => {
            dependencies.stickyUpdateScheduled = false;
            dependencies.updateStickyFolderHeader();
        });
    }

    return { clearDropHighlight, setDropHighlight, hasFileDrag, setDropzoneActive, getDroppedFiles, ensureFolderSticky, updateStickyFolderHeader, scheduleStickyUpdate };
}

module.exports = { createUiDropzone };
