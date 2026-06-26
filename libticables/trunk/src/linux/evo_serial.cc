#ifdef HAVE_CONFIG_H
#include <config.h>
#endif

#if defined(__LINUX__) && defined(HAVE_LIBUSB_1_0)

#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(__BSD__) || defined(__MACOSX__) || defined(__EMSCRIPTEN__)
#include <libusb.h>
#else
#include <libusb-1.0/libusb.h>
#endif

#include "../evo_serial.h"
#include "../error.h"
#include "../gettext.h"
#include "../logging.h"

static int evo_read_sysfs_text(const char *dirpath, const char *name, char *out, size_t out_size)
{
	char path[PATH_MAX];
	FILE *fp;
	size_t len;

	if (out == nullptr || out_size == 0)
	{
		return 0;
	}

	ticables_slprintf(path, sizeof(path), "%s/%s", dirpath, name);
	fp = fopen(path, "r");
	if (fp == nullptr)
	{
		return 0;
	}

	if (fgets(out, (int)out_size, fp) == nullptr)
	{
		fclose(fp);
		out[0] = 0;
		return 0;
	}
	fclose(fp);

	len = strlen(out);
	while (len > 0 && (out[len - 1] == '\n' || out[len - 1] == '\r'))
	{
		out[--len] = 0;
	}
	return out[0] != 0;
}

static int evo_read_sysfs_u16_hex(const char *dirpath, const char *name)
{
	char text[32];
	if (!evo_read_sysfs_text(dirpath, name, text, sizeof(text)))
	{
		return 0;
	}
	return (int)strtoul(text, nullptr, 16);
}

static int evo_sysfs_device_matches(const char *dirpath, uint16_t vid, uint16_t pid)
{
	return evo_read_sysfs_u16_hex(dirpath, "idVendor") == vid &&
	       evo_read_sysfs_u16_hex(dirpath, "idProduct") == pid;
}

static int evo_find_tty_in_sysfs(const char *dirpath, char *path, size_t path_size, int depth)
{
	DIR *dir;
	struct dirent *entry;
	int ret = ERR_SERIAL_OPEN;

	if (depth > 8)
	{
		return ERR_SERIAL_OPEN;
	}

	dir = opendir(dirpath);
	if (dir == nullptr)
	{
		return ERR_SERIAL_OPEN;
	}

	while (ret && (entry = readdir(dir)) != nullptr)
	{
		char child[PATH_MAX];

		if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, ".."))
		{
			continue;
		}

		ticables_slprintf(child, sizeof(child), "%s/%s", dirpath, entry->d_name);
		if (!strcmp(entry->d_name, "tty"))
		{
			DIR *ttydir = opendir(child);
			if (ttydir != nullptr)
			{
				struct dirent *tty;
				while ((tty = readdir(ttydir)) != nullptr)
				{
					if (tty->d_name[0] != '.')
					{
						ticables_slprintf(path, path_size, "/dev/%s", tty->d_name);
						ret = 0;
						break;
					}
				}
				closedir(ttydir);
			}
		}
		else
		{
			ret = evo_find_tty_in_sysfs(child, path, path_size, depth + 1);
		}
	}

	closedir(dir);
	return ret;
}

static int evo_find_linux_serial_path(libusb_device *device, char *path, size_t path_size)
{
	uint8_t ports[8];
	int nports = libusb_get_port_numbers(device, ports, sizeof(ports));
	char sysdev[PATH_MAX];
	int i;

	if (nports <= 0)
	{
		return ERR_SERIAL_OPEN;
	}

	ticables_slprintf(sysdev, sizeof(sysdev), "/sys/bus/usb/devices/%u-%u", libusb_get_bus_number(device), ports[0]);
	for (i = 1; i < nports; i++)
	{
		char segment[16];
		const size_t sysdev_len = strlen(sysdev);
		ticables_slprintf(segment, sizeof(segment), ".%u", ports[i]);
		if (sysdev_len + strlen(segment) >= sizeof(sysdev))
		{
			return ERR_SERIAL_OPEN;
		}
		strcat(sysdev, segment);
	}
	if (sysdev[0] == 0)
	{
		return ERR_SERIAL_OPEN;
	}

	return evo_find_tty_in_sysfs(sysdev, path, path_size, 0);
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

	if (info != nullptr && info->dev != nullptr)
	{
		ret = evo_find_linux_serial_path((libusb_device *)info->dev, path, path_size);
		if (!ret)
		{
			return 0;
		}
	}

	return ERR_SERIAL_OPEN;
}

int evo_serial_add_devices(USBCableInfo *devices, int start, int max_devices, uint16_t vid, uint16_t pid)
{
	DIR *dir = opendir("/sys/bus/usb/devices");
	struct dirent *entry;
	int j = start;

	if (dir == nullptr)
	{
		return start;
	}

	while (j < max_devices && (entry = readdir(dir)) != nullptr)
	{
		char sysdev[PATH_MAX];
		char path[sizeof(devices[j].device_path)];
		char product[sizeof(devices[j].product_str)];
		bool already_listed = false;
		int idx;

		if (entry->d_name[0] == '.')
		{
			continue;
		}
		ticables_slprintf(sysdev, sizeof(sysdev), "/sys/bus/usb/devices/%s", entry->d_name);
		if (!evo_sysfs_device_matches(sysdev, vid, pid) || evo_find_tty_in_sysfs(sysdev, path, sizeof(path), 0))
		{
			continue;
		}

		for (idx = 0; idx < j; idx++)
		{
			if (!strcmp(devices[idx].device_path, path))
			{
				already_listed = true;
				break;
			}
		}
		if (already_listed)
		{
			continue;
		}

		if (!evo_read_sysfs_text(sysdev, "product", product, sizeof(product)))
		{
			ticables_slprintf(product, sizeof(product), "%s", "TI-84 Evo");
		}

		devices[j].vid = vid;
		devices[j].pid = pid;
		devices[j].version = (uint16_t)evo_read_sysfs_u16_hex(sysdev, "bcdDevice");
		ticables_slprintf(devices[j].product_str, sizeof(devices[j].product_str), "%s", product);
		ticables_slprintf(devices[j].device_path, sizeof(devices[j].device_path), "%s", path);
		devices[j].dev = nullptr;
		ticables_info(_(" found %s on #%i through CDC serial <%s>\n"), devices[j].product_str, j + 1, path);
		j++;
	}

	closedir(dir);
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
