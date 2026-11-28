// Exercise multi-member accessory TIFL metadata and entry dispatch through the
// real WebTILP bridge, libtifiles, and libticalcs wrappers.
#include "../webtilp.cpp"

#include <cassert>
#include <string>
#include <vector>

namespace {
CalcFncts* original_calc = nullptr;
CalcFncts* capture_calc = nullptr;
int ready_calls = 0;
int os_calls = 0;
int app_calls = 0;

int capture_ready(CalcHandle*) {
    ++ready_calls;
    return 0;
}

int capture_os(CalcHandle*, FlashContent* content) {
    ++os_calls;
    assert(content);
    assert(content->next == nullptr);
    assert(content->data_type == TI83p_AMS);
    assert(strcmp(content->name, "OPERATING_SYSTEM") == 0);
    return 0;
}

int capture_app(CalcHandle*, FlashContent* content) {
    ++app_calls;
    assert(content);
    assert(content->next == nullptr);
    assert(content->data_type == 0x29);
    assert(strcmp(content->name, "DATAMATE") == 0);
    return 0;
}

void append_hex_record(std::string& out, uint8_t type, uint16_t address,
                       const std::vector<uint8_t>& data) {
    assert(data.size() <= 32);
    uint8_t sum = static_cast<uint8_t>(data.size() + (address >> 8) + address + type);
    char field[16];
    snprintf(field, sizeof(field), ":%02X%04X%02X", static_cast<unsigned>(data.size()), address, type);
    out += field;
    for (uint8_t byte : data) {
        snprintf(field, sizeof(field), "%02X", byte);
        out += field;
        sum = static_cast<uint8_t>(sum + byte);
    }
    snprintf(field, sizeof(field), "%02X\r\n", static_cast<uint8_t>(0 - sum));
    out += field;
}

std::string make_payload(uint16_t page, uint16_t address, const std::vector<uint8_t>& data) {
    std::string payload;
    append_hex_record(payload, 2, 0, {
        static_cast<uint8_t>(page >> 8), static_cast<uint8_t>(page)
    });
    append_hex_record(payload, 0, address, data);
    append_hex_record(payload, 1, 0, {});
    return payload;
}

void append_tifl(std::vector<uint8_t>& file, uint8_t type, const char* name,
                 const std::string& payload) {
    assert(strlen(name) <= 31);
    uint8_t header[78] = {};
    memcpy(header, "**TIFL**", 8);
    header[10] = 1;
    header[11] = 0x88;
    header[16] = static_cast<uint8_t>(strlen(name));
    memcpy(header + 17, name, strlen(name));
    header[48] = DEVICE_TYPE_CBL2;
    header[49] = type;
    const uint32_t length = static_cast<uint32_t>(payload.size());
    header[74] = static_cast<uint8_t>(length);
    header[75] = static_cast<uint8_t>(length >> 8);
    header[76] = static_cast<uint8_t>(length >> 16);
    header[77] = static_cast<uint8_t>(length >> 24);
    file.insert(file.end(), header, header + sizeof(header));
    file.insert(file.end(), payload.begin(), payload.end());
}
}

extern "C" EMSCRIPTEN_KEEPALIVE int test_accessory_flash_chain() {
    std::vector<uint8_t> file;
    append_tifl(file, TI83p_AMS, "OPERATING_SYSTEM", make_payload(0, 0, {1, 2, 3, 4}));
    append_tifl(file, 0x29, "DATAMATE", make_payload(1, 0x10, {0xa0, 0xa1, 0xa2}));
    assert(g_file_set_contents("/combined.c2u", reinterpret_cast<const char*>(file.data()),
                               static_cast<gssize>(file.size()), nullptr));

    const std::string metadata = file_get_entries_json("/combined.c2u");
    assert(metadata.find("\"class\":\"os\"") != std::string::npos);
    const size_t os = metadata.find("\"name\":\"OPERATING_SYSTEM\"");
    const size_t app = metadata.find("\"name\":\"DATAMATE\"");
    assert(os != std::string::npos && app != std::string::npos && os < app);
    assert(metadata.find("\"entry_class\":\"os\"", os) < app);
    assert(metadata.find("\"container_type\":\"flash\",\"container_index\":0", os) < app);
    assert(metadata.find("\"entry_class\":\"application\"", app) != std::string::npos);
    assert(metadata.find("\"container_type\":\"flash\",\"container_index\":1", app) != std::string::npos);

    FlashContent opaque{};
    opaque.model = CALC_CBL2;
    opaque.data_type = 0xf0;
    assert(get_flash_content_class(&opaque, TIFILE_OS) == TIFILE_FLASH);

    g_calc_model = CALC_CBL2;
    g_cable_handle = ticables_handle_new(CABLE_NUL, PORT_1);
    assert(g_cable_handle);
    g_calc_handle = ticalcs_handle_new(g_calc_model);
    assert(g_calc_handle);
    original_calc = g_calc_handle->calc;
    assert(ticalcs_cable_attach(g_calc_handle, g_cable_handle) == 0);
    g_calc_attached = 1;

    auto callbacks = original_calc->fncts;
    callbacks.is_ready = capture_ready;
    callbacks.send_os = capture_os;
    callbacks.send_app = capture_app;
    capture_calc = new CalcFncts{g_calc_model, "accessory-test", "accessory-test", "accessory-test",
        original_calc->features, original_calc->product_id, {}, callbacks};
    g_calc_handle->calc = capture_calc;

    ready_calls = os_calls = app_calls = 0;
    g_calc_ready = 0;
    assert(send_file_entry_custom(g_cable_handle, "/combined.c2u", 0, 3, "", -1, 0) == 0);
    assert(os_calls == 1 && app_calls == 0);
    assert(ready_calls == 0 && g_calc_ready == 0);

    assert(send_file_entry_custom(g_cable_handle, "/combined.c2u", 1, 3, "", -1, 0) == 0);
    assert(os_calls == 1 && app_calls == 1);
    assert(ready_calls == 1 && g_calc_ready == 1);
    assert(send_file_entry_custom(g_cable_handle, "/combined.c2u", 2, 3, "", -1, 0)
           == ERR_WEB_INVALID_ENTRY_INDEX);

    g_calc_handle->calc = original_calc;
    delete capture_calc;
    capture_calc = nullptr;
    ticalcs_cable_detach(g_calc_handle);
    ticalcs_handle_del(g_calc_handle);
    g_calc_handle = nullptr;
    g_calc_attached = g_calc_ready = 0;
    ticables_handle_del(g_cable_handle);
    g_cable_handle = nullptr;
    g_remove("/combined.c2u");

    puts("WebTILP WASM: two-member accessory TIFL metadata and OS/app entry dispatch passed");
    return 0;
}
