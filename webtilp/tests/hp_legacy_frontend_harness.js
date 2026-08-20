(() => {
    'use strict';

    const controls = document.createElement('div');
    controls.id = 'hpLegacyTestControls';
    controls.setAttribute('aria-label', 'Old HP test controls');
    Object.assign(controls.style, {
        position: 'fixed', zIndex: '10000', left: '12px', bottom: '12px',
        display: 'flex', gap: '8px', padding: '8px',
        border: '1px solid #586178', borderRadius: '8px', background: '#111827'
    });

    const addButton = (id, text, handler) => {
        const button = document.createElement('button');
        button.id = id;
        button.type = 'button';
        button.textContent = text;
        button.addEventListener('click', handler);
        controls.appendChild(button);
    };

    const activate = kermit => {
        state.hpLegacyConnectionGeneration += 1;
        state.activeFamily = DEVICE_FAMILY_HP_LEGACY;
        state.authorizedDevice = {
            vendorId: HP_VENDOR_ID,
            productId: HP_LEGACY_PRODUCT_ID,
            productName: 'Legacy HP test device'
        };
        state.hpLegacyKermitEnabled = kermit;
        state.hpLegacyModelInfo = kermit
            ? {
                modelId: 'hp50g', modelName: 'HP 50g',
                versionText: 'HP50-C Revision #2.15',
                serialText: 'HP50 Serial Number: CNA6110007'
            }
            : null;
        state.hpLegacyBackend = {
            async close() {},
            async captureScreenshot() {
                const width = 131;
                const height = 80;
                const rgba = new Uint8ClampedArray(width * height * 4);
                for (let y = 0; y < height; y += 1) {
                    for (let x = 0; x < width; x += 1) {
                        const offset = (y * width + x) * 4;
                        const dark = x === y || x === width - y - 1
                            || x === 0 || y === 0 || x === width - 1 || y === height - 1;
                        const color = dark ? 0 : 255;
                        rgba[offset] = color;
                        rgba[offset + 1] = color;
                        rgba[offset + 2] = color;
                        rgba[offset + 3] = 255;
                    }
                }
                return { width, height, rgba };
            }
        };
        state.features = kermit
            ? FEATURE_FLAGS.OPS_SCREEN | FEATURE_FLAGS.OPS_DIRLIST
                | FEATURE_FLAGS.OPS_VARS : 0;
        state.cableOpen = true;
        state.connected = true;
        state.dirlist = kermit ? [
            { name: 'IOPAR', folder: '', type: 0, type_name: 'List', size: 30,
                hpSize: '29.5', kind: 'hp-legacy', is_folder: 0, attr: 0 },
            { name: 'APPS', folder: '', type: 0, type_name: 'Directory', size: 2785,
                kind: 'hp-legacy', is_folder: 1, attr: 0 }
        ] : [];
        setConnected(true);
        applyActiveFamilyUiState();
        readHPLegacyInfo();
        renderDirlist(state.dirlist);
        setStatus('status_connected', true);
    };

    addButton('testActivateHPLegacyTransport', 'Simulate HP 39/40 transport',
        () => activate(false));
    addButton('testActivateHPLegacyKermit', 'Simulate HP 48/49/50 Kermit',
        () => activate(true));
    addButton('testDisconnectHPLegacy', 'Simulate Disconnect',
        () => handleTransportDisconnect());
    document.body.appendChild(controls);
})();
