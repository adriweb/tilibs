(() => {
    'use strict';

    const controls = document.createElement('div');
    controls.id = 'hpPrimeTestControls';
    controls.setAttribute('aria-label', 'HP Prime test controls');
    Object.assign(controls.style, {
        position: 'fixed',
        zIndex: '10000',
        left: '12px',
        bottom: '12px',
        display: 'flex',
        gap: '8px',
        padding: '8px',
        border: '1px solid #586178',
        borderRadius: '8px',
        background: '#111827'
    });

    const addButton = (id, text, handler) => {
        const button = document.createElement('button');
        button.id = id;
        button.type = 'button';
        button.textContent = text;
        button.addEventListener('click', handler);
        controls.appendChild(button);
    };

    addButton('testActivateHPPrime', 'Simulate HP Prime', () => {
        state.activeFamily = DEVICE_FAMILY_HP_PRIME;
        state.authorizedDevice = {
            vendorId: HP_VENDOR_ID,
            productId: 0x2441,
            productName: 'HP Prime G2 test device'
        };
        state.cableOpen = true;
        state.connected = true;
        state.deviceModelName = 'HP Prime G2';
        setConnected(true);
        applyActiveFamilyUiState();
        updateDeviceModelDisplay('HP Prime G2');
        setStatus('status_connected', true);
    });

    addButton('testFrench', 'Apply French', async () => {
        state.settings.language = 'fr';
        await applyTranslations();
    });

    addButton('testDisconnect', 'Simulate Disconnect', () => {
        handleTransportDisconnect();
    });

    document.body.appendChild(controls);
})();
