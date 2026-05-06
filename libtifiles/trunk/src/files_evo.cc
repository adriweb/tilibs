#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <glib.h>
#include <glib/gstdio.h>
#include <archive.h>
#include <archive_entry.h>

#include "tifiles.h"
#include "error.h"
#include "files_evo.h"
#include "logging.h"

#define EVO_CBOR_BREAK 0xff
#define EVO_CBOR_INDEFINITE_MAP 0xbf
#define EVO_OS_MAGIC 0x96f3b83dU
#define EVO_OS_MAX_SIZE (128U << 20)
#define EVO_OS_PRODUCT_TI84EVO 23U
#define EVO_OS_PRODUCT_TI83EVO 24U
#define EVO_OS_PRODUCT_TI84EVOT 25U

#define EVO_TYPE_LIST 1
#define EVO_TYPE_GDB 3
#define EVO_TYPE_PICTURE 4
#define EVO_TYPE_IMAGE 5
#define EVO_TYPE_MATRIX 6
#define EVO_TYPE_GRAPHPARAM 7
#define EVO_TYPE_STRING 10
#define EVO_TYPE_WINDOW 12
#define EVO_TYPE_RCL_WINDOW 13
#define EVO_TYPE_TABLE_SETUP 14

typedef struct
{
	const uint8_t *data;
	size_t len;
	size_t off;
} EvoCborReader;

typedef struct
{
	uint8_t type;
	uint8_t *name;
	size_t name_len;
} EvoFileMeta;

typedef struct
{
	uint8_t *data;
	size_t len;
	unsigned int product;
} EvoOsPackage;

static uint16_t evo_read_le16(const uint8_t *data)
{
	return (uint16_t)(data[0] | (data[1] << 8));
}

static uint32_t evo_read_le32(const uint8_t *data)
{
	return (uint32_t)data[0] | ((uint32_t)data[1] << 8) | ((uint32_t)data[2] << 16) | ((uint32_t)data[3] << 24);
}

static unsigned int evo_os_product_from_ext(const char *name)
{
	const char *ext = tifiles_fext_get(name);
	if (ext == nullptr)
	{
		return 0;
	}
	if (!g_ascii_strcasecmp(ext, "84b2") || !g_ascii_strcasecmp(ext, "84pk2"))
	{
		return EVO_OS_PRODUCT_TI84EVO;
	}
	if (!g_ascii_strcasecmp(ext, "83b2") || !g_ascii_strcasecmp(ext, "83pk2"))
	{
		return EVO_OS_PRODUCT_TI83EVO;
	}
	if (!g_ascii_strcasecmp(ext, "84tb2") || !g_ascii_strcasecmp(ext, "84tpk2"))
	{
		return EVO_OS_PRODUCT_TI84EVOT;
	}
	return 0;
}

static int evo_os_ext_is_extracted_package(const char *name)
{
	const char *ext = tifiles_fext_get(name);
	return ext != nullptr
	    && (!g_ascii_strcasecmp(ext, "84pk2")
	     || !g_ascii_strcasecmp(ext, "83pk2")
	     || !g_ascii_strcasecmp(ext, "84tpk2"));
}

static int evo_os_parse_metadata_product(const uint8_t *data, size_t len, unsigned int *product)
{
	static const char key[] = "bundle_target_prodid:";
	if (data == nullptr || product == nullptr)
	{
		return 0;
	}

	for (size_t i = 0; i + sizeof(key) - 1 <= len; i++)
	{
		if (memcmp(data + i, key, sizeof(key) - 1))
		{
			continue;
		}

		i += sizeof(key) - 1;
		while (i < len && (data[i] == ' ' || data[i] == '\t'))
		{
			i++;
		}

		unsigned int value = 0;
		int have_digit = 0;
		while (i < len && data[i] >= '0' && data[i] <= '9')
		{
			have_digit = 1;
			value = value * 10U + (unsigned int)(data[i] - '0');
			i++;
		}
		if (have_digit)
		{
			*product = value;
			return 1;
		}
	}
	return 0;
}

static int evo_os_read_archive_entry(struct archive *arc, uint8_t **data, size_t *len)
{
	uint8_t *out = nullptr;
	size_t out_len = 0;
	uint8_t buf[8192];

	for (;;)
	{
		const la_ssize_t got = archive_read_data(arc, buf, sizeof(buf));
		if (got < 0)
		{
			g_free(out);
			return ERR_FILE_IO;
		}
		if (got == 0)
		{
			break;
		}
		if ((size_t)got > EVO_OS_MAX_SIZE - out_len)
		{
			g_free(out);
			return ERR_INVALID_FILE;
		}
		uint8_t *tmp = (uint8_t *)g_try_realloc(out, out_len + (size_t)got);
		if (tmp == nullptr)
		{
			g_free(out);
			return ERR_MALLOC;
		}
		out = tmp;
		memcpy(out + out_len, buf, (size_t)got);
		out_len += (size_t)got;
	}

	if (out == nullptr)
	{
		out = (uint8_t *)g_try_malloc(1);
		if (out == nullptr)
		{
			return ERR_MALLOC;
		}
	}

	*data = out;
	*len = out_len;
	return 0;
}

static int evo_os_read_zip_package(const char *filename, EvoOsPackage *package)
{
	struct archive *arc = archive_read_new();
	FILE *fp = nullptr;
	if (arc == nullptr)
	{
		return ERR_MALLOC;
	}
	archive_read_support_format_zip(arc);
	archive_read_support_filter_all(arc);
	if (archive_read_open_filename(arc, filename, 10240) != ARCHIVE_OK)
	{
		fp = g_fopen(filename, "rb");
		if (fp == nullptr || archive_read_open_FILE(arc, fp) != ARCHIVE_OK)
		{
			if (fp != nullptr)
			{
				fclose(fp);
			}
			archive_read_free(arc);
			return ERR_INVALID_FILE;
		}
	}

	int ret = ERR_INVALID_FILE;
	unsigned int metadata_product = 0;
	struct archive_entry *entry = nullptr;
	while (archive_read_next_header(arc, &entry) == ARCHIVE_OK)
	{
		const char *pathname = archive_entry_pathname(entry);
		const char *base = pathname != nullptr ? strrchr(pathname, '/') : nullptr;
		base = base != nullptr ? base + 1 : pathname;
		if (base == nullptr || *base == 0 || archive_entry_filetype(entry) == AE_IFDIR)
		{
			archive_read_data_skip(arc);
			continue;
		}

		if (!g_ascii_strcasecmp(base, "METADATA"))
		{
			uint8_t *metadata = nullptr;
			size_t metadata_len = 0;
			ret = evo_os_read_archive_entry(arc, &metadata, &metadata_len);
			if (ret)
			{
				break;
			}
			evo_os_parse_metadata_product(metadata, metadata_len, &metadata_product);
			g_free(metadata);
			ret = ERR_INVALID_FILE;
			continue;
		}

		if (!evo_os_ext_is_extracted_package(base))
		{
			archive_read_data_skip(arc);
			continue;
		}

		ret = evo_os_read_archive_entry(arc, &package->data, &package->len);
		if (!ret)
		{
			if (package->product == 0)
			{
				package->product = evo_os_product_from_ext(base);
			}
			break;
		}
	}

	archive_read_close(arc);
	archive_read_free(arc);
	if (fp != nullptr)
	{
		fclose(fp);
	}

	if (!ret && package->product == 0)
	{
		package->product = metadata_product;
	}
	return ret;
}

static int evo_os_read_plain_package(const char *filename, EvoOsPackage *package)
{
	FILE *f = g_fopen(filename, "rb");
	if (f == nullptr)
	{
		return ERR_FILE_OPEN;
	}
	if (fseek(f, 0, SEEK_END) < 0)
	{
		fclose(f);
		return ERR_FILE_IO;
	}
	const long size_long = ftell(f);
	if (size_long < 0 || (unsigned long)size_long > EVO_OS_MAX_SIZE || fseek(f, 0, SEEK_SET) < 0)
	{
		fclose(f);
		return ERR_INVALID_FILE;
	}

	package->len = (size_t)size_long;
	package->data = (uint8_t *)g_try_malloc(package->len ? package->len : 1);
	if (package->data == nullptr)
	{
		fclose(f);
		return ERR_MALLOC;
	}
	if (fread(package->data, 1, package->len, f) != package->len)
	{
		g_free(package->data);
		package->data = nullptr;
		fclose(f);
		return ERR_FILE_IO;
	}
	fclose(f);
	return 0;
}

static int evo_os_parse_package_info(const uint8_t *data, size_t len, unsigned int *major, unsigned int *build, unsigned int *section_product)
{
	int found = 0;
	*major = 0;
	*build = 0;
	*section_product = 0;

	for (size_t off = 0; off + 32 <= len; off++)
	{
		if (evo_read_le32(data + off) != EVO_OS_MAGIC)
		{
			continue;
		}

		const unsigned int section_type = evo_read_le16(data + off + 10);
		const unsigned int version_major = evo_read_le32(data + off + 20);
		const unsigned int version_build = evo_read_le32(data + off + 24);
		if (!found || version_major > *major || (version_major == *major && version_build > *build))
		{
			*major = version_major;
			*build = version_build;
		}
		if (section_type == 0x51)
		{
			*section_product = EVO_OS_PRODUCT_TI83EVO;
		}
		else if (section_type == 0x41 && *section_product == 0)
		{
			// 0x41 is shared by TI-84 Evo and TI-84 Evo-T packages; the extension
			// or bundle metadata remains authoritative when available.
			*section_product = EVO_OS_PRODUCT_TI84EVO;
		}
		found = 1;
		off += 31;
	}
	return found;
}

static uint16_t evo_file_checksum(const uint8_t *body, size_t body_len)
{
	if (body_len < 3)
	{
		return 0;
	}

	size_t adjusted = body_len - 3;
	size_t word_count = adjusted >> 1;
	if ((adjusted & 1) && word_count > 0)
	{
		word_count--;
	}

	uint16_t checksum = 0;
	for (size_t i = 0; i < word_count; i++)
	{
		checksum ^= (uint16_t)(body[i * 2] | (body[i * 2 + 1] << 8));
	}
	return checksum;
}

static int evo_file_has_checksum(const uint8_t *data, size_t len)
{
	if (data == nullptr || len < 5 || data[0] != EVO_CBOR_INDEFINITE_MAP)
	{
		return 0;
	}

	const uint16_t stored = (uint16_t)((data[len - 2] << 8) | data[len - 1]);
	return stored == evo_file_checksum(data, len - 2);
}

static int evo_cbor_read_byte(EvoCborReader *r, uint8_t *byte)
{
	if (r->off >= r->len)
	{
		return 0;
	}
	*byte = r->data[r->off++];
	return 1;
}

static int evo_cbor_read_uint_arg(EvoCborReader *r, uint8_t addl, uint64_t *value)
{
	if (addl < 24)
	{
		*value = addl;
		return 1;
	}
	if (addl == 24)
	{
		uint8_t b;
		if (!evo_cbor_read_byte(r, &b)) return 0;
		*value = b;
		return 1;
	}
	if (addl == 25)
	{
		uint8_t b[2];
		if (r->off + sizeof(b) > r->len) return 0;
		memcpy(b, r->data + r->off, sizeof(b));
		r->off += sizeof(b);
		*value = (uint16_t)((b[0] << 8) | b[1]);
		return 1;
	}
	if (addl == 26)
	{
		uint8_t b[4];
		if (r->off + sizeof(b) > r->len) return 0;
		memcpy(b, r->data + r->off, sizeof(b));
		r->off += sizeof(b);
		*value = ((uint64_t)b[0] << 24) | ((uint64_t)b[1] << 16) | ((uint64_t)b[2] << 8) | b[3];
		return 1;
	}
	if (addl == 27)
	{
		uint64_t v = 0;
		if (r->off + 8 > r->len) return 0;
		for (unsigned int i = 0; i < 8; i++)
		{
			v = (v << 8) | r->data[r->off++];
		}
		*value = v;
		return 1;
	}
	return 0;
}

static int evo_cbor_skip(EvoCborReader *r, unsigned int depth);

static int evo_cbor_skip_items(EvoCborReader *r, uint64_t count, unsigned int depth)
{
	for (uint64_t i = 0; i < count; i++)
	{
		if (!evo_cbor_skip(r, depth + 1))
		{
			return 0;
		}
	}
	return 1;
}

static int evo_cbor_skip(EvoCborReader *r, unsigned int depth)
{
	if (depth > 32)
	{
		return 0;
	}

	uint8_t head;
	if (!evo_cbor_read_byte(r, &head))
	{
		return 0;
	}
	if (head == EVO_CBOR_BREAK)
	{
		return 0;
	}

	const uint8_t major = head >> 5;
	const uint8_t addl = head & 0x1f;
	uint64_t len = 0;
	if (addl == 31)
	{
		if (major != 2 && major != 3 && major != 4 && major != 5)
		{
			return 0;
		}
		if (major == 2 || major == 3)
		{
			for (;;)
			{
				if (r->off >= r->len) return 0;
				if (r->data[r->off] == EVO_CBOR_BREAK)
				{
					r->off++;
					return 1;
				}
				if (!evo_cbor_skip(r, depth + 1)) return 0;
			}
		}
		for (;;)
		{
			if (r->off >= r->len) return 0;
			if (r->data[r->off] == EVO_CBOR_BREAK)
			{
				r->off++;
				return 1;
			}
			if (!evo_cbor_skip(r, depth + 1)) return 0;
			if (major == 5 && !evo_cbor_skip(r, depth + 1)) return 0;
		}
	}

	if (!evo_cbor_read_uint_arg(r, addl, &len))
	{
		return 0;
	}
	if (len > (uint64_t)(SIZE_MAX - r->off))
	{
		return 0;
	}

	switch (major)
	{
	case 0:
	case 1:
	case 7:
		return 1;
	case 2:
	case 3:
		r->off += (size_t)len;
		return r->off <= r->len;
	case 4:
		return evo_cbor_skip_items(r, len, depth);
	case 5:
		return len <= UINT64_MAX / 2 && evo_cbor_skip_items(r, len * 2, depth);
	default:
		return 0;
	}
}

static int evo_cbor_read_text_key(EvoCborReader *r, char *key, size_t key_size)
{
	uint8_t head;
	uint64_t len;
	if (!evo_cbor_read_byte(r, &head) || (head >> 5) != 3 || (head & 0x1f) == 31)
	{
		return 0;
	}
	if (!evo_cbor_read_uint_arg(r, head & 0x1f, &len) || len >= key_size || len > (uint64_t)(r->len - r->off))
	{
		return 0;
	}
	memcpy(key, r->data + r->off, (size_t)len);
	key[len] = 0;
	r->off += (size_t)len;
	return 1;
}

static int evo_cbor_read_uint_value(EvoCborReader *r, uint64_t *value)
{
	uint8_t head;
	if (!evo_cbor_read_byte(r, &head) || (head >> 5) != 0)
	{
		return 0;
	}
	return evo_cbor_read_uint_arg(r, head & 0x1f, value);
}

static int evo_cbor_read_bytes_value(EvoCborReader *r, uint8_t **bytes, size_t *bytes_len)
{
	uint8_t head;
	uint64_t len;
	if (!evo_cbor_read_byte(r, &head) || (head >> 5) != 2 || (head & 0x1f) == 31)
	{
		return 0;
	}
	if (!evo_cbor_read_uint_arg(r, head & 0x1f, &len) || len > (uint64_t)(r->len - r->off))
	{
		return 0;
	}
	uint8_t *copy = (uint8_t *)g_malloc((size_t)len ? (size_t)len : 1);
	if (copy == nullptr)
	{
		return 0;
	}
	memcpy(copy, r->data + r->off, (size_t)len);
	r->off += (size_t)len;
	g_free(*bytes);
	*bytes = copy;
	*bytes_len = (size_t)len;
	return 1;
}

static int evo_cbor_enter_map(EvoCborReader *r, uint64_t *count, int *indefinite)
{
	uint8_t head;
	if (!evo_cbor_read_byte(r, &head) || (head >> 5) != 5)
	{
		return 0;
	}
	if ((head & 0x1f) == 31)
	{
		*indefinite = 1;
		*count = 0;
		return 1;
	}
	*indefinite = 0;
	return evo_cbor_read_uint_arg(r, head & 0x1f, count);
}

static int evo_cbor_map_done(EvoCborReader *r, uint64_t index, uint64_t count, int indefinite)
{
	if (!indefinite)
	{
		return index >= count;
	}
	if (r->off < r->len && r->data[r->off] == EVO_CBOR_BREAK)
	{
		r->off++;
		return 1;
	}
	return 0;
}

static int evo_parse_metadata(EvoCborReader *r, EvoFileMeta *meta)
{
	uint64_t count;
	int indefinite;
	if (!evo_cbor_enter_map(r, &count, &indefinite))
	{
		return 0;
	}

	for (uint64_t i = 0; !evo_cbor_map_done(r, i, count, indefinite); i++)
	{
		char key[32];
		if (!evo_cbor_read_text_key(r, key, sizeof(key)))
		{
			return 0;
		}
		if (!strcmp(key, "type"))
		{
			uint64_t value;
			if (!evo_cbor_read_uint_value(r, &value)) return 0;
			meta->type = (uint8_t)value;
		}
		else if (!strcmp(key, "name"))
		{
			if (!evo_cbor_read_bytes_value(r, &meta->name, &meta->name_len)) return 0;
		}
		else if (!evo_cbor_skip(r, 0))
		{
			return 0;
		}
	}
	return 1;
}

static int evo_parse_file_meta(const uint8_t *data, size_t len, EvoFileMeta *meta)
{
	EvoCborReader r = { data, len >= 2 ? len - 2 : len, 0 };
	uint64_t count;
	int indefinite;
	if (!evo_cbor_enter_map(&r, &count, &indefinite))
	{
		return 0;
	}

	for (uint64_t i = 0; !evo_cbor_map_done(&r, i, count, indefinite); i++)
	{
		char key[32];
		if (!evo_cbor_read_text_key(&r, key, sizeof(key)))
		{
			return 0;
		}
		if (!strcmp(key, "metaData"))
		{
			if (!evo_parse_metadata(&r, meta)) return 0;
		}
		else if (!evo_cbor_skip(&r, 0))
		{
			return 0;
		}
	}
	return meta->name != nullptr;
}

static int evo_name_word_at(const uint8_t *name, size_t name_len, size_t index, uint16_t *word)
{
	const size_t off = index * 2;
	if (off + 1 >= name_len)
	{
		return 0;
	}

	*word = (uint16_t)(name[off] | (name[off + 1] << 8));
	return *word != 0;
}

static char evo_char_from_name_word(uint16_t word)
{
	if (word >= 0xe800 && word <= 0xe819) return (char)('A' + word - 0xe800);
	if (word == 0xe81a) return '[';
	if (word >= 0xe401 && word <= 0xe40a) return (char)('0' + word - 0xe401);
	if ((word >= 'a' && word <= 'z') || (word >= 'A' && word <= 'Z') || (word >= '0' && word <= '9')) return (char)word;
	return '_';
}

static int evo_append_text(char *out, size_t out_size, size_t *off, const char *text)
{
	const size_t len = strlen(text);
	if (*off >= out_size || len >= out_size - *off)
	{
		return 0;
	}

	memcpy(out + *off, text, len + 1);
	*off += len;
	return 1;
}

static int evo_append_textf(char *out, size_t out_size, size_t *off, const char *fmt, unsigned int n)
{
	char tmp[16];
	const int written = snprintf(tmp, sizeof(tmp), fmt, n);
	return written >= 0 && (size_t)written < sizeof(tmp) && evo_append_text(out, out_size, off, tmp);
}

static int evo_decode_custom_name(const uint8_t *name, size_t name_len, size_t start, char *out, size_t out_size)
{
	size_t off = 0;
	uint16_t word;
	out[0] = 0;
	for (size_t i = start; evo_name_word_at(name, name_len, i, &word); i++)
	{
		char c[2] = { evo_char_from_name_word(word), 0 };
		if (!evo_append_text(out, out_size, &off, c))
		{
			return 0;
		}
	}
	return off > 0;
}

static int evo_decode_name(uint8_t type, const uint8_t *name, size_t name_len, char *out, size_t out_size)
{
	uint16_t first;
	size_t off = 0;
	out[0] = 0;
	if (!evo_name_word_at(name, name_len, 0, &first))
	{
		return 0;
	}

	if (type == EVO_TYPE_LIST)
	{
		if (first >= 0xe830 && first <= 0xe835) return evo_append_textf(out, out_size, &off, "L%u", (unsigned int)(first - 0xe830 + 1));
		return evo_decode_custom_name(name, name_len, first == 0xe836 ? 1 : 0, out, out_size);
	}
	if (type == EVO_TYPE_GDB)
	{
		if (first == 0xe899) return evo_append_text(out, out_size, &off, "GDB0");
		if (first >= 0xe890 && first <= 0xe898) return evo_append_textf(out, out_size, &off, "GDB%u", (unsigned int)(first - 0xe890 + 1));
	}
	if (type == EVO_TYPE_PICTURE)
	{
		if (first == 0xe889) return evo_append_text(out, out_size, &off, "Pic0");
		if (first >= 0xe880 && first <= 0xe888) return evo_append_textf(out, out_size, &off, "Pic%u", (unsigned int)(first - 0xe880 + 1));
	}
	if (type == EVO_TYPE_IMAGE)
	{
		if (first == 0xe8b9) return evo_append_text(out, out_size, &off, "Image0");
		if (first >= 0xe8b0 && first <= 0xe8b8) return evo_append_textf(out, out_size, &off, "Image%u", (unsigned int)(first - 0xe8b0 + 1));
	}
	if (type == EVO_TYPE_MATRIX && first >= 0xe820 && first <= 0xe829)
	{
		char matrix[2] = { (char)('A' + first - 0xe820), 0 };
		return evo_append_text(out, out_size, &off, matrix);
	}
	if (type == EVO_TYPE_GRAPHPARAM)
	{
		if (first >= 0xe840 && first <= 0xe849) return evo_append_textf(out, out_size, &off, "Y%u", (unsigned int)(first == 0xe849 ? 0 : first - 0xe840 + 1));
		if (first >= 0xe850 && first <= 0xe85b)
		{
			const unsigned int idx = (unsigned int)((first - 0xe850) / 2 + 1);
			char graph[4] = { ((first - 0xe850) % 2) == 0 ? 'X' : 'Y', (char)('0' + idx), 'T', 0 };
			return evo_append_text(out, out_size, &off, graph);
		}
		if (first >= 0xe860 && first <= 0xe865) return evo_append_textf(out, out_size, &off, "r%u", (unsigned int)(first - 0xe860 + 1));
		if (first >= 0xe870 && first <= 0xe872)
		{
			char uvw[2] = { (char)('u' + first - 0xe870), 0 };
			return evo_append_text(out, out_size, &off, uvw);
		}
	}
	if (type == EVO_TYPE_STRING)
	{
		if (first == 0xe8a9) return evo_append_text(out, out_size, &off, "Str0");
		if (first >= 0xe8a0 && first <= 0xe8a8) return evo_append_textf(out, out_size, &off, "Str%u", (unsigned int)(first - 0xe8a0 + 1));
	}
	if (type == EVO_TYPE_WINDOW && first == 0xe8ba) return evo_append_text(out, out_size, &off, "Window");
	if (type == EVO_TYPE_RCL_WINDOW && first == 0xe8bb) return evo_append_text(out, out_size, &off, "RclWindw");
	if (type == EVO_TYPE_TABLE_SETUP && first == 0xe8bc) return evo_append_text(out, out_size, &off, "TblSet");

	return evo_decode_custom_name(name, name_len, 0, out, out_size);
}

static char *evo_build_filename(const VarEntry *entry)
{
	char name[VARNAME_MAX + 1];
	size_t out = 0;
	for (size_t i = 0; i < VARNAME_MAX && entry->name[i] != 0; i++)
	{
		const char c = entry->name[i];
		name[out++] = (g_ascii_isalnum(c) || c == '.' || c == '_' || c == '-') ? c : '_';
	}
	if (out == 0)
	{
		memcpy(name, "var", 4);
	}
	else
	{
		name[out] = 0;
	}

	return g_strconcat(name, ".", tifiles_vartype2fext(CALC_TI84EVO_USB, entry->type), nullptr);
}

int evo_file_read_regular(const char *filename, FileContent *content)
{
	if (filename == nullptr || content == nullptr)
	{
		tifiles_critical("%s: an argument is NULL", __FUNCTION__);
		return ERR_INVALID_FILE;
	}

	FILE *f = g_fopen(filename, "rb");
	if (f == nullptr)
	{
		return ERR_FILE_OPEN;
	}
	if (fseek(f, 0, SEEK_END) < 0)
	{
		fclose(f);
		return ERR_FILE_IO;
	}
	const long file_size_long = ftell(f);
	if (file_size_long < 0 || file_size_long > (8L << 20) || fseek(f, 0, SEEK_SET) < 0)
	{
		fclose(f);
		return ERR_INVALID_FILE;
	}
	const size_t file_size = (size_t)file_size_long;
	uint8_t *data = (uint8_t *)g_malloc(file_size ? file_size : 1);
	if (data == nullptr)
	{
		fclose(f);
		return ERR_MALLOC;
	}
	if (fread(data, 1, file_size, f) != file_size)
	{
		g_free(data);
		fclose(f);
		return ERR_FILE_IO;
	}
	fclose(f);

	if (!evo_file_has_checksum(data, file_size))
	{
		g_free(data);
		return ERR_INVALID_FILE;
	}

	EvoFileMeta meta;
	memset(&meta, 0, sizeof(meta));
	if (!evo_parse_file_meta(data, file_size, &meta))
	{
		g_free(data);
		g_free(meta.name);
		return ERR_INVALID_FILE;
	}

	VarEntry *entry = tifiles_ve_create();
	VarEntry **entries = tifiles_ve_create_array(1);
	if (entry == nullptr || entries == nullptr)
	{
		if (entry != nullptr) tifiles_ve_delete(entry);
		g_free(entries);
		g_free(data);
		g_free(meta.name);
		return ERR_MALLOC;
	}

	entry->type = meta.type;
	entry->size = (uint32_t)file_size;
	entry->data = data;
	if (meta.type == EVO_TYPE_PICTURE || meta.type == EVO_TYPE_IMAGE)
	{
		entry->attr = ATTRB_ARCHIVED;
	}
	if (!evo_decode_name(meta.type, meta.name, meta.name_len, entry->name, sizeof(entry->name)))
	{
		g_strlcpy(entry->name, "VAR", sizeof(entry->name));
	}

	const CalcModel requested_model = content->model;
	content->model = ticonv_model_is_tievo(requested_model) ? requested_model : CALC_TI84EVO_USB;
	content->model_dst = content->model;
	tifiles_comment_set_single_sn(content->comment, sizeof(content->comment));
	content->num_entries = 1;
	content->entries = entries;
	content->entries[0] = entry;
	content->stored_checksum = (uint16_t)((data[file_size - 2] << 8) | data[file_size - 1]);
	content->checksum = evo_file_checksum(data, file_size - 2);

	g_free(meta.name);
	return 0;
}

int evo_file_write_regular(const char *filename, FileContent *content, char **filename2)
{
	if (content == nullptr || (filename == nullptr && filename2 == nullptr) || content->num_entries != 1 || content->entries == nullptr || content->entries[0] == nullptr)
	{
		tifiles_critical("%s: invalid argument", __FUNCTION__);
		return ERR_INVALID_FILE;
	}

	const VarEntry *entry = content->entries[0];
	if (!evo_file_has_checksum(entry->data, entry->size))
	{
		return ERR_INVALID_FILE;
	}

	char *real_name = nullptr;
	if (filename != nullptr)
	{
		real_name = g_strdup(filename);
	}
	else
	{
		real_name = evo_build_filename(entry);
	}
	if (real_name == nullptr)
	{
		return ERR_MALLOC;
	}
	if (filename2 != nullptr)
	{
		*filename2 = g_strdup(real_name);
	}

	FILE *f = g_fopen(real_name, "wb");
	if (f == nullptr)
	{
		g_free(real_name);
		return ERR_FILE_OPEN;
	}
	if (fwrite(entry->data, 1, entry->size, f) != entry->size)
	{
		fclose(f);
		g_free(real_name);
		return ERR_FILE_IO;
	}
	fclose(f);
	content->stored_checksum = (uint16_t)((entry->data[entry->size - 2] << 8) | entry->data[entry->size - 1]);
	content->checksum = evo_file_checksum(entry->data, entry->size - 2);
	g_free(real_name);
	return 0;
}

int evo_file_read_flash(const char *filename, FlashContent *content)
{
	if (filename == nullptr || content == nullptr)
	{
		tifiles_critical("%s: an argument is NULL", __FUNCTION__);
		return ERR_INVALID_FILE;
	}

	EvoOsPackage package;
	memset(&package, 0, sizeof(package));
	package.product = evo_os_product_from_ext(filename);

	const char *ext = tifiles_fext_get(filename);
	int ret;
	if (ext != nullptr && (!g_ascii_strcasecmp(ext, "84b2") || !g_ascii_strcasecmp(ext, "83b2") || !g_ascii_strcasecmp(ext, "84tb2")))
	{
		ret = evo_os_read_zip_package(filename, &package);
	}
	else
	{
		ret = evo_os_read_plain_package(filename, &package);
	}
	if (ret)
	{
		g_free(package.data);
		return ret;
	}

	unsigned int version_major = 0;
	unsigned int version_build = 0;
	unsigned int section_product = 0;
	if (!evo_os_parse_package_info(package.data, package.len, &version_major, &version_build, &section_product))
	{
		g_free(package.data);
		return ERR_INVALID_FILE;
	}
	if (package.product == 0)
	{
		package.product = section_product;
	}
	if (package.product == 0 || package.len > G_MAXUINT32)
	{
		g_free(package.data);
		return ERR_INVALID_FILE;
	}

	content->data_part = package.data;
	content->data_length = (uint32_t)package.len;
	content->device_type = (uint8_t)package.product;
	content->revision_major = (uint8_t)version_major;
	content->revision_minor = 0;
	content->revision_day = 0;
	content->revision_month = 0;
	content->revision_year = (uint16_t)version_build;
	if (package.product == EVO_OS_PRODUCT_TI84EVOT)
	{
		content->model = CALC_TI84EVOT_USB;
	}
	else if (package.product == EVO_OS_PRODUCT_TI83EVO)
	{
		content->model = CALC_TI83EVO_USB;
	}
	else
	{
		content->model = CALC_TI84EVO_USB;
	}
	content->model_dst = content->model;
	g_snprintf(content->name, sizeof(content->name), "%u.0.0.%u", version_major, version_build);

	return 0;
}
