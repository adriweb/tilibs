/*
 * libhpcables WebHID backend for HP Prime calculators.
 * Copyright (C) 2026 WebTILP contributors.
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 */

#ifdef HAVE_CONFIG_H
# include <config.h>
#endif

#include <emscripten.h>
#include <inttypes.h>
#include <stdint.h>

#include <hplibs.h>
#include <hpcalcs.h>
#include "logging.h"
#include "error.h"

extern const cable_fncts cable_prime_hid_fncts;

EM_ASYNC_JS(int, prime_webhid_probe_js, (), {
    if (!navigator.hid) {
        return 0;
    }
    const supported = device => device
        && device.vendorId === 0x03F0
        && (device.productId === 0x0441
            || device.productId === 0x1541
            || device.productId === 0x2441);
    const state = Module.__hplpWebHID;
    if (state && supported(state.device)) {
        return 1;
    }
    try {
        const devices = await navigator.hid.getDevices();
        return devices.some(supported) ? 1 : 0;
    } catch (error) {
        console.warn("[hpcables] WebHID enumeration failed", error);
        return 0;
    }
});

EM_ASYNC_JS(int, prime_webhid_open_js, (), {
    if (!navigator.hid) {
        return -1;
    }

    const supported = device => device
        && device.vendorId === 0x03F0
        && (device.productId === 0x0441
            || device.productId === 0x1541
            || device.productId === 0x2441);
    const ensureState = () => {
        if (!Module.__hplpWebHID) {
            Module.__hplpWebHID = {};
        }
        const state = Module.__hplpWebHID;
        state.device = state.device || null;
        state.queue = Array.isArray(state.queue) ? state.queue : [];
        state.waiters = Array.isArray(state.waiters) ? state.waiters : [];
        state.error = null;
        state.reportSize = state.reportSize | 0;
        return state;
    };
    const state = ensureState();
    const notify = () => {
        const waiters = state.waiters.splice(0, state.waiters.length);
        for (const waiter of waiters) {
            waiter();
        }
    };
    const reportBytes = reports => {
        let maximum = 0;
        for (const report of reports || []) {
            let bits = 0;
            for (const item of report.items || []) {
                bits += (item.reportSize || 0) * (item.reportCount || 0);
            }
            maximum = Math.max(maximum, Math.ceil(bits / 8));
        }
        return maximum;
    };
    const descriptorReportSize = device => {
        let maximum = 0;
        const visit = collection => {
            maximum = Math.max(
                maximum,
                reportBytes(collection.inputReports),
                reportBytes(collection.outputReports)
            );
            for (const child of collection.children || []) {
                visit(child);
            }
        };
        for (const collection of device.collections || []) {
            visit(collection);
        }
        return maximum;
    };

    try {
        const previousDevice = state.device;
        let device = supported(state.device) ? state.device : null;
        if (!device) {
            const devices = await navigator.hid.getDevices();
            device = devices.find(supported) || null;
        }
        if (!device) {
            return -2;
        }
        if (!device.opened) {
            await device.open();
        }

        if (previousDevice && previousDevice !== device && state.inputHandler) {
            previousDevice.removeEventListener("inputreport", state.inputHandler);
        }
        state.device = device;
        state.queue = [];
        state.error = null;
        /* Prime report sizes are part of the device protocol.  WebHID
         * collection metadata has varied across Chromium/OS HID backends, so
         * using a descriptor-derived maximum here can make identical hardware
         * fragment differently on two computers. */
        state.reportSize = device.productId === 0x2441 ? 1024 : 64;
        state.descriptorReportSize = descriptorReportSize(device);
        if (state.descriptorReportSize > 0
            && state.descriptorReportSize !== state.reportSize) {
            console.warn(
                `[hpcables] Ignoring ${state.descriptorReportSize}-byte HID descriptor report size; `
                + `HP Prime PID 0x${device.productId.toString(16).padStart(4, '0')} uses ${state.reportSize} bytes`
            );
        }

        if (state.inputHandler) {
            device.removeEventListener("inputreport", state.inputHandler);
        }
        state.inputHandler = event => {
            const view = event.data;
            const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
            state.queue.push(bytes);
            notify();
        };
        device.addEventListener("inputreport", state.inputHandler);

        if (!state.disconnectHandler) {
            state.disconnectHandler = event => {
                if (event.device === state.device) {
                    state.error = new Error("HP Prime WebHID device disconnected");
                    notify();
                }
            };
            navigator.hid.addEventListener("disconnect", state.disconnectHandler);
        }

        return state.reportSize;
    } catch (error) {
        state.error = error;
        console.warn("[hpcables] WebHID open failed", error);
        notify();
        return -1;
    }
});

EM_ASYNC_JS(int, prime_webhid_close_js, (), {
    const state = Module.__hplpWebHID;
    if (!state) {
        return 0;
    }
    try {
        if (state.device && state.inputHandler) {
            state.device.removeEventListener("inputreport", state.inputHandler);
        }
        if (state.device && state.device.opened) {
            await state.device.close();
        }
    } catch (error) {
        console.warn("[hpcables] WebHID close failed", error);
        return -1;
    } finally {
        if (state.disconnectHandler && navigator.hid) {
            navigator.hid.removeEventListener("disconnect", state.disconnectHandler);
        }
        state.disconnectHandler = null;
        state.inputHandler = null;
        state.queue = [];
        state.error = null;
        const waiters = Array.isArray(state.waiters)
            ? state.waiters.splice(0, state.waiters.length)
            : [];
        for (const waiter of waiters) {
            waiter();
        }
    }
    return 0;
});

EM_JS(int, prime_webhid_flush_js, (), {
    const state = Module.__hplpWebHID;
    if (!state) {
        return -1;
    }
    state.queue = [];
    state.error = null;
    return 0;
});

/* Prime commands are request/response exchanges.  Discard reports which were
 * already queued before a new legacy or V2 request is sent; otherwise delayed
 * data or ACKs from the preceding exchange can be mistaken for the new reply.
 * Keep this separate from sendReport() so a reply delivered while sendReport()
 * resolves is never discarded. */
EM_JS(void, prime_webhid_begin_exchange_js, (), {
    const state = Module.__hplpWebHID;
    if (state) {
        state.queue = [];
    }
});

EM_ASYNC_JS(int, prime_webhid_write_js, (const uint8_t *data, uint32_t len), {
    const state = Module.__hplpWebHID;
    if (!state || !state.device || !state.device.opened || len < 1) {
        return -1;
    }
    try {
        const reportId = HEAPU8[data];
        const bytes = HEAPU8.slice(data + 1, data + len);
        if (state.reportSize > 0 && bytes.length > state.reportSize) {
            return -1;
        }
        await state.device.sendReport(reportId, bytes);
        return len;
    } catch (error) {
        state.error = error;
        console.warn("[hpcables] WebHID write failed", error);
        return -1;
    }
});

EM_ASYNC_JS(int, prime_webhid_read_js, (uint8_t *data, uint32_t capacity, int timeout_ms), {
    const state = Module.__hplpWebHID;
    if (!state || !state.device || !state.device.opened) {
        return -1;
    }
    const dequeue = () => {
        if (!state.queue.length) {
            return 0;
        }
        const report = state.queue.shift();
        if (report.length > capacity) {
            state.error = new Error(`WebHID report ${report.length} exceeds ${capacity}-byte buffer`);
            return -1;
        }
        HEAPU8.set(report, data);
        return report.length;
    };

    let result = dequeue();
    if (result !== 0) {
        return result;
    }
    if (state.error) {
        return -1;
    }

    let timer = null;
    const woke = await new Promise(resolve => {
        const waiter = () => {
            if (timer !== null) {
                clearTimeout(timer);
            }
            resolve(1);
        };
        state.waiters.push(waiter);
        timer = setTimeout(() => {
            const index = state.waiters.indexOf(waiter);
            if (index >= 0) {
                state.waiters.splice(index, 1);
            }
            resolve(0);
        }, Math.max(1, timeout_ms | 0));
    });
    if (!woke) {
        return -2;
    }
    result = dequeue();
    return result !== 0 ? result : (state.error ? -1 : -2);
});

static int cable_prime_hid_probe(cable_handle * handle) {
    if (handle == NULL) {
        hpcables_error("%s: handle is NULL", __FUNCTION__);
        return ERR_INVALID_HANDLE;
    }
    return prime_webhid_probe_js() ? ERR_SUCCESS : ERR_CABLE_PROBE_FAILED;
}

static int cable_prime_hid_open(cable_handle * handle) {
    int report_size;
    if (handle == NULL) {
        hpcables_error("%s: handle is NULL", __FUNCTION__);
        return ERR_INVALID_HANDLE;
    }
    report_size = prime_webhid_open_js();
    if (report_size <= 0 || report_size > PRIME_RAW_HID_DATA_SIZE_MAX) {
        hpcables_error("%s: WebHID open failed (%d)", __FUNCTION__, report_size);
        return ERR_CABLE_NOT_OPEN;
    }
    handle->model = CABLE_PRIME_HID;
    handle->handle = NULL;
    handle->fncts = &cable_prime_hid_fncts;
    handle->read_timeout = 8000;
    handle->report_size = (uint32_t)report_size;
    handle->open = 1;
    handle->busy = 0;
    prime_webhid_flush_js();
    hpcables_info("%s: WebHID open succeeded, report size=%d", __FUNCTION__, report_size);
    return ERR_SUCCESS;
}

static int cable_prime_hid_close(cable_handle * handle) {
    if (handle == NULL) {
        return ERR_INVALID_HANDLE;
    }
    if (!handle->open) {
        return ERR_CABLE_NOT_OPEN;
    }
    if (prime_webhid_close_js() != 0) {
        return ERR_CABLE_OPEN;
    }
    handle->open = 0;
    handle->busy = 0;
    return ERR_SUCCESS;
}

static int cable_prime_hid_set_read_timeout(cable_handle * handle, int read_timeout) {
    if (handle == NULL) {
        return ERR_INVALID_HANDLE;
    }
    handle->read_timeout = read_timeout;
    return ERR_SUCCESS;
}

static int cable_prime_hid_send(cable_handle * handle, uint8_t * data, uint32_t len) {
    int written;
    if (handle == NULL || data == NULL) {
        return ERR_INVALID_PARAMETER;
    }
    if (!handle->open) {
        return ERR_CABLE_NOT_OPEN;
    }
    written = prime_webhid_write_js(data, len);
    if (written != (int)len) {
        hpcables_error("%s: WebHID write failed (%d/%" PRIu32 ")", __FUNCTION__, written, len);
        return ERR_CABLE_WRITE_ERROR;
    }
    return ERR_SUCCESS;
}

static int cable_prime_hid_recv(cable_handle * handle, uint8_t ** data, uint32_t * len) {
    int received;
    if (handle == NULL || data == NULL || *data == NULL || len == NULL) {
        return ERR_INVALID_PARAMETER;
    }
    if (!handle->open) {
        return ERR_CABLE_NOT_OPEN;
    }
    received = prime_webhid_read_js(*data, PRIME_RAW_HID_DATA_SIZE_MAX, handle->read_timeout);
    if (received < 0) {
        return ERR_CABLE_READ_ERROR;
    }
    *len = (uint32_t)received;
    return ERR_SUCCESS;
}

const cable_fncts cable_prime_hid_fncts = {
    CABLE_PRIME_HID,
    "Prime WebHID cable",
    "HP Prime USB HID cable through WebHID",
    &cable_prime_hid_probe,
    &cable_prime_hid_open,
    &cable_prime_hid_close,
    &cable_prime_hid_set_read_timeout,
    &cable_prime_hid_send,
    &cable_prime_hid_recv
};
