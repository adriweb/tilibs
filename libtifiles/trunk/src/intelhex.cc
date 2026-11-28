/* Hey EMACS -*- linux-c -*- */
/* $Id$ */

/*  libtifiles - file format library, a part of the TiLP project
 *  Copyright (C) 1999-2005  Romain Lievin
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
	IntelHex format reader/writer for TI8X FLASH calculators.
*/

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <stdint.h>
#include "macros.h"
#include "intelhex.h"
#include "export2.h"
#include "logging.h"

/* Constants */

#define HEX_DATA        0x00     // data packet
#define HEX_END         0x01     // end of section (1 for app, 3 for OS)
#define HEX_PAGE        0x02     // page change
#define HEX_EOF         0x03     // end of file (custom)

#define PKT_MAX         32       // 32 bytes max
#define BLK_MAX         16384    // 16KB max


static int hex_digit(int c)
{
	if (c >= '0' && c <= '9') return c - '0';
	if (c >= 'A' && c <= 'F') return c - 'A' + 10;
	if (c >= 'a' && c <= 'f') return c - 'a' + 10;
	return -1;
}

/* Read exactly two hexadecimal characters without letting scanf() skip across
   a declared TIFL payload boundary. */
static int read_byte(FILE *f, uint8_t *value)
{
	const int high = hex_digit(fgetc(f));
	const int low = hex_digit(fgetc(f));
	if (high < 0 || low < 0)
	{
		return -1;
	}
	*value = (uint8_t)((high << 4) | low);
	return 0;
}

/*
	hex_packet_read:
	@f : file descriptor
	@size : size of packet (field #1)
	@addr : addr of packet (field #2)
	@type : type of packet (field #3)
	@data : data of packet (field after #3), 32 bytes max

	Read an IntelHexa block from FLASH file like these:
	- ': 10 0000 00 FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF 00 CR/LF'
	- ': 00 0000 01 FF'
	- ': 02 0000 02 0000 FC'

	Returns : 0 if success, a negative value otherwise.
*/
static int hex_packet_read(FILE *f, long end_offset, uint8_t *size, uint16_t *addr, uint8_t *type, uint8_t *data)
{
	uint8_t sum = 0;
	long pos = ftell(f);
	if (pos < 0)
	{
		return -4;
	}
	if (pos >= end_offset)
	{
		*size = 0;
		*addr = 0;
		*type = HEX_EOF;
		return 0;
	}
	if (end_offset - pos < 3)
	{
		return -1;
	}
	int c = fgetc(f);
	if (c != ':')
	{
		return -1;
	}

	if (read_byte(f, size) < 0)
	{
		return -1;
	}
	pos = ftell(f);
	if (pos < 0 || *size > PKT_MAX || end_offset - pos < 8 + 2 * (long)*size)
	{
		return -2;
	}

	uint8_t byte;
	if (read_byte(f, &byte) < 0) return -1;
	uint16_t localaddr = ((uint16_t)byte) << 8;
	if (read_byte(f, &byte) < 0) return -1;
	localaddr |= byte;
	*addr = localaddr;
	if (read_byte(f, type) < 0) return -1;

	sum = *size + MSB(*addr) + LSB(*addr) + *type;

	for (int i = 0; i < *size; i++) 
	{
		if (read_byte(f, &data[i]) < 0) return -1;
		sum += data[i];
	}

	uint8_t checksum;
	if (read_byte(f, &checksum) < 0) return -1;
	if (LSB(sum + checksum))
	{
		return -3;
	}

	/* Consume a line ending when it is part of this payload. Do not probe the
	   first byte of the following TIFL member to determine EOF. */
	pos = ftell(f);
	if (pos < 0)
	{
		return -4;
	}
	if (pos < end_offset)
	{
		c = fgetc(f);
		if (c == '\r')
		{
			const long after_cr = ftell(f);
			if (after_cr < 0) return -4;
			if (after_cr < end_offset)
			{
				c = fgetc(f);
				if (c != '\n')
				{
					return -1;
				}
			}
		}
		else if (c != '\n')
		{
			return -1;
		}
	}

	return 0;
}

/*
	hex_block_read:
	@f : file descriptor
	@size : size of block
	@addr : address of block
	@type : a flag (0x80 or 0x00)
	@page : page of block
	@data : the buffer where block is placed (16KB max)

	Read a data block (page or segment) from FLASH file. 
	If all args are set to NULL, this resets the parser.

	Returns : 0 if success, EOF if end of file has been reached.
*/
int hex_block_read(FILE *f, long end_offset, uint16_t *size, uint16_t *addr, uint8_t *type, uint8_t *data, uint16_t *page)
{
	static uint8_t flag = UINT8_C(0x80);
	static uint16_t flash_page;
	static uint16_t flash_addr;
	int new_page = 0;

	// reset condition
	if (f == nullptr)
	{
		flag = 0x80;
		flash_page = flash_addr = 0;
		return 0;
	}
	if (size == nullptr || addr == nullptr || type == nullptr || data == nullptr || page == nullptr)
	{
		return -1;
	}

	// fill-up buffer with 0xff (flash)
	memset(data, 0xff, BLK_MAX);

	*addr = flash_addr;
	*type = flag;
	*page = flash_page;
	*size = 0;

	// load data
	for (uint16_t i = 0; i < BLK_MAX; )
	{
		uint8_t pkt_size, pkt_type;
		uint8_t pkt_data[PKT_MAX];
		uint16_t pkt_addr;

		// read packet
		const int ret = hex_packet_read(f, end_offset, &pkt_size, &pkt_addr, &pkt_type, pkt_data);
		if(ret < 0)
		{
			/* Keep EOF (-1) distinct from malformed input. */
			return ret == EOF ? -5 : ret;
		}

		// new block ? Set address
		if(new_page)
		{
			flash_addr = pkt_addr;
			new_page = 0;
		}

		// returned values
		*addr = flash_addr;
		*type = flag;
		*page = flash_page;
		
		// determine what to do
		switch(pkt_type)
		{
		case HEX_DATA:
			// copy data
			if (pkt_size > BLK_MAX - i)
			{
				return -1;
			}
			memcpy(&data[i], pkt_data, pkt_size);
			i += pkt_size;
			*size = i;
			break;

		case HEX_END: 
			if (pkt_size != 0)
			{
				return -1;
			}
			// new section
			flash_addr = 0;
			flash_page = 0;
			flag ^= 0x80;
			if(i == 0)
				break;
			else
				return 0;

		case HEX_PAGE: 
			if (pkt_size != 2)
			{
				return -1;
			}
			// new page
			flash_page = (((uint16_t)(pkt_data[0])) << 8) | (uint16_t)(pkt_data[1]);
			new_page = !0;
			break;

		case HEX_EOF:
			// end of file
			if (i != 0)
			{
				// The payload ended without an end-of-section record: the
				// pending block is not returned to the caller.
				tifiles_critical("intelhex: payload ended inside an unterminated block; dropping %u bytes at page %04X, address %04X",
				                 (unsigned int)i, (unsigned int)flash_page, (unsigned int)flash_addr);
			}
			return EOF;

		default: 
			tifiles_warning("intelhex: unexpected record type %02X", pkt_type);
			return -1;
		}
	}

	return 0;
}

static int write_byte(uint8_t b, FILE * f)
{
	fprintf(f, "%02X", b);
	return 2;
}

/*
	hex_packet_write:
	@f : file descriptor
	@size : size of packet (field #1)
	@addr : addr of packet (field #2)
	@type : type of packet (field #3)
	@data : data of packet (field after #3), 32 bytes max

	Write an IntelHexa block from FLASH file like these:
	- ': 10 0000 00 FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF 00 CR/LF'
	- ': 00 0000 01 FF'
	- ': 02 0000 02 0000 FC'

	Returns : number of chars written to file.
*/
static int hex_packet_write(FILE *f, uint8_t size, uint16_t addr, uint8_t type_, uint8_t *data)
{
	int num = 0;
	const uint8_t type = (type_ == HEX_EOF ? HEX_END : type_);

	fputc(':', f); num++;
	num += write_byte((uint8_t)size, f);
	num += write_byte(MSB(addr), f);
	num += write_byte(LSB(addr), f);
	num += write_byte(type, f);

	int sum = size + MSB(addr) + LSB(addr) + type;
	for (int i = 0; i < size; i++) 
	{
		num += write_byte(data[i], f);
		sum += data[i];
	}

	num += write_byte((uint8_t)(0x100 - LSB(sum)), f);

	if(type_ != HEX_EOF)
	{
		fputc(0x0D, f);	num++; // CR
		fputc(0x0A, f); num++; // LF
	}

	return num;
}

/*
	hex_block_write:
	@f : file descriptor
	@size : size of block
	@addr : address of block
	@type : a flag (0x80 or 0x00)
	@page : page of block
	@data : the buffer where block is placed (16KB max)
	@extra_bytes : number of additional 0xff bytes to add after the end of the data

	Write a data block (page/segment) to FLASH file. 

	Returns : number of chars written to file.
*/
int hex_block_write(FILE *f, uint16_t size, uint16_t addr, uint8_t type, uint8_t *data, uint16_t page, uint16_t extra_bytes)
{
	int bytes_written = 0;
	static int old_flag = 0x80;
	uint8_t buf[PKT_MAX];
	int new_section = 0;

	// write end block
	if(!size && !addr && !type && !data && !page)
	{
		const int result = hex_packet_write(f, 0, 0x0000, HEX_EOF, nullptr);
		// Each TIFL member and each output file starts in the default section.
		// Do not leak the final section flag into the next hex_block_write user.
		old_flag = 0x80;
		return result;
	}

	// new section (FLASH OS only)
	if(old_flag == 0x80 && type == 0x00)
	{
		new_section = !0;
	}

	if(old_flag != type)
	{
		old_flag = type;
		bytes_written += hex_packet_write(f, 0, 0x0000, HEX_END, nullptr);
	}

	// write page
	if(!addr && !page && !new_section)
	{
		// no packet if default address (0) & page (0)
	}
	else
	{
		buf[0] = (uint8_t)(page >> 8);
		buf[1] = (uint8_t)(page & 0xff);
		bytes_written += hex_packet_write(f, 2, 0x0000, HEX_PAGE, buf);
		new_section = 0;
	}

	// write a block (=page)
	while (size > 0 || extra_bytes > 0)
	{
		const int n = (size > PKT_MAX ? PKT_MAX : size);
		if (n > 0)
		{
			memcpy(buf, data, n);
			size -= n;
			data += n;
		}

		const int m = (extra_bytes > PKT_MAX - n ? PKT_MAX - n : extra_bytes);
		if (m > 0)
		{
			memset(buf + n, 0xff, m);
			extra_bytes -= m;
		}

		bytes_written += hex_packet_write(f, n + m, addr, HEX_DATA, buf);
		addr += n + m;
	}

	return bytes_written;
}
