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
	dissect(CALC_TI80, {0x00, DBUS_CMD_SCR});
	dissect(CALC_TI80, {0x80, DBUS_CMD_ACK});
	dissect(CALC_TI80, {0x80, DBUS_CMD_ACK, 0x00, 0x00}, ERR_INVALID_PACKET);
	dissect(CALC_TI83P, {0x73, DBUS_CMD_XDP, 0x01, 0x00, 0x51, 0x51, 0x00});
	dissect(CALC_TI83P, {0x73, DBUS_CMD_XDP, 0x01, 0x00, 0x51}, ERR_INVALID_PACKET);
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
	CHECK(ticalcs_library_exit() == 0);
	puts("DBUS command and framing tests passed");
	return 0;
}
