// Optional end-to-end test using an external TilEm checkout and external ROMs.
// The actual libticalcs cable callbacks drive TilEm byte by byte; no generated
// DBUS stream is replayed and no target bytes are written by the test host.
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdarg>
#include <deque>
#include <glib.h>
#include "../src/ticalcs.h"
#define restrict __restrict
#include "tilem.h"
#undef restrict

#define CHECK(c) do { if (!(c)) { fprintf(stderr, "%d: %s\n", __LINE__, #c); abort(); } } while (0)
extern "C" {
void *tilem_malloc(size_t n) { return g_malloc(n ? n : 1); }
void *tilem_malloc0(size_t n) { return g_malloc0(n ? n : 1); }
void *tilem_malloc_atomic(size_t n) { return tilem_malloc(n); }
void *tilem_try_malloc(size_t n) { return g_try_malloc(n ? n : 1); }
void *tilem_try_malloc0(size_t n) { return g_try_malloc0(n ? n : 1); }
void *tilem_try_malloc_atomic(size_t n) { return tilem_try_malloc(n); }
void *tilem_realloc(void *p, size_t n) { return g_realloc(p, n ? n : 1); }
void tilem_free(void *p) { g_free(p); }
void tilem_message(TilemCalc *, const char *, ...) {}
void tilem_warning(TilemCalc *, const char *format, ...) {
	va_list args; va_start(args, format); vfprintf(stderr, format, args); va_end(args); fputc('\n', stderr);
}
void tilem_internal(TilemCalc *, const char *format, ...) {
	va_list args; va_start(args, format); vfprintf(stderr, format, args); va_end(args); abort();
}
}
static TilemCalc *emulator;
static std::deque<uint8_t> replies;
static unsigned int sent, received;
static void tick(int us)
{
	int remaining;
	const unsigned int reason = tilem_z80_run_time(emulator, us, &remaining);
	CHECK(!(reason & ~(TILEM_STOP_TIMEOUT | TILEM_STOP_LINK_READ_BYTE | TILEM_STOP_LINK_WRITE_BYTE)));
	int b;
	while ((b = tilem_linkport_graylink_get_byte(emulator)) >= 0) replies.push_back(b);
}
static void wait_ms(int ms) { for (int i = 0; i < ms * 10; i++) tick(100); }
static void key(int code)
{
	tilem_keypad_press_key(emulator, code); wait_ms(80);
	tilem_keypad_release_key(emulator, code); wait_ms(140);
}
static int cable_send(CableHandle *, uint8_t *data, uint32_t size)
{
	for (unsigned int i = 0; i < size; i++)
	{
		unsigned int attempts = 0;
		while (tilem_linkport_graylink_send_byte(emulator, data[i]))
		{
			tick(20);
			if (++attempts > 100000) return ERROR_WRITE_TIMEOUT;
		}
		tick(20); sent++;
	}
	return 0;
}
static int cable_recv(CableHandle *, uint8_t *data, uint32_t size)
{
	for (unsigned int i = 0; i < size; i++)
	{
		unsigned int attempts = 0;
		while (replies.empty())
		{
			tick(20);
			if (++attempts > 100000) return ERROR_READ_TIMEOUT;
		}
		data[i] = replies.front(); replies.pop_front(); received++;
	}
	// Model the cable turnaround while the emulated CPU releases its last
	// output byte. The emulator runs only inside these cable callbacks.
	wait_ms(1);
	return 0;
}
int main(int argc, char **argv)
{
	if (argc != 4) { fprintf(stderr, "Usage: %s source.rom target.86u expected-target.rom\n", argv[0]); return 2; }
	emulator = tilem_calc_new('6'); CHECK(emulator);
	FILE *f = fopen(argv[1], "rb"); CHECK(f);
	CHECK(!tilem_calc_load_state(emulator, f, nullptr)); fclose(f);
	CHECK(!tilem_ti86_set_programmable_rom(emulator, 1));
	wait_ms(1000); key(41); wait_ms(1200); key(15); wait_ms(300);
	for (int code : {54, 56, 48, 45}) key(code); // MODE -> ALPHA F, no CPU/RAM setup.
	CHECK(emulator->mempagemap[1] == 15);
	emulator->linkport.linkemu = TILEM_LINK_EMULATOR_GRAY;
	tilem_linkport_graylink_reset(emulator);
	tifiles_library_init(); ticalcs_library_init();
	CableFncts functions = {}; CableHandle cable = {};
	functions.send = cable_send; functions.recv = cable_recv;
	cable.cable = &functions; cable.open = 1;
	CalcHandle *handle = ticalcs_handle_new(CALC_TI86); CHECK(handle);
	handle->cable = &cable; handle->open = handle->attached = 1;
	const int ret = ticalcs_calc_send_os2(handle, argv[2]);
	if (ret) fprintf(stderr, "Transfer error %d after %u sent/%u received; PC=%04x bank=%x replies=%zu\n", ret, sent, received, emulator->z80.r.pc.w.l, emulator->mempagemap[1], replies.size());
	CHECK(ret == 0); CHECK(sent == 289332 && received == 12312 && replies.empty());
	emulator->linkport.linkemu = TILEM_LINK_EMULATOR_NONE;
	tilem_linkport_graylink_reset(emulator); wait_ms(2000);
	char *expected = nullptr; gsize size = 0;
	CHECK(g_file_get_contents(argv[3], &expected, &size, nullptr));
	CHECK(size == 0x40000 && !memcmp(emulator->mem, expected, size));
	g_free(expected); handle->attached = 0; ticalcs_handle_del(handle);
	ticalcs_library_exit(); tifiles_library_exit(); tilem_calc_free(emulator);
	printf("PASS: native .86u filename API -> libticalcs -> live TilEm: %u sent, %u received, all 262144 ROM bytes equal\n", sent, received);
}
