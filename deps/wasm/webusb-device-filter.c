/* Exercise the real libusb WebUSB backend without attached hardware. */
#include <assert.h>
#include <emscripten/emscripten.h>
#include <libusb.h>
#include <stdio.h>

extern int libusb_webusb_device_filter_supported(void);

int main(void)
{
    libusb_context *context = NULL;
    libusb_device **devices = NULL;
    assert(libusb_webusb_device_filter_supported() == 1);
    MAIN_THREAD_EM_ASM({
        Module.webusbDeviceFilter = device => device === globalThis.mockUsbDevices[1];
    });
    assert(libusb_init(&context) == 0);
    assert(libusb_get_device_list(context, &devices) == 1);
    libusb_device *selected = libusb_ref_device(devices[0]);
    libusb_free_device_list(devices, 1);
    assert(MAIN_THREAD_EM_ASM_INT({ return globalThis.mockUsbDevices[0].opens; }) == 0);
    assert(MAIN_THREAD_EM_ASM_INT({ return globalThis.mockUsbDevices[1].opens; }) == 1);

    /* A selected device that disappeared must not fall back to its twin. */
    MAIN_THREAD_EM_ASM({ Module.webusbDeviceFilter = () => false; });
    assert(libusb_get_device_list(context, &devices) == 0);
    libusb_free_device_list(devices, 1);

    /* Removing the module-local predicate restores ordinary enumeration. */
    MAIN_THREAD_EM_ASM({ delete Module.webusbDeviceFilter; });
    assert(libusb_get_device_list(context, &devices) == 2);
    assert(devices[0] != selected && devices[1] == selected);
    libusb_free_device_list(devices, 1);
    assert(MAIN_THREAD_EM_ASM_INT({ return globalThis.mockUsbDevices[0].opens; }) == 1);
    assert(MAIN_THREAD_EM_ASM_INT({ return globalThis.mockUsbDevices[1].opens; }) == 1);
    libusb_unref_device(selected);
    libusb_exit(context);
    puts("PASS: exact WebUSB selection, no fallback, and filter removal");
    return 0;
}
