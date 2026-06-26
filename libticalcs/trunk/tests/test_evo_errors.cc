#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ticalcs.h"
#include "../src/error.h"

#define CHECK(condition) \
	do { \
		if (!(condition)) { \
			fprintf(stderr, "%s:%d: check failed: %s\n", __FILE__, __LINE__, #condition); \
			abort(); \
		} \
	} while (0)

typedef struct
{
	const char *code;
	const char *description;
} ExpectedEvoResult;

static const ExpectedEvoResult expected_results[] = {
	{ "OK", "Successful transfer" },
	{ "ER", "Unknown error" },
	{ "PM", "Bad parameter" },
	{ "NP", "No port" },
	{ "NM", "No memory" },
	{ "FL", "Flash" },
	{ "IN", "Invalid" },
	{ "NC", "Not found (client)" },
	{ "NF", "Not found (server)" },
	{ "CN", "Cancel" },
	{ "TO", "Timeout" },
	{ "DI", "Disconnect" },
	{ "UN", "Unsupported request" },
	{ "NV", "Version too new" },
	{ "VE", "Variable already exists" },
	{ "DP", "Invalid data payload" },
	{ "BZ", "Calculator is busy" },
	{ "LB", "Low battery" },
	{ "WT", "Wait for user action" },
	{ "OW", "User overwrite" },
	{ "OA", "User overwrite all" },
	{ "OM", "User omit" },
	{ "QU", "User quit" },
	{ "NR", "User not in receive" },
	{ "DR", "Defrag initiated" },
};

static void check_known_results(void)
{
	for (size_t i = 0; i < sizeof(expected_results) / sizeof(expected_results[0]); i++)
	{
		const ExpectedEvoResult *expected = &expected_results[i];
		CHECK(ticalcs_evo_error_set((const uint8_t *)expected->code, 2) == ERR_EVO_ERROR);

		char *message = nullptr;
		CHECK(ticalcs_error_get(ERR_EVO_ERROR, &message) == 0);
		CHECK(message != nullptr);
		CHECK(strstr(message, expected->code) != nullptr);
		CHECK(strstr(message, expected->description) != nullptr);

		uint16_t raw = 0;
		CHECK(ticalcs_error_get_raw_protocol_code(ERR_EVO_ERROR, &raw) == 0);
		CHECK(raw == (uint16_t)(((uint16_t)(uint8_t)expected->code[0] << 8) |
		                          (uint16_t)(uint8_t)expected->code[1]));
		CHECK(ticalcs_error_free(message) == 0);
	}
}

static void check_unknown_result(void)
{
	static const uint8_t wire[] = { 'X', 'Y' };
	CHECK(ticalcs_evo_error_set(wire, sizeof(wire)) == ERR_EVO_ERROR);

	char *message = nullptr;
	CHECK(ticalcs_error_get(ERR_EVO_ERROR, &message) == 0);
	CHECK(strstr(message, "unknown result XY") != nullptr);
	ticalcs_error_free(message);

	uint16_t raw = 0;
	CHECK(ticalcs_error_get_raw_protocol_code(ERR_EVO_ERROR, &raw) == 0);
	CHECK(raw == 0x5859);
}

static void check_malformed_result(void)
{
	static const uint8_t wire[] = { 'X' };
	CHECK(ticalcs_evo_error_set(wire, sizeof(wire)) == ERR_EVO_ERROR);

	char *message = nullptr;
	CHECK(ticalcs_error_get(ERR_EVO_ERROR, &message) == 0);
	CHECK(strstr(message, "without a two-letter result code") != nullptr);
	ticalcs_error_free(message);

	uint16_t raw = 0;
	CHECK(ticalcs_error_get_raw_protocol_code(ERR_EVO_ERROR, &raw) == ERR_EVO_ERROR);
}

int main(void)
{
	check_known_results();
	check_unknown_result();
	check_malformed_result();
	return 0;
}
