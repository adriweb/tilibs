#ifndef __TICALCS_EVO_CMD__
#define __TICALCS_EVO_CMD__

#include <stddef.h>
#include <stdint.h>

#include "ticalcs.h"

int evo_get_request(CalcHandle *handle, const char *url, uint8_t **payload, size_t *payload_len);
int evo_put_request(CalcHandle *handle, const char *url, const uint8_t *payload, size_t payload_len);
int evo_put_request_ignore_final_status(CalcHandle *handle, const char *url, const uint8_t *payload, size_t payload_len);

#endif
