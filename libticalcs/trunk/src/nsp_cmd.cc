/* Hey EMACS -*- linux-c -*- */
/* $Id: nsp_cmd.c 2077 2006-03-31 21:16:19Z roms $ */

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
	This unit handles commands and session management thru DirectLink.
*/

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ticalcs.h"
#include "internal.h"
#include "logging.h"
#include "error.h"

#include "nsp_vpkt.h"
#include "nsp_cmd.h"
#include "nsp_nnse.h"

/////////////----------------

static const uint8_t usb_errors[] = {
	0x02, 0x04, 0x07, 0x0a, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x20, 0x80
};

uint8_t ticalcs_nsp_error_code_from_index(unsigned int index)
{
	if (index >= (sizeof(usb_errors) / sizeof(usb_errors[0])))
	{
		return 0;
	}

	return usb_errors[index];
}

unsigned int ticalcs_nsp_error_count(void)
{
	return (unsigned int)(sizeof(usb_errors) / sizeof(usb_errors[0]));
}

static int err_code(uint8_t code)
{
	for (int i = 0; i < (int)(sizeof(usb_errors) / sizeof(usb_errors[0])); i++)
	{
		if (usb_errors[i] == code)
		{
			return i+1;
		}
	}

	ticalcs_warning("Nspire error code 0x%02x not found in list. Please report it at <tilp-devel@lists.sf.net>.", (int)code);

	return 0;
}

int ticalcs_nsp_os_status_result(uint8_t status, uint8_t *progress)
{
	if (status == NSP_ERR_OK)
	{
		*progress = 100;
		return 0;
	}

	*progress = status;
	return ERR_CALC_ERROR3 + err_code(status);
}

/////////////----------------

static int put_str(uint8_t *dst, const char *src)
{
	size_t i, j;
	const size_t len = strlen(src);

	for (i = 0; i < len; i++)
	{
		dst[i] = src[i];
	}
	dst[i++] = '\0';

	if (i < 9)
	{
		for (j = i; j < 9; j++)
		{
			dst[j] = '\0';
		}
	}
	else
	{
		j = i;
	}

	return j;
}

static int copy_vtl_data(const NSPVirtualPacket *pkt, uint32_t *size, uint8_t **data)
{
	if (size)
	{
		*size = pkt->size;
	}

	if (data == nullptr)
	{
		return 0;
	}

	*data = nullptr;
	if (pkt->size == 0)
	{
		return 0;
	}

	*data = (uint8_t *)g_malloc0(pkt->size);
	if (*data == nullptr)
	{
		return ERR_MALLOC;
	}
	memcpy(*data, pkt->data, pkt->size);

	return 0;
}

/////////////----------------

int TICALL nsp_cmd_r_login(CalcHandle *handle)
{
	int retval = 0;

	VALIDATE_HANDLE(handle);

	NSPVirtualPacket* pkt = nsp_vtl_pkt_new(handle);

	ticalcs_info("  receiving login:");

	retval = nsp_recv_data(handle, pkt);

	nsp_vtl_pkt_del(handle, pkt);

	return retval;
}

/////////////----------------

int TICALL nsp_cmd_s_status(CalcHandle *handle, uint8_t status)
{
	int retval = 0;

	VALIDATE_HANDLE(handle);

	NSPVirtualPacket* pkt = nsp_vtl_pkt_new_ex(handle, 1, NSP_SRC_ADDR, handle->priv.nsp_src_port, NSP_DEV_ADDR, handle->priv.nsp_dst_port,
	                                           NSP_CMD_STATUS, (uint8_t*)nsp_vtl_pkt_alloc_data(handle, 1));

	ticalcs_info("  sending status (%04x):", status);

	pkt->data[0] = status;
	retval = nsp_send_data(handle, pkt);

	nsp_vtl_pkt_del(handle, pkt);

	return retval;
}

int TICALL nsp_cmd_r_status(CalcHandle *handle, uint8_t *status)
{
	int retval = 0;

	VALIDATE_HANDLE(handle);

	NSPVirtualPacket* pkt = nsp_vtl_pkt_new(handle);

	ticalcs_info("  receiving status:");

	retval = nsp_recv_data(handle, pkt);
	if (!retval)
	{
		if (pkt->cmd != NSP_CMD_STATUS || pkt->size < 1)
		{
			retval = ERR_INVALID_PACKET;
			goto end;
		}

		const uint8_t value = pkt->data[0];
		if (status)
		{
			*status = value;
		}

		if (value != 0x00)
		{
			retval = ERR_CALC_ERROR3 + err_code(value);
		}
	}

end:
	nsp_vtl_pkt_del(handle, pkt);

	return retval;
}

/////////////----------------

int TICALL nsp_cmd_s_dev_infos(CalcHandle *handle, uint8_t cmd)
{
	int retval = 0;

	VALIDATE_HANDLE(handle);

	ticalcs_info("  requesting device information (cmd = %02x):", cmd);

	NSPVirtualPacket* pkt = nsp_vtl_pkt_new_ex(handle, 0, NSP_SRC_ADDR, handle->priv.nsp_src_port, NSP_DEV_ADDR, NSP_PORT_DEV_INFOS, cmd,
	                                           (uint8_t*)nsp_vtl_pkt_alloc_data(handle, 0));

	retval = nsp_send_data(handle, pkt);

	nsp_vtl_pkt_del(handle, pkt);

	return retval;
}

int TICALL nsp_cmd_r_dev_infos(CalcHandle *handle, uint8_t *cmd, uint32_t *size, uint8_t **data)
{
	int retval = 0;

	VALIDATE_HANDLE(handle);
	VALIDATE_NONNULL(cmd);
	VALIDATE_NONNULL(size);
	VALIDATE_NONNULL(data);

	NSPVirtualPacket* pkt = nsp_vtl_pkt_new(handle);

	ticalcs_info("  receiving device information:");

	retval = nsp_recv_data(handle, pkt);
	if (!retval)
	{
		*cmd = pkt->cmd;
		retval = copy_vtl_data(pkt, size, data);
	}

	nsp_vtl_pkt_del(handle, pkt);

	return retval;
}

/////////////----------------

int TICALL nsp_cmd_s_screen_rle(CalcHandle *handle, uint8_t cmd)
{
	int retval = 0;

	VALIDATE_HANDLE(handle);

	NSPVirtualPacket* pkt = nsp_vtl_pkt_new_ex(handle, 0, NSP_SRC_ADDR, handle->priv.nsp_src_port, NSP_DEV_ADDR, NSP_PORT_SCREEN_RLE, cmd,
	                                           (uint8_t*)nsp_vtl_pkt_alloc_data(handle, 0));

	ticalcs_info("  requesting RLE screenshot (cmd = %02x):", cmd);

	retval = nsp_send_data(handle, pkt);

	nsp_vtl_pkt_del(handle, pkt);

	return retval;
}

int TICALL nsp_cmd_r_screen_rle(CalcHandle *handle, uint8_t *cmd, uint32_t *size, uint8_t **data)
{
	int retval = 0;

	VALIDATE_HANDLE(handle);
	VALIDATE_NONNULL(cmd);
	VALIDATE_NONNULL(size);
	VALIDATE_NONNULL(data);

	NSPVirtualPacket* pkt = nsp_vtl_pkt_new(handle);

	ticalcs_info("  receiving RLE screenshot:");

	pkt->size = *size;
	retval = nsp_recv_data(handle, pkt);
	if (!retval)
	{
		*cmd = pkt->cmd;
		retval = copy_vtl_data(pkt, size, data);
	}

	nsp_vtl_pkt_del(handle, pkt);

	return retval;
}

/////////////----------------

// Live Presenter streams keyframes and deltas on the same NavNet session.
#define NSP_PRESENTER_HEADER_SIZE 12
#define NSP_PRESENTER_MAX_IMAGE_SIZE (NSP_PRESENTER_BITMAP_SIZE * 3 / 2)
#define NSP_PRESENTER_MAX_KEY_DATA_SIZE 4096
#define NSP_PRESENTER_GRAY_SIZE (NSP_PRESENTER_WIDTH * NSP_PRESENTER_HEIGHT / 2)

enum {
	NSP_PRESENTER_KEYS = 0x32,
	NSP_PRESENTER_GRAY_KEYFRAME = 0x33,
	NSP_PRESENTER_GRAY_DELTA = 0x34,
	NSP_PRESENTER_KEYFRAME = 0x41,
	NSP_PRESENTER_DELTA = 0x42,
};

static uint32_t presenter_be32(const uint8_t *data)
{
	return ((uint32_t)data[0] << 24) | ((uint32_t)data[1] << 16)
	     | ((uint32_t)data[2] << 8) | data[3];
}

static uint32_t presenter_le32(const uint8_t *data)
{
	return ((uint32_t)data[3] << 24) | ((uint32_t)data[2] << 16)
	     | ((uint32_t)data[1] << 8) | data[0];
}

static int presenter_decode_color(const uint8_t *data, uint32_t size, uint8_t *bitmap)
{
	if (size % 4)
	{
		return ERR_INVALID_PACKET;
	}

	uint32_t out = 0;
	for (uint32_t pos = 0; pos < size; )
	{
		const uint8_t *word = data + pos;
		pos += 4;
		uint32_t count = 1;
		if (size - pos >= 4 && memcmp(word, data + pos, 4) == 0)
		{
			if (size - pos < 8)
			{
				return ERR_INVALID_PACKET;
			}
			count = presenter_le32(data + pos + 4);
			pos += 8;
			if (count > NSP_PRESENTER_BITMAP_SIZE / 4 - 2)
			{
				return ERR_INVALID_PACKET;
			}
			count += 2;
		}
		if (count > (NSP_PRESENTER_BITMAP_SIZE - out) / 4)
		{
			return ERR_INVALID_PACKET;
		}
		for (uint32_t i = 0; i < count; i++, out += 4)
		{
			memcpy(bitmap + out, word, 4);
		}
	}
	return out == NSP_PRESENTER_BITMAP_SIZE ? 0 : ERR_INVALID_PACKET;
}

static int presenter_decode_gray_rle4(const uint8_t *data, uint32_t size, uint8_t *bitmap)
{
	uint32_t out = 0;
	for (uint32_t pos = 0; size - pos >= 2; )
	{
		const uint8_t run = data[pos++];
		const uint8_t value = data[pos++];
		if (!run && value <= 1)
		{
			if (value == 1)
			{
				// The encoder can pad the stream after the end-of-image marker.
				return out == NSP_PRESENTER_GRAY_SIZE ? 0 : ERR_INVALID_PACKET;
			}
			// The firmware can group multiple display rows between markers.
			continue;
		}

		// Counts are in pixels. Literal runs are padded to an even byte count.
		const uint32_t count = ((run ? run : value) + 1) / 2;
		if (count > NSP_PRESENTER_GRAY_SIZE - out)
		{
			return ERR_INVALID_PACKET;
		}
		if (run)
		{
			memset(bitmap + out, value, count);
		}
		else
		{
			const uint32_t padded = (count + 1) & ~1u;
			if (padded > size - pos)
			{
				return ERR_INVALID_PACKET;
			}
			memcpy(bitmap + out, data + pos, count);
			pos += padded;
		}
		out += count;
	}
	return ERR_INVALID_PACKET;
}

static int presenter_decode_gray_rle2(const uint8_t *data, uint32_t size, uint8_t *bitmap)
{
	uint32_t out = 0;
	for (uint32_t pos = 0; pos < size; )
	{
		const uint8_t value = data[pos++];
		uint32_t count = 1;
		if (pos < size && data[pos] == value)
		{
			if (size - pos < 2)
			{
				return ERR_INVALID_PACKET;
			}
			count = data[pos + 1];
			pos += 2;
			if (count == 0xff)
			{
				if (size - pos < 2)
				{
					return ERR_INVALID_PACKET;
				}
				count = data[pos] | ((uint32_t)data[pos + 1] << 8);
				pos += 2;
			}
			count += 2;
		}
		if (count > NSP_PRESENTER_GRAY_SIZE - out)
		{
			return ERR_INVALID_PACKET;
		}
		memset(bitmap + out, value, count);
		out += count;
	}
	return out == NSP_PRESENTER_GRAY_SIZE ? 0 : ERR_INVALID_PACKET;
}

static uint16_t presenter_gray_pixel(uint8_t shade)
{
	// Match the grayscale screenshot palette: each nibble is an intensity in steps of 16.
	return (shade << 12) | (shade << 7) | (shade << 1);
}

static void presenter_store_gray(uint8_t *dst, uint8_t packed)
{
	const uint16_t left = presenter_gray_pixel(packed >> 4);
	const uint16_t right = presenter_gray_pixel(packed & 0x0f);
	dst[0] = (uint8_t)left;
	dst[1] = (uint8_t)(left >> 8);
	dst[2] = (uint8_t)right;
	dst[3] = (uint8_t)(right >> 8);
}

static int presenter_apply_gray_delta(const uint8_t *image, uint32_t size, NspPresenterFrame *frame)
{
	const uint32_t record_size = 5;
	if (size % record_size)
	{
		return ERR_INVALID_PACKET;
	}
	for (uint32_t pos = 0; pos < size; pos += record_size)
	{
		if (presenter_le32(image + pos) >= NSP_PRESENTER_GRAY_SIZE)
		{
			return ERR_INVALID_PACKET;
		}
	}
	for (uint32_t pos = 0; pos < size; pos += record_size)
	{
		uint8_t *dst = frame->bitmap + presenter_le32(image + pos) * 4;
		uint8_t pixels[4];
		presenter_store_gray(pixels, image[pos + 4]);
		frame->changed |= memcmp(dst, pixels, sizeof(pixels)) != 0;
		memcpy(dst, pixels, sizeof(pixels));
	}
	return 0;
}

static int presenter_apply_gray_rle(uint32_t type, bool delta, const uint8_t *image, uint32_t size, NspPresenterFrame *frame)
{
	uint8_t packed[NSP_PRESENTER_GRAY_SIZE];
	const int ret = type == NSP_PRESENTER_GRAY_KEYFRAME
		? presenter_decode_gray_rle4(image, size, packed)
		: presenter_decode_gray_rle2(image, size, packed);
	if (ret)
	{
		return ret;
	}

	// Expanding the nibble preserves XOR, so apply deltas in RGB565.
	for (uint32_t i = 0; i < sizeof(packed); ++i)
	{
		uint8_t *dst = frame->bitmap + i * 4;
		if (!delta)
		{
			presenter_store_gray(dst, packed[i]);
		}
		else if (packed[i])
		{
			uint8_t pixels[4];
			presenter_store_gray(pixels, packed[i]);
			for (uint32_t j = 0; j < sizeof(pixels); ++j)
			{
				dst[j] ^= pixels[j];
			}
			frame->changed = 1;
		}
	}
	return 0;
}

static int presenter_apply_color(bool delta, const uint8_t *image, uint32_t size, NspPresenterFrame *frame)
{
	uint8_t bitmap[NSP_PRESENTER_BITMAP_SIZE];
	const int ret = presenter_decode_color(image, size, bitmap);
	if (ret)
	{
		return ret;
	}
	if (delta)
	{
		uint8_t changed = 0;
		for (uint32_t i = 0; i < sizeof(bitmap); i++)
		{
			frame->bitmap[i] ^= bitmap[i];
			changed |= bitmap[i];
		}
		frame->changed = changed != 0;
	}
	else
	{
		memcpy(frame->bitmap, bitmap, sizeof(bitmap));
	}
	return 0;
}

static int presenter_apply_image(CalcHandle *handle, uint32_t type, const uint8_t *image, uint32_t size, NspPresenterFrame *frame)
{
	const bool delta = type == NSP_PRESENTER_DELTA || type == NSP_PRESENTER_GRAY_DELTA;
	const bool keyframe = type == NSP_PRESENTER_KEYFRAME || type == NSP_PRESENTER_GRAY_KEYFRAME;
	if (!size)
	{
		// A reply without an image can carry key history alone.
		return keyframe ? ERR_INVALID_PACKET : 0;
	}
	if ((!keyframe && !delta) || (delta && !frame->valid))
	{
		return ERR_INVALID_PACKET;
	}
	if (type == NSP_PRESENTER_GRAY_DELTA)
	{
		return presenter_apply_gray_delta(image, size, frame);
	}

	const bool gray = type == NSP_PRESENTER_GRAY_KEYFRAME
		|| (handle->priv.nsp_screen_depth ? handle->priv.nsp_screen_depth == 4
		    : nsp_is_legacy_handheld(handle->model) && !nsp_is_original_cx(handle->model));
	const int ret = gray ? presenter_apply_gray_rle(type, delta, image, size, frame)
	                     : presenter_apply_color(delta, image, size, frame);
	if (!ret && keyframe)
	{
		frame->valid = frame->changed = 1;
	}
	return ret;
}

// Early firmware sends the image size, a one-byte frame type, the image,
// and a separate length-prefixed key history record (0x32).
static int presenter_read_legacy_frame(CalcHandle *handle, uint32_t image_size, NspPresenterFrame *frame)
{
	if (image_size > NSP_PRESENTER_MAX_IMAGE_SIZE)
	{
		return ERR_INVALID_PACKET;
	}
	uint8_t packet[MAX(NSP_CX_MAX_PAYLOAD, NSP_NNSE_MAX_PAYLOAD)];
	uint32_t received;
	int ret = nsp_session_read(handle, packet, sizeof(packet), &received);
	if (ret || received != 1)
	{
		return ret ? ret : ERR_INVALID_PACKET;
	}
	const uint8_t type = packet[0];
	uint8_t *image = (uint8_t *)g_try_malloc(image_size);
	if (image_size && !image)
	{
		return ERR_MALLOC;
	}
	for (uint32_t offset = 0; !ret && offset < image_size; offset += received)
	{
		ret = nsp_session_read(handle, packet, sizeof(packet), &received);
		if (!ret && (!received || received > image_size - offset))
		{
			ret = ERR_INVALID_PACKET;
		}
		if (!ret)
		{
			memcpy(image + offset, packet, received);
		}
	}

	if (!ret)
	{
		ret = nsp_session_read(handle, packet, sizeof(packet), &received);
		if (!ret)
		{
			ret = received == 4 ? 0 : ERR_INVALID_PACKET;
		}
	}
	if (!ret)
	{
		const uint32_t keys_size = presenter_be32(packet);
		if (keys_size > NSP_PRESENTER_MAX_KEY_DATA_SIZE)
		{
			ret = ERR_INVALID_PACKET;
		}
		else if (keys_size)
		{
			ret = nsp_session_read(handle, packet, sizeof(packet), &received);
			if (!ret && (received != keys_size || packet[0] != NSP_PRESENTER_KEYS))
			{
				ret = ERR_INVALID_PACKET;
			}
		}
	}
	if (!ret)
	{
		ret = presenter_apply_image(handle, type, image, image_size, frame);
	}
	g_free(image);
	return ret;
}

int TICALL nsp_presenter_start(CalcHandle *handle, NspPresenterFrame *frame)
{
	VALIDATE_HANDLE(handle);
	VALIDATE_NONNULL(frame);

	frame->valid = 0;
	frame->changed = 0;
	const int ret = nsp_enable_extended_payloads(handle);
	return ret ? ret : nsp_session_open(handle, NSP_PORT_PRESENTATION);
}

int TICALL nsp_presenter_next(CalcHandle *handle, NspPresenterFrame *frame)
{
	VALIDATE_HANDLE(handle);
	VALIDATE_NONNULL(frame);
	frame->changed = 0;
	if (handle->priv.nsp_dst_port != NSP_PORT_PRESENTATION)
	{
		return ERR_NOT_READY;
	}

	const uint8_t request[] = {0x04, 0x00, 0x32, 0x0a};
	int ret = nsp_session_write(handle, request, sizeof(request));
	if (ret)
	{
		return ret;
	}

	uint8_t packet[MAX(NSP_CX_MAX_PAYLOAD, NSP_NNSE_MAX_PAYLOAD)];
	uint32_t received;
	ret = nsp_session_read(handle, packet, sizeof(packet), &received);
	if (ret)
	{
		return ret;
	}
	if (received == 4 && !nsp_nnse_enabled(handle))
	{
		return presenter_read_legacy_frame(handle, presenter_be32(packet), frame);
	}
	if (received < NSP_PRESENTER_HEADER_SIZE)
	{
		return ERR_INVALID_PACKET;
	}

	const uint32_t type = presenter_be32(packet);
	const uint32_t image_size = presenter_be32(packet + 4);
	const uint32_t keys_size = presenter_be32(packet + 8);
	if (image_size > NSP_PRESENTER_MAX_IMAGE_SIZE || keys_size > NSP_PRESENTER_MAX_KEY_DATA_SIZE)
	{
		return ERR_INVALID_PACKET;
	}

	// The image and optional key history can share packets. Drain the latter
	// so the next request starts on a frame header.
	const uint32_t payload_size = image_size + keys_size;
	uint8_t *image = (uint8_t *)g_try_malloc(image_size);
	if (image_size && !image)
	{
		return ERR_MALLOC;
	}

	uint32_t offset = 0;
	uint32_t header_size = NSP_PRESENTER_HEADER_SIZE;

	for (;;)
	{
		const uint32_t chunk_size = received - header_size;
		if (chunk_size > payload_size - offset)
		{
			ret = ERR_INVALID_PACKET;
			goto cleanup;
		}
		if (offset < image_size)
		{
			memcpy(image + offset, packet + header_size, MIN(chunk_size, image_size - offset));
		}
		offset += chunk_size;
		if (offset == payload_size)
		{
			break;
		}
		ret = nsp_session_read(handle, packet, sizeof(packet), &received);
		if (ret || !received)
		{
			ret = ret ? ret : ERR_INVALID_PACKET;
			goto cleanup;
		}
		header_size = 0;
	}

	ret = presenter_apply_image(handle, type, image, image_size, frame);

cleanup:
	g_free(image);
	return ret;
}

int TICALL nsp_presenter_stop(CalcHandle *handle)
{
	VALIDATE_HANDLE(handle);
	if (handle->priv.nsp_dst_port != NSP_PORT_PRESENTATION)
	{
		return 0;
	}

	int ret = nsp_session_close(handle);
	if (!ret)
	{
		// The desktop software sends cleanup on a fresh presentation session.
		nsp_session_open(handle, NSP_PORT_PRESENTATION);
		const uint8_t request[] = {0x36, 0x00, 0x32, 0x0a};
		ret = nsp_session_write(handle, request, sizeof(request));
		const int close_ret = nsp_session_close(handle);
		if (!ret)
		{
			ret = close_ret;
		}
	}
	return nsp_restore_standard_payloads(handle, ret);
}

/////////////----------------

int TICALL nsp_cmd_s_dir_attributes(CalcHandle *handle, const char *name)
{
	int retval = 0;

	VALIDATE_HANDLE(handle);
	VALIDATE_NONNULL(name);

	const size_t len = strlen(name) < 8 ? 8 : strlen(name);
	NSPVirtualPacket* pkt = nsp_vtl_pkt_new_ex(handle, 1 + len + 1, NSP_SRC_ADDR, handle->priv.nsp_src_port, NSP_DEV_ADDR, NSP_PORT_FILE_MGMT,
	                                           NSP_CMD_FM_ATTRIBUTES, (uint8_t*)nsp_vtl_pkt_alloc_data(handle, 1 + len + 1));

	ticalcs_info("  unknown directory list command in <%s>:", name);

	pkt->data[0] = 0x01;
	put_str(pkt->data + 1, name);

	retval = nsp_send_data(handle, pkt);

	nsp_vtl_pkt_del(handle, pkt);

	return retval;
}

int TICALL nsp_cmd_r_dir_attributes(CalcHandle *handle, uint32_t *size, uint8_t *type, uint32_t *date)
{
	int retval = 0;

	VALIDATE_HANDLE(handle);

	NSPVirtualPacket* pkt = nsp_vtl_pkt_new(handle);

	ticalcs_info("  unknown directory list command reply received:");

	retval = nsp_recv_data(handle, pkt);
	if (!retval)
	{
		if (pkt->cmd != NSP_CMD_FM_ATTRIBUTES)
		{
			retval = pkt->size >= 1 ? ERR_CALC_ERROR3 + err_code(pkt->data[0]) : ERR_INVALID_PACKET;
			goto end;
		}
		if (pkt->size < 9)
		{
			retval = ERR_INVALID_PACKET;
			goto end;
		}

		if (size)
		{
			*size = (  (((uint32_t)pkt->data[0]) << 24)
			         | (((uint32_t)pkt->data[1]) << 16)
			         | (((uint32_t)pkt->data[2]) <<  8)
			         | (((uint32_t)pkt->data[3])      ));
		}
		if (date)
		{
			*date = (  (((uint32_t)pkt->data[4]) << 24)
			         | (((uint32_t)pkt->data[5]) << 16)
			         | (((uint32_t)pkt->data[6]) <<  8)
			         | (((uint32_t)pkt->data[7])      ));
		}
		if (type)
		{
			*type = *(pkt->data + 8);
		}
	}

end:
	nsp_vtl_pkt_del(handle, pkt);

	return retval;
}

int TICALL nsp_cmd_s_dir_enum_init(CalcHandle *handle, const char *name)
{
	int retval = 0;

	VALIDATE_HANDLE(handle);
	VALIDATE_NONNULL(name);

	const size_t len = strlen(name) < 8 ? 8 : strlen(name);

	NSPVirtualPacket* pkt = nsp_vtl_pkt_new_ex(handle, len + 1, NSP_SRC_ADDR, handle->priv.nsp_src_port, NSP_DEV_ADDR, NSP_PORT_FILE_MGMT,
	                                           NSP_CMD_FM_DIRLIST_INIT, (uint8_t*)nsp_vtl_pkt_alloc_data(handle, len + 1));

	ticalcs_info("  initiating directory listing in <%s>:", name);

	put_str(pkt->data, name);

	retval = nsp_send_data(handle, pkt);

	nsp_vtl_pkt_del(handle, pkt);

	return retval;
}

int TICALL nsp_cmd_r_dir_enum_init(CalcHandle *handle)
{
	return nsp_cmd_r_status(handle, nullptr);
}

int TICALL nsp_cmd_s_dir_enum_next(CalcHandle *handle)
{
	int retval = 0;

	VALIDATE_HANDLE(handle);

	NSPVirtualPacket* pkt = nsp_vtl_pkt_new_ex(handle, 0, NSP_SRC_ADDR, handle->priv.nsp_src_port, NSP_DEV_ADDR, NSP_PORT_FILE_MGMT,
	                                           NSP_CMD_FM_DIRLIST_NEXT, (uint8_t*)nsp_vtl_pkt_alloc_data(handle, 0));
	if (pkt != nullptr)
	{
		ticalcs_info("  requesting next directory entry:");

		retval = nsp_send_data(handle, pkt);

		nsp_vtl_pkt_del(handle, pkt);
	}
	else
	{
		retval = ERR_MALLOC;
	}

	return retval;
}

int TICALL nsp_cmd_r_dir_enum_next(CalcHandle *handle, char* name, uint32_t *size, uint8_t *type)
{
	//uint32_t date;
	int retval = 0;

	VALIDATE_HANDLE(handle);
	VALIDATE_NONNULL(name);

	NSPVirtualPacket* pkt = nsp_vtl_pkt_new(handle);

	ticalcs_info("  next directory entry:");

	retval = nsp_recv_data(handle, pkt);
	if (!retval)
	{
		if (pkt->cmd != NSP_CMD_FM_DIRLIST_ENT)
		{
			if (pkt->size < 1)
			{
				retval = ERR_INVALID_PACKET;
				goto end;
			}
			if (pkt->data[0] == NSP_ERR_NO_MORE_TO_LIST)
			{
				retval = ERR_EOT;
				goto end;
			}
			else
			{
				retval = ERR_CALC_ERROR3 + err_code(pkt->data[0]);
				goto end;
			}
		}

		if (pkt->size < 12)
		{
			retval = ERR_INVALID_PACKET;
			goto end;
		}
		const size_t data_size = (size_t)pkt->data[1] + 2;
		if (data_size < 12 || data_size > pkt->size)
		{
			retval = ERR_INVALID_PACKET;
			goto end;
		}
		const size_t o = data_size - 10;
		const size_t name_size = o - 2;
		if (name_size >= VARNAME_MAX)
		{
			retval = ERR_INVALID_PACKET;
			goto end;
		}
		ticalcs_strlcpy(name, (char *)pkt->data + 2, name_size + 1);

		if (size)
		{
			*size = (  (((uint32_t)pkt->data[o    ]) << 24)
			         | (((uint32_t)pkt->data[o + 1]) << 16)
			         | (((uint32_t)pkt->data[o + 2]) <<  8)
			         | (((uint32_t)pkt->data[o + 3])      ));
		}
		if (type)
		{
			*type = pkt->data[o + 8];
		}
	}

end:
	nsp_vtl_pkt_del(handle, pkt);

	return retval;
}

int TICALL nsp_cmd_s_dir_enum_done(CalcHandle *handle)
{
	int retval = 0;

	VALIDATE_HANDLE(handle);

	NSPVirtualPacket* pkt = nsp_vtl_pkt_new_ex(handle, 0, NSP_SRC_ADDR, handle->priv.nsp_src_port, NSP_DEV_ADDR, NSP_PORT_FILE_MGMT,
	                                           NSP_CMD_FM_DIRLIST_DONE, (uint8_t*)nsp_vtl_pkt_alloc_data(handle, 0));

	ticalcs_info("  closing directory listing:");

	retval = nsp_send_data(handle, pkt);

	nsp_vtl_pkt_del(handle, pkt);

	return retval;
}

int TICALL nsp_cmd_r_dir_enum_done(CalcHandle *handle)
{
	return nsp_cmd_r_status(handle, nullptr);
}

/////////////----------------

int TICALL nsp_cmd_s_put_file(CalcHandle *handle, const char *name, uint32_t size)
{
	int retval = 0;

	VALIDATE_HANDLE(handle);
	VALIDATE_NONNULL(name);

	const size_t len = strlen(name) < 8 ? 8 : strlen(name);
	NSPVirtualPacket* pkt = nsp_vtl_pkt_new_ex(handle, 6 + len, NSP_SRC_ADDR, handle->priv.nsp_src_port, NSP_DEV_ADDR, NSP_PORT_FILE_MGMT,
	                                           NSP_CMD_FM_PUT_FILE, (uint8_t*)nsp_vtl_pkt_alloc_data(handle, 6 + len));

	ticalcs_info("  sending variable:");

	pkt->data[0] = 0x01;
	int o = put_str(pkt->data + 1, name);
	o++;

	pkt->data[o+0] = MSB(MSW(size));
	pkt->data[o+1] = LSB(MSW(size));
	pkt->data[o+2] = MSB(LSW(size));
	pkt->data[o+3] = LSB(LSW(size));

	retval = nsp_send_data(handle, pkt);

	nsp_vtl_pkt_del(handle, pkt);

	return retval;
}

int TICALL nsp_cmd_r_put_file(CalcHandle *handle)
{
	return nsp_cmd_r_file_ok(handle);
}

int TICALL nsp_cmd_s_put_file_eot(CalcHandle *handle)
{
	int retval = 0;

	VALIDATE_HANDLE(handle);

	NSPVirtualPacket* pkt = nsp_vtl_pkt_new_ex(handle, 2, NSP_SRC_ADDR, handle->priv.nsp_src_port, NSP_DEV_ADDR, NSP_PORT_FILE_MGMT,
	                                           NSP_CMD_FM_PUT_FILE_EOT, (uint8_t*)nsp_vtl_pkt_alloc_data(handle, 2));

	ticalcs_info("  sending EOT:");

	pkt->data[0] = 0x01;

	retval = nsp_send_data(handle, pkt);

	nsp_vtl_pkt_del(handle, pkt);

	return retval;
}

// No nsp_cmd_r_put_file_eot because the calculator doesn't seem to reply to CMD_FM_PUT_FILE_EOT.

int TICALL nsp_cmd_s_get_file(CalcHandle *handle, const char *name)
{
	int retval = 0;

	VALIDATE_HANDLE(handle);
	VALIDATE_NONNULL(name);

	const size_t len = strlen(name) < 8 ? 8 : strlen(name);

	ticalcs_info("  requesting variable:");

	NSPVirtualPacket* pkt = nsp_vtl_pkt_new_ex(handle, 2 + len, NSP_SRC_ADDR, handle->priv.nsp_src_port, NSP_DEV_ADDR, NSP_PORT_FILE_MGMT,
	                                           NSP_CMD_FM_GET_FILE, (uint8_t*)nsp_vtl_pkt_alloc_data(handle, 2 + len));
	pkt->data[0] = 0x01;
	put_str(pkt->data + 1, name);

	retval = nsp_send_data(handle, pkt);

	nsp_vtl_pkt_del(handle, pkt);

	return retval;
}

int TICALL nsp_cmd_r_get_file(CalcHandle *handle, uint32_t *size)
{
	int retval = 0;

	VALIDATE_HANDLE(handle);

	NSPVirtualPacket* pkt = nsp_vtl_pkt_new(handle);

	ticalcs_info("  file size:");

	retval = nsp_recv_data(handle, pkt);

	if (!retval)
	{
		if (pkt->cmd == NSP_CMD_STATUS)
		{
			retval = pkt->size >= 1 ? ERR_CALC_ERROR3 + err_code(pkt->data[0]) : ERR_INVALID_PACKET;
			goto end;
		}

		if (pkt->cmd != NSP_CMD_FM_PUT_FILE || pkt->size < 14)
		{
			retval = ERR_INVALID_PACKET;
			goto end;
		}

		if (size)
		{
			*size = (  (((uint32_t)pkt->data[10]) << 24)
			         | (((uint32_t)pkt->data[11]) << 16)
			         | (((uint32_t)pkt->data[12]) <<  8)
			         | (((uint32_t)pkt->data[13])      ));
		}
	}

end:
	nsp_vtl_pkt_del(handle, pkt);

	return retval;
}

int TICALL nsp_cmd_s_del_file(CalcHandle *handle, const char *name)
{
	int retval = 0;

	VALIDATE_HANDLE(handle);
	VALIDATE_NONNULL(name);

	const size_t len = strlen(name) < 8 ? 8 : strlen(name);
	NSPVirtualPacket* pkt = nsp_vtl_pkt_new_ex(handle, 2 + len, NSP_SRC_ADDR, handle->priv.nsp_src_port, NSP_DEV_ADDR, NSP_PORT_FILE_MGMT,
	                                           NSP_CMD_FM_DEL_FILE, (uint8_t*)nsp_vtl_pkt_alloc_data(handle, 2 + len));

	ticalcs_info("  deleting variable:");

	pkt->data[0] = 0x01;
	put_str(pkt->data + 1, name);

	retval = nsp_send_data(handle, pkt);

	nsp_vtl_pkt_del(handle, pkt);

	return retval;
}

int TICALL nsp_cmd_r_del_file(CalcHandle *handle)
{
	return nsp_cmd_r_status(handle, nullptr);
}

int TICALL nsp_cmd_s_new_folder(CalcHandle *handle, const char *name)
{
	int retval = 0;

	VALIDATE_HANDLE(handle);
	VALIDATE_NONNULL(name);

	const size_t len = strlen(name) < 8 ? 8 : strlen(name);

	NSPVirtualPacket* pkt = nsp_vtl_pkt_new_ex(handle, 2 + len, NSP_SRC_ADDR, handle->priv.nsp_src_port, NSP_DEV_ADDR, NSP_PORT_FILE_MGMT,
	                                           NSP_CMD_FM_NEW_FOLDER, (uint8_t*)nsp_vtl_pkt_alloc_data(handle, 2 + len));

	ticalcs_info("  creating folder:");

	pkt->data[0] = 0x03;
	put_str(pkt->data + 1, name);

	retval = nsp_send_data(handle, pkt);

	nsp_vtl_pkt_del(handle, pkt);

	return retval;
}

int TICALL nsp_cmd_r_new_folder(CalcHandle *handle)
{
	return nsp_cmd_r_status(handle, nullptr);
}

int TICALL nsp_cmd_s_del_folder(CalcHandle *handle, const char *name)
{
	int retval = 0;

	VALIDATE_HANDLE(handle);
	VALIDATE_NONNULL(name);

	const size_t len = strlen(name) < 8 ? 8 : strlen(name);

	NSPVirtualPacket* pkt = nsp_vtl_pkt_new_ex(handle, 2 + len, NSP_SRC_ADDR, handle->priv.nsp_src_port, NSP_DEV_ADDR, NSP_PORT_FILE_MGMT,
	                                           NSP_CMD_FM_DEL_FOLDER, (uint8_t*)nsp_vtl_pkt_alloc_data(handle, 2 + len));

	ticalcs_info("  deleting folder:");

	pkt->data[0] = 0x03;
	put_str(pkt->data + 1, name);

	retval = nsp_send_data(handle, pkt);

	nsp_vtl_pkt_del(handle, pkt);

	return retval;
}

int TICALL nsp_cmd_r_del_folder(CalcHandle *handle)
{
	return nsp_cmd_r_status(handle, nullptr);
}

int TICALL nsp_cmd_s_copy_file(CalcHandle *handle, const char *name, const char *name2)
{
	int retval = 0;

	VALIDATE_HANDLE(handle);
	VALIDATE_NONNULL(name);
	VALIDATE_NONNULL(name2);

	const size_t len = strlen(name) < 8 ? 8 : strlen(name);
	const size_t len2 = strlen(name2) < 8 ? 8 : strlen(name2);

	NSPVirtualPacket* pkt = nsp_vtl_pkt_new_ex(handle, 3 + len + len2, NSP_SRC_ADDR, handle->priv.nsp_src_port, NSP_DEV_ADDR, NSP_PORT_FILE_MGMT,
	                                           NSP_CMD_FM_COPY_FILE, (uint8_t*)nsp_vtl_pkt_alloc_data(handle, 3 + len + len2));

	ticalcs_info("  copying file:");

	pkt->data[0] = 0x01;
	put_str(pkt->data + 1, name);
	put_str(pkt->data + 2 + len, name2);

	retval = nsp_send_data(handle, pkt);

	nsp_vtl_pkt_del(handle, pkt);

	return retval;
}

int TICALL nsp_cmd_r_copy_file(CalcHandle *handle)
{
	return nsp_cmd_r_status(handle, nullptr);
}

int TICALL nsp_cmd_s_rename_file(CalcHandle *handle, const char *name, const char *name2)
{
	int retval = 0;

	VALIDATE_HANDLE(handle);
	VALIDATE_NONNULL(name);
	VALIDATE_NONNULL(name2);

	const size_t len = strlen(name) < 8 ? 8 : strlen(name);
	const size_t len2 = strlen(name2) < 8 ? 8 : strlen(name2);

	ticalcs_info("  renaming file:");

	NSPVirtualPacket* pkt = nsp_vtl_pkt_new_ex(handle, 3 + len + len2, NSP_SRC_ADDR, handle->priv.nsp_src_port, NSP_DEV_ADDR, NSP_PORT_FILE_MGMT,
	                                           NSP_CMD_FM_RENAME_FILE, (uint8_t*)nsp_vtl_pkt_alloc_data(handle, 3 + len + len2));
	pkt->data[0] = 0x01;
	put_str(pkt->data + 1, name);
	put_str(pkt->data + 2 + len, name2);

	retval = nsp_send_data(handle, pkt);

	nsp_vtl_pkt_del(handle, pkt);

	return retval;
}

int TICALL nsp_cmd_r_rename_file(CalcHandle *handle)
{
	return nsp_cmd_r_status(handle, nullptr);
}

int TICALL nsp_cmd_s_file_ok(CalcHandle *handle)
{
	int retval = 0;

	VALIDATE_HANDLE(handle);

	NSPVirtualPacket* pkt = nsp_vtl_pkt_new_ex(handle, 0, NSP_SRC_ADDR, handle->priv.nsp_src_port, NSP_DEV_ADDR, NSP_PORT_FILE_MGMT,
	                                           NSP_CMD_FM_OK, (uint8_t*)nsp_vtl_pkt_alloc_data(handle, 0));

	ticalcs_info("  sending file contents:");

	retval = nsp_send_data(handle, pkt);

	nsp_vtl_pkt_del(handle, pkt);

	return retval;
}

int TICALL nsp_cmd_r_file_ok(CalcHandle *handle)
{
	int retval = 0;

	VALIDATE_HANDLE(handle);

	NSPVirtualPacket* pkt = nsp_vtl_pkt_new(handle);

	ticalcs_info("  file status:");

	retval = nsp_recv_data(handle, pkt);
	if (!retval)
	{
		if (pkt->cmd != NSP_CMD_FM_OK)
		{
			if (pkt->cmd == NSP_CMD_STATUS && pkt->size >= 1)
			{
				retval = ERR_CALC_ERROR3 + err_code(pkt->data[0]);
			}
			else
			{
				retval = ERR_INVALID_PACKET;
			}
		}
		else
		{
			ticalcs_info("  ok");
		}
	}

	nsp_vtl_pkt_del(handle, pkt);

	return retval;
}

int TICALL nsp_cmd_s_file_contents(CalcHandle *handle, uint32_t size, uint8_t *data)
{
	int retval = 0;

	VALIDATE_HANDLE(handle);
	VALIDATE_NONNULL(data);

	NSPVirtualPacket* pkt = nsp_vtl_pkt_new_ex(handle, size, NSP_SRC_ADDR, handle->priv.nsp_src_port, NSP_DEV_ADDR, NSP_PORT_FILE_MGMT,
	                                           NSP_CMD_FM_CONTENTS, (uint8_t*)nsp_vtl_pkt_alloc_data(handle, size));

	ticalcs_info("  sending file contents:");

	memcpy(pkt->data, data, size);
	retval = nsp_send_data(handle, pkt);

	nsp_vtl_pkt_del(handle, pkt);

	return retval;
}

int TICALL nsp_cmd_r_file_contents(CalcHandle *handle, uint32_t *size, uint8_t **data)
{
	int retval = 0;

	VALIDATE_HANDLE(handle);
	VALIDATE_NONNULL(size);
	VALIDATE_NONNULL(data);

	NSPVirtualPacket* pkt = nsp_vtl_pkt_new(handle);

	ticalcs_info("  receiving file contents:");

	pkt->size = *size;
	retval = nsp_recv_data(handle, pkt);

	if (!retval)
	{
		const uint32_t expected_size = *size;
		if (pkt->cmd == NSP_CMD_STATUS)
		{
			retval = pkt->size >= 1 ? ERR_CALC_ERROR3 + err_code(pkt->data[0]) : ERR_INVALID_PACKET;
		}
		else if (pkt->cmd != NSP_CMD_FM_CONTENTS || pkt->size != expected_size)
		{
			retval = ERR_INVALID_PACKET;
		}
		else
		{
			retval = copy_vtl_data(pkt, size, data);
		}
	}

	nsp_vtl_pkt_del(handle, pkt);

	return retval;
}

/////////////----------------

int TICALL nsp_cmd_s_os_install(CalcHandle *handle, uint32_t size)
{
	int retval = 0;

	VALIDATE_HANDLE(handle);

	NSPVirtualPacket* pkt = nsp_vtl_pkt_new_ex(handle, 4, NSP_SRC_ADDR, handle->priv.nsp_src_port, NSP_DEV_ADDR, NSP_PORT_OS_INSTALL,
	                                           NSP_CMD_OS_INSTALL, (uint8_t*)nsp_vtl_pkt_alloc_data(handle, 4));

	ticalcs_info("  installing OS:");

	pkt->data[0] = MSB(MSW(size));
	pkt->data[1] = LSB(MSW(size));
	pkt->data[2] = MSB(LSW(size));
	pkt->data[3] = LSB(LSW(size));
	retval = nsp_send_data(handle, pkt);

	nsp_vtl_pkt_del(handle, pkt);

	return retval;
}

int TICALL nsp_cmd_r_os_install(CalcHandle *handle)
{
	int retval = 0;

	VALIDATE_HANDLE(handle);

	NSPVirtualPacket* pkt = nsp_vtl_pkt_new(handle);

	ticalcs_info("  receiving OS installation:");

	retval = nsp_recv_data(handle, pkt);

	if (!retval)
	{
		if (pkt->cmd != NSP_CMD_OS_OK)
		{
			retval = ERR_INVALID_PACKET;
		}
	}

	nsp_vtl_pkt_del(handle, pkt);

	return retval;
}

int TICALL nsp_cmd_s_os_contents(CalcHandle *handle, uint32_t size, uint8_t *data)
{
	int retval = 0;

	VALIDATE_HANDLE(handle);
	VALIDATE_NONNULL(data);

	NSPVirtualPacket* pkt = nsp_vtl_pkt_new_ex(handle, size, NSP_SRC_ADDR, handle->priv.nsp_src_port, NSP_DEV_ADDR, NSP_PORT_OS_INSTALL,
	                                           NSP_CMD_OS_CONTENTS, (uint8_t*)nsp_vtl_pkt_alloc_data(handle, size));

	ticalcs_info("  sending OS contents:");

	memcpy(pkt->data, data, size);
	retval = nsp_send_data(handle, pkt);

	nsp_vtl_pkt_del(handle, pkt);

	return retval;
}

int TICALL nsp_cmd_r_progress(CalcHandle *handle, uint8_t *value)
{
	int retval = 0;

	VALIDATE_HANDLE(handle);
	VALIDATE_NONNULL(value);

	NSPVirtualPacket* pkt = nsp_vtl_pkt_new(handle);

	ticalcs_info("  OS installation status:");

	for (;;)
	{
		retval = nsp_recv_data(handle, pkt);
		if (retval)
		{
			break;
		}

		switch(pkt->cmd)
		{
		case NSP_CMD_OS_PROGRESS:
			if (pkt->size < 1)
			{
				retval = ERR_INVALID_PACKET;
				goto end;
			}
			*value = pkt->data[0];
			ticalcs_info("  %i/100", *value);
			goto end;
		case NSP_CMD_STATUS:
			if (pkt->size < 1)
			{
				retval = ERR_INVALID_PACKET;
			}
			else
			{
				retval = ticalcs_nsp_os_status_result(pkt->data[0], value);
				if (!retval)
				{
					ticalcs_info("  OS status OK, assuming 100/100");
				}
			}
			goto end;
		default:
			if (pkt->cmd == NSP_CMD_OS_OK)
			{
				*value = 100;
				ticalcs_info("  OS OK received, assuming 100/100");
				goto end;
			}
			if (pkt->src_port == NSP_PORT_PKT_ACK2)
			{
				// Ignore stray acks during progress polling.
				continue;
			}
			retval = ERR_INVALID_PACKET;
			goto end;
		}
	}

end:
	nsp_vtl_pkt_del(handle, pkt);

	return retval;
}

/////////////----------------

int TICALL nsp_cmd_s_generic_data(CalcHandle *handle, uint32_t size, const uint8_t *data, uint16_t sid, uint8_t cmd)
{
	int retval = 0;

	VALIDATE_HANDLE(handle);

	ticalcs_info("  sending generic data of size %lu (%lX) with command %02X:", (unsigned long)size, (unsigned long)size, cmd);

	NSPVirtualPacket* pkt = nsp_vtl_pkt_new_ex(handle, size, NSP_SRC_ADDR, handle->priv.nsp_src_port, NSP_DEV_ADDR, sid, cmd,
	                                           (uint8_t*)nsp_vtl_pkt_alloc_data(handle, size));

	if (data)
	{
		memcpy(pkt->data, data, size);
	}
	retval = nsp_send_data(handle, pkt);

	nsp_vtl_pkt_del(handle, pkt);

	return retval;
}

int TICALL nsp_cmd_r_generic_data(CalcHandle *handle, uint32_t *size, uint8_t **data)
{
	int retval = 0;

	VALIDATE_HANDLE(handle);

	NSPVirtualPacket* pkt = nsp_vtl_pkt_new(handle);

	ticalcs_info("  receiving generic data:");

	retval = nsp_recv_data(handle, pkt);
	if (!retval)
	{
		retval = copy_vtl_data(pkt, size, data);
	}

	nsp_vtl_pkt_del(handle, pkt);

	return retval;
}

/////////////----------------

int TICALL nsp_cmd_s_echo(CalcHandle *handle, uint32_t size, const uint8_t *data)
{
	ticalcs_info("  sending echo:");
	return nsp_cmd_s_generic_data(handle, size, data, NSP_PORT_ECHO, 0);
}

int TICALL nsp_cmd_r_echo(CalcHandle *handle, uint32_t *size, uint8_t **data)
{
	ticalcs_info("  receiving echo:");
	return nsp_cmd_r_generic_data(handle, size, data);
}

/////////////----------------

int TICALL nsp_cmd_s_key(CalcHandle *handle, uint32_t code)
{
	int retval = 0;

	VALIDATE_HANDLE(handle);

	ticalcs_info("  sending key:");

	retval = nsp_session_open(handle, NSP_SID_KEYPRESSES);
	if (!retval)
	{
		NSPVirtualPacket* pkt1 = nsp_vtl_pkt_new_ex(handle, 3, NSP_SRC_ADDR, handle->priv.nsp_src_port, NSP_DEV_ADDR, NSP_PORT_KEYPRESSES, 0x01,
		                                            (uint8_t*)nsp_vtl_pkt_alloc_data(handle, 3));

		pkt1->data[2] = 0x80;
		retval = nsp_send_data(handle, pkt1);

		if (!retval)
		{
			NSPVirtualPacket* pkt2 = nsp_vtl_pkt_new_ex(handle, 25, NSP_SRC_ADDR, handle->priv.nsp_src_port, NSP_DEV_ADDR, NSP_PORT_KEYPRESSES, 0,
			                                            (uint8_t*)nsp_vtl_pkt_alloc_data(handle, 25));

			pkt2->data[3] = 0x08;
			pkt2->data[4] = 0x02;
			pkt2->data[5] = (uint8_t)(code >> 16);
			pkt2->data[7] = (uint8_t)(code >>  8);
			pkt2->data[23] = (uint8_t)(code & 0xFF);

			retval = nsp_send_data(handle, pkt2);

			nsp_vtl_pkt_del(handle, pkt2);
		}

		nsp_vtl_pkt_del(handle, pkt1);

		if (!retval)
		{
			retval = nsp_session_close(handle);
		}
	}

	return retval;
}

int TICALL nsp_cmd_s_keypress_event(CalcHandle *handle, const uint8_t keycode[3])
{
	VALIDATE_HANDLE(handle);
	VALIDATE_NONNULL(keycode);

	const uint32_t key = ((uint32_t)(keycode[0]) << 16) | ((uint32_t)(keycode[1]) << 8) | (uint32_t)(keycode[2]);
	return nsp_cmd_s_key(handle, key);
}

// There doesn't seem to be a need for cmd_r_key / cmd_r_keypress_event.
