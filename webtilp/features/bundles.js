'use strict';

/**
 * features bundles. Browser and application dependencies are injected
 * by app.js; importing this module does not start the application.
 * @param {object} dependencies
 * @returns {object}
 */
function createFeaturesBundles(dependencies) {
    function parseLanguageId(rawValue) {
        if (!rawValue) {
            return null;
        }
        const match = String(rawValue).match(/\d+/);
        if (!match) {
            return null;
        }
        const value = Number(match[0]);
        return Number.isFinite(value) ? value : null;
    }

    function formatLanguageIdHtml(rawValue) {
        const code = dependencies.parseLanguageId(rawValue);
        if (code == null) {
            return dependencies.escapeHtml(String(rawValue || ''));
        }
        const name = dependencies.TI_LANG_CODES[code];
        if (name) {
            return `<abbr title="${code}">${name}</abbr>`;
        }
        return dependencies.escapeHtml(String(code));
    }

    function getDeviceInfoValue(label) {
        if (!label) {
            return '';
        }
        const target = String(label).trim().toLowerCase();
        if (!dependencies.state.deviceInfoEntries?.length) {
            return '';
        }
        const entry = dependencies.state.deviceInfoEntries.find(item => String(item.key || '').trim().toLowerCase() === target);
        return entry?.value ?? '';
    }

    function getLanguageIdValue() {
        const raw = dependencies.getDeviceInfoValue('Language ID');
        return dependencies.parseLanguageId(raw);
    }

    function isCeBundleFile(file) {
        return Boolean(file && dependencies.BUNDLE_EXT_RE.test(file.name || ''));
    }

    function isCEModelConnected() {
        const name = (dependencies.getActiveCalcModelString() || dependencies.state.deviceInfoProductName || dependencies.state.deviceModelName || dependencies.state.authorizedDevice?.productName || '')
            .toLowerCase()
            .trim();
        if (!name) {
            return false;
        }
        return name.startsWith('ti-83 premium ce') || name.startsWith('ti-84 plus ce');
    }

    function is83PCEConnected() {
        const name = (dependencies.getActiveCalcModelString() || dependencies.state.deviceInfoProductName || dependencies.state.deviceModelName || dependencies.state.authorizedDevice?.productName || '')
            .toLowerCase()
            .trim();
        if (!name) {
            return false;
        }
        return name.startsWith('ti-83 premium ce');
    }

    function getExistingLanguageApps() {
        const langs = new Set();
        const targets = dependencies.BUNDLE_LANGUAGE_APPS.map(name => name.toLowerCase());
        dependencies.state.dirlist.forEach(entry => {
            if (!entry || entry.is_folder === 1) {
                return;
            }
            const base = String(entry.name || '').toLowerCase();
            if (targets.includes(base)) {
                langs.add(base);
            }
        });
        return langs;
    }

    function applyBundleDefaults(plan) {
        const pythonOnBoard = dependencies.getDeviceInfoValue('Python on board') === 'Yes';
        const is83PCE = dependencies.is83PCEConnected();
        const languageId = dependencies.getLanguageIdValue();
        const preferredLang = languageId != null ? (dependencies.TI_LANG_CODES[languageId] || '') : '';
        const preferredLangLower = preferredLang.toLowerCase();
        const existingLangs = dependencies.getExistingLanguageApps();
        const languageTargets = new Set(dependencies.BUNDLE_LANGUAGE_APPS.map(name => name.toLowerCase()));

        plan.forEach(item => {
            const base = String(item.file?.name || '')
                .replace(/\.[^.]+$/, '')
                .toLowerCase();
            item.selected = true;

            if (base === 'python') {
                item.selected = pythonOnBoard;
                return;
            }
            if (base === 'pyadaptr') {
                item.selected = !pythonOnBoard && is83PCE;
                return;
            }
            if (languageTargets.has(base)) {
                if (existingLangs.has(base)) {
                    item.selected = true;
                } else if (preferredLangLower && base === preferredLangLower) {
                    item.selected = true;
                } else {
                    item.selected = false;
                }
            }
        });
    }

    function isCEBundleOSFile(item) {
        if (!item?.file?.name) {
            return false;
        }
        if (item.fileClass === 'os') {
            return true;
        }
        return /\.8[ep]u$/i.test(item.file.name);
    }

    async function extractBundleFiles(bundleFile, module) {
        if (!module.FS.analyzePath('/uploads').exists) {
            module.FS.mkdir('/uploads');
        }
        const data = new dependencies.Uint8Array(await bundleFile.arrayBuffer());
        const bundlePath = `/uploads/${bundleFile.name}`;
        module.FS.writeFile(bundlePath, data);

        if (!module.FS.analyzePath('/tmp_bundle').exists) {
            module.FS.mkdir('/tmp_bundle');
        }
        const bundleDir = `/tmp_bundle/${Date.now()}_${Math.random().toString(16).slice(2)}`;
        module.FS.mkdir(bundleDir);

        let parsed = null;
        const infoText = await dependencies.ccallAsync(
            module,
            'bundle_extract_json',
            'string',
            ['string', 'string'],
            [bundlePath, bundleDir],
            { timeoutMs: 15000 }
        );
        if (infoText && typeof infoText === 'string') {
            try {
                parsed = JSON.parse(infoText);
            } catch (err) {
                dependencies.console.warn('[WebTILP] Failed to parse bundle JSON', err);
            }
        }
        const files = Array.isArray(parsed?.files) ? parsed.files : [];
        return { bundlePath, bundleDir, files };
    }

    async function handleCeBundleTransfer(bundleFile, module, options) {
        if (!dependencies.isCEModelConnected()) {
            dependencies.alert(dependencies.t('alert_bundle_ce_only'));
            return null;
        }

        const cleanupPaths = [];
        let bundleDir = '';
        try {
            const extracted = await dependencies.extractBundleFiles(bundleFile, module);
            bundleDir = extracted.bundleDir;
            cleanupPaths.push(extracted.bundlePath);

            if (!extracted.files.length) {
                dependencies.alert(dependencies.t('alert_bundle_no_transferable_files'));
                return null;
            }

            const plan = await dependencies.buildTransferPlanFromFsEntries(extracted.files, module);
            extracted.files.forEach(item => {
                if (item.path) {
                    cleanupPaths.push(item.path);
                }
            });
            dependencies.applyBundleDefaults(plan);

            const modalResult = await dependencies.openTransferModal(plan, {
                hasFolder: options.hasFolder,
                hasArchive: options.hasArchive,
                folders: options.folders
            });
            if (!modalResult) {
                return null;
            }
            const { selections, overwriteAll } = modalResult;

            const nonOs = selections.filter(item => !dependencies.isCEBundleOSFile(item));
            const osItems = selections.filter(item => dependencies.isCEBundleOSFile(item));
            const orderedSelections = nonOs.concat(osItems);

            const { successCount } = await dependencies.performTransfers(orderedSelections, module, {
                hasFolder: options.hasFolder,
                hasArchive: options.hasArchive,
                overwriteAll
            });

            orderedSelections.forEach(item => {
                try {
                    module.FS.unlink(item.path);
                } catch {
                    // ignore
                }
            });

            const hasOs = orderedSelections.some(item => dependencies.isCEBundleOSFile(item));
            if (successCount > 0 && !hasOs) {
                await dependencies.refreshDirlist();
            }
            return { successCount, hasOs };
        } finally {
            cleanupPaths.forEach(path => {
                try {
                    module.FS.unlink(path);
                } catch {
                    // ignore
                }
            });
            if (bundleDir) {
                try {
                    module.FS.rmdir(bundleDir);
                } catch {
                    // ignore
                }
            }
        }
    }

    return { parseLanguageId, formatLanguageIdHtml, getDeviceInfoValue, getLanguageIdValue, isCeBundleFile, isCEModelConnected, is83PCEConnected, getExistingLanguageApps, applyBundleDefaults, isCEBundleOSFile, extractBundleFiles, handleCeBundleTransfer };
}

module.exports = { createFeaturesBundles };
