#ifndef __TICALCS_EVO_CMD__
#define __TICALCS_EVO_CMD__

#include <stddef.h>
#include <stdint.h>

#include "ticalcs.h"
#include "testable.h"

typedef enum
{
	EVO_KERMIT_SEQUENCE_CURRENT,
	EVO_KERMIT_SEQUENCE_DUPLICATE,
	EVO_KERMIT_SEQUENCE_UNEXPECTED
} EvoKermitSequenceState;

TICALCS_TESTABLE int evo_kermit_packet_remainder(uint8_t length, const uint8_t *extended_length, size_t *remainder);
TICALCS_TESTABLE EvoKermitSequenceState evo_kermit_sequence_state(int have_previous, uint8_t previous, uint8_t received);
TICALCS_TESTABLE int evo_kermit_duplicate_retry_allowed(size_t duplicate_count);
TICALCS_TESTABLE int evo_kermit_size_within_limit(size_t current, size_t additional, size_t limit);
int evo_get_request(CalcHandle *handle, const char *url, uint8_t **payload, size_t *payload_len);
int evo_put_request(CalcHandle *handle, const char *url, const uint8_t *payload, size_t payload_len);
int evo_put_request_ignore_final_status(CalcHandle *handle, const char *url, const uint8_t *payload, size_t payload_len);

#endif
