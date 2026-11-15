#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../src/error.h"
#include "../src/ticalcs.h"
#include "../src/internal.h"
#include "../src/nsp_cmd.h"
#include "../src/nsp_limits.h"
#include "../src/nsp_rpkt.h"
#include "../src/nsp_vpkt.h"
#include "../src/nsp_nnse.h"

#define CHECK(condition) \
	do { \
		if (!(condition)) { \
			fprintf(stderr, "%s:%d: check failed: %s\n", __FILE__, __LINE__, #condition); \
			abort(); \
		} \
	} while (0)

static int recv_calls = 0;

static int recv_oversized_legacy_packet(CableHandle *, uint8_t *data, uint32_t len)
{
	recv_calls++;
	if (recv_calls == 1)
	{
		CHECK(len == NSP_HEADER_SIZE);
		memset(data, 0, len);
		data[12] = 0xff;
		return 0;
	}
	if (recv_calls == 2)
	{
		CHECK(len == UINT8_MAX);
		memset(data, 0, len);
		return 0;
	}
	return 1234;
}

static void check_oversized_legacy_packet_is_drained_and_rejected(void)
{
	CableFncts cable_functions = {};
	cable_functions.recv = recv_oversized_legacy_packet;

	CableHandle cable = {};
	cable.cable = &cable_functions;
	cable.open = 1;

	CalcUpdate update = {};
	CalcHandle handle = {};
	handle.cable = &cable;
	handle.updat = &update;

	NSPRawPacket packet = {};
	recv_calls = 0;
	CHECK(nsp_recv(&handle, &packet) == ERR_INVALID_PACKET);
	CHECK(recv_calls == 2);
}

static void check_os_receive_size_limit(void)
{
	CHECK(!nsp_os_receive_size_valid(0));
	CHECK(nsp_os_receive_size_valid(1));
	CHECK(nsp_os_receive_size_valid(NSP_OS_MAX_SIZE - 1));
	CHECK(!nsp_os_receive_size_valid(NSP_OS_MAX_SIZE));
	CHECK(!nsp_os_receive_size_valid(UINT32_MAX));
}

static void check_nnse_os_receive_accepts_short_split_chunks(void)
{
	CHECK(nsp_os_receive_packet_boundary_valid(1024, 0, 0));
	CHECK(!nsp_os_receive_packet_boundary_valid(1024, 1, 0));
	CHECK(nsp_os_receive_packet_boundary_valid(1024, 1, 1));
	CHECK(nsp_os_receive_packet_boundary_valid(0, 1, 0));
}

static void check_os_status_result(void)
{
	uint8_t progress = 0;
	CHECK(ticalcs_nsp_os_status_result(NSP_ERR_OK, &progress) == 0);
	CHECK(progress == 100);

	progress = 0;
	CHECK(ticalcs_nsp_os_status_result(0x02, &progress) == ERR_CALC_ERROR3 + 1);
	CHECK(progress == 0x02);
}

static void check_reply_reverses_request_endpoints(void)
{
	NSPRawPacket request = {};
	request.src_addr = 0xc801;
	request.src_port = 0x8004;
	request.dst_addr = 0x6400;
	request.dst_port = NSP_PORT_OS_INSTALL;

	NSPRawPacket reply;
	memset(&reply, 0xff, sizeof(reply));
	nsp_init_reply(&reply, &request);

	CHECK(reply.src_addr == request.dst_addr);
	CHECK(reply.src_port == request.dst_port);
	CHECK(reply.dst_addr == request.src_addr);
	CHECK(reply.dst_port == request.src_port);
	CHECK(reply.data_size == 0);
	CHECK(reply.ack == 0);
}

static char requested_path[VARNAME_MAX + FLDNAME_MAX + 4];
static char requested_destination[sizeof(requested_path)];
static unsigned int expected_stream_timeout;
// Feed real directory reply packets through the NNSE parser and enumerator.
static const char *directory_names[] = {
	"config", "config.tns", "config.dat", "config.dat.tns", ".hidden",
	".hidden.tns", "UPPER.TNS", "themes.csv", "NspireLogs.zip", "é.cfg"
};
static size_t directory_index;
static bool directory_root;
static void queue_directory_reply(CalcHandle *handle, uint8_t cmd, const uint8_t *data, size_t size)
{
	uint8_t raw[NSP_HEADER_SIZE + NSP_DATA_SIZE] = {};
	raw[0] = 0x54; raw[1] = 0xfd;
	raw[2] = NSP_DEV_ADDR >> 8; raw[3] = NSP_DEV_ADDR & 0xff;
	raw[4] = NSP_PORT_FILE_MGMT >> 8; raw[5] = NSP_PORT_FILE_MGMT & 0xff;
	raw[6] = NSP_SRC_ADDR >> 8; raw[7] = NSP_SRC_ADDR & 0xff;
	raw[8] = handle->priv.nsp_src_port >> 8; raw[9] = handle->priv.nsp_src_port & 0xff;
	raw[12] = size + 1;
	raw[NSP_HEADER_SIZE] = cmd;
	memcpy(raw + NSP_HEADER_SIZE + 1, data, size);
	uint16_t crc = 0;
	for (size_t i = NSP_HEADER_SIZE; i < NSP_HEADER_SIZE + size + 1; ++i)
	{
		const uint16_t first = ((uint16_t)raw[i] << 8) | (crc >> 8);
		const uint16_t second = ((((crc & 0xff) & 0x0f) << 4) ^ (crc & 0xff)) << 8;
		const uint16_t third = second >> 5;
		crc = first ^ second ^ third ^ (third >> 7);
	}
	raw[10] = crc >> 8; raw[11] = crc & 0xff;
	for (size_t i = 0; i < NSP_HEADER_SIZE - 1; ++i) raw[15] += raw[i];
	CHECK(!nsp_nnse_queue_stream(handle, raw, NSP_HEADER_SIZE + size + 1));
}
static int directory_event(CalcHandle *handle, uint32_t, const CalcEventData *event, void *)
{
	if (event->type == CALC_EVENT_TYPE_BEFORE_SEND_NSP_VPKT)
	{
		uint8_t data[128] = {};
		const uint8_t cmd = event->data.nsp_vpkt.cmd;
		if (cmd == NSP_CMD_FM_ATTRIBUTES) queue_directory_reply(handle, cmd, data, 9);
		else if (cmd == NSP_CMD_FM_DIRLIST_INIT)
		{
			directory_index = 0;
			directory_root = !strcmp((const char *)event->data.nsp_vpkt.data, "/");
			queue_directory_reply(handle, NSP_CMD_STATUS, data, 1);
		}
		else if (cmd == NSP_CMD_FM_DIRLIST_NEXT)
		{
			const size_t count = sizeof(directory_names) / sizeof(*directory_names);
			if (directory_index < count || (directory_root && directory_index == count))
			{
				const char *name = directory_index < count ? directory_names[directory_index] : "App";
				const size_t len = strlen(name);
				data[1] = len + 10;
				memcpy(data + 2, name, len);
				data[2 + len + 8] = directory_index == count ? NSP_DIR : NSP_TNS;
				queue_directory_reply(handle, NSP_CMD_FM_DIRLIST_ENT, data, len + 12);
				directory_index++;
			}
			else
			{
				data[0] = NSP_ERR_NO_MORE_TO_LIST;
				queue_directory_reply(handle, NSP_CMD_STATUS, data, 1);
			}
		}
		else if (cmd == NSP_CMD_FM_DIRLIST_DONE) queue_directory_reply(handle, NSP_CMD_STATUS, data, 1);
		else CHECK(false);
		return 1234; // bypass the physical cable send
	}
	if (event->type == CALC_EVENT_TYPE_BEFORE_SEND_NSP_RPKT) return 1234;
	if (event->type == CALC_EVENT_TYPE_AFTER_SEND_NSP_VPKT
	    || event->type == CALC_EVENT_TYPE_AFTER_SEND_NSP_RPKT) return 0;
	return event->retval;
}
static int directory_timeout(CableHandle *, uint8_t *, uint32_t) { return ERROR_READ_TIMEOUT; }
static void check_nspire_directory_filenames(void)
{
	CalcHandle *handle = ticalcs_handle_new(CALC_NSPIRE_CXIIT);
	CHECK(handle);
	CableFncts functions = {};
	functions.recv = directory_timeout;
	CableHandle cable = {};
	cable.cable = &functions;
	cable.open = 1;
	cable.timeout = 50;
	handle->cable = &cable;
	handle->open = handle->attached = 1;
	handle->priv.nsp_nnse_mode = 2;
	handle->priv.nsp_nnse_handshake_done = 1;
	ticalcs_calc_set_event_hook(handle, directory_event);
	GNode *vars = nullptr, *apps = nullptr;
	CHECK(!ticalcs_calc_get_dirlist(handle, &vars, &apps));
	for (int folder = 0; folder < 2; ++folder)
	{
		GNode *parent = folder ? g_node_nth_child(vars, sizeof(directory_names) / sizeof(*directory_names)) : vars;
		CHECK(parent);
		for (size_t i = 0; i < sizeof(directory_names) / sizeof(*directory_names); ++i)
		{
			GNode *node = g_node_nth_child(parent, i);
			CHECK(node);
			const VarEntry *entry = (const VarEntry *)node->data;
			CHECK(!strcmp(entry->filename, directory_names[i]));
			CHECK(!strcmp(entry->folder, folder ? "App" : ""));
			char expected[VARNAME_MAX];
			strcpy(expected, directory_names[i]);
			const size_t len = strlen(expected);
			if (len > 4 && !g_ascii_strcasecmp(expected + len - 4, ".tns")) expected[len - 4] = 0;
			CHECK(!strcmp(entry->name, expected));
		}
	}
	ticalcs_dirlist_destroy(&vars);
	ticalcs_dirlist_destroy(&apps);
	handle->attached = 0;
	ticalcs_handle_del(handle);
}

static int check_stream_timeout(CableHandle *cable, uint8_t *, uint32_t);
static int stop_before_nspire_io(CalcHandle *, uint32_t, const CalcEventData *event, void *)
{
	if (event->type == CALC_EVENT_TYPE_BEFORE_SEND_NSP_VPKT)
	{
		const NSPVirtualPacket &packet = event->data.nsp_vpkt;
		if (packet.cmd == NSP_CMD_FM_GET_FILE || packet.cmd == NSP_CMD_FM_DEL_FILE
		    || packet.cmd == NSP_CMD_FM_RENAME_FILE || packet.cmd == NSP_CMD_FM_PUT_FILE)
		{
			CHECK(packet.size > 2);
			snprintf(requested_path, sizeof(requested_path), "%s", (const char *)packet.data + 1);
			if (packet.cmd == NSP_CMD_FM_RENAME_FILE)
			{
				snprintf(requested_destination, sizeof(requested_destination), "%s",
				         (const char *)packet.data + 2 + MAX(strlen(requested_path), (size_t)8));
			}
		}
		return 1234;
	}
	// Simulate a successful request send, then fail the first header read so
	// the actual receive path must restore the scoped generation timeout.
	if (event->type == CALC_EVENT_TYPE_AFTER_SEND_NSP_VPKT
	    && event->data.nsp_vpkt.cmd == NSP_CMD_FM_GET_FILE) return 0;
	if (event->type == CALC_EVENT_TYPE_BEFORE_SEND_NSP_RPKT) return 1234;
	return event->retval;
}

static void check_nspire_filenames_and_requests(void)
{
	CalcHandle *handle = ticalcs_handle_new(CALC_NSPIRE_CXIIT);
	CHECK(handle);
	CableFncts functions = {};
	functions.recv = check_stream_timeout;
	CableHandle cable = {};
	cable.cable = &functions;
	cable.open = 1;
	cable.timeout = 50;
	handle->cable = &cable;
	handle->open = handle->attached = 1;
	handle->priv.nsp_nnse_mode = 1;
	ticalcs_calc_set_event_hook(handle, stop_before_nspire_io);
	const struct { const char *folder, *name, *wire, *path, *filename; } cases[] = {
		{"", "themes.csv", "themes.csv", "/themes.csv", "themes.csv"},
		{"", "NspireLogs.zip", "NspireLogs.zip", "/NspireLogs.zip", "NspireLogs.zip"},
		{"", "themes", "themes.tns", "/themes.tns", "themes.tns"},
		{"", "NspireLogs", "NspireLogs.tns", "/NspireLogs.tns", "NspireLogs.tns"},
		{"", "NspireLogs.zip", "NspireLogs.zip.tns", "/NspireLogs.zip.tns", "NspireLogs.zip.tns"},
		{"", "config", "config", "/config", "config"},
		{"", "config", "config.tns", "/config.tns", "config.tns"},
		{"", "config.dat", "config.dat", "/config.dat", "config.dat"},
		{"", "config.dat", "config.dat.tns", "/config.dat.tns", "config.dat.tns"},
		{"", ".hidden", ".hidden", "/.hidden", ".hidden"},
		{"", ".hidden", ".hidden.tns", "/.hidden.tns", ".hidden.tns"},
		{"Examples", "config", "config", "/Examples/config", "Examples.config"},
		{"Examples", "config", "config.TNS", "/Examples/config.TNS", "Examples.config.TNS"},
		{"Examples", "themes.csv", "themes.csv", "/Examples/themes.csv", "Examples.themes.csv"},
		{"Examples", "NspireLogs.zip", "NspireLogs.zip", "/Examples/NspireLogs.zip", "Examples.NspireLogs.zip"},
		// Text-only legacy callers still request TNS documents, even with dots.
		{"", "themes", "", "/themes.tns", "themes.tns"},
		{"", "nsuit.cfg", "", "/nsuit.cfg.tns", "nsuit.cfg.tns"},
		{"Examples", "NspireLogs.zip", "", "/Examples/NspireLogs.zip.tns", "Examples.NspireLogs.zip.tns"}
	};
	for (const auto &test : cases)
	{
		VarEntry request = {};
		strcpy(request.folder, test.folder);
		strcpy(request.name, test.name);
		strcpy(request.filename, test.wire);
		request.type = NSP_TNS;
		char *filename = tifiles_build_filename(handle->model, &request);
		CHECK(filename && !strcmp(filename, test.filename));
		tifiles_filename_free(filename);
		FileContent *content = tifiles_content_create_regular(handle->model);
		requested_path[0] = 0;
		expected_stream_timeout = !strcmp(test.path, "/NspireLogs.zip") ? 1200 : 50;
		recv_calls = 0;
		CHECK(ticalcs_calc_recv_var(handle, MODE_NORMAL, content, &request) == 1234);
		CHECK(!strcmp(requested_path, test.path));
		CHECK(recv_calls == 1);
		CHECK(cable.timeout == 50);
		CHECK(handle->priv.nsp_nnse_stream_timeout == 0);
		tifiles_content_delete_regular(content);

		requested_path[0] = 0;
		CHECK(ticalcs_calc_del_var(handle, &request) == 1234);
		CHECK(!strcmp(requested_path, test.path));
		VarRequest destination = request;
		strcpy(destination.folder, "Moved");
		requested_path[0] = requested_destination[0] = 0;
		CHECK(ticalcs_calc_rename_var(handle, &request, &destination) == 1234);
		CHECK(!strcmp(requested_path, test.path));
		char expected_destination[sizeof(requested_path)];
		snprintf(expected_destination, sizeof(expected_destination), "/Moved/%s", strrchr(test.path, '/') + 1);
		CHECK(!strcmp(requested_destination, expected_destination));

		// Exact metadata must not enable uploads of non-TNS app data.
		FileContent upload = {};
		VarEntry *entries[] = {&request, nullptr};
		upload.model = handle->model;
		upload.num_entries = 1;
		upload.entries = entries;
		const size_t len = strlen(test.path);
		const bool tns = len > 4 && !g_ascii_strcasecmp(test.path + len - 4, ".tns");
		requested_path[0] = 0;
		CHECK(ticalcs_calc_send_var(handle, MODE_NORMAL, &upload) == (tns ? 1234 : ERR_INVALID_PARAMETER));
		CHECK(tns ? !strcmp(requested_path, test.path) : !requested_path[0]);
	}
	handle->attached = 0;
	ticalcs_handle_del(handle);
}

static int check_stream_timeout(CableHandle *cable, uint8_t *, uint32_t)
{
	CHECK(cable->timeout == expected_stream_timeout);
	recv_calls++;
	return 1234;
}

static int stream_readable(CableHandle *, int *status)
{
	*status = STATUS_RX;
	return 0;
}

static void check_nnse_scoped_timeout(void)
{
	CableFncts functions = {};
	functions.recv = check_stream_timeout;
	functions.check = stream_readable;
	CableHandle cable = {};
	cable.cable = &functions;
	cable.open = 1;
	cable.timeout = 50;
	CalcHandle *handle = ticalcs_handle_new(CALC_NSPIRE_CXIIT);
	CHECK(handle);
	handle->cable = &cable;
	handle->priv.nsp_nnse_mode = 2;
	handle->priv.nsp_nnse_handshake_done = 1;
	uint8_t data[1024];
	uint32_t size = 0;
	const unsigned int timeouts[] = {0U, 1200U, 0U};
	for (unsigned int override_timeout : timeouts)
	{
		handle->priv.nsp_nnse_stream_timeout = override_timeout;
		expected_stream_timeout = override_timeout ? override_timeout : 50;
		recv_calls = 0;
		CHECK(nsp_nnse_recv_stream(handle, data, sizeof(data), &size) == 1234);
		CHECK(recv_calls > 0);
		CHECK(cable.timeout == 50);
	}
	ticalcs_handle_del(handle);
}

int main(void)
{
	check_oversized_legacy_packet_is_drained_and_rejected();
	check_os_receive_size_limit();
	check_nnse_os_receive_accepts_short_split_chunks();
	check_os_status_result();
	check_reply_reverses_request_endpoints();
	check_nspire_directory_filenames();
	check_nspire_filenames_and_requests();
	check_nnse_scoped_timeout();
	return 0;
}
