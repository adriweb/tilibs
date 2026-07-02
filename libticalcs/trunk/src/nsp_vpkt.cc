/* Hey EMACS -*- linux-c -*- */
/* $Id: cmd84p.c 2077 2006-03-31 21:16:19Z roms $ */

/*  libticalcs - Ti Calculator library, a part of the TiLP project
 *  Copyright (C) 1999-2005  Romain Liévin
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
	This unit manages virtual packets from/to NSPire (DirectLink).
	Virtual packets are fragmented into one or more raw packets.

	Please note this unit does not fully implement the NSpire protocol. It assumes
	there is one Nspire which is not exposing services. This assumption allows to 
	work in a linear fashion although we need sometimes some nasty hacks (LOGIN for
	instance).

	A better unit should implement a kind of daemon listening on all ports and launching
	a thread for each connection attempt. This way is fully parallelized but need a state
	machine and so more (complex) code. Maybe later...
*/

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ticalcs.h"
#include "internal.h"
#include "logging.h"
#include "error.h"

#include "nsp_cmd.h"

#include "nsp_vpkt.h"
#include "nsp_nnse.h"

#define NSP_NNSE_DATA_SIZE 1440
#define NSP_NNSE_CLOSE_DRAIN_TIMEOUT 1
#define NSP_NNSE_CLOSE_DRAIN_MAX 3
#define NSP_CLIENT_PORT_FIRST 0x8000
#define NSP_CLIENT_PORT_LAST  0x8FFF

typedef struct
{
	uint16_t src_addr;
	uint16_t src_port;
	uint16_t dst_addr;
	uint16_t dst_port;
	uint16_t data_sum;
	uint8_t data_size;
	uint8_t ack;
	uint8_t seq;
	uint8_t hdr_sum;
	const uint8_t *data;
	uint32_t logical_data_size;
	uint32_t wire_data_size;
	uint32_t raw_size;
} NSPParsedRawPacket;

static int nsp_nnse_recv_raw_packet(CalcHandle *handle, NSPParsedRawPacket *pkt, uint8_t *msg, uint32_t msg_capacity);

static uint16_t nsp_compute_crc(const uint8_t *data, uint32_t size)
{
	uint16_t acc = 0;

	for (uint32_t i = 0; i < size; i++)
	{
		const uint16_t first = (((uint16_t)data[i]) << 8) | (acc >> 8);
		acc &= 0xff;
		const uint16_t second = (((acc & 0x0f) << 4) ^ acc) << 8;
		const uint16_t third = second >> 5;
		acc = third >> 7;
		acc = (acc ^ first ^ second ^ third);
	}

	return acc;
}

static uint8_t nsp_header_checksum(const uint8_t *data)
{
	return tifiles_checksum((uint8_t *)data, NSP_HEADER_SIZE - 1) & 0xff;
}

static void nsp_pack_header(uint8_t *buf, uint16_t src_addr, uint16_t src_port, uint16_t dst_addr, uint16_t dst_port,
                            uint16_t data_sum, uint8_t data_size, uint8_t ack, uint8_t seq)
{
	buf[0] = 0x54;
	buf[1] = 0xFD;
	buf[2] = MSB(src_addr);
	buf[3] = LSB(src_addr);
	buf[4] = MSB(src_port);
	buf[5] = LSB(src_port);
	buf[6] = MSB(dst_addr);
	buf[7] = LSB(dst_addr);
	buf[8] = MSB(dst_port);
	buf[9] = LSB(dst_port);
	buf[10] = MSB(data_sum);
	buf[11] = LSB(data_sum);
	buf[12] = data_size;
	buf[13] = ack;
	buf[14] = seq;
	buf[15] = nsp_header_checksum(buf);
}

static int nsp_parse_raw_packet(const uint8_t *msg, uint32_t msg_size, NSPParsedRawPacket *pkt)
{
	if (msg == nullptr || pkt == nullptr || msg_size < NSP_HEADER_SIZE)
	{
		return ERR_INVALID_PACKET;
	}

	if (msg[0] != 0x54 || msg[1] != 0xFD || msg[15] != nsp_header_checksum(msg))
	{
		return ERR_INVALID_PACKET;
	}

	pkt->src_addr = (((uint16_t)msg[2]) << 8) | msg[3];
	pkt->src_port = (((uint16_t)msg[4]) << 8) | msg[5];
	pkt->dst_addr = (((uint16_t)msg[6]) << 8) | msg[7];
	pkt->dst_port = (((uint16_t)msg[8]) << 8) | msg[9];
	pkt->data_sum = (((uint16_t)msg[10]) << 8) | msg[11];
	pkt->data_size = msg[12];
	pkt->ack = msg[13];
	pkt->seq = msg[14];
	pkt->hdr_sum = msg[15];

	if (pkt->data_size == 0xFF)
	{
		if (msg_size < NSP_HEADER_SIZE + 4)
		{
			return ERR_INVALID_PACKET;
		}

		pkt->logical_data_size = (((uint32_t)msg[16]) << 24) | (((uint32_t)msg[17]) << 16) | (((uint32_t)msg[18]) << 8) | msg[19];
		pkt->wire_data_size = pkt->logical_data_size + 4;
		pkt->data = msg + NSP_HEADER_SIZE + 4;
	}
	else
	{
		pkt->logical_data_size = pkt->data_size;
		pkt->wire_data_size = pkt->data_size;
		pkt->data = msg + NSP_HEADER_SIZE;
	}

	if (pkt->logical_data_size < 1 || pkt->logical_data_size > NSP_NNSE_DATA_SIZE)
	{
		return ERR_INVALID_PACKET;
	}

	pkt->raw_size = NSP_HEADER_SIZE + pkt->wire_data_size;
	if (pkt->raw_size > msg_size)
	{
		return ERR_INVALID_PACKET;
	}

	if (pkt->data_sum != nsp_compute_crc(msg + NSP_HEADER_SIZE, pkt->wire_data_size))
	{
		return ERR_CHECKSUM;
	}

	return 0;
}

static int nsp_find_raw_packet_boundary(const uint8_t *msg, uint32_t msg_size, NSPParsedRawPacket *pkt, uint32_t *offset)
{
	int saw_checksum_candidate = 0;

	for (uint32_t i = 0; i + NSP_HEADER_SIZE <= msg_size; i++)
	{
		if (msg[i] != 0x54 || msg[i + 1] != 0xFD)
		{
			continue;
		}

		const int ret = nsp_parse_raw_packet(msg + i, msg_size - i, pkt);
		if (!ret)
		{
			*offset = i;
			return 0;
		}
		if (ret == ERR_CHECKSUM)
		{
			saw_checksum_candidate = 1;
		}
	}

	return saw_checksum_candidate ? ERR_CHECKSUM : ERR_INVALID_PACKET;
}

static int nsp_nnse_send_raw_data(CalcHandle *handle, const NSPRawPacket *raw, const uint8_t *data, uint32_t data_size)
{
	uint8_t msg[NSP_HEADER_SIZE + 4 + NSP_NNSE_DATA_SIZE];
	uint8_t *wire_data = msg + NSP_HEADER_SIZE;
	uint32_t wire_data_size = data_size;
	uint8_t header_data_size = (uint8_t)data_size;

	if (raw == nullptr || data == nullptr || data_size < 1 || data_size > NSP_NNSE_DATA_SIZE)
	{
		return ERR_INVALID_PARAMETER;
	}

	if (data_size >= 0xFF)
	{
		header_data_size = 0xFF;
		wire_data[0] = (uint8_t)(data_size >> 24);
		wire_data[1] = (uint8_t)(data_size >> 16);
		wire_data[2] = (uint8_t)(data_size >> 8);
		wire_data[3] = (uint8_t)data_size;
		memcpy(wire_data + 4, data, data_size);
		wire_data_size += 4;
	}
	else
	{
		memcpy(wire_data, data, data_size);
	}

	const uint16_t data_sum = nsp_compute_crc(wire_data, wire_data_size);
	nsp_pack_header(msg, raw->src_addr, raw->src_port, raw->dst_addr, raw->dst_port, data_sum, header_data_size, raw->ack, raw->seq);

	return nsp_nnse_send_stream(handle, msg, NSP_HEADER_SIZE + wire_data_size);
}

static int nsp_nnse_send_control_for_parsed(CalcHandle *handle, const NSPParsedRawPacket *packet, uint16_t control_port)
{
	NSPRawPacket control;
	uint8_t data[2];

	if (packet == nullptr)
	{
		return ERR_INVALID_PARAMETER;
	}

	memset(&control, 0, sizeof(control));
	control.src_addr = NSP_SRC_ADDR;
	control.src_port = control_port;
	control.dst_addr = NSP_DEV_ADDR;
	control.dst_port = packet->src_port;
	control.ack = 0x0A;
	control.seq = packet->seq;
	data[0] = MSB(packet->dst_port);
	data[1] = LSB(packet->dst_port);

	return nsp_nnse_send_raw_data(handle, &control, data, sizeof(data));
}

static int nsp_nnse_send_ack_for_parsed(CalcHandle *handle, const NSPParsedRawPacket *packet)
{
	const uint16_t ack_port = (packet != nullptr && packet->seq == 0) ? NSP_PORT_PKT_ACK1 : NSP_PORT_PKT_ACK2;
	return nsp_nnse_send_control_for_parsed(handle, packet, ack_port);
}

static int nsp_nnse_send_noapp_for_parsed(CalcHandle *handle, const NSPParsedRawPacket *packet)
{
	return nsp_nnse_send_control_for_parsed(handle, packet, NSP_PORT_PKT_NACK);
}

static int nsp_nnse_handle_stale_packet(CalcHandle *handle, const NSPParsedRawPacket *packet, const char *context)
{
	if (packet == nullptr || packet->ack != 0x00 || packet->logical_data_size == 0)
	{
		return 0;
	}

	if (packet->src_port == NSP_PORT_DISCONNECT || packet->dst_port == NSP_PORT_DISCONNECT || packet->dst_port >= 0x8000)
	{
		ticalcs_debug("   NNSE: acking stale %sNavNet packet %04x->%04x while waiting on port %04x",
		              context != nullptr ? context : "", packet->src_port, packet->dst_port, handle->priv.nsp_src_port);
		return nsp_nnse_send_ack_for_parsed(handle, packet);
	}

	ticalcs_debug("   NNSE: sending NOAPP for stale %sNavNet service packet %04x->%04x while waiting on port %04x",
	              context != nullptr ? context : "", packet->src_port, packet->dst_port, handle->priv.nsp_src_port);
	return nsp_nnse_send_noapp_for_parsed(handle, packet);
}

static int nsp_nnse_queue_trailing_packets(CalcHandle *handle, const uint8_t *msg, uint32_t msg_size, uint32_t offset)
{
	uint32_t cursor = offset;

	while (cursor < msg_size)
	{
		NSPParsedRawPacket tail;
		uint32_t boundary = 0;

		memset(&tail, 0, sizeof(tail));
		const int ret = nsp_find_raw_packet_boundary(msg + cursor, msg_size - cursor, &tail, &boundary);
		if (ret)
		{
			ticalcs_warning("   NNSE: discarding %u residual byte(s) after NavNet packet", msg_size - cursor);
			return 0;
		}

		if (boundary)
		{
			ticalcs_warning("   NNSE: discarding %u residual byte(s) before trailing NavNet packet", boundary);
		}

		cursor += boundary;
		if (nsp_nnse_port_matches(handle, tail.dst_port))
		{
			ticalcs_debug("   NNSE: queueing trailing NavNet packet %04x->%04x cmd=%02x data_size=%u",
			              tail.src_port, tail.dst_port,
			              tail.logical_data_size ? tail.data[0] : 0, tail.logical_data_size);
			const int queue_ret = nsp_nnse_queue_stream(handle, msg + cursor, tail.raw_size);
			if (queue_ret)
			{
				return queue_ret;
			}
		}
		else
		{
			ticalcs_debug("   NNSE: not queueing trailing NavNet packet %04x->%04x while waiting on port %04x",
			              tail.src_port, tail.dst_port, handle->priv.nsp_src_port);
			const int control_ret = nsp_nnse_handle_stale_packet(handle, &tail, "trailing ");
			if (control_ret)
			{
				return control_ret;
			}
		}

		cursor += tail.raw_size;
	}

	return 0;
}

static int nsp_nnse_drain_after_close(CalcHandle *handle)
{
	uint8_t msg[NSP_NNSE_MAX_PAYLOAD];
	NSPParsedRawPacket parsed;
	const unsigned int old_timeout = ticables_options_set_timeout(handle->cable, NSP_NNSE_CLOSE_DRAIN_TIMEOUT);

	for (int i = 0; i < NSP_NNSE_CLOSE_DRAIN_MAX; i++)
	{
		memset(&parsed, 0, sizeof(parsed));
		const int ret = nsp_nnse_recv_raw_packet(handle, &parsed, msg, sizeof(msg));
		if (ret == ERROR_READ_TIMEOUT)
		{
			break;
		}
		if (ret == ERR_INVALID_PACKET || ret == ERR_CHECKSUM)
		{
			continue;
		}
		if (ret)
		{
			ticables_options_set_timeout(handle->cable, old_timeout);
			return ret;
		}

		ticalcs_debug("   NNSE: dropping post-close NavNet packet %04x->%04x cmd=%02x data_size=%u",
		              parsed.src_port, parsed.dst_port,
		              parsed.logical_data_size ? parsed.data[0] : 0, parsed.logical_data_size);
		const int control_ret = nsp_nnse_handle_stale_packet(handle, &parsed, "post-close ");
		if (control_ret)
		{
			ticables_options_set_timeout(handle->cable, old_timeout);
			return control_ret;
		}
	}

	ticables_options_set_timeout(handle->cable, old_timeout);
	return 0;
}

static int nsp_nnse_recv_raw_packet(CalcHandle *handle, NSPParsedRawPacket *pkt, uint8_t *msg, uint32_t msg_capacity)
{
	uint32_t msg_size = 0;
	int ret;

	for (;;)
	{
		ret = nsp_nnse_recv_stream(handle, msg, msg_capacity, &msg_size);
		if (ret)
		{
			return ret;
		}

		uint32_t offset = 0;
		ret = nsp_find_raw_packet_boundary(msg, msg_size, pkt, &offset);
		if (ret == ERR_CHECKSUM)
		{
			ticalcs_warning("   NNSE: dropping NavNet packet with bad checksum (%u bytes)", msg_size);
			continue;
		}
		if (ret)
		{
			ticalcs_warning("   NNSE: dropping stream payload without a valid NavNet packet boundary (%u bytes)", msg_size);
			continue;
		}
		if (offset)
		{
			ticalcs_warning("   NNSE: skipped %u byte(s) before NavNet packet boundary", offset);
		}
		if (offset + pkt->raw_size < msg_size)
		{
			ret = nsp_nnse_queue_trailing_packets(handle, msg, msg_size, offset + pkt->raw_size);
			if (ret)
			{
				return ret;
			}
		}
		if (!nsp_nnse_port_matches(handle, pkt->dst_port))
		{
			const int control_ret = nsp_nnse_handle_stale_packet(handle, pkt, "");
			if (control_ret)
			{
				return control_ret;
			}
			if (pkt->ack == 0x00 && pkt->logical_data_size > 0)
			{
				continue;
			}
			ticalcs_debug("   NNSE: ignoring NavNet packet %04x->%04x while waiting on port %04x cmd=%02x data_size=%u",
			             pkt->src_port, pkt->dst_port, handle->priv.nsp_src_port,
			             pkt->logical_data_size ? pkt->data[0] : 0, pkt->logical_data_size);
			nsp_nnse_drop_queued_streams(handle);
			continue;
		}

		if (pkt->src_port == 0x00fe || pkt->src_port == 0x00ff || pkt->src_port == 0x00d3)
		{
			handle->priv.nsp_seq_pc++;
		}
		else
		{
			handle->priv.nsp_seq = pkt->seq;
		}

		return 0;
	}
}

// Creation/Destruction/Garbage Collecting of packets

NSPVirtualPacket* TICALL nsp_vtl_pkt_new(CalcHandle * handle)
{
	return nsp_vtl_pkt_new_ex(handle, 0, 0, 0, 0, 0, 0, nullptr);
}

NSPVirtualPacket* TICALL nsp_vtl_pkt_new_ex(CalcHandle * handle, uint32_t size, uint16_t src_addr, uint16_t src_port, uint16_t dst_addr, uint16_t dst_port, uint8_t cmd, uint8_t * data)
{
	NSPVirtualPacket* vtl = nullptr;

	if (ticalcs_validate_handle(handle))
	{
		vtl = (NSPVirtualPacket *)g_malloc0(sizeof(NSPVirtualPacket));

		if (nullptr != vtl)
		{
			//GList * vtl_pkt_list;

			nsp_vtl_pkt_fill(vtl, size, src_addr, src_port, dst_addr, dst_port, cmd, data);

			//vtl_pkt_list = g_list_append((GList *)(handle->priv.nsp_vtl_pkt_list), vtl);
			//handle->priv.nsp_vtl_pkt_list = (void *)vtl_pkt_list;
		}
	}
	else
	{
		ticalcs_critical("%s: handle is invalid", __FUNCTION__);
	}

	return vtl;
}

void TICALL nsp_vtl_pkt_fill(NSPVirtualPacket* vtl, uint32_t size, uint16_t src_addr, uint16_t src_port, uint16_t dst_addr, uint16_t dst_port, uint8_t cmd, uint8_t * data)
{
	if (vtl != nullptr)
	{
		vtl->src_addr = src_addr;
		vtl->src_port = src_port;
		vtl->dst_addr = dst_addr;
		vtl->dst_port = dst_port;
		vtl->cmd = cmd;
		vtl->size = size;
		vtl->data = data;
	}
	else
	{
		ticalcs_critical("%s: vtl is NULL", __FUNCTION__);
	}
}

void TICALL nsp_vtl_pkt_del(CalcHandle *handle, NSPVirtualPacket* vtl)
{
	//GList *vtl_pkt_list;

	if (!ticalcs_validate_handle(handle))
	{
		ticalcs_critical("%s: handle is invalid", __FUNCTION__);
		return;
	}

	if (vtl == nullptr)
	{
		ticalcs_critical("%s: vtl is NULL", __FUNCTION__);
		return;
	}

	//vtl_pkt_list = g_list_remove((GList *)(handle->priv.nsp_vtl_pkt_list), vtl);
	//handle->priv.nsp_vtl_pkt_list = (void *)vtl_pkt_list;

	g_free(vtl->data);
	g_free(vtl);
}

void * TICALL nsp_vtl_pkt_alloc_data(CalcHandle * handle, size_t size)
{
	if (!ticalcs_validate_handle(handle))
	{
		return nullptr;
	}
	return g_malloc0(size + 1);
}

NSPVirtualPacket * TICALL nsp_vtl_pkt_realloc_data(CalcHandle * handle, NSPVirtualPacket* vtl, size_t size)
{
	if (!ticalcs_validate_handle(handle))
	{
		return nullptr;
	}
	if (vtl != nullptr)
	{
		if (size + 1 > size)
		{
			uint8_t * data = (uint8_t *)g_realloc(vtl->data, size + 1);
			if (nullptr != data)
			{
				if (size > vtl->size)
				{
					// The previous time, vtl->size + 1 bytes were allocated and initialized.
					// This time, we've allocated size + 1 bytes, so we need to initialize size - vtl->size extra bytes.
					memset(data + vtl->size + 1, 0x00, size - vtl->size);
				}
				vtl->data = data;
			}
			else
			{
				return nullptr;
			}
		}
		else
		{
			return nullptr;
		}
	}

	return vtl;
}

void TICALL nsp_vtl_pkt_free_data(CalcHandle * handle, void * data)
{
	if (ticalcs_validate_handle(handle))
	{
		g_free(data);
	}
}

// Session Management

int TICALL nsp_session_open(CalcHandle *handle, uint16_t port)
{
	VALIDATE_HANDLE(handle);

	if (handle->priv.nsp_src_port < NSP_CLIENT_PORT_FIRST || handle->priv.nsp_src_port >= NSP_CLIENT_PORT_LAST)
	{
		handle->priv.nsp_src_port = NSP_CLIENT_PORT_FIRST;
	}
	else
	{
		handle->priv.nsp_src_port++;
	}
	handle->priv.nsp_dst_port = port;

	ticalcs_info("  opening session from port #%04x to port #%04x:", handle->priv.nsp_src_port, handle->priv.nsp_dst_port);

	return 0;
}

int TICALL nsp_session_close(CalcHandle *handle)
{
	VALIDATE_HANDLE(handle);

	ticalcs_info("  closed session from port #%04x to port #%04x:", handle->priv.nsp_src_port, handle->priv.nsp_dst_port);

	SET_HANDLE_BUSY_IF_NECESSARY(handle);

	int ret = nsp_send_disconnect(handle);
	if (!ret)
	{
		if (nsp_nnse_enabled(handle))
		{
			ret = nsp_nnse_drain_after_close(handle);
		}
		else
		{
			ret = nsp_recv_ack(handle);
		}
		if (!ret)
		{
			handle->priv.nsp_dst_port = NSP_PORT_ADDR_REQUEST;
		}
	}

	CLEAR_HANDLE_BUSY_IF_NECESSARY(handle);

	return ret;
}

// Address Request/Assignment

int TICALL nsp_addr_request(CalcHandle *handle)
{
	NSPRawPacket pkt;

	VALIDATE_HANDLE(handle);

	// Single call to nsp_recv(), no need to take handle->busy.

	memset(&pkt, 0, sizeof(pkt));

	if (nsp_nnse_enabled(handle))
	{
		// The CX II performs its own NNSE-level handshake instead of sending
		// a NavNet address request, and no cable reset is needed to trigger it.
		handle->priv.nsp_seq_pc = 1;

		return nsp_nnse_ensure_ready(handle);
	}

	// Reset connection so that device send an address request packet
	int ret = handle->cable->cable->reset(handle->cable);
	if (!ret)
	{
		handle->priv.nsp_seq_pc = 1;

		ticalcs_info("  device address request:");

		ret = nsp_recv(handle, &pkt);
		if (!ret)
		{
			if (   pkt.src_port != NSP_PORT_ADDR_ASSIGN
			    || pkt.dst_port != NSP_PORT_ADDR_REQUEST)
			{
				ret = ERR_INVALID_PACKET;
			}
		}
	}

	return ret;
}

int TICALL nsp_addr_assign(CalcHandle *handle, uint16_t addr)
{
	NSPRawPacket pkt;

	VALIDATE_HANDLE(handle);

	// Tail call to nsp_send(), no need to take handle->busy.

	ticalcs_info("  assigning address %04x:", addr);

	memset(&pkt, 0, sizeof(pkt));
	pkt.data_size = 4;
	pkt.src_addr = NSP_SRC_ADDR;
	pkt.src_port = NSP_PORT_ADDR_ASSIGN;
	pkt.dst_addr = NSP_DEV_ADDR;
	pkt.dst_port = NSP_PORT_ADDR_ASSIGN;
	pkt.data[0] = MSB(addr);
	pkt.data[1] = LSB(addr);
	pkt.data[2] = 0xFF;
	pkt.data[3] = 0x00;

	return nsp_send(handle, &pkt);
}

// Acknowledgement

int TICALL nsp_send_ack(CalcHandle* handle)
{
	NSPRawPacket pkt;

	VALIDATE_HANDLE(handle);

	// Tail call to nsp_send(), no need to take handle->busy.

	ticalcs_info("  sending ack:");

	memset(&pkt, 0, sizeof(pkt));
	pkt.data_size = 2;
	pkt.src_addr = NSP_SRC_ADDR;
	pkt.src_port = NSP_PORT_PKT_ACK2;
	pkt.dst_addr = NSP_DEV_ADDR;
	pkt.dst_port = handle->priv.nsp_dst_port;
	pkt.data[0] = MSB(handle->priv.nsp_src_port);
	pkt.data[1] = LSB(handle->priv.nsp_src_port);

	return nsp_send(handle, &pkt);
}

static int nsp_send_ack_for_raw(CalcHandle* handle, const NSPRawPacket* packet)
{
	NSPRawPacket ack;

	memset(&ack, 0, sizeof(ack));
	ack.data_size = 2;
	ack.src_addr = NSP_SRC_ADDR;
	ack.src_port = (packet->seq == 0 ? NSP_PORT_PKT_ACK1 : NSP_PORT_PKT_ACK2);
	ack.dst_addr = NSP_DEV_ADDR;
	ack.dst_port = packet->src_port;
	ack.data[0] = MSB(packet->dst_port);
	ack.data[1] = LSB(packet->dst_port);

	return nsp_send(handle, &ack);
}


int TICALL nsp_send_nack(CalcHandle* handle)
{
	VALIDATE_HANDLE(handle);

	// Tail call to a function which takes handle->busy through nsp_send().

	return nsp_send_nack_ex(handle, handle->priv.nsp_dst_port);
}

int TICALL nsp_send_nack_ex(CalcHandle* handle, uint16_t port)
{
	NSPRawPacket pkt;

	VALIDATE_HANDLE(handle);

	// Tail call to nsp_send(), no need to take handle->busy.

	ticalcs_info("  sending nAck:");

	memset(&pkt, 0, sizeof(pkt));
	pkt.data_size = 2;
	pkt.src_addr = NSP_SRC_ADDR;
	pkt.src_port = NSP_PORT_PKT_NACK;
	pkt.dst_addr = NSP_DEV_ADDR;
	pkt.dst_port = port;
	pkt.data[0] = MSB(NSP_PORT_LOGIN);
	pkt.data[1] = LSB(NSP_PORT_LOGIN);

	return nsp_send(handle, &pkt);
}

int TICALL nsp_recv_ack(CalcHandle *handle)
{
	NSPRawPacket pkt;
	int ret = 0;

	VALIDATE_HANDLE(handle);

	// Single call to nsp_recv(), no need to take handle->busy.

	if (nsp_nnse_enabled(handle))
	{
		// NavNet-level acknowledgements are replaced by NNSE-level ones,
		// which are handled by the NNSE layer when sending.
		return 0;
	}

	ticalcs_info("  receiving ack:");

	for (;;)
	{
		memset(&pkt, 0, sizeof(pkt));

		ret = nsp_recv(handle, &pkt);
		if (ret)
		{
			return ret;
		}

		if (pkt.data_size >= 1 && (pkt.data[0] == NSP_CMD_OS_OK || pkt.data[0] == NSP_CMD_STATUS))
		{
			handle->priv.nsp_pending_cmd = pkt.data[0];
			handle->priv.nsp_has_pending_status = 0;
			handle->priv.nsp_pending_status = 0;

			if (pkt.data[0] == NSP_CMD_OS_OK)
			{
				int ack_ret = nsp_send_ack_for_raw(handle, &pkt);
				if (ack_ret)
				{
					return ack_ret;
				}
				ticalcs_info("  OS OK packet received while waiting for ack");
			}
			else if (pkt.data_size >= 2)
			{
				const uint8_t status = pkt.data[1];
				handle->priv.nsp_pending_status = status;
				handle->priv.nsp_has_pending_status = 1;
				if (status == 0x00)
				{
					int ack_ret = nsp_send_ack_for_raw(handle, &pkt);
					if (ack_ret)
					{
						return ack_ret;
					}
					ticalcs_info("  OS STATUS OK packet received while waiting for ack");
				}
				else
				{
					int ret_err = ERR_CALC_ERROR3;
					const unsigned int count = ticalcs_nsp_error_count();
					for (unsigned int i = 0; i < count; i++)
					{
						if (ticalcs_nsp_error_code_from_index(i) == status)
						{
							ret_err = ERR_CALC_ERROR3 + (int)i + 1;
							break;
						}
					}
					return ret_err;
				}
			}
			// Continue reading until we get the actual ACK.
			continue;
		}

		if (pkt.ack == 0x00 && pkt.data_size > 0)
		{
			int ack_ret = nsp_send_ack_for_raw(handle, &pkt);
			if (ack_ret)
			{
				return ack_ret;
			}
			ticalcs_debug("  ignoring unexpected packet while waiting for ack");
			continue;
		}

		const bool ack2 = (pkt.src_port == NSP_PORT_PKT_ACK2);
		const bool service_ack = (pkt.src_port == handle->priv.nsp_dst_port);
		if (!ack2 && !service_ack)
		{
			ticalcs_debug("  ignoring unexpected ACK src_port=%04x while waiting for ack", pkt.src_port);
			continue;
		}
		if (pkt.dst_port != handle->priv.nsp_src_port)
		{
			ticalcs_debug("  ignoring unexpected ACK dst_port=%04x while waiting for ack", pkt.dst_port);
			continue;
		}

		if (pkt.data_size >= 2)
		{
			const uint16_t addr = (((uint16_t)pkt.data[0]) << 8) | pkt.data[1];
			const uint16_t expected_addr = ack2 ? handle->priv.nsp_dst_port : handle->priv.nsp_src_port;
			if (addr != expected_addr)
			{
				ticalcs_debug("  ignoring unexpected ACK addr=%04x expected=%04x while waiting for ack", addr, expected_addr);
				continue;
			}
		}
		else
		{
			ticalcs_debug("  ignoring short ACK packet while waiting for ack");
			continue;
		}

		if (pkt.ack != 0x0A)
		{
			ticalcs_debug("  ignoring ACK with unexpected ack flag=%02x while waiting for ack", pkt.ack);
			continue;
		}

		return 0;
	}
}


// Service Disconnection

int TICALL nsp_send_disconnect(CalcHandle *handle)
{
	NSPRawPacket pkt;

	VALIDATE_HANDLE(handle);

	// Tail call to nsp_send(), no need to take handle->busy.

	ticalcs_info("  disconnecting from service #%04x:", handle->priv.nsp_dst_port);

	memset(&pkt, 0, sizeof(pkt));
	pkt.data_size = 2;
	pkt.src_addr = NSP_SRC_ADDR;
	pkt.src_port = NSP_PORT_DISCONNECT;
	pkt.dst_addr = NSP_DEV_ADDR;
	pkt.dst_port = handle->priv.nsp_dst_port;
	pkt.data[0] = MSB(handle->priv.nsp_src_port);
	pkt.data[1] = LSB(handle->priv.nsp_src_port);

	return nsp_send(handle, &pkt);
}

int TICALL nsp_recv_disconnect(CalcHandle *handle)
{
	NSPRawPacket pkt;

	VALIDATE_HANDLE(handle);

	ticalcs_info("  receiving disconnect:");

	memset(&pkt, 0, sizeof(pkt));

	SET_HANDLE_BUSY_IF_NECESSARY(handle);

	int ret = nsp_recv(handle, &pkt);
	if (!ret)
	{

		if (pkt.src_port != NSP_PORT_DISCONNECT)
		{
			ret = ERR_INVALID_PACKET;
		}
		else
		{
			// nasty hacks
			handle->priv.nsp_dst_port = (((uint16_t)pkt.data[0]) << 8) | pkt.data[1];
			const uint16_t addr = pkt.dst_port;

			ticalcs_info("  sending ack:");

			pkt.unused = 0;
			pkt.data_size = 2;
			pkt.src_addr = NSP_SRC_ADDR;
			pkt.src_port = NSP_PORT_PKT_ACK2;
			pkt.dst_addr = NSP_DEV_ADDR;
			pkt.dst_port = handle->priv.nsp_dst_port;
			pkt.data_sum = 0;
			pkt.ack = 0;
			pkt.seq = 0;
			pkt.hdr_sum = 0;
			pkt.data[0] = MSB(addr);
			pkt.data[1] = LSB(addr);
			ret = nsp_send(handle, &pkt);
		}
	}

	CLEAR_HANDLE_BUSY_IF_NECESSARY(handle);

	return ret;
}

// Fragmenting of packets

int TICALL nsp_send_data(CalcHandle *handle, NSPVirtualPacket *vtl)
{
	NSPRawPacket raw;
	long offset = 0;
	int ret = 0;
	CalcEventData event;

	VALIDATE_HANDLE(handle);
	VALIDATE_NONNULL(vtl);
	if (vtl->size && !vtl->data)
	{
		return ERR_INVALID_PARAMETER;
	}

	SET_HANDLE_BUSY_IF_NECESSARY(handle);

	ticalcs_event_fill_header(handle, &event, /* type */ CALC_EVENT_TYPE_BEFORE_SEND_NSP_VPKT, /* retval */ 0, /* operation */ CALC_FNCT_LAST);
	ticalcs_event_fill_nsp_vpkt(&event, vtl->src_addr, vtl->src_port, vtl->dst_addr, vtl->dst_port, vtl->cmd, vtl->size, vtl->data);
	ret = ticalcs_event_send(handle, &event);

	if (!ret)
	{
		memset(&raw, 0, sizeof(raw));
		raw.src_addr = vtl->src_addr;
		raw.src_port = vtl->src_port;
		raw.dst_addr = vtl->dst_addr;
		raw.dst_port = vtl->dst_port;

		if (nsp_nnse_enabled(handle))
		{
			uint8_t data[NSP_NNSE_DATA_SIZE];
			const uint32_t chunk_payload_size = NSP_NNSE_DATA_SIZE - 1;

			do
			{
				const uint32_t remaining = vtl->size - offset;
				const uint32_t copy_size = MIN(chunk_payload_size, remaining);
				data[0] = vtl->cmd;
				if (copy_size)
				{
					memcpy(data + 1, vtl->data + offset, copy_size);
				}
				offset += copy_size;

				ret = nsp_nnse_send_raw_data(handle, &raw, data, copy_size + 1);
				if (ret)
				{
					break;
				}

				handle->updat->max1 = vtl->size;
				handle->updat->cnt1 = offset;
				handle->updat->pbar();
			} while ((uint32_t)offset < vtl->size);
		}
		else
		{
			const int q = (vtl->size - offset) / (NSP_DATA_SIZE - 1);
			const int r = (vtl->size - offset) % (NSP_DATA_SIZE - 1);

			for (int i = 1; i <= q; i++)
			{
				raw.data_size = NSP_DATA_SIZE;
				raw.data[0] = vtl->cmd;
				memcpy(raw.data + 1, vtl->data + offset, NSP_DATA_SIZE-1);
				offset += NSP_DATA_SIZE-1;

				ret = nsp_send(handle, &raw);
				if (ret)
				{
					break;
				}

				if (raw.src_port != NSP_PORT_ADDR_ASSIGN && raw.dst_port != NSP_PORT_ADDR_REQUEST)
				{
					ret = nsp_recv_ack(handle);
					if (ret)
					{
						break;
					}
				}

				handle->updat->max1 = vtl->size;
				handle->updat->cnt1 += NSP_DATA_SIZE;
				handle->updat->pbar();
			}

			if (!ret)
			{
				if (r || !vtl->size)
				{
					raw.data_size = r + 1;
					raw.data[0] = vtl->cmd;
					if (vtl->data)
					{
						memcpy(raw.data + 1, vtl->data + offset, r);
					}
					offset += r;

					ret = nsp_send(handle, &raw);
					if (!ret)
					{
						if (raw.src_port != NSP_PORT_ADDR_ASSIGN && raw.dst_port != NSP_PORT_ADDR_REQUEST)
						{
							ret = nsp_recv_ack(handle);
						}
					}
				}
			}
		}
	}

	ticalcs_event_fill_header(handle, &event, /* type */ CALC_EVENT_TYPE_AFTER_SEND_NSP_VPKT, /* retval */ ret, /* operation */ CALC_FNCT_LAST);
	ticalcs_event_fill_nsp_vpkt(&event, vtl->src_addr, vtl->src_port, vtl->dst_addr, vtl->dst_port, vtl->cmd, vtl->size, vtl->data);
	ret = ticalcs_event_send(handle, &event);

	CLEAR_HANDLE_BUSY_IF_NECESSARY(handle);

	return ret;
}

// Note: data field may be re-allocated.
int TICALL nsp_recv_data(CalcHandle* handle, NSPVirtualPacket* vtl)
{
	NSPRawPacket raw;
	long offset = 0;
	int ret = 0;
	CalcEventData event;

	VALIDATE_HANDLE(handle);
	VALIDATE_NONNULL(vtl);

	SET_HANDLE_BUSY_IF_NECESSARY(handle);

	ticalcs_event_fill_header(handle, &event, /* type */ CALC_EVENT_TYPE_BEFORE_RECV_NSP_VPKT, /* retval */ 0, /* operation */ CALC_FNCT_LAST);
	ticalcs_event_fill_nsp_vpkt(&event, /* src_addr */ 0, /* src_port */ 0, /* dst_addr */ 0, /* dst_port */ 0, /* cmd */ 0, /* size */ 0, /* data */ nullptr);
	ret = ticalcs_event_send(handle, &event);

	if (!ret)
	{
		memset(&raw, 0, sizeof(raw));

		const uint32_t size = vtl->size;
		vtl->size = 0;
		vtl->data = (uint8_t *)g_malloc(1);

		if (vtl->data)
		{
			if (nsp_nnse_enabled(handle))
			{
				uint8_t msg[NSP_NNSE_MAX_PAYLOAD];
				NSPParsedRawPacket parsed;

				for (;;)
				{
					memset(&parsed, 0, sizeof(parsed));
					ret = nsp_nnse_recv_raw_packet(handle, &parsed, msg, sizeof(msg));
					if (ret)
					{
						break;
					}

					raw.src_addr = parsed.src_addr;
					raw.src_port = parsed.src_port;
					raw.dst_addr = parsed.dst_addr;
					raw.dst_port = parsed.dst_port;
					raw.data_sum = parsed.data_sum;
					raw.data_size = parsed.data_size;
					raw.ack = parsed.ack;
					raw.seq = parsed.seq;
					raw.hdr_sum = parsed.hdr_sum;

					const uint32_t raw_payload_size = parsed.logical_data_size - 1;
					uint32_t copy_size = raw_payload_size;
					vtl->cmd = parsed.data[0];
					if (size && vtl->size + copy_size > size)
					{
						copy_size = size - vtl->size;
					}

					uint8_t *new_data = (uint8_t *)g_realloc(vtl->data, vtl->size + copy_size + 1);
					if (new_data == nullptr)
					{
						ret = ERR_MALLOC;
						break;
					}
					vtl->data = new_data;
					if (copy_size)
					{
						memcpy(vtl->data + offset, parsed.data + 1, copy_size);
					}
					vtl->size += copy_size;
					offset += copy_size;

					handle->updat->max1 = size ? size : vtl->size;
					handle->updat->cnt1 = vtl->size;
					handle->updat->pbar();

					if (size && vtl->size >= size)
					{
						break;
					}
					if (parsed.logical_data_size < NSP_NNSE_DATA_SIZE)
					{
						break;
					}
				}
			}
			else
			{
				for (;;)
				{
					ret = nsp_recv(handle, &raw);
					if (ret)
					{
						break;
					}
					if (raw.data_size > 0)
					{
						const uint32_t raw_payload_size = raw.data_size - 1;
						uint32_t copy_size = raw_payload_size;
						vtl->cmd = raw.data[0];
						if (size && vtl->size + copy_size > size)
						{
							copy_size = size - vtl->size;
						}

						uint8_t *new_data = (uint8_t *)g_realloc(vtl->data, vtl->size + copy_size + 1);
						if (new_data == nullptr)
						{
							ret = ERR_MALLOC;
							break;
						}
						vtl->data = new_data;
						if (copy_size)
						{
							memcpy(vtl->data + offset, &(raw.data[1]), copy_size);
						}
						vtl->size += copy_size;
						offset += copy_size;

						handle->updat->max1 = size ? size : vtl->size;
						handle->updat->cnt1 += NSP_DATA_SIZE;
						handle->updat->pbar();
					}

					if (raw.dst_port == NSP_PORT_LOGIN)
					{
						ret = nsp_send_nack_ex(handle, raw.src_port);
						if (ret)
						{
							break;
						}
					}
					else if (raw.src_port != NSP_PORT_ADDR_ASSIGN && raw.dst_port != NSP_PORT_ADDR_REQUEST)
					{
						ret = nsp_send_ack(handle);
						if (ret)
						{
							break;
						}
					}

					if (size && vtl->size >= size)
					{
						break;
					}
					if (raw.data_size < NSP_DATA_SIZE)
					{
						break;
					}
				}
			}
		}

		vtl->src_addr = raw.src_addr;
		vtl->src_port = raw.src_port;
		vtl->dst_addr = raw.dst_addr;
		vtl->dst_port = raw.dst_port;
	}

	ticalcs_event_fill_header(handle, &event, /* type */ CALC_EVENT_TYPE_AFTER_RECV_NSP_VPKT, /* retval */ ret, /* operation */ CALC_FNCT_LAST);
	ticalcs_event_fill_nsp_vpkt(&event, vtl->src_addr, vtl->src_port, vtl->dst_addr, vtl->dst_port, vtl->cmd, vtl->size, vtl->data);
	ret = ticalcs_event_send(handle, &event);

	CLEAR_HANDLE_BUSY_IF_NECESSARY(handle);

	return ret;
}
