/* libhpcalcs - hand-helds support library
 * Copyright (C) 2013 Lionel Debroux
 * Code patterns and snippets borrowed from libticables & libticalcs:
 * Copyright (C) 1999-2009 Romain Liévin
 * Copyright (C) 2009-2013 Lionel Debroux
 * Copyright (C) 1999-2013 libti* contributors.
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program; if not, write to the Free Software Foundation,
 * Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA
 */

/**
 * \file prime_vpkt.c Calcs: Prime virtual packets.
 */

#ifdef HAVE_CONFIG_H
# include <config.h>
#endif

#include <hpcalcs.h>
#include "internal.h"
#include "logging.h"
#include "error.h"

#include "prime_cmd.h"

#include <inttypes.h>
#include <stdlib.h>
#include <string.h>

#define PRIME_LEGACY_MAX_STALE_REPORTS 4096U

// -----------------------------------------------
// Calcs - HP Prime virtual packets
// -----------------------------------------------


HPEXPORT prime_vtl_pkt * HPCALL prime_vtl_pkt_new(uint32_t size) {
    prime_vtl_pkt * pkt = (prime_vtl_pkt *)(hpcalcs_alloc_funcs.malloc)(sizeof(*pkt));

    if (pkt != NULL) {
        pkt->size = size;
        pkt->data = NULL;
        pkt->cmd = 0;
        if (size != 0) {
            pkt->data = (uint8_t *)(hpcalcs_alloc_funcs.calloc)(size, sizeof(*pkt->data));

            if (pkt->data == NULL) {
                (hpcalcs_alloc_funcs.free)(pkt);
                pkt = NULL;
            }
        }
    }

    return pkt;
}

HPEXPORT prime_vtl_pkt * HPCALL prime_vtl_pkt_new_with_data_ptr(uint32_t size, uint8_t * data) {
    prime_vtl_pkt * pkt = (prime_vtl_pkt *)(hpcalcs_alloc_funcs.malloc)(sizeof(*pkt));

    if (pkt != NULL) {
        pkt->size = size;
        pkt->data = data;
    }

    return pkt;
}

HPEXPORT void HPCALL prime_vtl_pkt_del(prime_vtl_pkt * pkt) {
    if (pkt != NULL) {
        (hpcalcs_alloc_funcs.free)(pkt->data);
        (hpcalcs_alloc_funcs.free)(pkt);
    }
    else {
        hpcalcs_error("%s: pkt is NULL", __FUNCTION__);
    }
}

HPEXPORT int HPCALL prime_send_data(calc_handle * handle, prime_vtl_pkt * pkt) {
    int res;
    if (handle != NULL && pkt != NULL) {
        prime_raw_hid_pkt raw;
        uint32_t report_size;
        uint32_t payload_size;
        uint32_t i, q, r;
        uint32_t offset = 0;
        uint8_t pkt_id = 0;

        report_size = hpcables_options_get_report_size(handle->cable);
        if (report_size < 2 || report_size > PRIME_RAW_HID_DATA_SIZE_MAX) {
            report_size = PRIME_RAW_HID_DATA_SIZE_LEGACY;
        }
        payload_size = report_size - 1;

        memset((void *)&raw, 0, sizeof(raw));
        q = (pkt->size) / payload_size;
        r = (pkt->size) % payload_size;

        hpcalcs_info("%s: q:%" PRIu32 "\tr:%" PRIu32, __FUNCTION__, q, r);

        for (i = 1; i <= q; i++) {
            raw.size = report_size + 1;
            raw.data[1] = pkt_id;
            memcpy(raw.data + 2, pkt->data + offset, payload_size);
            offset += payload_size;

            res = prime_send(handle, &raw);
            if (res) {
                hpcalcs_info("%s: send %" PRIu32 " failed", __FUNCTION__, i);
                r = 0;
                break;
            }
            else {
                hpcalcs_info("%s: send %" PRIu32 " succeeded", __FUNCTION__, i);
            }

            // Increment packet ID, which seems to be necessary for computer -> calc packets
            pkt_id++;
            if (pkt_id == 0xFF) {
                pkt_id = 0; // Skip 0xFF, which is used for other purposes.
            }
        }

        if (r || !pkt->size) {
            raw.size = r + 2;
            raw.data[1] = pkt_id;
            memcpy(raw.data + 2, pkt->data + offset, r);

            res = prime_send(handle, &raw);
            if (res) {
                hpcalcs_info("%s: send remaining failed", __FUNCTION__);
            }
            else {
                hpcalcs_info("%s: send remaining succeeded", __FUNCTION__);
            }
        }
    }
    else {
        res = ERR_INVALID_PARAMETER;
        hpcalcs_error("%s: an argument is NULL", __FUNCTION__);
    }
    return res;
}

HPEXPORT int HPCALL prime_recv_data(calc_handle * handle, prime_vtl_pkt * pkt) {
    int res;
    if (handle != NULL && pkt != NULL) {
        prime_raw_hid_pkt raw;
        uint32_t expected_size = 0;
        uint32_t offset = 0;
        uint32_t read_pkts_count = 0;
        uint32_t stale_reports = 0;
        // WIP: reassembly.

        //size = pkt->size;
        pkt->size = 0;
        pkt->data = NULL;

        for(;;) {
            memset(&raw, 0, sizeof(raw));
            res = prime_recv(handle, &raw);
            if (res) {
                hpcalcs_warning("%s: recv failed", __FUNCTION__);
                break;
            }
            else {
                //hpcalcs_info("%s: recv succeeded", __FUNCTION__);
            }
            //hpcalcs_info("%s: raw.size=%" PRIu32, __FUNCTION__, raw.size);
            if (raw.size > 0) {
                uint8_t * new_data;
                uint8_t expected_sequence = (uint8_t)(
                    (read_pkts_count + (read_pkts_count / 0xFFU)) & 0xFFU);

                /* A cancelled or interrupted transfer can leave reports in
                 * the OS/device input path after the HID handle is reopened.
                 * At the start of a new legacy reply, ignore only reports
                 * which cannot be its sequence-zero command header.  This is
                 * read-only resynchronization: no unsupported G1 flow-control
                 * packets are sent. */
                if (read_pkts_count == 0
                    && (raw.data[0] != 0
                        || raw.size < 2 || raw.data[1] != pkt->cmd)) {
                    stale_reports++;
                    if (stale_reports > PRIME_LEGACY_MAX_STALE_REPORTS) {
                        res = ERR_CALC_PACKET_FORMAT;
                        hpcalcs_error("%s: too many stale reports before command %02X",
                                      __FUNCTION__, pkt->cmd);
                        break;
                    }
                    hpcalcs_debug("%s: discarding stale report (sequence=%u, command=%02X) while waiting for command %02X",
                                  __FUNCTION__, (unsigned int)raw.data[0],
                                  raw.size >= 2 ? raw.data[1] : 0,
                                  pkt->cmd);
                    continue;
                }

                // Exclude those packets from reassembly (at least for screenshotting purposes, they seem to be spurious).
                if (raw.data[0] == 0xFF) {
                    // TODO: investigate whether the second byte could indicate an error code ?
                    hpcalcs_error("%s: skipping packet starting with 0xFF", __FUNCTION__);
                    continue;
                }
                // Sanity check. The first byte is the sequence number. After reaching 0xFE. it wraps back to 0 (skipping 0xFF).
                else if (raw.data[0] != expected_sequence) {
                    res = ERR_CALC_PACKET_FORMAT;
                    hpcalcs_error("%s: packet out of sequence at report %" PRIu32
                                  ", got %u, expected %u (report size=%" PRIu32
                                  ", assembled=%" PRIu32 "/%" PRIu32 ")",
                                  __FUNCTION__, read_pkts_count,
                                  (unsigned int)raw.data[0],
                                  (unsigned int)expected_sequence, raw.size,
                                  offset, expected_size);
                    break;
                }

                read_pkts_count++;

                // Over-read prevention (hopefully ^^) code: pre-set the expected size of the reply to the given command.
                if (read_pkts_count == 1) {
                    if (pkt->cmd != CMD_PRIME_CHECK_READY && raw.size < 7) {
                        res = ERR_CALC_PACKET_FORMAT;
                        hpcalcs_error("%s: first report is too short for a virtual packet header (%" PRIu32 " bytes)",
                                      __FUNCTION__, raw.size);
                        break;
                    }
                    res = prime_data_size(pkt->cmd, raw.data + 1, &expected_size); // +1: skip leading byte.
                    if (res != ERR_SUCCESS) {
                        break;
                    }
                }

                pkt->size += raw.size - 1;
                new_data = (hpcalcs_alloc_funcs.realloc)(pkt->data, pkt->size);
                if (new_data != NULL) {
                    pkt->data = new_data;
                    // Skip first byte, which is usually 0x00.
                    memcpy(pkt->data + offset, &(raw.data[1]), raw.size - 1);
                    offset += raw.size - 1;
                }
                else {
                    res = ERR_MALLOC;
                    hpcalcs_error("%s: cannot reallocate memory", __FUNCTION__);
                    break;
                }
            }
            else {
                res = ERR_CALC_PACKET_FORMAT;
                hpcalcs_error("%s: received an empty HID report", __FUNCTION__);
                break;
            }

            if (offset >= expected_size) {
                hpcalcs_info("%s: breaking because the expected size was reached", __FUNCTION__);
                // Shorten packet.
                if (expected_size < pkt->size) {
                    uint8_t * shortened;
                    hpcalcs_info("%s: shortening packet from %" PRIu32 " to %" PRIu32, __FUNCTION__, pkt->size, expected_size);
                    shortened = (hpcalcs_alloc_funcs.realloc)(pkt->data, expected_size);
                    if (shortened != NULL) {
                        pkt->data = shortened;
                    }
                }
                pkt->size = expected_size;
                break;
            }
        }
    }
    else {
        res = ERR_INVALID_PARAMETER;
        hpcalcs_error("%s: an argument is NULL", __FUNCTION__);
    }
    return res;
}

HPEXPORT int HPCALL prime_data_size(uint8_t cmd, uint8_t * data, uint32_t * out_size) {
    int res = ERR_SUCCESS;
    if (data != NULL && out_size != NULL) {
        switch (cmd) {
            case CMD_PRIME_CHECK_READY:
                // Single-packet reply.
                *out_size = 1;
                break;
            case CMD_PRIME_GET_INFOS:
            case CMD_PRIME_RECV_SCREEN:
            case CMD_PRIME_RECV_BACKUP:
            // Not supposed to receive REQ_FILE
            case CMD_PRIME_RECV_FILE:
            case CMD_PRIME_RECV_CHAT:
            // Not supposed to receive SEND_KEY
            // Not supposed to receive SET_DATE_TIME
                // Expected size is embedded in reply.
                /* Current Prime firmware uses marker 0x03 in legacy-framed
                 * replies on both G1 and G2.  Its big-endian payload length
                 * has the same layout as the older marker 0x01. */
                if (data[1] == 0x01 || data[1] == 0x03) {
                    uint32_t payload_size;
                    if (cmd != data[0]) {
                        hpcalcs_warning("%s: command in packet %02X does not match the expected command %02X", __FUNCTION__, data[0], cmd);
                    }

                    payload_size = (((uint32_t)(data[2])) << 24)
                        | (((uint32_t)(data[3])) << 16)
                        | (((uint32_t)(data[4])) << 8)
                        | ((uint32_t)(data[5]));
                    if (payload_size > UINT32_MAX - 6U) {
                        res = ERR_CALC_PACKET_FORMAT;
                        hpcalcs_error("%s: declared packet size overflows", __FUNCTION__);
                    }
                    else {
                        *out_size = payload_size + 6U; // cmd + 0x01 + size.
                    }
                }
                else {
                    res = ERR_CALC_PACKET_FORMAT;
                    hpcalcs_error("%s: malformed virtual header for command %02X"
                                  " (received command=%02X marker=%02X)",
                                  __FUNCTION__, cmd, data[0], data[1]);
                }
                break;
            default:
                // Not implemented.
                *out_size = 0;
                hpcalcs_error("%s: received unknown command %u, size undetermined, please report", __FUNCTION__, cmd);
                break;
        }
    }
    else {
        res = ERR_INVALID_PARAMETER;
        hpcalcs_error("%s: an argument is NULL", __FUNCTION__);
    }
    return res;
}
