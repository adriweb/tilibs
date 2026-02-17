#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#if defined(__BSD__) || defined(__MACOSX__) || defined(__EMSCRIPTEN__)
#include <libusb.h>
#else
#include <libusb-1.0/libusb.h>
#endif

#include "../src/usb_endpoint_pair.h"

// Internal test entry point, deliberately absent from the public cable API.
TICABLES_TESTABLE int ticables_usb1_discover_interrupt_endpoint_pair(const struct libusb_config_descriptor *config,
	TicablesUsbEndpointPair *pair, int require_out);

#define CHECK(condition) \
	do { \
		if (!(condition)) { \
			fprintf(stderr, "%s:%d: check failed: %s\n", __FILE__, __LINE__, #condition); \
			abort(); \
		} \
	} while (0)

static libusb_endpoint_descriptor endpoint(uint8_t address, uint8_t attributes, uint16_t packet_size)
{
	libusb_endpoint_descriptor result = {};
	result.bEndpointAddress = address;
	result.bmAttributes = attributes;
	result.wMaxPacketSize = packet_size;
	return result;
}

static libusb_interface_descriptor altsetting(uint8_t number, uint8_t alternate,
	const libusb_endpoint_descriptor *endpoints, uint8_t count)
{
	libusb_interface_descriptor result = {};
	result.bInterfaceNumber = number;
	result.bAlternateSetting = alternate;
	result.endpoint = endpoints;
	result.bNumEndpoints = count;
	return result;
}

static int discover(const libusb_interface *interfaces, uint8_t count, TicablesUsbEndpointPair *pair)
{
	libusb_config_descriptor config = {};
	config.interface = interfaces;
	config.bNumInterfaces = count;
	return ticables_usb1_discover_bulk_endpoint_pair(&config, pair);
}

static void check_pair_from_claimed_setting(void)
{
	const libusb_endpoint_descriptor endpoints[] = {
		endpoint(0x83, LIBUSB_TRANSFER_TYPE_BULK, 64),
		endpoint(0x81, LIBUSB_TRANSFER_TYPE_BULK, 512),
		endpoint(0x02, LIBUSB_TRANSFER_TYPE_BULK, 256),
	};
	const libusb_interface_descriptor settings[] = { altsetting(0, 0, endpoints, 3) };
	const libusb_interface interfaces[] = { { settings, 1 } };
	TicablesUsbEndpointPair pair = {};
	CHECK(discover(interfaces, 1, &pair) == 1);
	CHECK(pair.in_endpoint == 0x81);
	CHECK(pair.in_packet_size == 512);
	CHECK(pair.out_endpoint == 0x02);
	CHECK(pair.out_packet_size == 256);
}

static void check_directions_are_not_mixed_across_altsettings(void)
{
	const libusb_endpoint_descriptor in[] = { endpoint(0x81, LIBUSB_TRANSFER_TYPE_BULK, 64) };
	const libusb_endpoint_descriptor out[] = { endpoint(0x02, LIBUSB_TRANSFER_TYPE_BULK, 64) };
	const libusb_interface_descriptor settings[] = {
		altsetting(0, 0, in, 1),
		altsetting(0, 1, out, 1),
	};
	const libusb_interface interfaces[] = { { settings, 2 } };
	TicablesUsbEndpointPair pair = {};
	CHECK(discover(interfaces, 1, &pair) == 0);
}

static void check_other_interfaces_are_ignored(void)
{
	const libusb_endpoint_descriptor in[] = { endpoint(0x81, LIBUSB_TRANSFER_TYPE_BULK, 64) };
	const libusb_endpoint_descriptor out[] = { endpoint(0x02, LIBUSB_TRANSFER_TYPE_BULK, 64) };
	const libusb_interface_descriptor setting0[] = { altsetting(0, 0, in, 1) };
	const libusb_interface_descriptor setting1[] = { altsetting(1, 0, out, 1) };
	const libusb_interface interfaces[] = { { setting0, 1 }, { setting1, 1 } };
	TicablesUsbEndpointPair pair = {};
	CHECK(discover(interfaces, 2, &pair) == 0);
}

static void check_interrupt_endpoints_are_ignored(void)
{
	const libusb_endpoint_descriptor endpoints[] = {
		endpoint(0x81, LIBUSB_TRANSFER_TYPE_INTERRUPT, 64),
		endpoint(0x02, LIBUSB_TRANSFER_TYPE_INTERRUPT, 64),
	};
	const libusb_interface_descriptor settings[] = { altsetting(0, 0, endpoints, 2) };
	const libusb_interface interfaces[] = { { settings, 1 } };
	TicablesUsbEndpointPair pair = {};
	CHECK(discover(interfaces, 1, &pair) == 0);
}

static void check_missing_descriptors_are_ignored(void)
{
	TicablesUsbEndpointPair pair = {};
	CHECK(ticables_usb1_discover_bulk_endpoint_pair(NULL, &pair) == 0);
	CHECK(discover(NULL, 1, &pair) == 0);
}

static void check_zero_packet_sizes_are_ignored(void)
{
	const libusb_endpoint_descriptor endpoints[] = {
		endpoint(0x81, LIBUSB_TRANSFER_TYPE_BULK, 0),
		endpoint(0x82, LIBUSB_TRANSFER_TYPE_BULK, 512),
		endpoint(0x02, LIBUSB_TRANSFER_TYPE_BULK, 64),
	};
	const libusb_interface_descriptor settings[] = { altsetting(0, 0, endpoints, 3) };
	const libusb_interface interfaces[] = { { settings, 1 } };
	TicablesUsbEndpointPair pair = {};
	CHECK(discover(interfaces, 1, &pair) == 1);
	CHECK(pair.in_endpoint == 0x82);
	CHECK(pair.in_packet_size == 512);
}

static void check_vernier_interrupt_endpoints(void)
{
	const libusb_endpoint_descriptor endpoints[] = {
		endpoint(0x81, LIBUSB_TRANSFER_TYPE_BULK, 512),
		endpoint(0x83, LIBUSB_TRANSFER_TYPE_INTERRUPT, 8),
		endpoint(0x04, LIBUSB_TRANSFER_TYPE_INTERRUPT, 64),
	};
	const libusb_interface_descriptor hid_settings[] = { altsetting(0, 0, endpoints, 2) };
	const libusb_interface hid_interfaces[] = { { hid_settings, 1 } };
	libusb_config_descriptor config = {};
	config.interface = hid_interfaces;
	config.bNumInterfaces = 1;
	TicablesUsbEndpointPair pair = {};
	// Go! devices need only interrupt IN: commands use control transfers.
	// The Nspire-specific rejection of 0x83 must not apply to interrupt endpoints.
	CHECK(ticables_usb1_discover_interrupt_endpoint_pair(&config, &pair, 0) == 1);
	CHECK(pair.in_endpoint == 0x83);
	CHECK(pair.in_packet_size == 8);
	CHECK(pair.out_endpoint == 0);
	// Go Direct requires both directions from the same claimed interface/altsetting.
	CHECK(ticables_usb1_discover_interrupt_endpoint_pair(&config, &pair, 1) == 0);
	const libusb_interface_descriptor split_settings[] = {
		altsetting(0, 0, endpoints, 2),
		altsetting(0, 1, endpoints + 2, 1),
	};
	const libusb_interface split_interfaces[] = { { split_settings, 2 } };
	config.interface = split_interfaces;
	CHECK(ticables_usb1_discover_interrupt_endpoint_pair(&config, &pair, 1) == 0);
	const libusb_interface_descriptor gdx_settings[] = { altsetting(0, 0, endpoints, 3) };
	const libusb_interface gdx_interfaces[] = { { gdx_settings, 1 } };
	config.interface = gdx_interfaces;
	CHECK(ticables_usb1_discover_interrupt_endpoint_pair(&config, &pair, 1) == 1);
	CHECK(pair.in_endpoint == 0x83);
	CHECK(pair.in_packet_size == 8);
	CHECK(pair.out_endpoint == 0x04);
	CHECK(pair.out_packet_size == 64);
}

int main(void)
{
	check_pair_from_claimed_setting();
	check_directions_are_not_mixed_across_altsettings();
	check_other_interfaces_are_ignored();
	check_interrupt_endpoints_are_ignored();
	check_missing_descriptors_are_ignored();
	check_zero_packet_sizes_are_ignored();
	check_vernier_interrupt_endpoints();
	return 0;
}
