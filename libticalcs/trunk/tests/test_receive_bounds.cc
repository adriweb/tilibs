#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <vector>

#include "tifiles.h"
#include "../src/ticalcs.h"
#include "../src/error.h"
#include "../src/cmd68k.h"
#include "../src/dusb_cmd.h"
#include "../src/dusb_rpkt.h"
#include "../src/dusb_vpkt.h"
#include "../src/nsp_limits.h"
#include "../src/nsp_vpkt.h"
#include "../src/romdump.h"

#define CHECK(condition) \
	do { \
		if (!(condition)) { \
			fprintf(stderr, "%s:%d: check failed: %s\n", __FILE__, __LINE__, #condition); \
			abort(); \
		} \
	} while (0)

static std::vector<uint8_t> incoming;
static size_t received;

static int cable_recv(CableHandle *, uint8_t *data, uint32_t length)
{
	CHECK(received <= incoming.size());
	CHECK(length <= incoming.size() - received);
	if (length != 0)
	{
		memcpy(data, incoming.data() + received, length);
	}
	received += length;
	return 0;
}

static int cable_send(CableHandle *, uint8_t *, uint32_t)
{
	return 0;
}

struct MockCalculator
{
	CableFncts functions = {};
	CableHandle cable = {};
	CalcHandle *handle;

	explicit MockCalculator(CalcModel model)
	{
		incoming.clear();
		received = 0;
		functions.recv = cable_recv;
		functions.send = cable_send;
		cable.cable = &functions;
		cable.open = 1;
		cable.timeout = 50;
		handle = ticalcs_handle_new(model);
		CHECK(handle);
		handle->updat->cancel = 0;
		handle->cable = &cable;
		handle->open = handle->attached = 1;
	}

	~MockCalculator()
	{
		handle->attached = 0;
		ticalcs_handle_del(handle);
	}
};

static void queue_dbus_packet(uint8_t command, const std::vector<uint8_t> &payload, uint8_t host = 0x98)
{
	incoming.push_back(host);
	incoming.push_back(command);
	incoming.push_back((uint8_t)payload.size());
	incoming.push_back((uint8_t)(payload.size() >> 8));
	incoming.insert(incoming.end(), payload.begin(), payload.end());
	const uint16_t checksum = tifiles_checksum(payload.data(), (uint32_t)payload.size());
	incoming.push_back((uint8_t)checksum);
	incoming.push_back((uint8_t)(checksum >> 8));
}

static void queue_dbus_header(uint8_t command, uint8_t host = 0x98)
{
	incoming.insert(incoming.end(), {host, command, 0, 0});
}

static void check_dbus_capacity_and_drain()
{
	MockCalculator calc(CALC_TI89);
	queue_dbus_packet(0x15, {1, 2, 3, 4, 5});
	const size_t first_packet_size = incoming.size();
	queue_dbus_packet(0x15, {6, 7});
	const size_t second_packet_size = incoming.size();
	queue_dbus_packet(0x15, {8, 9, 10});
	const size_t third_packet_size = incoming.size();
	queue_dbus_packet(0x15, {11});

	uint8_t host = 0, command = 0;
	uint16_t length = 0;
	uint8_t guarded[6] = {0xa5, 0, 0, 0, 0, 0x5a};
	CHECK(dbus_recv_sized(calc.handle, &host, &command, &length, guarded + 1, 4) == ERR_INVALID_PACKET);
	CHECK(length == 5 && received == first_packet_size);
	CHECK(guarded[0] == 0xa5 && guarded[5] == 0x5a);

	uint8_t exact[2] = {};
	CHECK(dbus_recv_sized(calc.handle, &host, &command, &length, exact, sizeof(exact)) == 0);
	CHECK(length == sizeof(exact) && exact[0] == 6 && exact[1] == 7);
	CHECK(received == second_packet_size);

	CHECK(dbus_recv_sized(calc.handle, &host, &command, &length, nullptr, 0) == ERR_INVALID_PACKET);
	CHECK(length == 3 && received == third_packet_size);
	CHECK(dbus_recv_sized(calc.handle, &host, &command, &length, exact, sizeof(exact)) == 0);
	CHECK(length == 1 && exact[0] == 11);
	CHECK(received == incoming.size());

	std::vector<uint8_t> block(65536);
	for (size_t i = 0; i < block.size(); i++)
	{
		block[i] = (uint8_t)i;
	}
	queue_dbus_packet(0x15, block);
	const size_t block_end = incoming.size();
	queue_dbus_packet(0x15, {0x5a});
	std::vector<uint8_t> output(block.size());
	CHECK(dbus_recv_sized(calc.handle, &host, &command, &length, output.data(), output.size()) == 0);
	CHECK(command == 0x15 && length == 0 && output == block && received == block_end);
	CHECK(dbus_recv_sized(calc.handle, &host, &command, &length, exact, sizeof(exact)) == 0);
	CHECK(length == 1 && exact[0] == 0x5a && received == incoming.size());
}

static std::vector<uint8_t> make_68k_var(const std::vector<uint8_t> &name, bool flag = false)
{
	std::vector<uint8_t> payload = {4, 3, 2, 1, 0x0c, (uint8_t)name.size()};
	payload.insert(payload.end(), name.begin(), name.end());
	if (flag)
	{
		payload.push_back(1);
	}
	return payload;
}

static int receive_89_var(const std::vector<uint8_t> &payload, size_t capacity,
	std::vector<uint8_t> *storage = nullptr)
{
	MockCalculator calc(CALC_TI89);
	queue_dbus_packet(0x06, payload);
	std::vector<uint8_t> local(capacity + 2, 0xa5);
	char *name = (char *)local.data() + 1;
	uint32_t size = 0;
	uint8_t type = 0;
	const int result = ti89_recv_VAR_sized(calc.handle, &size, &type, name, capacity);
	CHECK(local.front() == 0xa5 && local.back() == 0xa5);
	CHECK(received == incoming.size());
	if (storage)
	{
		*storage = local;
	}
	return result;
}

static void check_68k_name_bounds()
{
	std::vector<uint8_t> storage;
	CHECK(receive_89_var(make_68k_var({'m', 'a', 'i', 'n', '\\', 'X'}, true), 2, &storage) == 0);
	CHECK(!strcmp((const char *)storage.data() + 1, "X"));
	CHECK(receive_89_var(make_68k_var({'X'}), 1) == ERR_INVALID_PACKET);
	CHECK(receive_89_var(make_68k_var(std::vector<uint8_t>(18, 'A')), 18) == ERR_INVALID_PACKET);
	CHECK(receive_89_var({0, 0, 0, 0, 1}, 18) == ERR_INVALID_PACKET);
	CHECK(receive_89_var(make_68k_var({'A', 0, 'B'}), 18) == ERR_INVALID_PACKET);

	MockCalculator calc(CALC_TI89);
	queue_dbus_packet(0x06, make_68k_var(std::vector<uint8_t>(9, 'R')));
	uint32_t size = 0;
	uint8_t type = 0;
	uint8_t guarded[11];
	memset(guarded, 0x5a, sizeof(guarded));
	CHECK(ti89_recv_RTS_sized(calc.handle, &size, &type, (char *)guarded + 1, 9) == ERR_INVALID_PACKET);
	CHECK(guarded[0] == 0x5a && guarded[10] == 0x5a);
}

static void queue_rom_packet(uint16_t command, const std::vector<uint8_t> &payload)
{
	const size_t start = incoming.size();
	incoming.push_back((uint8_t)command);
	incoming.push_back((uint8_t)(command >> 8));
	incoming.push_back((uint8_t)payload.size());
	incoming.push_back((uint8_t)(payload.size() >> 8));
	incoming.insert(incoming.end(), payload.begin(), payload.end());
	const uint16_t checksum = tifiles_checksum(incoming.data() + start, (uint32_t)payload.size() + 4U);
	incoming.push_back((uint8_t)checksum);
	incoming.push_back((uint8_t)(checksum >> 8));
}

static int receive_rom_size(const std::vector<uint8_t> &size_payload, bool valid, uint16_t command = 0x0003)
{
	MockCalculator calc(CALC_TI83P);
	queue_rom_packet(0x0001, {});
	queue_rom_packet(command, size_payload);
	if (valid)
	{
		queue_rom_packet(0x0001, {});
	}
	const char *filename = "test_receive_bounds.rom";
	remove(filename);
	const int result = rd_read_dump(calc.handle, filename);
	remove(filename);
	if (valid)
	{
		CHECK(result == 0);
	}
	CHECK(received == incoming.size());
	return result;
}

static void check_rom_size_bounds()
{
	CHECK(receive_rom_size({0, 0, 0}, false) == ERR_INVALID_PACKET);
	CHECK(receive_rom_size({0, 0, 0, 0}, true) == 0);
	CHECK(receive_rom_size({0, 0, 0, 0, 0}, false) == ERR_INVALID_PACKET);
	CHECK(receive_rom_size({0, 0, 0, 0}, false, 0x0002) == ERR_INVALID_PACKET);
	CHECK(receive_rom_size({0, 0, 0, 0}, false, 0x0006) == ERR_INVALID_PACKET);
	// cmdReqSize in romdump_834pce_usb/romdump.z80 replies with command zero.
	CHECK(receive_rom_size({}, false, 0x0000) == ERR_INVALID_PACKET);
	CHECK(receive_rom_size({0, 0, 0}, false, 0x0000) == ERR_INVALID_PACKET);
	CHECK(receive_rom_size({0, 0, 0, 0, 0}, false, 0x0000) == ERR_INVALID_PACKET);
	CHECK(receive_rom_size({0, 0, 0, 0}, true, 0x0000) == 0);
}

static void check_rom_dump(CalcModel model, bool ce, uint16_t block_size, uint8_t repeated_high_byte = 0xa5)
{
	MockCalculator calc(model);
	// Replay the block and repeated-value formats emitted by each dumper.
	// CE has variable block lengths; Z80 and 68k use fixed-size blocks.
	const uint16_t repeated_size = ce ? 5 : block_size;
	const uint32_t rom_size = (uint32_t)block_size + repeated_size;
	std::vector<uint8_t> expected(block_size);
	for (size_t i = 0; i < expected.size(); i++)
	{
		expected[i] = (uint8_t)i;
	}
	queue_rom_packet(0x0001, {});
	queue_rom_packet(ce ? 0x0000 : 0x0003, {
		(uint8_t)rom_size, (uint8_t)(rom_size >> 8),
		(uint8_t)(rom_size >> 16), (uint8_t)(rom_size >> 24)
	});
	queue_rom_packet(0x0006, expected);
	if (model == CALC_TI83PCE_USB)
	{
		const std::vector<std::vector<uint8_t>> malformed = {
			{}, {5}, {5, 0}, {5, 0, 0xa5, 0xa5, 0xa5},
			{0, 0, 0xa5}, {0, 0, 0xa5, 0xa5}
		};
		for (const auto &payload : malformed)
		{
			queue_rom_packet(0x0007, payload);
			// rd_read_dump resynchronizes three times before retrying the block.
			for (unsigned int i = 0; i < 3; i++)
			{
				queue_rom_packet(0x0001, {});
			}
		}
	}
	std::vector<uint8_t> repeated = {(uint8_t)repeated_size, (uint8_t)(repeated_size >> 8), 0xa5};
	if (!ce)
	{
		repeated.push_back(repeated_high_byte);
	}
	queue_rom_packet(0x0007, repeated);
	queue_rom_packet(0x0002, {});
	expected.insert(expected.end(), repeated_size, 0xa5);
	const char *filename = "test_receive_bounds.rom";
	remove(filename);
	CHECK(rd_read_dump(calc.handle, filename) == 0);
	CHECK(received == incoming.size());
	FILE *file = fopen(filename, "rb");
	CHECK(file);
	std::vector<uint8_t> actual(expected.size());
	CHECK(fread(actual.data(), 1, actual.size(), file) == actual.size());
	CHECK(fgetc(file) == EOF);
	CHECK(fclose(file) == 0);
	CHECK(actual == expected);
	CHECK(remove(filename) == 0);
}

static void queue_nsp_fragment(const std::vector<uint8_t> &data, uint8_t sequence)
{
	CHECK(data.size() <= 254);
	incoming.insert(incoming.end(), {
		0x54, 0xfd, 0x64, 0x01, 0x40, 0x03, 0x64, 0x00,
		0x40, 0x03, 0, 0, (uint8_t)data.size(), 0, sequence, 0
	});
	incoming.insert(incoming.end(), data.begin(), data.end());
}

static int receive_nsp_fragments(uint32_t expected_size, uint32_t final_payload_size)
{
	MockCalculator calc(CALC_NSPIRE);
	std::vector<uint8_t> first(254, 0x11);
	first[0] = 0x42;
	queue_nsp_fragment(first, 1);
	std::vector<uint8_t> second(final_payload_size + 1U, 0x22);
	second[0] = 0x42;
	queue_nsp_fragment(second, 2);

	NSPVirtualPacket packet = {};
	packet.size = expected_size;
	const int result = nsp_recv_data(calc.handle, &packet);
	CHECK(received == incoming.size());
	g_free(packet.data);
	return result;
}

static void check_nsp_fragment_bounds()
{
	CHECK(receive_nsp_fragments(254, 1) == 0);
	CHECK(receive_nsp_fragments(254, 2) == ERR_INVALID_PACKET);

	{
		MockCalculator calc(CALC_NSPIRE);
		incoming.insert(incoming.end(), {
			0x54, 0xfd, 0x64, 0x01, 0x40, 0x03, 0x64, 0x00,
			0x40, 0x03, 0, 0, 255, 0, 1, 0
		});
		incoming.insert(incoming.end(), 255, 0x33);
		const size_t first_packet_size = incoming.size();
		queue_nsp_fragment({0x42}, 2);
		NSPRawPacket raw = {};
		CHECK(nsp_recv(calc.handle, &raw) == ERR_INVALID_PACKET);
		CHECK(received == first_packet_size);
		CHECK(nsp_recv(calc.handle, &raw) == 0);
		CHECK(received == incoming.size() && raw.data_size == 1 && raw.data[0] == 0x42);
	}

	CHECK(!nsp_vpkt_append_size_valid(UINT32_MAX - 1U, 0, 4));
	CHECK(!nsp_vpkt_append_size_valid(NSP_VIRTUAL_PACKET_MAX_SIZE - 1U, 0, 2));
	CHECK(nsp_vpkt_append_size_valid(2, 4, 2));
	CHECK(!nsp_vpkt_append_size_valid(2, 4, 3));
}

static void queue_dusb_param_data(const std::vector<uint8_t> &payload)
{
	const unsigned int size = (unsigned int)payload.size() + 6U;
	incoming.insert(incoming.end(), {0, 0, (uint8_t)(size >> 8), (uint8_t)size, 4,
		0, 0, (uint8_t)(payload.size() >> 8), (uint8_t)payload.size(), 0, DUSB_VPKT_PARM_DATA});
	incoming.insert(incoming.end(), payload.begin(), payload.end());
}

static int receive_dusb_params(const std::vector<uint8_t> &payload, bool check_valid = false)
{
	MockCalculator calc(CALC_TI89T_USB);
	queue_dusb_param_data(payload);
	DUSBCalcParam **params = dusb_cp_new_array(calc.handle, 1);
	CHECK(params);
	const int result = dusb_cmd_r_param_data(calc.handle, 1, params);
	CHECK(received == incoming.size());
	if (check_valid)
	{
		CHECK(result == 0 && params[0]);
		CHECK(params[0]->id == 0x1234 && params[0]->ok && params[0]->size == 2);
		CHECK(params[0]->data[0] == 0xaa && params[0]->data[1] == 0xbb);
	}
	dusb_cp_del_array(calc.handle, params, 1);
	return result;
}

static void check_dusb_parameter_bounds()
{
	CHECK(receive_dusb_params({0, 1, 0x12, 0x34, 0, 0, 2, 0xaa, 0xbb}, true) == 0);
	const std::vector<std::vector<uint8_t>> malformed = {
		{}, {0}, {0, 1}, {0, 1, 0x12}, {0, 1, 0x12, 0x34},
		{0, 1, 0x12, 0x34, 0}, {0, 1, 0x12, 0x34, 0, 0},
		{0, 1, 0x12, 0x34, 0, 0, 2}, {0, 1, 0x12, 0x34, 0, 0, 2, 0xaa},
		{0, 1, 0x12, 0x34, 1, 0}
	};
	for (const auto &payload : malformed)
	{
		CHECK(receive_dusb_params(payload) == ERR_INVALID_PACKET);
	}
}

static void check_dusb_virtual_packet_bounds()
{
	CHECK(dusb_vpkt_append_size_valid(DUSB_VIRTUAL_PACKET_MAX_SIZE - 1U, 1));
	CHECK(!dusb_vpkt_append_size_valid(DUSB_VIRTUAL_PACKET_MAX_SIZE - 1U, 2));
	CHECK(!dusb_vpkt_append_size_valid(UINT32_MAX - 1U, 4));

	MockCalculator calc(CALC_TI89T_USB);
	const uint32_t declared_size = DUSB_VIRTUAL_PACKET_MAX_SIZE + 1U;
	incoming.insert(incoming.end(), {0, 0, 0, DUSB_DH_SIZE, DUSB_RPKT_VIRT_DATA_LAST,
		(uint8_t)(declared_size >> 24), (uint8_t)(declared_size >> 16),
		(uint8_t)(declared_size >> 8), (uint8_t)declared_size, 0, DUSB_VPKT_PARM_DATA});
	DUSBVirtualPacket packet = {};
	uint32_t returned_size = 0;
	CHECK(dusb_recv_data_varsize(calc.handle, &packet, &returned_size, 0) == ERR_INVALID_PACKET);
	CHECK(returned_size == declared_size && received == incoming.size() && packet.data == nullptr);
}

static void check_color_screenshot_bounds()
{
	MockCalculator calc(CALC_TI84PC);
	queue_dbus_header(0x56, 0x73);
	const std::vector<uint8_t> fragment(65535, 0x11);
	for (unsigned int i = 0; i < 5; i++)
	{
		queue_dbus_packet(0x15, fragment, 0x73);
	}
	CalcScreenCoord screen = {};
	uint8_t *bitmap = nullptr;
	CHECK(ticalcs_calc_recv_screen(calc.handle, &screen, &bitmap) == ERR_INVALID_PACKET);
	CHECK(bitmap == nullptr && received == incoming.size());

	uint8_t decoded[2] = {};
	const uint8_t short_input[] = {1};
	CHECK(ticalcs_screen_84pcse_rle_uncompress(short_input, sizeof(short_input), decoded,
		sizeof(decoded)) == ERR_INVALID_SCREENSHOT);
	const uint8_t valid_input[] = {1, 0x10, 0x34, 0x12, 1};
	CHECK(ticalcs_screen_84pcse_rle_uncompress(valid_input, sizeof(valid_input), decoded,
		sizeof(decoded)) == 0);
	CHECK(decoded[0] == 0x34 && decoded[1] == 0x12);
}

int main()
{
	CHECK(ticalcs_library_init() == 1);
	check_dbus_capacity_and_drain();
	check_68k_name_bounds();
	check_rom_size_bounds();
	// romdump_8x: seven embedded binaries, including their shared aliases.
	for (CalcModel model : {CALC_TI73, CALC_TI82, CALC_TI83, CALC_TI83P,
		CALC_TI84P, CALC_TI84PC, CALC_TI85, CALC_TI86})
	{
		check_rom_dump(model, false, 1024);
	}
	// romdump_84p_usb: three embedded binaries; Plus T shares the Plus one.
	for (CalcModel model : {CALC_TI84P_USB, CALC_TI84PT_USB, CALC_TI84PC_USB, CALC_TI82A_USB})
	{
		check_rom_dump(model, false, 1024);
	}
	// romdump_9x: DBUS, Fargo and DirectUSB binaries use zero-extended values.
	for (CalcModel model : {CALC_TI89, CALC_TI89T, CALC_TI92, CALC_TI92P, CALC_V200, CALC_TI89T_USB})
	{
		check_rom_dump(model, false, 4096, 0);
	}
	// romdump_834pce_usb: one binary, variable blocks up to 65535 bytes.
	for (CalcModel model : {CALC_TI83PCE_USB, CALC_TI84PCE_USB, CALC_TI82AEP_USB})
	{
		check_rom_dump(model, true, 65535);
	}
	check_nsp_fragment_bounds();
	check_dusb_parameter_bounds();
	check_dusb_virtual_packet_bounds();
	check_color_screenshot_bounds();
	CHECK(ticalcs_library_exit() == 0);
	puts("Receive-boundary tests passed");
	return 0;
}
