#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#include "../src/error.h"
#include "../src/evo_cbor.h"
#include "../src/evo_cmd.h"

#define CHECK(condition) \
	do { \
		if (!(condition)) { \
			fprintf(stderr, "%s:%d: check failed: %s\n", __FILE__, __LINE__, #condition); \
			abort(); \
		} \
	} while (0)

static void check_packet_lengths(void)
{
	size_t remainder = 0;
	CHECK(evo_kermit_packet_remainder(0x23, nullptr, &remainder) == 0);
	CHECK(remainder == 4);
	CHECK(evo_kermit_packet_remainder(0x1f, nullptr, &remainder) == ERR_INVALID_PACKET);
	CHECK(evo_kermit_packet_remainder(0x7f, nullptr, &remainder) == ERR_INVALID_PACKET);

	static const uint8_t one_byte[] = { 0x20, 0x21 };
	CHECK(evo_kermit_packet_remainder(0x20, one_byte, &remainder) == 0);
	CHECK(remainder == 3);

	static const uint8_t zero_bytes[] = { 0x20, 0x20 };
	CHECK(evo_kermit_packet_remainder(0x20, zero_bytes, &remainder) == ERR_INVALID_PACKET);
	static const uint8_t invalid_bytes[] = { 0x00, 0x00 };
	CHECK(evo_kermit_packet_remainder(0x20, invalid_bytes, &remainder) == ERR_INVALID_PACKET);

	static const uint8_t largest[] = { 0x35, 0x4d }; // 21 * 95 + 45 = 2040, as advertised in SINIT
	CHECK(evo_kermit_packet_remainder(0x20, largest, &remainder) == 0);
	CHECK(remainder == 2042);
	static const uint8_t too_large[] = { 0x35, 0x4e };
	CHECK(evo_kermit_packet_remainder(0x20, too_large, &remainder) == ERR_INVALID_PACKET);
}

static void check_packet_sequences(void)
{
	CHECK(evo_kermit_sequence_state(0, 0, 42) == EVO_KERMIT_SEQUENCE_CURRENT);
	CHECK(evo_kermit_sequence_state(1, 12, 13) == EVO_KERMIT_SEQUENCE_CURRENT);
	CHECK(evo_kermit_sequence_state(1, 12, 12) == EVO_KERMIT_SEQUENCE_DUPLICATE);
	CHECK(evo_kermit_sequence_state(1, 12, 14) == EVO_KERMIT_SEQUENCE_UNEXPECTED);
	CHECK(evo_kermit_sequence_state(1, 63, 0) == EVO_KERMIT_SEQUENCE_CURRENT);
	CHECK(evo_kermit_sequence_state(1, 63, 63) == EVO_KERMIT_SEQUENCE_DUPLICATE);
}

static void check_receive_limits(void)
{
	CHECK(evo_kermit_duplicate_retry_allowed(3));
	CHECK(!evo_kermit_duplicate_retry_allowed(4));
	CHECK(evo_kermit_size_within_limit(8, 4, 12));
	CHECK(!evo_kermit_size_within_limit(8, 5, 12));
	CHECK(!evo_kermit_size_within_limit(13, 0, 12));
	CHECK(!evo_kermit_size_within_limit((size_t)-1, 1, (size_t)-1));
}

static void check_cbor_container_bounds(void)
{
	static const uint8_t oversized_array[] = { 0x98, 0x18 };
	static const uint8_t oversized_map[] = { 0xb8, 0x18 };
	static const uint8_t incomplete_map[] = { 0xa1, 0x61, 'x' };
	const uint8_t *invalid[] = { oversized_array, oversized_map, incomplete_map };
	const size_t invalid_sizes[] = { sizeof(oversized_array), sizeof(oversized_map), sizeof(incomplete_map) };

	for (size_t i = 0; i < sizeof(invalid) / sizeof(invalid[0]); i++)
	{
		size_t off = 0;
		EvoCborValue value;
		CHECK(evo_cbor_parse(invalid[i], invalid_sizes[i], &off, &value) == 0);
		evo_cbor_free(&value);
	}

	static const uint8_t valid_array[] = { 0x82, 0xf6, 0xf6 };
	size_t off = 0;
	EvoCborValue value;
	CHECK(evo_cbor_parse(valid_array, sizeof(valid_array), &off, &value) == 1);
	CHECK(value.kind == EVO_CBOR_ARRAY);
	CHECK(value.len == 2);
	evo_cbor_free(&value);

	static const uint8_t valid_map[] = { 0xa1, 0x61, 'x', 0xf6 };
	off = 0;
	CHECK(evo_cbor_parse(valid_map, sizeof(valid_map), &off, &value) == 1);
	CHECK(value.kind == EVO_CBOR_MAP);
	CHECK(value.len == 1);
	evo_cbor_free(&value);
}

int main(void)
{
	check_packet_lengths();
	check_packet_sequences();
	check_receive_limits();
	check_cbor_container_bounds();
	return 0;
}
