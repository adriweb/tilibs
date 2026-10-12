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

static void check_ti73_types()
{
	CHECK(TI73_CATLIST == 0x0d);
	CHECK(strcmp(tifiles_vartype2string(CALC_TI73, TI73_CATLIST), "CATLIST") == 0);
	CHECK(strcmp(tifiles_vartype2fext(CALC_TI73, TI73_CATLIST), "73l") == 0);
	CHECK(strcmp(tifiles_vartype2type(CALC_TI73, TI73_CATLIST), "Categorical List") == 0);
	const uint8_t types[] = {TI73_RED_SIMPLE_FRAC, TI73_RED_MIXED_FRAC,
	                         TI73_UNRED_SIMPLE_FRAC, TI73_UNRED_MIXED_FRAC};
	const char *names[] = {"RFRAC", "RMFRAC", "UFRAC", "UMFRAC"};
	for (size_t i = 0; i < 4; i++)
	{
		CHECK(types[i] == 0x14 + i);
		CHECK(strcmp(tifiles_vartype2fext(CALC_TI73, types[i]), "73n") == 0);
		CHECK(strcmp(tifiles_vartype2string(CALC_TI73, types[i]), names[i]) == 0);
		CHECK(tifiles_string2vartype(CALC_TI73, names[i]) == types[i]);
	}
	// Shared extensions keep their existing canonical import type.
	CHECK(tifiles_fext2vartype(CALC_TI73, "73l") == TI73_LIST);
	CHECK(tifiles_fext2vartype(CALC_TI73, "73n") == TI73_REAL);
	const char list_name[9] = {0x5d, 0x01, 0, 0, 0, 0, 0, 0, 0};
	char *real_list = ticonv_varname_detokenize(CALC_TI73, list_name, TI73_LIST);
	char *category_list = ticonv_varname_detokenize(CALC_TI73, list_name, TI73_CATLIST);
	CHECK(real_list && category_list && strcmp(real_list, category_list) == 0);
	ticonv_varname_free(real_list);
	ticonv_varname_free(category_list);
}

int main()
{
	tifiles_library_init();
	check_ti73_types();
	tifiles_library_exit();
	puts("TI-73 type tests passed");
	return 0;
}
