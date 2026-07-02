/* Hey EMACS -*- linux-c -*- */

/*  libticalcs - Ti Calculator library, a part of the TiLP project
 *  Copyright (C) 2026  Adrien "Adriweb" Bertrand
 *
 *  This program is free software; you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation; either version 2 of the License, or
 *  (at your option) any later version.
 *
 *  This program is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU General Public License for more details.
 *
 *  You should have received a copy of the GNU General Public License
 *  along with this program; if not, write to the Free Software Foundation,
 *  Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA
 */

// NNSE ("NavNet SE") framing layer used by the TI-Nspire CX II in its default
// USB configuration (#1). NavNet raw packets are wrapped into NNSE "stream"
// messages; NNSE has its own handshake, sequence numbers and acknowledgements
// (which replace NavNet-level acknowledgements entirely).
// Modeled on libnspire's cx2.cpp by Fabian Vogt, and on Firebird.

// /!\ NOTE: this is an internal header, not part of the public API.

#ifndef __NSP_NNSE__
#define __NSP_NNSE__

#ifdef __cplusplus
extern "C" {
#endif

#define NSP_NNSE_HEADER_SIZE  12
// Maximum NNSE payload, matching libnspire's read buffer.
#define NSP_NNSE_MAX_PAYLOAD  1472

// Whether the cable attached to this handle speaks NNSE (TI-Nspire CX II in
// USB configuration #1). Determined once per cable attach, then cached.
int nsp_nnse_enabled(CalcHandle *handle);

// Process incoming NNSE messages until the calc-initiated handshake
// (address request + time request) has been answered. If no handshake
// traffic arrives, assume the device is already associated from a previous
// session and proceed optimistically.
int nsp_nnse_ensure_ready(CalcHandle *handle);

// Send one NavNet raw packet wrapped into an NNSE stream message. Normally
// waits for the NNSE-level acknowledgement; if current-port stream data arrives
// first, queues it and treats that as acceptance so the caller can receive it.
int nsp_nnse_send_stream(CalcHandle *handle, const uint8_t *data, uint32_t size);

// Receive the payload of the next NNSE stream message (one NavNet raw packet),
// answering handshake requests and acknowledging messages along the way.
int nsp_nnse_recv_stream(CalcHandle *handle, uint8_t *data, uint32_t maxsize, uint32_t *size);

// Whether a NavNet destination port belongs to the current NNSE operation.
// In addition to the current client and login ports, passive operations can
// temporarily register the calculator-side service port they are listening on.
int nsp_nnse_port_matches(CalcHandle *handle, uint16_t dst_port);

// Queue an already-unwrapped NavNet stream payload for the current local port
// so the next nsp_nnse_recv_stream() call returns it before reading USB. Used
// by the NavNet layer to split CX II extended packets into legacy-sized chunks
// and to preserve valid trailing packets found in a stream payload.
int nsp_nnse_queue_stream(CalcHandle *handle, const uint8_t *data, uint32_t size);

// Drop queued stream payloads after a known-size virtual packet receive has
// consumed the requested byte count.
int nsp_nnse_drop_queued_streams(CalcHandle *handle);

// Drop buffered NNSE data and force nsp_nnse_ensure_ready() to re-associate
// before the next stream operation, without forgetting that this cable uses
// NNSE framing.
void nsp_nnse_reassociate_next(CalcHandle *handle);

// Reset the per-handle NNSE state (cached mode, handshake state, sequence
// number) and free any pending queued payloads.
void nsp_nnse_reset(CalcHandle *handle);

// Internal parser invariant test hook used by ticalcs2_check.
int nsp_nnse_test_partial_header_possible(const uint8_t *header, uint32_t size);
uint32_t nsp_nnse_test_discard_impossible_prefix(uint8_t *data, uint32_t *size);
int nsp_nnse_test_port_matches(uint16_t current_port, uint16_t passive_port, uint16_t dst_port);
int nsp_nnse_test_stream_requires_ack(const uint8_t *data, uint32_t size);

#ifdef __cplusplus
}
#endif

#endif
