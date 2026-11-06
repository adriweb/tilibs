// The real bridge and protocol libraries, with scripted calculator replies.
#include "../webtilp.cpp"
#define main dbus_protocol_main
#include "../../libticalcs/trunk/tests/test_dbus_protocol.cc"
#undef main
#include <deque>

namespace {
std::deque<unsigned int> gc_send_results, gc_ready_results;
std::vector<std::string> gc_calls;
int gc_result(std::deque<unsigned int>& results) {
    CHECK(!results.empty());
    const unsigned int raw = results.front();
    results.pop_front();
    if (raw <= 511) return raw;
    const uint8_t data[] = {uint8_t(raw >> 8), uint8_t(raw)};
    return ticalcs_evo_error_set(data, 2);
}
int gc_send(CalcHandle*, CalcMode, FileContent* content) {
    CHECK(content->num_entries == 1);
    gc_calls.push_back(std::string("send:") + content->entries[0]->name);
    CHECK(ticables_get_timeout(g_cable_handle) == 250);
    return gc_result(gc_send_results);
}
int gc_ready(CalcHandle*) {
    gc_calls.push_back("ready");
    CHECK(ticables_get_timeout(g_cable_handle) == 10);
    return gc_result(gc_ready_results);
}
void gc_fixture() {
    FileContent* content = tifiles_content_create_regular(CALC_TI83P);
    content->num_entries = 2;
    content->entries = tifiles_ve_create_array(2);
    for (unsigned int i = 0; i < 2; i++) {
        VarEntry* entry = content->entries[i] = tifiles_ve_create();
        strcpy(entry->name, i ? "TWO" : "ONE");
        entry->type = 0x15;
        entry->size = 3;
        entry->data = static_cast<uint8_t*>(g_malloc0(3));
        entry->data[0] = 1;
    }
    CHECK(tifiles_file_write_regular("/gc.8xg", content, nullptr) == 0);
    tifiles_content_delete_regular(content);
}
}

extern "C" EMSCRIPTEN_KEEPALIVE int test_flash_gc() {
    // Includes DUSB repeated WAIT/error/timeout and actual DBUS Flash sends.
    check_dusb_gc_waits();
    check_dusb_greet_recovery();
    check_dusb_cancellation();
    check_transfer_error_details();
    check_68k_flash_waits();
    check_ti86_rts_retry();
    check_dbus_flash_gc();
    ensure_update_callbacks();
    g_calc_model = CALC_TI83EVO_USB;
    g_cable_handle = ticables_handle_new(CABLE_NUL, PORT_1);
    g_calc_handle = ticalcs_handle_new(g_calc_model);
    CHECK(ticalcs_cable_attach(g_calc_handle, g_cable_handle) == 0);
    ticalcs_update_set(g_calc_handle, &g_update);
    CalcFncts* original = g_calc_handle->calc;
    auto callbacks = original->fncts;
    callbacks.send_var = gc_send;
    callbacks.is_ready = gc_ready;
    CalcFncts mock{g_calc_model, "gc-test", "gc-test", "gc-test",
        original->features, original->product_id, {}, callbacks};
    g_calc_handle->calc = &mock;
    g_calc_attached = g_calc_ready = 1;
    ticables_options_set_timeout(g_cable_handle, 250);
    gc_fixture();

    gc_send_results = {0, 0x4452, 0}; // ONE is complete; only TWO needs retry.
    gc_ready_results = {0x425a, ERROR_READ_TIMEOUT, 0};
    CHECK(send_file_custom(g_cable_handle, "/gc.8xg", "", 1, 0) == 0);
    CHECK(gc_calls == std::vector<std::string>({"send:ONE", "send:TWO", "ready", "ready", "ready", "send:TWO"}));
    CHECK(g_calc_ready == 1 && ticables_get_timeout(g_cable_handle) == 250);

    gc_calls.clear();
    gc_send_results = {0x4452, 0};
    gc_ready_results = {0};
    CHECK(send_file_entry_custom(g_cable_handle, "/gc.8xg", 1, 0, "", 1, 0) == 0);
    CHECK(gc_calls == std::vector<std::string>({"send:TWO", "ready", "send:TWO"}));

    for (unsigned int error : {0x4c42U, unsigned(ERROR_READ_TIMEOUT), 0x4452U}) {
        gc_calls.clear();
        gc_send_results = {error, error, error};
        gc_ready_results = {0, 0};
        const int result = send_file_entry_custom(g_cable_handle, "/gc.8xg", 0, 0, "", 1, 0);
        if (error > 511) CHECK(evo_result_is(result, error));
        else CHECK(result == int(error));
        CHECK(gc_calls.size() == (error == 0x4452 ? 5 : 1));
        CHECK(ticables_get_timeout(g_cable_handle) == 250);
    }
    CHECK(g_calc_ready == 0);
    CHECK(wait_after_defrag(g_get_monotonic_time() - 1) == ERROR_READ_TIMEOUT);
    CHECK(ticables_get_timeout(g_cable_handle) == 250);
    g_update.cancel = 1;
    CHECK(wait_after_defrag(g_get_monotonic_time() + 10000000) == TICALCS_ERR_ABORT);
    g_update.cancel = 0;

    g_calc_handle->calc = original;
    ticalcs_cable_detach(g_calc_handle);
    ticalcs_handle_del(g_calc_handle);
    ticables_handle_del(g_cable_handle);
    g_calc_handle = nullptr;
    g_cable_handle = nullptr;
    g_calc_attached = g_calc_ready = 0;
    puts("Flash GC protocol and bridge retry tests passed.");
    return 0;
}
