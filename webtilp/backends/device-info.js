'use strict';

/**
 * backends device-info. Browser and application dependencies are injected
 * by app.js; importing this module does not start the application.
 * @param {object} dependencies
 * @returns {object}
 */
function createBackendsDeviceInfo(dependencies) {
    function applyCasioStorageSnapshot(module) {
        const filesText = module.ccall('casio_get_files_json', 'string', [], []);
        const files = JSON.parse(filesText || '[]');
        dependencies.state.features = dependencies.state.casioStorageSupported
            ? dependencies.FEATURE_FLAGS.FTS_FOLDER | dependencies.FEATURE_FLAGS.OPS_RENAME
                | dependencies.FEATURE_FLAGS.OPS_DELVAR
            : 0;
        dependencies.state.dirlist = files.map(entry => ({
            ...entry,
            type_name: entry.is_folder === 1
                ? dependencies.t('casio_type_directory') : dependencies.t('casio_type_storage_file')
        }));
        dependencies.state.casioFileSnapshotLoaded = true;
        dependencies.renderDirlist(dependencies.state.dirlist);
        return dependencies.state.dirlist.length;
    }

    function readCasioInfo(module) {
        const infoText = module.ccall('casio_get_info_json', 'string', [], []);
        if (!infoText) {
            throw new Error(dependencies.t('casio_info_unavailable'));
        }
        const info = JSON.parse(infoText);
        dependencies.state.casioStorageSupported = Boolean(info.storageSupported);
        dependencies.state.features = dependencies.state.casioStorageSupported
            ? dependencies.FEATURE_FLAGS.FTS_FOLDER | dependencies.FEATURE_FLAGS.OPS_RENAME
                | dependencies.FEATURE_FLAGS.OPS_DELVAR
            : 0;
        const model = info.productId || dependencies.state.authorizedDevice?.productName || 'Casio';
        const entries = [
            { key: dependencies.t('casio_info_product'), value: model },
            { key: dependencies.t('casio_info_protocol'), value: info.protocol || dependencies.t('unknown') },
            { key: dependencies.t('casio_info_os_version'), value: info.osVersion || dependencies.t('unknown') },
            { key: dependencies.t('casio_info_hardware_id'), value: info.hwid || dependencies.t('unknown') },
            { key: dependencies.t('casio_info_cpu_id'), value: info.cpuid || dependencies.t('unknown') },
            { key: dependencies.t('casio_info_username'), value: info.username || dependencies.t('unknown') },
            { key: dependencies.t('casio_info_organisation'), value: info.organisation || dependencies.t('unknown') }
        ];
        dependencies.state.deviceInfoEntries = entries;
        dependencies.state.deviceModelName = model;
        dependencies.state.deviceInfoProductName = model;
        dependencies.renderDeviceInfo(entries);
        dependencies.updateDeviceModelDisplay(model);
        if (dependencies.state.casioStorageSupported) {
            dependencies.els.memoryInfo.textContent = dependencies.tFormat('casio_storage_free', {
                free: dependencies.formatBytes(Number(info.storageFree) || 0)
            });
            dependencies.els.memoryInfo.title = `${Number(info.storageFree) || 0}B`;
        } else {
            dependencies.els.memoryInfo.textContent = dependencies.t('casio_storage_unavailable_short');
            dependencies.els.memoryInfo.title = dependencies.t('casio_storage_protocol_unavailable');
        }
        dependencies.applyActiveFamilyUiState();
        return info;
    }

    function readHPLegacyInfo() {
        const detected = dependencies.state.hpLegacyModelInfo;
        const versionText = String(detected?.versionText || '').trim();
        const serialText = String(detected?.serialText || '').trim();
        const protocol = dependencies.state.hpLegacyKermitEnabled
            ? `Classic Kermit${detected?.modelName
                ? ` (${detected.modelName})`
                : detected ? ' (model unrecognized)' : ''}`
            : 'Transport only; HP 39/40 XModem is not implemented';
        const entries = [
            { key: 'USB identity', value: '03f0:0121 (shared by six models)' },
            detected?.modelName
                ? { key: 'Detected model', value: detected.modelName }
                : detected
                    ? { key: 'Model probe', value: 'Unrecognized VERSION response' }
                : { key: 'Possible models', value: 'HP 39g+, 39gs, 40gs, 48gII, 49g+, or 50g' },
            ...(serialText ? [{ key: 'SERIAL', value: serialText }] : []),
            ...(versionText ? [{ key: 'VERSION response', value: versionText }] : []),
            { key: 'Protocol', value: protocol }
        ];
        dependencies.state.deviceInfoEntries = entries;
        dependencies.state.deviceModelName = detected?.modelName
            || (detected
                ? 'Legacy HP Kermit calculator (model unrecognized)'
                : 'Legacy HP calculator (ambiguous USB identity)');
        dependencies.state.deviceInfoProductName = dependencies.state.deviceModelName;
        dependencies.renderDeviceInfo(entries);
        dependencies.updateDeviceModelDisplay(dependencies.state.deviceModelName);
        if (dependencies.els.memoryInfo) dependencies.els.memoryInfo.textContent = '—';
    }

    function getHPPrimeModelName(device = dependencies.state.authorizedDevice) {
        if (device?.productId === 0x2441) {
            return 'HP Prime G2';
        }
        if (device?.productId === 0x0441 || device?.productId === 0x1541) {
            return 'HP Prime G1';
        }
        return 'HP Prime';
    }

    function getHPPrimeUploadIdentity(filename) {
        const leaf = String(filename || '').split(/[\\/]/).pop();
        if (!leaf) {
            return null;
        }
        const lower = leaf.toLowerCase();
        if (lower === 'calc.settings' || lower === 'cas.settings'
            || lower === 'settings' || lower === 'testmodes.hptestmodes') {
            return { name: leaf.replace(/\.[^.]+$/, ''), extension: '' };
        }
        const dot = leaf.lastIndexOf('.');
        if (dot <= 0 || dot === leaf.length - 1) {
            return null;
        }
        const extension = leaf.slice(dot + 1).toLowerCase();
        if (!dependencies.HP_PRIME_UPLOAD_EXTENSIONS.has(extension)) {
            return null;
        }
        return {
            name: leaf.slice(0, dot),
            extension: extension === 'hpmatrix' ? 'hpmat' : extension
        };
    }

    function applyHPPrimeFileSnapshot(module) {
        const filesText = module.ccall('hp_prime_get_files_json', 'string', [], []);
        const files = JSON.parse(filesText || '[]');
        dependencies.state.features = 0;
        dependencies.state.dirlist = files.flatMap(dependencies.mapHPPrimeFileEntries);
        dependencies.state.hpFileSnapshotLoaded = true;
        dependencies.renderDirlist(dependencies.state.dirlist);
        return files.length;
    }

    function mapHPPrimeFileEntry(file) {
        return {
            name: file.name,
            type: file.type,
            type_name: file.typeName,
            size: file.size,
            kind: 'hp',
            folder: '',
            attr: 0,
            is_folder: Array.isArray(file.children) ? 1 : 0,
            hpIndex: file.index,
            extension: file.extension,
            invalid: Boolean(file.invalid),
            hpAppRoot: Array.isArray(file.children),
            hpAppContainerValid: file.appContainerValid !== false
        };
    }

    function hpPrimeAppPartTypeName(kind) {
        if (kind === 'descriptor') return dependencies.t('hp_prime_app_descriptor');
        if (kind === 'note') return dependencies.t('hp_prime_app_note');
        if (kind === 'program') return dependencies.t('hp_prime_app_program');
        return dependencies.t('hp_prime_app_resource');
    }

    function mapHPPrimeFileEntries(file) {
        const root = dependencies.mapHPPrimeFileEntry(file);
        if (!Array.isArray(file.children)) {
            return [root];
        }
        const children = file.children.map(child => ({
            name: child.name,
            type: file.type,
            type_name: dependencies.hpPrimeAppPartTypeName(child.kind),
            size: child.size,
            kind: 'hp-app-child',
            folder: file.name,
            attr: 0,
            is_folder: 0,
            hpIndex: file.index,
            hpAppChildIndex: child.index,
            hpAppPartKind: child.kind,
            hpAppChildEditable: Boolean(child.editable),
            extension: child.extension,
            invalid: false
        }));
        return [root, ...children];
    }

    function appendHPPrimeFileArrival(module, generation, json) {
        if (dependencies.state.module !== module
            || dependencies.state.hpFileRefreshGeneration !== generation
            || !dependencies.isHPPrimeActive()) {
            return false;
        }
        try {
            dependencies.state.dirlist.push(...dependencies.mapHPPrimeFileEntries(JSON.parse(json)));
            dependencies.scheduleHPPrimeProgressRender(module, generation);
            return true;
        } catch (error) {
            dependencies.console.warn('[WebTILP] Ignoring invalid HP Prime file update.', error);
            return false;
        }
    }

    function beginHPPrimeFileSnapshot(module) {
        const generation = ++dependencies.state.hpFileRefreshGeneration;
        dependencies.state.hpFileRenderGeneration = 0;
        dependencies.state.hpFileSnapshotLoaded = false;
        dependencies.state.dirlist = [];
        dependencies.renderDirlist(dependencies.state.dirlist);
        const callback = json => dependencies.appendHPPrimeFileArrival(module, generation, json);
        module.__hpPrimeFileArrived = callback;
        return { generation, callback };
    }

    function finishHPPrimeFileSnapshot(module, refresh, successful) {
        if (module.__hpPrimeFileArrived === refresh.callback) {
            module.__hpPrimeFileArrived = null;
        }
        if (dependencies.state.module !== module
            || dependencies.state.hpFileRefreshGeneration !== refresh.generation
            || !dependencies.isHPPrimeActive()) {
            return dependencies.state.dirlist.length;
        }
        dependencies.state.hpFileRenderGeneration = 0;
        if (successful) {
            return dependencies.applyHPPrimeFileSnapshot(module);
        }
        dependencies.renderDirlist(dependencies.state.dirlist);
        return dependencies.state.dirlist.length;
    }

    function readHPPrimeInfo(module) {
        const infoText = module.ccall('hp_prime_get_info_json', 'string', [], []);
        if (!infoText) {
            throw new Error(dependencies.t('hp_prime_info_unavailable'));
        }
        const info = JSON.parse(infoText);
        dependencies.state.hpPrimeProtocolVersion = Number(info.protocol) || null;
        const entries = [
            { key: dependencies.t('hp_prime_info_product_name'), value: dependencies.getHPPrimeModelName() },
            { key: dependencies.t('hp_prime_info_firmware_version'), value: info.version || dependencies.t('unknown') },
            { key: dependencies.t('hp_prime_info_build'), value: String(info.build ?? dependencies.t('unknown')) },
            { key: dependencies.t('hp_prime_info_serial'), value: info.serial || dependencies.t('unknown') },
            { key: dependencies.t('hp_prime_info_protocol'), value: info.protocol === 2 ? 'V2' : dependencies.t('hp_prime_protocol_legacy') },
            { key: dependencies.t('hp_prime_info_v2_capable'), value: info.supportsV2 ? dependencies.t('yes') : dependencies.t('no') }
        ];
        dependencies.state.deviceInfoEntries = entries;
        dependencies.state.deviceModelName = dependencies.getHPPrimeModelName();
        dependencies.state.deviceInfoProductName = dependencies.state.deviceModelName;
        dependencies.renderDeviceInfo(entries);
        dependencies.updateDeviceModelDisplay(dependencies.state.deviceModelName);
        dependencies.els.memoryInfo.textContent = '—';
        dependencies.els.memoryInfo.title = '';
        dependencies.applyActiveFamilyUiState();
        return info;
    }

    function applyNumWorksStorageSnapshot() {
        const scripts = dependencies.state.numWorksBackend?.listScripts() || [];
        dependencies.state.features = dependencies.FEATURE_FLAGS.OPS_RENAME | dependencies.FEATURE_FLAGS.OPS_DELVAR;
        dependencies.state.dirlist = scripts.map(script => ({
            name: script.name,
            type: 0,
            type_name: script.autoImport ? dependencies.t('numworks_type_python_auto') : dependencies.t('numworks_type_python'),
            size: script.size,
            kind: 'numworks',
            folder: '',
            attr: script.autoImport ? 1 : 0,
            is_folder: 0,
            extension: 'py',
            numWorksName: script.name,
            invalid: !script.valid
        }));
        dependencies.renderDirlist(dependencies.state.dirlist);
        return dependencies.state.dirlist.length;
    }

    function readNumWorksInfo() {
        const info = dependencies.state.numWorksBackend?.getInfo();
        if (!info) {
            throw new Error(dependencies.t('numworks_info_unavailable'));
        }
        const integrityOk = info.headerIntegrity && info.storageFooterValid && info.storageValid;
        const entries = [
            { key: dependencies.t('numworks_info_product_name'), value: info.model || info.productName || 'NumWorks' },
            { key: dependencies.t('numworks_info_usb_product'), value: info.productName || 'NumWorks Calculator' },
            { key: dependencies.t('numworks_info_firmware_version'), value: info.firmwareVersion || dependencies.t('unknown') },
            { key: dependencies.t('numworks_info_commit'), value: info.commit || dependencies.t('unknown') },
            { key: dependencies.t('numworks_info_mode'), value: info.mode || dependencies.t('unknown') },
            { key: dependencies.t('numworks_info_slot'), value: info.slot || dependencies.t('unknown') },
            { key: dependencies.t('numworks_info_serial'), value: info.serialNumber || dependencies.t('unknown') },
            { key: dependencies.t('numworks_info_transfer_size'), value: `${info.transferSize} B` },
            { key: dependencies.t('numworks_info_storage_integrity'), value: integrityOk ? dependencies.t('valid') : dependencies.t('warning') },
            { key: dependencies.t('numworks_info_preserved_records'), value: info.preservedRecordCount == null
                ? dependencies.t('unknown') : String(info.preservedRecordCount) }
        ];
        dependencies.state.deviceInfoEntries = entries;
        dependencies.state.deviceModelName = info.model || 'NumWorks';
        dependencies.state.deviceInfoProductName = dependencies.state.deviceModelName;
        dependencies.renderDeviceInfo(entries);
        dependencies.updateDeviceModelDisplay(dependencies.state.deviceModelName);
        if (info.storageValid) {
            dependencies.els.memoryInfo.textContent = dependencies.tFormat('numworks_storage_summary', {
                used: dependencies.formatBytes(info.storageUsed),
                total: dependencies.formatBytes(info.storageSize)
            });
            dependencies.els.memoryInfo.title = dependencies.tFormat('numworks_storage_usage', {
                used: info.storageUsed,
                free: info.storageFree,
                total: info.storageSize
            });
        } else {
            dependencies.els.memoryInfo.textContent = dependencies.t('numworks_storage_unreadable');
            dependencies.els.memoryInfo.title = dependencies.t('numworks_storage_parse_failed');
        }
        return info;
    }

    function readSharpInfo(version = null) {
        const backend = dependencies.state.sharpBackend;
        dependencies.state.deviceModelName = dependencies.globalThis.WebTILPSharp.MODELS[backend.model];
        dependencies.state.deviceInfoProductName = dependencies.state.deviceModelName;
        const entries = [{ key: dependencies.t('sharp_model'), value: dependencies.state.deviceModelName },
            { key: dependencies.t('sharp_transport'), value: 'Sunplus 04FC:0201 / WebSerial' },
            { key: dependencies.t('sharp_protocol'), value: 'PC-Link / REPROGRAM' }];
        if (version) entries.push({ key: dependencies.t('sharp_version'), value: version });
        dependencies.state.deviceInfoEntries = entries; dependencies.renderDeviceInfo(entries);
        dependencies.updateDeviceModelDisplay(dependencies.state.deviceModelName);
        if (dependencies.els.memoryInfo) dependencies.els.memoryInfo.textContent = '—';
    }

    return { applyCasioStorageSnapshot, readCasioInfo, readHPLegacyInfo, getHPPrimeModelName, getHPPrimeUploadIdentity, applyHPPrimeFileSnapshot, mapHPPrimeFileEntry, hpPrimeAppPartTypeName, mapHPPrimeFileEntries, appendHPPrimeFileArrival, beginHPPrimeFileSnapshot, finishHPPrimeFileSnapshot, readHPPrimeInfo, applyNumWorksStorageSnapshot, readNumWorksInfo, readSharpInfo };
}

module.exports = { createBackendsDeviceInfo };
