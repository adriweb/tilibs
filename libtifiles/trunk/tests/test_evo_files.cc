#ifdef HAVE_CONFIG_H
#include <config.h>
#endif

#include <glib.h>
#include <glib/gstdio.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "../src/tifiles.h"

static void append_u16(GByteArray *out, uint16_t word)
{
	const uint8_t bytes[] = { (uint8_t)(word & 0xff), (uint8_t)(word >> 8) };
	g_byte_array_append(out, bytes, sizeof(bytes));
}

static void append_cbor_text(GByteArray *out, const char *text)
{
	const size_t len = strlen(text);
	g_assert_cmpuint(len, <, 24);
	const uint8_t head = (uint8_t)(0x60 | len);
	g_byte_array_append(out, &head, 1);
	g_byte_array_append(out, (const uint8_t *)text, len);
}

static void append_cbor_uint(GByteArray *out, uint8_t value)
{
	g_assert_cmpuint(value, <, 24);
	g_byte_array_append(out, &value, 1);
}

static void append_cbor_bytes(GByteArray *out, const GByteArray *bytes)
{
	g_assert_cmpuint(bytes->len, <, 24);
	const uint8_t head = (uint8_t)(0x40 | bytes->len);
	g_byte_array_append(out, &head, 1);
	g_byte_array_append(out, bytes->data, bytes->len);
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

static const char *evo_type_ext(uint8_t type)
{
	switch (type)
	{
	case 0: return "8xn2";
	case 1: return "8xl2";
	case 2: return "8xp2";
	case 3: return "8xd2";
	case 4: return "8ci2";
	case 5: return "8ca2";
	case 6: return "8xm2";
	case 7: return "8xy2";
	case 8: return "8xv2";
	case 9: return "8xg2";
	case 10: return "8xs2";
	case 11: return "8ek2";
	case 12: return "8xw2";
	case 13: return "8xz2";
	case 14: return "8xt2";
	case 15: return "8xpy2";
	default: return "8xv2";
	}
}

static char *write_evo_file(const char *dir, uint8_t type, const GByteArray *tok_name)
{
	GByteArray *body = g_byte_array_new();
	const uint8_t map = 0xbf;
	const uint8_t end = 0xff;
	g_byte_array_append(body, &map, 1);
	append_cbor_text(body, "metaData");
	g_byte_array_append(body, &map, 1);
	append_cbor_text(body, "type");
	append_cbor_uint(body, type);
	append_cbor_text(body, "version");
	append_cbor_uint(body, 1);
	append_cbor_text(body, "name");
	append_cbor_bytes(body, tok_name);
	g_byte_array_append(body, &end, 1);
	append_cbor_text(body, "version");
	append_cbor_uint(body, 1);
	append_cbor_text(body, "size");
	append_cbor_uint(body, 0);
	append_cbor_text(body, "data");
	const uint8_t empty = 0x40;
	g_byte_array_append(body, &empty, 1);
	g_byte_array_append(body, &end, 1);

	const uint16_t checksum = evo_file_checksum(body->data, body->len);
	const uint8_t checksum_bytes[] = { (uint8_t)(checksum >> 8), (uint8_t)(checksum & 0xff) };
	g_byte_array_append(body, checksum_bytes, sizeof(checksum_bytes));

	char *path = g_strdup_printf("%s/evo_%u.%s", dir, (unsigned int)g_test_rand_int(), evo_type_ext(type));
	g_assert_true(g_file_set_contents(path, (const char *)body->data, (gssize)body->len, nullptr));
	g_byte_array_free(body, TRUE);
	return path;
}

static void assert_evo_entry_name(uint8_t type, const GByteArray *tok_name, const char *expected)
{
	char *dir = g_dir_make_tmp("tilibs-evo-test-XXXXXX", nullptr);
	g_assert_nonnull(dir);
	char *path = write_evo_file(dir, type, tok_name);

	FileContent *content = tifiles_content_create_regular(CALC_TI84EVO_USB);
	g_assert_nonnull(content);
	g_assert_cmpint(tifiles_file_read_regular(path, content), ==, 0);
	g_assert_cmpuint(content->num_entries, ==, 1);
	g_assert_nonnull(content->entries);
	g_assert_nonnull(content->entries[0]);
	g_assert_cmpuint(content->entries[0]->type, ==, type);
	g_assert_cmpstr(content->entries[0]->name, ==, expected);

	tifiles_content_delete_regular(content);
	g_remove(path);
	g_rmdir(dir);
	g_free(path);
	g_free(dir);
}

static GByteArray *tok_words(const uint16_t *words, size_t count)
{
	GByteArray *tok = g_byte_array_new();
	for (size_t i = 0; i < count; i++)
	{
		append_u16(tok, words[i]);
	}
	append_u16(tok, 0);
	return tok;
}

static void test_evo_real_name(void)
{
	const uint16_t word = 0xe81a;
	GByteArray *tok = tok_words(&word, 1);
	assert_evo_entry_name(0, tok, "theta");
	g_byte_array_free(tok, TRUE);
}

static void test_evo_builtin_lists(void)
{
	for (uint16_t i = 0; i < 6; i++)
	{
		const uint16_t word = (uint16_t)(0xe830 + i);
		GByteArray *tok = tok_words(&word, 1);
		char expected[4];
		snprintf(expected, sizeof(expected), "L%u", (unsigned int)i + 1);
		assert_evo_entry_name(1, tok, expected);
		g_byte_array_free(tok, TRUE);
	}
}

static void test_evo_custom_list_name(void)
{
	const uint16_t words[] = { 0xe836, 0xe800, 0xe81a, 0xe400, '1' };
	GByteArray *tok = tok_words(words, G_N_ELEMENTS(words));
	assert_evo_entry_name(1, tok, "Atheta_1");
	g_byte_array_free(tok, TRUE);
}

static void test_evo_invalid_custom_name_falls_back(void)
{
	const uint16_t words[] = { 0xe836, 0xe800, 0xe8ff };
	GByteArray *tok = tok_words(words, G_N_ELEMENTS(words));
	assert_evo_entry_name(1, tok, "VAR");
	g_byte_array_free(tok, TRUE);
}

static void test_evo_program_name(void)
{
	const uint16_t words[] = { 0xe807, 0xe804, 0xe80b, 0xe80b, 0xe80e };
	GByteArray *tok = tok_words(words, G_N_ELEMENTS(words));
	assert_evo_entry_name(2, tok, "HELLO");
	g_byte_array_free(tok, TRUE);
}

static void test_evo_builtin_matrix(void)
{
	const uint16_t word = 0xe820;
	GByteArray *tok = tok_words(&word, 1);
	assert_evo_entry_name(6, tok, "A");
	g_byte_array_free(tok, TRUE);
}

static void test_evo_appvar_name(void)
{
	const uint16_t words[] = { 0xe802, 0xe805, 0xe806, 0xe400, '1' };
	GByteArray *tok = tok_words(words, G_N_ELEMENTS(words));
	assert_evo_entry_name(8, tok, "CFG_1");
	g_byte_array_free(tok, TRUE);
}

static void assert_fixture_entry(const char *fixture_dir, const char *filename, uint8_t expected_type, const char *expected_name)
{
	char *path = g_build_filename(fixture_dir, filename, nullptr);
	g_assert_nonnull(path);
	g_assert_true(g_file_test(path, G_FILE_TEST_EXISTS));

	FileContent *content = tifiles_content_create_regular(CALC_TI84EVO_USB);
	g_assert_nonnull(content);
	g_assert_cmpint(tifiles_file_read_regular(path, content), ==, 0);
	g_assert_cmpuint(content->num_entries, ==, 1);
	g_assert_nonnull(content->entries);
	g_assert_nonnull(content->entries[0]);
	g_assert_cmpuint(content->entries[0]->type, ==, expected_type);
	g_assert_cmpstr(content->entries[0]->name, ==, expected_name);

	tifiles_content_delete_regular(content);
	g_free(path);
}

static void test_evo_external_fixtures(void)
{
	const char *fixture_dir = g_getenv("TILIBS_EVO_FIXTURE_DIR");
	if (fixture_dir == nullptr || *fixture_dir == 0)
	{
		g_test_skip("set TILIBS_EVO_FIXTURE_DIR to run Evo fixture tests");
		return;
	}

	assert_fixture_entry(fixture_dir, "A.8xn2", 0, "A");
	assert_fixture_entry(fixture_dir, "Z.8xn2", 0, "Z");
	assert_fixture_entry(fixture_dir, "L1.8xl2", 1, "L1");
	assert_fixture_entry(fixture_dir, "L6.8xl2", 1, "L6");
	assert_fixture_entry(fixture_dir, "ABC.8xl2", 1, "ABC");
	assert_fixture_entry(fixture_dir, "XXX.8xl2", 1, "XXX");
	assert_fixture_entry(fixture_dir, "EMPTY.8xp2", 2, "EMPTY");
	assert_fixture_entry(fixture_dir, "ONELINE.8xp2", 2, "ONELINE");
	assert_fixture_entry(fixture_dir, "PREC.8xp2", 2, "PREC");
	assert_fixture_entry(fixture_dir, "SEUIL.8xp2", 2, "SEUIL");
	assert_fixture_entry(fixture_dir, "A.8xm2", 6, "A");
	assert_fixture_entry(fixture_dir, "F.8xm2", 6, "F");
	assert_fixture_entry(fixture_dir, "EqnsCnfg.8xv2", 8, "EqnsCnfg");
	assert_fixture_entry(fixture_dir, "PolyCnfg.8xv2", 8, "PolyCnfg");
	assert_fixture_entry(fixture_dir, "Pic1.8ci2", 4, "Pic1");
	assert_fixture_entry(fixture_dir, "Image1.8ca2", 5, "Image1");
	assert_fixture_entry(fixture_dir, "Window.8xw2", 12, "Window");
	assert_fixture_entry(fixture_dir, "RclWindw.8xz2", 13, "RclWindw");
	assert_fixture_entry(fixture_dir, "TblSet.8xt2", 14, "TblSet");
	assert_fixture_entry(fixture_dir, "HELLO.8xpy2", 15, "HELLO");
}

int main(int argc, char **argv)
{
	tifiles_library_init();
	g_test_init(&argc, &argv, nullptr);
	g_test_add_func("/evo/files/real-name", test_evo_real_name);
	g_test_add_func("/evo/files/builtin-lists", test_evo_builtin_lists);
	g_test_add_func("/evo/files/custom-list-name", test_evo_custom_list_name);
	g_test_add_func("/evo/files/invalid-custom-name-fallback", test_evo_invalid_custom_name_falls_back);
	g_test_add_func("/evo/files/program-name", test_evo_program_name);
	g_test_add_func("/evo/files/builtin-matrix", test_evo_builtin_matrix);
	g_test_add_func("/evo/files/appvar-name", test_evo_appvar_name);
	g_test_add_func("/evo/files/external-fixtures", test_evo_external_fixtures);
	const int ret = g_test_run();
	tifiles_library_exit();
	return ret;
}
