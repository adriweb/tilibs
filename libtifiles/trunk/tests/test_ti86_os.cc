#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include <glib.h>
#include <glib/gstdio.h>
#include "../src/tifiles.h"

#define CHECK(c) do { if (!(c)) { fprintf(stderr, "%d: %s\n", __LINE__, #c); abort(); } } while (0)
static std::string directory;
static unsigned int checks;

static std::vector<uint8_t> load(const std::string &path)
{
	char *data = nullptr;
	gsize size = 0;
	CHECK(g_file_get_contents(path.c_str(), &data, &size, nullptr));
	std::vector<uint8_t> bytes(data, data + size);
	g_free(data);
	return bytes;
}
static FlashContent *image()
{
	FlashContent *c = tifiles_content_create_flash(CALC_TI86);
	c->revision_major = c->flags = 1;
	c->object_type = 0x88;
	strcpy(c->name, "1.1003");
	c->device_type = DEVICE_TYPE_86;
	c->data_type = TI86_AMS;
	c->data_length = 0x40000;
	c->num_pages = 16;
	c->pages = (FlashPage **)g_malloc0(16 * sizeof(FlashPage *));
	for (unsigned int page = 0; page < 16; page++)
	{
		FlashPage *p = c->pages[page] = (FlashPage *)g_malloc0(sizeof(FlashPage));
		p->addr = p->size = 0x4000;
		p->page = page;
		p->flag = 0x80;
		p->data = (uint8_t *)g_malloc(0x4000);
		for (unsigned int i = 0; i < 0x4000; i++) p->data[i] = (page * 0x4000 + i) * 37 + page;
	}
	return c;
}
static void read_case(const std::vector<uint8_t> &bytes, bool valid, const char *ext = "86u", CalcModel target = CALC_TI86)
{
	const std::string path = directory + "/input." + ext;
	CHECK(g_file_set_contents(path.c_str(), (const char *)bytes.data(), bytes.size(), nullptr));
	FlashContent *c = tifiles_content_create_flash(target);
	const int ret = tifiles_file_read_flash(path.c_str(), c);
	CHECK((ret == 0) == valid);
	if (!ret)
	{
		CHECK(c->num_pages == 16 && c->data_length == 0x40000);
		CHECK(c->model_dst == CALC_TI86 && !strcmp(c->name, "1.1003"));
		for (unsigned int page = 0; page < 16; page++)
			for (unsigned int i = 0; i < 0x4000; i++)
				CHECK(c->pages[page]->data[i] == (uint8_t)((page * 0x4000 + i) * 37 + page));
		CHECK(!tifiles_file_write_flash((directory + "/roundtrip.86u").c_str(), c));
		tifiles_content_delete_flash(c);
	}
	checks++;
	CHECK(!g_remove(path.c_str()));
}
static std::string record(unsigned int addr, unsigned int kind, const std::vector<uint8_t> &data)
{
	char text[16];
	snprintf(text, sizeof(text), ":%02X%04X%02X", (unsigned int)data.size(), addr, kind);
	std::string out = text;
	unsigned int sum = data.size() + (addr >> 8) + (addr & 255) + kind;
	for (uint8_t b : data) { snprintf(text, sizeof(text), "%02X", b); out += text; sum += b; }
	snprintf(text, sizeof(text), "%02X", (-sum) & 255);
	return out + text;
}
static std::vector<uint8_t> container(const std::vector<uint8_t> &original, const std::vector<std::string> &lines, const char *sep = "\r\n")
{
	std::vector<uint8_t> bytes(original.begin(), original.begin() + 78);
	for (unsigned int i = 0; i < lines.size(); i++)
	{
		bytes.insert(bytes.end(), lines[i].begin(), lines[i].end());
		if (i + 1 < lines.size()) bytes.insert(bytes.end(), sep, sep + strlen(sep));
	}
	for (unsigned int i = 0; i < 4; i++) bytes[74 + i] = (bytes.size() - 78) >> (8*i);
	return bytes;
}
int main()
{
	tifiles_library_init();
	char *dir = g_dir_make_tmp("tifiles-ti86-os-XXXXXX", nullptr);
	CHECK(dir); directory = dir; g_free(dir);
	FlashContent *c = image();
	CHECK(!tifiles_file_write_flash((directory + "/original.86u").c_str(), c));
	auto original = load(directory + "/original.86u");
	CHECK(original.size() == 631145);
	CHECK(tifiles_file_test((directory + "/original.86u").c_str(), TIFILE_OS, CALC_TI86));
	CHECK(!tifiles_file_test((directory + "/original.86u").c_str(), TIFILE_OS, CALC_TI84P));
	read_case(original, true);
	CHECK(load(directory + "/roundtrip.86u") == original);
	read_case(original, false, "8xu");
	read_case(original, false, "86u", CALC_TI84P);
	for (unsigned int offset : {0, 8, 9, 10, 11, 12, 16, 17, 40, 48, 49, 50, 73, 74})
	{
		auto bytes = original; bytes[offset] ^= 0xff; read_case(bytes, false);
	}
	for (size_t size : {size_t(0), size_t(77), size_t(78), original.size() - 1})
		read_case(std::vector<uint8_t>(original.begin(), original.begin() + size), false);
	auto bytes = original; bytes.push_back(0); read_case(bytes, false);
	std::vector<std::string> lines;
	std::string body(original.begin() + 78, original.end());
	for (size_t start = 0, end; ; start = end + 2)
	{
		end = body.find("\r\n", start);
		lines.push_back(body.substr(start, end == std::string::npos ? end : end - start));
		if (end == std::string::npos) break;
	}
	CHECK(lines.size() == 8209);
	for (const char *sep : {"\r", "\n", "\r\n"}) read_case(container(original, lines, sep), true);
	auto variant = lines; variant.back() = ":0000000100"; read_case(container(original, variant), false);
	variant = lines; variant.pop_back(); read_case(container(original, variant), false);
	variant = lines; variant.push_back(lines.back()); read_case(container(original, variant), false);
	variant = lines; variant[0] = record(0, 2, {0, 16}); read_case(container(original, variant), false);
	variant = lines; variant[513] = lines[0]; read_case(container(original, variant), false);
	variant = lines; variant.erase(variant.begin(), variant.begin() + 513); read_case(container(original, variant), false);
	variant = lines; variant.erase(variant.begin() + 512); read_case(container(original, variant), false);
	variant = lines; variant[1] = record(0x4001, 0, std::vector<uint8_t>(c->pages[0]->data, c->pages[0]->data + 32)); read_case(container(original, variant), false);
	variant = lines; variant[1] = record(0x4000, 4, {0, 0}); read_case(container(original, variant), false);
	variant = lines; variant[0] = lines[1]; read_case(container(original, variant), false);
	variant = lines; variant[1][10] = 'Z'; read_case(container(original, variant), false);
	variant = lines; variant[1].push_back('0'); read_case(container(original, variant), false);
	variant.clear();
	for (int page = 15; page >= 0; page--) variant.insert(variant.end(), lines.begin() + page*513, lines.begin() + (page+1)*513);
	variant.push_back(lines.back()); read_case(container(original, variant), true);
	CHECK(load(directory + "/roundtrip.86u") == original);
	// A preceding legacy OS writer may end in its alternate section. Its state
	// must not leak an extra section-toggle record into the next .86u file.
	c->model = c->model_dst = CALC_TI83P; c->device_type = DEVICE_TYPE_83P;
	c->pages[15]->flag = 0;
	CHECK(!tifiles_file_write_flash((directory + "/legacy.8xu").c_str(), c));
	c->model = c->model_dst = CALC_TI86; c->device_type = DEVICE_TYPE_86; c->pages[15]->flag = 0x80;
	CHECK(!tifiles_file_write_flash((directory + "/second.86u").c_str(), c));
	CHECK(load(directory + "/second.86u") == original);
	tifiles_content_delete_flash(c);
	for (const char *name : {"original.86u", "roundtrip.86u", "legacy.8xu", "second.86u"}) CHECK(!g_remove((directory + "/" + name).c_str()));
	CHECK(!g_rmdir(directory.c_str()));
	tifiles_library_exit();
	printf("TI-86 OS parser: %u valid/malformed/cross-model cases and writer-state regression passed\n", checks);
}
