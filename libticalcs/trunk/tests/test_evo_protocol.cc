#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <initializer_list>
#include <vector>

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

static std::vector<std::vector<uint8_t>> sent_payloads;
static const char *first_error;
static const char *second_error;
static const char *expected_url;

static int mock_put(CalcHandle *, const char *url, const uint8_t *data, size_t size)
{
	CHECK(!strcmp(url, expected_url));
	const char *error = sent_payloads.empty() ? first_error : second_error;
	sent_payloads.emplace_back(data, data + size);
	CHECK(sent_payloads.size() <= 2);
	return error ? ticalcs_evo_error_set((const uint8_t *)error, strlen(error)) : 0;
}

static void check_python_wrapper_fallback(void)
{
	// Independent, checksummed legacy fixture: name m, no menu, MPY v5.
	const uint8_t old_file[] = {
		0xbf, 0x68, 0x6d, 0x65, 0x74, 0x61, 0x44, 0x61, 0x74, 0x61, 0xbf, 0x64, 0x74, 0x79, 0x70, 0x65,
		0x0f, 0x67, 0x76, 0x65, 0x72, 0x73, 0x69, 0x6f, 0x6e, 0x01, 0x64, 0x6e, 0x61, 0x6d, 0x65, 0x42,
		0x0c, 0xe8, 0xff, 0x67, 0x76, 0x65, 0x72, 0x73, 0x69, 0x6f, 0x6e, 0x01, 0x64, 0x73, 0x69, 0x7a,
		0x65, 0x18, 0x18, 0x64, 0x64, 0x61, 0x74, 0x61, 0x58, 0x18, 0x13, 0x02, 0xd8, 0x20, 0x18, 0x00,
		0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x6d, 0x00, 0x05, 0x00, 0x00, 0x02, 0x4d, 0x05, 0x03, 0x1f,
		0x00, 0x00, 0xff, 0xea, 0x7d
	};
	uint8_t *new_file = nullptr;
	uint32_t new_size = 0;
	CHECK(tifiles_evo_repack_python_module(old_file, sizeof(old_file), &new_file, &new_size) == 0);
	for (const int modern : {0, 1})
	{
		VarEntry entry = {};
		strcpy(entry.name, "M");
		entry.type = modern ? 18 : 15;
		entry.data = modern ? new_file : const_cast<uint8_t *>(old_file);
		entry.size = modern ? new_size : sizeof(old_file);
		const std::vector<uint8_t> original(entry.data, entry.data + entry.size);
		const std::vector<uint8_t> converted = modern
		    ? std::vector<uint8_t>(old_file, old_file + sizeof(old_file))
		    : std::vector<uint8_t>(new_file, new_file + new_size);
		for (const char *error : {"", "DP", "PM", "NM", "TO", "VE", "D"})
		{
			for (const char *retry_error : {"", "DP", "NM"})
			{
				sent_payloads.clear();
				first_error = *error ? error : nullptr;
				second_error = *retry_error ? retry_error : nullptr;
				expected_url = "hh01/xfr/var?memtarget=1&policy=1";
				const bool retry = !strcmp(error, "DP");
				const char *expected_error = retry ? second_error : first_error;
				const int result = evo_send_file_payload(nullptr, &entry, mock_put);
				CHECK(result == (expected_error ? ERR_EVO_ERROR : 0));
				CHECK(sent_payloads.size() == (retry ? 2 : 1));
				CHECK(sent_payloads[0] == original);
				if (retry) CHECK(sent_payloads[1] == converted);
				CHECK(std::vector<uint8_t>(entry.data, entry.data + entry.size) == original);
				CHECK(entry.attr == ATTRB_NONE);
				if (expected_error && strlen(expected_error) == 2)
				{
					uint16_t code = 0;
					CHECK(ticalcs_error_get_raw_protocol_code(result, &code) == 0);
					CHECK(code == ((unsigned int)expected_error[0] << 8 | expected_error[1]));
				}
			}
		}
	}
	// Unrecognized type 18 stays Archive-only but cannot be converted on DP.
	// Unrecognized/source type 15 keeps the caller's selected memory target.
	for (const uint8_t type : {15, 18})
	{
		VarEntry entry = {};
		entry.type = type;
		uint8_t opaque[] = {0x13, 1, 0, 0};
		entry.data = opaque; entry.size = sizeof(opaque);
		for (const FileAttr attr : {ATTRB_NONE, ATTRB_ARCHIVED})
		{
			entry.attr = attr;
			expected_url = type == 18 || attr == ATTRB_ARCHIVED
			    ? "hh01/xfr/var?memtarget=1&policy=1" : "hh01/xfr/var?memtarget=0&policy=1";
			sent_payloads.clear(); first_error = "DP"; second_error = nullptr;
			CHECK(evo_send_file_payload(nullptr, &entry, mock_put) == ERR_EVO_ERROR);
			CHECK(sent_payloads.size() == 1);
		}
	}
	tifiles_ve_free_data(new_file);
}

int main(void)
{
	check_packet_lengths();
	check_packet_sequences();
	check_receive_limits();
	check_cbor_container_bounds();
	check_python_wrapper_fallback();
	return 0;
}
