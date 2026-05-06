#ifdef HAVE_CONFIG_H
#include <config.h>
#endif

#include "evo_serial.h"
#include "error.h"

#if defined(__WIN32__)
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

int evo_serial_find_path(char *path, size_t path_size, const USBCableInfo *info)
{
	return ERR_SERIAL_OPEN;
}

int evo_serial_add_devices(USBCableInfo *devices, int start, int max_devices, uint16_t vid, uint16_t pid)
{
	return start;
}
#endif
