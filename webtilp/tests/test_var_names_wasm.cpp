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
char name_test_os_version[32] = "3.10";
int capture_name(CalcHandle*, VarRequest* request) {
    name_test_old = *request;
    name_test_new = {};
    ++name_test_calls;
    return TICABLES_ERR_READ_TIMEOUT;
}
int capture_recv(CalcHandle* handle, CalcMode, FileContent*, VarRequest* request) {
    return capture_name(handle, request);
}
int capture_send(CalcHandle* handle, CalcMode, FileContent* content) {
    assert(content->num_entries == 1);
    assert(content->entries[0]->type == 0x15);
    assert(content->entries[0]->attr == ATTRB_ARCHIVED);
    return capture_name(handle, content->entries[0]);
}
int capture_lab_report(CalcHandle*, CalcMode, FileContent* content) {
    assert(content && content->num_entries == 1 && content->entries[0]);
    const VarEntry* entry = content->entries[0];
    assert(!strcmp(entry->name, "TWO"));
    assert(!strcmp(entry->folder, "main"));
    assert(entry->type == 0x12 && entry->attr == ATTRB_ARCHIVED);
    return TICABLES_ERR_READ_TIMEOUT;
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
    strcpy(infos->os_version, name_test_os_version);
    return 0;
}
int name_test_send(CableHandle*, uint8_t* data, uint32_t size) {
    name_test_sent.insert(name_test_sent.end(), data, data + size);
    return 0;
}
int name_test_recv(CableHandle*, uint8_t*, uint32_t) { return TICABLES_ERR_READ_TIMEOUT; }
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* test_var_name_filenames() {
    // Exercise every subscript digit, independently of built-in list tokens.
    const unsigned short digits[] = {'L', 0x2080, 0x2081, 0x2082, 0x2083, 0x2084,
        0x2085, 0x2086, 0x2087, 0x2088, 0x2089, 0};
    char* filename = ticonv_utf16_to_gfe(CALC_TI84P_USB, digits);
    assert(filename && strcmp(filename, "L0123456789") == 0);
    ticonv_gfe_free(filename);

    // Controls, DEL, non-Latin text and supplementary characters must not leak
    // into filenames or disappear when no readable transliteration exists.
    const unsigned short unusual[] = {0x0001, 0x007f, 0x4e2d, 0xd83d, 0xde00, '/', 0};
    filename = ticonv_utf16_to_gfe(CALC_NSPIRE_CXII, unusual);
    assert(filename && strcmp(filename, "_u0001__u007F__u4E2D__u1F600__") == 0);
    ticonv_gfe_free(filename);

    struct Fixture {
        CalcModel model; uint8_t type; const char* raw; const char* basename;
        const char* folder = "";
    };
    for (const Fixture& fixture : {
        Fixture{CALC_TI83P, 1, "\x5d", "L1"},
        Fixture{CALC_TI83P, 1, "\x5d\x05", "L6"},
        Fixture{CALC_TI83P, 3, "\x5e\x10", "Y1"},
        Fixture{CALC_TI83P, 3, "\x5e\x19", "Y0"},
        Fixture{CALC_TI83P, 2, "\x5c", "[A]"},
        Fixture{CALC_TI84P_USB, 1, "L₁", "L1"},
        Fixture{CALC_TI84PCE_USB, 3, "Y₉", "Y9"},
        Fixture{CALC_TI83EVO_USB, 1, "L₆", "L6"},
        Fixture{CALC_TI84P_USB, 0x15, "A₀₇", "A07"},
        Fixture{CALC_TI84P_USB, 0, "θ", "_theta_"},
        Fixture{CALC_TI89, 0, "\x88", "_theta_"},
        Fixture{CALC_TI89, 0, "\xe9", "é"},
        Fixture{CALC_TI84P_USB, 0x15, "αΩπ", "_alpha__OMEGA__pi_"},
        Fixture{CALC_NSPIRE_CXII, 0, "café", "Données.café", "Données"},
        Fixture{CALC_NSPIRE_CXII, 0, "àçèéêëîïôùûüÿÉÇ", "àçèéêëîïôùûüÿÉÇ"}
    }) {
        VarEntry entry{};
        strcpy(entry.name, fixture.raw);
        strcpy(entry.folder, fixture.folder);
        entry.type = fixture.type;
        filename = tifiles_build_filename(fixture.model, &entry);
        const std::string expected = std::string(fixture.basename) + "."
            + tifiles_vartype2fext(fixture.model, fixture.type);
        if (!filename || filename != expected) {
            static std::string error;
            error = std::string(filename ? filename : "(null)") + " != " + expected;
            tifiles_filename_free(filename);
            return error.c_str();
        }
        for (const char* p = filename; *p; p = g_utf8_next_char(p)) {
            const gunichar ch = g_utf8_get_char(p);
            assert(((ch >= 0x20 && ch <= 0x7e) || (ch >= 0xa0 && ch <= 0xff))
                && g_unichar_isprint(ch));
        }
        tifiles_filename_free(filename);
    }
    return "";
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* test_var_name_setup(int model, int type,
                                                               const char* raw_hex,
                                                               const char* folder_hex) {
    strcpy(name_test_os_version, "3.10");
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
    if (tifiles_calc_is_tinspire(g_calc_model) && type == NSP_TNS) {
        strcpy(entry.filename, entry.name);
        const size_t len = strlen(entry.name);
        if (len > 4 && !g_ascii_strcasecmp(entry.name + len - 4, ".tns")) entry.name[len - 4] = 0;
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
    callbacks.send_var = capture_send;
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

extern "C" EMSCRIPTEN_KEEPALIVE void test_var_name_version(const char* version) {
    assert(strlen(version) < sizeof(name_test_os_version));
    strcpy(name_test_os_version, version);
}

extern "C" EMSCRIPTEN_KEEPALIVE void test_var_name_real_folder_delete() {
    auto callbacks = name_test_original_calc->fncts;
    callbacks.get_version = name_test_version;
    name_test_capture_calc = new CalcFncts{g_calc_model, "test", "test", "test",
        name_test_original_calc->features, name_test_original_calc->product_id, {}, callbacks};
    g_calc_handle->calc = name_test_capture_calc;
    name_test_calls = 0;
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* test_var_name_captured_hex(int field) {
    const char* value = field == 0 ? name_test_old.name : field == 1 ? name_test_old.folder
        : field == 2 ? name_test_new.name : field == 3 ? name_test_new.folder
        : field == 4 ? name_test_old.filename : name_test_new.filename;
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

extern "C" EMSCRIPTEN_KEEPALIVE const char* test_other_subtype_json(int model, int type, const char* hex, int container) {
    assert(strlen(hex) % 2 == 0);
    std::vector<uint8_t> data(strlen(hex) / 2);
    for (size_t i = 0; i < data.size(); ++i) {
        unsigned value;
        assert(sscanf(hex + 2 * i, "%2x", &value) == 1);
        data[i] = value;
    }
    VarEntry entry{};
    strcpy(entry.name, "test");
    entry.type = type;
    entry.size = data.size();
    entry.data = data.data();
    GString* json = g_string_new(nullptr);
    append_var_entry_json_with_container(json, &entry, static_cast<CalcModel>(model), container ? "var" : nullptr, 0);
    static std::string result;
    result = json->str;
    g_string_free(json, TRUE);
    return result.c_str();
}

extern "C" EMSCRIPTEN_KEEPALIVE void test_var_name_files() {
    // Write through the legacy model so the file header holds literal bytes,
    // independently of the USB name conversion exercised when sending it.
    for (const char* name : {"atmOS0", "btmOS0", "ctmOS0", "AtmOS0", "Pic1", "GDB1", "Str1", "abcdefgh"}) {
        FileContent* appvar = tifiles_content_create_regular(CALC_TI83P);
        appvar->num_entries = 1;
        appvar->entries = tifiles_ve_create_array(1);
        VarEntry* entry = appvar->entries[0] = tifiles_ve_create();
        strcpy(entry->name, name);
        entry->type = 0x15;
        entry->size = 3; // One data byte following its two-byte size.
        entry->data = static_cast<uint8_t*>(g_malloc0(entry->size));
        entry->data[0] = 1;
        const std::string path = std::string("/") + name + ".8xv";
        assert(tifiles_file_write_regular(path.c_str(), appvar, nullptr) == 0);
        tifiles_content_delete_regular(appvar);
    }
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

extern "C" EMSCRIPTEN_KEEPALIVE int test_lab_report_aliases() {
    std::string extensions = "," + std::string(get_file_extensions(CALC_TI89)) + ",";
    for (const char* ext : {"89r", "92r", "9xr", "v2r"}) {
        assert(extensions.find("," + std::string(ext) + ",") != std::string::npos);
    }

    FileContent* report = tifiles_content_create_regular(CALC_TI89);
    assert(report);
    report->num_entries = 2;
    report->entries = tifiles_ve_create_array(2);
    for (unsigned int i = 0; i < report->num_entries; ++i) {
        VarEntry* entry = report->entries[i] = tifiles_ve_create();
        assert(entry);
        strcpy(entry->name, i ? "TWO" : "ONE");
        strcpy(entry->folder, "main");
        entry->type = 0x12; // TI-68k program
        entry->attr = ATTRB_ARCHIVED;
        entry->size = 3;
        entry->data = static_cast<uint8_t*>(g_malloc0(entry->size));
    }
    assert(tifiles_file_write_regular("/report.89g", report, nullptr) == 0);
    tifiles_content_delete_regular(report);

    // Keep the ordinary 68k group signature and change only the historical
    // filename alias, proving that inspection does not invent a new vartype.
    char* bytes = nullptr;
    gsize length = 0;
    assert(g_file_get_contents("/report.89g", &bytes, &length, nullptr));
    assert(g_file_set_contents("/report.89r", bytes, length, nullptr));
    g_free(bytes);
    unlink("/report.89g");

    const char* metadata = file_get_entries_json("/report.89r");
    assert(metadata && strstr(metadata, "\"class\":\"group\""));
    assert(strstr(metadata, "\"name\":\"ONE\"") && strstr(metadata, "\"name\":\"TWO\""));

    g_calc_model = CALC_TI89;
    g_cable_handle = ticables_handle_new(CABLE_NUL, PORT_1);
    assert(g_cable_handle);
    CableFncts* original_cable = g_cable_handle->cable;
    g_calc_handle = ticalcs_handle_new(g_calc_model);
    assert(g_calc_handle);
    CalcFncts* original_calc = g_calc_handle->calc;
    assert(ticalcs_cable_attach(g_calc_handle, g_cable_handle) == 0);
    auto callbacks = original_calc->fncts;
    callbacks.send_var = capture_lab_report;
    CalcFncts* capture_calc = new CalcFncts{g_calc_model, "test", "test", "test",
        original_calc->features, original_calc->product_id, {}, callbacks};
    g_calc_handle->calc = capture_calc;
    g_calc_attached = g_calc_ready = 1;
    assert(send_file_entry_custom(g_cable_handle, "/report.89r", 1, 0, "", 1, 0)
        == TICABLES_ERR_READ_TIMEOUT);

    g_calc_handle->calc = original_calc;
    delete capture_calc;
    ticalcs_cable_detach(g_calc_handle);
    ticalcs_handle_del(g_calc_handle);
    g_calc_handle = nullptr;
    g_calc_attached = g_calc_ready = 0;
    g_cable_handle->cable = original_cable;
    ticables_handle_del(g_cable_handle);
    g_cable_handle = nullptr;
    unlink("/report.89r");
    return 0;
}
