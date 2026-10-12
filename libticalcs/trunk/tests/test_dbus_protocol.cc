#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <string>
#include <vector>

#include "../src/ticalcs.h"
#include "../src/dbus_pkt.h"
#include "../src/error.h"

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
	CHECK(received <= incoming.size());
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

static void packet(uint8_t mid, uint8_t cmd, const std::vector<uint8_t> &data = {})
{
	incoming.push_back(mid);
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

struct MockCalculator
{
	CableFncts functions = {};
	CableHandle cable = {};
	CalcHandle *handle;

	MockCalculator(CalcModel model)
	{
		incoming.clear();
		outgoing.clear();
		received = 0;
		functions.recv = cable_recv;
		functions.send = cable_send;
		cable.cable = &functions;
		cable.open = 1;
		handle = ticalcs_handle_new(model);
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

static std::string dissect(CalcModel model, const std::vector<uint8_t> &data, int expected = 0)
{
	FILE *file = tmpfile();
	CHECK(file);
	CHECK(dbus_dissect(model, file, data.data(), data.size()) == expected);
	CHECK(fflush(file) == 0);
	CHECK(fseek(file, 0, SEEK_SET) == 0);
	std::string text;
	char buffer[256];
	while (fgets(buffer, sizeof(buffer), file)) text += buffer;
	CHECK(fclose(file) == 0);
	return text;
}

static void check_short_packets()
{
	// DBUSPacket.toBuffer in TI's JAR places SKY/ACK values directly in
	// header bytes 2..3; the model parser does likewise for RDY/DONE/CHK.
	CHECK(dissect(CALC_TI83P, {0x23, 0x87, 0x1b, 0x00}).find("[key=001B]") != std::string::npos);
	CHECK(dissect(CALC_TI83P, {0x73, 0x56, 0x05, 0x00}).find("[status=0005]") != std::string::npos);
	const uint8_t commands[] = {DBUS_CMD_CTS, DBUS_CMD_ERR, DBUS_CMD_ERR2, DBUS_CMD_EOT};
	for (uint8_t command : commands)
	{
		CHECK(dissect(CALC_TI83P, {0x73, command, 0x34, 0x12}).find("[status=1234]") != std::string::npos);
		dissect(CALC_TI83P, {0x73, command, 0x34, 0x12, 0x00, 0x00}, ERR_INVALID_PACKET);
	}
	dissect(CALC_TI83P, {0x73, 0x56}, ERR_INVALID_PACKET);
	dissect(CALC_TI83P, {0x73, 0x56, 0x00}, ERR_INVALID_PACKET);
	// RDC is a parameter packet on the host side; the other data-less
	// commands follow the receive path's four-byte framing.
	const uint8_t host_commands[] = {DBUS_CMD_RDY, DBUS_CMD_SCR, DBUS_CMD_RID, DBUS_CMD_CNT};
	for (uint8_t command : host_commands)
	{
		CHECK(dissect(CALC_TI89, {0x08, command, 0x01, 0x00}).find("[status=0001]") != std::string::npos);
		dissect(CALC_TI89, {0x08, command, 0x01, 0x00, 0x00, 0x00, 0x00}, ERR_INVALID_PACKET);
	}
	CHECK(dissect(CALC_TI83P, {0x23, DBUS_CMD_RDY, 0x00, 0x00}).find("[status=") == std::string::npos);
	dissect(CALC_TI80, {0x00, DBUS_CMD_SCR});
	// Generic RDC requires four bytes even though it shares the TI-80 MID.
	dissect(CALC_NONE, {0x00, DBUS_CMD_RDY}, ERR_INVALID_PACKET);
	dissect(CALC_NONE, {0x00, DBUS_CMD_XDP}, ERR_INVALID_PACKET);
	CHECK(dissect(CALC_NONE, {0x00, DBUS_CMD_RDY, 0x00, 0x00}).find("RDY (Request Device Characteristics)") != std::string::npos);
	dissect(CALC_TI80, {0x80, DBUS_CMD_ACK});
	dissect(CALC_TI80, {0x80, DBUS_CMD_ACK, 0x00, 0x00}, ERR_INVALID_PACKET);
	dissect(CALC_TI83P, {0x73, DBUS_CMD_XDP, 0x01, 0x00, 0x51, 0x51, 0x00});
	dissect(CALC_TI83P, {0x73, DBUS_CMD_XDP, 0x01, 0x00, 0x51}, ERR_INVALID_PACKET);
	{
		MockCalculator calc(CALC_TI80);
		CHECK(dbus_send(calc.handle, DBUS_MID_PC_TI80, DBUS_CMD_SCR, 0, nullptr) == 0);
		CHECK(outgoing == (std::vector<uint8_t>{DBUS_MID_PC_TI80, DBUS_CMD_SCR}));
	}
	{
		MockCalculator calc(CALC_TI83P);
		CHECK(dbus_send(calc.handle, DBUS_MID_PC_TIXX, DBUS_TI_CMD_RDC, 0, nullptr) == 0);
		CHECK(outgoing == (std::vector<uint8_t>{DBUS_MID_PC_TIXX, DBUS_TI_CMD_RDC, 0, 0}));
	}
}

static void check_64k_flash_packet()
{
	std::vector<uint8_t> data(65536U + 6, 0);
	data[0] = DBUS_MID_PC_TI89;
	data[1] = DBUS_CMD_XDP;
	for (size_t i = 0; i < 65536; i++) data[i + 4] = (uint8_t)(i * 37 + 0x5b);
	const uint16_t sum = tifiles_checksum(data.data() + 4, 65536);
	data[65540] = sum & 0xff;
	data[65541] = sum >> 8;
	CHECK(dissect(CALC_TI89, data).find("00010000") == 0);
	// The 64 KiB convention comes from the existing TI-68k Flash sender;
	// it is deliberately not generalized to Z80 packets or other commands.
	dissect(CALC_TI83P, data, ERR_INVALID_PACKET);
	data[1] = DBUS_CMD_VAR;
	dissect(CALC_TI89, data, ERR_INVALID_PACKET);
}

static void check_device_information(CalcModel handle_model, uint8_t hardware,
                                     CalcModel expected_model, size_t length = 8)
{
	MockCalculator calc(handle_model);
	const uint8_t host = handle_model == CALC_TI73 ? DBUS_MID_TI73_PC : DBUS_MID_TI83p_PC;
	const uint8_t target = handle_model == CALC_TI73 ? DBUS_MID_PC_TI73 : DBUS_MID_PC_TI83p;
	std::vector<uint8_t> data = {1, (uint8_t)(handle_model == CALC_TI73 ? 0x91 : 19), 1, 2, 3, hardware, 7, 9};
	data.resize(length, 0xa5);
	packet(host, DBUS_CMD_ACK);
	packet(host, DBUS_CMD_ACK);
	packet(host, DBUS_CMD_XDP, data);
	CalcInfos infos;
	memset(&infos, 0xa5, sizeof(infos));
	CHECK(ticalcs_calc_get_version(calc.handle, &infos) == (length < DBUS_RDI_MIN_SIZE ? ERR_INVALID_PACKET : 0));
	CHECK(received == incoming.size());
	const std::vector<uint8_t> expected = {
		target, DBUS_TI_CMD_RDI, 0, 0,
		target, DBUS_TI_CMD_RDY, 0, 0,
		target, DBUS_TI_CMD_ACK, 0, 0
	};
	CHECK(outgoing == expected);
	if (length < DBUS_RDI_MIN_SIZE)
	{
		CHECK(infos.mask == 0);
		return;
	}
	const uint64_t fields = INFOS_OS_VERSION | INFOS_BOOT_VERSION | INFOS_BATTERY_ENOUGH
	                      | INFOS_HW_VERSION | INFOS_LANG_ID | INFOS_SUB_LANG_ID;
	CHECK((infos.mask & fields) == fields);
	CHECK(infos.hw_version == hardware);
	CHECK(infos.battery == 0);
	CHECK(infos.language_id == 7);
	CHECK(infos.sub_lang_id == 9);
	CHECK(strcmp(infos.boot_version, "1.02") == 0);
	CHECK(strcmp(infos.os_version, handle_model == CALC_TI73 ? "1.91" : "1.19") == 0);
	CHECK((infos.mask & INFOS_CALC_MODEL) == (expected_model == CALC_NONE ? 0 : INFOS_CALC_MODEL));
	CHECK(infos.model == expected_model);
}

static void check_public_probe(uint8_t hardware, CalcModel expected_model, bool usb_probe)
{
	MockCalculator calc(CALC_TI83P);
	calc.cable.model = CABLE_SLV;
	packet(DBUS_MID_TI83p_PC, DBUS_CMD_ACK); // RDC acknowledgement.
	packet(DBUS_MID_TI83p_PC, DBUS_CMD_ACK); // RDI acknowledgement.
	packet(DBUS_MID_TI83p_PC, DBUS_CMD_ACK); // RDY acknowledgement.
	packet(DBUS_MID_TI83p_PC, DBUS_CMD_XDP, {1, 19, 1, 2, 0, hardware, 0, 0});
	CalcModel detected = CALC_NONE;
	CHECK((usb_probe ? ticalcs_probe_usb_calc(&calc.cable, &detected)
	                 : ticalcs_probe_calc(&calc.cable, &detected)) == 0);
	CHECK(detected == expected_model);
	CHECK(received == incoming.size());
	CHECK(outgoing == (std::vector<uint8_t>{
		DBUS_MID_PC_TIXX, DBUS_TI_CMD_RDC, 0, 0,
		DBUS_MID_PC_TI83p, DBUS_TI_CMD_RDI, 0, 0,
		DBUS_MID_PC_TI83p, DBUS_TI_CMD_RDY, 0, 0,
		DBUS_MID_PC_TI83p, DBUS_TI_CMD_ACK, 0, 0
	}));
}

static void check_public_probe_ti73()
{
	MockCalculator calc(CALC_TI73);
	calc.cable.model = CABLE_SLV;
	packet(DBUS_MID_TI73_PC, DBUS_CMD_ACK);
	CalcModel detected = CALC_NONE;
	CHECK(ticalcs_probe_usb_calc(&calc.cable, &detected) == 0);
	CHECK(detected == CALC_TI73);
	CHECK(received == incoming.size());
	CHECK(outgoing == (std::vector<uint8_t>{DBUS_MID_PC_TIXX, DBUS_TI_CMD_RDC, 0, 0}));
}

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

static void check_commands()
{
	struct Command { uint8_t value; uint8_t alias; const char *name; const char *description; };
	const Command commands[] = {
		{0x56, DBUS_TI_CMD_ACK, "ACK", "Acknowledge"},
		{0x5a, DBUS_TI_CMD_CHK, "CHK", "Checksum Error"},
		{0x2a, DBUS_TI_CMD_DBL, "DBL", "Disable Background Processing Link"},
		{0x2c, DBUS_TI_CMD_DKE, "DKE", "Disable Key Echo"},
		{0x92, DBUS_TI_CMD_DONE, "DONE", "Done"},
		{0x88, DBUS_TI_CMD_DVL, "DVL", "Delete Variable Link"},
		{0x29, DBUS_TI_CMD_EBL, "EBL", "Enable Background Processing Link"},
		{0x2b, DBUS_TI_CMD_EKE, "EKE", "Enable Key Echo"},
		{0x36, DBUS_TI_CMD_EOR, "EOR", "Error on Request"},
		{0x89, DBUS_TI_CMD_EPL, "EPL", "Execute Program Link"},
		{0xa2, DBUS_TI_CMD_GET, "GET", "Get Data Object"},
		{0xb7, DBUS_TI_CMD_GTE, "GTE", "Get Data Element"},
		{0x68, DBUS_TI_CMD_RDC, "RDC", "Request Device Characteristics"},
		{0x2d, DBUS_TI_CMD_RDI, "RDI", "Request Device Information"},
		{0x6d, DBUS_TI_CMD_REQ, "REQ", "Request Screen Image"},
		{0x09, DBUS_TI_CMD_RDY, "RDY", "Ready for Data"},
		{0x74, DBUS_TI_CMD_RIOA, "RIOA", "Request I/O Address"},
		{0x78, DBUS_TI_CMD_RTC, "RTC", "Request To Continue"},
		{0x06, DBUS_TI_CMD_RTS, "RTS", "Request To Send"},
		{0xca, DBUS_TI_CMD_SETP, "SETP", "Send and Execute Temporary Program"},
		{0xc9, DBUS_TI_CMD_SEND, "SEND", "Send Data Object"},
		{0x87, DBUS_TI_CMD_SKY, "SKY", "Send Keypress"},
		{0x47, DBUS_TI_CMD_SIOA, "SIOA", "Set IO Address"},
		{0x15, DBUS_TI_CMD_XDP, "XDP", "Transmit Data Packet"},
	};
	for (const Command &command : commands)
	{
		CHECK(command.value == command.alias);
		CHECK(strcmp(dbus_cmd2officialname(command.value), command.name) == 0);
		CHECK(strcmp(dbus_cmd2desc(command.value), command.description) == 0);
	}
	// The established libticalcs spellings retain their old wire meaning.
	CHECK(DBUS_CMD_RTS == 0xc9 && DBUS_CMD_RDY == 0x68 && DBUS_CMD_REQ == 0xa2);
}

int main()
{
	CHECK(ticalcs_library_init() == 1);
	check_commands();
	check_short_packets();
	check_64k_flash_packet();
	check_device_information(CALC_TI73, 0, CALC_TI73);
	check_device_information(CALC_TI73, 1, CALC_NONE);
	check_device_information(CALC_TI83P, 0, CALC_TI83P);
	check_device_information(CALC_TI83P, 1, CALC_TI83P);
	check_device_information(CALC_TI84P, 2, CALC_TI84P);
	check_device_information(CALC_TI84P, 3, CALC_TI84P);
	check_device_information(CALC_TI84PC, 5, CALC_TI84PC);
	check_device_information(CALC_TI84PC, 4, CALC_NONE);
	check_device_information(CALC_TI84PC, 0xff, CALC_NONE);
	for (size_t length = 8; length <= 11; length++) check_device_information(CALC_TI83P, 0, CALC_TI83P, length);
	check_device_information(CALC_TI83P, 0, CALC_NONE, 7);
	check_ti73_types();
	check_public_probe_ti73();
	for (bool usb_probe : {true, false})
	{
		check_public_probe(0, CALC_TI83P, usb_probe);
		check_public_probe(2, CALC_TI84P, usb_probe);
		check_public_probe(5, CALC_TI84PC, usb_probe);
		check_public_probe(4, CALC_TI83P, usb_probe);
		check_public_probe(0xff, CALC_TI83P, usb_probe);
	}
	CHECK(ticalcs_library_exit() == 0);
	puts("DBUS command, framing, RDI and TI-73 type tests passed");
	return 0;
}
