/* Two identical calculators, deliberately without distinguishing serials. */
(() => {
    const descriptor = Uint8Array.of(
        18, 1, 0x10, 1, 0, 0, 0, 64,
        0xCF, 0x07, 0x01, 0x61, 0, 1, 0, 0, 0, 1
    );
    const configuration = Uint8Array.of(9, 2, 9, 0, 0, 1, 0, 0x80, 50);
    const createDevice = () => ({
        vendorId: 0x07CF,
        productId: 0x6101,
        opened: false,
        opens: 0,
        configuration: { configurationValue: 1 },
        async open() { this.opened = true; this.opens += 1; },
        async close() { this.opened = false; },
        async controlTransferIn(setup, length) {
            if (setup.request !== 6) throw new Error('Unexpected USB request');
            const type = setup.value >> 8;
            if (type !== 1 && type !== 2) throw new Error('Unexpected descriptor type');
            const bytes = (type === 1 ? descriptor : configuration).slice(0, length);
            return { status: 'ok', data: new DataView(bytes.buffer) };
        }
    });
    globalThis.mockUsbDevices = [createDevice(), createDevice()];
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { usb: { async getDevices() { return globalThis.mockUsbDevices.slice(); } } }
    });
})();
