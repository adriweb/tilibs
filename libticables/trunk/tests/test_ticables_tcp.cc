#include <cstdio>
#include <cstring>
#include <thread>
#include <cerrno>
#include <cstdarg>

#ifdef __WIN32__
#include <winsock2.h>
#include <ws2tcpip.h>
typedef SOCKET test_socket_t;
#define TEST_INVALID_SOCKET INVALID_SOCKET
#define test_close_socket(s) closesocket(s)
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
typedef int test_socket_t;
#define TEST_INVALID_SOCKET (-1)
#define test_close_socket(s) close(s)
#endif

#include <ticables.h>
#include "../src/error.h"

static FILE* g_log_file = nullptr;
static int g_verbose = 0;

static void test_log(const char* fmt, ...) {
	if (!g_verbose)
	{
		return;
	}

	va_list ap;
	va_start(ap, fmt);
	std::vfprintf(stdout, fmt, ap);
	std::fprintf(stdout, "\n");
	std::fflush(stdout);
	va_end(ap);

	if (g_log_file != nullptr)
	{
		va_start(ap, fmt);
		std::vfprintf(g_log_file, fmt, ap);
		std::fprintf(g_log_file, "\n");
		std::fflush(g_log_file);
		va_end(ap);
	}
}

static int get_free_tcp_port() {
	test_socket_t sock = TEST_INVALID_SOCKET;
	struct sockaddr_in addr;
	socklen_t addr_len = (socklen_t)sizeof(addr);
	int port = -1;

	sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
	if (sock == TEST_INVALID_SOCKET)
	{
		return -1;
	}

	memset(&addr, 0, sizeof(addr));
	addr.sin_family = AF_INET;
	addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
	addr.sin_port = 0;

	if (bind(sock, (struct sockaddr*)&addr, sizeof(addr)) != 0)
	{
		test_close_socket(sock);
		return -1;
	}

	if (getsockname(sock, (struct sockaddr*)&addr, &addr_len) != 0)
	{
		test_close_socket(sock);
		return -1;
	}

	port = (int)ntohs(addr.sin_port);
	test_close_socket(sock);
	return port;
}

int main() {
#if defined(NO_CABLE_TCPC) || defined(NO_CABLE_TCPS)
	std::fprintf(stderr, "TCP cable support disabled at build time, skipping.\n");
	return 0;
#else
	const char* log_path = "/tmp/test_ticables_tcp.log";
	enum TestStage
	{
		STAGE_INIT = 0,
		STAGE_OPEN_LOOPBACK,
		STAGE_IO_LOOPBACK,
		STAGE_TIMEOUT_CHECK,
		STAGE_DONE
	};

	int ret = 0;
	int port = get_free_tcp_port();
	bool ok = false;
	bool library_inited = false;
	bool server_thread_started = false;
	TestStage stage = STAGE_INIT;
	CableHandle* server = nullptr;
	CableHandle* client = nullptr;
	uint8_t server_rx[4] = {0};
	uint8_t client_rx[3] = {0};
	uint8_t client_tx[4] = {0x10, 0x20, 0x30, 0x40};
	uint8_t server_tx[3] = {0xAA, 0xBB, 0xCC};
	int server_open_ret = 0;
	int server_io_ret = 0;
	std::thread server_thread;

	g_verbose = (std::getenv("TICABLES_TCP_TEST_VERBOSE") != nullptr) ? 1 : 0;
	std::setvbuf(stdout, nullptr, _IONBF, 0);
	std::setvbuf(stderr, nullptr, _IONBF, 0);
	std::remove(log_path);
	if (g_verbose)
	{
		g_log_file = std::fopen(log_path, "w");
	}
	test_log("test_ticables_tcp: start");

	if (port <= 0)
	{
		test_log("failed to allocate free tcp port (errno=%d)", errno);
		ret = -1;
		goto done;
	}
	test_log("allocated free port=%d", port);

	ticables_library_init();
	library_inited = true;
	test_log("ticables_library_init done");

	server = ticables_handle_new(CABLE_TCPS, PORT_1);
	client = ticables_handle_new(CABLE_TCPC, PORT_1);
	if (server == nullptr || client == nullptr)
	{
		test_log("failed to create cable handles server=%p client=%p", (void*)server, (void*)client);
		goto done;
	}
	test_log("handles created server=%p client=%p", (void*)server, (void*)client);
	ticables_options_set_timeout(server, 100);
	ticables_options_set_timeout(client, 100);
	test_log("timeouts set to 100 (10s)");

	CableOptions server_opts;
	memset(&server_opts, 0, sizeof(server_opts));
	server_opts.model = CABLE_TCPS;
	server_opts.version = 1;
	server_opts.has_parameters = 1;
	server_opts.parameters.tcps.bind_address = "127.0.0.1";
	server_opts.parameters.tcps.server_address = "127.0.0.0/8";
	server_opts.parameters.tcps.port = (uint16_t)port;

	ret = ticables_cable_set_options(server, &server_opts);
	if (ret)
	{
		test_log("set server options failed: %d", ret);
		goto done;
	}
	test_log("set server options ok bind=%s cidr=%s port=%u",
			 server_opts.parameters.tcps.bind_address,
			 server_opts.parameters.tcps.server_address,
			 (unsigned)server_opts.parameters.tcps.port);

	char connect_addr1[32];
	char connect_addr2[32];
	std::strcpy(connect_addr1, "127.0.0.1");
	std::strcpy(connect_addr2, "127.0.0.1");

	CableOptions client_opts;
	memset(&client_opts, 0, sizeof(client_opts));
	client_opts.model = CABLE_TCPC;
	client_opts.version = 1;
	client_opts.has_parameters = 1;
	client_opts.parameters.tcpc.connect_address = connect_addr1;
	client_opts.parameters.tcpc.port = (uint16_t)port;

	ret = ticables_cable_set_options(client, &client_opts);
	if (ret)
	{
		test_log("set client options #1 failed: %d", ret);
		goto done;
	}
	test_log("set client options #1 ok addr=%s port=%u",
			 client_opts.parameters.tcpc.connect_address, (unsigned)client_opts.parameters.tcpc.port);
	std::strcpy(connect_addr1, "127.0.0.2");

	client_opts.parameters.tcpc.connect_address = connect_addr2;
	ret = ticables_cable_set_options(client, &client_opts);
	if (ret)
	{
		test_log("set client options #2 failed: %d", ret);
		goto done;
	}
	test_log("set client options #2 ok addr=%s port=%u",
			 client_opts.parameters.tcpc.connect_address, (unsigned)client_opts.parameters.tcpc.port);
	std::strcpy(connect_addr2, "127.0.0.3");

	server_thread = std::thread([&]() {
		test_log("server thread: opening server handle");
		server_open_ret = ticables_cable_open(server);
		test_log("server thread: ticables_cable_open ret=%d", server_open_ret);
		if (!server_open_ret)
		{
			test_log("server thread: waiting recv 4 bytes");
			server_io_ret = ticables_cable_recv(server, server_rx, sizeof(server_rx));
			test_log("server thread: recv ret=%d data=%02x %02x %02x %02x",
					 server_io_ret, server_rx[0], server_rx[1], server_rx[2], server_rx[3]);
		}
		if (!server_open_ret && !server_io_ret)
		{
			test_log("server thread: sending 3 bytes");
			server_io_ret = ticables_cable_send(server, server_tx, sizeof(server_tx));
			test_log("server thread: send ret=%d", server_io_ret);
		}
		test_log("server thread: done open=%d io=%d", server_open_ret, server_io_ret);
	});
	server_thread_started = true;
	stage = STAGE_OPEN_LOOPBACK;
	test_log("main: opening client handle");

	ret = ticables_cable_open(client);
	if (ret)
	{
		test_log("client open failed: %d", ret);
		goto done;
	}
	test_log("client open ok");

	ret = ticables_cable_send(client, client_tx, sizeof(client_tx));
	if (ret)
	{
		test_log("client send failed: %d", ret);
		goto done;
	}
	test_log("client send ok 4 bytes");

	ret = ticables_cable_recv(client, client_rx, sizeof(client_rx));
	if (ret)
	{
		test_log("client recv failed: %d (server open=%d io=%d)", ret, server_open_ret, server_io_ret);
		goto done;
	}
	test_log("client recv ok 3 bytes data=%02x %02x %02x", client_rx[0], client_rx[1], client_rx[2]);
	if (server_thread_started && server_thread.joinable())
	{
		test_log("joining server thread after recv");
		server_thread.join();
		server_thread_started = false;
	}

	if (server_open_ret || server_io_ret)
	{
		test_log("server side failed: open=%d io=%d", server_open_ret, server_io_ret);
		goto done;
	}
	stage = STAGE_IO_LOOPBACK;
	if (std::memcmp(server_rx, client_tx, sizeof(client_tx)) != 0)
	{
		test_log("server recv mismatch");
		goto done;
	}
	if (std::memcmp(client_rx, server_tx, sizeof(server_tx)) != 0)
	{
		test_log("client recv mismatch");
		goto done;
	}
	test_log("loopback data checks ok");

	ticables_cable_close(client);
	ticables_cable_close(server);
	test_log("closed main handles after loopback");

	{
		CableHandle* bad_client = ticables_handle_new(CABLE_TCPC, PORT_1);
		if (bad_client == nullptr)
		{
			test_log("failed to create timeout test handle");
			goto done;
		}
		test_log("timeout-check handle created");

		CableOptions bad_opts;
		uint16_t bad_port = (uint16_t)((port == 65535) ? 65534 : (port + 1));
		memset(&bad_opts, 0, sizeof(bad_opts));
		bad_opts.model = CABLE_TCPC;
		bad_opts.timeout = 5;
		bad_opts.version = 1;
		bad_opts.has_parameters = 1;
		bad_opts.parameters.tcpc.connect_address = "127.0.0.1";
		bad_opts.parameters.tcpc.port = bad_port;

		ret = ticables_cable_set_options(bad_client, &bad_opts);
		if (ret)
		{
			test_log("set timeout test options failed: %d", ret);
			ticables_handle_del(bad_client);
			goto done;
		}
		test_log("timeout-check options set addr=%s port=%u timeout=%u",
				 bad_opts.parameters.tcpc.connect_address, (unsigned)bad_opts.parameters.tcpc.port, bad_opts.timeout);

		ret = ticables_cable_open(bad_client);
		if (ret != ERR_TCPC_CONNECT)
		{
			test_log("expected ERR_TCPC_CONNECT (%d), got %d", ERR_TCPC_CONNECT, ret);
			ticables_handle_del(bad_client);
			goto done;
		}
		test_log("timeout-check returned expected ret=%d", ret);

		ticables_handle_del(bad_client);
	}

	stage = STAGE_TIMEOUT_CHECK;
	ok = true;
	stage = STAGE_DONE;
done:
	if (server_thread_started && server_thread.joinable())
	{
		test_log("joining server thread in cleanup");
		server_thread.join();
	}
	if (client != nullptr)
	{
		ticables_cable_close(client);
		ticables_handle_del(client);
	}
	if (server != nullptr)
	{
		ticables_cable_close(server);
		ticables_handle_del(server);
	}
	if (library_inited)
	{
		ticables_library_exit();
	}
	if (!ok)
	{
		std::fprintf(stdout, "test_ticables_tcp failed: stage=%d ret=%d server_open_ret=%d server_io_ret=%d port=%d\n",
					 (int)stage, ret, server_open_ret, server_io_ret, port);
		std::fflush(stdout);
		if (g_log_file != nullptr)
		{
			std::fprintf(g_log_file, "test_ticables_tcp failed: stage=%d ret=%d server_open_ret=%d server_io_ret=%d port=%d\n",
						 (int)stage, ret, server_open_ret, server_io_ret, port);
			std::fflush(g_log_file);
		}
	}
	if (g_log_file != nullptr)
	{
		std::fclose(g_log_file);
		g_log_file = nullptr;
	}
	return ok ? 0 : 1;
#endif
}
