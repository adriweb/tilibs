'use strict';

/**
 * features transfer-plan. Browser and application dependencies are injected
 * by app.js; importing this module does not start the application.
 * @param {object} dependencies
 * @returns {object}
 */
function createFeaturesTransferPlan(dependencies) {
    async function buildTransferPlan(files, module) {
        const operationGeneration = dependencies.session.capture();
        if (!module.FS.analyzePath('/uploads').exists) {
            module.FS.mkdir('/uploads');
        }

        const uploadPaths = [];
        const activeModelId = dependencies.getActiveCalcModelId();
        const pythonConversionKind = dependencies.getPythonConversionKind(activeModelId);
        for (const file of files) {
            const data = new dependencies.Uint8Array(await dependencies.session.wait(file.arrayBuffer(), operationGeneration));
            if (/\.mpy$/i.test(file.name)) {
                if (dependencies.state.settings?.convertScriptFiles === false) {
                    throw new Error(dependencies.tFormat('mpy_conversion_disabled', { file: file.name }));
                }
                // Bytecode incompatibility or packaging errors must abort the batch;
                // sending a raw .mpy as a calculator container cannot be a fallback.
                uploadPaths.push(await dependencies.session.wait(dependencies.packagePythonBytecode(file, data, module, activeModelId, pythonConversionKind), operationGeneration));
                continue;
            }
            const path = `/uploads/${file.name}`;
            module.FS.writeFile(path, data);
            const convertPython = dependencies.state.settings?.convertScriptFiles !== false
                && pythonConversionKind !== dependencies.PYTHON_CONVERSION_NONE
                && /\.py$/i.test(file.name);
            const convertLua = dependencies.state.settings?.convertScriptFiles !== false
                && dependencies.NSPIRE_LUA_CALC_MODELS.has(activeModelId)
                && /\.lua$/i.test(file.name);
            if (convertPython || convertLua) {
                try {
                    const convertedPath = convertLua
                        ? await dependencies.session.wait(dependencies.convertNspireScriptSource(file, data, module), operationGeneration)
                        : await dependencies.session.wait(dependencies.convertPythonSourceForCalc(
                            file,
                            data,
                            module,
                            activeModelId,
                            pythonConversionKind
                        ), operationGeneration);
                    if (convertedPath && convertedPath !== path) {
                        try {
                            module.FS.unlink(path);
                        } catch {
                            // ignore
                        }
                        uploadPaths.push(convertedPath);
                        continue;
                    }
                } catch (err) {
            if (err?.staleSession) throw err;
                    dependencies.console.warn(`[WebTILP] Failed to convert ${file.name}; trying the original file`, err);
                }
            }
            if (dependencies.EVO_PYTHON_CALC_MODELS.has(activeModelId)
                && dependencies.isLegacyTivarsConversionCandidate(file.name)) {
                try {
                    const convertedPath = await dependencies.session.wait(dependencies.convertLegacyTivarsFileForEvo(file, data, module, activeModelId), operationGeneration);
                    if (convertedPath && convertedPath !== path) {
                        try {
                            module.FS.unlink(path);
                        } catch {
                            // ignore
                        }
                        uploadPaths.push(convertedPath);
                        continue;
                    }
                } catch (err) {
            if (err?.staleSession) throw err;
                    dependencies.console.warn(`[WebTILP] Failed to convert ${file.name} for Evo; trying the original file`, err);
                }
            }
            uploadPaths.push(path);
        }

        if (!uploadPaths.length) {
            return [];
        }

        // Source conversion can give different inputs the same destination name.
        // Reject the batch before creating a plan that would send the last payload twice.
        const destinationNames = new Set();
        for (const path of uploadPaths) {
            const name = path.split('/').pop();
            const key = name.toLowerCase();
            if (destinationNames.has(key)) {
                throw new Error(dependencies.tFormat('source_conversion_name_conflict', { name }));
            }
            destinationNames.add(key);
        }

        let entries = [];
        try {
            const infoText = await dependencies.session.wait(dependencies.ccallAsync(
                module,
                'files_get_entries_json',
                'string',
                ['string'],
                [uploadPaths.join('\n')],
                { timeoutMs: 12000 }
            ), operationGeneration);
            if (infoText && typeof infoText === 'string') {
                const parsed = JSON.parse(infoText);
                entries = Array.isArray(parsed?.files) ? parsed.files : [];
            }
        } catch (err) {
            if (err?.staleSession) throw err;
            dependencies.console.warn('[WebTILP] Failed to parse batch file info', err);
        }

        // Keep modal fast and robust: complete missing metadata entries locally.
        const byPath = new Map(entries.map(item => [item.path, item]));
        const normalizedEntries = uploadPaths.map(path => {
            const existing = byPath.get(path);
            if (existing) {
                return existing;
            }
            const name = path.split('/').pop() || path;
            return { name, path, class: 'unknown', entries: [] };
        });
        return dependencies.buildTransferPlanFromFsEntries(normalizedEntries, module);
    }

    async function buildTransferPlanFromFsEntries(entries, module) {
        const plan = [];
        for (const entry of entries) {
            const path = entry.path;
            const name = entry.name;
            if (!path || !name) {
                continue;
            }
            let size = 0;
            try {
                size = module.FS.stat(path).size;
            } catch {
                size = 0;
            }
            const file = { name, size };

            const fileClass = entry.class || 'unknown';
            const entriesInfo = Array.isArray(entry.entries) ? entry.entries : [];
            const baseName = name.replace(/\.[^.]+$/, '');

            if (!entriesInfo.length) {
                plan.push({
                    file,
                    path,
                    fileClass,
                    sourceFileClass: fileClass,
                    entries: [],
                    entryCount: 0,
                    entryName: baseName,
                    entryType: null,
                    entryTypeName: '',
                    entryFolder: '',
                    entryAttr: 0,
                    entrySize: null,
                    defaultLocation: 'ram',
                    locationMask: 3,
                    locationMode: 'ram',
                    sendByEntry: false,
                    entryIndex: null,
                    containerKind: 0
                });
                continue;
            }

            entriesInfo.forEach((entryInfo, idx) => {
                const containerType = entryInfo.container_type || '';
                const containerKind = containerType === 'app' ? 2 : (containerType === 'var' ? 1 : 0);
                const entryIndex = Number.isInteger(entryInfo.container_index) ? entryInfo.container_index : idx;
                const effectiveClass = containerType === 'app'
                    ? 'application'
                    : (fileClass === 'group' || fileClass === 'tigroup' ? 'single' : fileClass);
                const defaultName = entryInfo.name || baseName;
                const defaultFolder = entryInfo.folder || '';
                const entrySize = Number.isFinite(Number(entryInfo.size)) ? Number(entryInfo.size) : null;
                const locationMask = entryInfo.location_mask ?? (effectiveClass === 'application' ? 2 : 3);
                const defaultLocation = (entryInfo.attr === 3 || locationMask === 2) ? 'archive' : 'ram';
                const locationMode = locationMask === 1
                    ? 'ram'
                    : (locationMask === 2 ? 'archive' : (locationMask === 0 ? 'auto' : defaultLocation));

                plan.push({
                    file,
                    path,
                    fileClass: effectiveClass,
                    sourceFileClass: fileClass,
                    entries: [entryInfo],
                    entryCount: 1,
                    entryName: defaultName,
                    entryType: entryInfo.type ?? null,
                    entryTypeName: entryInfo.type_name ?? '',
                    entryFolder: defaultFolder,
                    entryAttr: entryInfo.attr ?? 0,
                    entrySize,
                    defaultLocation,
                    locationMask,
                    locationMode,
                    sendByEntry: entriesInfo.length > 1 || fileClass === 'group' || fileClass === 'tigroup',
                    entryIndex,
                    containerKind
                });
            });
        }
        return plan;
    }

    return { buildTransferPlan, buildTransferPlanFromFsEntries };
}

module.exports = { createFeaturesTransferPlan };
