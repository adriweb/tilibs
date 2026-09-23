#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <vector>
#include <glib.h>
#include <glib/gstdio.h>

#include "../src/ticalcs.h"
#include "../src/dbus_pkt.h"

#define CHECK(condition) \
	do { \
		if (!(condition)) { \
			fprintf(stderr, "%s:%d: check failed: %s\n", __FILE__, __LINE__, #condition); \
			abort(); \
		} \
	} while (0)

static std::vector<uint8_t> incoming, outgoing;
static size_t received;

static int cable_recv(CableHandle *, uint8_t *data, uint32_t length)
{
	CHECK(length <= incoming.size() - received);
	if (length) memcpy(data, incoming.data() + received, length);
	received += length;
	return 0;
}

static int cable_send(CableHandle *, uint8_t *data, uint32_t length)
{
	outgoing.insert(outgoing.end(), data, data + length);
	return 0;
}

static void packet(uint8_t cmd, const std::vector<uint8_t> &data = {})
{
	incoming.push_back(DBUS_MID_TI92_PC);
	incoming.push_back(cmd);
	incoming.push_back(data.size() & 0xff);
	incoming.push_back(data.size() >> 8);
	if (!data.empty())
	{
		incoming.insert(incoming.end(), data.begin(), data.end());
		const uint16_t sum = tifiles_checksum(data.data(), data.size());
		incoming.push_back(sum & 0xff);
		incoming.push_back(sum >> 8);
	}
}

static void backup_block(const char *version, uint32_t announced, const std::vector<uint8_t> &payload)
{
	std::vector<uint8_t> header = {
		(uint8_t)announced, (uint8_t)(announced >> 8),
		(uint8_t)(announced >> 16), (uint8_t)(announced >> 24),
		TI92_BKUP, (uint8_t)strlen(version)
	};
	header.insert(header.end(), version, version + strlen(version));
	packet(DBUS_CMD_VAR, header);
	packet(DBUS_CMD_ACK);
	std::vector<uint8_t> data(4, 0);
	data.insert(data.end(), payload.begin(), payload.end());
	packet(DBUS_CMD_XDP, data);
}

struct MockCalculator
{
	CableFncts functions = {};
	CableHandle cable = {};
	CalcHandle *handle;

	MockCalculator()
	{
		incoming.clear();
		outgoing.clear();
		received = 0;
		functions.recv = cable_recv;
		functions.send = cable_send;
		cable.cable = &functions;
		cable.open = 1;
		handle = ticalcs_handle_new(CALC_TI92);
		CHECK(handle);
		handle->cable = &cable;
		handle->open = handle->attached = 1;
	}

	~MockCalculator()
	{
		handle->attached = 0;
		ticalcs_handle_del(handle);
	}
};

static void check_saved_backup(BackupContent *content, const char *name,
                               const std::vector<uint8_t> &payload)
{
	GError *error = nullptr;
	char *dir = g_dir_make_tmp("tilibs-ti92-backup-XXXXXX", &error);
	CHECK(dir && !error);
	char *path = g_build_filename(dir, "backup.92b", nullptr);
	CHECK(tifiles_file_write_backup(path, content) == 0);
	char *bytes = nullptr;
	gsize size = 0;
	CHECK(g_file_get_contents(path, &bytes, &size, &error));
	CHECK(size == 0x52 + payload.size() + 2);
	char expected_name[8] = {};
	memcpy(expected_name, name, strlen(name));
	CHECK(memcmp(bytes + 0x40, expected_name, 8) == 0);
	CHECK(memcmp(bytes + 0x52, payload.data(), payload.size()) == 0);
	const uint16_t sum = tifiles_checksum(payload.data(), payload.size());
	CHECK((uint8_t)bytes[size - 2] == (sum & 0xff));
	CHECK((uint8_t)bytes[size - 1] == (sum >> 8));
	BackupContent *reread = tifiles_content_create_backup(CALC_TI92);
	CHECK(tifiles_file_read_backup(path, reread) == 0);
	CHECK(strcmp(reread->rom_version, name) == 0);
	CHECK(reread->data_length == payload.size());
	CHECK(memcmp(reread->data_part, payload.data(), payload.size()) == 0);
	tifiles_content_delete_backup(reread);
	g_free(bytes);
	CHECK(g_remove(path) == 0);
	CHECK(g_rmdir(dir) == 0);
	g_free(path);
	g_free(dir);
}

static void check_receive_name(const char *version, const char *name)
{
	MockCalculator calc;
	const std::vector<uint8_t> payload = { 0x19, 0x23, 0xa5 };
	packet(DBUS_CMD_ACK);
	backup_block(version, payload.size(), payload);
	packet(DBUS_CMD_EOT);
	BackupContent *content = tifiles_content_create_backup(CALC_TI92);
	CHECK(ticalcs_calc_recv_backup(calc.handle, content) == 0);
	CHECK(received == incoming.size());
	CHECK(strcmp(content->rom_version, name) == 0);
	check_saved_backup(content, name, payload);
	tifiles_content_delete_backup(content);
}

static void check_send_name(const char *version, const char *name)
{
	MockCalculator calc;
	packet(DBUS_CMD_ACK); // initial backup header
	packet(DBUS_CMD_ACK); // block header
	packet(DBUS_CMD_CTS);
	packet(DBUS_CMD_ACK); // block data
	uint8_t payload[] = { 0x19, 0x23, 0xa5 };
	BackupContent content = {};
	content.model = CALC_TI92;
	content.type = TI92_BKUP;
	strcpy(content.rom_version, version);
	content.data_part = payload;
	content.data_length = sizeof(payload);
	CHECK(ticalcs_calc_send_backup(calc.handle, &content) == 0);
	CHECK(received == incoming.size());
	CHECK(strcmp(content.rom_version, version) == 0);
	size_t pos = 0;
	unsigned int headers = 0, data_packets = 0;
	while (pos < outgoing.size())
	{
		CHECK(pos + 4 <= outgoing.size());
		CHECK(outgoing[pos] == DBUS_MID_PC_TI92);
		const uint8_t cmd = outgoing[pos + 1];
		const size_t length = outgoing[pos + 2] | (outgoing[pos + 3] << 8);
		CHECK(pos + 4 + length + (length ? 2 : 0) <= outgoing.size());
		const uint8_t *data = outgoing.data() + pos + 4;
		if (cmd == DBUS_CMD_VAR)
		{
			CHECK(length == 6 + strlen(name));
			CHECK(data[5] == strlen(name));
			CHECK(memcmp(data + 6, name, strlen(name)) == 0);
			headers++;
		}
		else if (cmd == DBUS_CMD_XDP)
		{
			CHECK(length == sizeof(payload));
			CHECK(memcmp(data, payload, length) == 0);
			data_packets++;
		}
		pos += 4 + length + (length ? 2 : 0);
	}
	CHECK(headers == 2 && data_packets == 1);
}

int main(void)
{
	const char *versions[] = { "0.5d23", "0.6a19", "0.6a50", "1.0", "1.0b1", "1.12", "2.1", "a" };
	for (const char *version : versions)
	{
		const char *name = version[0] == '0' ? "a" : version;
		check_receive_name(version, name);
		check_send_name(version, name);
	}
	return 0;
}
