'use strict';

/**
 * features converters. Browser and application dependencies are injected
 * by app.js; importing this module does not start the application.
 * @param {object} dependencies
 * @returns {object}
 */
function createFeaturesConverters(dependencies) {
    function loadPythonConverterModule(fileName, factoryName) {
        const moduleUrl = new dependencies.URL(fileName, dependencies.document.baseURI).href;
        return import(moduleUrl).then(imported => {
            const factory = imported.default;
            if (typeof factory !== 'function') {
                throw new Error(`${factoryName} factory is unavailable`);
            }
            return factory();
        });
    }

    function getTivarsLib() {
        if (!dependencies.tivarsLibPromise) {
            dependencies.tivarsLibPromise = dependencies.loadPythonConverterModule('TIVarsLib.js', 'TIVarsLib');
        }
        return dependencies.tivarsLibPromise;
    }

    function getWebLuna() {
        if (!dependencies.webLunaPromise) {
            dependencies.webLunaPromise = dependencies.loadPythonConverterModule('WebLuna.js', 'WebLuna');
        }
        return dependencies.webLunaPromise;
    }

    function sanitizePythonVarName(fileName) {
        const base = String(fileName || '').replace(/\.[^.]*$/, '');
        let name = base.toUpperCase().replace(/[^A-Z0-9_]/g, '');
        if (!/^[A-Z]/.test(name)) {
            name = `P${name}`;
        }
        name = name.slice(0, 8);
        return /^[A-Z][A-Z0-9_]{0,7}$/.test(name) ? name : 'PYTHON';
    }

    async function convertTivarsPythonSource(file, data, module, modelId, conversionKind) {
        const operationGeneration = dependencies.session.capture();
        const tivars = await dependencies.session.wait(dependencies.getTivarsLib(), operationGeneration);
        const varName = dependencies.sanitizePythonVarName(file.name);
        const modelName = conversionKind === dependencies.PYTHON_CONVERSION_EVO
            ? dependencies.EVO_PYTHON_CALC_MODELS.get(modelId)
            : dependencies.CE_PYTHON_CALC_MODELS.get(modelId);
        if (!modelName) {
            return '';
        }

        const source = new dependencies.TextDecoder('utf-8').decode(data);
        const variable = tivars.TIVarFile.createNew('PythonAppVar', varName, modelName);
        let converterPath = '';
        try {
            if (conversionKind === dependencies.PYTHON_CONVERSION_EVO) {
                variable.setContentFromString(source);
            } else {
                variable.setContentFromString(JSON.stringify({
                    typeName: 'PythonAppVar',
                    filename: `${varName}.py`,
                    code: source
                }));
            }
            converterPath = variable.saveVarToFile('.', varName);
            const converted = tivars.FS.readFile(converterPath, { encoding: 'binary' });
            const extension = conversionKind === dependencies.PYTHON_CONVERSION_EVO ? '8xpy2' : '8xv';
            const outputPath = `/uploads/${varName}.${extension}`;
            module.FS.writeFile(outputPath, converted);
            return outputPath;
        } finally {
            if (converterPath) {
                try {
                    tivars.FS.unlink(converterPath);
                } catch {
                    // ignore
                }
            }
            if (typeof variable.delete === 'function') {
                variable.delete();
            }
        }
    }

    async function convertNspireScriptSource(file, data, module) {
        const operationGeneration = dependencies.session.capture();
        const luna = await dependencies.session.wait(dependencies.getWebLuna(), operationGeneration);
        const inputName = String(file.name || 'python.py').replace(/[\\/]/g, '_');
        const outputName = inputName.replace(/\.[^.]*$/, '') + '.tns';
        const inputPath = `/${inputName}`;
        const converterPath = `/${outputName}`;
        try {
            luna.FS.writeFile(inputPath, data, { encoding: 'binary' });
            try {
                luna.FS.unlink(converterPath);
            } catch {
                // ignore
            }
            const result = luna.callMain([inputPath, converterPath]);
            if (result !== 0) {
                throw new Error(`Luna exited with status ${result}`);
            }
            const converted = luna.FS.readFile(converterPath, { encoding: 'binary' });
            const outputPath = `/uploads/${outputName}`;
            module.FS.writeFile(outputPath, converted);
            return outputPath;
        } finally {
            for (const path of [inputPath, converterPath]) {
                try {
                    luna.FS.unlink(path);
                } catch {
                    // ignore
                }
            }
        }
    }

    async function convertPythonSourceForCalc(file, data, module, modelId, conversionKind) {
        if (conversionKind === dependencies.PYTHON_CONVERSION_CE || conversionKind === dependencies.PYTHON_CONVERSION_EVO) {
            return dependencies.convertTivarsPythonSource(file, data, module, modelId, conversionKind);
        }
        if (conversionKind === dependencies.PYTHON_CONVERSION_NSPIRE_CXII) {
            return dependencies.convertNspireScriptSource(file, data, module);
        }
        return '';
    }

    function validatePythonBytecode(file, data, conversionKind) {
        const targets = {
            [dependencies.PYTHON_CONVERSION_CE]: { header: [3, 2], label: 'CE Python (MPY v3)' },
            [dependencies.PYTHON_CONVERSION_EVO]: { header: [5, 3], label: 'Evo (MPY v5)' },
            [dependencies.PYTHON_CONVERSION_NSPIRE_CXII]: { header: [4, 3], label: 'TI-Nspire CX II (MPY v4)' }
        };
        const target = targets[conversionKind];
        if (!target) {
            throw new Error(dependencies.tFormat('mpy_unsupported_target', { file: file.name }));
        }
        if (data.length <= 4 || data[0] !== 0x4d || data[1] !== target.header[0]
            || data[2] !== target.header[1] || data[3] < 1 || data[3] > 31) {
            throw new Error(dependencies.tFormat('mpy_incompatible', { file: file.name, target: target.label }));
        }
        const name = file.name.replace(/\.mpy$/i, '');
        const nspire = conversionKind === dependencies.PYTHON_CONVERSION_NSPIRE_CXII;
        if (!(nspire ? /^[A-Za-z0-9_]{1,240}$/ : /^[A-Za-z][A-Za-z0-9_]{0,7}$/).test(name)) {
            throw new Error(dependencies.tFormat('mpy_invalid_name', {
                file: file.name,
                rule: dependencies.t(nspire ? 'mpy_name_rule_nspire' : 'mpy_name_rule_short')
            }));
        }
        return name;
    }

    async function packagePythonBytecode(file, data, module, modelId, conversionKind) {
        const operationGeneration = dependencies.session.capture();
        const name = dependencies.validatePythonBytecode(file, data, conversionKind);
        if (conversionKind === dependencies.PYTHON_CONVERSION_NSPIRE_CXII) {
            const luna = await dependencies.session.wait(dependencies.getWebLuna(), operationGeneration);
            const inputPath = `/${name}.mpy`;
            // A separate editor page can import the module without a same-name .py
            // source shadowing its bytecode. Luna references the first .py argument.
            const launcherPath = name.toLowerCase() === 'main' ? '/run.py' : '/main.py';
            const converterPath = `/${name}.tns`;
            try {
                luna.FS.writeFile(inputPath, data, { encoding: 'binary' });
                luna.FS.writeFile(launcherPath, new dependencies.TextEncoder().encode(`__import__('${name}')\n`));
                if (luna.FS.analyzePath(converterPath).exists) luna.FS.unlink(converterPath);
                const result = luna.callMain([launcherPath, inputPath, converterPath]);
                if (result !== 0) throw new Error(`Luna exited with status ${result}`);
                const outputPath = `/uploads/${name}.tns`;
                module.FS.writeFile(outputPath, luna.FS.readFile(converterPath, { encoding: 'binary' }));
                return outputPath;
            } finally {
                for (const path of [inputPath, launcherPath, converterPath]) {
                    try { luna.FS.unlink(path); } catch { /* Already absent. */ }
                }
            }
        }

        const tivars = await dependencies.session.wait(dependencies.getTivarsLib(), operationGeneration);
        const evo = conversionKind === dependencies.PYTHON_CONVERSION_EVO;
        const varName = name.toUpperCase();
        const modelName = (evo ? dependencies.EVO_PYTHON_CALC_MODELS : dependencies.CE_PYTHON_CALC_MODELS).get(modelId);
        let variable;
        let converterPath = '';
        try {
            variable = tivars.TIVarFile.createNew(evo ? 'PythonAppVar' : 'PythonModuleAppVar', varName, modelName);
            const bytecodeHex = Array.from(data, byte => byte.toString(16).padStart(2, '0')).join('');
            variable.setContentFromString(JSON.stringify(evo
                ? { python: { compiledModule: true, name, bodyHex: bytecodeHex } }
                : { typeName: 'PythonModuleAppVar', filename: name, compiledDataHex: bytecodeHex }));
            if (evo) variable.convertToEvoPythonFormat('8mp2');
            if (!evo && variable.getRawContentHexStr().length / 2 > 65535 - 17) {
                throw new Error(dependencies.tFormat('mpy_ce_too_large', { file: file.name }));
            }
            variable.setArchived(true);
            converterPath = variable.saveVarToFile('.', varName);
            const outputPath = `/uploads/${varName}.${evo ? '8mp2' : '8xv'}`;
            module.FS.writeFile(outputPath, tivars.FS.readFile(converterPath, { encoding: 'binary' }));
            return outputPath;
        } catch (error) {
            if (error?.staleSession) throw error;
            throw new Error(`${file.name}: ${dependencies.formatTivarsException(tivars, error)}`);
        } finally {
            if (converterPath) {
                try { tivars.FS.unlink(converterPath); } catch { /* Already absent. */ }
            }
            variable?.delete();
        }
    }

    function isLegacyTivarsConversionCandidate(fileName) {
        const match = String(fileName || '').toLowerCase().match(/\.([^.]+)$/);
        const extension = match?.[1] || '';
        return dependencies.LEGACY_TIVARS_EXTENSION_RE.test(extension)
            && !dependencies.LEGACY_TIVARS_FLASH_EXTENSIONS.has(extension);
    }

    async function convertLegacyTivarsFileForEvo(file, data, module, modelId) {
        const operationGeneration = dependencies.session.capture();
        const modelName = dependencies.EVO_PYTHON_CALC_MODELS.get(modelId);
        if (!modelName || !dependencies.isLegacyTivarsConversionCandidate(file.name)) {
            return '';
        }

        const tivars = await dependencies.session.wait(dependencies.getTivarsLib(), operationGeneration);
        const safeInputName = String(file.name || 'variable.8x?').replace(/[\\/]/g, '_');
        const outputBaseName = safeInputName.replace(/\.[^.]*$/, '') || 'VARIABLE';
        const inputPath = `/evo-input-${Date.now()}-${safeInputName}`;
        let outputPath = '';
        let variable = null;
        try {
            tivars.FS.writeFile(inputPath, data, { encoding: 'binary' });
            variable = tivars.TIVarFile.loadFromFile(inputPath);
            if (variable.isEvoFormat()) {
                return '';
            }
            variable.convertToModel(modelName, true);
            outputPath = variable.saveVarToFile('.', outputBaseName);
            const converted = tivars.FS.readFile(outputPath, { encoding: 'binary' });
            const outputName = outputPath.split('/').pop() || `${safeInputName}2`;
            const modulePath = `/uploads/${outputName}`;
            module.FS.writeFile(modulePath, converted);
            return modulePath;
        } finally {
            for (const path of [inputPath, outputPath]) {
                if (!path) {
                    continue;
                }
                try {
                    tivars.FS.unlink(path);
                } catch {
                    // ignore
                }
            }
            if (variable && typeof variable.delete === 'function') {
                variable.delete();
            }
        }
    }

    async function convertReceivedPythonFile(filename, data) {
        const operationGeneration = dependencies.session.capture();
        if (dependencies.state.settings?.convertScriptFiles === false) {
            return null;
        }
        const conversionKind = dependencies.getPythonConversionKind(dependencies.getActiveCalcModelId());
        const isCeCandidate = conversionKind === dependencies.PYTHON_CONVERSION_CE && /\.8xv$/i.test(filename);
        const isEvoCandidate = conversionKind === dependencies.PYTHON_CONVERSION_EVO && /\.8xpy2$/i.test(filename);
        if (!isCeCandidate && !isEvoCandidate) {
            return null;
        }

        const safeInputName = String(filename || 'python-var').replace(/[\\/]/g, '_');
        const converterPath = `/${safeInputName}`;
        let tivars = null;
        let variable = null;
        let options = null;
        try {
            tivars = await dependencies.session.wait(dependencies.getTivarsLib(), operationGeneration);
            tivars.FS.writeFile(converterPath, data, { encoding: 'binary' });
            variable = tivars.TIVarFile.loadFromFile(converterPath);
            options = new tivars.options_t();
            options.set('metadata', 1);
            const metadata = JSON.parse(variable.getReadableContent(options));

            let source = '';
            let sourceName = '';
            if (isCeCandidate && metadata.typeName === 'PythonAppVar' && typeof metadata.code === 'string') {
                source = metadata.code;
                sourceName = metadata.filename || safeInputName.replace(/\.[^.]*$/, '');
            } else if (isEvoCandidate
                && metadata.typeName === 'PythonScript'
                && metadata.python?.compiledModule === false
                && typeof metadata.python.code === 'string') {
                source = metadata.python.code;
                sourceName = metadata.python.name || safeInputName.replace(/\.[^.]*$/, '');
            } else {
                return null;
            }

            sourceName = String(sourceName).replace(/[\\/]/g, '_');
            if (!/\.py$/i.test(sourceName)) {
                sourceName += '.py';
            }
            return {
                filename: sourceName,
                data: new dependencies.TextEncoder().encode(source)
            };
        } catch {
            return null;
        } finally {
            if (options && typeof options.delete === 'function') {
                options.delete();
            }
            if (variable && typeof variable.delete === 'function') {
                variable.delete();
            }
            if (tivars) {
                try {
                    tivars.FS.unlink(converterPath);
                } catch {
                    // ignore
                }
            }
        }
    }

    return { loadPythonConverterModule, getTivarsLib, getWebLuna, sanitizePythonVarName, convertTivarsPythonSource, convertNspireScriptSource, convertPythonSourceForCalc, validatePythonBytecode, packagePythonBytecode, isLegacyTivarsConversionCandidate, convertLegacyTivarsFileForEvo, convertReceivedPythonFile };
}

module.exports = { createFeaturesConverters };
