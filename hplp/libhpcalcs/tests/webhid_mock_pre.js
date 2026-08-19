/* Browser-independent WebHID mock loaded before the Emscripten runtime. */

(() => {
    const deviceListeners = new Map();
    const hidListeners = new Map();
    const report = count => ({items: [{reportSize: 8, reportCount: count}]});
    const device = {
        vendorId: 0x03F0,
        productId: 0x2441,
        opened: false,
        collections: [{
            inputReports: [report(1024)],
            outputReports: [report(1024)],
            children: []
        }],
        async open() { this.opened = true; },
        async close() { this.opened = false; },
        async sendReport(reportId, bytes) {
            globalThis.__hplpLastWrite = {
                reportId,
                bytes: Uint8Array.from(bytes)
            };
            const response = globalThis.__hplpPrimeNextWriteResponse;
            globalThis.__hplpPrimeNextWriteResponse = null;
            if (response) {
                const callback = deviceListeners.get("inputreport");
                if (!callback) throw new Error("inputreport listener is not installed");
                const data = Uint8Array.from(response);
                callback({device, data: new DataView(data.buffer)});
            }
        },
        addEventListener(type, callback) { deviceListeners.set(type, callback); },
        removeEventListener(type, callback) {
            if (deviceListeners.get(type) === callback) deviceListeners.delete(type);
        }
    };

    globalThis.navigator = globalThis.navigator || {};
    globalThis.navigator.hid = {
        async getDevices() { return [device]; },
        addEventListener(type, callback) { hidListeners.set(type, callback); },
        removeEventListener(type, callback) {
            if (hidListeners.get(type) === callback) hidListeners.delete(type);
        }
    };
    globalThis.__hplpMockDevice = device;
    globalThis.__hplpEmitInput = bytes => {
        const data = Uint8Array.from(bytes);
        const callback = deviceListeners.get("inputreport");
        if (!callback) throw new Error("inputreport listener is not installed");
        callback({device, data: new DataView(data.buffer)});
    };
    globalThis.__hplpEmitDisconnect = () => {
        const callback = hidListeners.get("disconnect");
        if (!callback) throw new Error("disconnect listener is not installed");
        callback({device});
    };
    globalThis.__hplpSelectG1Fallback = () => {
        device.productId = 0x1541;
        /* Model an OS/browser exposing misleading collection metadata.  The
         * protocol size still comes from the known Prime PID. */
        device.collections = [{
            inputReports: [report(1024)],
            outputReports: [report(1024)],
            children: []
        }];
    };
    globalThis.__hplpPrepareLegacyExchange = response => {
        Module.__hplpWebHID.queue = [Uint8Array.of(0xEE)];
        globalThis.__hplpPrimeNextWriteResponse = Uint8Array.from(response);
    };

    Module.__hplpWebHID = {
        device,
        queue: [Uint8Array.of(0xEE)],
        waiters: []
    };
})();
