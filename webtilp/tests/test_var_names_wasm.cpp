// Exercise the actual JSON bridge, Emscripten string arguments and DBUS requests.
#include "../webtilp.cpp"
#include <cassert>
#include <vector>

namespace {
std::vector<uint8_t> name_test_sent;
CableFncts* name_test_original_cable;
CalcFncts* name_test_original_calc;
CalcFncts* name_test_capture_calc;
VarEntry name_test_old, name_test_new;
int name_test_calls;
int capture_name(CalcHandle*, VarRequest* request) {
    name_test_old = *request;
    name_test_new = {};
    ++name_test_calls;
    return TICABLES_ERR_READ_TIMEOUT;
}
int capture_recv(CalcHandle* handle, CalcMode, FileContent*, VarRequest* request) {
    return capture_name(handle, request);
}
int capture_app(CalcHandle* handle, FlashContent*, VarRequest* request) {
    return capture_name(handle, request);
}
int capture_rename(CalcHandle* handle, VarRequest* old_request, VarRequest* new_request) {
    const int result = capture_name(handle, old_request);
    name_test_new = *new_request;
    return result;
}
int capture_attr(CalcHandle* handle, VarRequest* request, FileAttr) {
    return capture_name(handle, request);
}
int name_test_version(CalcHandle*, CalcInfos* infos) {
    *infos = {};
    strcpy(infos->os_version, "3.10");
    return 0;
}
int name_test_send(CableHandle*, uint8_t* data, uint32_t size) {
    name_test_sent.insert(name_test_sent.end(), data, data + size);
    return 0;
}
int name_test_recv(CableHandle*, uint8_t*, uint32_t) { return TICABLES_ERR_READ_TIMEOUT; }
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* test_var_name_setup(int model, int type,
                                                               const char* raw_hex,
                                                               const char* folder_hex) {
    g_calc_model = static_cast<CalcModel>(model);
    g_cable_handle = ticables_handle_new(CABLE_NUL, PORT_1);
    name_test_original_cable = g_cable_handle->cable;
    static CableFncts cable = *name_test_original_cable;
    cable.send = name_test_send;
    cable.recv = name_test_recv;
    g_cable_handle->cable = &cable;
    g_calc_handle = ticalcs_handle_new(g_calc_model);
    name_test_original_calc = g_calc_handle->calc;
    assert(ticalcs_cable_attach(g_calc_handle, g_cable_handle) == 0);
    g_calc_attached = g_calc_ready = 1;
    name_test_sent.clear();
    VarEntry entry{};
    entry.type = type;
    for (size_t i = 0; raw_hex[2 * i]; ++i) {
        unsigned value;
        assert(sscanf(raw_hex + 2 * i, "%2x", &value) == 1);
        entry.name[i] = value;
    }
    for (size_t i = 0; folder_hex[2 * i]; ++i) {
        unsigned value;
        assert(sscanf(folder_hex + 2 * i, "%2x", &value) == 1);
        entry.folder[i] = value;
    }
    FILE* fp = fopen("/name.json", "wb");
    assert(fp);
    write_var_entry_json(fp, &entry, "var");
    fclose(fp);
    return "/name.json";
}

extern "C" EMSCRIPTEN_KEEPALIVE void test_var_name_capture() {
    auto callbacks = name_test_original_calc->fncts;
    callbacks.recv_var = capture_recv;
    callbacks.recv_app = capture_app;
    callbacks.del_var = capture_name;
    callbacks.del_fld = capture_name;
    callbacks.new_fld = capture_name;
    callbacks.rename_var = capture_rename;
    callbacks.change_attr = capture_attr;
    callbacks.get_version = name_test_version;
    name_test_capture_calc = new CalcFncts{g_calc_model, "test", "test", "test",
        name_test_original_calc->features, name_test_original_calc->product_id, {}, callbacks};
    g_calc_handle->calc = name_test_capture_calc;
    name_test_calls = 0;
}

extern "C" EMSCRIPTEN_KEEPALIVE int test_var_name_calls() { return name_test_calls; }

extern "C" EMSCRIPTEN_KEEPALIVE const char* test_var_name_captured_hex(int field) {
    const char* value = field == 0 ? name_test_old.name : field == 1 ? name_test_old.folder
        : field == 2 ? name_test_new.name : name_test_new.folder;
    static std::string hex;
    hex.clear();
    for (; *value; ++value) {
        char buf[3];
        snprintf(buf, sizeof(buf), "%02x", static_cast<unsigned char>(*value));
        hex += buf;
    }
    return hex.c_str();
}

extern "C" EMSCRIPTEN_KEEPALIVE int test_var_name_handle() {
    return reinterpret_cast<uintptr_t>(g_cable_handle);
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* test_var_name_sent_hex() {
    static std::string hex;
    hex.clear();
    for (uint8_t byte : name_test_sent) {
        char buf[3];
        snprintf(buf, sizeof(buf), "%02x", byte);
        hex += buf;
    }
    return hex.c_str();
}

extern "C" EMSCRIPTEN_KEEPALIVE void test_var_name_teardown() {
    g_calc_handle->calc = name_test_original_calc;
    delete name_test_capture_calc;
    name_test_capture_calc = nullptr;
    ticalcs_cable_detach(g_calc_handle);
    ticalcs_handle_del(g_calc_handle);
    g_calc_handle = nullptr;
    g_calc_attached = g_calc_ready = 0;
    g_cable_handle->cable = name_test_original_cable;
    ticables_handle_del(g_cable_handle);
    g_cable_handle = nullptr;
}

extern "C" EMSCRIPTEN_KEEPALIVE void test_var_name_files() {
    FileContent* content = tifiles_content_create_regular(CALC_TI83P);
    content->num_entries = 2;
    content->entries = tifiles_ve_create_array(2);
    for (unsigned i = 0; i < 2; ++i) {
        VarEntry* entry = content->entries[i] = tifiles_ve_create();
        entry->type = 1; // A real list containing one zero.
        entry->name[0] = 0x5d;
        entry->name[1] = i;
        entry->size = 11;
        entry->data = static_cast<uint8_t*>(g_malloc0(entry->size));
        entry->data[0] = 1;
    }
    assert(tifiles_file_write_regular("/lists.8xg", content, nullptr) == 0);
    content->num_entries = 1;
    assert(tifiles_file_write_regular("/L1.8xl", content, nullptr) == 0);
    TigContent* tig = tifiles_content_create_tigroup(CALC_TI83P, 0);
    TigEntry* te = tifiles_te_create("L1.8xl", TIFILE_SINGLE, CALC_TI83P);
    tifiles_content_delete_regular(te->content.regular);
    te->content.regular = tifiles_content_dup_regular(content);
    assert(tifiles_content_add_te(tig, te) == 1);
    assert(tifiles_file_write_tigroup("/lists.tig", tig) == 0);
    tifiles_content_delete_tigroup(tig);
    content->num_entries = 2;
    tifiles_content_delete_regular(content);

    content = tifiles_content_create_regular(CALC_TI89);
    content->num_entries = 1;
    content->entries = tifiles_ve_create_array(1);
    VarEntry* entry = content->entries[0] = tifiles_ve_create();
    strcpy(entry->name, "\x88"); // theta in an alpha folder, in the TI-89 charset.
    strcpy(entry->folder, "\x80");
    entry->size = 1;
    entry->data = static_cast<uint8_t*>(g_malloc0(1));
    assert(tifiles_file_write_regular("/theta.89e", content, nullptr) == 0);
    tifiles_content_delete_regular(content);
}
