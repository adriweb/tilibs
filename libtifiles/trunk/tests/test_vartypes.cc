#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../src/tifiles.h"

#define CHECK(condition) \
	do { \
		if (!(condition)) { \
			fprintf(stderr, "%s:%d: check failed: %s\n", __FILE__, __LINE__, #condition); \
			abort(); \
		} \
	} while (0)

struct VartypeExtensionCase
{
	CalcModel model;
	uint8_t vartype;
	const char *type;
	const char *extension;
};

static void check_ti85_ti86_extensions()
{
	const VartypeExtensionCase cases[] = {
		{CALC_TI82, TI82_ZSTO,  "ZSTO",  "82z"},
		{CALC_TI85, TI85_CONS,  "CONS",  "85k"},
		{CALC_TI85, TI85_CCONS, "CCONS", "85k"},
		{CALC_TI85, TI85_EQU,   "EQU",   "85e"},
		{CALC_TI85, TI85_FUNC,  "WND",   "85r"},
		{CALC_TI85, TI85_POL,   "POLAR", "85r"},
		{CALC_TI85, TI85_PARAM, "PARAM", "85r"},
		{CALC_TI85, TI85_DIFEQ, "DIFEQ", "85r"},
		{CALC_TI85, TI85_ZRCL,  "ZRCL",  "85r"},
		{CALC_TI86, TI86_CONS,  "CONS",  "86k"},
		{CALC_TI86, TI86_CCONS, "CCONS", "86k"},
		{CALC_TI86, TI86_EQU,   "EQU",   "86e"},
	};

	for (const VartypeExtensionCase &test : cases)
	{
		CHECK(strcmp(tifiles_vartype2string(test.model, test.vartype), test.type) == 0);
		CHECK(strcmp(tifiles_vartype2fext(test.model, test.vartype), test.extension) == 0);
		CHECK(tifiles_string2vartype(test.model, test.type) == test.vartype);
	}

	// Shared extensions keep their first table entry as the canonical import type.
	CHECK(tifiles_fext2vartype(CALC_TI82, "82w") == TI82_WDW);
	CHECK(tifiles_fext2vartype(CALC_TI82, "82z") == TI82_ZSTO);
	CHECK(tifiles_fext2vartype(CALC_TI85, "85k") == TI85_CONS);
	CHECK(tifiles_fext2vartype(CALC_TI85, "85r") == TI85_RANGE);
	CHECK(tifiles_fext2vartype(CALC_TI86, "86k") == TI86_CONS);
	CHECK(tifiles_fext2vartype(CALC_TI85, "85e") == TI85_EQU);
	CHECK(tifiles_fext2vartype(CALC_TI86, "86e") == TI86_EQU);

	// Bit 5 marks selected equations in the TI-85 and TI-86 VAT. Treat those
	// flagged values as equation aliases while keeping the base ID canonical.
	CHECK(strcmp(tifiles_vartype2string(CALC_TI85, TI85_EQU_SELECTED), "EQU") == 0);
	CHECK(strcmp(tifiles_vartype2fext(CALC_TI85, TI85_EQU_SELECTED), "85e") == 0);
	CHECK(tifiles_string2vartype(CALC_TI85, "EQU") == TI85_EQU);
	CHECK(strcmp(tifiles_vartype2string(CALC_TI86, TI86_EQU_SELECTED), "EQU") == 0);
	CHECK(strcmp(tifiles_vartype2fext(CALC_TI86, TI86_EQU_SELECTED), "86e") == 0);
	CHECK(tifiles_string2vartype(CALC_TI86, "EQU") == TI86_EQU);
}

int main()
{
	tifiles_library_init();
	check_ti85_ti86_extensions();
	tifiles_library_exit();
	puts("Variable type tests passed");
	return 0;
}
