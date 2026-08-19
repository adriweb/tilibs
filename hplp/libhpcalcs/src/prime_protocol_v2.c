/*
 * HP Prime modern (V2) message framing.
 *
 * The calculator first answers GET_INFOS over the legacy protocol, then this
 * module selects the session protocol through on-wire V2 and legacy probes.
 * Device IDs, HID report sizes and firmware versions are deliberately not
 * used as capability signals.  V3 is intentionally not represented until its
 * behavior is proven.
 */

#ifdef HAVE_CONFIG_H
# include <config.h>
#endif

#include <inttypes.h>
#include <stdint.h>
#include <string.h>

#include "error.h"
#include "logging.h"
#include "prime_protocol_v2.h"
#include "prime_cmd.h"
#include "internal.h"

struct _prime_protocol_state {
    uint32_t build;
    uint32_t next_message_id;
    uint8_t version;
    uint8_t supports_v2;
    char firmware_version[17];
    char serial[17];
};

#define PRIME_V2_MAX_RETRIES 3U
#define PRIME_V2_MAX_CONTROL_FRAMES 1024U
#define PRIME_V2_ACK_REPORT_WINDOW 77U
#define PRIME_PROTOCOL_PROBE_TIMEOUT_MS 1500

static int prime_v2_send_message_with_retries(calc_handle *handle,
                                               const uint8_t *data,
                                               uint32_t size,
                                               uint32_t *out_message_id,
                                               uint32_t max_retries);

static int prime_v2_recv_legacy_message(calc_handle *handle,
                                         const prime_raw_hid_pkt *first,
                                         uint8_t **out_data,
                                         uint32_t *out_size);

static uint32_t read_le32(const uint8_t *data) {
    return ((uint32_t)data[0])
        | ((uint32_t)data[1] << 8)
        | ((uint32_t)data[2] << 16)
        | ((uint32_t)data[3] << 24);
}

static void write_le32(uint8_t *data, uint32_t value) {
    data[0] = (uint8_t)value;
    data[1] = (uint8_t)(value >> 8);
    data[2] = (uint8_t)(value >> 16);
    data[3] = (uint8_t)(value >> 24);
}

prime_protocol_state *prime_protocol_state_new(void) {
    prime_protocol_state *state = (prime_protocol_state *)
        (hpcalcs_alloc_funcs.calloc)(1, sizeof(*state));
    if (state != NULL) {
        state->version = PRIME_PROTOCOL_LEGACY;
        state->next_message_id = 1;
    }
    return state;
}

void prime_protocol_state_del(prime_protocol_state *state) {
    (hpcalcs_alloc_funcs.free)(state);
}

int prime_protocol_record_infos(calc_handle *handle, const uint8_t *data, uint32_t size) {
    uint32_t build;
    if (handle == NULL || handle->prime == NULL || data == NULL) {
        return ERR_INVALID_PARAMETER;
    }

    /* GET_INFOS is returned as a six-byte legacy header followed by the info
     * body.  In known modern firmware the LE build number is 36 bytes from
     * the end of the complete virtual packet (before version and serial). */
    if (size < 42) {
        hpcalcs_warning("%s: GET_INFOS packet is too short (%u bytes)",
                        __FUNCTION__, (unsigned int)size);
        return ERR_CALC_PACKET_FORMAT;
    }
    build = (uint32_t)data[size - 36]
        | ((uint32_t)data[size - 35] << 8);
    handle->prime->build = build;
    /* V2 support is established only by a successful session negotiation.
     * GET_INFOS metadata is shared by multiple hardware generations and is
     * not a protocol capability advertisement. */
    handle->prime->supports_v2 = 0;
    memcpy(handle->prime->firmware_version, data + size - 32, 16);
    handle->prime->firmware_version[16] = '\0';
    memcpy(handle->prime->serial, data + size - 16, 16);
    handle->prime->serial[16] = '\0';
    hpcalcs_info("%s: Prime build=%u; protocol not negotiated yet",
                 __FUNCTION__, (unsigned int)build);
    return ERR_SUCCESS;
}

int prime_protocol_get_info(const calc_handle *handle,
                            calc_prime_protocol_info *info) {
    if (handle == NULL || handle->prime == NULL || info == NULL) {
        return ERR_INVALID_PARAMETER;
    }
    memset(info, 0, sizeof(*info));
    info->build = handle->prime->build;
    info->protocol_version = handle->prime->version;
    info->supports_v2 = handle->prime->supports_v2;
    memcpy(info->version, handle->prime->firmware_version,
           sizeof(info->version));
    memcpy(info->serial, handle->prime->serial, sizeof(info->serial));
    return ERR_SUCCESS;
}

uint32_t prime_protocol_get_build(const calc_handle *handle) {
    return handle != NULL && handle->prime != NULL ? handle->prime->build : 0;
}

uint8_t prime_protocol_get_version(const calc_handle *handle) {
    return handle != NULL && handle->prime != NULL
        ? handle->prime->version : PRIME_PROTOCOL_LEGACY;
}

int prime_protocol_supports_v2(const calc_handle *handle) {
    return handle != NULL && handle->prime != NULL
        ? handle->prime->supports_v2 : 0;
}

uint32_t prime_protocol_next_message_id(calc_handle *handle) {
    uint32_t result;
    if (handle == NULL || handle->prime == NULL) {
        return 0;
    }
    result = handle->prime->next_message_id++;
    if (handle->prime->next_message_id == 0) {
        handle->prime->next_message_id = 1;
    }
    return result;
}

static int prime_protocol_probe_legacy(calc_handle *handle) {
    prime_vtl_pkt *request;
    prime_vtl_pkt *reply;
    int res;

    request = prime_vtl_pkt_new(1);
    if (request == NULL) {
        return ERR_MALLOC;
    }
    request->cmd = CMD_PRIME_CHECK_READY;
    request->data[0] = CMD_PRIME_CHECK_READY;
    res = prime_send_data(handle, request);
    prime_vtl_pkt_del(request);
    if (res != ERR_SUCCESS) {
        return res;
    }

    reply = prime_vtl_pkt_new(0);
    if (reply == NULL) {
        return ERR_MALLOC;
    }
    reply->cmd = CMD_PRIME_CHECK_READY;
    res = prime_recv_data(handle, reply);
    if (res == ERR_SUCCESS
        && (reply->size != 1 || reply->data == NULL
            || reply->data[0] != CMD_PRIME_CHECK_READY)) {
        res = ERR_CALC_PACKET_FORMAT;
    }
    prime_vtl_pkt_del(reply);
    return res;
}

static int prime_protocol_probe_v2(calc_handle *handle) {
    static const uint8_t request[] = {
        0xFD, 0x01, 0x00, 0x00, 0x00, 0x01, 0x03
    };
    static const uint8_t response_prefix[] = {
        0xFD, 0x03, 0x00, 0x00, 0x00, 0x01, 0x03
    };
    uint8_t *response = NULL;
    uint32_t response_size = 0;
    uint32_t response_id = 0;
    int res;

    res = prime_v2_send_message_with_retries(handle, request,
                                              sizeof(request), NULL, 0);
    if (res == ERR_SUCCESS) {
        res = prime_v2_recv_message(handle, &response, &response_size,
                                    &response_id);
    }
    if (res == ERR_SUCCESS
        && (response_id == 0
            /* Current G2 firmware echoes the seven-byte FD 01 request,
             * while other observed sessions return the longer FD 03
             * information response.  Either valid V2 message proves that
             * the protocol selector took effect. */
            || !((response_size == sizeof(request)
                  && memcmp(response, request, sizeof(request)) == 0)
                 || (response_size >= sizeof(response_prefix)
                     && memcmp(response, response_prefix,
                               sizeof(response_prefix)) == 0)))) {
        res = ERR_CALC_PACKET_FORMAT;
    }
    (hpcalcs_alloc_funcs.free)(response);
    return res;
}

int prime_protocol_negotiate(calc_handle *handle) {
    prime_raw_hid_pkt raw;
    int original_timeout;
    int shortened_timeout = 0;
    int v2_res;
    int res;
    if (handle == NULL || handle->prime == NULL) {
        return ERR_INVALID_HANDLE;
    }
    if (handle->cable == NULL || !handle->open || !handle->attached) {
        return ERR_CALC_NO_CABLE;
    }
    if (handle->prime->version == PRIME_PROTOCOL_V2) {
        return ERR_SUCCESS;
    }

    original_timeout = hpcables_options_get_read_timeout(handle->cable);
    if (original_timeout > PRIME_PROTOCOL_PROBE_TIMEOUT_MS
        && hpcables_options_set_read_timeout(
            handle->cable, PRIME_PROTOCOL_PROBE_TIMEOUT_MS) == ERR_SUCCESS) {
        shortened_timeout = 1;
    }

    /* Report ID 0 is passed to HIDAPI/WebHID separately from the eight-byte
     * FF EC protocol-selection payload.  The final zero explicitly selects
     * V2; V3 is not enabled by this implementation. */
    memset(&raw, 0, sizeof(raw));
    raw.size = 9;
    raw.data[1] = 0xFF;
    raw.data[2] = 0xEC;
    res = prime_send(handle, &raw);
    if (res != ERR_SUCCESS) {
        if (shortened_timeout) {
            (void)hpcables_options_set_read_timeout(handle->cable,
                                                    original_timeout);
        }
        return res;
    }

    /* The selector itself has no reply.  Confirm the selected framing with
     * the same V2 session-information round trip used by Connectivity Kit. */
    handle->prime->version = PRIME_PROTOCOL_V2;
    v2_res = prime_protocol_probe_v2(handle);
    if (v2_res == ERR_SUCCESS) {
        handle->prime->supports_v2 = 1;
        hpcalcs_info("%s: negotiated Prime protocol V2 over %u-byte HID reports",
                     __FUNCTION__, (unsigned int)
                     hpcables_options_get_report_size(handle->cable));
        if (shortened_timeout) {
            (void)hpcables_options_set_read_timeout(handle->cable,
                                                    original_timeout);
        }
        return ERR_SUCCESS;
    }

    /* An unsupported selector leaves a legacy calculator in legacy framing.
     * Prove that state with a normal command instead of inferring it from
     * device metadata.  If neither probe works, fail rather than continuing
     * with a protocol state that may disagree with the calculator. */
    prime_protocol_reset_legacy(handle);
    res = prime_protocol_probe_legacy(handle);
    if (res == ERR_SUCCESS) {
        hpcalcs_info("%s: V2 probe failed; negotiated legacy Prime protocol",
                     __FUNCTION__);
        if (shortened_timeout) {
            (void)hpcables_options_set_read_timeout(handle->cable,
                                                    original_timeout);
        }
        return ERR_SUCCESS;
    }
    if (shortened_timeout) {
        (void)hpcables_options_set_read_timeout(handle->cable,
                                                original_timeout);
    }
    hpcalcs_error("%s: neither V2 nor legacy protocol probe succeeded",
                  __FUNCTION__);
    return v2_res != ERR_SUCCESS ? v2_res : res;
}

void prime_protocol_reset_legacy(calc_handle *handle) {
    if (handle != NULL && handle->prime != NULL) {
        handle->prime->version = PRIME_PROTOCOL_LEGACY;
        handle->prime->supports_v2 = 0;
        handle->prime->next_message_id = 1;
    }
}

uint8_t prime_v2_next_sequence(uint8_t sequence) {
    if (sequence < PRIME_V2_SEQUENCE_FIRST
        || sequence >= PRIME_V2_SEQUENCE_LAST) {
        return PRIME_V2_SEQUENCE_FIRST + 1;
    }
    return sequence + 1;
}

int prime_v2_encode_content(uint8_t sequence, uint32_t message_id,
                            uint32_t total_size, const uint8_t *data,
                            uint32_t data_size, uint8_t *out,
                            uint32_t capacity, uint32_t *out_size) {
    uint32_t header_size;
    if (out == NULL || out_size == NULL || (data == NULL && data_size != 0)) {
        return ERR_INVALID_PARAMETER;
    }
    if (sequence < PRIME_V2_SEQUENCE_FIRST
        || sequence > PRIME_V2_SEQUENCE_LAST) {
        return ERR_CALC_PACKET_FORMAT;
    }
    header_size = sequence == PRIME_V2_SEQUENCE_FIRST
        ? PRIME_V2_START_HEADER_SIZE : PRIME_V2_CONT_HEADER_SIZE;
    if (capacity < header_size || data_size > capacity - header_size) {
        return ERR_CALC_PACKET_FORMAT;
    }
    if (sequence == PRIME_V2_SEQUENCE_FIRST
        && (message_id == 0 || data_size > total_size)) {
        return ERR_CALC_PACKET_FORMAT;
    }

    out[0] = sequence;
    if (sequence == PRIME_V2_SEQUENCE_FIRST) {
        write_le32(out + 1, message_id);
        write_le32(out + 5, total_size);
    }
    if (data_size != 0) {
        memcpy(out + header_size, data, data_size);
    }
    *out_size = header_size + data_size;
    return ERR_SUCCESS;
}

int prime_v2_decode_content(const uint8_t *data, uint32_t size,
                            prime_v2_content *frame) {
    uint32_t header_size;
    if (data == NULL || frame == NULL || size < PRIME_V2_CONT_HEADER_SIZE) {
        return ERR_INVALID_PARAMETER;
    }
    if (data[0] < PRIME_V2_SEQUENCE_FIRST
        || data[0] > PRIME_V2_SEQUENCE_LAST) {
        return ERR_CALC_PACKET_FORMAT;
    }
    memset(frame, 0, sizeof(*frame));
    frame->sequence = data[0];
    frame->is_start = data[0] == PRIME_V2_SEQUENCE_FIRST;
    header_size = frame->is_start
        ? PRIME_V2_START_HEADER_SIZE : PRIME_V2_CONT_HEADER_SIZE;
    if (size < header_size) {
        return ERR_CALC_PACKET_FORMAT;
    }
    if (frame->is_start) {
        frame->message_id = read_le32(data + 1);
        frame->total_size = read_le32(data + 5);
        if (frame->message_id == 0) {
            return ERR_CALC_PACKET_FORMAT;
        }
    }
    frame->data = data + header_size;
    frame->data_size = size - header_size;
    return ERR_SUCCESS;
}

int prime_v2_encode_ack(const prime_v2_ack *ack, uint8_t *out,
                        uint32_t capacity, uint32_t *out_size) {
    if (ack == NULL || out == NULL || out_size == NULL) {
        return ERR_INVALID_PARAMETER;
    }
    if (capacity < PRIME_V2_ACK_FRAME_SIZE || ack->message_id == 0
        || ack->sequence_to_resend == PRIME_V2_SEQUENCE_OOB) {
        return ERR_CALC_PACKET_FORMAT;
    }
    out[0] = PRIME_V2_SEQUENCE_OOB;
    out[1] = ack->is_ack ? 1 : 0;
    out[2] = ack->sequence_to_resend;
    out[3] = 0;
    write_le32(out + 4, ack->block_position);
    write_le32(out + 8, ack->message_id);
    *out_size = PRIME_V2_ACK_FRAME_SIZE;
    return ERR_SUCCESS;
}

int prime_v2_decode_ack(const uint8_t *data, uint32_t size,
                        prime_v2_ack *ack) {
    if (data == NULL || ack == NULL) {
        return ERR_INVALID_PARAMETER;
    }
    if (size < PRIME_V2_ACK_FRAME_SIZE || data[0] != PRIME_V2_SEQUENCE_OOB
        || data[1] > 1 || data[3] != 0) {
        return ERR_CALC_PACKET_FORMAT;
    }
    ack->is_ack = data[1];
    ack->sequence_to_resend = data[2];
    ack->block_position = read_le32(data + 4);
    ack->message_id = read_le32(data + 8);
    if (ack->message_id == 0) {
        return ERR_CALC_PACKET_FORMAT;
    }
    /* Cyrille's protocol description explicitly states that the sequence
     * byte has no meaning for ACK.  Validate it only for a NACK. */
    if (!ack->is_ack
        && (ack->sequence_to_resend < PRIME_V2_SEQUENCE_FIRST
            || ack->sequence_to_resend > PRIME_V2_SEQUENCE_LAST)) {
        return ERR_CALC_PACKET_FORMAT;
    }
    return ERR_SUCCESS;
}

int prime_v2_is_heartbeat(const uint8_t *data, uint32_t size) {
    if (data == NULL || size < 3
        || data[0] != PRIME_V2_SEQUENCE_OOB
        || data[1] != 1
        || data[2] != PRIME_V2_SEQUENCE_HEARTBEAT) {
        return 0;
    }
    /* A real ACK may also use FF in the semantically-unused sequence field.
     * The observed heartbeat has no associated IO message ID. */
    return size < PRIME_V2_ACK_FRAME_SIZE || read_le32(data + 8) == 0;
}

static int prime_v2_send_frame(calc_handle *handle, const uint8_t *frame,
                               uint32_t frame_size) {
    prime_raw_hid_pkt raw;
    if (handle == NULL || frame == NULL
        || frame_size > PRIME_RAW_HID_DATA_SIZE_MAX) {
        return ERR_INVALID_PARAMETER;
    }
    memset(&raw, 0, sizeof(raw));
    raw.size = hpcables_options_get_report_size(handle->cable) + 1U;
    if (raw.size <= frame_size || raw.size > sizeof(raw.data)) {
        return ERR_CALC_PACKET_FORMAT;
    }
    memcpy(raw.data + 1, frame, frame_size);
    return prime_send(handle, &raw);
}

static int prime_v2_send_frames_from(calc_handle *handle, uint32_t message_id,
                                     const uint8_t *data, uint32_t size,
                                     uint32_t offset, uint8_t sequence) {
    uint32_t report_size;
    int first = offset == 0;
    int sent_any = 0;
    if (handle == NULL || handle->cable == NULL || offset > size
        || (data == NULL && size != 0)) {
        return ERR_INVALID_PARAMETER;
    }
    report_size = hpcables_options_get_report_size(handle->cable);
    if (report_size < PRIME_V2_START_HEADER_SIZE
        || report_size > PRIME_RAW_HID_DATA_SIZE_MAX) {
        return ERR_CALC_PACKET_FORMAT;
    }
    if ((first && sequence != PRIME_V2_SEQUENCE_FIRST)
        || (!first && (sequence < 2 || sequence > PRIME_V2_SEQUENCE_LAST))) {
        return ERR_CALC_PACKET_FORMAT;
    }

    do {
        uint8_t frame[PRIME_RAW_HID_DATA_SIZE_MAX];
        uint32_t header_size = first
            ? PRIME_V2_START_HEADER_SIZE : PRIME_V2_CONT_HEADER_SIZE;
        uint32_t available = report_size - header_size;
        uint32_t remaining = size - offset;
        uint32_t chunk_size = remaining < available ? remaining : available;
        uint32_t frame_size = 0;
        int res = prime_v2_encode_content(sequence, message_id, size,
                                          data != NULL ? data + offset : NULL,
                                          chunk_size, frame, report_size,
                                          &frame_size);
        if (res != ERR_SUCCESS) {
            return res;
        }
        res = prime_v2_send_frame(handle, frame, frame_size);
        if (res != ERR_SUCCESS) {
            return res;
        }
        sent_any = 1;
        offset += chunk_size;
        sequence = prime_v2_next_sequence(sequence);
        first = 0;
    } while (offset < size || !sent_any);
    return ERR_SUCCESS;
}

static int prime_v2_send_ack_frame(calc_handle *handle, int is_ack,
                                   uint8_t sequence, uint32_t position,
                                   uint32_t message_id) {
    prime_v2_ack ack;
    uint8_t frame[PRIME_V2_ACK_FRAME_SIZE];
    uint32_t frame_size = 0;
    int res;
    ack.is_ack = is_ack ? 1 : 0;
    ack.sequence_to_resend = sequence;
    ack.block_position = position;
    ack.message_id = message_id;
    res = prime_v2_encode_ack(&ack, frame, sizeof(frame), &frame_size);
    return res == ERR_SUCCESS
        ? prime_v2_send_frame(handle, frame, frame_size) : res;
}

static int prime_v2_send_message_with_retries(calc_handle *handle,
                                               const uint8_t *data,
                                               uint32_t size,
                                               uint32_t *out_message_id,
                                               uint32_t max_retries) {
    uint32_t message_id;
    uint32_t retries = 0;
    uint32_t controls = 0;
    int res;
    if (handle == NULL || handle->prime == NULL
        || (data == NULL && size != 0)) {
        return ERR_INVALID_PARAMETER;
    }
    if (handle->prime->version != PRIME_PROTOCOL_V2
        || size > PRIME_V2_MAX_MESSAGE_SIZE) {
        return ERR_CALC_PACKET_FORMAT;
    }
    message_id = prime_protocol_next_message_id(handle);
    if (message_id == 0) {
        return ERR_INVALID_HANDLE;
    }
    if (out_message_id != NULL) {
        *out_message_id = message_id;
    }

    res = prime_v2_send_frames_from(handle, message_id, data, size, 0,
                                    PRIME_V2_SEQUENCE_FIRST);
    if (res != ERR_SUCCESS) {
        return res;
    }

    while (controls++ < PRIME_V2_MAX_CONTROL_FRAMES) {
        prime_raw_hid_pkt raw;
        prime_v2_ack ack;
        memset(&raw, 0, sizeof(raw));
        res = prime_recv(handle, &raw);
        if (res != ERR_SUCCESS) {
            if (++retries > max_retries) {
                return res;
            }
            res = prime_v2_send_frames_from(handle, message_id, data, size, 0,
                                            PRIME_V2_SEQUENCE_FIRST);
            if (res != ERR_SUCCESS) {
                return res;
            }
            continue;
        }
        if (prime_v2_is_heartbeat(raw.data, raw.size)) {
            continue;
        }
        res = prime_v2_decode_ack(raw.data, raw.size, &ack);
        if (res != ERR_SUCCESS) {
            hpcalcs_error("%s: expected ACK/NACK control frame", __FUNCTION__);
            return res;
        }
        if (ack.message_id != message_id) {
            hpcalcs_warning("%s: ignoring ACK for message %u while waiting for %u",
                            __FUNCTION__, (unsigned int)ack.message_id,
                            (unsigned int)message_id);
            continue;
        }
        if (ack.is_ack) {
            return ERR_SUCCESS;
        }
        if (++retries > max_retries || ack.block_position > size) {
            return ERR_CALC_PACKET_FORMAT;
        }
        res = prime_v2_send_frames_from(handle, message_id, data, size,
                                        ack.block_position,
                                        ack.sequence_to_resend);
        if (res != ERR_SUCCESS) {
            return res;
        }
    }
    return ERR_CALC_PACKET_FORMAT;
}

/* Current G1 firmware accepts the V2 selector and uses V2 framing for the
 * session probe and the beginning of a backup, but can continue that same
 * backup with ordinary sequence-zero legacy reports.  Reassemble such a
 * message from the already-consumed first report.  G2 remains on the normal
 * V2 path, and this fallback never sends legacy ACK/NAK control traffic. */
static int prime_v2_recv_legacy_message(calc_handle *handle,
                                         const prime_raw_hid_pkt *first,
                                         uint8_t **out_data,
                                         uint32_t *out_size) {
    uint8_t *message;
    uint32_t total_size = 0;
    uint32_t offset;
    uint32_t report_index = 1;
    uint32_t copy_size;
    int res;

    if (handle == NULL || first == NULL || out_data == NULL || out_size == NULL
        || first->size < 7 || first->data[0] != 0) {
        return ERR_CALC_PACKET_FORMAT;
    }
    res = prime_data_size(first->data[1], (uint8_t *)first->data + 1,
                          &total_size);
    if (res != ERR_SUCCESS || total_size == 0
        || total_size > PRIME_V2_MAX_MESSAGE_SIZE) {
        return res != ERR_SUCCESS ? res : ERR_CALC_PACKET_FORMAT;
    }
    message = (uint8_t *)(hpcalcs_alloc_funcs.malloc)(total_size);
    if (message == NULL) {
        return ERR_MALLOC;
    }
    copy_size = first->size - 1;
    if (copy_size > total_size) {
        copy_size = total_size;
    }
    memcpy(message, first->data + 1, copy_size);
    offset = copy_size;

    while (offset < total_size) {
        prime_raw_hid_pkt raw;
        uint8_t expected_sequence = (uint8_t)(
            (report_index + (report_index / 0xFFU)) & 0xFFU);
        memset(&raw, 0, sizeof(raw));
        res = prime_recv(handle, &raw);
        if (res != ERR_SUCCESS) {
            (hpcalcs_alloc_funcs.free)(message);
            return res;
        }
        if (raw.size == 0 || raw.data[0] != expected_sequence) {
            hpcalcs_error("%s: hybrid legacy packet out of sequence at report %" PRIu32
                          ", got %u, expected %u",
                          __FUNCTION__, report_index,
                          raw.size != 0 ? (unsigned int)raw.data[0] : 0,
                          (unsigned int)expected_sequence);
            (hpcalcs_alloc_funcs.free)(message);
            return ERR_CALC_PACKET_FORMAT;
        }
        copy_size = raw.size - 1;
        if (copy_size > total_size - offset) {
            copy_size = total_size - offset;
        }
        memcpy(message + offset, raw.data + 1, copy_size);
        offset += copy_size;
        report_index++;
    }

    *out_data = message;
    *out_size = total_size;
    hpcalcs_info("%s: received legacy-framed message inside a V2 G1 session",
                 __FUNCTION__);
    return ERR_SUCCESS;
}

int prime_v2_send_message(calc_handle *handle, const uint8_t *data,
                          uint32_t size, uint32_t *out_message_id) {
    return prime_v2_send_message_with_retries(handle, data, size,
                                              out_message_id,
                                              PRIME_V2_MAX_RETRIES);
}

int prime_v2_recv_message(calc_handle *handle, uint8_t **out_data,
                          uint32_t *out_size, uint32_t *out_message_id) {
    uint8_t *message = NULL;
    uint32_t message_id = 0;
    uint32_t total_size = 0;
    uint32_t offset = 0;
    uint32_t ack_position = 0;
    uint32_t reports_since_ack = 0;
    uint32_t retries = 0;
    uint32_t controls = 0;
    uint8_t expected_sequence = PRIME_V2_SEQUENCE_FIRST;
    int started = 0;
    int res;
    if (handle == NULL || handle->prime == NULL
        || out_data == NULL || out_size == NULL) {
        return ERR_INVALID_PARAMETER;
    }
    if (handle->prime->version != PRIME_PROTOCOL_V2) {
        return ERR_CALC_PACKET_FORMAT;
    }
    *out_data = NULL;
    *out_size = 0;
    if (out_message_id != NULL) {
        *out_message_id = 0;
    }

    for (;;) {
        prime_raw_hid_pkt raw;
        prime_v2_content frame;
        uint32_t frame_capacity;
        uint32_t report_size;
        uint32_t copy_size;
        memset(&raw, 0, sizeof(raw));
        res = prime_recv(handle, &raw);
        if (res != ERR_SUCCESS) {
            if (!started || ++retries > PRIME_V2_MAX_RETRIES) {
                break;
            }
            res = prime_v2_send_ack_frame(handle, 0, expected_sequence,
                                          offset, message_id);
            if (res != ERR_SUCCESS) {
                break;
            }
            continue;
        }
        if (prime_v2_is_heartbeat(raw.data, raw.size)) {
            if (++controls > PRIME_V2_MAX_CONTROL_FRAMES) {
                res = ERR_CALC_PACKET_FORMAT;
                hpcalcs_error("%s: too many consecutive V2 control frames",
                              __FUNCTION__);
                break;
            }
            continue;
        }
        if (raw.size != 0 && raw.data[0] == PRIME_V2_SEQUENCE_OOB) {
            /* A delayed control frame can remain queued after a request. */
            if (++controls > PRIME_V2_MAX_CONTROL_FRAMES) {
                res = ERR_CALC_PACKET_FORMAT;
                hpcalcs_error("%s: too many consecutive V2 control frames",
                              __FUNCTION__);
                break;
            }
            continue;
        }
        if (!started && raw.size != 0 && raw.data[0] == 0) {
            return prime_v2_recv_legacy_message(handle, &raw,
                                                out_data, out_size);
        }
        res = prime_v2_decode_content(raw.data, raw.size, &frame);
        if (res != ERR_SUCCESS) {
            break;
        }
        controls = 0;
        if (!started) {
            if (!frame.is_start || frame.total_size > PRIME_V2_MAX_MESSAGE_SIZE) {
                res = ERR_CALC_PACKET_FORMAT;
                break;
            }
            total_size = frame.total_size;
            message_id = frame.message_id;
            if (total_size != 0) {
                message = (uint8_t *)(hpcalcs_alloc_funcs.malloc)(total_size);
                if (message == NULL) {
                    res = ERR_MALLOC;
                    break;
                }
            }
            started = 1;
        }
        if (frame.sequence != expected_sequence || (frame.is_start && offset != 0)) {
            if (++retries > PRIME_V2_MAX_RETRIES) {
                res = ERR_CALC_PACKET_FORMAT;
                break;
            }
            res = prime_v2_send_ack_frame(handle, 0, expected_sequence,
                                          offset, message_id);
            if (res != ERR_SUCCESS) {
                break;
            }
            continue;
        }

        report_size = hpcables_options_get_report_size(handle->cable);
        frame_capacity = frame.is_start
            ? report_size - PRIME_V2_START_HEADER_SIZE
            : report_size - PRIME_V2_CONT_HEADER_SIZE;
        if (report_size < PRIME_V2_START_HEADER_SIZE
            || ack_position > UINT32_MAX - frame_capacity) {
            res = ERR_CALC_PACKET_FORMAT;
            break;
        }

        copy_size = frame.data_size;
        if (copy_size > total_size - offset) {
            copy_size = total_size - offset;
        }
        if (copy_size != 0) {
            memcpy(message + offset, frame.data, copy_size);
        }
        offset += copy_size;
        ack_position += frame_capacity;
        reports_since_ack++;
        expected_sequence = prime_v2_next_sequence(expected_sequence);
        retries = 0;
        if (offset == total_size) {
            res = prime_v2_send_ack_frame(handle, 1,
                                          frame.sequence,
                                          ack_position, message_id);
            if (res == ERR_SUCCESS) {
                *out_data = message;
                *out_size = total_size;
                if (out_message_id != NULL) {
                    *out_message_id = message_id;
                }
                return ERR_SUCCESS;
            }
            break;
        }
        if (reports_since_ack == PRIME_V2_ACK_REPORT_WINDOW) {
            /* The G2 sender pauses periodically until the receiver confirms
             * the next sequence and the full report-capacity position. */
            res = prime_v2_send_ack_frame(handle, 1, expected_sequence,
                                          ack_position, message_id);
            if (res != ERR_SUCCESS) {
                break;
            }
            reports_since_ack = 0;
        }
    }

    (hpcalcs_alloc_funcs.free)(message);
    return res;
}
