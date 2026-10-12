#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <string>
#include <vector>
#include <glib.h>
#ifdef _WIN32
#include <io.h>
#else
#include <unistd.h>
#endif

// The test target compiles the production decoder, an internal cable symbol.
int dbus_decomp(const char *filename, int resync);

#define CHECK(condition) \
	do { \
		if (!(condition)) { \
			fprintf(stderr, "%s:%d: check failed: %s\n", __FILE__, __LINE__, #condition); \
			abort(); \
		} \
	} while (0)

static std::string hex_log(const std::vector<uint8_t> &bytes, bool final_newline = false)
{
	std::string text = "TiCables-2 data logger\nVersion 1.3.6\n\n";
	char hex[4];
	for (size_t i = 0; i < bytes.size(); i++)
	{
		snprintf(hex, sizeof(hex), "%02X ", bytes[i]);
		text += hex;
		if ((i + 1) % 16 == 0)
		{
			// Hexadecimal-looking ASCII must not become extra input bytes.
			text += "| ABCD0123456789EF\n";
		}
	}
	if (final_newline && bytes.size() % 16) text += '\n';
	return text;
}

static std::string decode_text(const std::string &text, int expected = 0, int resync = 0)
{
	GError *error = nullptr;
	// Reserve a unique basename with an API available before GLib 2.30.
	char *base = nullptr;
	const int reservation = g_file_open_tmp("ticables-dbus-trace-XXXXXX", &base, &error);
	CHECK(reservation >= 0 && base && !error);
#ifdef _WIN32
	CHECK(_close(reservation) == 0);
#else
	CHECK(close(reservation) == 0);
#endif
	char *input = g_strconcat(base, ".hex", nullptr);
	char *output = g_strconcat(base, ".pkt", nullptr);
	FILE *file = fopen(input, "wb");
	CHECK(file);
	CHECK(fwrite(text.data(), 1, text.size(), file) == text.size());
	CHECK(fclose(file) == 0);
	CHECK(dbus_decomp(base, resync) == expected);
	char *result = nullptr;
	gsize size = 0;
	CHECK(g_file_get_contents(output, &result, &size, &error));
	std::string converted(result, size);
	g_free(result);
	// The decoder writes native text, but g_file_get_contents reads raw bytes.
	// Normalize Windows CRLF so the assertions can check complete lines.
	for (size_t pos = 0; (pos = converted.find("\r\n", pos)) != std::string::npos; pos++)
	{
		converted.replace(pos, 2, "\n");
	}
	CHECK(remove(input) == 0);
	CHECK(remove(output) == 0);
	CHECK(remove(base) == 0);
	g_free(base);
	g_free(input);
	g_free(output);
	return converted;
}

static std::string decode(const std::vector<uint8_t> &bytes, int expected = 0, int resync = 0)
{
	return decode_text(hex_log(bytes), expected, resync);
}

static void append_packet(std::vector<uint8_t> &bytes, uint8_t command, bool data)
{
	const std::vector<uint8_t> header = {0x73, command, (uint8_t)(data ? 3 : 0), 0};
	bytes.insert(bytes.end(), header.begin(), header.end());
	if (data)
	{
		// Checksum = 0x01a9 (unsigned byte sum, little endian).
		const uint8_t payload[] = {0x00, 0xaa, 0xff, 0xa9, 0x01};
		bytes.insert(bytes.end(), payload, payload + sizeof(payload));
	}
}

static void check_commands()
{
	struct Command { uint8_t value; const char *legacy; const char *official; bool data; };
	const Command commands[] = {
		{0x06, "VAR", "RTS", true},
		{0x09, "CTS", "RDY", false},
		{0x15, "XDP", "XDP", true},
		{0x29, "ELD", "EBL", false},
		{0x2a, "DLD", "DBL", false},
		{0x2b, "EKE", "EKE", false},
		{0x2c, "DKE", "DKE", false},
		{0x2d, "VER", "RDI", false},
		{0x36, "SKP", "EOR", true},
		{0x47, "SID", "SIOA", true},
		{0x56, "ACK", "ACK", false},
		{0x5a, "ERR", "CHK", false},
		{0x68, "RDY", "RDC", false},
		{0x6d, "SCR", "REQ", false},
		{0x6e, "GID", "???", false},
		{0x6f, "DMP", "???", true},
		{0x70, "TG2", "???", true},
		{0x74, "RID", "RIOA", false},
		{0x78, "CNT", "RTC", false},
		{0x87, "KEY", "SKY", false},
		{0x88, "DEL", "DVL", true},
		{0x89, "RUN", "EPL", true},
		{0x92, "EOT", "DONE", false},
		{0xa2, "REQ", "GET", true},
		{0xb4, "ERR2", "???", false},
		{0xb7, "IND", "GTE", true},
		{0xc9, "RTS", "SEND", true},
		{0xca, "RSE", "SETP", true},
	};
	std::vector<uint8_t> bytes;
	for (const Command &command : commands) append_packet(bytes, command.value, command.data);
	const std::string output = decode(bytes);
	for (const Command &command : commands)
	{
		const std::string label = std::string(": ") + command.legacy + " (TI: " + command.official + ")";
		CHECK(output.find(label) != std::string::npos);
	}
	CHECK(output.find("Checksum mismatch") == std::string::npos);
	// A small final line also parses when explicitly terminated with newline.
	CHECK(decode_text(hex_log({0x73, 0x56, 0, 0}, true)).find(": ACK (TI: ACK)") != std::string::npos);
}

static void check_short_words_and_payloads()
{
	const std::vector<uint8_t> bytes = {
		0x73, 0x5a, 0x34, 0x12, // CHK status, no data/checksum
		0x73, 0x56, 0x05, 0x00, // ACK status
		0x23, 0x87, 0x1b, 0x00, // SKY keycode
		0x73, 0x09, 0x03, 0x00, // RDY header value
		0x73, 0x92, 0x04, 0x00, // DONE header value
		0x73, 0xb4, 0x02, 0x00, // legacy ERR2 header value
		0x73, 0x15, 0x03, 0x00, 0x00, 0xaa, 0xff, 0xa9, 0x01,
		0x73, 0x56, 0x00, 0x00
	};
	const std::string output = decode(bytes);
	CHECK(output.find("23 87 1B 00") != std::string::npos);
	CHECK(output.find("73 56 05 00") != std::string::npos);
	CHECK(output.find("ERR (TI: CHK) [status=1234]") != std::string::npos);
	CHECK(output.find("ACK (TI: ACK) [status=0005]") != std::string::npos);
	CHECK(output.find("KEY (TI: SKY) [key=001B]") != std::string::npos);
	CHECK(output.find("CTS (TI: RDY) [status=0003]") != std::string::npos);
	CHECK(output.find("EOT (TI: DONE) [status=0004]") != std::string::npos);
	CHECK(output.find("ERR2 (TI: ??" "?) [status=0002]") != std::string::npos);
	CHECK(output.find("XDP (TI: XDP)") != std::string::npos);
	CHECK(output.find("Checksum mismatch") == std::string::npos);
	CHECK(decode({0x73, 0x15, 0x01, 0x00, 0xff, 0x00, 0x00}).find("Checksum mismatch") != std::string::npos);
	// Empty XDP does not consume the next ACK as a checksum.
	CHECK(decode({0x73, 0x15, 0, 0, 0x73, 0x56, 0, 0}).find(": ACK (TI: ACK)") != std::string::npos);
	CHECK(decode({0x00, 0x6d, 0x80, 0x56}).find("TI>PC: ACK (TI: ACK)") != std::string::npos);
	CHECK(decode({0x42, 0x56, 0, 0, 0x43, 0x56, 0, 0}).find("TIPR>PC") != std::string::npos);
	// A probe log: libticalcs sends the MID 0x00 RDC as two bytes.
	const std::string probe = decode({0x00, 0x68, 0x73, 0x56, 0x00, 0x00});
	CHECK(probe.find("PC>TI: RDY (TI: RDC)\n") != std::string::npos);
	CHECK(probe.find("TI>PC: ACK (TI: ACK)") != std::string::npos);
	// Data-carrying MID 0x00 packets keep their header word.
	CHECK(decode({0x00, 0x15, 0x01, 0x00, 0x41, 0x41, 0x00}).find("PC>TI: XDP") != std::string::npos);
	// CBL / CBR traffic.
	const std::string cbl = decode({0x12, 0x56, 0, 0, 0x15, 0x56, 0, 0, 0x19, 0x56, 0, 0, 0x95, 0x56, 0, 0});
	CHECK(cbl.find("CBL>TI: ACK") != std::string::npos);
	CHECK(cbl.find("TI>CBL: ACK") != std::string::npos);
}

static void check_malformed_captures()
{
	decode({0xff, 0x56, 0, 0}, -1);
	decode({0xfe, 0x56, 0, 0}, -1);
	decode({0x73, 0xff, 0, 0}, -2);
	decode({0x73, 0xfe, 0, 0}, -2);
	decode({0x73}, -3);
	decode({0x73, 0x56}, -3);
	decode({0x73, 0x56, 0}, -3);
	decode({0x73, 0x15, 1, 0}, -3);
	decode({0x73, 0x15, 1, 0, 0x41}, -3);
	decode({0x73, 0x15, 1, 0, 0x41, 0x41}, -3);
	decode_text("TiCables-2 data logger\nVersion 1.3.6\n\n100 56 00 00 ", -1);
	decode_text("TiCables-2 data logger\nVersion 1.3.6\n\n73 ZZ 00 00 ", -1);
	decode_text("TiCables-2 data logger\nVersion 1.3.6\n\n7", -1);
	decode_text("TiCables-2 data logger\n", -1);
	decode_text("TiCables-2 data logger\nVersion 1.3.6\n\n");
	CHECK(dbus_decomp(nullptr, 0) == -1);
	const std::string too_long(2048, 'x');
	CHECK(dbus_decomp(too_long.c_str(), 0) == -1);
}

static void check_resynchronization()
{
	// A corrupted payload length exceeds the remaining capture, but resync
	// can still recover a complete TI-89 ACK embedded in those bytes.
	const std::vector<uint8_t> capture = {0x98, 0x15, 100, 0, 0xaa, 0x98, 0x56, 5, 0};
	decode(capture, -3);
	const std::string result = decode(capture, 0, 1);
	CHECK(result.find("Beware : length of previous packet is wrong") != std::string::npos);
	CHECK(result.find("ACK (TI: ACK) [status=0005]") != std::string::npos);
	decode({0x98, 0x15, 100, 0, 0x98}, -3, 1);
	// A failed conversion cannot leak its partial display row to a new one.
	CHECK(decode({0x73, 0x15, 1, 0, 0x31, 0x31, 0}).find("31 ") != std::string::npos);
}

int main()
{
	check_commands();
	check_short_words_and_payloads();
	check_malformed_captures();
	check_resynchronization();
	puts("DBUS hexadecimal trace decoder tests passed");
	return 0;
}
