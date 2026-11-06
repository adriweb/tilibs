#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <vector>

#include "../src/ticalcs.h"
#include "../src/error.h"
#include "../src/dusb_cmd.h"
#include "../src/dusb_vpkt.h"

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
	if (length) memcpy(data, incoming.data() + received, length);
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

	MockCalculator()
	{
		incoming.clear();
		received = 0;
		functions.recv = cable_recv;
		functions.send = cable_send;
		cable.cable = &functions;
		cable.open = 1;
		cable.timeout = 50;
		handle = ticalcs_handle_new(CALC_TI89T_USB);
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

static void queue_var_header(const std::vector<uint8_t> &payload)
{
	const unsigned int size = (unsigned int)payload.size() + 6;
	incoming.insert(incoming.end(), {0, 0, (uint8_t)(size >> 8), (uint8_t)size, 4,
	    0, 0, (uint8_t)(payload.size() >> 8), (uint8_t)payload.size(), 0, DUSB_VPKT_VAR_HDR});
	incoming.insert(incoming.end(), payload.begin(), payload.end());
}

static int receive_header(const std::vector<uint8_t> &payload, size_t folder_size,
	size_t name_size, unsigned int expected_attrs, bool check_valid = false)
{
	MockCalculator calc;
	queue_var_header(payload);

	std::vector<uint8_t> folder_storage(folder_size + 2, 0xa5);
	std::vector<uint8_t> name_storage(name_size + 2, 0x5a);
	char *folder = (char *)folder_storage.data() + 1;
	char *name = (char *)name_storage.data() + 1;
	DUSBCalcAttr **attrs = dusb_ca_new_array(calc.handle, expected_attrs);
	CHECK(attrs);

	const int result = dusb_cmd_r_var_header(calc.handle, folder, folder_size,
		name, name_size, expected_attrs, attrs);
	CHECK(folder_storage.front() == 0xa5 && folder_storage.back() == 0xa5);
	CHECK(name_storage.front() == 0x5a && name_storage.back() == 0x5a);
	CHECK(attrs[expected_attrs] == nullptr);
	CHECK(received == incoming.size());

	if (check_valid)
	{
		CHECK(result == 0);
		CHECK(strcmp(folder, "main") == 0);
		CHECK(strcmp(name, "X") == 0);
		CHECK(attrs[0] && attrs[0]->id == 0x1234 && attrs[0]->ok);
		CHECK(attrs[0]->size == 3 && !memcmp(attrs[0]->data, "\x01\x02\x03", 3));
		CHECK(attrs[1] && attrs[1]->id == 0x5678 && !attrs[1]->ok);
	}

	dusb_ca_del_array(calc.handle, attrs, expected_attrs);
	return result;
}

static void check_valid_headers()
{
	CHECK(receive_header({4, 'm', 'a', 'i', 'n', 0, 1, 'X', 0, 0, 2,
		0x12, 0x34, 0, 0, 3, 1, 2, 3,
		0x56, 0x78, 1}, 5, 2, 2, true) == 0);

	// Empty names have no trailing NUL on the wire; a successful zero-size
	// attribute still contains its two-byte size field.
	CHECK(receive_header({0, 0, 0, 1, 0, 1, 0, 0, 0}, 1, 1, 1) == 0);
}

static void check_malformed_headers()
{
	const std::vector<std::vector<uint8_t>> malformed = {
		{},
		{1},
		{1, 'A'},
		{1, 'A', 'B', 0, 0, 0},
		{0},
		{0, 1, 'X'},
		{0, 1, 'X', 'Y', 0, 0},
		{0, 0},
		{0, 0, 0},
	};
	for (const auto &payload : malformed)
	{
		CHECK(receive_header(payload, 8, 8, 0) == ERR_INVALID_PACKET);
	}

	// Declared strings fit the packet but not the caller's destination.
	CHECK(receive_header({3, 'a', 'b', 'c', 0, 0, 0, 0}, 3, 8, 0) == ERR_INVALID_PACKET);
	CHECK(receive_header({0, 3, 'a', 'b', 'c', 0, 0, 0}, 8, 3, 0) == ERR_INVALID_PACKET);

	// The response must contain exactly the requested number of attributes.
	CHECK(receive_header({0, 0, 0, 0}, 8, 8, 1) == ERR_INVALID_PACKET);
	CHECK(receive_header({0, 0, 0, 2}, 8, 8, 1) == ERR_INVALID_PACKET);
	// Complete records make the vulnerable parser reach both out-of-bounds
	// attribute-pointer writes for an eight-after-six response.
	CHECK(receive_header({0, 0, 0, 8,
		0, 1, 1, 0, 2, 1, 0, 3, 1, 0, 4, 1,
		0, 5, 1, 0, 6, 1, 0, 7, 1, 0, 8, 1}, 8, 8, 6) == ERR_INVALID_PACKET);

	// Attribute record, size, and data truncation boundaries.
	CHECK(receive_header({0, 0, 0, 1}, 8, 8, 1) == ERR_INVALID_PACKET);
	CHECK(receive_header({0, 0, 0, 1, 0, 1}, 8, 8, 1) == ERR_INVALID_PACKET);
	CHECK(receive_header({0, 0, 0, 1, 0, 1, 0}, 8, 8, 1) == ERR_INVALID_PACKET);
	CHECK(receive_header({0, 0, 0, 1, 0, 1, 0, 0}, 8, 8, 1) == ERR_INVALID_PACKET);
	CHECK(receive_header({0, 0, 0, 1, 0, 1, 0, 0, 3, 1, 2}, 8, 8, 1) == ERR_INVALID_PACKET);
}

static void check_zero_capacities()
{
	MockCalculator calc;
	char folder = 'F';
	char name = 'N';
	DUSBCalcAttr **attrs = dusb_ca_new_array(calc.handle, 0);
	CHECK(attrs);
	CHECK(dusb_cmd_r_var_header(calc.handle, &folder, 0, &name, 1, 0, attrs) == ERR_INVALID_PARAMETER);
	CHECK(dusb_cmd_r_var_header(calc.handle, &folder, 1, &name, 0, 0, attrs) == ERR_INVALID_PARAMETER);
	CHECK(folder == 'F' && name == 'N');
	dusb_ca_del_array(calc.handle, attrs, 0);
}

int main()
{
	CHECK(ticalcs_library_init() == 1);
	check_valid_headers();
	check_malformed_headers();
	check_zero_capacities();
	CHECK(ticalcs_library_exit() == 0);
	puts("DUSB variable-header bounds tests passed");
	return 0;
}
