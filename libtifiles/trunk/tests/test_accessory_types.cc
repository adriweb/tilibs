#include <cstdio>
#include <cstdlib>
#include <cstring>
#include "../src/tifiles.h"

#define CHECK(c) do { if (!(c)) { std::fprintf(stderr, "%d: %s\n", __LINE__, #c); std::abort(); } } while (0)

struct TypeCase
{
	uint8_t id;
	const char *type;
	const char *description;
};

static const TypeCase cbl2_types[] =
{
	{ 0x07, "STR",     "String" },
	{ 0x08, "LIST",    "List" },
	{ 0x0A, "SETUP",   "Setup" },
	{ 0x0D, "DATA",    "Normal data list" },
	{ 0x1F, "DIR",     "Full Directory" },
	{ 0x23, "AMS",     "OS upgrade" },
	{ 0x29, "APPL",    "User Flash Application" },
	{ 0x2A, "ARCHIVE", "Archive record" },
	{ 0xF0, "INFO",    "Information" },
};

static const TypeCase presenter_types[] =
{
	{ 0x1F, "DIR",  "Full Directory" },
	{ 0x23, "AMS",  "OS upgrade" },
	{ 0xF0, "INFO", "Information" },
};

static void check_types(CalcModel model, const TypeCase *types, size_t count)
{
	for (size_t i = 0; i < count; i++)
	{
		CHECK(!std::strcmp(tifiles_vartype2string(model, types[i].id), types[i].type));
		CHECK(!std::strcmp(tifiles_vartype2type(model, types[i].id), types[i].description));
		CHECK(!std::strcmp(tifiles_vartype2icon(model, types[i].id), types[i].description));
		CHECK(tifiles_string2vartype(model, types[i].type) == types[i].id);
	}
	CHECK(!tifiles_vartype2string(model, 0)[0]);
	CHECK(!std::strcmp(tifiles_vartype2type(model, 0), "Unknown"));
	CHECK(!std::strcmp(tifiles_vartype2icon(model, 0), "Unknown"));
	CHECK(tifiles_string2vartype(model, "UNKNOWN") == (uint8_t)-1);
}

int main()
{
	tifiles_library_init();
	const CalcModel cbl2_models[] = { CALC_CBL2, CALC_LABPRO, CALC_LABPRO_USB };
	for (CalcModel model : cbl2_models)
	{
		check_types(model, cbl2_types, sizeof(cbl2_types) / sizeof(cbl2_types[0]));
		CHECK(tifiles_folder_type(model) == (uint8_t)-1);
		CHECK(tifiles_flash_type(model) == 0x29);
		CHECK(!std::strcmp(tifiles_vartype2fext(model, 0x23), "c2u"));
		CHECK(!std::strcmp(tifiles_vartype2fext(model, 0x29), "c2u"));
		CHECK(tifiles_fext2vartype(model, "c2u") == 0x23);
		CHECK(tifiles_fext2vartype(model, "bogus") == (uint8_t)-1);
	}
	check_types(CALC_TIPRESENTER, presenter_types, sizeof(presenter_types) / sizeof(presenter_types[0]));
	CHECK(tifiles_folder_type(CALC_TIPRESENTER) == (uint8_t)-1);
	CHECK(tifiles_flash_type(CALC_TIPRESENTER) == (uint8_t)-1);
	CHECK(!std::strcmp(tifiles_vartype2fext(CALC_TIPRESENTER, 0x23), "hex"));
	CHECK(tifiles_fext2vartype(CALC_TIPRESENTER, "hex") == 0x23);
	CHECK(tifiles_fext2vartype(CALC_TIPRESENTER, "bogus") == (uint8_t)-1);
	tifiles_library_exit();
	std::puts("Accessory vartype tables passed");
}
