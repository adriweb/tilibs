#ifdef HAVE_CONFIG_H
#include <config.h>
#endif

#include "evo_cbor.h"

#include <stdlib.h>
#include <string.h>

#include "error.h"

#define EVO_CBOR_MAJOR_UINT 0
#define EVO_CBOR_MAJOR_NEG 1
#define EVO_CBOR_MAJOR_BYTES 2
#define EVO_CBOR_MAJOR_TEXT 3
#define EVO_CBOR_MAJOR_ARRAY 4
#define EVO_CBOR_MAJOR_MAP 5
#define EVO_CBOR_MAJOR_SIMPLE 7
#define EVO_CBOR_MAJOR_SHIFT 5

#define EVO_CBOR_FALSE 20
#define EVO_CBOR_TRUE 21
#define EVO_CBOR_NULL 22
#define EVO_CBOR_UNDEFINED 23
#define EVO_CBOR_UINT8_FOLLOWS 24
#define EVO_CBOR_UINT16_FOLLOWS 25
#define EVO_CBOR_UINT32_FOLLOWS 26
#define EVO_CBOR_INDEFINITE 31
#define EVO_CBOR_BREAK 0xff
#define EVO_CBOR_MAX_DEPTH 64

#define EVO_CBOR_HEAD(major, addl) (uint8_t)(((major) << EVO_CBOR_MAJOR_SHIFT) | (addl))

void evo_buffer_init(EvoBuffer *buffer)
{
	buffer->data = nullptr;
	buffer->size = 0;
	buffer->capacity = 0;
}

void evo_buffer_free(EvoBuffer *buffer)
{
	free(buffer->data);
	buffer->data = nullptr;
	buffer->size = 0;
	buffer->capacity = 0;
}

int evo_buffer_reserve(EvoBuffer *buffer, size_t needed)
{
	if (needed <= buffer->capacity)
	{
		return 0;
	}

	size_t capacity = buffer->capacity ? buffer->capacity : 64;
	while (capacity < needed)
	{
		capacity *= 2;
	}

	uint8_t *data = (uint8_t *)realloc(buffer->data, capacity);
	if (data == nullptr)
	{
		return ERR_MALLOC;
	}

	buffer->data = data;
	buffer->capacity = capacity;
	return 0;
}

int evo_buffer_append(EvoBuffer *buffer, const uint8_t *data, size_t len)
{
	if (len == 0)
	{
		return 0;
	}

	const int ret = evo_buffer_reserve(buffer, buffer->size + len);
	if (ret)
	{
		return ret;
	}

	memcpy(buffer->data + buffer->size, data, len);
	buffer->size += len;
	return 0;
}

int evo_buffer_append_byte(EvoBuffer *buffer, uint8_t byte)
{
	return evo_buffer_append(buffer, &byte, 1);
}

void evo_cbor_init(EvoCborValue *value)
{
	memset(value, 0, sizeof(*value));
	value->kind = EVO_CBOR_NONE;
}

void evo_cbor_free(EvoCborValue *value)
{
	if (value == nullptr)
	{
		return;
	}

	switch (value->kind)
	{
		case EVO_CBOR_TEXT:
			free(value->v.str);
			break;
		case EVO_CBOR_BYTES:
			free(value->v.bytes);
			break;
		case EVO_CBOR_ARRAY:
			for (size_t i = 0; i < value->len; i++)
			{
				evo_cbor_free(&value->v.array[i]);
			}
			free(value->v.array);
			break;
		case EVO_CBOR_MAP:
			for (size_t i = 0; i < value->len; i++)
			{
				free(value->v.map[i].key);
				evo_cbor_free(&value->v.map[i].value);
			}
			free(value->v.map);
			break;
		default:
			break;
	}

	evo_cbor_init(value);
}

static int cbor_len(const uint8_t *data, size_t data_len, size_t *off, uint8_t addl, uint64_t *len)
{
	if (addl < 24)
	{
		*len = addl;
		return 1;
	}
	if (addl == EVO_CBOR_UINT8_FOLLOWS && *off < data_len)
	{
		*len = data[(*off)++];
		return 1;
	}
	if (addl == EVO_CBOR_UINT16_FOLLOWS && *off + 1 < data_len)
	{
		*len = ((uint64_t)data[*off] << 8) | data[*off + 1];
		*off += 2;
		return 1;
	}
	if (addl == EVO_CBOR_UINT32_FOLLOWS && *off + 3 < data_len)
	{
		*len = ((uint64_t)data[*off] << 24) | ((uint64_t)data[*off + 1] << 16) | ((uint64_t)data[*off + 2] << 8) | data[*off + 3];
		*off += 4;
		return 1;
	}
	return 0;
}

static int cbor_array_append(EvoCborValue *value, EvoCborValue *item)
{
	EvoCborValue *array = (EvoCborValue *)realloc(value->v.array, (value->len + 1) * sizeof(EvoCborValue));
	if (array == nullptr)
	{
		return 0;
	}

	value->v.array = array;
	value->v.array[value->len++] = *item;
	evo_cbor_init(item);
	return 1;
}

static int cbor_map_append(EvoCborValue *value, char *key, EvoCborValue *item)
{
	EvoCborPair *map = (EvoCborPair *)realloc(value->v.map, (value->len + 1) * sizeof(EvoCborPair));
	if (map == nullptr)
	{
		return 0;
	}

	value->v.map = map;
	value->v.map[value->len].key = key;
	value->v.map[value->len].value = *item;
	value->len++;
	evo_cbor_init(item);
	return 1;
}

static char *cbor_take_text_key(EvoCborValue *key)
{
	if (key->kind != EVO_CBOR_TEXT)
	{
		evo_cbor_free(key);
		return nullptr;
	}

	char *text = key->v.str ? key->v.str : strdup("");
	key->v.str = nullptr;
	evo_cbor_free(key);
	return text;
}

static int evo_cbor_parse_at(const uint8_t *data, size_t data_len, size_t *off, EvoCborValue *value, unsigned int depth)
{
	evo_cbor_init(value);
	if (*off >= data_len || depth > EVO_CBOR_MAX_DEPTH)
	{
		return 0;
	}

	const uint8_t initial = data[(*off)++];
	const uint8_t major = initial >> EVO_CBOR_MAJOR_SHIFT;
	const uint8_t addl = initial & 0x1f;
	uint64_t len = 0;

	if (major == EVO_CBOR_MAJOR_SIMPLE)
	{
		value->kind = EVO_CBOR_BOOL;
		value->v.boolv = addl == EVO_CBOR_TRUE;
		return addl == EVO_CBOR_FALSE || addl == EVO_CBOR_TRUE || addl == EVO_CBOR_NULL || addl == EVO_CBOR_UNDEFINED;
	}

	if (addl == EVO_CBOR_INDEFINITE && (major == EVO_CBOR_MAJOR_ARRAY || major == EVO_CBOR_MAJOR_MAP))
	{
		value->kind = major == EVO_CBOR_MAJOR_ARRAY ? EVO_CBOR_ARRAY : EVO_CBOR_MAP;
		while (*off < data_len && data[*off] != EVO_CBOR_BREAK)
		{
			if (major == EVO_CBOR_MAJOR_ARRAY)
			{
				EvoCborValue item;
				if (!evo_cbor_parse_at(data, data_len, off, &item, depth + 1))
				{
					evo_cbor_free(value);
					return 0;
				}
				if (!cbor_array_append(value, &item))
				{
					evo_cbor_free(&item);
					evo_cbor_free(value);
					return 0;
				}
			}
			else
			{
				EvoCborValue key;
				EvoCborValue item;
				if (!evo_cbor_parse_at(data, data_len, off, &key, depth + 1))
				{
					evo_cbor_free(value);
					return 0;
				}
				if (!evo_cbor_parse_at(data, data_len, off, &item, depth + 1))
				{
					evo_cbor_free(&key);
					evo_cbor_free(&item);
					evo_cbor_free(value);
					return 0;
				}
				char *key_text = cbor_take_text_key(&key);
				if (key_text == nullptr || !cbor_map_append(value, key_text, &item))
				{
					free(key_text);
					evo_cbor_free(&item);
					evo_cbor_free(value);
					return 0;
				}
			}
		}
		if (*off < data_len)
		{
			(*off)++;
		}
		return 1;
	}

	if (!cbor_len(data, data_len, off, addl, &len))
	{
		return 0;
	}
	if (major == EVO_CBOR_MAJOR_UINT)
	{
		value->kind = EVO_CBOR_UINT;
		value->v.uintv = len;
		return 1;
	}
	if (major == EVO_CBOR_MAJOR_NEG)
	{
		value->kind = EVO_CBOR_NEG;
		value->v.intv = -1 - (int64_t)len;
		return 1;
	}
	if (major == EVO_CBOR_MAJOR_BYTES || major == EVO_CBOR_MAJOR_TEXT)
	{
		if (*off + len > data_len)
		{
			return 0;
		}
		if (major == EVO_CBOR_MAJOR_BYTES)
		{
			value->kind = EVO_CBOR_BYTES;
			value->v.bytes = (uint8_t *)malloc((size_t)len ? (size_t)len : 1);
			if (value->v.bytes == nullptr)
			{
				return 0;
			}
			memcpy(value->v.bytes, data + *off, (size_t)len);
		}
		else
		{
			value->kind = EVO_CBOR_TEXT;
			value->v.str = (char *)malloc((size_t)len + 1);
			if (value->v.str == nullptr)
			{
				return 0;
			}
			memcpy(value->v.str, data + *off, (size_t)len);
			value->v.str[(size_t)len] = 0;
		}
		value->len = (size_t)len;
		*off += (size_t)len;
		return 1;
	}
	if (major == EVO_CBOR_MAJOR_ARRAY)
	{
		if ((uint64_t)(size_t)len != len || (size_t)len > data_len - *off ||
		    (size_t)len > (size_t)-1 / sizeof(EvoCborValue))
		{
			return 0;
		}
		value->kind = EVO_CBOR_ARRAY;
		const size_t count = (size_t)len;
		value->v.array = (EvoCborValue *)calloc(count ? count : 1, sizeof(EvoCborValue));
		if (value->v.array == nullptr)
		{
			return 0;
		}
		for (size_t i = 0; i < count; i++)
		{
			if (!evo_cbor_parse_at(data, data_len, off, &value->v.array[i], depth + 1))
			{
				evo_cbor_free(value);
				return 0;
			}
			value->len++;
		}
		return 1;
	}
	if (major == EVO_CBOR_MAJOR_MAP)
	{
		if ((uint64_t)(size_t)len != len || (size_t)len > (data_len - *off) / 2 ||
		    (size_t)len > (size_t)-1 / sizeof(EvoCborPair))
		{
			return 0;
		}
		value->kind = EVO_CBOR_MAP;
		const size_t count = (size_t)len;
		value->v.map = (EvoCborPair *)calloc(count ? count : 1, sizeof(EvoCborPair));
		if (value->v.map == nullptr)
		{
			return 0;
		}
		for (size_t i = 0; i < count; i++)
		{
			EvoCborValue key;
			if (!evo_cbor_parse_at(data, data_len, off, &key, depth + 1))
			{
				evo_cbor_free(value);
				return 0;
			}
			char *key_text = cbor_take_text_key(&key);
			if (key_text == nullptr)
			{
				evo_cbor_free(value);
				return 0;
			}
			value->v.map[i].key = key_text;
			value->len++;
			if (!evo_cbor_parse_at(data, data_len, off, &value->v.map[i].value, depth + 1))
			{
				evo_cbor_free(value);
				return 0;
			}
		}
		return 1;
	}

	return 0;
}

int evo_cbor_parse(const uint8_t *data, size_t data_len, size_t *off, EvoCborValue *value)
{
	return evo_cbor_parse_at(data, data_len, off, value, 0);
}

const EvoCborValue *evo_cbor_get(const EvoCborValue *map, const char *key)
{
	if (map == nullptr || map->kind != EVO_CBOR_MAP)
	{
		return nullptr;
	}

	for (size_t i = 0; i < map->len; i++)
	{
		if (!strcmp(map->v.map[i].key, key))
		{
			return &map->v.map[i].value;
		}
	}
	return nullptr;
}

int evo_cbor_text_append(EvoBuffer *out, const char *s)
{
	const size_t len = strlen(s);
	if (len >= 24)
	{
		return ERR_INVALID_PARAMETER;
	}

	const int ret = evo_buffer_append_byte(out, EVO_CBOR_HEAD(EVO_CBOR_MAJOR_TEXT, len));
	if (ret) return ret;
	return evo_buffer_append(out, (const uint8_t *)s, len);
}

int evo_cbor_uint_append(EvoBuffer *out, uint32_t n)
{
	if (n < 24) return evo_buffer_append_byte(out, (uint8_t)n);
	if (n < 256)
	{
		const uint8_t bytes[2] = { EVO_CBOR_HEAD(EVO_CBOR_MAJOR_UINT, EVO_CBOR_UINT8_FOLLOWS), (uint8_t)n };
		return evo_buffer_append(out, bytes, sizeof(bytes));
	}
	const uint8_t bytes[5] = { EVO_CBOR_HEAD(EVO_CBOR_MAJOR_UINT, EVO_CBOR_UINT32_FOLLOWS), (uint8_t)(n >> 24), (uint8_t)(n >> 16), (uint8_t)(n >> 8), (uint8_t)n };
	return evo_buffer_append(out, bytes, sizeof(bytes));
}

int evo_cbor_bytes_append(EvoBuffer *out, const uint8_t *data, size_t len)
{
	int ret;
	if (len < 24)
	{
		ret = evo_buffer_append_byte(out, EVO_CBOR_HEAD(EVO_CBOR_MAJOR_BYTES, len));
	}
	else if (len < 256)
	{
		const uint8_t bytes[2] = { EVO_CBOR_HEAD(EVO_CBOR_MAJOR_BYTES, EVO_CBOR_UINT8_FOLLOWS), (uint8_t)len };
		ret = evo_buffer_append(out, bytes, sizeof(bytes));
	}
	else
	{
		const uint8_t bytes[5] = { EVO_CBOR_HEAD(EVO_CBOR_MAJOR_BYTES, EVO_CBOR_UINT32_FOLLOWS), (uint8_t)(len >> 24), (uint8_t)(len >> 16), (uint8_t)(len >> 8), (uint8_t)len };
		ret = evo_buffer_append(out, bytes, sizeof(bytes));
	}
	if (ret) return ret;
	return evo_buffer_append(out, data, len);
}
