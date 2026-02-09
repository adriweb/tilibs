/* Hey EMACS -*- linux-c -*- */

/*  libticables2 - link cable library, a part of the TiLP project
 *  Copyright (C) 2015  Lionel Debroux
 *
 *  This program is free software; you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation; either version 2 of the License, or
 *  (at your option) any later version.
 *
 *  This program is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU General Public License for more details.
 *
 *  You should have received a copy of the GNU General Public License
 *  along with this program; if not, write to the Free Software Foundation,
 *  Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA
 */

/* TCP client virtual link cable unit */

/*
 * This unit uses a TCP socket between 2 programs which use this lib.
 */

#ifdef HAVE_CONFIG_H
#include <config.h>
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef __WIN32__
#include <winsock2.h>
#include <ws2tcpip.h>
typedef SOCKET tcp_socket_t;
#define TCP_INVALID_SOCKET INVALID_SOCKET
#define tcp_close(s) closesocket(s)
#define tcp_errno WSAGetLastError()
#define TCP_EWOULDBLOCK WSAEWOULDBLOCK
#define TCP_EINPROGRESS WSAEWOULDBLOCK
#else
#include <sys/types.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <netdb.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
typedef int tcp_socket_t;
#define TCP_INVALID_SOCKET (-1)
#define tcp_close(s) close(s)
#define tcp_errno errno
#define TCP_EWOULDBLOCK EWOULDBLOCK
#define TCP_EINPROGRESS EINPROGRESS
#endif

#include "../ticables.h"
#include "../logging.h"
#include "../error.h"
#include "../gettext.h"
#include "../internal.h"
#include "../timeout.h"

typedef struct
{
	tcp_socket_t sock;
	const char *connect_address;
	uint16_t port;
} TcpcPrivData;

static int tcp_set_nonblocking(tcp_socket_t sock, int nonblocking)
{
#ifdef __WIN32__
	unsigned long mode = nonblocking ? 1 : 0;
	return ioctlsocket(sock, FIONBIO, &mode);
#else
	int flags = fcntl(sock, F_GETFL, 0);
	if (flags < 0)
	{
		return -1;
	}
	if (nonblocking)
	{
		flags |= O_NONBLOCK;
	}
	else
	{
		flags &= ~O_NONBLOCK;
	}
	return fcntl(sock, F_SETFL, flags);
#endif
}

static int tcp_wait_socket(tcp_socket_t sock, int want_read, unsigned int timeout_ms)
{
	fd_set rfds;
	fd_set wfds;
	struct timeval tv;
	struct timeval *ptv = nullptr;

	FD_ZERO(&rfds);
	FD_ZERO(&wfds);

	if (want_read)
	{
		FD_SET(sock, &rfds);
	}
	else
	{
		FD_SET(sock, &wfds);
	}

	tv.tv_sec = timeout_ms / 1000;
	tv.tv_usec = (timeout_ms % 1000) * 1000;
	ptv = &tv;

	return select((int)(sock + 1), want_read ? &rfds : nullptr, want_read ? nullptr : &wfds, nullptr, ptv);
}

static unsigned int tcpc_timeout_ms(const CableHandle *h)
{
	return h->timeout * 100;
}

static unsigned int tcpc_wait_slice_ms(const CableHandle *h, tiTIME clk)
{
	const unsigned int total = tcpc_timeout_ms(h);
	const unsigned int slice = 200;
	const unsigned long elapsed = TO_CURRENT(clk);
	unsigned int remaining = 0;

	if (elapsed >= total)
	{
		return 0;
	}

	remaining = total - (unsigned int)elapsed;
	return remaining < slice ? remaining : slice;
}

static void tcpc_free_priv(TcpcPrivData *priv)
{
	if (priv == nullptr)
	{
		return;
	}

	if (priv->sock != TCP_INVALID_SOCKET)
	{
		tcp_close(priv->sock);
		priv->sock = TCP_INVALID_SOCKET;
	}
	free(priv);
}

static int tcpc_prepare(CableHandle *h)
{
	TcpcPrivData *priv = nullptr;
	const char *connect_address = "127.0.0.1";
	uint16_t port = 4242;

	if (h->options != nullptr && h->options->model == CABLE_TCPC && h->options->has_parameters)
	{
		if (h->options->parameters.tcpc.connect_address != nullptr)
		{
			connect_address = h->options->parameters.tcpc.connect_address;
		}
		if (h->options->parameters.tcpc.port != 0)
		{
			port = h->options->parameters.tcpc.port;
		}
	}

	priv = (TcpcPrivData *)calloc(1, sizeof(TcpcPrivData));
	if (priv == nullptr)
	{
		return ERR_TCPC_OPEN;
	}

	priv->sock = TCP_INVALID_SOCKET;
	priv->port = port;
	priv->connect_address = connect_address;

	tcpc_free_priv((TcpcPrivData *)h->priv2);
	h->priv2 = priv;

	return 0;
}

static int tcpc_open(CableHandle *h)
{
	TcpcPrivData *priv = (TcpcPrivData *)h->priv2;
	struct addrinfo hints;
	struct addrinfo *result = nullptr;
	struct addrinfo *rp = nullptr;
	char port_str[16];
	int ret = ERR_TCPC_CONNECT;

	if (priv == nullptr || priv->connect_address == nullptr)
	{
		return ERR_TCPC_OPEN;
	}

	snprintf(port_str, sizeof(port_str), "%u", priv->port);
	memset(&hints, 0, sizeof(hints));
	hints.ai_family = AF_UNSPEC;
	hints.ai_socktype = SOCK_STREAM;
	hints.ai_protocol = IPPROTO_TCP;

	if (getaddrinfo(priv->connect_address, port_str, &hints, &result) != 0)
	{
		return ERR_TCPC_CONNECT;
	}

	for (rp = result; rp != nullptr; rp = rp->ai_next)
	{
		int so_error = 0;
		socklen_t so_error_len = (socklen_t)sizeof(so_error);
		int wait_ret = 0;
		unsigned int timeout_ms = tcpc_timeout_ms(h);
		int one = 1;

		priv->sock = socket(rp->ai_family, rp->ai_socktype, rp->ai_protocol);
		if (priv->sock == TCP_INVALID_SOCKET)
		{
			continue;
		}

		if (setsockopt(priv->sock, IPPROTO_TCP, TCP_NODELAY, (const char *)&one, sizeof(one)) != 0)
		{
			ticables_warning("tcpc_open: unable to set TCP_NODELAY, continuing.");
		}

		if (tcp_set_nonblocking(priv->sock, 1) != 0)
		{
			tcp_close(priv->sock);
			priv->sock = TCP_INVALID_SOCKET;
			continue;
		}

		if (connect(priv->sock, rp->ai_addr, (socklen_t)rp->ai_addrlen) == 0)
		{
			ret = 0;
		}
		else
		{
			const int err = tcp_errno;
			if (err != TCP_EWOULDBLOCK && err != TCP_EINPROGRESS)
			{
				tcp_close(priv->sock);
				priv->sock = TCP_INVALID_SOCKET;
				continue;
			}

			wait_ret = tcp_wait_socket(priv->sock, 0, timeout_ms);
			if (wait_ret == 0)
			{
				tcp_close(priv->sock);
				priv->sock = TCP_INVALID_SOCKET;
				ret = ERR_TCPC_CONNECT;
				continue;
			}
			if (wait_ret < 0)
			{
				tcp_close(priv->sock);
				priv->sock = TCP_INVALID_SOCKET;
				ret = ERR_TCPC_CONNECT;
				continue;
			}

			if (getsockopt(priv->sock, SOL_SOCKET, SO_ERROR, (char *)&so_error, &so_error_len) != 0 || so_error != 0)
			{
				tcp_close(priv->sock);
				priv->sock = TCP_INVALID_SOCKET;
				ret = ERR_TCPC_CONNECT;
				continue;
			}

			ret = 0;
		}

		if (ret == 0)
		{
			if (tcp_set_nonblocking(priv->sock, 0) != 0)
			{
				tcp_close(priv->sock);
				priv->sock = TCP_INVALID_SOCKET;
				ret = ERR_TCPC_OPEN;
				continue;
			}
			break;
		}
	}

	freeaddrinfo(result);

	if (ret != 0)
	{
		return ret;
	}

	return 0;
}

static int tcpc_close(CableHandle *h)
{
	tcpc_free_priv((TcpcPrivData *)h->priv2);
	h->priv2 = nullptr;
	return 0;
}

static int tcpc_reset(CableHandle *h)
{
	TcpcPrivData *priv = (TcpcPrivData *)h->priv2;
	char buffer[1024];
	int rc = 0;

	if (priv == nullptr || priv->sock == TCP_INVALID_SOCKET)
	{
		return ERR_TCPC_CLOSE;
	}

	if (tcp_set_nonblocking(priv->sock, 1) != 0)
	{
		return ERR_FLUSH_ERROR;
	}

	for (;;)
	{
		rc = recv(priv->sock, buffer, sizeof(buffer), 0);
		if (rc > 0)
		{
			continue;
		}
		if (rc == 0)
		{
			break;
		}
		if (tcp_errno == TCP_EWOULDBLOCK)
		{
			break;
		}
		break;
	}

	if (tcp_set_nonblocking(priv->sock, 0) != 0)
	{
		return ERR_FLUSH_ERROR;
	}

	return 0;
}

static int tcpc_probe(CableHandle *h)
{
	(void)h;
	return 0;
}

static int tcpc_put(CableHandle *h, uint8_t *data, uint32_t len)
{
	TcpcPrivData *priv = (TcpcPrivData *)h->priv2;
	tiTIME clk;
	uint32_t sent = 0;

	if (priv == nullptr || priv->sock == TCP_INVALID_SOCKET)
	{
		return ERR_NOT_OPEN;
	}

	TO_START(clk);
	while (sent < len)
	{
		const unsigned int timeout_ms = tcpc_wait_slice_ms(h, clk);
		int wait_ret = tcp_wait_socket(priv->sock, 0, timeout_ms);
		if (wait_ret == 0 || TO_ELAPSED(clk, h->timeout))
		{
			return ERR_WRITE_TIMEOUT;
		}
		if (wait_ret < 0)
		{
			return ERR_WRITE_ERROR;
		}

		{
			int rc = send(priv->sock, (const char *)(data + sent), (int)(len - sent), 0);
			if (rc > 0)
			{
				sent += (uint32_t)rc;
				continue;
			}
			if (rc == 0)
			{
				return ERR_WRITE_ERROR;
			}
			if (tcp_errno == TCP_EWOULDBLOCK)
			{
				continue;
			}
			return ERR_WRITE_ERROR;
		}
	}

	return 0;
}

static int tcpc_get(CableHandle *h, uint8_t *data, uint32_t len)
{
	TcpcPrivData *priv = (TcpcPrivData *)h->priv2;
	tiTIME clk;
	uint32_t received = 0;

	if (priv == nullptr || priv->sock == TCP_INVALID_SOCKET)
	{
		return ERR_NOT_OPEN;
	}

	TO_START(clk);
	while (received < len)
	{
		const unsigned int timeout_ms = tcpc_wait_slice_ms(h, clk);
		int wait_ret = tcp_wait_socket(priv->sock, 1, timeout_ms);
		if (wait_ret == 0 || TO_ELAPSED(clk, h->timeout))
		{
			return ERR_READ_TIMEOUT;
		}
		if (wait_ret < 0)
		{
			return ERR_READ_ERROR;
		}

		{
			int rc = recv(priv->sock, (char *)(data + received), (int)(len - received), 0);
			if (rc > 0)
			{
				received += (uint32_t)rc;
				continue;
			}
			if (rc == 0)
			{
				return ERR_READ_ERROR;
			}
			if (tcp_errno == TCP_EWOULDBLOCK)
			{
				continue;
			}
			return ERR_READ_ERROR;
		}
	}

	return 0;
}

static int tcpc_check(CableHandle *h, int *status)
{
	TcpcPrivData *priv = (TcpcPrivData *)h->priv2;
	int ret = 0;

	if (status == nullptr)
	{
		return ERR_ILLEGAL_ARG;
	}

	*status = STATUS_NONE;

	if (priv == nullptr || priv->sock == TCP_INVALID_SOCKET)
	{
		return ERR_NOT_OPEN;
	}

	ret = tcp_wait_socket(priv->sock, 1, 0);
	if (ret < 0)
	{
		return ERR_READ_ERROR;
	}
	if (ret > 0)
	{
		*status = STATUS_RX;
	}

	return 0;
}

static int tcpc_set_device(CableHandle *h, const char * device)
{
	if (device != NULL)
	{
		char * device2 = strdup(device);
		if (device2 != NULL)
		{
			free(h->device);
			h->device = device2;
		}
		else
		{
			ticables_warning(_("unable to set device %s.\n"), device);
		}
		return 0;
	}
	return ERR_ILLEGAL_ARG;
}

extern const CableFncts cable_tcpc =
{
	CABLE_TCPC,
	"TCPC",
	N_("TCPC"),
	N_("Virtual TCP client link"),
	0,
	&tcpc_prepare,
	&tcpc_open, &tcpc_close, &tcpc_reset, &tcpc_probe, NULL,
	&tcpc_put, &tcpc_get, &tcpc_check,
	&noop_set_red_wire, &noop_set_white_wire,
	&noop_get_red_wire, &noop_get_white_wire,
	NULL, NULL,
	&tcpc_set_device,
	NULL
};
