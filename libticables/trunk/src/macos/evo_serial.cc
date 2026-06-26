#ifdef HAVE_CONFIG_H
#include <config.h>
#endif

#if defined(__MACOSX__)

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/IOKitLib.h>
#include <IOKit/serial/IOSerialKeys.h>
#include <IOKit/usb/USB.h>

#include "../evo_serial.h"
#include "../error.h"
#include "../gettext.h"
#include "../logging.h"

static int macos_cfstring_to_cstr(CFStringRef str, char *out, size_t out_size)
{
	if (str == nullptr || out == nullptr || out_size == 0)
	{
		return 0;
	}

	if (!CFStringGetCString(str, out, out_size, kCFStringEncodingUTF8))
	{
		out[0] = 0;
		return 0;
	}
	return 1;
}

static int macos_cfstring_matches(CFStringRef str, const char *expected)
{
	char value[128];
	return macos_cfstring_to_cstr(str, value, sizeof(value)) && !strcmp(value, expected);
}

static int macos_cfnumber_matches_u16(CFTypeRef value, uint16_t expected)
{
	int n = 0;
	return value != nullptr && CFGetTypeID(value) == CFNumberGetTypeID() && CFNumberGetValue((CFNumberRef)value, kCFNumberIntType, &n) && n == expected;
}

static int macos_usb_device_has_product(io_service_t device, const char *product)
{
	CFTypeRef product_ref = IORegistryEntryCreateCFProperty(device, CFSTR("kUSBProductString"), kCFAllocatorDefault, 0);
	int matches = product_ref != nullptr && CFGetTypeID(product_ref) == CFStringGetTypeID() && macos_cfstring_matches((CFStringRef)product_ref, product);
	if (product_ref != nullptr)
	{
		CFRelease(product_ref);
	}

	if (!matches)
	{
		product_ref = IORegistryEntryCreateCFProperty(device, CFSTR("USB Product Name"), kCFAllocatorDefault, 0);
		matches = product_ref != nullptr && CFGetTypeID(product_ref) == CFStringGetTypeID() && macos_cfstring_matches((CFStringRef)product_ref, product);
		if (product_ref != nullptr)
		{
			CFRelease(product_ref);
		}
	}
	return matches;
}

static int macos_usb_device_has_vid_pid(io_service_t device, uint16_t vid, uint16_t pid)
{
	CFTypeRef vid_ref = IORegistryEntryCreateCFProperty(device, CFSTR("idVendor"), kCFAllocatorDefault, 0);
	CFTypeRef pid_ref = IORegistryEntryCreateCFProperty(device, CFSTR("idProduct"), kCFAllocatorDefault, 0);
	const int matches = macos_cfnumber_matches_u16(vid_ref, vid) && macos_cfnumber_matches_u16(pid_ref, pid);
	if (vid_ref != nullptr)
	{
		CFRelease(vid_ref);
	}
	if (pid_ref != nullptr)
	{
		CFRelease(pid_ref);
	}
	return matches;
}

static int macos_usb_device_get_product(io_service_t device, char *product, size_t product_size)
{
	CFTypeRef product_ref = IORegistryEntryCreateCFProperty(device, CFSTR("kUSBProductString"), kCFAllocatorDefault, 0);
	int ret = product_ref != nullptr && CFGetTypeID(product_ref) == CFStringGetTypeID() && macos_cfstring_to_cstr((CFStringRef)product_ref, product, product_size);
	if (product_ref != nullptr)
	{
		CFRelease(product_ref);
	}

	if (!ret)
	{
		product_ref = IORegistryEntryCreateCFProperty(device, CFSTR("USB Product Name"), kCFAllocatorDefault, 0);
		ret = product_ref != nullptr && CFGetTypeID(product_ref) == CFStringGetTypeID() && macos_cfstring_to_cstr((CFStringRef)product_ref, product, product_size);
		if (product_ref != nullptr)
		{
			CFRelease(product_ref);
		}
	}
	return ret;
}

static uint16_t macos_usb_device_get_u16_property(io_service_t device, CFStringRef key)
{
	CFTypeRef value = IORegistryEntryCreateCFProperty(device, key, kCFAllocatorDefault, 0);
	int n = 0;
	if (value != nullptr && CFGetTypeID(value) == CFNumberGetTypeID())
	{
		CFNumberGetValue((CFNumberRef)value, kCFNumberIntType, &n);
	}
	if (value != nullptr)
	{
		CFRelease(value);
	}
	return (uint16_t)n;
}

static int macos_usb_device_serial_path(io_service_t device, char *path, size_t path_size)
{
	io_iterator_t iter = IO_OBJECT_NULL;
	int ret = ERR_SERIAL_OPEN;
	io_object_t child;

	if (IORegistryEntryCreateIterator(device, kIOServicePlane, kIORegistryIterateRecursively, &iter) != KERN_SUCCESS)
	{
		return ERR_SERIAL_OPEN;
	}

	while ((child = IOIteratorNext(iter)) != IO_OBJECT_NULL)
	{
		if (IOObjectConformsTo(child, "IOSerialBSDClient"))
		{
			CFTypeRef callout = IORegistryEntryCreateCFProperty(child, CFSTR(kIOCalloutDeviceKey), kCFAllocatorDefault, 0);
			if (callout != nullptr && CFGetTypeID(callout) == CFStringGetTypeID() && macos_cfstring_to_cstr((CFStringRef)callout, path, path_size))
			{
				ret = 0;
			}
			if (callout != nullptr)
			{
				CFRelease(callout);
			}
		}
		IOObjectRelease(child);
		if (!ret)
		{
			break;
		}
	}
	IOObjectRelease(iter);
	return ret;
}

static int evo_find_macos_serial_path(char *path, size_t path_size, const char *product, uint16_t vid, uint16_t pid)
{
	CFMutableDictionaryRef matching = IOServiceMatching("IOUSBHostDevice");
	io_iterator_t iter = IO_OBJECT_NULL;
	int ret = ERR_SERIAL_OPEN;
	io_service_t device;

	if (matching == nullptr)
	{
		return ERR_SERIAL_OPEN;
	}

	if (IOServiceGetMatchingServices(MACH_PORT_NULL, matching, &iter) != KERN_SUCCESS)
	{
		return ERR_SERIAL_OPEN;
	}

	while ((device = IOIteratorNext(iter)) != IO_OBJECT_NULL)
	{
		if (macos_usb_device_has_vid_pid(device, vid, pid) && (product == nullptr || *product == 0 || macos_usb_device_has_product(device, product)))
		{
			ret = macos_usb_device_serial_path(device, path, path_size);
		}
		IOObjectRelease(device);
		if (!ret)
		{
			break;
		}
	}
	IOObjectRelease(iter);
	return ret;
}

static int evo_find_configured_path(char *path, size_t path_size, const USBCableInfo *info)
{
	const char *configured = getenv("TICABLES_EVO_SERIAL");
	if (configured != nullptr && *configured != 0)
	{
		ticables_slprintf(path, path_size, "%s", configured);
		return 0;
	}

	if (info != nullptr && info->device_path[0] != 0)
	{
		ticables_slprintf(path, path_size, "%s", info->device_path);
		return 0;
	}

	return ERR_SERIAL_OPEN;
}

void evo_serial_init(EvoSerial *serial)
{
	if (serial != nullptr)
	{
		serial->fd = -1;
		serial->handle = nullptr;
	}
}

int evo_serial_is_open(const EvoSerial *serial)
{
	return serial != nullptr && serial->fd >= 0;
}

int evo_serial_find_path(char *path, size_t path_size, const USBCableInfo *info)
{
	int ret = evo_find_configured_path(path, path_size, info);
	if (!ret)
	{
		return 0;
	}

	return evo_find_macos_serial_path(path, path_size, info != nullptr ? info->product_str : nullptr, info != nullptr ? info->vid : 0, info != nullptr ? info->pid : 0);
}

int evo_serial_add_devices(USBCableInfo *devices, int start, int max_devices, uint16_t vid, uint16_t pid)
{
	CFMutableDictionaryRef matching = IOServiceMatching("IOUSBHostDevice");
	io_iterator_t iter = IO_OBJECT_NULL;
	int j = start;
	io_service_t device;

	if (matching == nullptr)
	{
		return start;
	}

	if (IOServiceGetMatchingServices(MACH_PORT_NULL, matching, &iter) != KERN_SUCCESS)
	{
		return start;
	}

	while (j < max_devices && (device = IOIteratorNext(iter)) != IO_OBJECT_NULL)
	{
		char product[sizeof(devices[j].product_str)];
		char path[sizeof(devices[j].device_path)];
		if (macos_usb_device_has_vid_pid(device, vid, pid) &&
		    macos_usb_device_get_product(device, product, sizeof(product)) &&
		    !macos_usb_device_serial_path(device, path, sizeof(path)))
		{
			bool already_listed = false;
			int idx;
			for (idx = 0; idx < j; idx++)
			{
				if (!strcmp(devices[idx].device_path, path))
				{
					already_listed = true;
					break;
				}
			}
			if (!already_listed)
			{
				devices[j].vid = vid;
				devices[j].pid = pid;
				devices[j].version = macos_usb_device_get_u16_property(device, CFSTR("bcdDevice"));
				ticables_slprintf(devices[j].product_str, sizeof(devices[j].product_str), "%s", product);
				ticables_slprintf(devices[j].device_path, sizeof(devices[j].device_path), "%s", path);
				devices[j].dev = nullptr;
				ticables_info(_(" found %s on #%i through CDC serial <%s>\n"), devices[j].product_str, j + 1, path);
				j++;
			}
		}
		IOObjectRelease(device);
	}
	IOObjectRelease(iter);
	return j;
}

int evo_serial_open(CableHandle *h, EvoSerial *serial, const USBCableInfo *info)
{
	char path[PATH_MAX];
	int ret = evo_serial_find_path(path, sizeof(path), info);
	if (ret)
	{
		return ret;
	}
	return evo_posix_serial_open_path(h, serial, path);
}

void evo_serial_close(EvoSerial *serial)
{
	evo_posix_serial_close(serial);
}

int evo_serial_reset(EvoSerial *serial)
{
	return evo_posix_serial_reset(serial);
}

int evo_serial_send(CableHandle *h, EvoSerial *serial, uint8_t *data, uint32_t len)
{
	return evo_posix_serial_send(h, serial, data, len);
}

int evo_serial_recv(CableHandle *h, EvoSerial *serial, uint8_t *data, uint32_t len)
{
	return evo_posix_serial_recv(h, serial, data, len);
}

int evo_serial_check(CableHandle *h, EvoSerial *serial, int *status)
{
	return evo_posix_serial_check(h, serial, status);
}

#endif
