/* Hey EMACS -*- linux-c -*- */

/*  libticalcs - Ti Calculator library, a part of the TiLP project
 *  Copyright (C) 2026  Adrien "Adriweb" Bertrand
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

/*
	This unit manages the NNSE ("NavNet SE") framing layer spoken by the
	TI-Nspire CX II in its default USB configuration (#1).

	NavNet raw packets are wrapped into NNSE "stream" service messages.
	The NNSE layer performs its own handshake (the device requests an
	address, then the current time), carries its own sequence numbers, and
	acknowledges messages at the NNSE level: NavNet-level acknowledgements
	are not used at all on this transport.

	All messages start with a 12-byte big-endian header:
	  misc(1) service(1) src(1) dest(1) unknown(1) reqAck(1)
	  length(2, includes header) seqno(2) checksum(2)
	The checksum is the bitwise complement of the 16-bit end-around-carry
	sum of the whole message (checksum field zeroed); verifying a message
	consists of checking that the sum over the whole message is 0xFFFF.

	Modeled on libnspire's cx2.cpp by Fabian Vogt, and on Firebird.
*/

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define NNSE_PAUSE_1MS() emscripten_sleep(1)
#define NSP_NNSE_HAS_USB_RESET 0
#else
#include "pause.h"
#define NNSE_PAUSE_1MS() PAUSE(1)
#define NSP_NNSE_HAS_USB_RESET 1
#endif

#include "ticalcs.h"
#include "internal.h"
#include "logging.h"
#include "error.h"

#include "nsp_nnse.h"
#include "nsp_vpkt.h"

// NNSE addresses
#define NSP_NNSE_ADDR_ALL     0xFF
#define NSP_NNSE_ADDR_PC      0xFE
#define NSP_NNSE_ADDR_CALC    0x01

// NNSE services
#define NSP_NNSE_SRV_ADDR_REQ 0x01
#define NSP_NNSE_SRV_TIME     0x02
#define NSP_NNSE_SRV_ECHO     0x03
#define NSP_NNSE_SRV_STREAM   0x04
#define NSP_NNSE_SRV_TRANSMIT 0x05
#define NSP_NNSE_SRV_LOOPBACK 0x06
#define NSP_NNSE_SRV_STATS    0x07
#define NSP_NNSE_SRV_STREAM_CTRL 0x08
#define NSP_NNSE_SRV_ACK_FLAG 0x80
#define NSP_NNSE_STREAM_INDEX 0x01
#define NSP_NNSE_STREAM_CTRL_STATUS 0x00
#define NSP_NNSE_STREAM_CTRL_START  0x01
#define NSP_NNSE_STREAM_CTRL_RESET  0x02

// Number of messages to process while waiting for a specific one, like libnspire.
#define NSP_NNSE_MAX_ITERATIONS 10
// TI's connector keeps sent packets and resends them when an ACK is missing.
#define NSP_NNSE_SEND_RETRIES 5
// Repeated stale fragments mean the stream is not at an NNSE boundary anymore;
// return quickly so the caller can use the normal session recovery path.
#define NSP_NNSE_MAX_RESYNC_FRAGMENTS 2
// Pull at most a short non-header fragment after a complete frame. If the next
// valid frame is already queued, the next receive will finish reading its
// header from the persistent buffer.
#define NSP_NNSE_PREFETCH_MAX (NSP_NNSE_HEADER_SIZE - 1)
// Cap on payloads queued while waiting for an NNSE-level acknowledgement.
#define NSP_NNSE_MAX_PENDING 64
// Timeouts are expressed in tenths of seconds.
#define NSP_NNSE_HANDSHAKE_TIMEOUT 40
#define NSP_NNSE_ASSOC_PROMPT_TIMEOUT 3
// CX II screenshot/file services can take several seconds before returning
// their first stream payload. Keep this ceiling close to native timeouts so we
// do not resend slow-but-valid service requests and poison the next one, while
// still respecting shorter caller-selected cleanup timeouts.
#define NSP_NNSE_STREAM_TIMEOUT_CEILING 80
#define NSP_NNSE_RESYNC_TIMEOUT 1
#define NSP_NNSE_STREAM_RESET_TIMEOUT 15
typedef struct
{
	uint8_t  misc;
	uint8_t  service;
	uint8_t  src;
	uint8_t  dest;
	uint8_t  unknown;
	uint8_t  reqack;
	uint16_t length;
	uint16_t seqno;
	uint16_t csum;
} NSPNNSEHeader;

typedef struct
{
	uint32_t size;
	uint8_t  data[1];
} NSPNNSEPendingPayload;

static uint16_t nnse_next_seqno(CalcHandle *handle);
static int nnse_send_stream_control_reset(CalcHandle *handle, uint16_t seqno);
static int nnse_wait_stream_control_reset(CalcHandle *handle, uint16_t reset_seqno);

int nsp_nnse_enabled(CalcHandle *handle)
{
	if (handle->priv.nsp_nnse_mode == 0)
	{
		uint8_t mode = 1; // legacy NavNet framing

		if (handle->cable != nullptr && handle->open)
		{
			CableDeviceInfo info = {};
			if (!ticables_cable_get_device_info(handle->cable, &info))
			{
				if (info.family == CABLE_FAMILY_USB_NSPIRE_CXII)
				{
					// Keep this consistent with the configuration choice made by libticables.
					const char * env = getenv("TILIBS_NSPIRE_CXII_LEGACY_NAVNET");
					if (env != nullptr && env[0] != 0 && env[0] != '0')
					{
						ticalcs_info("  NNSE framing disabled by TILIBS_NSPIRE_CXII_LEGACY_NAVNET");
					}
					else
					{
						mode = 2; // NNSE framing
					}
				}
			}
		}
		else
		{
			// Cable not attached / open yet, don't cache the answer.
			return 0;
		}

		handle->priv.nsp_nnse_mode = mode;
		if (mode == 2)
		{
			ticalcs_info("  NNSE framing enabled (Nspire CX II)");
		}
	}

	return handle->priv.nsp_nnse_mode == 2;
}

static void nnse_clear_buffers(CalcHandle *handle)
{
	GList * pending = (GList *)handle->priv.nsp_nnse_pending;
	for (const GList * l = pending; l != nullptr; l = l->next)
	{
		g_free(l->data);
	}
	g_list_free(pending);
	handle->priv.nsp_nnse_pending = nullptr;

	GByteArray * rx_buffer = (GByteArray *)handle->priv.nsp_nnse_rx_buffer;
	if (rx_buffer != nullptr)
	{
		g_byte_array_free(rx_buffer, TRUE);
	}
	handle->priv.nsp_nnse_rx_buffer = nullptr;
}

static int nnse_port_matches(uint16_t current_port, uint16_t passive_port, uint16_t dst_port)
{
	return dst_port == current_port || dst_port == NSP_PORT_LOGIN
	    || (passive_port != 0 && dst_port == passive_port);
}

int nsp_nnse_port_matches(CalcHandle *handle, uint16_t dst_port)
{
	return handle != nullptr
	    && nnse_port_matches(handle->priv.nsp_src_port, handle->priv.nsp_nnse_passive_port, dst_port);
}

static int nnse_stream_is_for_current_port(CalcHandle *handle, const uint8_t *payload, uint32_t payload_size)
{
	if (payload_size < 16 || payload == nullptr)
	{
		return 1;
	}

	const uint16_t dst_port = (((uint16_t)payload[8]) << 8) | payload[9];
	if (nsp_nnse_port_matches(handle, dst_port))
	{
		return 1;
	}

	ticalcs_debug("   NNSE: dropping queued NavNet packet for port %04x while waiting on port %04x",
	             dst_port, handle->priv.nsp_src_port);
	return 0;
}

static int nnse_stream_requires_ack(const uint8_t *data, uint32_t size)
{
	if (data == nullptr || size < NSP_HEADER_SIZE || data[0] != 0x54 || data[1] != 0xFD)
	{
		return 1;
	}

	const uint16_t dst_port = (((uint16_t)data[8]) << 8) | data[9];
	return dst_port != NSP_PORT_KEYPRESSES;
}

static void nnse_clear_stream_history(CalcHandle *handle)
{
	handle->priv.nsp_nnse_has_last_stream_seqno = 0;
	handle->priv.nsp_nnse_last_stream_seqno = 0;
}

static int nnse_stream_is_duplicate(CalcHandle *handle, const NSPNNSEHeader *hdr)
{
	if ((hdr->reqack & 0x08) == 0)
	{
		return 0;
	}
	return handle->priv.nsp_nnse_has_last_stream_seqno
	    && handle->priv.nsp_nnse_last_stream_seqno == hdr->seqno;
}

static void nnse_note_stream_delivered(CalcHandle *handle, const NSPNNSEHeader *hdr)
{
	handle->priv.nsp_nnse_last_stream_seqno = hdr->seqno;
	handle->priv.nsp_nnse_has_last_stream_seqno = 1;
}

void nsp_nnse_reassociate_next(CalcHandle *handle)
{
	nnse_clear_buffers(handle);
	nnse_clear_stream_history(handle);
	if (handle->priv.nsp_nnse_mode == 2 && handle->cable != nullptr && handle->open)
	{
		const uint16_t reset_seqno = nnse_next_seqno(handle);
		const int ret = nnse_send_stream_control_reset(handle, reset_seqno);
		if (ret)
		{
			ticalcs_warning("   NNSE: stream reset request failed: %i", ret);
		}
		else
		{
			const int wait_ret = nnse_wait_stream_control_reset(handle, reset_seqno);
			if (wait_ret && wait_ret != ERROR_READ_TIMEOUT)
			{
				ticalcs_warning("   NNSE: stream reset completion failed: %i", wait_ret);
			}
		}
		return;
	}
	handle->priv.nsp_nnse_handshake_done = 0;
}

void nsp_nnse_reset(CalcHandle *handle)
{
	nnse_clear_buffers(handle);
	handle->priv.nsp_nnse_mode = 0;
	handle->priv.nsp_nnse_handshake_done = 0;
	handle->priv.nsp_nnse_seqno = 0;
	handle->priv.nsp_nnse_passive_port = 0;
	nnse_clear_stream_history(handle);
}

static uint32_t nnse_checksum_acc(const uint8_t *data, uint32_t size, uint32_t acc)
{
	if (size > 0)
	{
		for (uint32_t i = 0; i < size - 1; i += 2)
		{
			acc += (((uint16_t)data[i]) << 8) | data[i + 1];
		}
		if (size & 1)
		{
			acc += ((uint16_t)data[size - 1]) << 8;
		}
	}

	return acc;
}

static uint16_t nnse_checksum_fold(uint32_t acc)
{
	while (acc >> 16)
	{
		acc = (acc >> 16) + (acc & 0xFFFF);
	}

	return (uint16_t)acc;
}

static int nnse_trace_enabled()
{
	const char *enabled = getenv("TILIBS_NNSE_TRACE");
	return enabled != nullptr && enabled[0] != 0 && strcmp(enabled, "0") != 0;
}

static void nnse_log_stale_fragment(const char *context, const uint8_t *data, uint32_t size)
{
	char hex[(NSP_NNSE_HEADER_SIZE * 3) + 1];
	uint32_t pos = 0;
	const uint32_t shown = MIN(size, (uint32_t)NSP_NNSE_HEADER_SIZE);

	for (uint32_t i = 0; i < shown && pos + 3 < sizeof(hex); i++)
	{
		pos += (uint32_t)snprintf(hex + pos, sizeof(hex) - pos, "%02X%s", data[i], i + 1 < shown ? " " : "");
	}
	hex[pos] = 0;

	if (size == 1)
	{
		ticalcs_debug("   NNSE: discarding %u stale byte(s) %s%s%s",
		              size, context, shown ? ": " : "", shown ? hex : "");
	}
	else
	{
		ticalcs_warning("   NNSE: discarding %u stale byte(s) %s%s%s",
		                size, context, shown ? ": " : "", shown ? hex : "");
	}
}

static int nnse_service_plausible(uint8_t service)
{
	switch (service & ~NSP_NNSE_SRV_ACK_FLAG)
	{
		case NSP_NNSE_SRV_ADDR_REQ:
		case NSP_NNSE_SRV_TIME:
		case NSP_NNSE_SRV_ECHO:
		case NSP_NNSE_SRV_STREAM:
		case NSP_NNSE_SRV_TRANSMIT:
		case NSP_NNSE_SRV_LOOPBACK:
		case NSP_NNSE_SRV_STATS:
		case NSP_NNSE_SRV_STREAM_CTRL:
			return 1;
		default:
			return 0;
	}
}

static int nnse_reqack_plausible(uint8_t reqack)
{
	// bit 0 requests an ACK; bit 3 marks a retransmitted packet.
	return (reqack & ~0x09) == 0;
}

static int nnse_header_plausible(const uint8_t *header, uint32_t maxpayload)
{
	const uint16_t length = (((uint16_t)header[6]) << 8) | header[7];
	const uint8_t service = header[1];
	const uint32_t payload_size = length >= NSP_NNSE_HEADER_SIZE ? (uint32_t)(length - NSP_NNSE_HEADER_SIZE) : 0;

	if (header[0] != 0 || header[4] != 0)
	{
		return 0;
	}

	if (!nnse_service_plausible(service) || !nnse_reqack_plausible(header[5]))
	{
		return 0;
	}

	if (header[2] != NSP_NNSE_ADDR_CALC || (header[3] != NSP_NNSE_ADDR_PC && header[3] != NSP_NNSE_ADDR_ALL))
	{
		return 0;
	}

	if (length < NSP_NNSE_HEADER_SIZE || payload_size > maxpayload)
	{
		return 0;
	}

	if ((service & NSP_NNSE_SRV_ACK_FLAG) && (payload_size != 0 || (header[5] & 1) != 0))
	{
		return 0;
	}

	return 1;
}

static int nnse_compact_stream_control_plausible(const uint8_t *header, uint32_t maxpayload)
{
	const uint16_t length = (((uint16_t)header[5]) << 8) | header[6];
	const uint32_t payload_size = length >= NSP_NNSE_HEADER_SIZE ? (uint32_t)(length - NSP_NNSE_HEADER_SIZE) : 0;

	if (header[0] != NSP_NNSE_SRV_STREAM_CTRL || header[3] != 0)
	{
		return 0;
	}

	if (header[2] != NSP_NNSE_ADDR_PC && header[2] != NSP_NNSE_ADDR_ALL)
	{
		return 0;
	}

	if (length < NSP_NNSE_HEADER_SIZE || payload_size > maxpayload)
	{
		return 0;
	}

	return 1;
}

static int nnse_partial_header_possible(const uint8_t *header, uint32_t size)
{
	if (header == nullptr || size == 0)
	{
		return 1;
	}

	if (header[0] == 0)
	{
		if (size >= 2 && !nnse_service_plausible(header[1]))
		{
			return 0;
		}
		if (size >= 3 && header[2] != NSP_NNSE_ADDR_CALC)
		{
			return 0;
		}
		if (size >= 4 && header[3] != NSP_NNSE_ADDR_PC && header[3] != NSP_NNSE_ADDR_ALL)
		{
			return 0;
		}
		if (size >= 5 && header[4] != 0)
		{
			return 0;
		}
		if (size >= 6 && !nnse_reqack_plausible(header[5]))
		{
			return 0;
		}
		if (size >= 8 && ((((uint16_t)header[6]) << 8) | header[7]) < NSP_NNSE_HEADER_SIZE)
		{
			return 0;
		}
		return 1;
	}

	if (header[0] == NSP_NNSE_SRV_STREAM_CTRL)
	{
		if (size >= 3 && header[2] != NSP_NNSE_ADDR_PC && header[2] != NSP_NNSE_ADDR_ALL)
		{
			return 0;
		}
		if (size >= 4 && header[3] != 0)
		{
			return 0;
		}
		if (size >= 7 && ((((uint16_t)header[5]) << 8) | header[6]) < NSP_NNSE_HEADER_SIZE)
		{
			return 0;
		}
		return 1;
	}

	return 0;
}

static uint32_t nnse_discard_impossible_prefix(GByteArray *buffer, const char *context)
{
	uint8_t dropped[NSP_NNSE_HEADER_SIZE];
	uint32_t dropped_count = 0;

	while (buffer->len > 0 && buffer->len < NSP_NNSE_HEADER_SIZE && !nnse_partial_header_possible(buffer->data, buffer->len))
	{
		if (dropped_count < sizeof(dropped))
		{
			dropped[dropped_count++] = buffer->data[0];
		}
		g_byte_array_remove_index(buffer, 0);
	}

	if (dropped_count && context != nullptr)
	{
		nnse_log_stale_fragment(context, dropped, dropped_count);
	}

	return dropped_count;
}

int nsp_nnse_test_partial_header_possible(const uint8_t *header, uint32_t size)
{
	return nnse_partial_header_possible(header, size);
}

uint32_t nsp_nnse_test_discard_impossible_prefix(uint8_t *data, uint32_t *size)
{
	if (data == nullptr || size == nullptr)
	{
		return 0;
	}

	GByteArray* buffer = g_byte_array_sized_new(*size);
	g_byte_array_append(buffer, data, *size);
	const uint32_t dropped = nnse_discard_impossible_prefix(buffer, nullptr);
	memcpy(data, buffer->data, buffer->len);
	*size = buffer->len;
	g_byte_array_free(buffer, TRUE);

	return dropped;
}

int nsp_nnse_test_port_matches(uint16_t current_port, uint16_t passive_port, uint16_t dst_port)
{
	return nnse_port_matches(current_port, passive_port, dst_port);
}

int nsp_nnse_test_stream_requires_ack(const uint8_t *data, uint32_t size)
{
	return nnse_stream_requires_ack(data, size);
}

static uint16_t nnse_compact_stream_control_checksum(const uint8_t *data, uint32_t size)
{
	uint8_t buf[NSP_NNSE_HEADER_SIZE + NSP_NNSE_MAX_PAYLOAD];

	if (size + 1 > sizeof(buf))
	{
		return 0;
	}

	buf[0] = 0;
	memcpy(buf + 1, data, size);

	return nnse_checksum_fold(nnse_checksum_acc(buf, size + 1, 0));
}

static GByteArray * nnse_rx_buffer(CalcHandle *handle)
{
	GByteArray * buffer = (GByteArray *)handle->priv.nsp_nnse_rx_buffer;
	if (buffer == nullptr)
	{
		buffer = g_byte_array_new();
		handle->priv.nsp_nnse_rx_buffer = buffer;
	}

	return buffer;
}

static int nnse_buffer_read_polled(CalcHandle *handle, GByteArray *buffer, uint32_t wanted, int resync_after_first_byte)
{
	const gint64 now = g_get_monotonic_time();
	gint64 deadline = now + ((gint64)handle->cable->timeout * 100000);
	int had_partial = buffer->len > 0;
	int ret = 0;
	if (resync_after_first_byte && had_partial)
	{
		deadline = now + ((gint64)NSP_NNSE_RESYNC_TIMEOUT * 100000);
	}

	while (buffer->len < wanted && !ret)
	{
		CableStatus status = STATUS_NONE;
		ret = ticables_cable_check(handle->cable, &status);
		if (!ret && (status & STATUS_RX))
		{
			const guint old_len = buffer->len;
			g_byte_array_set_size(buffer, old_len + 1);
			ret = ticables_cable_recv(handle->cable, buffer->data + old_len, 1);
			if (ret)
			{
				g_byte_array_set_size(buffer, old_len);
			}
			else
			{
				if (!had_partial)
				{
					had_partial = 1;
					if (resync_after_first_byte)
					{
						deadline = g_get_monotonic_time() + ((gint64)NSP_NNSE_RESYNC_TIMEOUT * 100000);
					}
				}
				if (resync_after_first_byte && buffer->len < NSP_NNSE_HEADER_SIZE)
				{
					const uint32_t dropped = nnse_discard_impossible_prefix(buffer, "while reading header prefix");
					if (dropped)
					{
						had_partial = buffer->len > 0;
						deadline = g_get_monotonic_time() + ((gint64)NSP_NNSE_RESYNC_TIMEOUT * 100000);
					}
				}
			}
		}
		else if (!ret)
		{
			if (g_get_monotonic_time() >= deadline)
			{
				ret = ERROR_READ_TIMEOUT;
			}
			else
			{
				NNSE_PAUSE_1MS();
			}
		}
	}

	return ret;
}

static void nnse_prefetch_immediate(CalcHandle *handle, GByteArray *buffer)
{
	while (buffer->len < NSP_NNSE_PREFETCH_MAX)
	{
		CableStatus status = STATUS_NONE;
		const int ret = ticables_cable_check(handle->cable, &status);
		if (ret || !(status & STATUS_RX))
		{
			break;
		}

		const guint old_len = buffer->len;
		g_byte_array_set_size(buffer, old_len + 1);
		const int recv_ret = ticables_cable_recv(handle->cable, buffer->data + old_len, 1);
		if (recv_ret)
		{
			g_byte_array_set_size(buffer, old_len);
			break;
		}
	}

	nnse_discard_impossible_prefix(buffer, "after frame");
}

static int nnse_buffer_read(CalcHandle *handle, GByteArray *buffer, uint32_t wanted)
{
	const int resync_after_first_byte = wanted <= NSP_NNSE_HEADER_SIZE;
	return nnse_buffer_read_polled(handle, buffer, wanted, resync_after_first_byte);
}

static int nnse_buffer_read_with_timeout(CalcHandle *handle, GByteArray *buffer, uint32_t wanted, unsigned int timeout)
{
	const unsigned int old_timeout = ticables_options_set_timeout(handle->cable, timeout);
	const int ret = nnse_buffer_read(handle, buffer, wanted);
	ticables_options_set_timeout(handle->cable, old_timeout);
	return ret;
}

static int nnse_send_message(CalcHandle *handle, uint8_t misc, uint8_t service, uint8_t src, uint8_t dest,
                             uint8_t unknown, uint8_t reqack, uint16_t seqno, const uint8_t *data, uint32_t size)
{
	uint8_t buf[NSP_NNSE_HEADER_SIZE + NSP_NNSE_MAX_PAYLOAD];

	if (size > NSP_NNSE_MAX_PAYLOAD || (size && data == nullptr))
	{
		return ERR_INVALID_PACKET;
	}

	const uint16_t length = (uint16_t)(NSP_NNSE_HEADER_SIZE + size);

	buf[0] = misc;
	buf[1] = service;
	buf[2] = src;
	buf[3] = dest;
	buf[4] = unknown;
	buf[5] = reqack;
	buf[6] = MSB(length);
	buf[7] = LSB(length);
	buf[8] = MSB(seqno);
	buf[9] = LSB(seqno);
	buf[10] = 0;
	buf[11] = 0;
	if (size)
	{
		memcpy(buf + NSP_NNSE_HEADER_SIZE, data, size);
	}

	const uint16_t csum = nnse_checksum_fold(nnse_checksum_acc(buf, length, 0)) ^ 0xFFFF;
	buf[10] = MSB(csum);
	buf[11] = LSB(csum);

	if (nnse_trace_enabled())
	{
		ticalcs_info("   NNSE OUT: service=%02X %02X->%02X reqAck=%02X SQ=%04X len=%u",
		             service, src, dest, reqack, seqno, length);
	}

	return ticables_cable_send(handle->cable, buf, length);
}

static int nnse_recv_message(CalcHandle *handle, NSPNNSEHeader *hdr, uint8_t *payload, uint32_t maxpayload, uint32_t *payload_size)
{
	GByteArray * frame = nnse_rx_buffer(handle);
	unsigned int skipped = 0;

	int ret = nnse_buffer_read(handle, frame, NSP_NNSE_HEADER_SIZE);
	if (ret)
	{
		if (ret == ERROR_READ_TIMEOUT && frame->len)
		{
			nnse_log_stale_fragment("while reading header", frame->data, frame->len);
			g_byte_array_set_size(frame, 0);
			return ERR_INVALID_PACKET;
		}
		return ret;
	}

	for (;;)
	{
		if (frame->len < NSP_NNSE_HEADER_SIZE)
		{
			ret = nnse_buffer_read(handle, frame, NSP_NNSE_HEADER_SIZE);
			if (ret)
			{
				return ret;
			}
		}

		if (nnse_header_plausible(frame->data, maxpayload))
		{
			const uint16_t length = (((uint16_t)frame->data[6]) << 8) | frame->data[7];
			ret = nnse_buffer_read(handle, frame, length);
			if (ret)
			{
				if (ret == ERROR_READ_TIMEOUT && frame->len >= NSP_NNSE_HEADER_SIZE)
				{
					nnse_log_stale_fragment("while reading payload", frame->data, frame->len);
					g_byte_array_set_size(frame, 0);
					return ERR_INVALID_PACKET;
				}
				return ret;
			}

			if (nnse_checksum_fold(nnse_checksum_acc(frame->data, length, 0)) == 0xFFFF)
			{
				break;
			}
		}
		else if (nnse_compact_stream_control_plausible(frame->data, maxpayload))
		{
			const uint16_t length = (((uint16_t)frame->data[5]) << 8) | frame->data[6];
			const uint16_t wire_length = length - 1;
			ret = nnse_buffer_read(handle, frame, wire_length);
			if (ret)
			{
				if (ret == ERROR_READ_TIMEOUT && frame->len >= NSP_NNSE_HEADER_SIZE)
				{
					nnse_log_stale_fragment("while reading compact stream-control payload", frame->data, frame->len);
					g_byte_array_set_size(frame, 0);
					return ERR_INVALID_PACKET;
				}
				return ret;
			}

			if (nnse_compact_stream_control_checksum(frame->data, wire_length) == 0xFFFF)
			{
				hdr->misc    = 0;
				hdr->service = frame->data[0];
				hdr->src     = frame->data[1];
				hdr->dest    = frame->data[2];
				hdr->unknown = frame->data[3];
				hdr->reqack  = frame->data[4];
				hdr->length  = length;
				hdr->seqno   = (((uint16_t)frame->data[7]) << 8) | frame->data[8];
				hdr->csum    = (((uint16_t)frame->data[9]) << 8) | frame->data[10];

				*payload_size = length - NSP_NNSE_HEADER_SIZE;
				if (*payload_size)
				{
					memcpy(payload, frame->data + (NSP_NNSE_HEADER_SIZE - 1), *payload_size);
				}
				g_byte_array_remove_range(frame, 0, wire_length);
				nnse_prefetch_immediate(handle, frame);

				if (nnse_trace_enabled())
				{
					ticalcs_info("   NNSE IN : service=%02X %02X->%02X reqAck=%02X SQ=%04X len=%u",
					             hdr->service, hdr->src, hdr->dest, hdr->reqack, hdr->seqno, hdr->length);
				}

				return 0;
			}
		}

		if (++skipped > NSP_NNSE_HEADER_SIZE + maxpayload)
		{
			const uint16_t length = (((uint16_t)frame->data[6]) << 8) | frame->data[7];
			ticalcs_critical("%s: no valid NNSE message found, last candidate length %u", __FUNCTION__, length);
			return ERR_INVALID_PACKET;
		}

		g_byte_array_remove_index(frame, 0);
		if (frame->len < NSP_NNSE_HEADER_SIZE)
		{
			ret = nnse_buffer_read_with_timeout(handle, frame, NSP_NNSE_HEADER_SIZE, NSP_NNSE_RESYNC_TIMEOUT);
			if (ret == ERROR_READ_TIMEOUT)
			{
				if (frame->len)
				{
					nnse_log_stale_fragment("while resynchronizing", frame->data, frame->len);
					g_byte_array_set_size(frame, 0);
					return ERR_INVALID_PACKET;
				}
				return ERROR_READ_TIMEOUT;
			}
			if (ret)
			{
				return ret;
			}
		}
	}

	hdr->misc    = frame->data[0];
	hdr->service = frame->data[1];
	hdr->src     = frame->data[2];
	hdr->dest    = frame->data[3];
	hdr->unknown = frame->data[4];
	hdr->reqack  = frame->data[5];
	hdr->length  = (((uint16_t)frame->data[6]) << 8) | frame->data[7];
	hdr->seqno   = (((uint16_t)frame->data[8]) << 8) | frame->data[9];
	hdr->csum    = (((uint16_t)frame->data[10]) << 8) | frame->data[11];

	if (hdr->length < NSP_NNSE_HEADER_SIZE || (uint32_t)(hdr->length - NSP_NNSE_HEADER_SIZE) > maxpayload)
	{
		ticalcs_critical("%s: invalid NNSE message length %u", __FUNCTION__, hdr->length);
		return ERR_INVALID_PACKET;
	}

	*payload_size = hdr->length - NSP_NNSE_HEADER_SIZE;
	if (*payload_size)
	{
		memcpy(payload, frame->data + NSP_NNSE_HEADER_SIZE, *payload_size);
	}
	g_byte_array_remove_range(frame, 0, hdr->length);
	nnse_prefetch_immediate(handle, frame);

	if (nnse_trace_enabled())
	{
		ticalcs_info("   NNSE IN : service=%02X %02X->%02X reqAck=%02X SQ=%04X len=%u",
		             hdr->service, hdr->src, hdr->dest, hdr->reqack, hdr->seqno, hdr->length);
	}

	return 0;
}

static uint16_t nnse_next_seqno(CalcHandle *handle)
{
	return handle->priv.nsp_nnse_seqno++;
}

static int nnse_handle_message(CalcHandle *handle, const NSPNNSEHeader *hdr, const uint8_t *payload, uint32_t payload_size, int *is_stream);

static int nnse_send_addr_response_twice(CalcHandle *handle)
{
	// libnspire: in some cases on HW, and in Firebird always after
	// reconnecting, the first response is ignored, so send it twice; if both
	// are received, the second one is ignored.
	const uint8_t addr_resp = 0x80;
	int ret = 0;

	for (int i = 0; i < 2 && !ret; i++)
	{
		ret = nnse_send_message(handle, 0, NSP_NNSE_SRV_ADDR_REQ, NSP_NNSE_ADDR_PC, NSP_NNSE_ADDR_CALC,
		                        0, 0, nnse_next_seqno(handle), &addr_resp, 1);
	}

	return ret;
}

static int nnse_send_stream_control_status(CalcHandle *handle, uint8_t dest, uint8_t control, uint8_t status)
{
	const uint8_t response[2] = { (uint8_t)(control | 0x80), status };

	return nnse_send_message(handle, 0, NSP_NNSE_SRV_STREAM_CTRL, NSP_NNSE_ADDR_PC, dest,
	                         0, 0, nnse_next_seqno(handle), response, sizeof(response));
}

static int nnse_send_stream_control_reset(CalcHandle *handle, uint16_t seqno)
{
	const uint8_t payload = NSP_NNSE_STREAM_CTRL_RESET;

	ticalcs_info("   NNSE: resetting stream control");

	return nnse_send_message(handle, 0, NSP_NNSE_SRV_STREAM_CTRL, NSP_NNSE_ADDR_PC, NSP_NNSE_STREAM_INDEX,
	                         0, 1, seqno, &payload, 1);
}

static unsigned int nnse_effective_stream_timeout(CalcHandle *handle)
{
	if (handle != nullptr && handle->cable != nullptr
	    && handle->cable->timeout > 0
	    && handle->cable->timeout < NSP_NNSE_STREAM_TIMEOUT_CEILING)
	{
		return handle->cable->timeout;
	}

	return NSP_NNSE_STREAM_TIMEOUT_CEILING;
}

static int nnse_process_handshake_messages(CalcHandle *handle, unsigned int timeout)
{
	NSPNNSEHeader hdr;
	uint8_t payload[NSP_NNSE_MAX_PAYLOAD];
	uint32_t payload_size = 0;
	int ret = 0;

	for (int i = 0; i < NSP_NNSE_MAX_ITERATIONS && !handle->priv.nsp_nnse_handshake_done; i++)
	{
		const unsigned int old_timeout = ticables_options_set_timeout(handle->cable, timeout);
		ret = nnse_recv_message(handle, &hdr, payload, sizeof(payload), &payload_size);
		ticables_options_set_timeout(handle->cable, old_timeout);
		if (ret == ERR_INVALID_PACKET || ret == ERR_CHECKSUM)
		{
			continue;
		}
		if (ret)
		{
			// Nothing (more) is coming.
			break;
		}

		int is_stream = 0;
		ret = nnse_handle_message(handle, &hdr, payload, payload_size, &is_stream);
		if (ret)
		{
			break;
		}
		// Stream payloads received before the handshake completed are stale
		// leftovers from a previous session, drop them.
		if (is_stream)
		{
			ticalcs_info("   NNSE: dropping stale stream payload received during handshake");
		}
	}

	return ret;
}

// Acknowledge (if requested) and answer the given message. Handshake requests
// (address / time / unknown services) are answered whenever they show up, so
// that a device rebooting or reconnecting mid-session re-associates
// transparently. Stream payloads are reported through is_stream and left to
// the caller.
static int nnse_handle_message(CalcHandle *handle, const NSPNNSEHeader *hdr, const uint8_t *payload, uint32_t payload_size, int *is_stream)
{
	int ret = 0;

	*is_stream = 0;

	if (hdr->dest != NSP_NNSE_ADDR_PC && hdr->dest != NSP_NNSE_ADDR_ALL)
	{
		ticalcs_info("   NNSE: ignoring message for address %02X", hdr->dest);
	}
	else if (hdr->service & NSP_NNSE_SRV_ACK_FLAG)
	{
		// Acknowledgements are matched by the send path.
	}
	else
	{
		if (hdr->reqack & 1)
		{
			ret = nnse_send_message(handle, hdr->misc, hdr->service | NSP_NNSE_SRV_ACK_FLAG, hdr->dest, hdr->src,
			                        hdr->unknown, hdr->reqack & 0xFE, hdr->seqno, nullptr, 0);
		}

		if (!ret)
		{
			switch (hdr->service)
			{
				case NSP_NNSE_SRV_ADDR_REQ:
				{
					if (payload_size < 1 || payload[0] != 0x00)
					{
						ticalcs_info("   NNSE: ignoring unexpected address request contents");
						break;
					}

					ticalcs_info("   NNSE: answering address request");

					ret = nnse_send_addr_response_twice(handle);

					// A new address request means the device restarted its NNSE stack.
					handle->priv.nsp_nnse_handshake_done = 0;
					break;
				}
				case NSP_NNSE_SRV_TIME:
				{
					if (payload_size < 1 || payload[0] != 0x00)
					{
						ticalcs_info("   NNSE: ignoring unexpected time request contents");
						break;
					}

					ticalcs_info("   NNSE: answering time request");

					uint8_t time_resp[17] = {};
					const uint32_t now = (uint32_t)time(nullptr);
					time_resp[0] = 0x80;
					time_resp[1] = (uint8_t)(now >> 24);
					time_resp[2] = (uint8_t)(now >> 16);
					time_resp[3] = (uint8_t)(now >> 8);
					time_resp[4] = (uint8_t)(now);
					// The remaining 12 bytes (two fractional parts) are left zeroed.

					ret = nnse_send_message(handle, 0, hdr->service, NSP_NNSE_ADDR_PC, NSP_NNSE_ADDR_CALC,
					                        0, 0, nnse_next_seqno(handle), time_resp, sizeof(time_resp));
					if (!ret)
					{
						handle->priv.nsp_nnse_handshake_done = 1;
						ticalcs_info("   NNSE: handshake complete");
					}
					break;
				}
				case NSP_NNSE_SRV_STREAM_CTRL:
				{
					if (payload_size == 1 && payload[0] == NSP_NNSE_STREAM_CTRL_START)
					{
						ret = nnse_send_stream_control_status(handle, hdr->src, NSP_NNSE_STREAM_CTRL_START, 0x03);
						break;
					}

					if (payload_size == 1 && payload[0] == NSP_NNSE_STREAM_CTRL_RESET)
					{
						nnse_clear_buffers(handle);
						nnse_clear_stream_history(handle);
						ret = nnse_send_stream_control_status(handle, hdr->src, NSP_NNSE_STREAM_CTRL_RESET, 0x00);
						break;
					}

					if (payload_size == 2 && (payload[0] & 0x80))
					{
						ticalcs_info("   NNSE: stream control status %02X/%02X", payload[0], payload[1]);
						break;
					}

					if (payload_size == 1 && payload[0] == NSP_NNSE_STREAM_CTRL_STATUS)
					{
						ret = nnse_send_stream_control_status(handle, hdr->src, NSP_NNSE_STREAM_CTRL_STATUS, 0x00);
						break;
					}

					ticalcs_info("   NNSE: ignoring unexpected stream control message");
					break;
				}
				case NSP_NNSE_SRV_STREAM:
				{
					*is_stream = 1;
					break;
				}
				default:
				{
					ticalcs_info("   NNSE: unhandled service %02X", hdr->service);
					break;
				}
			}
		}
	}

	return ret;
}

static int nnse_wait_stream_control_reset(CalcHandle *handle, uint16_t reset_seqno)
{
	NSPNNSEHeader hdr;
	uint8_t payload[NSP_NNSE_MAX_PAYLOAD];
	uint32_t payload_size = 0;
	int saw_reset_ack = 0;
	int saw_stream_restart = 0;

	handle->priv.nsp_nnse_handshake_done = 0;

	for (int i = 0; i < NSP_NNSE_MAX_ITERATIONS * 2; i++)
	{
		const unsigned int old_timeout = ticables_options_set_timeout(handle->cable, NSP_NNSE_STREAM_RESET_TIMEOUT);
		int ret = nnse_recv_message(handle, &hdr, payload, sizeof(payload), &payload_size);
		ticables_options_set_timeout(handle->cable, old_timeout);

		if (ret == ERR_INVALID_PACKET || ret == ERR_CHECKSUM)
		{
			continue;
		}
		if (ret)
		{
			if (saw_reset_ack)
			{
				ticalcs_warning("   NNSE: stream reset ACK received without restart handshake");
				return 0;
			}
			return ret;
		}

		if (   (hdr.dest == NSP_NNSE_ADDR_PC || hdr.dest == NSP_NNSE_ADDR_ALL)
		    && hdr.service == (NSP_NNSE_SRV_STREAM_CTRL | NSP_NNSE_SRV_ACK_FLAG)
		    && hdr.seqno == reset_seqno)
		{
			saw_reset_ack = 1;
			continue;
		}

		if (hdr.service == NSP_NNSE_SRV_STREAM_CTRL && payload_size == 1 && payload[0] == NSP_NNSE_STREAM_CTRL_START)
		{
			saw_stream_restart = 1;
		}

		int is_stream = 0;
		ret = nnse_handle_message(handle, &hdr, payload, payload_size, &is_stream);
		if (ret)
		{
			return ret;
		}
		if (is_stream)
		{
			ticalcs_info("   NNSE: dropping stale stream payload received during stream reset");
		}

		if (saw_reset_ack && saw_stream_restart && handle->priv.nsp_nnse_handshake_done)
		{
			nnse_clear_buffers(handle);
			nnse_clear_stream_history(handle);
			ticalcs_info("   NNSE: stream reset complete");
			return 0;
		}
	}

	ticalcs_warning("   NNSE: stream reset did not complete before retry");
	return ERROR_READ_TIMEOUT;
}

static int nnse_queue_payload_ex(CalcHandle *handle, const uint8_t *payload, uint32_t payload_size, int *queued)
{
	GList * pending = (GList *)handle->priv.nsp_nnse_pending;

	if (queued != nullptr)
	{
		*queued = 0;
	}

	if (payload_size && payload == nullptr)
	{
		return ERR_INVALID_PARAMETER;
	}

	if (!nnse_stream_is_for_current_port(handle, payload, payload_size))
	{
		return 0;
	}

	if (g_list_length(pending) >= NSP_NNSE_MAX_PENDING)
	{
		ticalcs_warning("%s: too many pending NNSE stream payloads, dropping", __FUNCTION__);
		return ERR_BUSY;
	}

	NSPNNSEPendingPayload * entry = (NSPNNSEPendingPayload *)g_malloc(offsetof(NSPNNSEPendingPayload, data) + payload_size);
	entry->size = payload_size;
	if (payload_size)
	{
		memcpy(entry->data, payload, payload_size);
	}
	handle->priv.nsp_nnse_pending = (void *)g_list_append(pending, entry);

	if (queued != nullptr)
	{
		*queued = 1;
	}

	return 0;
}

int nsp_nnse_queue_stream(CalcHandle *handle, const uint8_t *data, uint32_t size)
{
	return nnse_queue_payload_ex(handle, data, size, nullptr);
}

int nsp_nnse_drop_queued_streams(CalcHandle *handle)
{
	GList * pending = (GList *)handle->priv.nsp_nnse_pending;
	unsigned int dropped = 0;

	while (pending != nullptr)
	{
		NSPNNSEPendingPayload * entry = (NSPNNSEPendingPayload *)pending->data;
		handle->priv.nsp_nnse_pending = (void *)g_list_delete_link(pending, pending);
		g_free(entry);
		dropped++;
		pending = (GList *)handle->priv.nsp_nnse_pending;
	}

	if (dropped)
	{
		ticalcs_info("   NNSE: dropping %u queued stream payload(s)", dropped);
	}

	return (int)dropped;
}

int nsp_nnse_ensure_ready(CalcHandle *handle)
{
	int ret = 0;

	if (!handle->priv.nsp_nnse_handshake_done)
	{
		// Prompt the calculator at the NNSE protocol level first. This is the
		// only option on WinUSB/WebUSB, and also works on already-associated
		// native devices without disturbing the USB stack.
		ticalcs_info("  NNSE: prompting device association");
		ret = nnse_send_addr_response_twice(handle);
		if (!ret)
		{
			const unsigned int old_timeout = ticables_options_set_timeout(handle->cable, NSP_NNSE_ASSOC_PROMPT_TIMEOUT);
			ret = nnse_process_handshake_messages(handle, NSP_NNSE_ASSOC_PROMPT_TIMEOUT);
			ticables_options_set_timeout(handle->cable, old_timeout);
			if (ret == ERROR_READ_TIMEOUT)
			{
				ret = 0;
			}
		}

		if (!ret && !handle->priv.nsp_nnse_handshake_done && NSP_NNSE_HAS_USB_RESET)
		{
			// Native libusb can still provoke a fresh handshake if the prompt
			// was not enough, matching the older native recovery behavior.
			ret = handle->cable->cable->reset(handle->cable);
			if (!ret)
			{
				ticalcs_info("  NNSE: waiting for device handshake:");

				const unsigned int old_timeout = ticables_options_set_timeout(handle->cable, NSP_NNSE_HANDSHAKE_TIMEOUT);
				// Give the device a few seconds, like the legacy LOGIN check does.
				ret = nnse_process_handshake_messages(handle, NSP_NNSE_HANDSHAKE_TIMEOUT);
				ticables_options_set_timeout(handle->cable, old_timeout);
				if (ret == ERROR_READ_TIMEOUT)
				{
					ret = 0;
				}
			}

			if (!ret && !handle->priv.nsp_nnse_handshake_done)
			{
				// If reset did not provoke the normal AddrReq handshake, prompt the
				// calculator once more and wait longer for the follow-up TimeReq.
				ticalcs_info("  NNSE: no handshake traffic, prompting device association");
				ret = nnse_send_addr_response_twice(handle);
				if (!ret)
				{
					ret = nnse_process_handshake_messages(handle, NSP_NNSE_HANDSHAKE_TIMEOUT);
					if (ret == ERROR_READ_TIMEOUT)
					{
						ret = 0;
					}
				}
			}
		}

		if (!ret)
		{
			if (!handle->priv.nsp_nnse_handshake_done)
			{
				// The device may still be associated from a previous session.
				ticalcs_warning("  NNSE: no handshake response, assuming device is already associated");
				handle->priv.nsp_nnse_handshake_done = 1;
			}
			else
			{
				ticalcs_info("  NNSE: device handshake done");
			}
		}
	}

	return ret;
}

int nsp_nnse_send_stream(CalcHandle *handle, const uint8_t *data, uint32_t size)
{
	NSPNNSEHeader hdr;
	uint8_t payload[NSP_NNSE_MAX_PAYLOAD];
	uint32_t payload_size;
	int done = 0;

	int ret = nsp_nnse_ensure_ready(handle);
	if (!ret)
	{
		const uint16_t seqno = nnse_next_seqno(handle);
		const int requires_ack = nnse_stream_requires_ack(data, size);
		if (!requires_ack)
		{
			// The CX II keypress service is one-way and does not acknowledge
			// NNSE stream messages. Requesting an ACK here would turn every key
			// into five duplicate sends followed by ERR_NACK.
			return nnse_send_message(handle, 0, NSP_NNSE_SRV_STREAM, NSP_NNSE_ADDR_PC, NSP_NNSE_ADDR_CALC,
			                         0, 0, seqno, data, size);
		}

		for (int attempt = 0; attempt < NSP_NNSE_SEND_RETRIES && !ret && !done; attempt++)
		{
			int reassociated = 0;
			int retry_send = 0;

			if (attempt > 0)
			{
				ticalcs_warning("   NNSE: missing stream ACK, resending held message (%d/%d)",
				                attempt + 1, NSP_NNSE_SEND_RETRIES);
			}

			ret = nnse_send_message(handle, 0, NSP_NNSE_SRV_STREAM, NSP_NNSE_ADDR_PC, NSP_NNSE_ADDR_CALC,
			                        0, 1, seqno, data, size);

			// Wait for the NNSE-level acknowledgement, answering handshake requests
			// and queueing stream payloads that may arrive in the meantime.
			for (int i = 0; i < NSP_NNSE_MAX_ITERATIONS && !ret && !retry_send && !done; i++)
			{
				const unsigned int old_timeout = ticables_options_set_timeout(handle->cable, nnse_effective_stream_timeout(handle));
				ret = nnse_recv_message(handle, &hdr, payload, sizeof(payload), &payload_size);
				ticables_options_set_timeout(handle->cable, old_timeout);
				if (ret == ERR_INVALID_PACKET || ret == ERR_CHECKSUM)
				{
					ret = 0;
					continue;
				}
				if (ret == ERROR_READ_TIMEOUT)
				{
					retry_send = 1;
					ret = 0;
				}
				else if (!ret)
				{
					if (   (hdr.dest == NSP_NNSE_ADDR_PC || hdr.dest == NSP_NNSE_ADDR_ALL)
					    && hdr.service == (NSP_NNSE_SRV_STREAM | NSP_NNSE_SRV_ACK_FLAG)
					    && hdr.seqno == seqno)
					{
						done = 1;
					}
					else
					{
						if (hdr.service == NSP_NNSE_SRV_ADDR_REQ)
						{
							reassociated = 1;
						}

						int is_stream = 0;
						ret = nnse_handle_message(handle, &hdr, payload, payload_size, &is_stream);
						if (!ret && is_stream)
						{
							if (reassociated)
							{
								ticalcs_info("   NNSE: dropping stale stream payload received during re-association");
							}
							else if (nnse_stream_is_duplicate(handle, &hdr))
							{
								ticalcs_debug("   NNSE: dropping duplicate retried stream payload SQ=%04X", hdr.seqno);
							}
							else
							{
								int queued = 0;
								ret = nnse_queue_payload_ex(handle, payload, payload_size, &queued);
								if (!ret && queued)
								{
									nnse_note_stream_delivered(handle, &hdr);
									ticalcs_debug("   NNSE: stream payload arrived before ACK, proceeding");
									done = 1;
								}
							}
						}
						if (!ret && reassociated && handle->priv.nsp_nnse_handshake_done)
						{
							ticalcs_warning("   NNSE: device re-associated while waiting for stream ack, resending");
							retry_send = 1;
						}
					}
				}
			}

			if (!ret && !retry_send && !done && attempt + 1 < NSP_NNSE_SEND_RETRIES)
			{
				retry_send = 1;
			}
		}
	}

	if (!ret && !done)
	{
		ticalcs_critical("%s: no NNSE ack received for stream message", __FUNCTION__);
		ret = ERR_NACK;
	}

	return ret;
}

int nsp_nnse_recv_stream(CalcHandle *handle, uint8_t *data, uint32_t maxsize, uint32_t *size)
{
	NSPNNSEHeader hdr;
	uint8_t payload[NSP_NNSE_MAX_PAYLOAD];
	uint32_t payload_size;
	int reassociated = 0;
	int resync_fragments = 0;

	int ret = nsp_nnse_ensure_ready(handle);
	if (ret)
	{
		return ret;
	}

	// Deliver payloads queued while waiting for an acknowledgement first.
	GList * pending = (GList *)handle->priv.nsp_nnse_pending;
	while (pending != nullptr)
	{
		NSPNNSEPendingPayload * entry = (NSPNNSEPendingPayload *)pending->data;
		handle->priv.nsp_nnse_pending = (void *)g_list_delete_link(pending, pending);
		pending = (GList *)handle->priv.nsp_nnse_pending;

		if (!nnse_stream_is_for_current_port(handle, entry->data, entry->size))
		{
			g_free(entry);
			continue;
		}
		if (entry->size > maxsize)
		{
			g_free(entry);
			return ERR_INVALID_PACKET;
		}
		memcpy(data, entry->data, entry->size);
		*size = entry->size;
		g_free(entry);
		return 0;
	}

	const unsigned int old_timeout = ticables_options_set_timeout(handle->cable, nnse_effective_stream_timeout(handle));

	for (int i = 0; i < NSP_NNSE_MAX_ITERATIONS; i++)
	{
		ret = nnse_recv_message(handle, &hdr, payload, sizeof(payload), &payload_size);
		if (ret == ERR_INVALID_PACKET || ret == ERR_CHECKSUM)
		{
			resync_fragments++;
			if (resync_fragments >= NSP_NNSE_MAX_RESYNC_FRAGMENTS)
			{
				ticalcs_warning("   NNSE: repeated stale fragments while waiting for stream data");
				ret = ERROR_READ_TIMEOUT;
				goto end;
			}
			continue;
		}
		if (ret)
		{
			goto end;
		}

		int is_stream = 0;
		ret = nnse_handle_message(handle, &hdr, payload, payload_size, &is_stream);
		if (ret)
		{
			goto end;
		}
		if (hdr.service == NSP_NNSE_SRV_ADDR_REQ)
		{
			reassociated = 1;
		}

		if (is_stream)
		{
			if (reassociated)
			{
				ticalcs_info("   NNSE: dropping stale stream payload received during re-association");
				continue;
			}
			if (nnse_stream_is_duplicate(handle, &hdr))
			{
				ticalcs_debug("   NNSE: dropping duplicate retried stream payload SQ=%04X", hdr.seqno);
				continue;
			}
			if (payload_size > maxsize)
			{
				ret = ERR_INVALID_PACKET;
				goto end;
			}
			memcpy(data, payload, payload_size);
			*size = payload_size;
			nnse_note_stream_delivered(handle, &hdr);
			ret = 0;
			goto end;
		}
		if (reassociated && handle->priv.nsp_nnse_handshake_done)
		{
			ticalcs_warning("   NNSE: device re-associated while waiting for stream data");
			ret = ERROR_READ_TIMEOUT;
			goto end;
		}
	}

	ticalcs_critical("%s: no NNSE stream message received", __FUNCTION__);
	ret = resync_fragments ? ERROR_READ_TIMEOUT : ERR_INVALID_PACKET;

end:
	ticables_options_set_timeout(handle->cable, old_timeout);
	return ret;
}
