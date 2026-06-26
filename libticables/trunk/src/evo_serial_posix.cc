#ifdef HAVE_CONFIG_H
#include <config.h>
#endif

#if !defined(__WIN32__)

#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <termios.h>
#include <unistd.h>
#include <sys/select.h>

#include "evo_serial.h"
#include "error.h"
#include "logging.h"

static int evo_posix_serial_configure(int fd)
{
	struct termios attrs;

	if (tcgetattr(fd, &attrs) < 0)
	{
		return ERR_SERIAL_IOCTL;
	}

	cfmakeraw(&attrs);
	attrs.c_cflag |= CLOCAL | CREAD;
	attrs.c_cflag &= ~(PARENB | CSTOPB | CSIZE);
#ifdef CRTSCTS
	attrs.c_cflag &= ~CRTSCTS;
#endif
	attrs.c_cflag |= CS8;
	attrs.c_cc[VMIN] = 0;
	attrs.c_cc[VTIME] = 0;
	cfsetispeed(&attrs, B115200);
	cfsetospeed(&attrs, B115200);

	if (tcsetattr(fd, TCSANOW, &attrs) < 0)
	{
		return ERR_SERIAL_IOCTL;
	}
	tcflush(fd, TCIOFLUSH);
	return 0;
}

int evo_posix_serial_open_path(CableHandle *h, EvoSerial *serial, const char *path)
{
	int fd = open(path, O_RDWR | O_NOCTTY | O_NONBLOCK);
	if (fd < 0)
	{
		ticables_warning("failed to open TI-84 Evo serial device %s: %s\n", path, strerror(errno));
		return ERR_SERIAL_OPEN;
	}

	int ret = evo_posix_serial_configure(fd);
	if (ret)
	{
		ticables_warning("failed to configure TI-84 Evo serial device %s\n", path);
		close(fd);
		return ret;
	}

	serial->fd = fd;
	free(h->device);
	h->device = strdup(path);
	ticables_info("using TI-84 Evo serial device %s\n", path);
	return 0;
}

void evo_posix_serial_close(EvoSerial *serial)
{
	if (serial != nullptr && serial->fd >= 0)
	{
		close(serial->fd);
	}
	evo_serial_init(serial);
}

int evo_posix_serial_reset(EvoSerial *serial)
{
	if (serial == nullptr || serial->fd < 0)
	{
		return ERR_SERIAL_IOCTL;
	}
	return tcflush(serial->fd, TCIOFLUSH) ? ERR_SERIAL_IOCTL : 0;
}

int evo_posix_serial_send(CableHandle *h, EvoSerial *serial, uint8_t *data, uint32_t len)
{
	uint32_t done = 0;
	while (done < len)
	{
		fd_set wfds;
		struct timeval tv;
		int ready;
		ssize_t written;

		FD_ZERO(&wfds);
		FD_SET(serial->fd, &wfds);
		tv.tv_sec = evo_serial_timeout_ms(h) / 1000;
		tv.tv_usec = (evo_serial_timeout_ms(h) % 1000) * 1000;
		ready = select(serial->fd + 1, nullptr, &wfds, nullptr, &tv);
		if (ready == 0)
		{
			return ERR_WRITE_TIMEOUT;
		}
		if (ready < 0)
		{
			if (errno == EINTR)
			{
				continue;
			}
			return ERR_WRITE_ERROR;
		}

		written = write(serial->fd, data + done, len - done);
		if (written < 0)
		{
			if (errno == EAGAIN || errno == EINTR)
			{
				continue;
			}
			return ERR_WRITE_ERROR;
		}
		done += (uint32_t)written;
	}
	return 0;
}

int evo_posix_serial_recv(CableHandle *h, EvoSerial *serial, uint8_t *data, uint32_t len)
{
	uint32_t done = 0;
	while (done < len)
	{
		fd_set rfds;
		struct timeval tv;
		int ready;
		ssize_t got;

		FD_ZERO(&rfds);
		FD_SET(serial->fd, &rfds);
		tv.tv_sec = evo_serial_timeout_ms(h) / 1000;
		tv.tv_usec = (evo_serial_timeout_ms(h) % 1000) * 1000;
		ready = select(serial->fd + 1, &rfds, nullptr, nullptr, &tv);
		if (ready == 0)
		{
			return ERR_READ_TIMEOUT;
		}
		if (ready < 0)
		{
			if (errno == EINTR)
			{
				continue;
			}
			return ERR_READ_ERROR;
		}

		got = read(serial->fd, data + done, len - done);
		if (got < 0)
		{
			if (errno == EAGAIN || errno == EINTR)
			{
				continue;
			}
			return ERR_READ_ERROR;
		}
		if (got == 0)
		{
			continue;
		}
		done += (uint32_t)got;
	}
	return 0;
}

int evo_posix_serial_check(CableHandle *h, EvoSerial *serial, int *status)
{
	fd_set rfds;
	struct timeval tv;
	int ret;

	FD_ZERO(&rfds);
	FD_SET(serial->fd, &rfds);
	tv.tv_sec = 0;
	tv.tv_usec = 0;
	ret = select(serial->fd + 1, &rfds, nullptr, nullptr, &tv);
	if (ret < 0)
	{
		return ERR_READ_ERROR;
	}
	*status = ret > 0 ? STATUS_RX : STATUS_NONE;
	return 0;
}

#endif
