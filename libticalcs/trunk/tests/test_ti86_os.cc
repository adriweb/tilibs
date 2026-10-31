#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>
#include <glib.h>
#include <glib/gstdio.h>
#include "../src/ticalcs.h"
#include "../src/dbus_pkt.h"
#include "../src/error.h"

#define CHECK(c) do { if (!(c)) { fprintf(stderr, "%d: %s\n", __LINE__, #c); abort(); } } while (0)
static std::vector<uint8_t> incoming, outgoing;
static size_t received, cancel_after;
static int write_error;
static CalcHandle *active;
static int cable_recv(CableHandle *, uint8_t *data, uint32_t size)
{
	if (size > incoming.size() - received) return ERROR_READ_TIMEOUT;
	memcpy(data, incoming.data() + received, size);
	received += size;
	if (cancel_after && received >= cancel_after) active->updat->cancel = 1;
	return 0;
}
static int cable_send(CableHandle *, uint8_t *data, uint32_t size)
{
	CHECK(size > 0);
	if (write_error) return write_error;
	outgoing.insert(outgoing.end(), data, data + size);
	return 0;
}
struct Calculator
{
	CableFncts functions = {};
	CableHandle cable = {};
	CalcHandle *handle;
	Calculator()
	{
		incoming.clear(); outgoing.clear(); received = cancel_after = 0; write_error = 0;
		functions.recv = cable_recv; functions.send = cable_send;
		cable.cable = &functions; cable.open = 1;
		active = handle = ticalcs_handle_new(CALC_TI86);
		CHECK(handle); handle->updat->cancel = 0;
		handle->cable = &cable; handle->open = handle->attached = 1;
		for (unsigned int i = 0; i < 1026; i++)
			incoming.insert(incoming.end(), {0x85, 0x56, 10, 0, 0x85, 9, 10, 0, 0x85, 0x56, 0, 1});
	}
	~Calculator() { handle->attached = 0; ticalcs_handle_del(handle); }
};
static FlashContent *image()
{
	FlashContent *c = tifiles_content_create_flash(CALC_TI86);
	c->revision_major = c->flags = 1; c->object_type = 0x88;
	strcpy(c->name, "1.1003"); c->device_type = DEVICE_TYPE_86; c->data_type = TI86_AMS;
	c->data_length = 0x40000; c->num_pages = 16;
	c->pages = (FlashPage **)g_malloc0(16 * sizeof(FlashPage *));
	for (unsigned int i = 0; i < 16; i++)
	{
		FlashPage *p = c->pages[i] = (FlashPage *)g_malloc0(sizeof(FlashPage));
		p->addr = p->size = 0x4000; p->page = i; p->flag = 0x80;
		p->data = (uint8_t *)g_malloc(0x4000);
		for (unsigned int j = 0; j < 0x4000; j++) p->data[j] = i * 13 + j * 37;
	}
	return c;
}
static void verify_wire(const FlashContent *c)
{
	CHECK(outgoing.size() == 289332);
	const FlashPage *pages[16] = {};
	for (unsigned int i = 0; i < 16; i++) pages[c->pages[i]->page] = c->pages[i];
	for (unsigned int i = 0; i < 1026; i++)
	{
		const uint8_t *b = outgoing.data() + i * 282;
		CHECK(b[0] == 5 && b[1] == 6 && b[2] == 10 && b[3] == 0);
		CHECK(b[4] == 0 && b[5] == 1 && b[6] == 0 && b[7] == 0 && b[8] == 0x16 && b[9] == 4 && b[13] == 0);
		unsigned int page = i < 1024 ? i / 64 : 15;
		unsigned int addr = i < 960 ? 0x4000 + (i % 64)*256 : i < 1024 ? 0x8000 + (i % 64)*256 : i == 1024 ? 0xc600 : 0xfb00;
		CHECK(b[10] == (addr & 255) && b[11] == (addr >> 8) && b[12] == page);
		CHECK(tifiles_checksum(b + 4, 10) == (b[14] | b[15] << 8));
		CHECK(!memcmp(b + 16, "\5\126\0\0\5\25\0\1", 8));
		CHECK(tifiles_checksum(b + 24, 256) == (b[280] | b[281] << 8));
		if (i < 1024) CHECK(!memcmp(b + 24, pages[page]->data + (i % 64)*256, 256));
		if (i == 1025) for (unsigned int j = 0; j < 256; j++) CHECK(b[24+j] == (j % 2 ? 0xc6 : 0));
	}
}
int main(int argc, char **argv)
{
	tifiles_library_init(); ticalcs_library_init();
	if (argc == 3)
	{
		Calculator calc;
		CHECK(!ticalcs_calc_send_os2(calc.handle, argv[1]));
		CHECK(g_file_set_contents(argv[2], (const char *)outgoing.data(), outgoing.size(), nullptr));
		puts("TI-86 OS filename API wire captured");
		return 0;
	}
	FlashContent *c = image();
	{
		Calculator calc;
		CHECK(!ticalcs_calc_send_os(calc.handle, c));
		CHECK(received == incoming.size()); verify_wire(c);
		CHECK(calc.handle->updat->cnt2 == 1026 && calc.handle->updat->max2 == 1026);
	}
	// Page order in the in-memory object does not determine transfer order.
	std::swap(c->pages[0], c->pages[15]);
	{ Calculator calc; CHECK(!ticalcs_calc_send_os(calc.handle, c)); verify_wire(c); }
	std::swap(c->pages[0], c->pages[15]);
	// Invalid objects must fail before even a header is transmitted.
	for (unsigned int test = 0; test < 8; test++)
	{
		Calculator calc;
		FlashContent saved = *c; FlashPage page = *c->pages[15];
		if (test == 0) c->device_type = DEVICE_TYPE_83P;
		if (test == 1) c->model_dst = CALC_TI84P;
		if (test == 2) c->num_pages = 15;
		if (test == 3) c->pages[15]->page = 14;
		if (test == 4) c->pages[15]->size--;
		if (test == 5) c->hw_id = 1;
		if (test == 6) c->next = c;
		if (test == 7) c->pages[15]->data = nullptr;
		CHECK(ticalcs_calc_send_os(calc.handle, c) == ERR_INVALID_PARAMETER);
		CHECK(outgoing.empty() && received == 0);
		*c = saved; *c->pages[15] = page;
	}
	{ Calculator calc; calc.handle->updat->cancel = 1; CHECK(ticalcs_calc_send_os(calc.handle, c) == ERR_ABORT); CHECK(outgoing.empty()); }
	{ Calculator calc; cancel_after = 12; CHECK(ticalcs_calc_send_os(calc.handle, c) == ERR_ABORT); CHECK(outgoing.size() == 282); }
	for (unsigned int index : {0, 1, 2, 5, 6, 9, 10})
	{
		Calculator calc; incoming[index] ^= 1;
		CHECK(ticalcs_calc_send_os(calc.handle, c) == ERR_INVALID_PACKET);
		CHECK(outgoing.size() == (index < 8 ? 16 : 282));
	}
	{ Calculator calc; incoming[1] = 0x5a; CHECK(ticalcs_calc_send_os(calc.handle, c) == ERR_CHECKSUM); CHECK(outgoing.size() == 20 && !memcmp(outgoing.data() + 16, "\5\126\0\0", 4)); }
	{ Calculator calc; incoming.resize(8); CHECK(ticalcs_calc_send_os(calc.handle, c) == ERROR_READ_TIMEOUT); CHECK(outgoing.size() == 282); }
	{ Calculator calc; write_error = ERROR_WRITE_TIMEOUT; CHECK(ticalcs_calc_send_os(calc.handle, c) == ERROR_WRITE_TIMEOUT); CHECK(received == 0); }
	// The same filename API used by WebTiLP parses the file before transport.
	{
		char *dir = g_dir_make_tmp("ticalcs-ti86-os-XXXXXX", nullptr); CHECK(dir);
		char *path = g_build_filename(dir, "test.86u", nullptr);
		CHECK(!tifiles_file_write_flash(path, c));
		Calculator calc; CHECK(!ticalcs_calc_send_os2(calc.handle, path)); verify_wire(c);
		CHECK(!g_remove(path)); CHECK(!g_rmdir(dir)); g_free(path); g_free(dir);
	}
	tifiles_content_delete_flash(c); ticalcs_library_exit(); tifiles_library_exit();
	puts("TI-86 OS sender: full image, filename API, reordered pages, preflight, cancellation, reply/error/timeout cases passed");
}
