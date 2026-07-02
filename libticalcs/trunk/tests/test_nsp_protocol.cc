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

#define CHECK(condition) \
	do { \
		if (!(condition)) { \
			fprintf(stderr, "%s:%d: check failed: %s\n", __FILE__, __LINE__, #condition); \
			abort(); \
		} \
	} while (0)

static int recv_calls = 0;

static int recv_oversized_legacy_header(CableHandle *, uint8_t *data, uint32_t len)
{
	recv_calls++;
	if (recv_calls == 1)
	{
		CHECK(len == NSP_HEADER_SIZE);
		memset(data, 0, len);
		data[12] = 0xff;
		return 0;
	}
	return 1234;
}

static void check_oversized_legacy_packet_is_rejected_before_data_read(void)
{
	CableFncts cable_functions = {};
	cable_functions.recv = recv_oversized_legacy_header;

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
	CHECK(recv_calls == 1);
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

int main(void)
{
	check_oversized_legacy_packet_is_rejected_before_data_read();
	check_os_receive_size_limit();
	check_nnse_os_receive_accepts_short_split_chunks();
	check_os_status_result();
	check_reply_reverses_request_endpoints();
	return 0;
}
