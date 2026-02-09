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

/* TCP server virtual link cable unit */

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
	tcp_socket_t listen_sock;
	tcp_socket_t client_sock;
	const char *server_address;
	const char *advertised_address;
	const char *bind_address;
	uint16_t port;
} TcpsPrivData;

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

static int cidr_match(const char *cidr, const struct sockaddr *addr)
{
	char ipbuf[64];
	const char *slash = nullptr;
	int prefix_len = 32;
	struct in_addr cidr_addr;
	struct in_addr peer_addr;
	uint32_t mask = 0xffffffffU;
	uint32_t cidr_ip = 0;
	uint32_t peer_ip = 0;

	if (cidr == nullptr || *cidr == '\0')
	{
		return 1;
	}
	if (addr == nullptr || addr->sa_family != AF_INET)
	{
		return 0;
	}

	slash = strchr(cidr, '/');
	if (slash != nullptr)
	{
		size_t len = (size_t)(slash - cidr);
		char *endptr = nullptr;
		long value = 0;

		if (len == 0 || len >= sizeof(ipbuf))
		{
			return 0;
		}
		memcpy(ipbuf, cidr, len);
		ipbuf[len] = '\0';

		value = strtol(slash + 1, &endptr, 10);
		if (endptr == slash + 1 || *endptr != '\0' || value < 0 || value > 32)
		{
			return 0;
		}
		prefix_len = (int)value;
	}
	else
	{
		size_t len = strlen(cidr);
		if (len == 0 || len >= sizeof(ipbuf))
		{
			return 0;
		}
		strcpy(ipbuf, cidr);
	}

	if (inet_pton(AF_INET, ipbuf, &cidr_addr) != 1)
	{
		return 0;
	}

	peer_addr = ((const struct sockaddr_in *)addr)->sin_addr;
	cidr_ip = ntohl(cidr_addr.s_addr);
	peer_ip = ntohl(peer_addr.s_addr);

	if (prefix_len == 0)
	{
		mask = 0;
	}
	else if (prefix_len < 32)
	{
		mask = 0xffffffffU << (32 - prefix_len);
	}

	return ((cidr_ip & mask) == (peer_ip & mask)) ? 1 : 0;
}

static unsigned int tcps_timeout_ms(const CableHandle *h)
{
	return h->timeout * 100;
}

static unsigned int tcps_wait_slice_ms(const CableHandle *h, tiTIME clk)
{
	const unsigned int total = tcps_timeout_ms(h);
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

static void tcps_free_priv(TcpsPrivData *priv)
{
	if (priv == nullptr)
	{
		return;
	}

	if (priv->client_sock != TCP_INVALID_SOCKET)
	{
		tcp_close(priv->client_sock);
		priv->client_sock = TCP_INVALID_SOCKET;
	}
	if (priv->listen_sock != TCP_INVALID_SOCKET)
	{
		tcp_close(priv->listen_sock);
		priv->listen_sock = TCP_INVALID_SOCKET;
	}
	free(priv);
}

static int tcps_prepare(CableHandle *h)
{
	TcpsPrivData *priv = nullptr;
	const char *bind_address = "0.0.0.0";
	const char *server_address = nullptr;
	const char *advertised_address = nullptr;
	uint16_t port = 4242;

	if (h->options != nullptr && h->options->model == CABLE_TCPS && h->options->has_parameters)
	{
		if (h->options->parameters.tcps.bind_address != nullptr)
		{
			bind_address = h->options->parameters.tcps.bind_address;
		}
		if (h->options->parameters.tcps.server_address != nullptr)
		{
			server_address = h->options->parameters.tcps.server_address;
		}
		if (h->options->parameters.tcps.advertised_address != nullptr)
		{
			advertised_address = h->options->parameters.tcps.advertised_address;
		}
		if (h->options->parameters.tcps.port != 0)
		{
			port = h->options->parameters.tcps.port;
		}
	}

	priv = (TcpsPrivData *)calloc(1, sizeof(TcpsPrivData));
	if (priv == nullptr)
	{
		return ERR_TCPS_OPEN;
	}

	priv->listen_sock = TCP_INVALID_SOCKET;
	priv->client_sock = TCP_INVALID_SOCKET;
	priv->port = port;
	priv->bind_address = bind_address;
	priv->server_address = server_address;
	priv->advertised_address = advertised_address;

	tcps_free_priv((TcpsPrivData *)h->priv2);
	h->priv2 = priv;

	return 0;
}

static int tcps_open(CableHandle *h)
{
	TcpsPrivData *priv = (TcpsPrivData *)h->priv2;
	struct addrinfo hints;
	struct addrinfo *result = nullptr;
	struct addrinfo *rp = nullptr;
	struct sockaddr_storage peer_addr;
	socklen_t peer_len = sizeof(peer_addr);
	char port_str[16];
	int ret = ERR_TCPS_OPEN;
	int wait_ret = 0;
	unsigned int timeout_ms = tcps_timeout_ms(h);

	if (priv == nullptr || priv->bind_address == nullptr)
	{
		return ERR_TCPS_OPEN;
	}

	snprintf(port_str, sizeof(port_str), "%u", priv->port);
	memset(&hints, 0, sizeof(hints));
	hints.ai_family = AF_UNSPEC;
	hints.ai_socktype = SOCK_STREAM;
	hints.ai_protocol = IPPROTO_TCP;
	hints.ai_flags = AI_PASSIVE;

	if (getaddrinfo(priv->bind_address, port_str, &hints, &result) != 0)
	{
		return ERR_TCPS_BIND;
	}

	for (rp = result; rp != nullptr; rp = rp->ai_next)
	{
		int one = 1;
		priv->listen_sock = socket(rp->ai_family, rp->ai_socktype, rp->ai_protocol);
		if (priv->listen_sock == TCP_INVALID_SOCKET)
		{
			continue;
		}

		setsockopt(priv->listen_sock, SOL_SOCKET, SO_REUSEADDR, (const char *)&one, sizeof(one));
		if (bind(priv->listen_sock, rp->ai_addr, (socklen_t)rp->ai_addrlen) == 0)
		{
			break;
		}

		tcp_close(priv->listen_sock);
		priv->listen_sock = TCP_INVALID_SOCKET;
	}

	freeaddrinfo(result);

	if (priv->listen_sock == TCP_INVALID_SOCKET)
	{
		return ERR_TCPS_BIND;
	}

	if (listen(priv->listen_sock, 1) != 0)
	{
		tcp_close(priv->listen_sock);
		priv->listen_sock = TCP_INVALID_SOCKET;
		return ERR_TCPS_LISTEN;
	}

	if (tcp_set_nonblocking(priv->listen_sock, 1) != 0)
	{
		tcp_close(priv->listen_sock);
		priv->listen_sock = TCP_INVALID_SOCKET;
		return ERR_TCPS_OPEN;
	}

	wait_ret = tcp_wait_socket(priv->listen_sock, 1, timeout_ms);
	if (wait_ret == 0)
	{
		ret = ERR_TCPS_ACCEPT;
		goto fail;
	}
	if (wait_ret < 0)
	{
		ret = ERR_TCPS_ACCEPT;
		goto fail;
	}

	priv->client_sock = accept(priv->listen_sock, (struct sockaddr *)&peer_addr, &peer_len);
	if (priv->client_sock == TCP_INVALID_SOCKET)
	{
		ret = ERR_TCPS_ACCEPT;
		goto fail;
	}

	if (priv->server_address != nullptr && !cidr_match(priv->server_address, (struct sockaddr *)&peer_addr))
	{
		tcp_close(priv->client_sock);
		priv->client_sock = TCP_INVALID_SOCKET;
		ret = ERR_TCPS_ACCEPT;
		goto fail;
	}

	if (tcp_set_nonblocking(priv->client_sock, 0) != 0)
	{
		tcp_close(priv->client_sock);
		priv->client_sock = TCP_INVALID_SOCKET;
		ret = ERR_TCPS_OPEN;
		goto fail;
	}

	{
		int one = 1;
		setsockopt(priv->client_sock, IPPROTO_TCP, TCP_NODELAY, (const char *)&one, sizeof(one));
	}

	ret = 0;
	return ret;

fail:
	if (priv->listen_sock != TCP_INVALID_SOCKET)
	{
		tcp_close(priv->listen_sock);
		priv->listen_sock = TCP_INVALID_SOCKET;
	}
	if (priv->client_sock != TCP_INVALID_SOCKET)
	{
		tcp_close(priv->client_sock);
		priv->client_sock = TCP_INVALID_SOCKET;
	}
	return ret;
}

static int tcps_close(CableHandle *h)
{
	tcps_free_priv((TcpsPrivData *)h->priv2);
	h->priv2 = nullptr;
	return 0;
}

static int tcps_reset(CableHandle *h)
{
	TcpsPrivData *priv = (TcpsPrivData *)h->priv2;
	char buffer[1024];
	int rc = 0;

	if (priv == nullptr || priv->client_sock == TCP_INVALID_SOCKET)
	{
		return ERR_TCPS_CLOSE;
	}

	if (tcp_set_nonblocking(priv->client_sock, 1) != 0)
	{
		return ERR_FLUSH_ERROR;
	}

	for (;;)
	{
		rc = recv(priv->client_sock, buffer, sizeof(buffer), 0);
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

	if (tcp_set_nonblocking(priv->client_sock, 0) != 0)
	{
		return ERR_FLUSH_ERROR;
	}

	return 0;
}

static int tcps_probe(CableHandle *h)
{
	(void)h;
	return 0;
}

static int tcps_put(CableHandle *h, uint8_t *data, uint32_t len)
{
	TcpsPrivData *priv = (TcpsPrivData *)h->priv2;
	tiTIME clk;
	uint32_t sent = 0;

	if (priv == nullptr || priv->client_sock == TCP_INVALID_SOCKET)
	{
		return ERR_NOT_OPEN;
	}

	TO_START(clk);
	while (sent < len)
	{
		const unsigned int timeout_ms = tcps_wait_slice_ms(h, clk);
		int wait_ret = tcp_wait_socket(priv->client_sock, 0, timeout_ms);
		if (wait_ret == 0 || TO_ELAPSED(clk, h->timeout))
		{
			return ERR_WRITE_TIMEOUT;
		}
		if (wait_ret < 0)
		{
			return ERR_WRITE_ERROR;
		}

		{
			int rc = send(priv->client_sock, (const char *)(data + sent), (int)(len - sent), 0);
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

static int tcps_get(CableHandle *h, uint8_t *data, uint32_t len)
{
	TcpsPrivData *priv = (TcpsPrivData *)h->priv2;
	tiTIME clk;
	uint32_t received = 0;

	if (priv == nullptr || priv->client_sock == TCP_INVALID_SOCKET)
	{
		return ERR_NOT_OPEN;
	}

	TO_START(clk);
	while (received < len)
	{
		const unsigned int timeout_ms = tcps_wait_slice_ms(h, clk);
		int wait_ret = tcp_wait_socket(priv->client_sock, 1, timeout_ms);
		if (wait_ret == 0 || TO_ELAPSED(clk, h->timeout))
		{
			return ERR_READ_TIMEOUT;
		}
		if (wait_ret < 0)
		{
			return ERR_READ_ERROR;
		}

		{
			int rc = recv(priv->client_sock, (char *)(data + received), (int)(len - received), 0);
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

static int tcps_check(CableHandle *h, int *status)
{
	TcpsPrivData *priv = (TcpsPrivData *)h->priv2;
	int ret = 0;

	if (status == nullptr)
	{
		return ERR_ILLEGAL_ARG;
	}

	*status = STATUS_NONE;

	if (priv == nullptr || priv->client_sock == TCP_INVALID_SOCKET)
	{
		return ERR_NOT_OPEN;
	}

	ret = tcp_wait_socket(priv->client_sock, 1, 0);
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

static int tcps_set_device(CableHandle *h, const char * device)
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

extern const CableFncts cable_tcps =
{
	CABLE_TCPS,
	"TCPS",
	N_("TCPS"),
	N_("Virtual TCP server link"),
	0,
	&tcps_prepare,
	&tcps_open, &tcps_close, &tcps_reset, &tcps_probe, NULL,
	&tcps_put, &tcps_get, &tcps_check,
	&noop_set_red_wire, &noop_set_white_wire,
	&noop_get_red_wire, &noop_get_white_wire,
	NULL, NULL,
	&tcps_set_device,
	NULL
};
