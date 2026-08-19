/* HP Prime modern (V2) message framing and negotiation state. */

#ifndef __HPLIBS_PRIME_PROTOCOL_V2_H__
#define __HPLIBS_PRIME_PROTOCOL_V2_H__

#include <stdint.h>

#include "hpcalcs.h"

#define PRIME_PROTOCOL_LEGACY 1
#define PRIME_PROTOCOL_V2 2
#define PRIME_V2_ACK_FRAME_SIZE 12U
#define PRIME_V2_START_HEADER_SIZE 9U
#define PRIME_V2_CONT_HEADER_SIZE 1U
#define PRIME_V2_SEQUENCE_FIRST 1U
#define PRIME_V2_SEQUENCE_LAST 0xFDU
#define PRIME_V2_SEQUENCE_OOB 0xFEU
#define PRIME_V2_SEQUENCE_HEARTBEAT 0xFFU
#define PRIME_V2_MAX_MESSAGE_SIZE (64U * 1024U * 1024U)

typedef struct {
    uint8_t is_ack;
    uint8_t sequence_to_resend;
    uint32_t block_position;
    uint32_t message_id;
} prime_v2_ack;

typedef struct {
    uint8_t sequence;
    uint8_t is_start;
    uint32_t message_id;
    uint32_t total_size;
    const uint8_t *data;
    uint32_t data_size;
} prime_v2_content;

prime_protocol_state *prime_protocol_state_new(void);
void prime_protocol_state_del(prime_protocol_state *state);

int prime_protocol_record_infos(calc_handle *handle, const uint8_t *data, uint32_t size);
int prime_protocol_get_info(const calc_handle *handle,
                            calc_prime_protocol_info *info);
uint32_t prime_protocol_get_build(const calc_handle *handle);
uint8_t prime_protocol_get_version(const calc_handle *handle);
int prime_protocol_supports_v2(const calc_handle *handle);
uint32_t prime_protocol_next_message_id(calc_handle *handle);
int prime_protocol_negotiate(calc_handle *handle);
void prime_protocol_reset_legacy(calc_handle *handle);

uint8_t prime_v2_next_sequence(uint8_t sequence);
int prime_v2_encode_content(uint8_t sequence, uint32_t message_id,
                            uint32_t total_size, const uint8_t *data,
                            uint32_t data_size, uint8_t *out,
                            uint32_t capacity, uint32_t *out_size);
int prime_v2_decode_content(const uint8_t *data, uint32_t size,
                            prime_v2_content *frame);
int prime_v2_encode_ack(const prime_v2_ack *ack, uint8_t *out,
                        uint32_t capacity, uint32_t *out_size);
int prime_v2_decode_ack(const uint8_t *data, uint32_t size,
                        prime_v2_ack *ack);
int prime_v2_is_heartbeat(const uint8_t *data, uint32_t size);
int prime_v2_send_message(calc_handle *handle, const uint8_t *data,
                          uint32_t size, uint32_t *out_message_id);
int prime_v2_recv_message(calc_handle *handle, uint8_t **out_data,
                          uint32_t *out_size, uint32_t *out_message_id);

#endif
