#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <vector>

#include "../src/ticalcs.h"
#include "../src/internal.h"
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

struct SentPacket
{
	uint16_t type;
	std::vector<uint8_t> payload;
};

struct MockCalculator
{
	CableFncts functions = {};
	CableHandle cable = {};
	CalcHandle* handle;
	CalcClock clock = {};
	bool classic, timezone_supported = true, fail_after_timezone = false;
	int malformed_timezone = 0, receive_failure = 0, send_failure = 0;
	std::vector<uint8_t> incoming;
	std::vector<SentPacket> sent;
	size_t received = 0;
	unsigned timezone_writes = 0;
	static MockCalculator* active;

	explicit MockCalculator(CalcModel model = CALC_TI84PCE_USB)
		: classic(model == CALC_TI84P_USB || model == CALC_TI84PC_USB)
	{
		CHECK(!active);
		active = this;
		functions.recv = receive;
		functions.send = send;
		cable.cable = &functions;
		cable.open = 1;
		cable.timeout = 50;
		handle = ticalcs_handle_new(model);
		CHECK(handle);
		handle->updat->cancel = 0;
		handle->cable = &cable;
		handle->open = handle->attached = 1;
		clock.year = 2026;
		clock.month = 11;
		clock.day = 14;
		clock.hours = 12;
		clock.minutes = 34;
		clock.seconds = 20;
		clock.time_format = 24;
		clock.date_format = 2;
		clock.state = 1;
		clock.timezone_minutes = 60;
		clock.timezone_valid = 1;
	}

	~MockCalculator()
	{
		handle->attached = 0;
		ticalcs_handle_del(handle);
		active = nullptr;
	}

	static int receive(CableHandle*, uint8_t* data, uint32_t size)
	{
		MockCalculator& calc = *active;
		if (calc.receive_failure) return calc.receive_failure;
		CHECK(calc.received <= calc.incoming.size());
		CHECK(size <= calc.incoming.size() - calc.received);
		if (size) memcpy(data, calc.incoming.data() + calc.received, size);
		calc.received += size;
		return 0;
	}

	void packet(uint16_t type, const std::vector<uint8_t>& payload)
	{
		const unsigned size = payload.size() + 6;
		incoming.insert(incoming.end(), {0, 0, uint8_t(size >> 8), uint8_t(size), 4,
			0, 0, uint8_t(payload.size() >> 8), uint8_t(payload.size()), uint8_t(type >> 8), uint8_t(type)});
		incoming.insert(incoming.end(), payload.begin(), payload.end());
	}

	bool parameter(uint16_t pid, std::vector<uint8_t>& data)
	{
		unsigned value = 0, size = 1;
		switch (pid)
		{
			case DUSB_PID_CLASSIC_CLK_SUPPORT: if (!classic) return false; value = 1; break;
			case DUSB_PID_NEW_CLK_SUPPORT: if (classic) return false; value = 1; break;
			case DUSB_PID_CLK_ON: value = clock.state; break;
			case DUSB_PID_CLK_SEC_SINCE_1997:
			{
				if (!classic) return false;
				uint32_t seconds;
				CHECK(ticalcs_clock_to_dusb(&clock, &seconds) == 0);
				data = {uint8_t(seconds >> 24), uint8_t(seconds >> 16), uint8_t(seconds >> 8), uint8_t(seconds)};
				return true;
			}
			case DUSB_PID_CLK_DATE_FMT: value = clock.date_format == 3 ? 0 : clock.date_format; break;
			case DUSB_PID_CLK_TIME_FMT: value = classic ? unsigned(clock.time_format == 24) : clock.time_format == 12 ? 0x80 : 0x81; break;
			case DUSB_PID_CLK_TZ:
				if (!timezone_supported) return false;
				value = uint16_t(clock.timezone_minutes); size = malformed_timezone == 2 ? 1 : 2; break;
			case DUSB_PID_CLK_SECONDS: if (classic) return false; value = clock.seconds; break;
			case DUSB_PID_CLK_MINUTES: if (classic) return false; value = clock.minutes; break;
			case DUSB_PID_CLK_HOURS:
				if (classic) return false;
				value = clock.time_format == 12 ? (clock.hours % 12 ? clock.hours % 12 : 12) : clock.hours; break;
			case DUSB_PID_CLK_DAY: if (classic) return false; value = clock.day; break;
			case DUSB_PID_CLK_MONTH: if (classic) return false; value = clock.month; break;
			case DUSB_PID_CLK_YEAR: if (classic) return false; value = clock.year; size = 2; break;
			default: CHECK(false);
		}
		if (size == 2) data.push_back(uint8_t(value >> 8));
		data.push_back(uint8_t(value));
		return true;
	}

	void set_parameter(uint16_t pid, const std::vector<uint8_t>& data)
	{
		CHECK(data.size() >= 5);
		unsigned value = data[4];
		if (data[3] == 2) value = (value << 8) | data[5];
		switch (pid)
		{
			case DUSB_PID_CLK_TZ:
				CHECK(timezone_supported && data[3] == 2);
				clock.timezone_minutes = int16_t(value >= 0x8000 ? int(value) - 0x10000 : int(value));
				++timezone_writes; break;
			case DUSB_PID_CLK_SEC_SINCE_1997:
				CHECK(data[3] == 4);
				ticalcs_clock_from_dusb((uint32_t(data[4]) << 24) | (uint32_t(data[5]) << 16)
					| (uint32_t(data[6]) << 8) | data[7], &clock); break;
			case DUSB_PID_CLK_DATE_FMT: clock.date_format = value == 0 ? 3 : value; break;
			case DUSB_PID_CLK_TIME_FMT: clock.time_format = (classic ? value != 0 : value != 0x80) ? 24 : 12; break;
			case DUSB_PID_CLK_ON: clock.state = value; break;
			case DUSB_PID_CLK_SECONDS: clock.seconds = value; break;
			case DUSB_PID_CLK_MINUTES: clock.minutes = value; break;
			case DUSB_PID_CLK_HOURS: clock.hours = value; break;
			case DUSB_PID_CLK_DAY: clock.day = value; break;
			case DUSB_PID_CLK_MONTH: clock.month = value; break;
			case DUSB_PID_CLK_YEAR: clock.year = value; break;
			default: CHECK(false);
		}
	}

	static int send(CableHandle*, uint8_t* bytes, uint32_t size)
	{
		MockCalculator& calc = *active;
		if (calc.send_failure) return calc.send_failure;
		if (!size || (size >= 5 && bytes[4] == 5)) return 0;
		CHECK(size >= 11 && bytes[4] == 4);
		const uint16_t type = (uint16_t(bytes[9]) << 8) | bytes[10];
		const std::vector<uint8_t> data(bytes + 11, bytes + size);
		if (type == DUSB_VPKT_PARM_SET && calc.fail_after_timezone && calc.timezone_writes)
		{
			return ERROR_WRITE_TIMEOUT;
		}
		calc.sent.push_back({type, data});
		calc.incoming.insert(calc.incoming.end(), {0, 0, 0, 2, 5, 0xe0, 0});
		if (type == DUSB_VPKT_PARM_REQ)
		{
			CHECK(data.size() >= 2 && data.size() == 2U + 2U * data[1]);
			std::vector<uint8_t> response = {0, data[1]};
			for (size_t i = 2; i < data.size(); i += 2)
			{
				const uint16_t pid = (uint16_t(data[i]) << 8) | data[i + 1];
				std::vector<uint8_t> value;
				const bool supported = calc.parameter(pid, value);
				const uint16_t reply_pid = pid == DUSB_PID_CLK_TZ && calc.malformed_timezone == 1 ? DUSB_PID_CLK_TIME_FMT : pid;
				response.insert(response.end(), {uint8_t(reply_pid >> 8), uint8_t(reply_pid), uint8_t(!supported)});
				if (supported)
				{
					response.insert(response.end(), {0, uint8_t(value.size())});
					response.insert(response.end(), value.begin(), value.end());
				}
			}
			calc.packet(DUSB_VPKT_PARM_DATA, response);
		}
		else
		{
			CHECK(type == DUSB_VPKT_PARM_SET && data.size() >= 5);
			calc.set_parameter((uint16_t(data[0]) << 8) | data[1], data);
			calc.packet(DUSB_VPKT_DATA_ACK, {});
		}
		return 0;
	}

	unsigned writes() const
	{
		unsigned count = 0;
		for (const auto& pkt : sent) if (pkt.type == DUSB_VPKT_PARM_SET) ++count;
		return count;
	}
};
MockCalculator* MockCalculator::active;

static void check_clock_fields(const CalcClock& actual, const CalcClock& expected)
{
	CHECK(actual.year == expected.year && actual.month == expected.month && actual.day == expected.day);
	CHECK(actual.hours == expected.hours && actual.minutes == expected.minutes && actual.seconds == expected.seconds);
	CHECK(actual.time_format == expected.time_format && actual.date_format == expected.date_format && actual.state == expected.state);
}

static void check_get_and_set()
{
	for (int offset : {-32768, -330, 0, 60, 345, 32767})
	{
		MockCalculator calc;
		calc.clock.timezone_minutes = offset;
		CalcClock result = {};
		CHECK(ticalcs_calc_get_clock(calc.handle, &result) == 0);
		CHECK(result.timezone_valid && result.timezone_minutes == offset);
		check_clock_fields(result, calc.clock);
		CHECK(calc.sent[0].payload.size() == 28 && calc.sent[0].payload[1] == 13);
		CHECK(calc.sent[0].payload[26] == 0 && calc.sent[0].payload[27] == DUSB_PID_CLK_TZ);
		CHECK(!calc.writes());
		result.timezone_minutes = offset == 0 ? 345 : 0;
		result.timezone_valid = 2; // Presence is a boolean, any nonzero value applies it.
		const CalcClock target = result;
		CHECK(ticalcs_calc_set_clock(calc.handle, &result) == 0);
		CHECK(calc.clock.timezone_minutes == target.timezone_minutes && calc.timezone_writes == 1);
		check_clock_fields(calc.clock, target);
		bool exact_encoding = false;
		for (const auto& pkt : calc.sent)
		{
			if (pkt.type == DUSB_VPKT_PARM_SET && pkt.payload[1] == DUSB_PID_CLK_TZ)
			{
				const uint16_t value = uint16_t(target.timezone_minutes);
				exact_encoding = pkt.payload == std::vector<uint8_t>({0, DUSB_PID_CLK_TZ, 0, 2, uint8_t(value >> 8), uint8_t(value)});
			}
		}
		CHECK(exact_encoding && !calc.handle->busy);
	}
	{
		MockCalculator calc;
		CalcClock target = calc.clock;
		target.timezone_minutes = -330;
		target.timezone_valid = 0;
		target.minutes = 45;
		CHECK(ticalcs_calc_set_clock(calc.handle, &target) == 0);
		CHECK(calc.clock.timezone_minutes == 60 && !calc.timezone_writes);
		check_clock_fields(calc.clock, target);
	}
	{
		MockCalculator calc;
		CalcClock target = calc.clock;
		CHECK(ticalcs_calc_set_clock(calc.handle, &target) == 0);
		CHECK(!calc.timezone_writes); // Already set.
	}
	{
		MockCalculator calc;
		calc.clock.time_format = 12;
		calc.clock.hours = 17;
		calc.clock.timezone_minutes = -330;
		CalcClock result = {};
		CHECK(ticalcs_calc_get_clock(calc.handle, &result) == 0);
		CHECK(result.hours == 17 && result.time_format == 12);
		CHECK(result.timezone_valid && result.timezone_minutes == -330);
		CHECK(calc.clock.time_format == 12);
	}
}

static void check_optional_and_malformed()
{
	for (CalcModel model : {CALC_TI84P_USB, CALC_TI84PC_USB, CALC_TI84PCE_USB})
	{
		MockCalculator calc(model);
		calc.timezone_supported = false;
		CalcClock clock = {};
		CHECK(ticalcs_calc_get_clock(calc.handle, &clock) == 0);
		CHECK(!clock.timezone_valid);
		clock.timezone_valid = 1;
		clock.timezone_minutes = 345;
		CHECK(ticalcs_calc_set_clock(calc.handle, &clock) == 0);
		CHECK(!calc.timezone_writes && !calc.handle->busy);
	}
	for (int malformed : {1, 2})
	{
		MockCalculator calc;
		calc.malformed_timezone = malformed;
		CalcClock result;
		memset(&result, 0xa5, sizeof(result));
		const CalcClock before = result;
		CHECK(ticalcs_calc_get_clock(calc.handle, &result) == ERR_INVALID_PACKET);
		CHECK(!memcmp(&result, &before, sizeof(result)));
		CalcClock target = calc.clock;
		target.timezone_minutes = -330;
		CHECK(ticalcs_calc_set_clock(calc.handle, &target) == ERR_INVALID_PACKET);
		CHECK(!calc.writes() && !calc.handle->busy);
	}
	{
		MockCalculator calc;
		CalcClock target = calc.clock;
		target.year = 1990;
		target.month = 13;
		target.timezone_minutes = -330;
		CHECK(ticalcs_calc_set_clock(calc.handle, &target) == ERR_INVALID_PARAMETER);
		CHECK(calc.sent.empty());
	}
}

static int host_timezone()
{
	GDateTime* now = g_date_time_new_now_local();
	const int offset = g_date_time_get_utc_offset(now) / G_TIME_SPAN_MINUTE;
	g_date_time_unref(now);
	return offset;
}

static void check_sync()
{
	{
		MockCalculator calc(CALC_TI84P_USB);
		calc.timezone_supported = false;
		calc.clock.time_format = 12;
		calc.clock.state = 0;
		CalcClock expected = calc.clock;
		CHECK(ticalcs_clock_now(&expected, 1234, 500000) == 0);
		uint32_t expected_seconds, actual_seconds;
		CHECK(ticalcs_clock_to_dusb(&expected, &expected_seconds) == 0);
		CHECK(ticalcs_calc_sync_clock(calc.handle, 1234) == 0);
		CHECK(ticalcs_clock_to_dusb(&calc.clock, &actual_seconds) == 0);
		CHECK(actual_seconds >= expected_seconds && actual_seconds <= expected_seconds + 2);
		CHECK(!calc.timezone_writes && calc.clock.time_format == 12 && calc.clock.state == 0);
	}
	{
		MockCalculator calc;
		calc.clock.timezone_minutes = host_timezone() == 0 ? 1 : 0;
		calc.fail_after_timezone = true;
		// Stop at the first RTC write: this protocol mock has no one-Hz RTC delays.
		CHECK(ticalcs_calc_sync_clock(calc.handle, 1234) == ERROR_WRITE_TIMEOUT);
		CHECK(calc.timezone_writes == 1 && calc.clock.timezone_minutes == host_timezone());
		CHECK(!calc.handle->busy);
	}
}

static void check_failures()
{
	for (int scenario = 0; scenario < 3; ++scenario)
	{
		MockCalculator calc;
		if (scenario == 0) calc.receive_failure = ERROR_READ_TIMEOUT;
		if (scenario == 1) calc.send_failure = ERROR_WRITE_TIMEOUT;
		if (scenario == 2) calc.handle->updat->cancel = 1;
		const int expected = scenario == 0 ? ERROR_READ_TIMEOUT : scenario == 1 ? ERROR_WRITE_TIMEOUT : ERR_ABORT;
		CalcClock target = calc.clock;
		target.timezone_minutes = -330;
		CHECK(ticalcs_calc_set_clock(calc.handle, &target) == expected);
		CHECK(!calc.timezone_writes && !calc.handle->busy);
	}
}

int main()
{
	ticalcs_library_init();
	check_get_and_set();
	check_optional_and_malformed();
	check_sync();
	check_failures();
	ticalcs_library_exit();
	puts("Clock timezone struct protocol tests passed.");
	return 0;
}
