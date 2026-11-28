#include <glib.h>
#include <glib/gstdio.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "../src/tifiles.h"

#define CHECK(c) do { if (!(c)) { std::fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #c); std::abort(); } } while (0)

static void append_record(std::string &out, uint8_t type, uint16_t address,
	const std::vector<uint8_t> &data, bool bad_checksum = false)
{
	CHECK(data.size() <= 32);
	uint8_t sum = (uint8_t)(data.size() + (address >> 8) + address + type);
	char field[16];
	std::snprintf(field, sizeof(field), ":%02X%04X%02X", (unsigned)data.size(), address, type);
	out += field;
	for (uint8_t byte : data)
	{
		std::snprintf(field, sizeof(field), "%02X", byte);
		out += field;
		sum = (uint8_t)(sum + byte);
	}
	uint8_t checksum = (uint8_t)(0 - sum);
	if (bad_checksum) checksum ^= 1;
	std::snprintf(field, sizeof(field), "%02X\r\n", checksum);
	out += field;
}

static std::string make_payload(uint16_t page, uint16_t address,
	const std::vector<uint8_t> &data, bool bad_checksum = false)
{
	std::string payload;
	append_record(payload, 2, 0, { (uint8_t)(page >> 8), (uint8_t)page });
	append_record(payload, 0, address, data, bad_checksum);
	append_record(payload, 1, 0, {});
	return payload;
}

static void append_tifl(std::vector<uint8_t> &file, uint8_t owner, uint8_t type,
	const char *name, const std::string &payload, uint8_t flags = 1,
	uint8_t object_type = 0x88, uint8_t hw_id = 0)
{
	CHECK(std::strlen(name) <= 31);
	uint8_t header[78] = {};
	std::memcpy(header, "**TIFL**", 8);
	header[10] = flags;
	header[11] = object_type;
	header[16] = (uint8_t)std::strlen(name);
	std::memcpy(header + 17, name, std::strlen(name));
	header[48] = owner;
	header[49] = type;
	header[73] = hw_id;
	const uint32_t length = (uint32_t)payload.size();
	header[74] = (uint8_t)length;
	header[75] = (uint8_t)(length >> 8);
	header[76] = (uint8_t)(length >> 16);
	header[77] = (uint8_t)(length >> 24);
	file.insert(file.end(), header, header + sizeof(header));
	file.insert(file.end(), payload.begin(), payload.end());
}

static void write_file(const char *path, const std::vector<uint8_t> &data)
{
	CHECK(g_file_set_contents(path, (const char *)data.data(), (gssize)data.size(), nullptr));
}

static void check_page(const FlashContent *content, uint16_t page, uint16_t address,
	const std::vector<uint8_t> &expected)
{
	CHECK(content->num_pages == 1);
	CHECK(content->pages != nullptr && content->pages[0] != nullptr);
	CHECK(content->pages[0]->page == page);
	CHECK(content->pages[0]->addr == address);
	CHECK(content->pages[0]->size == expected.size());
	CHECK(!std::memcmp(content->pages[0]->data, expected.data(), expected.size()));
	CHECK(content->data_length == expected.size());
}

static void check_combined_classes(const char *path, const std::vector<uint8_t> &bytes)
{
	CHECK(tifiles_file_is_os(path));
	CHECK(tifiles_file_is_app(path));
	CHECK(tifiles_file_is_flash(path));
	/* The public single-valued class keeps its established OS-before-app
	   priority while the independent predicates expose both members. */
	CHECK(tifiles_file_get_class(path) == TIFILE_OS);

	for (CalcModel model : { CALC_CBL2, CALC_LABPRO, CALC_LABPRO_USB })
	{
		CHECK(tifiles_file_test(path, TIFILE_OS, model));
		CHECK(tifiles_file_test(path, TIFILE_APP, model));
		CHECK(tifiles_buffer_test(bytes.data(), bytes.size(), TIFILE_OS, model));
		CHECK(tifiles_buffer_test(bytes.data(), bytes.size(), TIFILE_APP, model));
	}
	CHECK(!tifiles_file_test(path, TIFILE_OS, CALC_TIPRESENTER));
	CHECK(!tifiles_file_test(path, TIFILE_APP, CALC_TIPRESENTER));
	CHECK(tifiles_buffer_is_os(bytes.data(), bytes.size()));
	CHECK(tifiles_buffer_is_app(bytes.data(), bytes.size()));

	uint8_t owner = 0, type = 0;
	CHECK(tifiles_file_has_tifl_header(path, &owner, &type));
	CHECK(owner == DEVICE_TYPE_CBL2 && type == 0x29);
	owner = type = 0;
	CHECK(tifiles_buffer_has_tifl_header(bytes.data(), bytes.size(), &owner, &type));
	CHECK(owner == DEVICE_TYPE_CBL2 && type == 0x29);
}

static FlashContent *read_combined(const char *path,
	const std::vector<uint8_t> &os_data, const std::vector<uint8_t> &app_data)
{
	FlashContent *content = tifiles_content_create_flash(CALC_CBL2);
	CHECK(content != nullptr);
	CHECK(tifiles_file_read_flash(path, content) == 0);
	CHECK(content->model == CALC_CBL2);
	CHECK(content->device_type == DEVICE_TYPE_CBL2 && content->data_type == TI83p_AMS);
	CHECK(!std::strcmp(content->name, "OPERATING_SYSTEM"));
	check_page(content, 0, 0, os_data);

	CHECK(content->next != nullptr && content->next->next == nullptr);
	CHECK(content->next->model == CALC_CBL2);
	CHECK(content->next->device_type == DEVICE_TYPE_CBL2 && content->next->data_type == 0x29);
	CHECK(!std::strcmp(content->next->name, "DATAMATE"));
	check_page(content->next, 1, 0x10, app_data);
	return content;
}

static FlashContent *read_binary_chain(const char *path,
	const std::vector<uint8_t> &binary_data, const std::vector<uint8_t> &app_data)
{
	FlashContent *content = tifiles_content_create_flash(CALC_CBL2);
	CHECK(content != nullptr);
	CHECK(tifiles_file_read_flash(path, content) == 0);
	CHECK(content->device_type == DEVICE_TYPE_CBL2 && content->data_type == TI83p_AMS);
	CHECK(content->flags == 0 && content->object_type == 0);
	CHECK(content->hw_id == 0);
	CHECK(content->pages == nullptr && content->num_pages == 0);
	CHECK(content->data_length == binary_data.size());
	CHECK(content->data_part != nullptr);
	CHECK(!std::memcmp(content->data_part, binary_data.data(), binary_data.size()));
	CHECK(content->next != nullptr && content->next->next == nullptr);
	CHECK(content->next->data_type == 0x29);
	CHECK(content->next->hw_id == 0x5A);
	check_page(content->next, 1, 0x10, app_data);
	return content;
}

static void check_real_fixture(const char *path)
{
	FlashContent *content = tifiles_content_create_flash(CALC_CBL2);
	CHECK(content != nullptr);
	CHECK(tifiles_file_read_flash(path, content) == 0);
	CHECK(content->device_type == DEVICE_TYPE_CBL2 && content->data_type == TI83p_AMS);
	CHECK(!std::strcmp(content->name, "OPERATING_SYSTEM"));
	CHECK(content->data_length == 140288);
	CHECK(content->next != nullptr && content->next->next == nullptr);
	CHECK(content->next->device_type == DEVICE_TYPE_CBL2 && content->next->data_type == 0x29);
	CHECK(!std::strcmp(content->next->name, "DATAMATE"));
	CHECK(content->next->data_length == 219900);
	tifiles_content_delete_flash(content);
}

static FlashContent *check_opaque(const char *path)
{
	static const uint8_t types[] = {
		0x07, 0x08, 0x0A, 0x0D, 0x1F, 0x2A,
		0x25, 0x26, 0x27, 0x28, 0x3E, 0xF0
	};
	CHECK(tifiles_file_is_flash(path));
	CHECK(!tifiles_file_is_os(path));
	CHECK(!tifiles_file_is_app(path));
	CHECK(tifiles_file_get_class(path) == TIFILE_FLASH);

	FlashContent *head = tifiles_content_create_flash(CALC_CBL2);
	CHECK(head != nullptr);
	CHECK(tifiles_file_read_flash(path, head) == 0);
	FlashContent *entry = head;
	for (size_t i = 0; i < sizeof(types); i++)
	{
		CHECK(entry != nullptr);
		CHECK(entry->device_type == DEVICE_TYPE_CBL2);
		CHECK(entry->data_type == types[i]);
		CHECK(entry->num_pages == 0 && entry->pages == nullptr);
		CHECK(entry->data_length == 3 && entry->data_part != nullptr);
		const uint8_t expected[] = { types[i], 0, (uint8_t)(types[i] ^ 0xFF) };
		CHECK(!std::memcmp(entry->data_part, expected, sizeof(expected)));
		entry = entry->next;
	}
	CHECK(entry == nullptr);
	return head;
}

int main(int argc, char **argv)
{
	tifiles_library_init();
	char *dir = g_dir_make_tmp("tilibs-accessory-tifl-XXXXXX", nullptr);
	CHECK(dir != nullptr);
	char *combined_path = g_build_filename(dir, "combined.c2u", nullptr);
	char *roundtrip_path = g_build_filename(dir, "roundtrip.c2u", nullptr);
	char *presenter_path = g_build_filename(dir, "presenter.hex", nullptr);
	char *broken_path = g_build_filename(dir, "broken-second.c2u", nullptr);
	char *opaque_path = g_build_filename(dir, "opaque.c2u", nullptr);
	char *opaque_roundtrip_path = g_build_filename(dir, "opaque-roundtrip.c2u", nullptr);
	char *wrong_app_path = g_build_filename(dir, "wrong-app.c2u", nullptr);
	char *checksummed_path = g_build_filename(dir, "checksummed.c2u", nullptr);
	char *binary_path = g_build_filename(dir, "binary.c2u", nullptr);
	char *binary_roundtrip_path = g_build_filename(dir, "binary-roundtrip.c2u", nullptr);

	const std::vector<uint8_t> os_data = { 1, 2, 3, 4 };
	const std::vector<uint8_t> app_data = { 0xA0, 0xA1, 0xA2, 0xA3, 0xA4 };
	std::vector<uint8_t> combined;
	append_tifl(combined, DEVICE_TYPE_CBL2, TI83p_AMS, "OPERATING_SYSTEM", make_payload(0, 0, os_data));
	append_tifl(combined, DEVICE_TYPE_CBL2, 0x29, "DATAMATE", make_payload(1, 0x10, app_data));
	write_file(combined_path, combined);
	check_combined_classes(combined_path, combined);

	FlashContent *content = read_combined(combined_path, os_data, app_data);
	FlashContent *dup = tifiles_content_dup_flash(content);
	CHECK(dup != nullptr && dup->next != nullptr);
	CHECK(dup->pages[0]->data != content->pages[0]->data);
	CHECK(dup->next->pages[0]->data != content->next->pages[0]->data);
	check_page(dup, 0, 0, os_data);
	check_page(dup->next, 1, 0x10, app_data);
	tifiles_content_delete_flash(dup);

	/* End the first member in the alternate section. The next member must
	   still start in the default section; hex writer state is per member. */
	content->pages[0]->flag = 0;
	CHECK(tifiles_file_write_flash(roundtrip_path, content) == 0);
	tifiles_content_delete_flash(content);
	FlashContent *roundtrip = read_combined(roundtrip_path, os_data, app_data);
	CHECK(roundtrip->pages[0]->flag == 0);
	CHECK(roundtrip->next->pages[0]->flag == 0x80);
	tifiles_content_delete_flash(roundtrip);

	/* Some producers insert an unmodeled two-byte checksum between members. */
	std::vector<uint8_t> checksummed;
	append_tifl(checksummed, DEVICE_TYPE_CBL2, TI83p_AMS, "OPERATING_SYSTEM", make_payload(0, 0, os_data));
	checksummed.push_back(0x12);
	checksummed.push_back(0x34);
	append_tifl(checksummed, DEVICE_TYPE_CBL2, 0x29, "DATAMATE", make_payload(1, 0x10, app_data));
	write_file(checksummed_path, checksummed);
	check_combined_classes(checksummed_path, checksummed);
	FlashContent *checksummed_content = read_combined(checksummed_path, os_data, app_data);
	tifiles_content_delete_flash(checksummed_content);

	/* Flags/object type, not hw_id, select Intel HEX. A 128 KiB binary OS
	   member with hw_id zero must remain flat and bounded at its declared end. */
	std::vector<uint8_t> binary_data(131072);
	for (size_t i = 0; i < binary_data.size(); i++) binary_data[i] = (uint8_t)(i * 37 + 11);
	std::vector<uint8_t> binary;
	append_tifl(binary, DEVICE_TYPE_CBL2, TI83p_AMS, "BOOTCODE",
		std::string((const char *)binary_data.data(), binary_data.size()), 0, 0);
	append_tifl(binary, DEVICE_TYPE_CBL2, 0x29, "DATAMATE",
		make_payload(1, 0x10, app_data), 1, 0x88, 0x5A);
	write_file(binary_path, binary);
	CHECK(tifiles_file_is_os(binary_path) && tifiles_file_is_app(binary_path));
	FlashContent *binary_content = read_binary_chain(binary_path, binary_data, app_data);
	CHECK(tifiles_file_write_flash(binary_roundtrip_path, binary_content) == 0);
	tifiles_content_delete_flash(binary_content);
	FlashContent *binary_roundtrip = read_binary_chain(binary_roundtrip_path, binary_data, app_data);
	tifiles_content_delete_flash(binary_roundtrip);

	TifilesMetadataPair *metadata = tifiles_file_get_metadata(combined_path);
	CHECK(metadata != nullptr);
	TifilesMetadataPair *name_pair = tifiles_metadata_find_pair(metadata, "file.name");
	CHECK(name_pair != nullptr && !std::strcmp(name_pair->value, "OPERATING_SYSTEM"));
	TifilesMetadataPair *entries_pair = tifiles_metadata_find_pair(metadata, "file.entries");
	CHECK(entries_pair != nullptr && !std::strcmp(entries_pair->value, "2"));
	tifiles_metadata_free(metadata);

	std::vector<uint8_t> presenter;
	append_tifl(presenter, DEVICE_TYPE_TIPRESENTER, TI83p_AMS,
		"OPERATING_SYSTEM", make_payload(0, 0, os_data));
	const std::string presenter_directory("\x1f\x00\x43", 3);
	append_tifl(presenter, DEVICE_TYPE_TIPRESENTER, 0x1F,
		"DIRECTORY", presenter_directory, 0, 0);
	write_file(presenter_path, presenter);
	CHECK(tifiles_file_is_os(presenter_path));
	CHECK(!tifiles_file_is_app(presenter_path));
	CHECK(tifiles_file_test(presenter_path, TIFILE_OS, CALC_TIPRESENTER));
	CHECK(!tifiles_file_test(presenter_path, TIFILE_OS, CALC_CBL2));
	FlashContent *presenter_content = tifiles_content_create_flash(CALC_TIPRESENTER);
	CHECK(tifiles_file_read_flash(presenter_path, presenter_content) == 0);
	CHECK(presenter_content->model == CALC_TIPRESENTER);
	check_page(presenter_content, 0, 0, os_data);
	CHECK(presenter_content->next != nullptr && presenter_content->next->next == nullptr);
	CHECK(presenter_content->next->device_type == DEVICE_TYPE_TIPRESENTER);
	CHECK(presenter_content->next->data_type == 0x1F);
	CHECK(presenter_content->next->data_length == presenter_directory.size());
	CHECK(presenter_content->next->data_part != nullptr);
	CHECK(!std::memcmp(presenter_content->next->data_part,
		presenter_directory.data(), presenter_directory.size()));
	tifiles_content_delete_flash(presenter_content);

	/* A failure in member two must reject the whole container and release the
	   supplied head exactly once. ASan/LSan exercise the tail cleanup here. */
	std::vector<uint8_t> broken;
	append_tifl(broken, DEVICE_TYPE_CBL2, TI83p_AMS, "OPERATING_SYSTEM", make_payload(0, 0, os_data));
	append_tifl(broken, DEVICE_TYPE_CBL2, 0x29, "DATAMATE", make_payload(1, 0x10, app_data, true));
	write_file(broken_path, broken);
	FlashContent *broken_content = tifiles_content_create_flash(CALC_CBL2);
	CHECK(tifiles_file_read_flash(broken_path, broken_content) != 0);
	CHECK(tifiles_file_get_metadata(broken_path) == nullptr);

	std::vector<uint8_t> opaque;
	for (uint8_t type : { (uint8_t)0x07, (uint8_t)0x08, (uint8_t)0x0A,
	                      (uint8_t)0x0D, (uint8_t)0x1F, (uint8_t)0x2A,
	                      (uint8_t)0x25, (uint8_t)0x26, (uint8_t)0x27,
	                      (uint8_t)0x28, (uint8_t)0x3E, (uint8_t)0xF0 })
	{
		const char name[] = "RECORD";
		const uint8_t raw[] = { type, 0, (uint8_t)(type ^ 0xFF) };
		append_tifl(opaque, DEVICE_TYPE_CBL2, type, name,
			std::string((const char *)raw, sizeof(raw)));
	}
	write_file(opaque_path, opaque);
	FlashContent *opaque_content = check_opaque(opaque_path);
	FlashContent *opaque_dup = tifiles_content_dup_flash(opaque_content);
	CHECK(opaque_dup != nullptr && opaque_dup->data_part != opaque_content->data_part);
	CHECK(opaque_dup->next != nullptr && opaque_dup->next->data_part != opaque_content->next->data_part);
	tifiles_content_delete_flash(opaque_dup);
	CHECK(tifiles_file_write_flash(opaque_roundtrip_path, opaque_content) == 0);
	tifiles_content_delete_flash(opaque_content);
	FlashContent *opaque_roundtrip = check_opaque(opaque_roundtrip_path);
	tifiles_content_delete_flash(opaque_roundtrip);

	/* Type 24h is a calculator Flash application, not a CBL2 or Presenter
	   application. Only owner 42 type 29h has accessory app semantics. */
	std::vector<uint8_t> wrong_app;
	append_tifl(wrong_app, DEVICE_TYPE_CBL2, TI83p_APPL, "NOT_AN_APP", "raw", 0, 0);
	write_file(wrong_app_path, wrong_app);
	CHECK(tifiles_file_is_flash(wrong_app_path));
	CHECK(!tifiles_file_is_app(wrong_app_path));

	/* Older libtifiles versions saved apps received from a TI-83 Plus with the
	   flags and object type left at 0 although the payload is Intel HEX. Those
	   files must still decode as pages, and are rewritten with the HEX markers. */
	char *legacy_path = g_build_filename(dir, "legacy.8xk", nullptr);
	char *legacy_roundtrip_path = g_build_filename(dir, "legacy-roundtrip.8xk", nullptr);
	std::vector<uint8_t> legacy;
	append_tifl(legacy, DEVICE_TYPE_83P, TI83p_APPL, "LEGACY", make_payload(0, 0x4000, app_data), 0, 0);
	write_file(legacy_path, legacy);
	CHECK(tifiles_file_is_app(legacy_path));
	FlashContent *legacy_content = tifiles_content_create_flash(CALC_TI83P);
	CHECK(tifiles_file_read_flash(legacy_path, legacy_content) == 0);
	CHECK(legacy_content->flags == 0 && legacy_content->object_type == 0);
	CHECK(legacy_content->data_part == nullptr);
	check_page(legacy_content, 0, 0x4000, app_data);
	CHECK(tifiles_file_write_flash(legacy_roundtrip_path, legacy_content) == 0);
	tifiles_content_delete_flash(legacy_content);
	legacy_content = tifiles_content_create_flash(CALC_TI83P);
	CHECK(tifiles_file_read_flash(legacy_roundtrip_path, legacy_content) == 0);
	CHECK((legacy_content->flags & 1) && legacy_content->object_type == 0x88);
	check_page(legacy_content, 0, 0x4000, app_data);
	tifiles_content_delete_flash(legacy_content);

	/* A non-zero hardware ID keeps a flags/object-type 0 payload flat, even
	   when its bytes happen to look like a HEX record. */
	std::vector<uint8_t> flat_colon;
	append_tifl(flat_colon, DEVICE_TYPE_83P, TI83p_APPL, "FLAT", make_payload(0, 0x4000, app_data), 0, 0, 0x13);
	write_file(legacy_path, flat_colon);
	legacy_content = tifiles_content_create_flash(CALC_TI83P);
	CHECK(tifiles_file_read_flash(legacy_path, legacy_content) == 0);
	CHECK(legacy_content->pages == nullptr && legacy_content->data_part != nullptr);
	tifiles_content_delete_flash(legacy_content);

	/* A payload ending inside a block, without an end-of-section record, is
	   still accepted, but the reader logs that the pending block is dropped. */
	std::string unterminated;
	append_record(unterminated, 2, 0, { 0, 0 });
	append_record(unterminated, 0, 0x4000, app_data);
	std::vector<uint8_t> unterminated_file;
	append_tifl(unterminated_file, DEVICE_TYPE_83P, TI83p_APPL, "UNTERM", unterminated);
	write_file(legacy_path, unterminated_file);
	legacy_content = tifiles_content_create_flash(CALC_TI83P);
	CHECK(tifiles_file_read_flash(legacy_path, legacy_content) == 0);
	CHECK(legacy_content->num_pages == 0);
	tifiles_content_delete_flash(legacy_content);

	g_remove(legacy_path);
	g_remove(legacy_roundtrip_path);
	g_free(legacy_path);
	g_free(legacy_roundtrip_path);

	if (argc > 1)
	{
		check_real_fixture(argv[1]);
	}

	g_remove(combined_path);
	g_remove(roundtrip_path);
	g_remove(presenter_path);
	g_remove(broken_path);
	g_remove(opaque_path);
	g_remove(opaque_roundtrip_path);
	g_remove(wrong_app_path);
	g_remove(checksummed_path);
	g_remove(binary_path);
	g_remove(binary_roundtrip_path);
	g_rmdir(dir);
	g_free(combined_path);
	g_free(roundtrip_path);
	g_free(presenter_path);
	g_free(broken_path);
	g_free(opaque_path);
	g_free(opaque_roundtrip_path);
	g_free(wrong_app_path);
	g_free(checksummed_path);
	g_free(binary_path);
	g_free(binary_roundtrip_path);
	g_free(dir);
	tifiles_library_exit();
	std::puts("Accessory multi-entry TIFL tests passed");
	return 0;
}
