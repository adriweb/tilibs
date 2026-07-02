#ifndef __TICALCS_NSP_LIMITS__
#define __TICALCS_NSP_LIMITS__

#include <stdint.h>

#define NSP_OS_MAX_SIZE (128U << 20)

static inline int nsp_os_receive_size_valid(uint32_t size)
{
	return size > 0 && size < NSP_OS_MAX_SIZE;
}

static inline int nsp_os_receive_packet_boundary_valid(uint32_t remaining, int is_short, int is_nnse)
{
	// NNSE extended packets are exposed as multiple synthetic raw packets, so
	// an intermediate split fragment can legitimately be short.
	return remaining == 0 || !is_short || is_nnse;
}

#endif
