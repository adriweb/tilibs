#ifdef HAVE_CONFIG_H
#include <config.h>
#endif

#include <glib.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ticalcs.h"
#include "gettext.h"
#include "internal.h"
#include "logging.h"
#include "error.h"
#include "evo_cbor.h"
#include "evo_cmd.h"

#define EVO_CBOR_INDEFINITE_MAP 0xbf
#define EVO_CBOR_BREAK 0xff

#define EVO_TYPE_LIST 1
#define EVO_TYPE_PROGRAM 2
#define EVO_TYPE_GDB 3
#define EVO_TYPE_PICTURE 4
#define EVO_TYPE_IMAGE 5
#define EVO_TYPE_MATRIX 6
#define EVO_TYPE_GRAPHPARAM 7
#define EVO_TYPE_APPVAR 8
#define EVO_TYPE_GROUP 9
#define EVO_TYPE_STRING 10
#define EVO_TYPE_FLASH_APP 11
#define EVO_TYPE_WINDOW 12
#define EVO_TYPE_RCL_WINDOW 13
#define EVO_TYPE_TABLE_SETUP 14
#define EVO_TYPE_PYTHON_SCRIPT 15

#define EVO_SCREEN_WIDTH 320
#define EVO_SCREEN_HEIGHT 240
#define EVO_SCREEN_BYTES_PER_PIXEL 2
#define EVO_SCREEN_SIZE (EVO_SCREEN_WIDTH * EVO_SCREEN_HEIGHT * EVO_SCREEN_BYTES_PER_PIXEL)

static const EvoCborValue *evo_find_bytes_with_len(const EvoCborValue *value, size_t len)
{
	if (value == nullptr)
	{
		return nullptr;
	}
	if (value->kind == EVO_CBOR_BYTES && value->len == len)
	{
		return value;
	}
	if (value->kind == EVO_CBOR_ARRAY)
	{
		for (size_t i = 0; i < value->len; i++)
		{
			const EvoCborValue *found = evo_find_bytes_with_len(&value->v.array[i], len);
			if (found != nullptr)
			{
				return found;
			}
		}
	}
	if (value->kind == EVO_CBOR_MAP)
	{
		for (size_t i = 0; i < value->len; i++)
		{
			const EvoCborValue *found = evo_find_bytes_with_len(&value->v.map[i].value, len);
			if (found != nullptr)
			{
				return found;
			}
		}
	}
	return nullptr;
}

static int evo_name_word_at(const EvoCborValue *tok, size_t index, uint16_t *word)
{
	const size_t off = index * 2;
	if (tok == nullptr || tok->kind != EVO_CBOR_BYTES || off + 1 >= tok->len)
	{
		return 0;
	}

	*word = (uint16_t)(tok->v.bytes[off] | (tok->v.bytes[off + 1] << 8));
	return *word != 0;
}

static int evo_name_append(char *out, size_t out_size, size_t *off, const char *text)
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

static int evo_name_appendf(char *out, size_t out_size, size_t *off, const char *fmt, unsigned int n)
{
	char tmp[16];
	const int written = snprintf(tmp, sizeof(tmp), fmt, n);
	return written >= 0 && (size_t)written < sizeof(tmp) && evo_name_append(out, out_size, off, tmp);
}

static int evo_name_append_word(char *out, size_t out_size, size_t *off, uint16_t word)
{
	if (word >= 0xe800 && word <= 0xe819)
	{
		char c[2] = { (char)('A' + word - 0xe800), 0 };
		return evo_name_append(out, out_size, off, c);
	}
	else if (word == 0xe81a)
	{
		return evo_name_append(out, out_size, off, "theta");
	}
	else if ((word >= 'a' && word <= 'z') || (word >= 'A' && word <= 'Z') || (word >= '0' && word <= '9'))
	{
		char c[2] = { (char)word, 0 };
		return evo_name_append(out, out_size, off, c);
	}
	else if (word >= 0xe401 && word <= 0xe40a)
	{
		char c[2] = { (char)('0' + word - 0xe401), 0 };
		return evo_name_append(out, out_size, off, c);
	}
	else if (word == 0xe400 || word == '_')
	{
		return evo_name_append(out, out_size, off, "_");
	}
	return 0;
}

static int evo_decode_custom_name(const EvoCborValue *tok, size_t start, char *out, size_t out_size)
{
	size_t off = 0;
	uint16_t word;

	out[0] = 0;
	for (size_t i = start; evo_name_word_at(tok, i, &word); i++)
	{
		if (!evo_name_append_word(out, out_size, &off, word))
		{
			return 0;
		}
	}
	return off > 0;
}

static int evo_decode_tok_name(uint64_t type, const EvoCborValue *tok, char *out, size_t out_size)
{
	uint16_t first;

	out[0] = 0;
	if (!evo_name_word_at(tok, 0, &first))
	{
		return 0;
	}

	size_t off = 0;
	if (type == EVO_TYPE_LIST)
	{
		if (first >= 0xe830 && first <= 0xe835)
		{
			return evo_name_appendf(out, out_size, &off, "L%u", (unsigned int)(first - 0xe830 + 1));
		}
		return evo_decode_custom_name(tok, first == 0xe836 ? 1 : 0, out, out_size);
	}
	if (type == EVO_TYPE_GDB)
	{
		if (first == 0xe899) return evo_name_append(out, out_size, &off, "GDB0");
		if (first >= 0xe890 && first <= 0xe898) return evo_name_appendf(out, out_size, &off, "GDB%u", (unsigned int)(first - 0xe890 + 1));
	}
	if (type == EVO_TYPE_PICTURE)
	{
		if (first == 0xe889) return evo_name_append(out, out_size, &off, "Pic0");
		if (first >= 0xe880 && first <= 0xe888) return evo_name_appendf(out, out_size, &off, "Pic%u", (unsigned int)(first - 0xe880 + 1));
	}
	if (type == EVO_TYPE_IMAGE)
	{
		if (first == 0xe8b9) return evo_name_append(out, out_size, &off, "Image0");
		if (first >= 0xe8b0 && first <= 0xe8b8) return evo_name_appendf(out, out_size, &off, "Image%u", (unsigned int)(first - 0xe8b0 + 1));
	}
	if (type == EVO_TYPE_MATRIX && first >= 0xe820 && first <= 0xe829)
	{
		char name[2] = { (char)('A' + first - 0xe820), 0 };
		return evo_name_append(out, out_size, &off, name);
	}
	if (type == EVO_TYPE_GRAPHPARAM)
	{
		if (first >= 0xe840 && first <= 0xe849) return evo_name_appendf(out, out_size, &off, "Y%u", (unsigned int)(first == 0xe849 ? 0 : first - 0xe840 + 1));
		if (first >= 0xe850 && first <= 0xe85b)
		{
			const unsigned int idx = (unsigned int)((first - 0xe850) / 2 + 1);
			char name[4] = { ((first - 0xe850) % 2) == 0 ? 'X' : 'Y', (char)('0' + idx), 'T', 0 };
			return evo_name_append(out, out_size, &off, name);
		}
		if (first >= 0xe860 && first <= 0xe865) return evo_name_appendf(out, out_size, &off, "r%u", (unsigned int)(first - 0xe860 + 1));
		if (first >= 0xe870 && first <= 0xe872)
		{
			char name[2] = { (char)('u' + first - 0xe870), 0 };
			return evo_name_append(out, out_size, &off, name);
		}
	}
	if (type == EVO_TYPE_STRING)
	{
		if (first == 0xe8a9) return evo_name_append(out, out_size, &off, "Str0");
		if (first >= 0xe8a0 && first <= 0xe8a8) return evo_name_appendf(out, out_size, &off, "Str%u", (unsigned int)(first - 0xe8a0 + 1));
	}
	if (type == EVO_TYPE_WINDOW && first == 0xe8ba) return evo_name_append(out, out_size, &off, "Window");
	if (type == EVO_TYPE_RCL_WINDOW && first == 0xe8bb) return evo_name_append(out, out_size, &off, "RclWindw");
	if (type == EVO_TYPE_TABLE_SETUP && first == 0xe8bc) return evo_name_append(out, out_size, &off, "TblSet");

	return evo_decode_custom_name(tok, 0, out, out_size);
}

static int evo_decode_tok_custom_name(const EvoCborValue *tok, uint64_t type, char *out, size_t out_size)
{
	if (type == EVO_TYPE_LIST)
	{
		uint16_t first;
		if (evo_name_word_at(tok, 0, &first) && first == 0xe836)
		{
			return evo_decode_custom_name(tok, 1, out, out_size);
		}
	}
	return evo_decode_custom_name(tok, 0, out, out_size);
}

static void evo_display_name(const EvoCborValue *item, char *out, size_t out_size)
{
	out[0] = 0;
	const EvoCborValue *tok = evo_cbor_get(item, "tokName");
	if (tok && tok->kind == EVO_CBOR_BYTES)
	{
		const EvoCborValue *type = evo_cbor_get(item, "type");
		const uint64_t t = (type && type->kind == EVO_CBOR_UINT) ? type->v.uintv : 0;
		if (evo_decode_tok_name(t, tok, out, out_size))
		{
			return;
		}
	}
	const EvoCborValue *disp = evo_cbor_get(item, "dispName");
	if (disp && disp->kind == EVO_CBOR_TEXT)
	{
		ticalcs_strlcpy(out, disp->v.str, out_size);
	}
}

static int evo_dir_entry_add_match_candidate(const VarRequest *vr, uint64_t type, const char *candidate)
{
	if (candidate == nullptr || *candidate == 0)
	{
		return 0;
	}
	if (!g_ascii_strcasecmp(candidate, vr->name))
	{
		return 1;
	}
	if (type == EVO_TYPE_MATRIX)
	{
		const size_t len = strlen(candidate);
		if (len >= 2 && candidate[0] == '[' && candidate[len - 1] == ']')
		{
			char bare[VARNAME_MAX];
			size_t bare_len = len - 2;
			if (bare_len >= sizeof(bare))
			{
				bare_len = sizeof(bare) - 1;
			}
			memcpy(bare, candidate + 1, bare_len);
			bare[bare_len] = 0;
			if (!g_ascii_strcasecmp(bare, vr->name))
			{
				return 1;
			}
		}
	}
	return type == EVO_TYPE_TABLE_SETUP && !g_ascii_strcasecmp(candidate, "tblsetup") && !g_ascii_strcasecmp(vr->name, "tblset");
}

static int evo_url_encode_tok_name(const EvoCborValue *tok, char *out, size_t out_size)
{
	size_t off = 0;
	out[0] = 0;
	if (tok == nullptr || tok->kind != EVO_CBOR_BYTES)
	{
		return ERR_INVALID_PACKET;
	}

	for (size_t i = 0; i + 1 < tok->len; i += 2)
	{
		const uint16_t word = tok->v.bytes[i] | (tok->v.bytes[i + 1] << 8);
		if (word == 0) break;
		const uint8_t utf8[3] = {
			(uint8_t)(0xe0 | ((word >> 12) & 0x0f)),
			(uint8_t)(0x80 | ((word >> 6) & 0x3f)),
			(uint8_t)(0x80 | (word & 0x3f))
		};
		for (size_t j = 0; j < sizeof(utf8); j++)
		{
			const int written = snprintf(out + off, out_size - off, "%%%02X", utf8[j]);
			if (written < 0 || (size_t)written >= out_size - off)
			{
				return ERR_INVALID_PACKET;
			}
			off += (size_t)written;
		}
	}
	return 0;
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

static int evo_data_is_file_payload(const uint8_t *data, uint32_t size)
{
	if (data == nullptr || size < 5 || data[0] != EVO_CBOR_INDEFINITE_MAP)
	{
		return 0;
	}

	const uint16_t stored = (uint16_t)((data[size - 2] << 8) | data[size - 1]);
	return stored == evo_file_checksum(data, size - 2);
}

static int evo_dir_entry_matches_request(const EvoCborValue *item, const VarRequest *vr)
{
	const EvoCborValue *type = evo_cbor_get(item, "type");
	if (!type || type->kind != EVO_CBOR_UINT || type->v.uintv != vr->type)
	{
		return 0;
	}

	char display[VARNAME_MAX];
	evo_display_name(item, display, sizeof(display));
	if (evo_dir_entry_add_match_candidate(vr, type->v.uintv, display))
	{
		return 1;
	}

	const EvoCborValue *tok = evo_cbor_get(item, "tokName");
	if (tok && tok->kind == EVO_CBOR_BYTES)
	{
		char custom[VARNAME_MAX];
		if (evo_decode_tok_custom_name(tok, type->v.uintv, custom, sizeof(custom))
		    && evo_dir_entry_add_match_candidate(vr, type->v.uintv, custom))
		{
			return 1;
		}
	}
	return 0;
}

static int evo_find_dir_entry_resource(CalcHandle *handle, const VarRequest *vr, char *resource, size_t resource_size, VarEntry *entry)
{
	uint8_t *payload = nullptr;
	size_t payload_len = 0;
	int ret = evo_get_request(handle, "hh01/get/hh01/inf/res?name=directory&gotohome=1", &payload, &payload_len);
	if (ret)
	{
		free(payload);
		return ret;
	}

	EvoCborValue root;
	size_t off = 0;
	if (!evo_cbor_parse(payload, payload_len, &off, &root) || root.kind != EVO_CBOR_MAP)
	{
		evo_cbor_free(&root);
		free(payload);
		return ERR_INVALID_PACKET;
	}
	const EvoCborValue *data = evo_cbor_get(&root, "data");
	if (!data || data->kind != EVO_CBOR_ARRAY)
	{
		evo_cbor_free(&root);
		free(payload);
		return ERR_INVALID_PACKET;
	}

	ret = ERR_MISSING_VAR;
	for (size_t i = 0; i < data->len; i++)
	{
		const EvoCborValue *item = &data->v.array[i];
		if (item->kind != EVO_CBOR_MAP || !evo_dir_entry_matches_request(item, vr))
		{
			continue;
		}

		const EvoCborValue *tok = evo_cbor_get(item, "tokName");
		const EvoCborValue *type = evo_cbor_get(item, "type");
		if (!type || type->kind != EVO_CBOR_UINT)
		{
			ret = ERR_INVALID_PACKET;
			break;
		}

		char name[128];
		ret = evo_url_encode_tok_name(tok, name, sizeof(name));
		if (ret) break;
		const int written = snprintf(resource, resource_size, "var?name=%s&type=%u", name, (unsigned int)type->v.uintv);
		ret = (written < 0 || (size_t)written >= resource_size) ? ERR_INVALID_PACKET : 0;
		if (!ret && entry != nullptr)
		{
			memset(entry, 0, sizeof(*entry));
			evo_display_name(item, entry->name, sizeof(entry->name));
			entry->type = (uint8_t)type->v.uintv;
			const EvoCborValue *v = evo_cbor_get(item, "size");
			if (v && v->kind == EVO_CBOR_UINT) entry->size = (uint32_t)v->v.uintv;
			v = evo_cbor_get(item, "mem");
			entry->attr = (v && v->kind == EVO_CBOR_BOOL && v->v.boolv) ? ATTRB_ARCHIVED : ATTRB_NONE;
		}
		break;
	}

	evo_cbor_free(&root);
	free(payload);
	return ret;
}

static int is_ready(CalcHandle *handle)
{
	uint8_t *payload = nullptr;
	size_t payload_len = 0;
	const int ret = evo_get_request(handle, "hh01/get/hh01/sys/attributes", &payload, &payload_len);
	free(payload);
	return ret;
}

static int send_key(CalcHandle *handle, uint32_t key)
{
	uint8_t payload[4];
	size_t payload_len;

	if (key < 24)
	{
		payload[0] = 0x9f;
		payload[1] = (uint8_t)key;
		payload[2] = 0xff;
		payload_len = 3;
	}
	else if (key <= 0xff)
	{
		payload[0] = 0x9f;
		payload[1] = 0x18;
		payload[2] = (uint8_t)key;
		payload[3] = 0xff;
		payload_len = 4;
	}
	else
	{
		return ERR_INVALID_PACKET;
	}

	return evo_put_request(handle, "hh01/sys/scancode", payload, payload_len);
}

static int get_dynamic_info(CalcHandle *handle, CalcInfos *infos, uint32_t *ram, uint32_t *flash)
{
	uint8_t *payload = nullptr;
	size_t payload_len = 0;
	int ret = evo_get_request(handle, "hh01/get/hh01/inf/res?name=dynamicinfo", &payload, &payload_len);
	if (ret)
	{
		free(payload);
		return ret;
	}

	EvoCborValue root;
	size_t off = 0;
	if (!evo_cbor_parse(payload, payload_len, &off, &root) || root.kind != EVO_CBOR_MAP)
	{
		evo_cbor_free(&root);
		free(payload);
		return ERR_INVALID_PACKET;
	}

	int have_ram = 0;
	int have_flash = 0;
	const EvoCborValue *v = evo_cbor_get(&root, "ram");
	if (v && v->kind == EVO_CBOR_UINT)
	{
		have_ram = 1;
		if (ram) *ram = (uint32_t)v->v.uintv;
		if (infos)
		{
			infos->ram_free = v->v.uintv;
			infos->mask = (InfosMask)(infos->mask | INFOS_RAM_FREE);
		}
	}
	v = evo_cbor_get(&root, "archive");
	if (v && v->kind == EVO_CBOR_UINT)
	{
		have_flash = 1;
		if (flash) *flash = (uint32_t)v->v.uintv;
		if (infos)
		{
			infos->flash_free = v->v.uintv;
			infos->mask = (InfosMask)(infos->mask | INFOS_FLASH_FREE);
		}
	}
	v = evo_cbor_get(&root, "language");
	if (v && v->kind == EVO_CBOR_UINT && infos)
	{
		infos->language_id = (uint8_t)v->v.uintv;
		infos->mask = (InfosMask)(infos->mask | INFOS_LANG_ID);
	}

	evo_cbor_free(&root);
	free(payload);
	return ((ram && !have_ram) || (flash && !have_flash)) ? ERR_INVALID_PACKET : 0;
}

static int get_memfree(CalcHandle *handle, uint32_t *ram, uint32_t *flash)
{
	return get_dynamic_info(handle, nullptr, ram, flash);
}

static uint8_t evo_battery_level_to_percent(uint64_t level)
{
	if (level <= 5)
	{
		return (uint8_t)(level * 20);
	}
	if (level > 100)
	{
		return 100;
	}
	return (uint8_t)level;
}

static CalcModel evo_model_from_product_id(uint64_t product_id)
{
	switch (product_id)
	{
		case PRODUCT_ID_TI84EVO: return CALC_TI84EVO_USB;
		case PRODUCT_ID_TI83EVO: return CALC_TI83EVO_USB;
		case PRODUCT_ID_TI84EVOT: return CALC_TI84EVOT_USB;
		default: return CALC_NONE;
	}
}

static CalcModel evo_model_from_product_string(const char *product)
{
	if (product == nullptr || *product == 0)
	{
		return CALC_NONE;
	}

	char *end = nullptr;
	const uint64_t product_id = strtoull(product, &end, 10);
	if (end == product)
	{
		return CALC_NONE;
	}
	return evo_model_from_product_id(product_id);
}

static int get_version(CalcHandle *handle, CalcInfos *infos)
{
	VALIDATE_NONNULL(infos);
	uint8_t *payload = nullptr;
	size_t payload_len = 0;
	const int ret = evo_get_request(handle, "hh01/get/hh01/sys/attributes", &payload, &payload_len);
	if (ret)
	{
		free(payload);
		return ret;
	}

	EvoCborValue root;
	size_t off = 0;
	if (!evo_cbor_parse(payload, payload_len, &off, &root) || root.kind != EVO_CBOR_MAP)
	{
		evo_cbor_free(&root);
		free(payload);
		return ERR_INVALID_PACKET;
	}

	memset(infos, 0, sizeof(*infos));
	infos->model = ticonv_model_is_tievo(handle->model) ? handle->model : CALC_TI84EVO_USB;
	infos->mask = INFOS_CALC_MODEL | INFOS_PRODUCT_NAME | INFOS_PRODUCT_ID | INFOS_OS_VERSION | INFOS_BOOT_VERSION | INFOS_BOOT2_VERSION | INFOS_FLASH_PHYS | INFOS_RAM_PHYS | INFOS_BATTERY_LEVEL | INFOS_EXTERNAL_POWER | INFOS_COLOR_SCREEN | INFOS_HAS_SCREEN | INFOS_COLOR_DEPTH | INFOS_LCD_WIDTH | INFOS_LCD_HEIGHT;
	const EvoCborValue *v = evo_cbor_get(&root, "product");
	if (v && v->kind == EVO_CBOR_TEXT)
	{
		ticalcs_strlcpy(infos->product_id, v->v.str, sizeof(infos->product_id));
		const CalcModel product_model = evo_model_from_product_string(v->v.str);
		if (product_model != CALC_NONE) infos->model = product_model;
	}
	ticalcs_strlcpy(infos->product_name, ticonv_model_to_string(infos->model), sizeof(infos->product_name));
	v = evo_cbor_get(&root, "pkg-version");
	if (v && v->kind == EVO_CBOR_TEXT) ticalcs_strlcpy(infos->os_version, v->v.str, sizeof(infos->os_version));
	v = evo_cbor_get(&root, "bl1-version");
	if (v && v->kind == EVO_CBOR_TEXT) ticalcs_strlcpy(infos->boot_version, v->v.str, sizeof(infos->boot_version));
	v = evo_cbor_get(&root, "bl2-version");
	if (v && v->kind == EVO_CBOR_TEXT) ticalcs_strlcpy(infos->boot2_version, v->v.str, sizeof(infos->boot2_version));
	v = evo_cbor_get(&root, "total-flash");
	if (v && v->kind == EVO_CBOR_UINT) infos->flash_phys = v->v.uintv;
	v = evo_cbor_get(&root, "total-ram");
	if (v && v->kind == EVO_CBOR_UINT) infos->ram_phys = v->v.uintv;
	v = evo_cbor_get(&root, "battery");
	if (v && v->kind == EVO_CBOR_UINT) infos->battery_level = evo_battery_level_to_percent(v->v.uintv);
	v = evo_cbor_get(&root, "charging");
	if (v && v->kind == EVO_CBOR_UINT) infos->external_power = (uint8_t)v->v.uintv;
	infos->lcd_width = EVO_SCREEN_WIDTH;
	infos->lcd_height = EVO_SCREEN_HEIGHT;
	infos->color_screen = 1;
	infos->has_screen = 1;
	infos->color_depth = 16;

	evo_cbor_free(&root);
	free(payload);
	return get_dynamic_info(handle, infos, nullptr, nullptr);
}

static int recv_screen(CalcHandle *handle, CalcScreenCoord *sc, uint8_t **bitmap)
{
	VALIDATE_NONNULL(sc);
	VALIDATE_NONNULL(bitmap);
	uint8_t *payload = nullptr;
	size_t payload_len = 0;
	const int ret = evo_get_request(handle, "hh01/get/hh01/sys/screen", &payload, &payload_len);
	if (ret)
	{
		free(payload);
		return ret;
	}

	const size_t screen_size = EVO_SCREEN_SIZE;
	EvoCborValue root;
	size_t off = 0;
	if (!evo_cbor_parse(payload, payload_len, &off, &root))
	{
		free(payload);
		return ERR_INVALID_SCREENSHOT;
	}
	const EvoCborValue *pixels = evo_find_bytes_with_len(&root, screen_size);
	if (pixels == nullptr)
	{
		evo_cbor_free(&root);
		free(payload);
		return ERR_INVALID_SCREENSHOT;
	}
	*bitmap = (uint8_t *)ticalcs_alloc_screen(screen_size);
	if (*bitmap == nullptr)
	{
		evo_cbor_free(&root);
		free(payload);
		return ERR_MALLOC;
	}
	memcpy(*bitmap, pixels->v.bytes, screen_size);
	sc->format = SCREEN_FULL;
	sc->width = sc->clipped_width = EVO_SCREEN_WIDTH;
	sc->height = sc->clipped_height = EVO_SCREEN_HEIGHT;
	sc->pixel_format = CALC_PIXFMT_RGB_565_LE;
	evo_cbor_free(&root);
	free(payload);
	return 0;
}

static int get_dirlist(CalcHandle *handle, GNode **vars, GNode **apps)
{
	VALIDATE_NONNULL(vars);
	VALIDATE_NONNULL(apps);
	int ret = dirlist_init_trees(handle, vars, apps);
	if (ret) return ret;
	GNode *folder = dirlist_create_append_node(nullptr, vars);
	dirlist_create_append_node(nullptr, apps);
	if (folder == nullptr) return ERR_MALLOC;

	uint8_t *payload = nullptr;
	size_t payload_len = 0;
	ret = evo_get_request(handle, "hh01/get/hh01/inf/res?name=directory&gotohome=1", &payload, &payload_len);
	if (ret)
	{
		free(payload);
		return ret;
	}

	EvoCborValue root;
	size_t off = 0;
	if (!evo_cbor_parse(payload, payload_len, &off, &root) || root.kind != EVO_CBOR_MAP)
	{
		evo_cbor_free(&root);
		free(payload);
		return ERR_INVALID_PACKET;
	}
	const EvoCborValue *data = evo_cbor_get(&root, "data");
	if (!data || data->kind != EVO_CBOR_ARRAY)
	{
		evo_cbor_free(&root);
		free(payload);
		return 0;
	}

	for (size_t i = 0; i < data->len; i++)
	{
		const EvoCborValue *item = &data->v.array[i];
		if (item->kind != EVO_CBOR_MAP) continue;
		VarEntry *ve = tifiles_ve_create();
		if (ve == nullptr)
		{
			evo_cbor_free(&root);
			free(payload);
			return ERR_MALLOC;
		}
		evo_display_name(item, ve->name, sizeof(ve->name));
		const EvoCborValue *v = evo_cbor_get(item, "type");
		if (v && v->kind == EVO_CBOR_UINT) ve->type = (uint8_t)v->v.uintv;
		v = evo_cbor_get(item, "size");
		if (v && v->kind == EVO_CBOR_UINT) ve->size = (uint32_t)v->v.uintv;
		v = evo_cbor_get(item, "mem");
		ve->attr = (v && v->kind == EVO_CBOR_BOOL && v->v.boolv) ? ATTRB_ARCHIVED : ATTRB_NONE;
		if (dirlist_create_append_node(ve, &folder) == nullptr)
		{
			tifiles_ve_delete(ve);
			evo_cbor_free(&root);
			free(payload);
			return ERR_MALLOC;
		}
	}

	evo_cbor_free(&root);
	free(payload);
	return 0;
}

static int send_var(CalcHandle *handle, CalcMode mode, FileContent *content)
{
	VALIDATE_FILECONTENT(content);
	(void)mode;
	for (unsigned int i = 0; i < content->num_entries; i++)
	{
		const VarEntry *ve = content->entries[i];
		if (!evo_data_is_file_payload(ve->data, ve->size))
		{
			return ERR_INVALID_PACKET;
		}

		char *utf8 = ticonv_varname_to_utf8(handle->model, ve->name, ve->type);
		ticalcs_slprintf(handle->updat->text, sizeof(handle->updat->text), _("Sending %s..."), utf8);
		ticonv_utf8_free(utf8);
		ticalcs_update_label(handle);

		unsigned int archive = ve->attr == ATTRB_ARCHIVED;
		if (ve->type == EVO_TYPE_PICTURE || ve->type == EVO_TYPE_IMAGE || ve->type == EVO_TYPE_GROUP)
		{
			archive = 1;
		}
		else if (ve->type == EVO_TYPE_FLASH_APP)
		{
			// Type 11 is only accepted by the generic transfer endpoint as a
			// RAM-staged object. Installing it as an application is a separate path.
			archive = 0;
		}
		char url[96];
		snprintf(url, sizeof(url), "hh01/xfr/var?memtarget=%u&policy=1", archive ? 1U : 0U);
		const int ret = evo_put_request(handle, url, ve->data, ve->size);
		if (ret) return ret;
	}
	return 0;
}

static int recv_var(CalcHandle *handle, CalcMode mode, FileContent *content, VarRequest *vr)
{
	VALIDATE_FILECONTENT(content);
	VALIDATE_VARREQUEST(vr);
	(void)mode;

	char *utf8 = ticonv_varname_to_utf8(handle->model, vr->name, vr->type);
	ticalcs_slprintf(handle->updat->text, sizeof(handle->updat->text), _("Receiving %s..."), utf8);
	ticonv_utf8_free(utf8);
	ticalcs_update_label(handle);

	char resource[160];
	VarEntry dir_entry;
	int ret = evo_find_dir_entry_resource(handle, vr, resource, sizeof(resource), &dir_entry);
	if (ret) return ret;

	char url[192];
	int written = snprintf(url, sizeof(url), "hh01/get/hh01/xfr/%s", resource);
	if (written < 0 || (size_t)written >= sizeof(url))
	{
		return ERR_INVALID_PACKET;
	}

	uint8_t *payload = nullptr;
	size_t payload_len = 0;
	ret = evo_get_request(handle, url, &payload, &payload_len);
	if (ret)
	{
		free(payload);
		return ret;
	}
	if (payload_len > (uint32_t)-1 - 2)
	{
		free(payload);
		return ERR_INVALID_PACKET;
	}

	VarEntry *ve = tifiles_ve_create();
	VarEntry **entries = tifiles_ve_create_array(1);
	if (ve == nullptr || entries == nullptr)
	{
		if (ve != nullptr) tifiles_ve_delete(ve);
		g_free(entries);
		free(payload);
		return ERR_MALLOC;
	}

	memcpy(ve, &dir_entry, sizeof(*ve));
	ve->size = (uint32_t)(payload_len + 2);
	ve->data = (uint8_t *)tifiles_ve_alloc_data(ve->size);
	if (ve->data == nullptr)
	{
		tifiles_ve_delete(ve);
		g_free(entries);
		free(payload);
		return ERR_MALLOC;
	}

	memcpy(ve->data, payload, payload_len);
	const uint16_t checksum = evo_file_checksum(payload, payload_len);
	ve->data[payload_len] = (uint8_t)(checksum >> 8);
	ve->data[payload_len + 1] = (uint8_t)(checksum & 0xff);

	content->model = handle->model;
	tifiles_comment_set_single_sn(content->comment, sizeof(content->comment));
	content->num_entries = 1;
	content->entries = entries;
	content->entries[0] = ve;

	free(payload);
	return 0;
}

static int del_var(CalcHandle *handle, VarRequest *vr)
{
	VALIDATE_VARREQUEST(vr);

	char *utf8 = ticonv_varname_to_utf8(handle->model, vr->name, vr->type);
	ticalcs_slprintf(handle->updat->text, sizeof(handle->updat->text), _("Deleting %s..."), utf8);
	ticonv_utf8_free(utf8);
	ticalcs_update_label(handle);

	char resource[160];
	int ret = evo_find_dir_entry_resource(handle, vr, resource, sizeof(resource), nullptr);
	if (ret) return ret;

	char url[192];
	const int written = snprintf(url, sizeof(url), "hh01/del/%s", resource);
	if (written < 0 || (size_t)written >= sizeof(url))
	{
		return ERR_INVALID_PACKET;
	}

	const uint8_t payload = 0;
	return evo_put_request(handle, url, &payload, 1);
}

static int send_os(CalcHandle *handle, FlashContent *content)
{
	VALIDATE_FLASHCONTENT(content);

	if (content->name[0] == 0)
	{
		return ERR_INVALID_PACKET;
	}

	ticalcs_slprintf(handle->updat->text, sizeof(handle->updat->text), _("Sending OS %s..."), content->name);
	ticalcs_update_label(handle);

	unsigned int product = content->device_type;
	if (product == 0)
	{
		product = (unsigned int)ticonv_model_to_product_id(handle->model);
	}
	const unsigned int connected_product = (unsigned int)ticonv_model_to_product_id(handle->model);
	if (content->device_type != 0 && connected_product != 0 && connected_product != product)
	{
		ticalcs_warning(_("OS package targets product %u, but connected calculator model is %s (product %u)"),
		                product, ticonv_model_to_string(handle->model), connected_product);
	}

	char url[96];
	const int written = snprintf(url, sizeof(url), "hh01/upd/pkg?bundle=1&prodnum=%u&version=%s", product, content->name);
	if (written < 0 || (size_t)written >= sizeof(url))
	{
		return ERR_INVALID_PACKET;
	}

	// The calculator may stop answering once the OS installer takes over after
	// the transfer-finalize packet; at that point the package was accepted.
	return evo_put_request_ignore_final_status(handle, url, content->data_part, content->data_length);
}

static int send_cert(CalcHandle *handle, FlashContent *content)
{
	VALIDATE_FLASHCONTENT(content);
	return evo_put_request(handle, "hh01/upd/devcert", content->data_part, content->data_length);
}

#define EVO_CALC_COUNTERS \
	{"", "", "", "1P", "1L", "", "", "", "2P", "", "", "", "", "", "2P", "", "", "", "", "", "1L", "", "", "1L", "", "", "", "", "", "", "", "", ""}

#define EVO_CALC_FNCTS \
	{ \
		&is_ready, \
		&send_key, \
		&noop_execute, \
		&recv_screen, \
		&get_dirlist, \
		&get_memfree, \
		&noop_send_backup, \
		&noop_recv_backup, \
		&send_var, \
		&recv_var, \
		&noop_send_var_ns, \
		&noop_recv_var_ns, \
		&noop_send_flash, \
		&noop_recv_flash, \
		&send_os, \
		&noop_recv_idlist, \
		&noop_dump_rom_1, \
		&noop_dump_rom_2, \
		&noop_set_clock, \
		&noop_get_clock, \
		&del_var, \
		&noop_new_folder, \
		&get_version, \
		&send_cert, \
		&noop_recv_cert, \
		&noop_rename_var, \
		&noop_change_attr, \
		&noop_send_all_vars_backup, \
		&noop_recv_all_vars_backup, \
		&noop_send_lab_equipment_data, \
		&noop_get_lab_equipment_data, \
		&noop_del_folder, \
		&noop_recv_os, \
		nullptr \
	}

extern const CalcFncts calc_84evo_usb =
{
	CALC_TI84EVO_USB,
	"TI84Evo",
	"TI-84 Evo",
	N_("TI-84 Evo thru CDC serial"),
	OPS_ISREADY | OPS_KEYS | OPS_SCREEN | OPS_DIRLIST | OPS_VARS | OPS_DELVAR | OPS_OS | OPS_VERSION |
	FTS_SILENT | FTS_MEMFREE | FTS_FLASH,
	PRODUCT_ID_TI84EVO,
	EVO_CALC_COUNTERS,
	EVO_CALC_FNCTS
};

extern const CalcFncts calc_84evot_usb =
{
	CALC_TI84EVOT_USB,
	"TI84EvoT",
	"TI-84 Evo-T",
	N_("TI-84 Evo-T thru CDC serial"),
	OPS_ISREADY | OPS_KEYS | OPS_SCREEN | OPS_DIRLIST | OPS_VARS | OPS_DELVAR | OPS_OS | OPS_VERSION |
	FTS_SILENT | FTS_MEMFREE | FTS_FLASH,
	PRODUCT_ID_TI84EVOT,
	EVO_CALC_COUNTERS,
	EVO_CALC_FNCTS
};

extern const CalcFncts calc_83evo_usb =
{
	CALC_TI83EVO_USB,
	"TI83Evo",
	"TI-83 Evo",
	N_("TI-83 Evo thru CDC serial"),
	OPS_ISREADY | OPS_KEYS | OPS_SCREEN | OPS_DIRLIST | OPS_VARS | OPS_DELVAR | OPS_OS | OPS_VERSION |
	FTS_SILENT | FTS_MEMFREE | FTS_FLASH,
	PRODUCT_ID_TI83EVO,
	EVO_CALC_COUNTERS,
	EVO_CALC_FNCTS
};
