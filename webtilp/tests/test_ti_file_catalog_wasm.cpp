// Exercise catalog source/destination handling and the public ABI against real
// libtifiles readers. Compiled as a separate translation unit from the bridge.
#include "../webtilp.h"
#include "../ti_file_catalog.h"
#include "../ti_file_io.h"
#include "../ti_session.h"
#include <emscripten.h>
#include <cassert>
#include <cstdio>
#include <cstring>
#include <glib.h>
#include <ticonv.h>

namespace {
ti::RegularContent fixture(CalcModel source, unsigned count) {
    ti::RegularContent content(tifiles_content_create_regular(source));
    assert(content);
    content->num_entries = count;
    content->entries = tifiles_ve_create_array(count);
    for (unsigned i = 0; i < count; ++i) {
        VarEntry* entry = content->entries[i] = tifiles_ve_create();
        assert(entry);
        strcpy(entry->name, i ? "TWO" : "ONE");
        entry->type = source == CALC_TI82 ? 5 : 12;
        entry->size = 3;
        entry->data = static_cast<uint8_t*>(g_malloc0(3));
    }
    return content;
}

ti::RegularContent theta_fixture() {
    auto content = fixture(CALC_TI83P, 1);
    VarEntry* entry = content->entries[0];
    entry->type = 5; // Legacy TI-83 Plus program.
    memset(entry->name, 0, sizeof(entry->name));
    entry->name[0] = 0x5b; // Theta in the legacy calculator character set.
    entry->name[1] = 'P';
    return content;
}
}

extern "C" EMSCRIPTEN_KEEPALIVE int test_ti_catalog() {
    auto content = fixture(CALC_TI82, 2);
    assert(tifiles_file_write_regular("/catalog.82g", content.get(), nullptr) == 0);
    auto single = fixture(CALC_TI82, 1);
    assert(tifiles_file_write_regular("/catalog.82p", single.get(), nullptr) == 0);

    // Connected destination differs from the file: names/types use the source.
    set_calc_model(CALC_TI85);
    const auto description = ti::inspect_file("/catalog.82g", CALC_TI85);
    assert(description.entries.size() == 2);
    assert(description.entries[0].type_name == tifiles_vartype2type(CALC_TI82, 5));
    assert(description.entries[0].name == "ONE");
    assert(description.entries[1].name == "TWO");
    int error = 0;
    auto received = ti::load_regular("/catalog.82g", CALC_TI85, error);
    assert(received && error == 0);
    assert(received->model == CALC_TI82 && received->model_dst == CALC_TI85);

    // Name conversion uses the bounded source bytes before touching ticonv.
    VarEntry token{};
    token.type = 1;
    token.name[0] = 0x5d; token.name[1] = 1;
    char expected[VARNAME_MAX * 4] = {};
    assert(ticonv_varname_to_utf8_sn(CALC_TI82, token.name, expected, sizeof(expected), token.type));
    const auto token_description = ti::describe_entry(token, CALC_TI82, CALC_TI85);
    assert(token_description.name == expected);
    VarEntry full{};
    full.type = 5;
    memset(full.name, 'A', sizeof(full.name));
    memset(full.folder, 'B', sizeof(full.folder));
    assert(!ti::describe_entry(full, CALC_TI89, CALC_TI89).name.empty());

    FILE* directory = fopen("/catalog-dir.json", "wb");
    assert(directory);
    ti::write_var_entry_json(directory, content->entries[0], "var", CALC_TI82);
    assert(fclose(directory) == 0);

    // Preserve per-member models and indices when extracting a TiGroup catalog.
    ti::TigroupContent group(tifiles_content_create_tigroup(CALC_TI82, 0));
    TigEntry* member = tifiles_te_create("one.82p", TIFILE_SINGLE, CALC_TI82);
    assert(member);
    tifiles_content_delete_regular(member->content.regular);
    member->content.regular = fixture(CALC_TI82, 1).release();
    assert(tifiles_content_add_te(group.get(), member) > 0);
    assert(tifiles_file_write_tigroup("/catalog.tig", group.get()) == 0);
    const auto bundled = ti::inspect_file("/catalog.tig", CALC_TI85);
    assert(bundled.entries.size() == 1);
    assert(bundled.entries[0].container_type == "var" && bundled.entries[0].container_index == 0);
    assert(bundled.entries[0].type_name == description.entries[0].type_name);

    assert(send_file_custom(nullptr, "", "", -1, 0) == ti::ERR_WEB_INVALID_ARGUMENT);
    assert(send_file_entry_custom(nullptr, "file", -1, 0, "", -1, 0) == ti::ERR_WEB_INVALID_ENTRY_INDEX);
    assert(!ti::load_regular(nullptr, CALC_TI82, error) && error == ti::ERR_WEB_INVALID_ARGUMENT);

    // The file signature identifies a legacy model, but the .8ep extension
    // makes the reader normalize its names to the CE USB representation.
    auto theta = theta_fixture();
    char theta_expected[VARNAME_MAX * 4] = {};
    assert(ticonv_varname_to_utf8_sn(CALC_TI83P, theta->entries[0]->name,
        theta_expected, sizeof(theta_expected), theta->entries[0]->type));
    assert(std::string(theta_expected) == u8"θP");
    assert(tifiles_file_write_regular("/encoded.8xp", theta.get(), nullptr) == 0);
    assert(tifiles_file_write_regular("/encoded.8ep", theta.get(), nullptr) == 0);
    const auto legacy_theta = ti::inspect_file("/encoded.8xp", CALC_TI85);
    const auto usb_theta = ti::inspect_file("/encoded.8ep", CALC_TI85);
    assert(legacy_theta.entries.size() == 1 && usb_theta.entries.size() == 1);
    assert(legacy_theta.entries[0].name == theta_expected);
    assert(usb_theta.entries[0].name == theta_expected);
    auto usb_content = ti::load_regular("/encoded.8ep", CALC_TI84PCE_USB, error);
    assert(usb_content && error == 0);
    assert(usb_content->model == CALC_TI83P && usb_content->model_dst == CALC_TI84PCE_USB);
    assert(strcmp(usb_content->entries[0]->name, theta->entries[0]->name) != 0);

    // TiGroup parsing also normalizes each member to its requested destination
    // model. Display that representation once while retaining source types.
    ti::TigroupContent encoded_group(tifiles_content_create_tigroup(CALC_TI83P, 0));
    TigEntry* encoded_member = tifiles_te_create("encoded.8xp", TIFILE_SINGLE, CALC_TI83P);
    assert(encoded_member);
    tifiles_content_delete_regular(encoded_member->content.regular);
    encoded_member->content.regular = theta_fixture().release();
    assert(tifiles_content_add_te(encoded_group.get(), encoded_member) > 0);
    assert(tifiles_file_write_tigroup("/encoded.tig", encoded_group.get()) == 0);
    const auto encoded_bundled = ti::inspect_file("/encoded.tig", CALC_TI84PCE_USB);
    assert(encoded_bundled.entries.size() == 1);
    assert(encoded_bundled.entries[0].name == theta_expected);
    assert(encoded_bundled.entries[0].type_name == legacy_theta.entries[0].type_name);
    assert(encoded_bundled.entries[0].container_type == "var"
        && encoded_bundled.entries[0].container_index == 0);

    // Reconfigure an owned null cable through the real public lifecycle.
    set_cable_model(CABLE_NUL);
    set_force_cable(1);
    set_force_calc(1);
    set_calc_model(CALC_TI82);
    CableHandle* cable = create_handle();
    assert(cable && create_handle() == cable);
    assert(is_ready(cable) == 0);
    assert(ti::calculator());
    CalcUpdate* progress = ti::calculator()->updat;
    assert(progress);
    progress->cnt1 = 1; progress->max1 = 10;
    progress->cnt2 = 2; progress->max2 = 20;
    progress->cnt3 = 7; progress->max3 = 100;
    progress->rate = 1.25f;
    memset(progress->text, 1, sizeof(progress->text));
    const char* progress_json = get_progress_info_json();
    assert(strlen(progress_json) > 1000);
    FILE* progress_file = fopen("/catalog-progress.json", "wb");
    assert(progress_file);
    assert(fwrite(progress_json, 1, strlen(progress_json), progress_file) == strlen(progress_json));
    assert(fclose(progress_file) == 0);
    uint32_t* tick = get_progress_tick_ptr();
    const uint32_t before = get_progress_tick_value();
    progress->label();
    assert(get_progress_tick_value() == before + 1 && *tick == before + 1);
    reset_progress_info();
    assert(progress->text[0] == 0 && progress->max3 == 0 && progress->cnt3 == 0);
    set_calc_model(CALC_TI85);
    assert(!ti::calculator());
    assert(get_calc_model_id() == CALC_TI85);
    assert(get_progress_info_json()[0] == 0);
    assert(create_handle() == cable && is_ready(cable) == 0);
    assert(close_cable(cable) == 0);
    notify_usb_disconnect();
    assert(!ti::calculator() && get_progress_tick_ptr() == tick);
    assert(consume_cable_reopen_flag() == 0);
    assert(consume_model_update_info()[0] == 0);
    clear_native_warnings();
    assert(get_native_warnings()[0] == 0);
    puts("TI catalog model, bounded names, TiGroup and transfer argument tests passed");
    return 0;
}
