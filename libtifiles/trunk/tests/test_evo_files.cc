#ifdef HAVE_CONFIG_H
#include <config.h>
#endif

#include <glib.h>
#include <glib/gstdio.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <initializer_list>
#include <utility>

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

static void append_cbor_arg(GByteArray *out, uint8_t major, uint32_t value)
{
	const uint8_t head = major | (value < 24 ? value : value < 256 ? 24 : value < 65536 ? 25 : 26);
	g_byte_array_append(out, &head, 1);
	const int count = value < 24 ? 0 : value < 256 ? 1 : value < 65536 ? 2 : 4;
	for (int i = count - 1; i >= 0; i--)
	{
		const uint8_t byte = (uint8_t)(value >> (i * 8));
		g_byte_array_append(out, &byte, 1);
	}
}

static void append_cbor_uint(GByteArray *out, uint32_t value)
{
	append_cbor_arg(out, 0, value);
}

static void append_cbor_bytes(GByteArray *out, const GByteArray *bytes)
{
	append_cbor_arg(out, 0x40, bytes->len);
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
	case 18: return "8mp2";
	default: return "8xv2";
	}
}

static char *write_evo_file(const char *dir, uint8_t type, const GByteArray *tok_name, const GByteArray *payload = nullptr)
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
	if (type == 18)
	{
		append_cbor_text(body, "flags");
		append_cbor_uint(body, 1);
	}
	append_cbor_text(body, "name");
	append_cbor_bytes(body, tok_name);
	g_byte_array_append(body, &end, 1);
	append_cbor_text(body, "version");
	append_cbor_uint(body, 1);
	append_cbor_text(body, "size");
	append_cbor_uint(body, payload ? payload->len : 0);
	append_cbor_text(body, "data");
	if (payload)
	{
		append_cbor_bytes(body, payload);
	}
	else
	{
		const uint8_t empty = 0x40;
		g_byte_array_append(body, &empty, 1);
	}
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

static void test_evo_python_module(void)
{
	const CalcModel models[] = { CALC_TI84EVO_USB, CALC_TI83EVO_USB, CALC_TI84EVOT_USB };
	const uint16_t words[] = { 0xe813, 0xe808, 0xe400, 0xe803, 0xe811, 0xe800, 0xe816 };
	GByteArray *tok = tok_words(words, G_N_ELEMENTS(words));
	// File transport treats module data as opaque, including any trailing byte.
	const uint8_t bytes[] = { 0x13, 0x02, 0xd8, 0x20, 0x00, 0x4d, 0x05, 0x03, 0x1f, 0xa5 };
	GByteArray *payload = g_byte_array_new();
	g_byte_array_append(payload, bytes, sizeof(bytes));
	char *dir = g_dir_make_tmp("tilibs-evo-mpy-test-XXXXXX", nullptr);
	g_assert_nonnull(dir);
	char *path = write_evo_file(dir, 18, tok, payload);
	char *upper_path = g_strconcat(dir, "/TI_DRAW.8MP2", nullptr);
	g_assert_cmpint(g_rename(path, upper_path), ==, 0);
	char *output = g_strconcat(dir, "/roundtrip.8mp2", nullptr);
	gchar *original = nullptr;
	gsize original_size = 0;
	g_assert_true(g_file_get_contents(upper_path, &original, &original_size, nullptr));

	for (size_t i = 0; i < G_N_ELEMENTS(models); i++)
	{
		const CalcModel model = models[i];
		g_assert_cmpstr(tifiles_vartype2string(model, 18), ==, "MPY");
		g_assert_cmpuint(tifiles_string2vartype(model, "MPY"), ==, 18);
		g_assert_cmpstr(tifiles_vartype2fext(model, 18), ==, "8mp2");
		g_assert_cmpuint(tifiles_fext2vartype(model, "8MP2"), ==, 18);
		g_assert_cmpstr(tifiles_vartype2type(model, 18), ==, "Python Module");
		g_assert_cmpstr(tifiles_vartype2fext(model, 15), ==, "8xpy2");
		g_assert_cmpuint(tifiles_fext2vartype(model, "8xpy2"), ==, 15);
		g_assert_true(tifiles_file_is_ti(upper_path));
		g_assert_cmpint(tifiles_file_get_class(upper_path), ==, TIFILE_SINGLE);
		FileContent *content = tifiles_content_create_regular(model);
		g_assert_cmpint(tifiles_file_read_regular(upper_path, content), ==, 0);
		g_assert_cmpint(content->model, ==, model);
		g_assert_cmpuint(content->num_entries, ==, 1);
		const VarEntry *entry = content->entries[0];
		g_assert_cmpstr(entry->name, ==, "TI_DRAW");
		g_assert_cmpuint(entry->type, ==, 18);
		g_assert_cmpint(entry->attr, ==, ATTRB_ARCHIVED);
		g_assert_cmpmem(entry->data, entry->size, original, original_size);
		g_assert_cmpint(tifiles_file_write_regular(output, content, nullptr), ==, 0);
		gchar *roundtrip = nullptr;
		gsize roundtrip_size = 0;
		g_assert_true(g_file_get_contents(output, &roundtrip, &roundtrip_size, nullptr));
		g_assert_cmpmem(roundtrip, roundtrip_size, original, original_size);
		g_free(roundtrip);
		tifiles_content_delete_regular(content);
	}
	g_free(original);
	g_remove(output);
	g_remove(upper_path);
	g_rmdir(dir);
	g_free(output);
	g_free(upper_path);
	g_free(path);
	g_free(dir);
	g_byte_array_free(tok, TRUE);
	g_byte_array_free(payload, TRUE);
}

static void check_evo_python_repack(unsigned int mpy_size, std::initializer_list<uint8_t> tail)
{
	char *dir = g_dir_make_tmp("tilibs-evo-repack-XXXXXX", nullptr);
	const uint16_t word = 0xe80c; // M
	GByteArray *tok = tok_words(&word, 1);
	{
		// Object: name M, menu, MPY; tests both CBOR uint16 and uint32 lengths.
		const uint8_t prefix[] = {0x13, 2, 0xd8, 0x20, 0, 0, 0, 0,
		    1, 0, 0, 0, 'M', 0, 2, 0, 0, 1, '#', '\n', 0};
		GByteArray *payload = g_byte_array_new();
		g_byte_array_append(payload, prefix, sizeof(prefix));
		const uint8_t record[] = {(uint8_t)mpy_size, (uint8_t)(mpy_size >> 8), (uint8_t)(mpy_size >> 16), 2};
		g_byte_array_append(payload, record, sizeof(record));
		const uint8_t mpy[] = {'M', 5, 3, 0x1f};
		g_byte_array_append(payload, mpy, sizeof(mpy));
		for (unsigned int i = 4; i <= mpy_size; i++)
		{
			const uint8_t zero = 0;
			g_byte_array_append(payload, &zero, 1);
		}
		for (unsigned int i = 0; i < 4; i++) payload->data[4 + i] = (uint8_t)(payload->len >> (8 * i));
		for (const uint8_t byte : tail) g_byte_array_append(payload, &byte, 1);
		g_byte_array_set_size(tok, 2);
		char *old_path = write_evo_file(dir, 15, tok, payload);
		append_u16(tok, 0);
		char *new_path = write_evo_file(dir, 18, tok, payload);
		FileContent *old_file = tifiles_content_create_regular(CALC_TI84EVO_USB);
		FileContent *new_file = tifiles_content_create_regular(CALC_TI84EVO_USB);
		g_assert_cmpint(tifiles_file_read_regular(old_path, old_file), ==, 0);
		g_assert_cmpint(tifiles_file_read_regular(new_path, new_file), ==, 0);
		for (const auto pair : {std::make_pair(old_file, new_file), std::make_pair(new_file, old_file)})
		{
			const VarEntry *src = pair.first->entries[0], *dst = pair.second->entries[0];
			g_assert_cmpint(src->attr, ==, ATTRB_ARCHIVED);
			g_assert_true(tifiles_evo_is_python_module(src->data, src->size));
			uint8_t *converted = nullptr;
			uint32_t converted_size = 0;
			g_assert_cmpint(tifiles_evo_repack_python_module(src->data, src->size, &converted, &converted_size), ==, 0);
			g_assert_cmpmem(converted, converted_size, dst->data, dst->size);
			uint8_t *roundtrip = nullptr;
			uint32_t roundtrip_size = 0;
			g_assert_cmpint(tifiles_evo_repack_python_module(converted, converted_size, &roundtrip, &roundtrip_size), ==, 0);
			g_assert_cmpmem(roundtrip, roundtrip_size, src->data, src->size);
			tifiles_ve_free_data(roundtrip);
			tifiles_ve_free_data(converted);
		}
		// Source subtype and incompatible MPY version are never converted.
		for (const unsigned int index : {0U, 1U})
		{
			VarEntry *src = new_file->entries[0];
			const size_t offset = src->size - 3 - payload->len + (index ? sizeof(prefix) + sizeof(record) + 1 : 1);
			const uint8_t saved = src->data[offset];
			src->data[offset] = index ? 6 : 1;
			const uint16_t checksum = evo_file_checksum(src->data, src->size - 2);
			src->data[src->size - 2] = checksum >> 8; src->data[src->size - 1] = checksum;
			uint8_t *converted = nullptr;
			uint32_t converted_size = 0;
			g_assert_cmpint(tifiles_evo_repack_python_module(src->data, src->size, &converted, &converted_size), !=, 0);
			g_assert_null(converted);
			src->data[offset] = saved;
		}
		// Truncations must not read past the supplied buffer.
		const VarEntry *src = old_file->entries[0];
		for (uint32_t len = 0; len < src->size; len += (mpy_size > 100 ? 997 : 1))
		{
			g_assert_false(tifiles_evo_is_python_module(src->data, len));
		}
		tifiles_content_delete_regular(old_file); tifiles_content_delete_regular(new_file);
		g_remove(old_path); g_remove(new_path); g_free(old_path); g_free(new_path);
		g_byte_array_free(payload, TRUE);
	}
	g_byte_array_free(tok, TRUE);
	g_rmdir(dir); g_free(dir);
}

static void test_evo_python_repack(void)
{
	// Every inner-size residue, including already aligned objects with historical
	// A5 padding, arbitrary short tails, and a tail longer than allocator padding.
	const std::initializer_list<uint8_t> tails[] = {
	    {}, {0xa5}, {0xa6}, {0}, {0xff}, {0, 0xff}, {0xa6, 0, 0xff}, {0xa5, 0, 0xff, 0xa6, 1}
	};
	for (const unsigned int mpy_size : {4U, 5U, 6U, 7U, 70000U})
	{
		for (const auto tail : tails) check_evo_python_repack(mpy_size, tail);
	}
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

static void test_evo_external_python_pairs(void)
{
	const char *path = g_getenv("TILIBS_EVO_MPY_FIXTURE_DIR");
	if (path == nullptr || !*path)
	{
		g_test_skip("set TILIBS_EVO_MPY_FIXTURE_DIR to a directory of matching .8xpy2/.8mp2 pairs");
		return;
	}
	GDir *dir = g_dir_open(path, 0, nullptr);
	g_assert_nonnull(dir);
	unsigned int count = 0;
	while (const char *name = g_dir_read_name(dir))
	{
		if (!g_str_has_suffix(name, ".8xpy2")) continue;
		char *old_path = g_build_filename(path, name, nullptr);
		char *stem = g_strndup(name, strlen(name) - 6);
		char *new_name = g_strconcat(stem, ".8mp2", nullptr);
		char *new_path = g_build_filename(path, new_name, nullptr);
		if (g_file_test(new_path, G_FILE_TEST_EXISTS))
		{
			gchar *old_data = nullptr, *new_data = nullptr;
			gsize old_size = 0, new_size = 0;
			g_assert_true(g_file_get_contents(old_path, &old_data, &old_size, nullptr));
			g_assert_true(g_file_get_contents(new_path, &new_data, &new_size, nullptr));
			// Historical paired files can have different tails. Each input's stored
			// bytes must survive its own roundtrip, not acquire the other file's tail.
			for (const auto source : {std::make_pair(old_data, old_size), std::make_pair(new_data, new_size)})
			{
				uint8_t *converted = nullptr, *roundtrip = nullptr;
				uint32_t converted_size = 0, roundtrip_size = 0;
				g_assert_cmpint(tifiles_evo_repack_python_module((const uint8_t *)source.first, source.second, &converted, &converted_size), ==, 0);
				g_assert_cmpint(tifiles_evo_repack_python_module(converted, converted_size, &roundtrip, &roundtrip_size), ==, 0);
				g_assert_cmpmem(roundtrip, roundtrip_size, source.first, source.second);
				tifiles_ve_free_data(converted);
				tifiles_ve_free_data(roundtrip);
			}
			g_free(old_data); g_free(new_data);
			g_test_message("%s: both input roundtrips byte-exact", stem);
			count++;
		}
		g_free(old_path); g_free(stem); g_free(new_name); g_free(new_path);
	}
	g_dir_close(dir);
	g_assert_cmpuint(count, >, 0);
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
	g_test_add_func("/evo/files/python-module", test_evo_python_module);
	g_test_add_func("/evo/files/python-repack", test_evo_python_repack);
	g_test_add_func("/evo/files/external-python-pairs", test_evo_external_python_pairs);
	g_test_add_func("/evo/files/external-fixtures", test_evo_external_fixtures);
	const int ret = g_test_run();
	tifiles_library_exit();
	return ret;
}
