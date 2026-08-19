/* Runtime checks for the Emscripten WebHID cable implementation. */

#include <emscripten.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#include "error.h"
#include "hpcables.h"
#include "hpcalcs.h"

EM_JS(void, mock_emit_input, (uint8_t first, uint8_t second), {
    globalThis.__hplpEmitInput([first, second]);
});

EM_JS(void, mock_emit_disconnect, (), {
    globalThis.__hplpEmitDisconnect();
});

EM_JS(void, mock_select_g1_fallback, (), {
    globalThis.__hplpSelectG1Fallback();
});

EM_JS(void, mock_prepare_legacy_exchange, (uint8_t first, uint8_t second), {
    globalThis.__hplpPrepareLegacyExchange([first, second]);
});

EM_JS(int, mock_write_matches, (uint8_t report_id, uint8_t first, uint8_t second), {
    const write = globalThis.__hplpLastWrite;
    return !!write && write.reportId === report_id
        && write.bytes.length === 2
        && write.bytes[0] === first && write.bytes[1] === second;
});

static int check(int condition, const char *message) {
    if (!condition) {
        fprintf(stderr, "FAIL: %s\n", message);
        return 1;
    }
    return 0;
}

int main(void) {
    cable_handle *cable;
    calc_handle calc = {0};
    uint8_t write_data[] = {7, 0xAA, 0x55};
    uint8_t read_data[PRIME_RAW_HID_DATA_SIZE_MAX];
    uint8_t *read_ptr = read_data;
    uint32_t read_size = 0;
    int failed = 0;

    failed |= check(hpcables_init(NULL) == ERR_SUCCESS, "initialize hpcables");
    cable = hpcables_handle_new(CABLE_PRIME_HID);
    failed |= check(cable != NULL, "allocate WebHID cable");
    if (cable == NULL) {
        hpcables_exit();
        return EXIT_FAILURE;
    }

    failed |= check(hpcables_cable_probe(cable) == ERR_SUCCESS,
                    "probe authorized HP Prime WebHID device");
    failed |= check(hpcables_cable_open(cable) == ERR_SUCCESS,
                    "open mocked G2 WebHID device");
    failed |= check(hpcables_options_get_report_size(cable) == 1024,
                    "discover 1024-byte G2 reports from HID collections");
    failed |= check(hpcables_cable_send(cable, write_data,
                    sizeof(write_data)) == ERR_SUCCESS
                    && mock_write_matches(7, 0xAA, 0x55),
                    "separate HID report ID from sendReport payload");

    mock_emit_input(0x12, 0x34);
    failed |= check(hpcables_cable_recv(cable, &read_ptr, &read_size)
                    == ERR_SUCCESS && read_size == 2
                    && read_data[0] == 0x12 && read_data[1] == 0x34,
                    "flush stale input on open and dequeue complete input report");

    failed |= check(hpcables_options_set_read_timeout(cable, 1) == ERR_SUCCESS,
                    "set short WebHID read timeout");
    failed |= check(hpcables_cable_recv(cable, &read_ptr, &read_size)
                    == ERR_CABLE_READ_ERROR,
                    "surface WebHID read timeout as a cable read error");

    mock_emit_disconnect();
    failed |= check(hpcables_cable_recv(cable, &read_ptr, &read_size)
                    == ERR_CABLE_READ_ERROR,
                    "wake blocked reads with an error after device disconnect");
    failed |= check(hpcables_cable_close(cable) == ERR_SUCCESS,
                    "close mocked G2 WebHID device");

    mock_select_g1_fallback();
    failed |= check(hpcables_cable_open(cable) == ERR_SUCCESS
                    && hpcables_options_get_report_size(cable) == 64,
                    "use fixed 64-byte G1 reports despite misleading descriptors");

    calc.model = CALC_PRIME;
    calc.cable = cable;
    {
        prime_vtl_pkt *packet = prime_vtl_pkt_new(2);
        failed |= check(packet != NULL, "allocate legacy virtual packet");
        if (packet != NULL) {
            packet->cmd = 0xFC;
            packet->data[0] = 0xFC;
            packet->data[1] = 8;
            mock_prepare_legacy_exchange(0x12, 0x34);
            failed |= check(prime_send_data(&calc, packet) == ERR_SUCCESS,
                            "send a fresh legacy virtual packet");
            read_ptr = read_data;
            read_size = 0;
            failed |= check(hpcables_cable_recv(cable, &read_ptr, &read_size)
                            == ERR_SUCCESS && read_size == 2
                            && read_data[0] == 0x12 && read_data[1] == 0x34,
                            "discard stale input before send but retain a reply emitted during sendReport");
            prime_vtl_pkt_del(packet);
        }
    }
    failed |= check(hpcables_cable_close(cable) == ERR_SUCCESS,
                    "close mocked G1 WebHID device");

    hpcables_handle_del(cable);
    failed |= check(hpcables_exit() == ERR_SUCCESS, "shut down hpcables");
    if (!failed) {
        puts("HP Prime WebHID mock tests passed");
    }
    return failed ? EXIT_FAILURE : EXIT_SUCCESS;
}
