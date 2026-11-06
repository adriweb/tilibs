#ifndef __TICALCS_NSP_LIMITS__
#define __TICALCS_NSP_LIMITS__

#include <stdint.h>

#define NSP_VIRTUAL_PACKET_MAX_SIZE (128U << 20)

static inline int nsp_vpkt_append_size_valid(uint32_t current_size, uint32_t expected_size, uint32_t append_size)
{
	return current_size <= NSP_VIRTUAL_PACKET_MAX_SIZE
		&& append_size <= NSP_VIRTUAL_PACKET_MAX_SIZE - current_size
		&& (expected_size == 0
			|| (current_size <= expected_size && append_size <= expected_size - current_size));
}

#endif
