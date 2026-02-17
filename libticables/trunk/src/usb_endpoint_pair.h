#ifndef __TICABLES_USB_ENDPOINT_PAIR__
#define __TICABLES_USB_ENDPOINT_PAIR__

#include <stdint.h>

#include "testable.h"

struct libusb_config_descriptor;

typedef struct
{
	uint8_t in_endpoint;
	int in_packet_size;
	uint8_t out_endpoint;
	int out_packet_size;
} TicablesUsbEndpointPair;

TICABLES_TESTABLE int ticables_usb1_discover_bulk_endpoint_pair(const struct libusb_config_descriptor *config,
	TicablesUsbEndpointPair *pair);

#endif
