#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <string>
#include <vector>

#include "../src/ticalcs.h"
#include "../src/dbus_pkt.h"
#include "../src/cmdz80.h"
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
static int receive_failure, send_failure;
static unsigned int zero_length_writes;

static int cable_recv(CableHandle *, uint8_t *data, uint32_t length)
{
	CHECK(received <= incoming.size());
	if (received == incoming.size() && receive_failure) return receive_failure;
	CHECK(length <= incoming.size() - received);
	if (length) memcpy(data, incoming.data() + received, length);
	received += length;
	return 0;
}

static int cable_send(CableHandle *, uint8_t *data, uint32_t length)
{
	if (!length) zero_length_writes++;
	outgoing.insert(outgoing.end(), data, data + length);
	return send_failure;
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
		receive_failure = 0;
		send_failure = 0;
		zero_length_writes = 0;
		functions.recv = cable_recv;
		functions.send = cable_send;
		cable.cable = &functions;
		cable.open = 1;
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

// Independent packet framing expectations from the TI link guide.
static void append_wire_packet(std::vector<uint8_t> &wire, uint8_t mid, uint8_t command,
                               const std::vector<uint8_t> &payload = {})
{
	wire.insert(wire.end(), {mid, command, (uint8_t)payload.size(), (uint8_t)(payload.size() >> 8)});
	if (!payload.empty())
	{
		wire.insert(wire.end(), payload.begin(), payload.end());
		unsigned int sum = 0;
		for (uint8_t byte : payload) sum += byte;
		wire.insert(wire.end(), {(uint8_t)sum, (uint8_t)(sum >> 8)});
	}
}

// Independent packet expectations from the TI link guide: a three-part
// backup ends with the calculator's final DATA ACK, with no further PC ACK.
static void check_send_backup(BackupContent *content, bool final_ack_timeout = false)
{
	const CalcModel model = content->model;
	const bool classic = model == CALC_TI82 || model == CALC_TI83 || model == CALC_TI85 || model == CALC_TI86;
	const uint8_t mid = model == CALC_TI83 ? 0x83 : model == CALC_TI82 ? 0x82
	    : model == CALC_TI85 ? 0x85 : model == CALC_TI86 ? 0x86 : model == CALC_TI73 ? 0x74 : 0x73;
	const uint8_t host = model == CALC_TI83 ? 0x03 : model == CALC_TI82 ? 0x02
	    : model == CALC_TI85 ? 0x05 : model == CALC_TI86 ? 0x06 : model == CALC_TI73 ? 0x07 : 0x23;
	MockCalculator calc(model);
	const uint16_t address = model == CALC_TI86 ? content->data_length4 : content->mem_address;
	const uint8_t type = model == CALC_TI86 ? TI85_BKUP : content->type;
	const std::vector<uint8_t> header = {
	    (uint8_t)content->data_length1, (uint8_t)(content->data_length1 >> 8), type,
	    (uint8_t)content->data_length2, (uint8_t)(content->data_length2 >> 8),
	    (uint8_t)content->data_length3, (uint8_t)(content->data_length3 >> 8),
	    (uint8_t)address, (uint8_t)(address >> 8)};
	incoming = {mid, 0x56, (uint8_t)(classic ? 9 : 0), 0, mid, 0x09, 0, 0};
	std::vector<uint8_t> expected;
	append_wire_packet(expected, host, !classic || model == CALC_TI83 ? 0xc9 : 0x06, header);
	append_wire_packet(expected, host, 0x56);
	const uint16_t lengths[] = {content->data_length1, content->data_length2, content->data_length3, content->data_length4};
	uint8_t *const parts[] = {content->data_part1, content->data_part2, content->data_part3, content->data_part4};
	for (unsigned int i = 0; i < (model == CALC_TI86 ? 4U : 3U); i++)
	{
		if (!lengths[i]) continue;
		append_wire_packet(expected, host, 0x15, std::vector<uint8_t>(parts[i], parts[i] + lengths[i]));
		if (final_ack_timeout && i == (model == CALC_TI86 ? 3U : 2U))
			receive_failure = ERROR_READ_TIMEOUT;
		else
			incoming.insert(incoming.end(), {mid, 0x56, (uint8_t)(classic ? lengths[i] : 0),
			    (uint8_t)(classic ? lengths[i] >> 8 : 0)});
	}
	if (model == CALC_TI85 && !final_ack_timeout) append_wire_packet(expected, host, 0x92);
	CHECK(ticalcs_calc_send_backup(calc.handle, content) == (final_ack_timeout ? ERROR_READ_TIMEOUT : 0));
	CHECK(received == incoming.size());
	CHECK(outgoing == expected);
	CHECK(zero_length_writes == 0);
	CHECK(calc.handle->busy == 0);
	// The next transfer must start with no stale protocol bytes, including
	// after a missing final ACK (which must still be reported as an error).
	receive_failure = 0;
	packet(mid, 0x56);
	if (model == CALC_TI83)
	{
		const std::vector<uint8_t> data(768, 0x5a);
		packet(mid, 0x15, data);
		CalcScreenCoord screen = {};
		screen.format = SCREEN_FULL;
		uint8_t *bitmap = nullptr;
		CHECK(ticalcs_calc_recv_screen(calc.handle, &screen, &bitmap) == 0);
		CHECK(bitmap && memcmp(bitmap, data.data(), data.size()) == 0);
		ticalcs_free_screen(bitmap);
		append_wire_packet(expected, host, 0x6d);
		append_wire_packet(expected, host, 0x56);
	}
	else CHECK(tiz80_recv_ACK(calc.handle, nullptr) == 0);
	CHECK(received == incoming.size() && outgoing == expected);
}

static void check_send_backup_models()
{
	for (CalcModel model : {CALC_TI82, CALC_TI83, CALC_TI85, CALC_TI86,
	    CALC_TI73, CALC_TI83P, CALC_TI84P, CALC_TI84PC})
	{
		BackupContent *content = tifiles_content_create_backup(model);
		content->type = model == CALC_TI86 ? TI86_BKUP : model == CALC_TI85 ? TI85_BKUP
		    : model == CALC_TI82 ? TI82_BKUP : TI83_BKUP;
		// The physical TI-83 capture has a 250-byte last block, whose framed
		// packet occupies exactly two 128-byte cable writes.
		content->data_length1 = 3520;
		content->data_length2 = 152;
		content->data_length3 = 250;
		content->mem_address = 0x9327;
		content->data_part1 = (uint8_t *)g_malloc0(content->data_length1);
		content->data_part2 = (uint8_t *)g_malloc0(content->data_length2);
		content->data_part3 = (uint8_t *)g_malloc0(content->data_length3);
		if (model == CALC_TI86)
		{
			content->data_length4 = 17;
			content->data_part4 = (uint8_t *)g_malloc0(content->data_length4);
		}
		check_send_backup(content);
		check_send_backup(content, true);
		if (model == CALC_TI86)
		{
			// ROM 1.2 through 1.6 also accept backups without section 3;
			// section 4 still supplies the final DATA/ACK, with no PC ACK.
			content->data_length3 = 0;
			g_free(content->data_part3);
			content->data_part3 = nullptr;
			check_send_backup(content);
			check_send_backup(content, true);
		}
		tifiles_content_delete_backup(content);
	}
}

static void check_send_chunk_boundaries()
{
	for (unsigned int length : {1U, 121U, 122U, 123U, 249U, 250U, 251U, 2554U, 4094U, 65514U, 65536U})
	{
		MockCalculator calc(CALC_TI89);
		std::vector<uint8_t> data(length), expected;
		for (unsigned int i = 0; i < length; i++) data[i] = (uint8_t)(i * 37 + 0x5b);
		append_wire_packet(expected, 0x08, 0x15, data);
		CHECK(dbus_send(calc.handle, 0x08, 0x15, (uint16_t)length, data.data()) == 0);
		CHECK(outgoing == expected);
		CHECK(zero_length_writes == 0);
		CHECK(calc.handle->updat->cnt1 == (int)length + 6);
	}
}

static void check_ack_header_word()
{
	struct AckModel { CalcModel model; uint8_t mid; bool echoes_length; };
	const AckModel models[] = {
		{CALC_TI82, 0x82, true},
		{CALC_TI83, 0x83, true},
		{CALC_TI85, 0x85, true},
		{CALC_TI86, 0x86, true},
		{CALC_TI73, 0x74, false},
		{CALC_TI83P, 0x73, false},
		{CALC_TI84P, 0x73, false},
		{CALC_TI84PC, 0x73, false},
	};
	for (const AckModel &model : models)
	{
		// Include captured/documented echoed lengths and Flash rejection status 5.
		for (uint16_t word : {0, 5, 9, 11, 12, 768})
		{
			for (bool read_status : {false, true})
			{
				MockCalculator calc(model.model);
				incoming = {model.mid, DBUS_CMD_ACK, (uint8_t)word, (uint8_t)(word >> 8)};
				uint16_t status = 0xffff;
				const int expected = read_status || model.echoes_length || word == 0 ? 0 : ERR_NACK;
				CHECK(tiz80_recv_ACK(calc.handle, read_status ? &status : nullptr) == expected);
				if (read_status) CHECK(status == word);
				CHECK(received == 4 && outgoing.empty());
			}
		}
		MockCalculator calc(model.model);
		incoming = {model.mid, DBUS_CMD_CTS, 0, 0};
		CHECK(tiz80_recv_ACK(calc.handle, nullptr) == ERR_INVALID_CMD);
	}
}

struct ChecksumModel
{
	CalcModel model;
	uint8_t calculator_mid, pc_mid;
	bool acknowledge_chk, notify_chk;
};

// Literal wire expectations keep the ROM-supported scope independent of
// the library's model-to-MID and checksum-recovery helpers.
static const ChecksumModel checksum_models[] = {
	{CALC_TI73,  0x74, 0x07, true,  true},
	{CALC_TI82,  0x82, 0x02, true,  true},
	{CALC_TI83,  0x83, 0x03, true,  true},
	{CALC_TI83P, 0x73, 0x23, true,  true},
	{CALC_TI84P, 0x73, 0x23, true,  true},
	{CALC_TI85,  0x85, 0x05, true,  true},
	{CALC_TI86,  0x86, 0x06, true,  true},
	{CALC_TI89,  0x98, 0x08, false, true},
	{CALC_TI89T, 0x98, 0x08, false, true},
	{CALC_TI80,  0x80, 0x00, false, false},
	{CALC_TI84PC,0x73, 0x23, false, false},
	{CALC_TI92,  0x89, 0x09, false, false},
	{CALC_TI92P, 0x88, 0x08, false, false},
	{CALC_V200,  0x88, 0x08, false, false},
	{CALC_TI84P_USB, 0x73, 0x23, false, false},
	{CALC_TI89T_USB, 0x98, 0x08, false, false},
};

static void check_received_checksum_error(const ChecksumModel &model, uint8_t command,
                                          int busy = 0, int failed_send = 0)
{
	MockCalculator calc(model.model);
	calc.handle->busy = busy;
	send_failure = failed_send;
	// The CHK header word can be nonzero without carrying any data.
	incoming = {model.calculator_mid, command};
	if (model.model != CALC_TI80) incoming.insert(incoming.end(), {0x0b, 0x00});
	const size_t error_end = incoming.size();
	incoming.insert(incoming.end(), {model.calculator_mid, 0x56});
	if (model.model != CALC_TI80) incoming.insert(incoming.end(), {0x00, 0x00});
	uint8_t data[16];
	memset(data, 0xa5, sizeof(data));
	uint8_t host = 0, cmd = 0;
	uint16_t length = 0;
	CHECK(dbus_recv(calc.handle, &host, &cmd, &length, data) == ERR_CHECKSUM);
	CHECK(host == model.calculator_mid && cmd == command);
	CHECK(length == (model.model == CALC_TI80 ? 0 : 11));
	CHECK(received == error_end); // No payload read, retransmission, or read-ahead.
	CHECK(calc.handle->busy == busy);
	for (uint8_t value : data) CHECK(value == 0xa5);
	const std::vector<uint8_t> expected = model.acknowledge_chk && command == 0x5a
		? std::vector<uint8_t>{model.pc_mid, 0x56, 0x00, 0x00} : std::vector<uint8_t>{};
	CHECK(outgoing == expected);
	send_failure = 0;
	CHECK(dbus_recv(calc.handle, &host, &cmd, &length, data) == 0);
	CHECK(host == model.calculator_mid && cmd == 0x56 && length == 0);
	CHECK(received == incoming.size() && outgoing == expected);
	CHECK(calc.handle->busy == busy);
}

static void check_bad_checksum_data(const ChecksumModel &model, uint8_t command,
                                    int busy = 0, int failed_send = 0)
{
	MockCalculator calc(model.model);
	calc.handle->busy = busy;
	send_failure = failed_send;
	const std::vector<uint8_t> bad = {0xa1, 0xb2, 0xc3, 0xd4, 0xe5};
	const std::vector<uint8_t> good = {0x21, 0x43, 0x65};
	packet(model.calculator_mid, command, bad);
	incoming.back() ^= 1;
	const size_t error_end = incoming.size();
	packet(model.calculator_mid, 0x15, good);
	uint8_t *data = (uint8_t *)calc.handle->buffer;
	memset(data, 0xa5, 16);
	uint8_t host = 0, cmd = 0;
	uint16_t length = 0;
	CHECK(dbus_recv(calc.handle, &host, &cmd, &length, data) == ERR_CHECKSUM);
	CHECK(host == model.calculator_mid && cmd == command && length == bad.size());
	CHECK(received == error_end);
	CHECK(calc.handle->busy == busy);
	// Sending the error notification must not clobber an aliased receive buffer.
	CHECK(memcmp(data, bad.data(), bad.size()) == 0);
	for (size_t i = bad.size(); i < 16; i++) CHECK(data[i] == 0xa5);
	const std::vector<uint8_t> expected = model.notify_chk && (command == 0x06 || command == 0x15)
		? std::vector<uint8_t>{model.pc_mid, 0x5a, 0x00, 0x00} : std::vector<uint8_t>{};
	CHECK(outgoing == expected);
	send_failure = 0;
	CHECK(dbus_recv(calc.handle, &host, &cmd, &length, data) == 0);
	CHECK(host == model.calculator_mid && cmd == 0x15 && length == good.size());
	CHECK(memcmp(data, good.data(), good.size()) == 0);
	CHECK(received == incoming.size() && outgoing == expected); // Good data produces no CHK.
	CHECK(calc.handle->busy == busy);
}

static void check_checksum_transport_errors()
{
	for (int busy : {0, 1})
	{
		for (bool missing_data : {false, true})
		{
			MockCalculator calc(CALC_TI86);
			calc.handle->busy = busy;
			if (missing_data) incoming = {0x86, 0x15, 0x03, 0x00, 0x21, 0x43, 0x65};
			receive_failure = ERROR_READ_TIMEOUT;
			uint8_t host = 0, cmd = 0, data[16] = {};
			uint16_t length = 0;
			CHECK(dbus_recv(calc.handle, &host, &cmd, &length, data) == ERROR_READ_TIMEOUT);
			CHECK(received == incoming.size() && outgoing.empty());
			CHECK(calc.handle->busy == busy);
		}
		MockCalculator calc(CALC_TI86);
		calc.handle->busy = busy;
		calc.handle->updat->cancel = 1;
		packet(0x86, 0x15, {0x21, 0x43, 0x65});
		uint8_t host = 0, cmd = 0, data[16] = {};
		uint16_t length = 0;
		CHECK(dbus_recv(calc.handle, &host, &cmd, &length, data) == ERR_ABORT);
		CHECK(received == 5 && outgoing.empty());
		CHECK(calc.handle->busy == busy);
	}
}

static void check_checksum_recovery()
{
	for (const ChecksumModel &model : checksum_models)
	{
		check_received_checksum_error(model, 0x5a);
		check_received_checksum_error(model, 0xb4); // Legacy ERR2 retains its existing behavior.
		check_bad_checksum_data(model, 0x15);
		if (model.model != CALC_TI80) check_bad_checksum_data(model, 0x06);
	}
	// Nested ownership and failed recovery sends must preserve the original error.
	const ChecksumModel ti86 = {CALC_TI86, 0x86, 0x06, true, true};
	const ChecksumModel ti89 = {CALC_TI89, 0x98, 0x08, false, true};
	check_received_checksum_error(ti86, 0x5a, 1, ERROR_WRITE_TIMEOUT);
	check_bad_checksum_data(ti86, 0x15, 1, ERROR_WRITE_TIMEOUT);
	check_bad_checksum_data(ti89, 0x06, 1, ERROR_WRITE_TIMEOUT);
	// Other data commands have no ROM-verified abort notification policy.
	for (uint8_t command : {0x36, 0x47, 0xa2, 0xb7, 0xc9})
	{
		check_bad_checksum_data(ti86, command);
		check_bad_checksum_data(ti89, command);
	}
	check_checksum_transport_errors();
}

static void check_bad_screenshot(CalcModel model, uint8_t calculator_mid, uint8_t pc_mid,
                                 size_t screen_size)
{
	MockCalculator calc(model);
	const std::vector<uint8_t> data(screen_size, 0x5a);
	packet(calculator_mid, 0x56);
	packet(calculator_mid, 0x15, data);
	incoming.back() ^= 1;
	const size_t error_end = incoming.size();
	packet(calculator_mid, 0x56);
	packet(calculator_mid, 0x15, data);
	CalcScreenCoord screen = {};
	screen.format = SCREEN_FULL;
	uint8_t *bitmap = nullptr;
	CHECK(ticalcs_calc_recv_screen(calc.handle, &screen, &bitmap) == ERR_CHECKSUM);
	CHECK(bitmap == nullptr && calc.handle->busy == 0);
	CHECK(received == error_end);
	std::vector<uint8_t> expected = {pc_mid, 0x6d, 0x00, 0x00, pc_mid, 0x5a, 0x00, 0x00};
	CHECK(outgoing == expected); // No successful-data ACK after the CHK abort.
	CHECK(ticalcs_calc_recv_screen(calc.handle, &screen, &bitmap) == 0);
	CHECK(bitmap != nullptr && calc.handle->busy == 0);
	CHECK(memcmp(bitmap, data.data(), screen_size) == 0);
	expected.insert(expected.end(), {pc_mid, 0x6d, 0x00, 0x00, pc_mid, 0x56, 0x00, 0x00});
	CHECK(received == incoming.size() && outgoing == expected);
	ticalcs_free_screen(bitmap);
}

static void check_color_screenshot_error()
{
	MockCalculator calc(CALC_TI84PC);
	packet(0x73, 0x56);
	packet(0x73, 0x15, {0x21, 0x43}); // Initial color screenshot chunk.
	packet(0x73, 0x15, {0x65, 0x87, 0xa9});
	incoming.back() ^= 1;
	const size_t error_end = incoming.size();
	packet(0x73, 0x92);
	CalcScreenCoord screen = {};
	uint8_t *bitmap = nullptr;
	CHECK(ticalcs_calc_recv_screen(calc.handle, &screen, &bitmap) == ERR_CHECKSUM);
	CHECK(bitmap == nullptr && calc.handle->busy == 0);
	CHECK(received == error_end);
	CHECK(outgoing == (std::vector<uint8_t>{0x23, 0x6d, 0x00, 0x00, 0x23, 0x56, 0x00, 0x00}));
}

static void check_expected_asm_completion(CalcModel model, uint8_t calculator_mid, uint8_t pc_mid)
{
	for (int busy : {0, 1})
	{
		MockCalculator calc(model);
		calc.handle->busy = busy;
		incoming = {calculator_mid, 0x5a, 0x0b, 0x00};
		uint16_t status = 0;
		CHECK(ti82_recv_ERR(calc.handle, &status) == 0);
		CHECK(status == 11 && received == incoming.size());
		CHECK(outgoing.empty() && calc.handle->busy == busy);
		CHECK(tiz80_send_ACK(calc.handle, pc_mid) == 0);
		CHECK(outgoing == (std::vector<uint8_t>{pc_mid, 0x56, 0x00, 0x00}));
		CHECK(calc.handle->busy == busy);
	}
	// Exercise the public caller that uploads the bootstrap and owns its ACK.
	MockCalculator calc(model);
	packet(calculator_mid, 0x56);
	packet(calculator_mid, 0x09);
	packet(calculator_mid, 0x56);
	incoming.insert(incoming.end(), {calculator_mid, 0x5a, 0x0b, 0x00});
	FileContent *content = tifiles_content_create_regular(model);
	CHECK(content);
	VarEntry *entry = tifiles_ve_create_alloc_data(4);
	CHECK(entry);
	entry->size = 4;
	strcpy(entry->name, "TEST");
	entry->type = model == CALC_TI82 ? TI82_PRGM : TI85_PRGM;
	memset(entry->data, 0, 4);
	CHECK(tifiles_content_add_entry(content, entry) == 1);
	CHECK(ticalcs_calc_send_var(calc.handle, MODE_SEND_EXEC_ASM, content) == 0);
	CHECK(received == incoming.size() && calc.handle->busy == 0);
	std::vector<uint8_t> commands;
	for (size_t offset = 0; offset < outgoing.size();)
	{
		CHECK(outgoing.size() - offset >= 4 && outgoing[offset] == pc_mid);
		const uint8_t command = outgoing[offset + 1];
		commands.push_back(command);
		const uint16_t length = outgoing[offset + 2] | ((uint16_t)outgoing[offset + 3] << 8);
		offset += command == 0x56 ? 4 : 6 + length;
		CHECK(offset <= outgoing.size());
	}
	CHECK(commands == (std::vector<uint8_t>{0x06, 0x56, 0x15, 0x06, 0x56}));
	CHECK(std::vector<uint8_t>(outgoing.end() - 4, outgoing.end()) ==
	      (std::vector<uint8_t>{pc_mid, 0x56, 0x00, 0x00}));
	tifiles_content_delete_regular(content);
}

static void check_invalid_command_cleanup()
{
	for (int busy : {0, 1})
	{
		MockCalculator calc(CALC_TI86);
		calc.handle->busy = busy;
		incoming = {0x86, 0xff, 0x00, 0x00, 0x86, 0x56, 0x00, 0x00};
		uint8_t host = 0, cmd = 0, data[16] = {};
		uint16_t length = 0;
		CHECK(dbus_recv(calc.handle, &host, &cmd, &length, data) == ERR_INVALID_CMD);
		CHECK(received == 4 && outgoing.empty() && calc.handle->busy == busy);
		CHECK(dbus_recv(calc.handle, &host, &cmd, &length, data) == 0);
		CHECK(received == incoming.size() && outgoing.empty() && calc.handle->busy == busy);
	}
}

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

int main(int argc, char **argv)
{
	CHECK(ticalcs_library_init() == 1);
	check_commands();
	check_send_backup_models();
	check_send_chunk_boundaries();
	// Optional real backup fixtures exercise the production file parser too.
	for (int i = 1; i < argc; i++)
	{
		BackupContent *content = tifiles_content_create_backup(CALC_NONE);
		CHECK(tifiles_file_read_backup(argv[i], content) == 0);
		CHECK(content->checksum == content->stored_checksum);
		check_send_backup(content);
		check_send_backup(content, true);
		tifiles_content_delete_backup(content);
	}
	check_ack_header_word();
	check_checksum_recovery();
	check_bad_screenshot(CALC_TI86, 0x86, 0x06, 1024);
	check_bad_screenshot(CALC_TI83P, 0x73, 0x23, 768);
	check_bad_screenshot(CALC_TI89, 0x98, 0x08, 3840);
	check_color_screenshot_error();
	check_expected_asm_completion(CALC_TI82, 0x82, 0x02);
	check_expected_asm_completion(CALC_TI85, 0x85, 0x05);
	check_invalid_command_cleanup();
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
	puts("DBUS command, framing, checksum recovery, screenshot and RDI tests passed");
	return 0;
}
