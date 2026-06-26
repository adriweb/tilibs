#ifdef HAVE_CONFIG_H
#include <config.h>
#endif

#include "evo_serial.h"
#include "error.h"

#if defined(__EMSCRIPTEN__)
# include <stdio.h>
# include <stdlib.h>
# include <string.h>
# include "gettext.h"
# include "logging.h"
# include "webserial.h"

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

int evo_serial_open(CableHandle *h, EvoSerial *serial, const USBCableInfo *info)
{
	(void)info;
	if (serial == nullptr)
	{
		return ERR_SERIAL_OPEN;
	}

	int ret = webserial_open(WEBSERIAL_KIND_EVO, 115200, 8, 1, 0, 0x0451, 0xE018);
	if (ret)
	{
		return ERR_SERIAL_OPEN;
	}

	serial->fd = 1;
	serial->handle = nullptr;
	free(h->device);
	h->device = strdup("WebSerial TI-84 Evo");
	ticables_info("using TI-84 Evo WebSerial device\n");
	return 0;
}

void evo_serial_close(EvoSerial *serial)
{
	if (serial != nullptr && evo_serial_is_open(serial))
	{
		webserial_close(WEBSERIAL_KIND_EVO);
	}
	evo_serial_init(serial);
}

int evo_serial_reset(EvoSerial *serial)
{
	(void)serial;
	return 0;
}

int evo_serial_send(CableHandle *h, EvoSerial *serial, uint8_t *data, uint32_t len)
{
	(void)h;
	if (!evo_serial_is_open(serial))
	{
		return ERR_WRITE_ERROR;
	}

	uint32_t done = 0;
	while (done < len)
	{
		int ret = webserial_write(WEBSERIAL_KIND_EVO, data + done, (int)(len - done));
		if (ret < 0)
		{
			return ERR_WRITE_ERROR;
		}
		if (ret == 0)
		{
			return ERR_WRITE_TIMEOUT;
		}
		done += (uint32_t)ret;
	}
	return 0;
}

int evo_serial_recv(CableHandle *h, EvoSerial *serial, uint8_t *data, uint32_t len)
{
	if (!evo_serial_is_open(serial))
	{
		return ERR_READ_ERROR;
	}

	uint32_t done = 0;
	while (done < len)
	{
		int ret = webserial_read(WEBSERIAL_KIND_EVO, data + done, (int)(len - done), (int)evo_serial_timeout_ms(h));
		if (ret == -2)
		{
			return ERR_READ_TIMEOUT;
		}
		if (ret < 0)
		{
			return ERR_READ_ERROR;
		}
		if (ret == 0)
		{
			return ERR_READ_TIMEOUT;
		}
		done += (uint32_t)ret;
	}
	return 0;
}

int evo_serial_check(CableHandle *h, EvoSerial *serial, int *status)
{
	(void)h;
	if (status != nullptr)
	{
		*status = evo_serial_is_open(serial) && webserial_available(WEBSERIAL_KIND_EVO) > 0 ? STATUS_RX : STATUS_NONE;
	}
	return 0;
}

int evo_serial_has_bound_device(void)
{
	return webserial_has_bound_evo();
}

int evo_serial_find_path(char *path, size_t path_size, const USBCableInfo *info)
{
	(void)info;
	if (!webserial_has_bound_evo() && !webserial_has_authorized_evo())
	{
		return ERR_SERIAL_OPEN;
	}
	if (path != nullptr && path_size > 0)
	{
		snprintf(path, path_size, "%s", "WebSerial TI-84 Evo");
	}
	return 0;
}

int evo_serial_add_devices(USBCableInfo *devices, int start, int max_devices, uint16_t vid, uint16_t pid)
{
	int j = start;
	if (devices == nullptr || j >= max_devices || (!webserial_has_bound_evo() && !webserial_has_authorized_evo()))
	{
		return start;
	}

	for (int idx = 0; idx < j; idx++)
	{
		if (devices[idx].vid == vid && devices[idx].pid == pid)
		{
			return start;
		}
	}

	devices[j].vid = vid;
	devices[j].pid = pid;
	devices[j].version = 0;
	snprintf(devices[j].product_str, sizeof(devices[j].product_str), "%s", "TI-84 Evo");
	snprintf(devices[j].device_path, sizeof(devices[j].device_path), "%s", "WebSerial TI-84 Evo");
	devices[j].dev = nullptr;
	ticables_info(_(" found %s on #%i through WebSerial\n"), devices[j].product_str, j + 1);
	return j + 1;
}

#elif defined(__WIN32__)
# include "win32/evo_serial.cc"
#elif defined(__MACOSX__) && defined(HAVE_LIBUSB_1_0)
# include "evo_serial_posix.cc"
# include "macos/evo_serial.cc"
#elif defined(__LINUX__) && defined(HAVE_LIBUSB_1_0)
# include "evo_serial_posix.cc"
# include "linux/evo_serial.cc"
#else
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
	return 0;
}

int evo_serial_open(CableHandle *h, EvoSerial *serial, const USBCableInfo *info)
{
	return ERR_SERIAL_OPEN;
}

void evo_serial_close(EvoSerial *serial)
{
	if (serial != nullptr)
	{
		evo_serial_init(serial);
	}
}

int evo_serial_reset(EvoSerial *serial)
{
	return 0;
}

int evo_serial_send(CableHandle *h, EvoSerial *serial, uint8_t *data, uint32_t len)
{
	return ERR_WRITE_ERROR;
}

int evo_serial_recv(CableHandle *h, EvoSerial *serial, uint8_t *data, uint32_t len)
{
	return ERR_READ_ERROR;
}

int evo_serial_check(CableHandle *h, EvoSerial *serial, int *status)
{
	if (status != nullptr)
	{
		*status = STATUS_NONE;
	}
	return 0;
}

int evo_serial_has_bound_device(void)
{
	return 0;
}

int evo_serial_find_path(char *path, size_t path_size, const USBCableInfo *info)
{
	return ERR_SERIAL_OPEN;
}

int evo_serial_add_devices(USBCableInfo *devices, int start, int max_devices, uint16_t vid, uint16_t pid)
{
	return start;
}
#endif
