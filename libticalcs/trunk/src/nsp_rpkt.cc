/* Hey EMACS -*- linux-c -*- */
/* $Id: packets.c 1404 2005-07-20 20:39:39Z roms $ */

/*  libticalcs - Ti Calculator library, a part of the TiLP project
 *  Copyright (C) 2007 Romain Liévin
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
	This unit manages raw packets from/to NSpire thru DirectLink cable.
	Documentation & credits can be found at <http://hackspire.unsads.com/USB_Protocol>.
*/

#include <stdio.h>
#include <string.h>

#include "ticalcs.h"
#include "internal.h"
#include "nsp_rpkt.h"
#include "nsp_vpkt.h"
#include "nsp_nnse.h"
#include "logging.h"
#include "error.h"

#define VPKT_DBG	1	// 1 = verbose, 2 = more verbose

typedef struct
{
	uint16_t		id;
	const char*		name;
} NSPServiceId;

typedef struct
{
	uint16_t		id;
	const char*		name;
} NSPAddress;

static const NSPAddress nspaddrs[] =
{
	{ 0x0000, "TI" },
	{ 0x6400, "PC" },
	{ 0x6401, "TI" },
};

static const NSPServiceId nspsids[] =
{
	{ 0x00FE, "Reception Acknowledgment" },
	{ 0x00FF, "Reception Ack" },
	{ 0x4001, "Null" },
	{ 0x4002, "Echo" },
	{ 0x4003, "Device Address Request/Assignment" },
	{ 0x4020, "Device Information" },
	{ 0x4021, "Screen Capture" },
	{ 0x4024, "Screen Capture w/ RLE" },
	{ 0x4042, "Keypresses" },
	{ 0x4050, "Login" },
	{ 0x4051, "Messages" },
	{ 0x4060, "File Management" },
	{ 0x4070, "TI-Robot" },
	{ 0x4080, "OS Installation" },
	{ 0x4090, "Remote Management" },
	{ 0x40DE, "Service Disconnect" },

	{ 0x8003, "8003" },
	{ 0x8004, "8004" },
	{ 0x8005, "8005" },
	{ 0x8006, "8006" },
	{ 0x8007, "8007" },
	{ 0x8009, "8009" },
};

const char* TICALL nsp_addr2name(uint16_t id)
{
	for (unsigned int i = 0; i < sizeof(nspaddrs) / sizeof(nspaddrs[0]); i++)
	{
		if (id == nspaddrs[i].id)
		{
			return nspaddrs[i].name;
		}
	}

	return "";
}

const char* TICALL nsp_sid2name(uint16_t id)
{
	for (unsigned int i = 0; i < sizeof(nspsids) / sizeof(nspsids[0]); i++)
	{
		if (id == nspsids[i].id)
		{
			return nspsids[i].name;
		}
	}

	return "";
}

void TICALL nsp_init_reply(NSPRawPacket *reply, const NSPRawPacket *request)
{
	if (reply == nullptr || request == nullptr)
	{
		return;
	}

	memset(reply, 0, sizeof(*reply));
	reply->src_addr = request->dst_addr;
	reply->src_port = request->dst_port;
	reply->dst_addr = request->src_addr;
	reply->dst_port = request->src_port;
}

// CRC implementation from O. Armand (ExtendeD)
static uint16_t compute_crc(uint8_t *data, uint32_t size)
{
	uint16_t acc = 0;

	if (size == 0)
	{
		return 0;
	}

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

static int hexdump(uint8_t *data, uint32_t size)
{
#if (VPKT_DBG == 1)
	char str[64];

	str[0] = 0;
	if (size <= 12)
	{
		str[0] = ' '; str[1] = ' '; str[2] = ' '; str[3] = ' ';

		for (uint32_t i = 0; i < size; i++)
		{
			sprintf(&str[3*i+4], "%02X ", data[i]);
		}
	}
	else
	{
		sprintf(str, "    %02X %02X %02X %02X %02X ..... %02X %02X %02X %02X %02X",
		             data[0], data[1], data[2], data[3], data[4],
		             data[size-5], data[size-4], data[size-3], data[size-2], data[size-1]);
	}
	ticalcs_info("%s", str);
#endif
#if (VPKT_DBG == 2)
	char *str = (char *)g_malloc(3*size + 8 + 10);
	uint32_t i, j, k;
	int step = 12;

	for (k = 0; k < 4; k++)
	{
		str[k] = ' ';
	}

	for (i = j = 0; i < size; i++, j++)
	{
		if (i && !(i % step))
		{
			ticalcs_info(str);
			j = 0;
		}

		sprintf(&str[3*j+4], "%02X ", data[i]);
	}
	ticalcs_info("%s", str);

	g_free(str);
#endif
	return 0;
}


static void nsp_pack_raw_message(uint8_t *buf, const NSPRawPacket *pkt, const uint8_t *data, uint8_t data_size)
{
	uint16_t data_sum = compute_crc((uint8_t *)data, data_size);

	buf[0] = 0x54;
	buf[1] = 0xFD;
	buf[2] = MSB(pkt->src_addr);
	buf[3] = LSB(pkt->src_addr);
	buf[4] = MSB(pkt->src_port);
	buf[5] = LSB(pkt->src_port);
	buf[6] = MSB(pkt->dst_addr);
	buf[7] = LSB(pkt->dst_addr);
	buf[8] = MSB(pkt->dst_port);
	buf[9] = LSB(pkt->dst_port);
	buf[10] = MSB(data_sum);
	buf[11] = LSB(data_sum);
	buf[12] = data_size;
	buf[13] = pkt->ack;
	buf[14] = pkt->seq;
	buf[15] = tifiles_checksum(buf, NSP_HEADER_SIZE-1) & 0xff;

	if (data_size)
	{
		memcpy(buf + NSP_HEADER_SIZE, data, data_size);
	}
}

static int nsp_queue_nnse_split_packet(CalcHandle *handle, const NSPRawPacket *pkt, uint8_t cmd,
                                       const uint8_t *data, uint32_t data_size)
{
	uint8_t raw[NSP_HEADER_SIZE + NSP_DATA_SIZE];
	uint8_t chunk[NSP_DATA_SIZE];
	uint32_t offset = 0;

	while (offset < data_size)
	{
		const uint32_t chunk_data_size = MIN((uint32_t)(NSP_DATA_SIZE - 1), data_size - offset);
		chunk[0] = cmd;
		memcpy(chunk + 1, data + offset, chunk_data_size);
		nsp_pack_raw_message(raw, pkt, chunk, (uint8_t)(chunk_data_size + 1));

		int ret = nsp_nnse_queue_stream(handle, raw, NSP_HEADER_SIZE + chunk_data_size + 1);
		if (ret)
		{
			return ret;
		}

		offset += chunk_data_size;
	}

	// If the last synthetic packet is full-sized and callers don't know the
	// expected total size, give them a short terminator packet.
	if (data_size > 0 && (data_size % (NSP_DATA_SIZE - 1)) == 0)
	{
		chunk[0] = cmd;
		nsp_pack_raw_message(raw, pkt, chunk, 1);
		return nsp_nnse_queue_stream(handle, raw, NSP_HEADER_SIZE + 1);
	}

	return 0;
}

int TICALL nsp_send(CalcHandle* handle, NSPRawPacket* pkt)
{
	uint8_t buf[sizeof(NSPRawPacket)] = { 0 };
	CalcEventData event;

	VALIDATE_HANDLE(handle);
	VALIDATE_NONNULL(pkt);

	SET_HANDLE_BUSY_IF_NECESSARY(handle);

	const int is_nnse = nsp_nnse_enabled(handle);
	if (is_nnse && (pkt->src_port == 0x00fe || pkt->src_port == 0x00ff))
	{
		// NavNet-level acknowledgements are replaced by NNSE-level ones.
		ticalcs_info("   NNSE: not sending NavNet-level ack");
		CLEAR_HANDLE_BUSY_IF_NECESSARY(handle);
		return 0;
	}

	ticalcs_event_fill_header(handle, &event, /* type */ CALC_EVENT_TYPE_BEFORE_SEND_NSP_RPKT, /* retval */ 0, /* operation */ CALC_FNCT_LAST);
	ticalcs_event_fill_nsp_rpkt(&event, /* src_addr */ pkt->src_addr, /* src_port */ pkt->src_port, /* dst_addr */ pkt->dst_addr, /* dst_port */ pkt->dst_port,
	                            /* data_sum */ pkt->data_sum, /* data_size */ pkt->data_size, /* ack */ pkt->ack, /* seq */ pkt->seq, /* hdr_sum */ pkt->hdr_sum, /* data */ pkt->data);
	int ret = ticalcs_event_send(handle, &event);

	if (!ret)
	{
		const uint32_t size = pkt->data_size + NSP_HEADER_SIZE;
		pkt->data_sum = compute_crc(pkt->data, pkt->data_size);

		if (pkt->src_port == 0x00fe || pkt->src_port == 0x00ff || pkt->src_port == 0x00d3)
		{
			pkt->ack = 0x0a;
			pkt->seq = handle->priv.nsp_seq;
		}
		else if (is_nnse)
		{
			// The NNSE layer carries its own sequence numbers; NavNet packets
			// are sent with seq 0 on this transport, like libnspire does.
			pkt->seq = 0;
		}
		else
		{
			if (!handle->priv.nsp_seq_pc)
			{
				handle->priv.nsp_seq_pc++;
			}
			pkt->seq = handle->priv.nsp_seq_pc;
		}

		ticalcs_info("   %04x:%04x->%04x:%04x AK=%02x SQ=%02x HC=%02x DC=%04x (%i bytes)",
				pkt->src_addr, pkt->src_port, pkt->dst_addr, pkt->dst_port,
				pkt->ack, pkt->seq, pkt->hdr_sum, pkt->data_sum, pkt->data_size);
		if (pkt->data_size)
		{
			hexdump(pkt->data, pkt->data_size);
		}

		buf[0] = 0x54;
		buf[1] = 0xFD;
		buf[2] = MSB(pkt->src_addr);
		buf[3] = LSB(pkt->src_addr);
		buf[4] = MSB(pkt->src_port);
		buf[5] = LSB(pkt->src_port);
		buf[6] = MSB(pkt->dst_addr);
		buf[7] = LSB(pkt->dst_addr);
		buf[8] = MSB(pkt->dst_port);
		buf[9] = LSB(pkt->dst_port);
		buf[10] = MSB(pkt->data_sum);
		buf[11] = LSB(pkt->data_sum);
		buf[12] = pkt->data_size;
		buf[13] = pkt->ack;
		buf[14] = pkt->seq;
		buf[15] = pkt->hdr_sum = tifiles_checksum(buf, NSP_HEADER_SIZE-1) & 0xff;

		memcpy(buf + NSP_HEADER_SIZE, pkt->data, pkt->data_size);

		ticables_progress_reset(handle->cable);
		if (is_nnse)
		{
			ret = nsp_nnse_send_stream(handle, buf, size);
		}
		else
		{
			ret = ticables_cable_send(handle->cable, buf, size);
		}
		if (!ret)
		{
			if (size >= 128)
			{
				ticables_progress_get(handle->cable, nullptr, nullptr, &handle->updat->rate);
			}

			if (handle->updat->cancel)
			{
				ret = ERR_ABORT;
			}
		}
	}

	ticalcs_event_fill_header(handle, &event, /* type */ CALC_EVENT_TYPE_AFTER_SEND_NSP_RPKT, /* retval */ ret, /* operation */ CALC_FNCT_LAST);
	ticalcs_event_fill_nsp_rpkt(&event, /* src_addr */ pkt->src_addr, /* src_port */ pkt->src_port, /* dst_addr */ pkt->dst_addr, /* dst_port */ pkt->dst_port,
	                            /* data_sum */ pkt->data_sum, /* data_size */ pkt->data_size, /* ack */ pkt->ack, /* seq */ pkt->seq, /* hdr_sum */ pkt->hdr_sum, /* data */ pkt->data);
	ret = ticalcs_event_send(handle, &event);

	CLEAR_HANDLE_BUSY_IF_NECESSARY(handle);

	return ret;
}

int TICALL nsp_recv(CalcHandle* handle, NSPRawPacket* pkt)
{
	uint8_t buf[NSP_HEADER_SIZE];
	CalcEventData event;

	VALIDATE_HANDLE(handle);
	VALIDATE_NONNULL(pkt);

	SET_HANDLE_BUSY_IF_NECESSARY(handle);

	ticalcs_event_fill_header(handle, &event, /* type */ CALC_EVENT_TYPE_BEFORE_RECV_NSP_RPKT, /* retval */ 0, /* operation */ CALC_FNCT_LAST);
	ticalcs_event_fill_nsp_rpkt(&event, /* src_addr */ 0, /* src_port */ 0, /* dst_addr */ 0, /* dst_port */ 0,
	                            /* data_sum */ 0, /* data_size */ 0, /* ack */ 0, /* seq */ 0, /* hdr_sum */ 0, /* data */ pkt->data);
	int ret = ticalcs_event_send(handle, &event);

	if (!ret)
	{
		ticables_progress_reset(handle->cable);
		if (nsp_nnse_enabled(handle))
		{
			uint8_t msg[NSP_NNSE_MAX_PAYLOAD];
			uint32_t msg_size = 0;

			ret = nsp_nnse_recv_stream(handle, msg, sizeof(msg), &msg_size);
			while (!ret)
			{
				if (msg_size < NSP_HEADER_SIZE)
				{
					ticalcs_critical("%s: NNSE stream payload too small for a NavNet packet", __FUNCTION__);
					ret = ERR_INVALID_PACKET;
					break;
				}

				pkt->unused    = (((uint16_t)msg[0]) << 8) | msg[1];
				pkt->src_addr  = (((uint16_t)msg[2]) << 8) | msg[3];
				pkt->src_port  = (((uint16_t)msg[4]) << 8) | msg[5];
				pkt->dst_addr  = (((uint16_t)msg[6]) << 8) | msg[7];
				pkt->dst_port  = (((uint16_t)msg[8]) << 8) | msg[9];
				pkt->data_sum  = (((uint16_t)msg[10]) << 8) | msg[11];
				pkt->data_size = msg[12];
				pkt->ack       = msg[13];
				pkt->seq       = msg[14];
				pkt->hdr_sum   = msg[15];

				if (!nsp_nnse_port_matches(handle, pkt->dst_port))
				{
					ticalcs_debug("   NNSE: ignoring NavNet packet %04x->%04x while waiting on port %04x cmd=%02x data_size=%u data1=%02x",
					             pkt->src_port, pkt->dst_port, handle->priv.nsp_src_port,
					             pkt->data_size && msg_size > NSP_HEADER_SIZE ? msg[NSP_HEADER_SIZE] : 0, pkt->data_size,
					             pkt->data_size > 1 && msg_size > NSP_HEADER_SIZE + 1 ? msg[NSP_HEADER_SIZE + 1] : 0);
					nsp_nnse_drop_queued_streams(handle);
					ret = nsp_nnse_recv_stream(handle, msg, sizeof(msg), &msg_size);
					continue;
				}

				if (pkt->data_size == 0xFF)
				{
					if (msg_size < NSP_HEADER_SIZE + 4)
					{
						ticalcs_critical("%s: extended NavNet packet is missing its 32-bit size", __FUNCTION__);
						ret = ERR_INVALID_PACKET;
						break;
					}

					const uint32_t ext_size = (((uint32_t)msg[16]) << 24) | (((uint32_t)msg[17]) << 16) | (((uint32_t)msg[18]) << 8) | msg[19];
					if (ext_size < 1 || ext_size + NSP_HEADER_SIZE + 4 > msg_size)
					{
						ticalcs_critical("%s: extended NavNet data size is incoherent with NNSE stream payload size", __FUNCTION__);
						ret = ERR_INVALID_PACKET;
						break;
					}

					const uint8_t cmd = msg[NSP_HEADER_SIZE + 4];
					const uint8_t * ext_data = msg + NSP_HEADER_SIZE + 5;
					const uint32_t ext_data_size = ext_size - 1;
					const uint32_t first_data_size = MIN((uint32_t)(NSP_DATA_SIZE - 1), ext_data_size);

					pkt->data[0] = cmd;
					if (first_data_size)
					{
						memcpy(pkt->data + 1, ext_data, first_data_size);
					}
					pkt->data_size = (uint8_t)(first_data_size + 1);
					pkt->data_sum = compute_crc(pkt->data, pkt->data_size);

					if (ext_data_size > first_data_size)
					{
						ret = nsp_queue_nnse_split_packet(handle, pkt, cmd, ext_data + first_data_size, ext_data_size - first_data_size);
						if (ret)
						{
							break;
						}
					}
					else if (pkt->data_size == NSP_DATA_SIZE)
					{
						uint8_t terminator[1] = { cmd };
						uint8_t raw[NSP_HEADER_SIZE + 1];
						nsp_pack_raw_message(raw, pkt, terminator, 1);
						ret = nsp_nnse_queue_stream(handle, raw, sizeof(raw));
						if (ret)
						{
							break;
						}
					}
				}
				else if ((uint32_t)pkt->data_size + NSP_HEADER_SIZE > msg_size)
				{
					ticalcs_critical("%s: NavNet data size is incoherent with NNSE stream payload size", __FUNCTION__);
					ret = ERR_INVALID_PACKET;
					break;
				}
				else if (pkt->data_size)
				{
					memcpy(pkt->data, msg + NSP_HEADER_SIZE, pkt->data_size);
				}

				if (pkt->src_port == 0x00fe || pkt->src_port == 0x00ff || pkt->src_port == 0x00d3)
				{
					handle->priv.nsp_seq_pc++;
				}
				else
				{
					handle->priv.nsp_seq = pkt->seq;
				}

				if (pkt->data_size >= 128)
				{
					ticables_progress_get(handle->cable, nullptr, nullptr, &handle->updat->rate);
				}

				if (handle->updat->cancel)
				{
					ret = ERR_ABORT;
					break;
				}

				ticalcs_info("   %04x:%04x->%04x:%04x AK=%02x SQ=%02x HC=%02x DC=%04x (%i bytes)",
					     pkt->src_addr, pkt->src_port, pkt->dst_addr, pkt->dst_port,
					     pkt->ack, pkt->seq, pkt->hdr_sum, pkt->data_sum, pkt->data_size);
				if (pkt->data_size)
				{
					hexdump(pkt->data, pkt->data_size);
				}

				break;
			}

		}
		else
		{
			ret = ticables_cable_recv(handle->cable, buf, NSP_HEADER_SIZE);
			while (!ret)
			{
				pkt->unused    = (((uint16_t)buf[0]) << 8) | buf[1];
				pkt->src_addr  = (((uint16_t)buf[2]) << 8) | buf[3];
				pkt->src_port  = (((uint16_t)buf[4]) << 8) | buf[5];
				pkt->dst_addr  = (((uint16_t)buf[6]) << 8) | buf[7];
				pkt->dst_port  = (((uint16_t)buf[8]) << 8) | buf[9];
				pkt->data_sum  = (((uint16_t)buf[10]) << 8) | buf[11];
				pkt->data_size = buf[12];
				pkt->ack       = buf[13];
				pkt->seq       = buf[14];
				pkt->hdr_sum   = buf[15];
				if (pkt->data_size > NSP_DATA_SIZE)
				{
					ticalcs_critical("%s: legacy NavNet data size %u exceeds the %u-byte packet buffer", __FUNCTION__, pkt->data_size, NSP_DATA_SIZE);
					ret = ERR_INVALID_PACKET;
					break;
				}

				if (pkt->src_port == 0x00fe || pkt->src_port == 0x00ff || pkt->src_port == 0x00d3)
				{
					handle->priv.nsp_seq_pc++;
				}
				else
				{
					handle->priv.nsp_seq = pkt->seq;
				}

				// Next, follows data
				if (pkt->data_size)
				{
					ret = ticables_cable_recv(handle->cable, pkt->data, pkt->data_size);
					if (ret)
					{
						break;
					}

					if (pkt->data_size >= 128)
					{
						ticables_progress_get(handle->cable, nullptr, nullptr, &handle->updat->rate);
					}
				}

				if (handle->updat->cancel)
				{
					ret = ERR_ABORT;
					break;
				}

				ticalcs_info("   %04x:%04x->%04x:%04x AK=%02x SQ=%02x HC=%02x DC=%04x (%i bytes)",
					     pkt->src_addr, pkt->src_port, pkt->dst_addr, pkt->dst_port,
					     pkt->ack, pkt->seq, pkt->hdr_sum, pkt->data_sum, pkt->data_size);
				if (pkt->data_size)
				{
					hexdump(pkt->data, pkt->data_size);
				}

				break;
			}
		}
	}

	ticalcs_event_fill_header(handle, &event, /* type */ CALC_EVENT_TYPE_AFTER_RECV_NSP_RPKT, /* retval */ ret, /* operation */ CALC_FNCT_LAST);
	ticalcs_event_fill_nsp_rpkt(&event, /* src_addr */ pkt->src_addr, /* src_port */ pkt->src_port, /* dst_addr */ pkt->dst_addr, /* dst_port */ pkt->dst_port,
	                            /* data_sum */ pkt->data_sum, /* data_size */ pkt->data_size, /* ack */ pkt->ack, /* seq */ pkt->seq, /* hdr_sum */ pkt->hdr_sum, /* data */ pkt->data);
	ret = ticalcs_event_send(handle, &event);

	CLEAR_HANDLE_BUSY_IF_NECESSARY(handle);

	return ret;
}

static const char* ep_way(uint8_t ep)
{
	if (ep == 0x01)
	{
		return "TI>PC";
	}
	else if (ep == 0x02)
	{
		return "PC>TI";
	}
	else
	{
		return "XX>XX";
	}
}

int TICALL nsp_dissect(CalcModel model, FILE * f, const uint8_t * data, uint32_t len, uint8_t ep)
{
	const int ret = 0;
	uint32_t i;

	VALIDATE_NONNULL(f);
	VALIDATE_NONNULL(data);

	if (len < NSP_HEADER_SIZE + 1 || len > NSP_HEADER_SIZE + 1 + NSP_DATA_SIZE) // 1 is the cmd byte.
	{
		ticalcs_critical("Length %lu (%lX) is too small or too large for a valid NSP raw packet", (unsigned long)len, (unsigned long)len);
		return ERR_INVALID_PACKET;
	}

	const uint16_t unused = (((uint16_t)data[0]) << 8) | data[1];
	const uint16_t src_addr = (((uint16_t)data[2]) << 8) | data[3];
	const uint16_t src_port = (((uint16_t)data[4]) << 8) | data[5];
	const uint16_t dst_addr = (((uint16_t)data[6]) << 8) | data[7];
	const uint16_t dst_port = (((uint16_t)data[8]) << 8) | data[9];
	const uint16_t data_sum = (((uint16_t)data[10]) << 8) | data[11];
	const uint8_t data_size = data[12];
	const uint8_t ack = data[13];
	const uint8_t seq = data[14];
	const uint8_t hdr_sum = data[15];
	const uint8_t cmd = data[16];

	fprintf(f, "%08lX\t| %s: %04X - %s (%04X - %s) -> %04X - %s (%04X - %s)\n", (unsigned long)len, ep_way(ep),
	           src_addr, nsp_addr2name(src_addr), src_port, nsp_sid2name(src_port),
	           dst_addr, nsp_addr2name(dst_addr), dst_port, nsp_sid2name(dst_port));
	fprintf(f, "\t  unused=%04X ack=%02X seq=%02X header_checksum=%02X data_checksum=%04X (%u bytes)\n",
	           unused, ack, seq, hdr_sum, data_sum, data_size);
	fprintf(f, "\t  cmd=%02X\n", cmd);

	if (data_size > NSP_DATA_SIZE)
	{
		ticalcs_critical("Data size %u (%X) is too large for a valid NSP raw packet", data_size, data_size);
		return ERR_INVALID_PACKET;
	}
	if (len != (uint32_t)data_size + NSP_HEADER_SIZE)
	{
		ticalcs_critical("Data size %u (%X) is incoherent with given NSP raw packet length %lu (%lX)", data_size, data_size, (unsigned long)len, (unsigned long)len);
		return ERR_INVALID_PACKET;
	}

	uint8_t computed_hdr_sum = 0;
	for (i = 0; i < NSP_HEADER_SIZE - 1; i++)
	{
		computed_hdr_sum += data[i];
	}
	const uint16_t computed_data_sum = tifiles_checksum(data, len);
	fprintf(f, "\t  computed_hdr_sum=%02X computed_data_sum=%04X\n", computed_hdr_sum, computed_data_sum);
	if (computed_hdr_sum != hdr_sum || computed_data_sum != data_sum)
	{
	fprintf(f, "\t  (NOTE: header and/or data sum do not match header)\n");
	}

	data += NSP_HEADER_SIZE + 1;
	len -= NSP_HEADER_SIZE + 1;
	fprintf(f, "\t\t");
	for (i = 0; i < len;)
	{
		fprintf(f, "%02X ", *data++);
		if (!(++i & 15))
		{
			fprintf(f, "\n\t\t");
		}
	}
	fputc('\n', f);

	return ret;
}
