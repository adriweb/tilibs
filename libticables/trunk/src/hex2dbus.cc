/*  hex2dbus - an D-BUS packet decompiler
 *  Copyright (C) 2002-2007  Romain Liévin
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

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <vector>

#include "ticables.h"
#include "internal.h"

static const unsigned char machine_id[] =
{
	0x00, 0x02, 0x03, 0x05, 0x06, 0x07, 0x08, 0x08, 0x09, 0x23,
	0x80, 0x82, 0x83, 0x85, 0x86, 0x74, 0x98, 0x88, 0x89, 0x73,
	0x42, 0x43,
	0x12, 0x15, 0x19, 0x95,
	0xff
};

static const char* machine_way[] = 
{
	"PC>TI", "PC>TI", "PC>TI", "PC>TI", "PC>TI", "PC>TI", "PC>TI", "PC>TI", "PC>TI", "PC>TI",
	"TI>PC", "TI>PC", "TI>PC", "TI>PC", "TI>PC", "TI>PC", "TI>PC", "TI>PC", "TI>PC", "TI>PC",
	"CBL2>PC", "TIPR>PC",
	"CBL>TI", "CBL>TI", "CBL>TI", "TI>CBL",
	"",
};

// The legacy names are kept for existing log readers. TI's names come from
// DBUSCommand in ActivityGrapher; the extra commands remain tilibs-only names.
struct DBUSCommandInfo
{
	unsigned char id;
	const char *name;
	const char *official_name;
	bool has_data;
};

static const DBUSCommandInfo commands[] =
{
	{0x06, "VAR", "RTS", true},
	{0x09, "CTS", "RDY", false},
	{0x15, "XDP", "XDP", true},
	{0x29, "ELD", "EBL", false},
	{0x2A, "DLD", "DBL", false},
	{0x2B, "EKE", "EKE", false},
	{0x2C, "DKE", "DKE", false},
	{0x2D, "VER", "RDI", false},
	{0x36, "SKP", "EOR", true},
	{0x47, "SID", "SIOA", true},
	{0x56, "ACK", "ACK", false},
	{0x5A, "ERR", "CHK", false},
	{0x68, "RDY", "RDC", false},
	{0x6D, "SCR", "REQ", false},
	{0x6E, "GID", "???", false},
	{0x6F, "DMP", "???", true},
	{0x70, "TG2", "???", true},
	{0x74, "RID", "RIOA", false},
	{0x78, "CNT", "RTC", false},
	{0x87, "KEY", "SKY", false},
	{0x88, "DEL", "DVL", true},
	{0x89, "RUN", "EPL", true},
	{0x92, "EOT", "DONE", false},
	{0xA2, "REQ", "GET", true},
	{0xB4, "ERR2", "???", false},
	{0xB7, "IND", "GTE", true},
	{0xC9, "RTS", "SEND", true},
	{0xCA, "RSE", "SETP", true},
};

static int is_a_machine_id(unsigned char id)
{
	int i;

	for (i=0; machine_id[i] != 0xff; i++)
	{
		if (id == machine_id[i])
		{
			break;
		}
	}

	return machine_id[i] != 0xff ? i : -1;
}

static int is_a_command_id(unsigned char id)
{
	for (unsigned int i = 0; i < sizeof(commands) / sizeof(commands[0]); i++)
	{
		if (id == commands[i].id)
		{
			return (int)i;
		}
	}
	return -1;
}

#define WIDTH	12

static int fill_buf(FILE *f, unsigned char data, int flush, bool reset = false)
{
	static unsigned char buf[WIDTH];
	static unsigned int cnt = 0;
	unsigned int i;
	if (reset)
	{
		cnt = 0;
		return 0;
	}

	if (!flush)
	{
		buf[cnt++] = data;
	}

	if ((cnt >= WIDTH) || flush)
	{
		//printf(".");
		fprintf(f, "    ");
		for (i = 0; i < cnt; i++)
		{
			fprintf(f, "%02X ", 0xff & buf[i]);
		}

		if (flush)
		{
			for (unsigned int j = i; j < WIDTH; j++)
			{
				fprintf(f, "   ");
			}
		}

		fprintf(f, "| ");
		for (i = 0; i < cnt; i++)
		{
			fprintf(f, "%c", isalnum(buf[i]) ? buf[i] : '.');
		}

		fprintf(f, "\n");
		cnt = 0;
	}

	return 0;
}

/*
  Input is log_hex.cc's three-line preamble followed by up to 16 HH bytes
  per line and an optional "| " ASCII column. The final line may be partial.
*/
int dbus_decomp(const char *filename, int resync)
{
	char src_name[1024];
	char dst_name[1024];
	FILE *fi = nullptr, *fo = nullptr;
	char str[256];
	std::vector<unsigned char> buffer;
	int ret = 0;

	if (filename == nullptr
	    || snprintf(src_name, sizeof(src_name), "%s.hex", filename) >= (int)sizeof(src_name)
	    || snprintf(dst_name, sizeof(dst_name), "%s.pkt", filename) >= (int)sizeof(dst_name))
	{
		return -1;
	}
	fi = fopen(src_name, "rt");
	if (fi == nullptr)
	{
		fprintf(stderr, "Unable to open input file: %s\n", src_name);
		return -1;
	}
	fo = fopen(dst_name, "wt");
	if (fo == nullptr)
	{
		fprintf(stderr, "Unable to open output file: %s\n", dst_name);
		fclose(fi);
		return -1;
	}
	fprintf(fo, "TI packet decompiler for D-BUS, version 1.3\n");
	fill_buf(fo, 0, 0, true);

	// Preserve the logger's preamble and ASCII-column format; do not scan the
	// ASCII column as hexadecimal, even if it contains digits or A..F.
	for (int line = 0; line < 3; line++)
	{
		if (fgets(str, sizeof(str), fi) == nullptr)
		{
			ret = -1;
			goto exit;
		}
	}
	while (fgets(str, sizeof(str), fi) != nullptr)
	{
		char *cursor = str;
		unsigned int count = 0;
		while (*cursor && *cursor != '|')
		{
			while (isspace((unsigned char)*cursor)) cursor++;
			if (*cursor == '\0' || *cursor == '|') break;
			if (count == 16 || !isxdigit((unsigned char)cursor[0])
			    || !isxdigit((unsigned char)cursor[1])
			    || (cursor[2] != '\0' && cursor[2] != '|'
			        && !isspace((unsigned char)cursor[2])))
			{
				ret = -1;
				goto exit;
			}
			char hex[3] = {cursor[0], cursor[1], '\0'};
			buffer.push_back((unsigned char)strtoul(hex, nullptr, 16));
			cursor += 2;
			count++;
		}
		if (strchr(str, '\n') == nullptr && !feof(fi))
		{
			// A logger line is much shorter than this buffer; a longer line is
			// malformed rather than a second set of data without a boundary.
			int next = fgetc(fi);
			if (next != EOF)
			{
				ret = -1;
				goto exit;
			}
		}
	}
	if (ferror(fi))
	{
		ret = -1;
		goto exit;
	}
	printf("%lu bytes read.\n", (unsigned long)buffer.size());

	for (size_t i = 0; i < buffer.size();)
	{
		if (buffer.size() - i < 2)
		{
			ret = -3;
			goto exit;
		}
		const unsigned char mid = buffer[i];
		const unsigned char cid = buffer[i + 1];
		const int machine = is_a_machine_id(mid);
		if (machine == -1)
		{
			ret = -1;
			goto exit;
		}
		const int command = is_a_command_id(cid);
		if (command == -1)
		{
			ret = -2;
			goto exit;
		}
		const DBUSCommandInfo &info = commands[command];
		// The TI-80 ACK has no header word, and libticalcs writes every
		// data-less MID 0x00 packet (TI-80 SCR, probe RDC) as two bytes.
		const bool ti80_short = (mid == 0x80 && cid == 0x56)
		                    || (mid == 0x00 && !info.has_data);
		const size_t header_size = ti80_short ? 2 : 4;
		if (buffer.size() - i < header_size)
		{
			ret = -3;
			goto exit;
		}
		const unsigned int word = ti80_short ? 0 : buffer[i + 2] | ((unsigned int)buffer[i + 3] << 8);
		const size_t length = info.has_data ? word : 0;
		const size_t packet_size = header_size + (length ? length + 2 : 0);
		if (buffer.size() - i < packet_size && (!resync || !length))
		{
			ret = -3;
			goto exit;
		}
		fprintf(fo, "%02X %02X", mid, cid);
		if (!ti80_short) fprintf(fo, " %02X %02X", word & 0xff, word >> 8);
		for (size_t j = header_size; j <= WIDTH; j++) fprintf(fo, "   ");
		fprintf(fo, "  | %s: %s (TI: %s)", machine_way[machine], info.name, info.official_name);
		if (!info.has_data && !ti80_short && word)
		{
			fprintf(fo, " [%s=%04X]", cid == 0x87 ? "key" : "status", word);
		}
		fputc('\n', fo);
		i += header_size;
		bool restarted = false;
		if (length)
		{
			unsigned int checksum = 0;
			for (size_t j = 0; j < length; j++)
			{
				if (i == buffer.size())
				{
					ret = -3;
					goto exit;
				}
				if (resync && i + 1 < buffer.size() && buffer[i] == 0x98
				    && (buffer[i + 1] == 0x15 || buffer[i + 1] == 0x56))
				{
					printf("Warning: there is packets in data !\n");
					fprintf(fo, "Beware : length of previous packet is wrong !\n");
					fill_buf(fo, 0, 1);
					restarted = true;
					break;
				}
				checksum += buffer[i];
				fill_buf(fo, buffer[i++], 0);
			}
			if (restarted) continue;
			fill_buf(fo, 0, 1);
			if (buffer.size() - i < 2)
			{
				ret = -3;
				goto exit;
			}
			const unsigned int expected = buffer[i] | ((unsigned int)buffer[i + 1] << 8);
			fprintf(fo, "    %02X %02X", buffer[i], buffer[i + 1]);
			if ((checksum & 0xffff) != expected) fprintf(fo, " (Checksum mismatch)");
			fputc('\n', fo);
			i += 2;
		}
	}

exit:
	if (ret < 0) printf("Error %i\n", -ret);
	fill_buf(fo, 0, 0, true);
	if (fclose(fo) != 0) ret = -1;
	if (fclose(fi) != 0) ret = -1;
	return ret;
}

#if 0
int main(int argc, char **argv)
{
	int resync = 0;

	if (argc < 2)
	{
		fprintf(stderr, "Usage: hex2dbus [file]\n");
		exit(0);
	}

	if (argc > 2)
	{
		resync = !0;
	}

	return dbus_decomp(argv[1], resync);
}
#endif
