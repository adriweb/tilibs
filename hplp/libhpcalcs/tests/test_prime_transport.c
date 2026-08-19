/* Focused transport tests for legacy and G2 HP Prime HID report sizes. */

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "hpcalcs.h"
#include "error.h"
#include "prime_cmd.h"

#define MAX_REPORTS 8

typedef struct {
    uint32_t count;
    uint32_t lengths[MAX_REPORTS];
    uint8_t reports[MAX_REPORTS][PRIME_RAW_HID_DATA_SIZE_MAX + 1];
    uint32_t recv_count;
    uint32_t recv_index;
    uint32_t recv_lengths[MAX_REPORTS];
    uint8_t recv_reports[MAX_REPORTS][PRIME_RAW_HID_DATA_SIZE_MAX];
} mock_transport;

static int mock_send(cable_handle *handle, uint8_t *data, uint32_t len) {
    mock_transport *mock = (mock_transport *)handle->handle;
    if (mock == NULL || data == NULL || mock->count >= MAX_REPORTS
        || len > sizeof(mock->reports[0])) {
        return ERR_INVALID_PARAMETER;
    }
    mock->lengths[mock->count] = len;
    memcpy(mock->reports[mock->count], data, len);
    mock->count++;
    return ERR_SUCCESS;
}

static int mock_recv(cable_handle *handle, uint8_t **data, uint32_t *len) {
    mock_transport *mock = (mock_transport *)handle->handle;
    if (mock == NULL || data == NULL || *data == NULL || len == NULL
        || mock->recv_index >= mock->recv_count) {
        return ERR_CABLE_READ_ERROR;
    }
    *len = mock->recv_lengths[mock->recv_index];
    memcpy(*data, mock->recv_reports[mock->recv_index], *len);
    mock->recv_index++;
    return ERR_SUCCESS;
}

static const cable_fncts mock_fncts = {
    CABLE_PRIME_HID,
    "Mock Prime HID cable",
    "Prime transport unit-test cable",
    NULL,
    NULL,
    NULL,
    NULL,
    mock_send,
    mock_recv
};

static int check(int condition, const char *message) {
    if (!condition) {
        fprintf(stderr, "FAIL: %s\n", message);
        return 1;
    }
    return 0;
}

static int run_fragmentation_case(uint32_t report_size) {
    const uint32_t payload_size = report_size - 1;
    const uint32_t data_size = payload_size + 5;
    uint8_t *data = (uint8_t *)malloc(data_size);
    prime_vtl_pkt packet;
    mock_transport mock = {0};
    cable_handle cable = {0};
    calc_handle calc = {0};
    uint32_t i;
    int failed = 0;

    if (data == NULL) {
        return check(0, "test data allocation");
    }
    for (i = 0; i < data_size; i++) {
        data[i] = (uint8_t)(i * 17U + 3U);
    }

    cable.model = CABLE_PRIME_HID;
    cable.handle = &mock;
    cable.fncts = &mock_fncts;
    cable.report_size = report_size;
    cable.open = 1;
    calc.model = CALC_PRIME;
    calc.cable = &cable;
    packet.size = data_size;
    packet.data = data;
    packet.cmd = 0;

    failed |= check(prime_send_data(&calc, &packet) == ERR_SUCCESS,
                    "prime_send_data succeeds");
    failed |= check(mock.count == 2, "payload is split into two HID reports");
    failed |= check(mock.lengths[0] == report_size + 1,
                    "full report includes report ID and complete HID payload");
    failed |= check(mock.lengths[1] == 7,
                    "short report includes report ID, sequence byte, and remainder");
    failed |= check(mock.reports[0][0] == 0 && mock.reports[0][1] == 0,
                    "first report has zero report ID and sequence zero");
    failed |= check(mock.reports[1][0] == 0 && mock.reports[1][1] == 1,
                    "second report increments sequence independently of report ID");
    failed |= check(memcmp(mock.reports[0] + 2, data, payload_size) == 0,
                    "first report payload is intact");
    failed |= check(memcmp(mock.reports[1] + 2, data + payload_size, 5) == 0,
                    "second report payload is intact");

    free(data);
    return failed;
}

static int run_sequence_wrap_case(void) {
    const uint32_t report_size = PRIME_RAW_HID_DATA_SIZE_LEGACY;
    const uint32_t payload_size = report_size - 1;
    const uint32_t data_size = payload_size * 256;
    uint8_t *data = (uint8_t *)calloc(data_size, 1);
    prime_vtl_pkt packet = {data_size, data, 0};
    mock_transport mock = {0};
    cable_handle cable = {0};
    calc_handle calc = {0};
    int failed = 0;

    if (data == NULL) {
        return check(0, "sequence-wrap allocation");
    }

    /* Only retain the last reports by testing the boundary in two calls. The
     * production loop itself is exercised by a report-count-only callback. */
    cable.model = CABLE_PRIME_HID;
    cable.handle = &mock;
    cable.fncts = &mock_fncts;
    cable.report_size = report_size;
    cable.open = 1;
    calc.model = CALC_PRIME;
    calc.cable = &cable;

    /* The bounded recorder intentionally rejects report 9; verify errors are
     * propagated instead of silently continuing after a transport failure. */
    failed |= check(prime_send_data(&calc, &packet) == ERR_INVALID_PARAMETER,
                    "transport write failure is propagated");
    failed |= check(mock.count == MAX_REPORTS,
                    "fragmentation stops immediately after a transport failure");

    free(data);
    return failed;
}

static int run_variable_receive_case(void) {
    static const uint8_t message[] = {
        CMD_PRIME_RECV_SCREEN, 0x01, 0x00, 0x00, 0x00, 0x0E,
        0x12, 0x34, 0x08, 0xFF, 0xFF, 0xFF, 0xFF,
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A
    };
    mock_transport mock = {0};
    cable_handle cable = {0};
    calc_handle calc = {0};
    prime_vtl_pkt packet = {0, NULL, CMD_PRIME_RECV_SCREEN};
    int failed = 0;

    mock.recv_count = 2;
    mock.recv_lengths[0] = 9;
    mock.recv_reports[0][0] = 0;
    memcpy(mock.recv_reports[0] + 1, message, 8);
    mock.recv_lengths[1] = 13;
    mock.recv_reports[1][0] = 1;
    memcpy(mock.recv_reports[1] + 1, message + 8, sizeof(message) - 8);

    cable.model = CABLE_PRIME_HID;
    cable.handle = &mock;
    cable.fncts = &mock_fncts;
    cable.report_size = PRIME_RAW_HID_DATA_SIZE_LEGACY;
    cable.open = 1;
    calc.model = CALC_PRIME;
    calc.cable = &cable;

    failed |= check(prime_recv_data(&calc, &packet) == ERR_SUCCESS,
                    "variable-length legacy reports are reassembled");
    failed |= check(packet.size == sizeof(message)
                    && packet.data != NULL
                    && memcmp(packet.data, message, sizeof(message)) == 0,
                    "declared virtual-packet size, not a short HID report, ends reception");
    free(packet.data);

    memset(&packet, 0, sizeof(packet));
    packet.cmd = CMD_PRIME_RECV_SCREEN;
    mock.recv_index = 0;
    mock.recv_count = 1;
    failed |= check(prime_recv_data(&calc, &packet) == ERR_CABLE_READ_ERROR,
                    "truncated legacy message reports a read failure");
    failed |= check(packet.size == 8,
                    "truncated legacy message is not enlarged with uninitialized bytes");
    free(packet.data);
    return failed;
}

static int run_stale_receive_case(void) {
    static const uint8_t info_message[] = {
        CMD_PRIME_GET_INFOS, 0x03, 0x00, 0x00, 0x00, 0x02,
        0x12, 0x34
    };
    static const uint8_t stale_start[] = {
        0, CMD_PRIME_RECV_FILE, 0x03, 0, 0, 0, 2, 0xAA, 0x55
    };
    mock_transport mock = {0};
    cable_handle cable = {0};
    calc_handle calc = {0};
    prime_vtl_pkt packet = {0, NULL, CMD_PRIME_GET_INFOS};
    int failed = 0;

    mock.recv_count = 4;
    mock.recv_lengths[0] = 3;
    mock.recv_reports[0][0] = 2;
    mock.recv_reports[0][1] = 0xDE;
    mock.recv_reports[0][2] = 0xAD;
    mock.recv_lengths[1] = sizeof(stale_start);
    memcpy(mock.recv_reports[1], stale_start, sizeof(stale_start));
    mock.recv_lengths[2] = 3;
    mock.recv_reports[2][0] = 1;
    mock.recv_reports[2][1] = 0xBE;
    mock.recv_reports[2][2] = 0xEF;
    mock.recv_lengths[3] = 1 + sizeof(info_message);
    mock.recv_reports[3][0] = 0;
    memcpy(mock.recv_reports[3] + 1, info_message, sizeof(info_message));

    cable.model = CABLE_PRIME_HID;
    cable.handle = &mock;
    cable.fncts = &mock_fncts;
    cable.report_size = PRIME_RAW_HID_DATA_SIZE_LEGACY;
    cable.open = 1;
    calc.model = CALC_PRIME;
    calc.cable = &cable;

    failed |= check(prime_recv_data(&calc, &packet) == ERR_SUCCESS,
                    "legacy receive skips stale reports until its command header");
    failed |= check(packet.size == sizeof(info_message)
                    && packet.data != NULL
                    && memcmp(packet.data, info_message,
                              sizeof(info_message)) == 0,
                    "legacy receive returns only the current command reply");
    free(packet.data);
    return failed;
}

int main(void) {
    int failed = 0;
    failed |= run_fragmentation_case(PRIME_RAW_HID_DATA_SIZE_LEGACY);
    failed |= run_fragmentation_case(PRIME_RAW_HID_DATA_SIZE_G2);
    failed |= run_sequence_wrap_case();
    failed |= run_variable_receive_case();
    failed |= run_stale_receive_case();
    if (!failed) {
        puts("HP Prime transport tests passed");
    }
    return failed ? EXIT_FAILURE : EXIT_SUCCESS;
}
