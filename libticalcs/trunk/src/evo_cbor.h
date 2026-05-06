/* TI-84 Evo CBOR helpers. */

#ifndef __TICALCS_EVO_CBOR__
#define __TICALCS_EVO_CBOR__

#include <stddef.h>
#include <stdint.h>

typedef struct
{
	uint8_t *data;
	size_t size;
	size_t capacity;
} EvoBuffer;

typedef enum
{
	EVO_CBOR_NONE,
	EVO_CBOR_UINT,
	EVO_CBOR_NEG,
	EVO_CBOR_BYTES,
	EVO_CBOR_TEXT,
	EVO_CBOR_ARRAY,
	EVO_CBOR_MAP,
	EVO_CBOR_BOOL
} EvoCborKind;

typedef struct EvoCborValue EvoCborValue;
typedef struct EvoCborPair EvoCborPair;

struct EvoCborValue
{
	EvoCborKind kind;
	size_t len;
	union
	{
		uint64_t uintv;
		int64_t intv;
		bool boolv;
		char *str;
		uint8_t *bytes;
		EvoCborValue *array;
		EvoCborPair *map;
	} v;
};

struct EvoCborPair
{
	char *key;
	EvoCborValue value;
};

void evo_buffer_init(EvoBuffer *buffer);
void evo_buffer_free(EvoBuffer *buffer);
int evo_buffer_reserve(EvoBuffer *buffer, size_t needed);
int evo_buffer_append(EvoBuffer *buffer, const uint8_t *data, size_t len);
int evo_buffer_append_byte(EvoBuffer *buffer, uint8_t byte);

void evo_cbor_init(EvoCborValue *value);
void evo_cbor_free(EvoCborValue *value);
int evo_cbor_parse(const uint8_t *data, size_t data_len, size_t *off, EvoCborValue *value);
const EvoCborValue *evo_cbor_get(const EvoCborValue *map, const char *key);
int evo_cbor_text_append(EvoBuffer *out, const char *s);
int evo_cbor_uint_append(EvoBuffer *out, uint32_t n);
int evo_cbor_bytes_append(EvoBuffer *out, const uint8_t *data, size_t len);

#endif
