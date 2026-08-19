/* Byte-vector tests for the modern HP Prime V2 framing protocol. */

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <zlib.h>

#include "error.h"
#include "hpcalcs.h"
#include "prime_cmd.h"
#include "prime_protocol_v2.h"

#define MOCK_REPORTS 1040

typedef struct {
    uint32_t sent_count;
    uint32_t sent_sizes[MOCK_REPORTS];
    uint8_t sent[MOCK_REPORTS][PRIME_RAW_HID_DATA_SIZE_MAX + 1];
    uint32_t recv_count;
    uint32_t recv_index;
    uint32_t recv_attempts;
    uint32_t recv_sizes[MOCK_REPORTS];
    uint8_t recv[MOCK_REPORTS][PRIME_RAW_HID_DATA_SIZE_MAX];
} v2_mock_transport;

static int prepare_v2_handle(calc_handle *handle, cable_handle *cable,
                             v2_mock_transport *mock);
static int prepare_v2_handle_with_report_size(calc_handle *handle,
                                              cable_handle *cable,
                                              v2_mock_transport *mock,
                                              uint32_t report_size);

static int mock_send(cable_handle *handle, uint8_t *data, uint32_t size) {
    v2_mock_transport *mock = (v2_mock_transport *)handle->handle;
    if (mock == NULL || data == NULL || mock->sent_count >= MOCK_REPORTS
        || size > sizeof(mock->sent[0])) {
        return ERR_INVALID_PARAMETER;
    }
    mock->sent_sizes[mock->sent_count] = size;
    memcpy(mock->sent[mock->sent_count], data, size);
    mock->sent_count++;
    return ERR_SUCCESS;
}

static int mock_recv(cable_handle *handle, uint8_t **data, uint32_t *size) {
    v2_mock_transport *mock = (v2_mock_transport *)handle->handle;
    if (mock != NULL) {
        mock->recv_attempts++;
    }
    if (mock == NULL || data == NULL || *data == NULL || size == NULL
        || mock->recv_index >= mock->recv_count) {
        return ERR_CABLE_READ_ERROR;
    }
    *size = mock->recv_sizes[mock->recv_index];
    memcpy(*data, mock->recv[mock->recv_index], *size);
    mock->recv_index++;
    return ERR_SUCCESS;
}

static int mock_set_read_timeout(cable_handle *handle, int read_timeout) {
    if (handle == NULL) {
        return ERR_INVALID_HANDLE;
    }
    handle->read_timeout = read_timeout;
    return ERR_SUCCESS;
}

static const cable_fncts mock_fncts = {
    CABLE_PRIME_HID,
    "Mock Prime V2 cable",
    "Prime V2 protocol unit-test cable",
    NULL, NULL, NULL, mock_set_read_timeout,
    mock_send,
    mock_recv
};

static void queue_report(v2_mock_transport *mock, const uint8_t *data,
                         uint32_t size) {
    if (mock->recv_count < MOCK_REPORTS && size <= sizeof(mock->recv[0])) {
        mock->recv_sizes[mock->recv_count] = size;
        memcpy(mock->recv[mock->recv_count], data, size);
        mock->recv_count++;
    }
}

static void queue_ack(v2_mock_transport *mock, uint32_t message_id,
                      uint32_t position) {
    uint8_t data[PRIME_V2_ACK_FRAME_SIZE];
    uint32_t size = 0;
    prime_v2_ack ack = {1, PRIME_V2_SEQUENCE_HEARTBEAT, position, message_id};
    if (prime_v2_encode_ack(&ack, data, sizeof(data), &size) == ERR_SUCCESS) {
        queue_report(mock, data, size);
    }
}

static void queue_v2_message(v2_mock_transport *mock, uint32_t message_id,
                             const uint8_t *data, uint32_t size,
                             uint32_t report_size) {
    uint32_t offset = 0;
    uint8_t sequence = PRIME_V2_SEQUENCE_FIRST;
    do {
        uint8_t frame[PRIME_RAW_HID_DATA_SIZE_MAX] = {0};
        uint32_t header_size = sequence == PRIME_V2_SEQUENCE_FIRST
            ? PRIME_V2_START_HEADER_SIZE : PRIME_V2_CONT_HEADER_SIZE;
        uint32_t available = report_size - header_size;
        uint32_t remaining = size - offset;
        uint32_t chunk = remaining < available ? remaining : available;
        uint32_t frame_size = 0;
        if (prime_v2_encode_content(sequence, message_id, size,
                                    data + offset, chunk, frame, report_size,
                                    &frame_size) != ERR_SUCCESS) {
            return;
        }
        queue_report(mock, frame, frame_size);
        offset += chunk;
        sequence = prime_v2_next_sequence(sequence);
    } while (offset < size);
}

static void queue_legacy_message(v2_mock_transport *mock,
                                 const uint8_t *data, uint32_t size,
                                 uint32_t report_size) {
    uint32_t offset = 0;
    uint8_t sequence = 0;
    while (offset < size) {
        uint8_t report[PRIME_RAW_HID_DATA_SIZE_MAX] = {0};
        uint32_t available = report_size - 1;
        uint32_t remaining = size - offset;
        uint32_t chunk = remaining < available ? remaining : available;
        report[0] = sequence;
        memcpy(report + 1, data + offset, chunk);
        queue_report(mock, report, 1 + chunk);
        offset += chunk;
        sequence++;
        if (sequence == 0xFF) {
            sequence = 0;
        }
    }
}

static void queue_v2_echo_negotiation(v2_mock_transport *mock,
                                      uint32_t report_size) {
    static const uint8_t response[] = {
        0xFD, 0x01, 0x00, 0x00, 0x00, 0x01, 0x03
    };
    queue_ack(mock, 1, sizeof(response));
    queue_v2_message(mock, 0xD1, response, sizeof(response), report_size);
}

static void queue_v2_detailed_negotiation(v2_mock_transport *mock,
                                          uint32_t report_size) {
    uint8_t response[55] = {
        0xFD, 0x03, 0x00, 0x00, 0x00, 0x01, 0x03
    };
    response[7] = 0x66;
    response[8] = 0x3D;
    memcpy(response + 11, "V0.050.640", 10);
    memcpy(response + 27, "G1OR2SERIAL", 11);
    queue_ack(mock, 1, sizeof(response));
    queue_v2_message(mock, 0xD1, response, sizeof(response), report_size);
}

static uint16_t test_crc16(const uint8_t *buffer, uint32_t len) {
    uint16_t crc = 0;
    while (len--) {
        uint8_t bit;
        crc ^= (uint16_t)*buffer++ << 8;
        for (bit = 0; bit < 8; bit++) {
            crc = (crc & 0x8000U) ? (uint16_t)((crc << 1) ^ 0x1021U)
                                  : (uint16_t)(crc << 1);
        }
    }
    return crc;
}

static int check(int condition, const char *message) {
    if (!condition) {
        fprintf(stderr, "FAIL: %s\n", message);
        return 1;
    }
    return 0;
}

static int test_content_frames(void) {
    static const uint8_t payload[] = {0xF9, 0x01, 0xAA, 0x55};
    static const uint8_t expected_start[] = {
        0x01,
        0x78, 0x56, 0x34, 0x12,
        0x04, 0x00, 0x00, 0x00,
        0xF9, 0x01, 0xAA, 0x55
    };
    uint8_t encoded[32];
    uint32_t encoded_size = 0;
    prime_v2_content frame;
    int failed = 0;

    failed |= check(prime_v2_encode_content(1, 0x12345678U, 4,
                    payload, sizeof(payload), encoded, sizeof(encoded),
                    &encoded_size) == ERR_SUCCESS,
                    "encode V2 start frame");
    failed |= check(encoded_size == sizeof(expected_start)
                    && memcmp(encoded, expected_start, sizeof(expected_start)) == 0,
                    "start frame uses sequence 1 and LE message ID/size");
    failed |= check(prime_v2_decode_content(encoded, encoded_size, &frame)
                    == ERR_SUCCESS,
                    "decode V2 start frame");
    failed |= check(frame.is_start && frame.sequence == 1
                    && frame.message_id == 0x12345678U
                    && frame.total_size == sizeof(payload)
                    && frame.data_size == sizeof(payload)
                    && memcmp(frame.data, payload, sizeof(payload)) == 0,
                    "decoded start frame fields match");

    failed |= check(prime_v2_encode_content(2, 0, 0, payload, 2,
                    encoded, sizeof(encoded), &encoded_size) == ERR_SUCCESS,
                    "encode continuation frame");
    failed |= check(encoded_size == 3 && encoded[0] == 2
                    && encoded[1] == 0xF9 && encoded[2] == 0x01,
                    "continuation has only a sequence header");
    failed |= check(prime_v2_decode_content(encoded, encoded_size, &frame)
                    == ERR_SUCCESS && !frame.is_start && frame.data_size == 2,
                    "decode continuation frame");

    failed |= check(prime_v2_next_sequence(1) == 2
                    && prime_v2_next_sequence(0xFC) == 0xFD
                    && prime_v2_next_sequence(0xFD) == 2,
                    "sequence wraps from FD to 2 without reusing start or OOB IDs");
    return failed;
}

static int test_ack_frames(void) {
    static const uint8_t expected_ack[] = {
        0xFE, 0x01, 0xFF, 0x00,
        0x00, 0x04, 0x00, 0x00,
        0x78, 0x56, 0x34, 0x12
    };
    static const uint8_t expected_nack[] = {
        0xFE, 0x00, 0x07, 0x00,
        0x00, 0x08, 0x00, 0x00,
        0x78, 0x56, 0x34, 0x12
    };
    static const uint8_t heartbeat[] = {
        0xFE, 0x01, 0xFF, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00
    };
    prime_v2_ack ack = {1, 0xFF, 1024, 0x12345678U};
    uint8_t encoded[PRIME_V2_ACK_FRAME_SIZE];
    uint32_t encoded_size = 0;
    prime_v2_ack decoded;
    int failed = 0;

    failed |= check(prime_v2_encode_ack(&ack, encoded, sizeof(encoded),
                    &encoded_size) == ERR_SUCCESS,
                    "encode ACK with meaningless FF sequence");
    failed |= check(encoded_size == sizeof(expected_ack)
                    && memcmp(encoded, expected_ack, sizeof(expected_ack)) == 0,
                    "ACK vector matches documented LE layout");
    failed |= check(prime_v2_decode_ack(encoded, encoded_size, &decoded)
                    == ERR_SUCCESS && decoded.is_ack
                    && decoded.message_id == 0x12345678U
                    && decoded.block_position == 1024,
                    "decode ACK without rejecting its meaningless sequence byte");

    ack.is_ack = 0;
    ack.sequence_to_resend = 7;
    ack.block_position = 2048;
    failed |= check(prime_v2_encode_ack(&ack, encoded, sizeof(encoded),
                    &encoded_size) == ERR_SUCCESS
                    && memcmp(encoded, expected_nack, sizeof(expected_nack)) == 0,
                    "NACK encodes resend sequence and byte position");
    failed |= check(prime_v2_decode_ack(encoded, encoded_size, &decoded)
                    == ERR_SUCCESS && !decoded.is_ack
                    && decoded.sequence_to_resend == 7,
                    "decode NACK resend state");

    failed |= check(!prime_v2_is_heartbeat(expected_ack, sizeof(expected_ack)),
                    "real ACK with FF sequence is not mistaken for heartbeat");
    failed |= check(prime_v2_is_heartbeat(heartbeat, sizeof(heartbeat)),
                    "FE 01 FF is classified as an out-of-band heartbeat");
    return failed;
}

static int test_prime_file_extensions(void) {
    uint8_t type = PRIME_TYPE_UNKNOWN;
    char *calc_name = NULL;
    int failed = 0;

    failed |= check(strcmp(hpfiles_vartype2fext(CALC_PRIME,
                    PRIME_TYPE_MATRIX), "hpmat") == 0,
                    "Prime matrices use the Connectivity Kit .hpmat extension");
    failed |= check(hpfiles_parsefilename(CALC_PRIME, "M1.hpmat", &type,
                    &calc_name) == ERR_SUCCESS
                    && type == PRIME_TYPE_MATRIX && calc_name != NULL
                    && strcmp(calc_name, "M1") == 0,
                    "parse canonical .hpmat matrix filename");
    free(calc_name);
    calc_name = NULL;
    type = PRIME_TYPE_UNKNOWN;
    failed |= check(hpfiles_parsefilename(CALC_PRIME, "M2.hpmatrix", &type,
                    &calc_name) == ERR_SUCCESS
                    && type == PRIME_TYPE_MATRIX && calc_name != NULL
                    && strcmp(calc_name, "M2") == 0,
                    "retain compatibility with historical .hpmatrix uploads");
    free(calc_name);
    return failed;
}

static int test_info_state(void) {
    uint8_t info[108] = {0};
    cable_handle cable = {0};
    calc_handle handle = {0};
    calc_prime_protocol_info public_info;
    int failed = 0;

    handle.prime = prime_protocol_state_new();
    handle.cable = &cable;
    cable.report_size = PRIME_RAW_HID_DATA_SIZE_G2;
    failed |= check(handle.prime != NULL, "allocate Prime protocol state");
    if (handle.prime == NULL) {
        return failed;
    }

    info[sizeof(info) - 36] = 0x0B;
    info[sizeof(info) - 35] = 0x39; /* 14603, known G2 issue example. */
    memcpy(info + sizeof(info) - 32, "2.1.14603", 9);
    memcpy(info + sizeof(info) - 16, "G2SERIAL", 8);
    handle.model = CALC_PRIME;
    failed |= check(prime_protocol_record_infos(&handle, info, sizeof(info))
                    == ERR_SUCCESS,
                    "record GET_INFOS build");
    failed |= check(prime_protocol_get_build(&handle) == 14603
                    && !prime_protocol_supports_v2(&handle)
                    && prime_protocol_get_version(&handle) == PRIME_PROTOCOL_LEGACY,
                    "GET_INFOS metadata does not infer a protocol capability");
    failed |= check(prime_protocol_next_message_id(&handle) == 1
                    && prime_protocol_next_message_id(&handle) == 2,
                    "message IDs are per-handle and monotonic");
    failed |= check(hpcalcs_prime_get_protocol_info(&handle, &public_info)
                    == ERR_SUCCESS && public_info.build == 14603
                    && !public_info.supports_v2
                    && strcmp(public_info.version, "2.1.14603") == 0
                    && strcmp(public_info.serial, "G2SERIAL") == 0,
                    "public Prime metadata API exposes recorded build/version/serial");

    cable.report_size = PRIME_RAW_HID_DATA_SIZE_LEGACY;
    failed |= check(prime_protocol_record_infos(&handle, info, sizeof(info))
                    == ERR_SUCCESS
                    && !prime_protocol_supports_v2(&handle),
                    "HID report size does not infer a protocol capability");

    prime_protocol_state_del(handle.prime);
    return failed;
}

static int test_modern_legacy_headers(void) {
    enum { INFO_BODY_SIZE = 108, INFO_PACKET_SIZE = 6 + INFO_BODY_SIZE };
    uint8_t report[1 + INFO_PACKET_SIZE] = {0};
    v2_mock_transport mock = {0};
    cable_handle cable = {0};
    calc_handle handle = {0};
    calc_infos infos = {0};
    calc_prime_protocol_info protocol = {0};
    uint32_t parsed_size = 0;
    int failed = 0;

    report[0] = 0; /* Legacy report sequence. */
    report[1] = CMD_PRIME_GET_INFOS;
    report[2] = 0x03; /* Observed on current G2 firmware. */
    report[6] = INFO_BODY_SIZE;
    report[1 + INFO_PACKET_SIZE - 36] = 0x66;
    report[1 + INFO_PACKET_SIZE - 35] = 0x3D; /* Build 15718. */
    memcpy(report + 1 + INFO_PACKET_SIZE - 32, "V2.060.650", 11);
    memcpy(report + 1 + INFO_PACKET_SIZE - 16, "G2CURRENT", 9);

    handle.model = CALC_PRIME;
    handle.prime = prime_protocol_state_new();
    handle.cable = &cable;
    cable.model = CABLE_PRIME_HID;
    cable.handle = &mock;
    cable.fncts = &mock_fncts;
    cable.report_size = PRIME_RAW_HID_DATA_SIZE_G2;
    cable.open = 1;
    queue_report(&mock, report, sizeof(report));

    failed |= check(calc_prime_r_get_infos(&handle, &infos) == ERR_SUCCESS
                    && infos.size == INFO_PACKET_SIZE
                    && infos.data != NULL && infos.data[1] == 0x03,
                    "accept current G2 marker 03 in legacy GET_INFOS");
    failed |= check(hpcalcs_prime_get_protocol_info(&handle, &protocol)
                    == ERR_SUCCESS && protocol.build == 15718
                    && !protocol.supports_v2,
                    "record current protocol metadata without inferring V2 after marker 03");
    report[1] = CMD_PRIME_RECV_SCREEN;
    failed |= check(prime_data_size(CMD_PRIME_RECV_SCREEN, report + 1,
                                    &parsed_size) == ERR_SUCCESS
                    && parsed_size == INFO_PACKET_SIZE,
                    "accept marker 03 for current legacy-framed replies");

    free(infos.data);
    prime_protocol_state_del(handle.prime);
    return failed;
}

static int test_readonly_commands(void) {
    static const uint8_t png[] = {
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A
    };
    static const uint8_t file_data[] = {0x10, 0x20, 0x30, 0x40, 0x50};
    static const uint8_t uncompressed_file_data[] = {
        0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88
    };
    uint8_t screen_reply[13 + sizeof(png)] = {0};
    uint8_t raw_file[4 + 4 + sizeof(file_data)] = {0};
    uint8_t rebuilt_file[6 + sizeof(raw_file)] = {0};
    uint8_t uncompressed_reply[10 + 4 + sizeof(uncompressed_file_data)] = {0};
    uint8_t compressed[128];
    uLongf compressed_size = sizeof(compressed);
    uint8_t compressed_reply[10 + sizeof(compressed)] = {0};
    uint8_t backup_done[6] = {CMD_PRIME_RECV_BACKUP, 0x02, 0, 0, 0, 0};
    uint8_t *screen = NULL;
    uint32_t screen_size = 0;
    files_var_entry **entries = NULL;
    v2_mock_transport mock = {0};
    cable_handle cable;
    calc_handle handle;
    uint16_t crc;
    uint32_t compressed_reply_size;
    uint32_t sent_before;
    files_var_entry outgoing = {0};
    uint8_t outgoing_data[] = {0xDE, 0xAD, 0xBE, 0xEF};
    uint8_t sent_payload[18];
    int failed = 0;

    failed |= check(prepare_v2_handle(&handle, &cable, &mock) == ERR_SUCCESS,
                    "prepare V2 command handle");

    sent_before = mock.sent_count;
    failed |= check(calc_prime_s_get_infos(&handle) == ERR_CALC_PACKET_FORMAT
                    && mock.sent_count == sent_before,
                    "reject GET_INFOS locally after V2 negotiation");

    queue_ack(&mock, 2, 2);
    failed |= check(calc_prime_s_recv_screen(
                        &handle, CALC_SCREENSHOT_FORMAT_PRIME_PNG_320x240x16)
                    == ERR_SUCCESS,
                    "send V2 screenshot request");
    failed |= check(mock.sent[mock.sent_count - 1][10] == CMD_PRIME_RECV_SCREEN
                    && mock.sent[mock.sent_count - 1][11]
                        == CALC_SCREENSHOT_FORMAT_PRIME_PNG_320x240x16,
                    "V2 screenshot preserves the requested format byte");
    screen_reply[0] = CMD_PRIME_RECV_SCREEN;
    screen_reply[1] = 0x03;
    screen_reply[5] = (uint8_t)(sizeof(screen_reply) - 6);
    screen_reply[8] = CALC_SCREENSHOT_FORMAT_PRIME_PNG_320x240x16;
    memset(screen_reply + 9, 0xFF, 4);
    memcpy(screen_reply + 13, png, sizeof(png));
    crc = test_crc16(screen_reply + 6, sizeof(screen_reply) - 6);
    screen_reply[6] = (uint8_t)(crc >> 8);
    screen_reply[7] = (uint8_t)crc;
    queue_v2_message(&mock, 101, screen_reply, sizeof(screen_reply),
                     PRIME_RAW_HID_DATA_SIZE_LEGACY);
    failed |= check(calc_prime_r_recv_screen(
                        &handle, CALC_SCREENSHOT_FORMAT_PRIME_PNG_320x240x16,
                        &screen, &screen_size) == ERR_SUCCESS
                    && screen_size == sizeof(png)
                    && memcmp(screen, png, sizeof(png)) == 0,
                    "receive V2 screenshot and strip its Prime marker/header");
    free(screen);

    raw_file[0] = PRIME_TYPE_PRGM;
    raw_file[1] = 4;
    raw_file[4] = 'T';
    raw_file[5] = 0;
    raw_file[6] = '1';
    raw_file[7] = 0;
    memcpy(raw_file + 8, file_data, sizeof(file_data));
    rebuilt_file[0] = CMD_PRIME_RECV_FILE;
    rebuilt_file[1] = 0x03;
    rebuilt_file[5] = sizeof(raw_file);
    memcpy(rebuilt_file + 6, raw_file, sizeof(raw_file));
    crc = test_crc16(rebuilt_file, sizeof(rebuilt_file));
    raw_file[2] = (uint8_t)crc;
    raw_file[3] = (uint8_t)(crc >> 8);
    failed |= check(compress2(compressed, &compressed_size, raw_file,
                             sizeof(raw_file), Z_BEST_SPEED) == Z_OK,
                    "create compressed Prime file fixture");
    compressed_reply[0] = CMD_PRIME_RECV_FILE;
    compressed_reply[1] = 0x03;
    compressed_reply_size = 10U + (uint32_t)compressed_size;
    compressed_reply[2] = (uint8_t)((compressed_reply_size - 6U) >> 24);
    compressed_reply[3] = (uint8_t)((compressed_reply_size - 6U) >> 16);
    compressed_reply[4] = (uint8_t)((compressed_reply_size - 6U) >> 8);
    compressed_reply[5] = (uint8_t)(compressed_reply_size - 6U);
    compressed_reply[6] = (uint8_t)sizeof(raw_file);
    compressed_reply[7] = (uint8_t)(sizeof(raw_file) >> 8);
    compressed_reply[8] = (uint8_t)(sizeof(raw_file) >> 16);
    compressed_reply[9] = (uint8_t)(sizeof(raw_file) >> 24);
    memcpy(compressed_reply + 10, compressed, compressed_size);

    uncompressed_reply[0] = CMD_PRIME_RECV_FILE;
    uncompressed_reply[1] = 0x01;
    uncompressed_reply[5] = sizeof(uncompressed_reply) - 6;
    uncompressed_reply[6] = PRIME_TYPE_PRGM;
    uncompressed_reply[7] = 4;
    uncompressed_reply[10] = 'L';
    uncompressed_reply[12] = '1';
    memcpy(uncompressed_reply + 14, uncompressed_file_data,
           sizeof(uncompressed_file_data));
    crc = test_crc16(uncompressed_reply, sizeof(uncompressed_reply) - 6);
    uncompressed_reply[8] = (uint8_t)crc;
    uncompressed_reply[9] = (uint8_t)(crc >> 8);

    queue_ack(&mock, 3, 2);
    failed |= check(calc_prime_s_recv_backup(&handle) == ERR_SUCCESS,
                    "send V2 backup request");
    failed |= check(mock.sent[mock.sent_count - 1][6] == 1
                    && mock.sent[mock.sent_count - 1][10]
                        == CMD_PRIME_RECV_BACKUP,
                    "V2 backup request matches the one-byte CK F9 payload");
    queue_v2_message(&mock, 102, uncompressed_reply,
                     sizeof(uncompressed_reply),
                     PRIME_RAW_HID_DATA_SIZE_LEGACY);
    queue_v2_message(&mock, 103, compressed_reply, compressed_reply_size,
                     PRIME_RAW_HID_DATA_SIZE_LEGACY);
    queue_v2_message(&mock, 104, backup_done, sizeof(backup_done),
                     PRIME_RAW_HID_DATA_SIZE_LEGACY);
    failed |= check(calc_prime_r_recv_backup(&handle, &entries) == ERR_SUCCESS
                    && entries != NULL && entries[0] != NULL
                    && entries[1] != NULL && entries[2] == NULL,
                    "backup receives subtype-1 and compressed files before F9 completion");
    failed |= check(entries != NULL && entries[0] != NULL
                    && !entries[0]->invalid
                    && entries[0]->type == PRIME_TYPE_PRGM
                    && entries[0]->name[0] == 'L' && entries[0]->name[1] == '1'
                    && entries[0]->size == sizeof(uncompressed_file_data)
                    && memcmp(entries[0]->data, uncompressed_file_data,
                              sizeof(uncompressed_file_data)) == 0,
                    "subtype-1 file over V2 uses CRC coverage excluding six trailing bytes");
    failed |= check(entries != NULL && entries[1] != NULL
                    && !entries[1]->invalid,
                    "compressed subtype-3 file uses full reconstructed-packet CRC coverage");
    failed |= check(entries != NULL && entries[1] != NULL
                    && entries[1]->type == PRIME_TYPE_PRGM,
                    "compressed backup file preserves its type");
    failed |= check(entries != NULL && entries[1] != NULL
                    && entries[1]->name[0] == 'T' && entries[1]->name[1] == '1',
                    "compressed backup file preserves its UTF-16LE name");
    failed |= check(entries != NULL && entries[1] != NULL
                    && entries[1]->size == sizeof(file_data),
                    "compressed backup file preserves its uncompressed size");
    failed |= check(entries != NULL && entries[1] != NULL
                    && memcmp(entries[1]->data, file_data, sizeof(file_data)) == 0,
                    "compressed backup file preserves its uncompressed bytes");
    hpfiles_ve_delete_array(entries);

    outgoing.type = PRIME_TYPE_PRGM;
    outgoing.name[0] = 'T';
    outgoing.name[1] = '2';
    outgoing.data = outgoing_data;
    outgoing.size = sizeof(outgoing_data);
    queue_ack(&mock, 4, 14);
    failed |= check(calc_prime_s_recv_file(&handle, &outgoing) == ERR_SUCCESS,
                    "request an individual file through V2 framing");
    failed |= check(mock.sent[mock.sent_count - 1][2] == 4
                    && mock.sent[mock.sent_count - 1][6] == 14
                    && mock.sent[mock.sent_count - 1][10] == CMD_PRIME_REQ_FILE
                    && mock.sent[mock.sent_count - 1][11] == 0x01
                    && mock.sent[mock.sent_count - 1][15] == 8
                    && mock.sent[mock.sent_count - 1][16] == PRIME_TYPE_PRGM
                    && mock.sent[mock.sent_count - 1][17] == 4
                    && mock.sent[mock.sent_count - 1][20] == 'T'
                    && mock.sent[mock.sent_count - 1][21] == 0
                    && mock.sent[mock.sent_count - 1][22] == '2'
                    && mock.sent[mock.sent_count - 1][23] == 0,
                    "V2 individual-file request preserves the F8 01 header, type and UTF-16LE name");

    queue_ack(&mock, 5, sizeof(sent_payload));
    failed |= check(calc_prime_s_send_file(&handle, &outgoing) == ERR_SUCCESS
                    && calc_prime_r_send_file(&handle) == ERR_SUCCESS,
                    "send a file through verified V2 framing");
    memcpy(sent_payload, mock.sent[mock.sent_count - 1] + 10,
           sizeof(sent_payload));
    crc = (uint16_t)sent_payload[8]
        | ((uint16_t)sent_payload[9] << 8);
    sent_payload[8] = 0;
    sent_payload[9] = 0;
    failed |= check(sent_payload[0] == CMD_PRIME_RECV_FILE
                    && sent_payload[1] == 0x03
                    && sent_payload[5] == 12
                    && sent_payload[6] == PRIME_TYPE_PRGM
                    && sent_payload[7] == 4
                    && sent_payload[10] == 'T' && sent_payload[11] == 0
                    && sent_payload[12] == '2' && sent_payload[13] == 0
                    && memcmp(sent_payload + 14, outgoing_data,
                              sizeof(outgoing_data)) == 0,
                    "V2 file payload matches PR #4 compact F7 03 layout");
    failed |= check(crc == test_crc16(sent_payload, sizeof(sent_payload)),
                    "V2 file payload CRC covers the compact message");

    sent_before = mock.sent_count;
    queue_ack(&mock, 6, 7);
    queue_ack(&mock, 7, 16);
    failed |= check(calc_prime_s_send_key(&handle, 23) == ERR_SUCCESS
                    && mock.sent_count == sent_before + 2,
                    "Prime V2 sends a key and display wake message regardless of build");
    failed |= check(mock.sent[sent_before][10] == CMD_PRIME_SEND_KEY
                    && mock.sent[sent_before][11] == 0x03
                    && mock.sent[sent_before][15] == 1
                    && mock.sent[sent_before][16] == 23,
                    "V2 single-key payload uses the EC 03 layout");
    failed |= check(mock.sent[sent_before + 1][10] == CMD_PRIME_SET_DATE_TIME
                    && mock.sent[sent_before + 1][11] == 0x01
                    && mock.sent[sent_before + 1][15] == 10
                    && mock.sent[sent_before + 1][16] == 0
                    && mock.sent[sent_before + 1][17] == 0
                    && mock.sent[sent_before + 1][18] == 0
                    && mock.sent[sent_before + 1][19] == 0,
                    "V2 key wake uses the CK E7 packet with four reserved zero bytes");

    {
        static const uint8_t keys[] = {2, 7, 30};
        sent_before = mock.sent_count;
        queue_ack(&mock, 8, 6 + sizeof(keys));
        queue_ack(&mock, 9, 16);
        failed |= check(calc_prime_s_send_keys(&handle, keys, sizeof(keys))
                        == ERR_SUCCESS
                        && mock.sent_count == sent_before + 2,
                        "Prime V2 sends multiple keys followed by one wake regardless of build");
        failed |= check(mock.sent[sent_before][10] == CMD_PRIME_SEND_KEY
                        && mock.sent[sent_before][11] == 0x03
                        && mock.sent[sent_before][15] == sizeof(keys)
                        && memcmp(mock.sent[sent_before] + 16, keys,
                                  sizeof(keys)) == 0,
                        "V2 multi-key payload uses EC 03 with the exact key bytes");
    }
    failed |= check(calc_prime_s_send_key(&handle, 0x100U)
                    == ERR_INVALID_PARAMETER,
                    "single-key API rejects values that would truncate");
    prime_protocol_state_del(handle.prime);
    return failed;
}

static int test_legacy_command_fallback(void) {
    uint8_t info[108] = {0};
    v2_mock_transport mock = {0};
    cable_handle cable = {0};
    calc_handle handle = {0};
    files_var_entry outgoing = {0};
    uint8_t outgoing_data[] = {0x12, 0x34};
    uint32_t recv_attempts_before;
    int failed = 0;

    handle.model = CALC_PRIME;
    handle.prime = prime_protocol_state_new();
    handle.cable = &cable;
    handle.attached = 1;
    handle.open = 1;
    cable.model = CABLE_PRIME_HID;
    cable.handle = &mock;
    cable.fncts = &mock_fncts;
    cable.report_size = PRIME_RAW_HID_DATA_SIZE_LEGACY;
    cable.read_timeout = 8000;
    cable.open = 1;
    info[sizeof(info) - 36] = 0x66;
    info[sizeof(info) - 35] = 0x3D; /* 15718: shared current G1/G2 build. */
    {
        static const uint8_t invalid_v2_reply[] = {0x00};
        static const uint8_t legacy_ready_reply[] = {
            0x00, CMD_PRIME_CHECK_READY
        };
        queue_report(&mock, invalid_v2_reply, sizeof(invalid_v2_reply));
        queue_report(&mock, legacy_ready_reply,
                     sizeof(legacy_ready_reply));
    }
    failed |= check(prime_protocol_record_infos(&handle, info, sizeof(info))
                    == ERR_SUCCESS
                    && !prime_protocol_supports_v2(&handle)
                    && prime_protocol_negotiate(&handle) == ERR_SUCCESS
                    && prime_protocol_get_version(&handle)
                        == PRIME_PROTOCOL_LEGACY
                    && !prime_protocol_supports_v2(&handle)
                    && mock.sent_count == 3
                    && cable.read_timeout == 8000,
                    "failed V2 round trip dynamically falls back to validated legacy framing");
    failed |= check(mock.sent_sizes[0] == 9
                    && mock.sent[0][1] == 0xFF
                    && mock.sent[0][2] == 0xEC
                    && mock.sent_sizes[1] == 65
                    && mock.sent[1][1] == 0x01
                    && mock.sent[1][10] == 0xFD
                    && mock.sent_sizes[2] == 3
                    && mock.sent[2][2] == CMD_PRIME_CHECK_READY,
                    "fallback decision is based on V2 and legacy wire probes");
    failed |= check(calc_prime_s_get_infos(&handle) == ERR_SUCCESS,
                    "legacy info request remains available without V2");
    failed |= check(mock.sent_count == 4 && mock.sent_sizes[3] == 3
                    && mock.sent[3][0] == 0 && mock.sent[3][1] == 0
                    && mock.sent[3][2] == CMD_PRIME_GET_INFOS,
                    "legacy fallback keeps report ID, sequence and FA payload layout");
    failed |= check(calc_prime_s_set_date_time(&handle, time(NULL))
                    == ERR_SUCCESS,
                    "legacy date-time command remains available");
    failed |= check(mock.sent_count == 5 && mock.sent_sizes[4] == 18
                    && mock.sent[4][0] == 0 && mock.sent[4][1] == 0
                    && mock.sent[4][2] == CMD_PRIME_SET_DATE_TIME
                    && mock.sent[4][3] == 0x01
                    && mock.sent[4][8] == 0 && mock.sent[4][9] == 0
                    && mock.sent[4][10] == 0x54
                    && mock.sent[4][11] == 0x1E,
                    "legacy G1 clock payload preserves the HPLP reserved bytes");
    failed |= check(calc_prime_s_send_key(&handle, 23) == ERR_SUCCESS,
                    "legacy single-key command remains available");
    failed |= check(mock.sent_count == 6 && mock.sent_sizes[5] == 9
                    && mock.sent[5][0] == 0 && mock.sent[5][1] == 0
                    && mock.sent[5][2] == CMD_PRIME_SEND_KEY
                    && mock.sent[5][3] == 0x01
                    && mock.sent[5][4] == 0 && mock.sent[5][5] == 0
                    && mock.sent[5][6] == 0 && mock.sent[5][7] == 1
                    && mock.sent[5][8] == 23,
                    "legacy single-key payload keeps the public EC 01 layout");
    outgoing.type = PRIME_TYPE_MATRIX;
    outgoing.name[0] = 'M';
    outgoing.name[1] = '0';
    outgoing.data = outgoing_data;
    outgoing.size = sizeof(outgoing_data);
    recv_attempts_before = mock.recv_attempts;
    failed |= check(calc_prime_s_send_file(&handle, &outgoing) == ERR_SUCCESS
                    && calc_prime_r_send_file(&handle) == ERR_SUCCESS,
                    "legacy file send completes when the HID write completes");
    failed |= check(mock.recv_attempts == recv_attempts_before,
                    "legacy file send does not wait for a nonexistent reply");
    prime_protocol_state_del(handle.prime);
    return failed;
}

static int prepare_v2_handle_with_report_size(calc_handle *handle,
                                              cable_handle *cable,
                                              v2_mock_transport *mock,
                                              uint32_t report_size) {
    uint8_t info[108] = {0};
    int result;
    memset(handle, 0, sizeof(*handle));
    memset(cable, 0, sizeof(*cable));
    handle->model = CALC_PRIME;
    handle->prime = prime_protocol_state_new();
    handle->cable = cable;
    handle->attached = 1;
    handle->open = 1;
    cable->model = CABLE_PRIME_HID;
    cable->handle = mock;
    cable->fncts = &mock_fncts;
    cable->report_size = report_size;
    cable->read_timeout = 8000;
    cable->open = 1;
    info[sizeof(info) - 36] = 0x01;
    info[sizeof(info) - 35] = 0x00; /* Deliberately below the former gate. */
    if (handle->prime == NULL
        || prime_protocol_record_infos(handle, info, sizeof(info)) != ERR_SUCCESS) {
        return ERR_MALLOC;
    }
    queue_v2_echo_negotiation(mock, cable->report_size);
    result = prime_protocol_negotiate(handle);
    return result;
}

static int prepare_v2_handle(calc_handle *handle, cable_handle *cable,
                             v2_mock_transport *mock) {
    return prepare_v2_handle_with_report_size(
        handle, cable, mock, PRIME_RAW_HID_DATA_SIZE_LEGACY);
}

static int test_dynamic_report_size_negotiation(void) {
    v2_mock_transport mock = {0};
    cable_handle cable;
    calc_handle handle;
    int failed = 0;

    failed |= check(prepare_v2_handle_with_report_size(
                        &handle, &cable, &mock,
                        PRIME_RAW_HID_DATA_SIZE_G2) == ERR_SUCCESS,
                    "1024-byte transport dynamically negotiates V2");
    failed |= check(prime_protocol_supports_v2(&handle)
                    && prime_protocol_get_build(&handle) == 1
                    && mock.sent_count == 3
                    && mock.sent_sizes[1]
                        == PRIME_RAW_HID_DATA_SIZE_G2 + 1
                    && cable.read_timeout == 8000,
                    "1024-byte transport accepts the echoed V2 session probe");
    prime_protocol_state_del(handle.prime);
    return failed;
}

static int test_detailed_v2_negotiation_response(void) {
    uint8_t info[108] = {0};
    v2_mock_transport mock = {0};
    cable_handle cable = {0};
    calc_handle handle = {0};
    int failed = 0;

    handle.model = CALC_PRIME;
    handle.prime = prime_protocol_state_new();
    handle.cable = &cable;
    handle.attached = 1;
    handle.open = 1;
    cable.model = CABLE_PRIME_HID;
    cable.handle = &mock;
    cable.fncts = &mock_fncts;
    cable.report_size = PRIME_RAW_HID_DATA_SIZE_G2;
    cable.read_timeout = 8000;
    cable.open = 1;
    queue_v2_detailed_negotiation(&mock, cable.report_size);

    failed |= check(handle.prime != NULL
                    && prime_protocol_record_infos(&handle, info, sizeof(info))
                        == ERR_SUCCESS
                    && prime_protocol_negotiate(&handle) == ERR_SUCCESS
                    && prime_protocol_supports_v2(&handle),
                    "detailed V2 session response remains accepted");
    prime_protocol_state_del(handle.prime);
    return failed;
}

static int test_message_transport(void) {
    uint8_t payload[70];
    uint8_t ack_bytes[PRIME_V2_ACK_FRAME_SIZE];
    uint8_t nack_bytes[PRIME_V2_ACK_FRAME_SIZE];
    uint32_t frame_size = 0;
    uint32_t message_id = 0;
    prime_v2_ack ack = {1, 0xFF, sizeof(payload), 1};
    prime_v2_ack nack = {0, 2, 55, 1};
    v2_mock_transport mock = {0};
    cable_handle cable;
    calc_handle handle;
    uint32_t i;
    int failed = 0;

    for (i = 0; i < sizeof(payload); i++) {
        payload[i] = (uint8_t)(i + 1);
    }
    failed |= check(prepare_v2_handle(&handle, &cable, &mock) == ERR_SUCCESS,
                    "negotiate V2 on a capable attached Prime");
    failed |= check(mock.sent_count == 3 && mock.sent_sizes[0] == 9
                    && mock.sent[0][0] == 0 && mock.sent[0][1] == 0xFF
                    && mock.sent[0][2] == 0xEC && mock.sent[0][8] == 0,
                    "V2 negotiation sends report ID plus eight-byte FF EC selector");
    failed |= check(mock.sent_sizes[1] == 65
                    && mock.sent[1][1] == 0x01
                    && mock.sent[1][10] == 0xFD
                    && mock.sent[1][11] == 0x01
                    && mock.sent[2][1] == 0xFE
                    && prime_protocol_supports_v2(&handle),
                    "64-byte transport selects V2 only after the session probe reply");

    nack.message_id = 2;
    ack.message_id = 2;
    prime_v2_encode_ack(&nack, nack_bytes, sizeof(nack_bytes), &frame_size);
    queue_report(&mock, nack_bytes, frame_size);
    prime_v2_encode_ack(&ack, ack_bytes, sizeof(ack_bytes), &frame_size);
    queue_report(&mock, ack_bytes, frame_size);

    failed |= check(prime_v2_send_message(&handle, payload, sizeof(payload),
                    &message_id) == ERR_SUCCESS && message_id == 2,
                    "V2 message completes after bounded NACK retransmission and ACK");
    failed |= check(mock.sent_count == 6,
                    "V2 send emits start, continuation, then requested continuation resend");
    failed |= check(mock.sent_sizes[3] == 65 && mock.sent[3][1] == 1
                    && mock.sent[3][2] == 2 && mock.sent[3][6] == sizeof(payload),
                    "start report uses dynamic 64-byte HID payload and nine-byte V2 header");
    failed |= check(mock.sent[4][1] == 2 && mock.sent[5][1] == 2
                    && memcmp(mock.sent[4], mock.sent[5], mock.sent_sizes[4]) == 0,
                    "NACK block position and sequence resend the exact continuation");

    prime_protocol_state_del(handle.prime);
    return failed;
}

static int test_message_receive(void) {
    uint8_t payload[70];
    uint8_t first[PRIME_RAW_HID_DATA_SIZE_LEGACY] = {0};
    uint8_t second[16] = {0};
    uint8_t heartbeat[PRIME_V2_ACK_FRAME_SIZE] = {0xFE, 0x01, 0xFF};
    uint8_t *received = NULL;
    uint32_t received_size = 0;
    uint32_t message_id = 0;
    uint32_t frame_size = 0;
    v2_mock_transport mock = {0};
    cable_handle cable;
    calc_handle handle;
    uint32_t sent_before;
    uint32_t i;
    int failed = 0;

    for (i = 0; i < sizeof(payload); i++) {
        payload[i] = (uint8_t)(0xE0U ^ i);
    }
    failed |= check(prepare_v2_handle(&handle, &cable, &mock) == ERR_SUCCESS,
                    "prepare V2 receive handle");
    sent_before = mock.sent_count;
    prime_v2_encode_content(1, 77, sizeof(payload), payload, 55,
                            first, sizeof(first), &frame_size);
    queue_report(&mock, heartbeat, sizeof(heartbeat));
    queue_report(&mock, first, PRIME_RAW_HID_DATA_SIZE_LEGACY);
    prime_v2_encode_content(2, 0, 0, payload + 55, 15,
                            second, sizeof(second), &frame_size);
    queue_report(&mock, second, frame_size);

    failed |= check(prime_v2_recv_message(&handle, &received, &received_size,
                    &message_id) == ERR_SUCCESS,
                    "V2 receive ignores heartbeat and reassembles message");
    failed |= check(received_size == sizeof(payload) && message_id == 77
                    && received != NULL
                    && memcmp(received, payload, sizeof(payload)) == 0,
                    "V2 receive honors total length instead of trailing HID report bytes");
    failed |= check(mock.sent_count == sent_before + 1
                    && mock.sent_sizes[sent_before] == 65
                    && mock.sent[sent_before][1] == 0xFE
                    && mock.sent[sent_before][2] == 1
                    && mock.sent[sent_before][3] == 2
                    && mock.sent[sent_before][5] == 118
                    && mock.sent[sent_before][9] == 77,
                    "V2 receive ACKs the final sequence and report-capacity position");

    free(received);
    received = NULL;
    received_size = 0;
    for (i = 0; i < 1025; i++) {
        queue_report(&mock, heartbeat, sizeof(heartbeat));
    }
    failed |= check(prime_v2_recv_message(&handle, &received, &received_size,
                    &message_id) == ERR_CALC_PACKET_FORMAT
                    && received == NULL && received_size == 0,
                    "V2 receive bounds a calculator stuck on control frames");

    prime_protocol_state_del(handle.prime);
    return failed;
}

static int test_hybrid_g1_message_receive(void) {
    uint8_t payload[90] = {0};
    uint8_t *received = NULL;
    uint32_t received_size = 0;
    uint32_t message_id = 99;
    v2_mock_transport mock = {0};
    cable_handle cable;
    calc_handle handle;
    uint32_t sent_before;
    uint32_t i;
    int failed = 0;

    payload[0] = CMD_PRIME_RECV_FILE;
    payload[1] = 0x03;
    payload[5] = sizeof(payload) - 6;
    for (i = 6; i < sizeof(payload); i++) {
        payload[i] = (uint8_t)(i * 3U + 1U);
    }
    failed |= check(prepare_v2_handle(&handle, &cable, &mock) == ERR_SUCCESS,
                    "prepare hybrid G1 receive handle");
    sent_before = mock.sent_count;
    queue_legacy_message(&mock, payload, sizeof(payload),
                         PRIME_RAW_HID_DATA_SIZE_LEGACY);
    failed |= check(prime_v2_recv_message(&handle, &received, &received_size,
                    &message_id) == ERR_SUCCESS,
                    "V2 G1 session accepts an observed legacy-framed file message");
    failed |= check(received_size == sizeof(payload) && message_id == 0
                    && received != NULL
                    && memcmp(received, payload, sizeof(payload)) == 0,
                    "hybrid G1 receive preserves the complete virtual packet");
    failed |= check(mock.sent_count == sent_before,
                    "hybrid legacy receive sends no V2 or invented legacy ACK");

    free(received);
    prime_protocol_state_del(handle.prime);
    return failed;
}

static int test_large_message_receive_flow_control(void) {
    enum { PAYLOAD_SIZE = 16350 };
    uint8_t *payload = malloc(PAYLOAD_SIZE);
    uint8_t *received = NULL;
    uint32_t received_size = 0;
    uint32_t message_id = 0;
    v2_mock_transport mock = {0};
    cable_handle cable;
    calc_handle handle;
    prime_v2_ack ack;
    uint32_t sent_before;
    static const uint32_t expected_positions[] = {
        4843, 9694, 14545, 16372
    };
    static const uint8_t expected_sequences[] = {
        0x4E, 0x9B, 0xE8, 0x08
    };
    uint32_t i;
    int failed = 0;

    failed |= check(payload != NULL, "allocate large V2 receive fixture");
    if (payload == NULL) {
        return failed;
    }
    for (i = 0; i < PAYLOAD_SIZE; i++) {
        payload[i] = (uint8_t)(i * 17U + 3U);
    }
    failed |= check(prepare_v2_handle(&handle, &cable, &mock) == ERR_SUCCESS,
                    "prepare large V2 receive handle");
    sent_before = mock.sent_count;
    queue_v2_message(&mock, 91, payload, PAYLOAD_SIZE,
                     PRIME_RAW_HID_DATA_SIZE_LEGACY);
    failed |= check(prime_v2_recv_message(&handle, &received, &received_size,
                    &message_id) == ERR_SUCCESS,
                    "large V2 receive completes across periodic ACK windows");
    failed |= check(received_size == PAYLOAD_SIZE && message_id == 91
                    && received != NULL
                    && memcmp(received, payload, PAYLOAD_SIZE) == 0,
                    "large V2 receive preserves payload across sequence wrap");
    failed |= check(mock.sent_count == sent_before + 4,
                    "large V2 receive emits three window ACKs and one final ACK");
    for (i = 0; i < 4 && mock.sent_count >= sent_before + 4; i++) {
        failed |= check(prime_v2_decode_ack(mock.sent[sent_before + i] + 1,
                        mock.sent_sizes[sent_before + i] - 1, &ack) == ERR_SUCCESS
                        && ack.is_ack && ack.message_id == 91
                        && ack.sequence_to_resend == expected_sequences[i]
                        && ack.block_position == expected_positions[i],
                        "large V2 ACK matches CK sequence and capacity position");
    }

    free(received);
    free(payload);
    prime_protocol_state_del(handle.prime);
    return failed;
}

int main(void) {
    int failed = 0;
    failed |= test_content_frames();
    failed |= test_ack_frames();
    failed |= test_prime_file_extensions();
    failed |= test_info_state();
    failed |= test_modern_legacy_headers();
    failed |= test_dynamic_report_size_negotiation();
    failed |= test_detailed_v2_negotiation_response();
    failed |= test_message_transport();
    failed |= test_message_receive();
    failed |= test_hybrid_g1_message_receive();
    failed |= test_large_message_receive_flow_control();
    failed |= test_readonly_commands();
    failed |= test_legacy_command_fallback();
    if (!failed) {
        puts("HP Prime V2 protocol tests passed");
    }
    return failed ? EXIT_FAILURE : EXIT_SUCCESS;
}
