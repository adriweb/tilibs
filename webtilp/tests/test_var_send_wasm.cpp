// Exercise the real WebTiLP bridge and libticalcs against a scripted cable.
#include "../webtilp.h"
#include <emscripten.h>
#include <cstring>
#include <cstdio>
#include <vector>
#include <glib.h>
#include <cassert>
#include <deque>
#include <dbus_pkt.h>

namespace {
CalcModel test_model = CALC_NONE;
std::deque<uint8_t> replies;
std::vector<uint8_t> sent;
int mock_send(CableHandle*, uint8_t* data, uint32_t size) {
    sent.insert(sent.end(), data, data + size);
    return 0;
}
int mock_recv(CableHandle*, uint8_t* data, uint32_t size) {
    if (replies.size() < size) return ti::TICABLES_ERR_READ_TIMEOUT;
    while (size--) { *data++ = replies.front(); replies.pop_front(); }
    return 0;
}
void reply(uint8_t command) {
    const uint8_t model = test_model == CALC_TI82 ? DBUS_MID_TI82_PC : DBUS_MID_TI85_PC;
    for (uint8_t byte : {model, command, uint8_t(0), uint8_t(0)}) replies.push_back(byte);
}
void variable_replies() {
    reply(DBUS_CMD_ACK);
    reply(DBUS_CMD_CTS);
    reply(DBUS_CMD_ACK);
}
std::vector<uint8_t> commands() {
    std::vector<uint8_t> result;
    for (size_t offset = 0; offset < sent.size();) {
        assert(offset + 4 <= sent.size());
        const unsigned size = sent[offset + 2] | (unsigned(sent[offset + 3]) << 8);
        result.push_back(sent[offset + 1]);
        offset += 4 + (size ? size + 2 : 0);
        assert(offset <= sent.size());
    }
    return result;
}
void expect_commands(std::initializer_list<uint8_t> expected) {
    assert(commands() == std::vector<uint8_t>(expected));
    assert(replies.empty());
    sent.clear();
}
void fixture(const char* path, unsigned count) {
    auto* content = tifiles_content_create_regular(test_model);
    content->num_entries = count;
    content->entries = tifiles_ve_create_array(count);
    for (unsigned i = 0; i < count; ++i) {
        auto* entry = content->entries[i] = tifiles_ve_create();
        strcpy(entry->name, i ? "TWO" : "ONE");
        entry->type = test_model == CALC_TI82 ? 5 : 12;
        entry->size = 3;
        entry->data = static_cast<uint8_t*>(g_malloc0(entry->size));
    }
    assert(tifiles_file_write_regular(path, content, nullptr) == 0);
    tifiles_content_delete_regular(content);
}
}

extern "C" EMSCRIPTEN_KEEPALIVE int test_var_send_protocol() {
    for (CalcModel model : {CALC_TI82, CALC_TI85}) {
        test_model = model;
        set_calc_model(model);
        set_force_calc(1);
        set_cable_model(CABLE_NUL);
        set_force_cable(1);
        CableHandle* cable = create_handle();
        assert(cable);
        CableFncts* original = cable->cable;
        CableFncts mock = *original;
        mock.send = mock_send;
        mock.recv = mock_recv;
        cable->cable = &mock;
        assert(is_ready(cable) == 0);
        const char* single = model == CALC_TI82 ? "/single.82p" : "/single.85s";
        const char* group = model == CALC_TI82 ? "/group.82g" : "/group.85g";
        fixture(single, 1);
        fixture(group, 2);

        // Independent API calls close the transfer themselves.
        variable_replies(); reply(DBUS_CMD_ACK);
        assert(send_file_custom(cable, single, "", -1, 0) == 0);
        expect_commands({DBUS_CMD_VAR, DBUS_CMD_ACK, DBUS_CMD_XDP, DBUS_CMD_EOT});
        variable_replies(); variable_replies(); reply(DBUS_CMD_ACK);
        assert(send_file_custom(cable, group, "", -1, 0) == 0);
        expect_commands({DBUS_CMD_VAR, DBUS_CMD_ACK, DBUS_CMD_XDP,
                         DBUS_CMD_VAR, DBUS_CMD_ACK, DBUS_CMD_XDP, DBUS_CMD_EOT});

        // WebTiLP batches whole files and individual group entries without EOT
        // between them, then explicitly closes after the final successful send.
        variable_replies();
        assert(send_file_custom(cable, single, "", -1, 1) == 0);
        expect_commands({DBUS_CMD_VAR, DBUS_CMD_ACK, DBUS_CMD_XDP});
        variable_replies();
        assert(send_file_entry_custom(cable, group, 1, 0, "", -1, 1) == 0);
        expect_commands({DBUS_CMD_VAR, DBUS_CMD_ACK, DBUS_CMD_XDP});
        reply(DBUS_CMD_ACK);
        assert(finish_var_send(cable) == 0);
        expect_commands({DBUS_CMD_EOT});

        variable_replies();
        assert(send_file_custom(cable, single, "", -1, 1) == 0);
        expect_commands({DBUS_CMD_VAR, DBUS_CMD_ACK, DBUS_CMD_XDP});
        assert(finish_var_send(cable) == ti::TICABLES_ERR_READ_TIMEOUT);
        expect_commands({DBUS_CMD_EOT});
        assert(finish_var_send(nullptr) == ti::ERR_WEB_INVALID_ARGUMENT);
        expect_commands({});

        assert(close_cable(cable) == 0);
        cable->cable = original;
        notify_usb_disconnect();
        printf("TI-%d actual packet sequence and EOT acknowledgement tests passed\n", model == CALC_TI82 ? 82 : 85);
    }
    for (CalcModel model : {CALC_TI83, CALC_TI86, CALC_TI84P_USB}) {
        test_model = model;
        set_calc_model(model);
        assert(finish_var_send(nullptr) == 0);
        expect_commands({});
    }
    return 0;
}
