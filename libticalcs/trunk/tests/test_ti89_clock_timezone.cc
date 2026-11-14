#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <vector>
#include <utility>
#include "../src/internal.h"

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

static std::vector<uint8_t> incoming, outgoing;
static size_t received;
static int receive_failure, send_failure;

static int cable_recv(CableHandle *, uint8_t *data, uint32_t size)
{
	if (receive_failure) return receive_failure;
	CHECK(received <= incoming.size());
	CHECK(size <= incoming.size() - received);
	if (size) memcpy(data, incoming.data() + received, size);
	received += size;
	return 0;
}

static int cable_send(CableHandle *, uint8_t *data, uint32_t size)
{
	if (send_failure) return send_failure;
	outgoing.insert(outgoing.end(), data, data + size);
	return 0;
}

struct MockCalculator
{
	CableFncts functions = {};
	CableHandle cable = {};
	CalcHandle *handle;

	explicit MockCalculator(CalcModel model = CALC_TI89T_USB)
	{
		incoming.clear();
		outgoing.clear();
		received = 0;
		receive_failure = send_failure = 0;
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

static void raw_ack()
{
	incoming.insert(incoming.end(), {0, 0, 0, 2, 5, 0xe0, 0});
}

static void packet(uint16_t type, const std::vector<uint8_t> &payload)
{
	const unsigned size = payload.size() + 6;
	incoming.insert(incoming.end(), {0, 0, uint8_t(size >> 8), uint8_t(size), 4,
		0, 0, uint8_t(payload.size() >> 8), uint8_t(payload.size()), uint8_t(type >> 8), uint8_t(type)});
	incoming.insert(incoming.end(), payload.begin(), payload.end());
}

struct SentPacket
{
	uint16_t type;
	std::vector<uint8_t> payload;
};

static std::vector<SentPacket> sent_packets()
{
	std::vector<SentPacket> packets;
	for (size_t i = 0; i < outgoing.size();)
	{
		CHECK(outgoing.size() - i >= 5);
		const size_t size = (size_t(outgoing[i]) << 24) | (size_t(outgoing[i + 1]) << 16)
			| (size_t(outgoing[i + 2]) << 8) | outgoing[i + 3];
		CHECK(size <= outgoing.size() - i - 5);
		if (outgoing[i + 4] == 4)
		{
			CHECK(size >= 6);
			const uint16_t type = (uint16_t(outgoing[i + 9]) << 8) | outgoing[i + 10];
			packets.push_back({type, {outgoing.begin() + i + 11, outgoing.begin() + i + 5 + size}});
		}
		i += 5 + size;
	}
	return packets;
}

static const uint32_t EPOCH_1997 = 852076800;
static const uint32_t CIVIL_NOON = 942580800; // 2026-11-14 12:00 civil seconds.

static void add_parameter(std::vector<uint8_t> &payload, uint16_t id, const std::vector<uint8_t> &data)
{
	payload.insert(payload.end(), {uint8_t(id >> 8), uint8_t(id), 0,
		uint8_t(data.size() >> 8), uint8_t(data.size())});
	payload.insert(payload.end(), data.begin(), data.end());
}

static void clock_response(uint32_t utc_seconds, int timezone_minutes, bool malformed = false)
{
	raw_ack();
	std::vector<uint8_t> payload = {0, 6};
	add_parameter(payload, DUSB_PID_CLASSIC_CLK_SUPPORT, {1});
	add_parameter(payload, DUSB_PID_CLK_ON, {1});
	add_parameter(payload, DUSB_PID_CLK_SEC_SINCE_1997,
		{uint8_t(utc_seconds >> 24), uint8_t(utc_seconds >> 16), uint8_t(utc_seconds >> 8), uint8_t(utc_seconds)});
	add_parameter(payload, DUSB_PID_CLK_DATE_FMT, {1});
	add_parameter(payload, DUSB_PID_CLK_TIME_FMT, {0});
	if (malformed) add_parameter(payload, DUSB_PID_CLK_TZ, {0});
	else add_parameter(payload, DUSB_PID_CLK_TZ, {uint8_t(uint16_t(timezone_minutes) >> 8), uint8_t(timezone_minutes)});
	packet(DUSB_VPKT_PARM_DATA, payload);
}

static void set_ack()
{
	raw_ack();
	packet(DUSB_VPKT_DATA_ACK, {});
}

static CalcClock noon_clock()
{
	CalcClock clock = {};
	clock.year = 2026;
	clock.month = 11;
	clock.day = 14;
	clock.hours = 12;
	clock.date_format = 1;
	clock.time_format = 12;
	clock.state = 1;
	return clock;
}

static uint32_t written_seconds()
{
	for (const auto &sent : sent_packets())
	{
		if (sent.type == DUSB_VPKT_PARM_SET && sent.payload.size() == 8
			&& sent.payload[0] == 0 && sent.payload[1] == DUSB_PID_CLK_SEC_SINCE_1997)
		{
			CHECK(sent.payload[2] == 0 && sent.payload[3] == 4);
			return (uint32_t(sent.payload[4]) << 24) | (uint32_t(sent.payload[5]) << 16)
				| (uint32_t(sent.payload[6]) << 8) | sent.payload[7];
		}
	}
	CHECK(false);
	return 0;
}

static void check_local_clock_reads()
{
	for (int timezone_minutes : {-330, 0, 345, 840})
	{
		MockCalculator calc;
		clock_response(CIVIL_NOON, timezone_minutes);
		CalcClock clock = {};
		CHECK(ticalcs_calc_get_clock(calc.handle, &clock) == 0);
		GDateTime *expected = g_date_time_new_from_unix_utc((gint64)EPOCH_1997 + CIVIL_NOON + timezone_minutes * 60);
		CHECK(clock.year == g_date_time_get_year(expected));
		CHECK(clock.month == g_date_time_get_month(expected));
		CHECK(clock.day == g_date_time_get_day_of_month(expected));
		CHECK(clock.hours == g_date_time_get_hour(expected));
		CHECK(clock.minutes == g_date_time_get_minute(expected));
		CHECK(clock.seconds == g_date_time_get_second(expected));
		CHECK(clock.date_format == 1 && clock.time_format == 12 && clock.state == 1);
		CHECK(clock.timezone_valid && clock.timezone_minutes == timezone_minutes);
		g_date_time_unref(expected);
		CHECK(received == incoming.size());
		const auto sent = sent_packets();
		CHECK(sent.size() == 1 && sent[0].type == DUSB_VPKT_PARM_REQ);
		CHECK(sent[0].payload == std::vector<uint8_t>({0, 6, 0, DUSB_PID_CLASSIC_CLK_SUPPORT,
			0, DUSB_PID_CLK_ON, 0, DUSB_PID_CLK_SEC_SINCE_1997, 0, DUSB_PID_CLK_DATE_FMT,
			0, DUSB_PID_CLK_TIME_FMT, 0, DUSB_PID_CLK_TZ}));
	}
}

static void check_local_clock_writes()
{
	for (bool explicit_timezone : {false, true}) {
		for (int timezone_minutes : {-330, 0, 345}) {
			MockCalculator calc;
			if (!explicit_timezone) clock_response(CIVIL_NOON, timezone_minutes);
			for (int i = 0; i < (explicit_timezone ? 5 : 4); ++i) set_ack();
			CalcClock clock = noon_clock();
			clock.timezone_valid = explicit_timezone;
			clock.timezone_minutes = explicit_timezone ? timezone_minutes : 1234;
			CHECK(ticalcs_calc_set_clock(calc.handle, &clock) == 0);
			CHECK(written_seconds() == uint32_t((gint64)CIVIL_NOON - timezone_minutes * 60));
			CHECK(received == incoming.size());
			const auto sent = sent_packets();
			CHECK(sent.size() == 5);
			if (explicit_timezone) {
				CHECK(sent[0].type == DUSB_VPKT_PARM_SET);
				CHECK(sent[0].payload == std::vector<uint8_t>({0, DUSB_PID_CLK_TZ, 0, 2,
					uint8_t(uint16_t(timezone_minutes) >> 8), uint8_t(timezone_minutes)}));
			} else CHECK(sent[0].type == DUSB_VPKT_PARM_REQ);
			CHECK(sent[2].payload == std::vector<uint8_t>({0, DUSB_PID_CLK_DATE_FMT, 0, 1, 1}));
			CHECK(sent[3].payload == std::vector<uint8_t>({0, DUSB_PID_CLK_TIME_FMT, 0, 1, 0}));
			CHECK(sent[4].payload == std::vector<uint8_t>({0, DUSB_PID_CLK_ON, 0, 1, 1}));
		}
	}
}

static uint32_t local_seconds_now()
{
	CalcClock clock = {};
	GDateTime* now = g_date_time_new_now_local();
	CHECK(now);
	clock.year = g_date_time_get_year(now);
	clock.month = g_date_time_get_month(now);
	clock.day = g_date_time_get_day_of_month(now);
	clock.hours = g_date_time_get_hour(now);
	clock.minutes = g_date_time_get_minute(now);
	clock.seconds = g_date_time_get_second(now);
	g_date_time_unref(now);
	uint32_t seconds;
	CHECK(ticalcs_clock_to_dusb(&clock, &seconds) == 0);
	return seconds;
}

static int host_timezone_now()
{
	GDateTime *now = g_date_time_new_now_local();
	CHECK(now);
	const int timezone_minutes = g_date_time_get_utc_offset(now) / (60 * G_TIME_SPAN_SECOND);
	g_date_time_unref(now);
	return timezone_minutes;
}

static void check_clock_sync()
{
	const int host_timezone = host_timezone_now();
	for (uint32_t old_raw : {CIVIL_NOON, uint32_t(0)}) {
		for (int old_timezone : {host_timezone, host_timezone == 345 ? -330 : 345, -330}) {
			MockCalculator calc;
			clock_response(old_raw, old_timezone);
			if (host_timezone != old_timezone) set_ack();
			set_ack();
			const uint32_t before = local_seconds_now();
			CHECK(ticalcs_calc_sync_clock(calc.handle, 0) == 0);
			const uint32_t after = local_seconds_now();
			const gint64 written_local = (gint64)written_seconds() + host_timezone * 60;
			CHECK(written_local >= before && written_local <= (gint64)after + 1);
			CHECK(received == incoming.size());
			const auto sent = sent_packets();
			CHECK(sent.size() == (host_timezone != old_timezone ? 3 : 2));
			if (host_timezone != old_timezone) {
				CHECK(sent[1].payload == std::vector<uint8_t>({0, DUSB_PID_CLK_TZ, 0, 2,
					uint8_t(uint16_t(host_timezone) >> 8), uint8_t(host_timezone)}));
			}
		}
	}
}

static void check_clock_epoch_bounds()
{
	for (const auto &fixture : {std::pair<uint32_t, int>{0, -330}, {G_MAXUINT32, 345}})
	{
		MockCalculator calc;
		clock_response(fixture.first, fixture.second);
		CalcClock clock = {};
		CHECK(ticalcs_calc_get_clock(calc.handle, &clock) == 0);
		CHECK(clock.year == 1997 && clock.month == 1 && clock.day == 1);
		CHECK(clock.hours == (fixture.first ? 5 : 0));
		CHECK(clock.minutes == (fixture.first ? 44 : 0));
		CHECK(clock.seconds == (fixture.first ? 59 : 0));
		CHECK(received == incoming.size());
	}
}

static void check_clock_failures()
{
	{
		MockCalculator calc;
		receive_failure = ERROR_READ_TIMEOUT;
		CHECK(ticalcs_calc_sync_clock(calc.handle, 0) == ERROR_READ_TIMEOUT);
		CHECK(sent_packets().size() == 1);
		CHECK(!calc.handle->busy);
	}
	{
		MockCalculator calc;
		CalcClock clock = noon_clock();
		clock.timezone_valid = 1;
		clock.timezone_minutes = 345;
		raw_ack();
		packet(DUSB_VPKT_EOT, {}); // Offset write rejected; do not write date/time.
		CHECK(ticalcs_calc_set_clock(calc.handle, &clock) == ERR_INVALID_PACKET);
		CHECK(sent_packets().size() == 1);
		CHECK(received == incoming.size());
		CHECK(!calc.handle->busy);
	}
}

static void check_invalid_clock_responses()
{
	{
		MockCalculator calc;
		clock_response(CIVIL_NOON, 345, true);
		CalcClock clock = noon_clock();
		CHECK(ticalcs_calc_get_clock(calc.handle, &clock) == ERR_INVALID_PACKET);
		CHECK(clock.hours == 12 && clock.minutes == 0 && clock.year == 2026);
		CHECK(received == incoming.size());
	}
	for (bool explicit_timezone : {false, true}) {
		MockCalculator calc;
		if (!explicit_timezone) clock_response(CIVIL_NOON, 345);
		CalcClock clock = noon_clock();
		clock.year = 1997;
		clock.month = clock.day = 1;
		clock.hours = 0;
		clock.timezone_valid = explicit_timezone;
		clock.timezone_minutes = 345;
		// The target local date is not representable at the selected offset. Reject
		// it before changing the offset or clock, including a combined update.
		CHECK(ticalcs_calc_set_clock(calc.handle, &clock) == ERR_INVALID_PARAMETER);
		const auto sent = sent_packets();
		CHECK(sent.size() == (explicit_timezone ? 0 : 1));
		if (!explicit_timezone) CHECK(sent[0].type == DUSB_VPKT_PARM_REQ);
	}
}

int main()
{
	ticalcs_library_init();
	check_local_clock_reads();
	check_local_clock_writes();
	check_clock_sync();
	check_invalid_clock_responses();
	check_clock_epoch_bounds();
	check_clock_failures();
	ticalcs_library_exit();
	puts("TI-89 Titanium timezone clock tests passed.");
	return 0;
}
