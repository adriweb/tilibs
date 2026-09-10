// Exercise the real enumeration code with deterministic libusb ownership.
// Unused transport functions are discarded by this target's linker flags.
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <vector>

#if defined(__BSD__) || defined(__MACOSX__)
#include <libusb.h>
#else
#include <libusb-1.0/libusb.h>
#endif

#define CHECK(condition) \
	do { \
		if (!(condition)) { \
			fprintf(stderr, "%s:%d: check failed: %s\n", __FILE__, __LINE__, #condition); \
			abort(); \
		} \
	} while (0)

struct libusb_device
{
	uint16_t vid;
	uint16_t pid;
	int refs;
	int creations;
	bool bad_descriptor;

	libusb_device(uint16_t vendor = 0, uint16_t product = 0)
		: vid(vendor), pid(product), refs(0), creations(0), bad_descriptor(false)
	{
	}
};

static std::vector<libusb_device *> discovered;
static int list_error;
static int lists_allocated;
static int lists_freed;
static bool serial_available;

static libusb_device *test_ref_device(libusb_device *device)
{
	CHECK(device->refs > 0);
	device->refs++;
	return device;
}

static void test_unref_device(libusb_device *device)
{
	CHECK(device->refs > 0);
	device->refs--;
}

static ssize_t test_get_device_list(libusb_context *, libusb_device ***list)
{
	if (list_error)
	{
		// libusb leaves the output pointer untouched on failure.
		return list_error;
	}
	*list = (libusb_device **)calloc(discovered.size() + 1, sizeof(libusb_device *));
	CHECK(*list != NULL);
	lists_allocated++;
	for (size_t i = 0; i < discovered.size(); i++)
	{
		libusb_device *device = discovered[i];
		if (device->refs == 0)
		{
			device->creations++;
		}
		device->refs++;
		(*list)[i] = device;
	}
	return (ssize_t)discovered.size();
}

static void test_free_device_list(libusb_device **list, int unref_devices)
{
	CHECK(list != NULL);
	if (unref_devices)
	{
		for (size_t i = 0; list[i] != NULL; i++)
		{
			test_unref_device(list[i]);
		}
	}
	free(list);
	lists_freed++;
}

static int test_get_device_descriptor(libusb_device *device, libusb_device_descriptor *descriptor)
{
	CHECK(device->refs > 0);
	if (device->bad_descriptor)
	{
		return LIBUSB_ERROR_IO;
	}
	memset(descriptor, 0, sizeof(*descriptor));
	descriptor->idVendor = device->vid;
	descriptor->idProduct = device->pid;
	return 0;
}

#define libusb_ref_device test_ref_device
#define libusb_unref_device test_unref_device
#define libusb_get_device_list test_get_device_list
#define libusb_free_device_list test_free_device_list
#define libusb_get_device_descriptor test_get_device_descriptor
#include "../src/linux/link_usb1.cc"

int evo_serial_find_path(char *, size_t, const USBCableInfo *)
{
	return 0;
}

int evo_serial_add_devices(USBCableInfo *devices, int start, int max_devices, uint16_t vid, uint16_t pid)
{
	if (!serial_available || start >= max_devices)
	{
		return start;
	}
	devices[start].vid = vid;
	devices[start].pid = pid;
	devices[start].dev = NULL;
	return start + 1;
}

static void check_empty_list(void)
{
	discovered.clear();
	CHECK(tigl_find() == 0);
	CHECK(tigl_n_devices == 0);
	CHECK(lists_allocated == lists_freed);
}

static void check_repeated_discovery_and_detachment(void)
{
	libusb_device supported = { VID_TI, PID_TI84P };
	libusb_device unsupported = { 0xffff, 0xffff };
	discovered = { &unsupported, &supported };
	for (int i = 0; i < 20; i++)
	{
		CHECK(tigl_find() == 1);
		CHECK(tigl_devices[0].dev == &supported);
		CHECK(supported.refs == 1);
		CHECK(unsupported.refs == 0);
		// Keep WebUSB's existing device and descriptor cache alive during refresh.
		CHECK(supported.creations == 1);
		CHECK(lists_allocated == lists_freed);
	}
	// An open libusb handle owns another reference, independently of the cache.
	test_ref_device(&supported);
	discovered.clear();
	CHECK(tigl_find() == 0);
	CHECK(supported.refs == 1);
	test_unref_device(&supported);
	CHECK(supported.refs == 0);
	CHECK(lists_allocated == lists_freed);
}

static void check_device_limit(void)
{
	libusb_device devices[MAX_CABLES + 2] = {};
	discovered.clear();
	for (libusb_device &device : devices)
	{
		device.vid = VID_TI;
		device.pid = PID_TI84P;
		discovered.push_back(&device);
	}
	CHECK(tigl_find() == MAX_CABLES);
	CHECK(tigl_n_devices == MAX_CABLES);
	for (int i = 0; i < MAX_CABLES + 2; i++)
	{
		CHECK(devices[i].refs == (i < MAX_CABLES ? 1 : 0));
	}
	CHECK(lists_allocated == lists_freed);
	usb_clear_device_info();
	usb_clear_device_info();
	for (libusb_device &device : devices)
	{
		CHECK(device.refs == 0);
	}
	discovered.clear();
}

static void check_descriptor_error(void)
{
	libusb_device supported = { VID_TI, PID_TI84P };
	libusb_device broken = { VID_TI, PID_TI84P };
	broken.bad_descriptor = true;
	discovered = { &supported, &broken };
	const USBCableInfo *info = NULL;
	int count = -1;
	CHECK(usb_probe_device_info(&info, &count) == LIBUSB_ERROR_IO);
	CHECK(info == NULL);
	CHECK(count == 0);
	CHECK(tigl_n_devices == 0);
	CHECK(supported.refs == 0);
	CHECK(broken.refs == 0);
	CHECK(lists_allocated == lists_freed);
	discovered.clear();
}

static void check_list_error_and_serial_fallback(void)
{
	libusb_device supported = { VID_TI, PID_TI84P };
	discovered = { &supported };
	CHECK(tigl_find() == 1);
	list_error = LIBUSB_ERROR_ACCESS;
	CHECK(tigl_find() == 0);
	CHECK(supported.refs == 0);
	CHECK(lists_allocated == lists_freed);
	serial_available = true;
	CHECK(tigl_find() == 1);
	CHECK(tigl_devices[0].dev == NULL);
	CHECK(tigl_devices[0].pid == PID_TI84EVO);
	usb_clear_device_info();
	CHECK(tigl_n_devices == 0);
	list_error = 0;
	discovered.clear();
	CHECK(tigl_find() == 1);
	CHECK(lists_allocated == lists_freed);
	usb_clear_device_info();
	serial_available = false;
}

int main(void)
{
	check_empty_list();
	check_repeated_discovery_and_detachment();
	check_device_limit();
	check_descriptor_error();
	check_list_error_and_serial_fallback();
	return 0;
}
