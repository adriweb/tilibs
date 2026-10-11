#include "ti_transfers.h"
#include "ti_file_io.h"
#include "ti_session.h"
#include <cstring>
#include <cstdio>
#include <glib.h>
#include <ticonv.h>

namespace ti {
static void apply_var_entry_overrides(VarEntry* ve, const char* folder, int location) {
    if (!ve) {
        return;
    }

    if (folder && *folder) {
        char* raw_folder = ticonv_varname_tokenize(current_model(), folder, ve->type);
        if (raw_folder) {
            if (strncmp(ve->folder, raw_folder, sizeof(ve->folder)) != 0) {
                strncpy(ve->folder, raw_folder, sizeof(ve->folder) - 1);
                ve->folder[sizeof(ve->folder) - 1] = '\0';
            }
            ticonv_varname_free(raw_folder);
        }
    }
    if (location == 0) {
        if (ve->attr != ATTRB_NONE) {
            ve->attr = ATTRB_NONE;
        }
    } else if (location == 1) {
        if (ve->attr != ATTRB_ARCHIVED) {
            ve->attr = ATTRB_ARCHIVED;
        }
    } else if (location != -1) {
        printf("WARN: Unknown location override %d\n", location);
    }

    // This is a transient entry loaded for sending, not the user's source file.
    // Use the current connection's device info to avoid a known-bad first send.
    if (ticonv_model_is_tievo(current_model()) && evo_python_type()
        && ve->type != evo_python_type() && tifiles_evo_is_python_module(ve->data, ve->size)) {
        uint8_t* converted = nullptr;
        uint32_t converted_size = 0;
        if (!tifiles_evo_repack_python_module(ve->data, ve->size, &converted, &converted_size)) {
            printf("Repackaging %s as %s for the connected Evo OS\n", ve->name, evo_python_type() == 18 ? "8mp2" : "8xpy2");
            tifiles_ve_free_data(ve->data);
            ve->data = converted;
            ve->size = converted_size;
            ve->type = (uint8_t)evo_python_type();
            ve->attr = ATTRB_ARCHIVED;
        }
    }
}

static RegularContent create_single_entry_content(const FileContent* source, VarEntry* source_entry) {
    if (!source || !source_entry) {
        return {};
    }

    RegularContent single(tifiles_content_create_regular(source->model));
    if (!single) {
        return {};
    }

    single->model = source->model;
    single->model_dst = source->model_dst;
    single->checksum = source->checksum;
    single->stored_checksum = source->stored_checksum;
    strncpy(single->default_folder, source->default_folder, sizeof(single->default_folder) - 1);
    single->default_folder[sizeof(single->default_folder) - 1] = '\0';
    strncpy(single->comment, source->comment, sizeof(single->comment) - 1);
    single->comment[sizeof(single->comment) - 1] = '\0';
    single->entries = tifiles_ve_create_array(1);
    if (!single->entries) {
        return {};
    }
    single->entries[0] = tifiles_ve_dup(source_entry);
    if (!single->entries[0]) {
        return {};
    }
    single->num_entries = 1;

    return single;
}

static CalcMode var_send_mode(int defer_eot) {
    // TI-82/85 keep receiving until the caller explicitly ends the batch.
    return !defer_eot && (current_model() == CALC_TI82 || current_model() == CALC_TI85)
        ? MODE_SEND_LAST_VAR : MODE_NORMAL;
}


static int send_regular_content(RegularContent content, const char* folder, int location, int defer_eot) {
    for (unsigned i = 0; i < content->num_entries; ++i)
        apply_var_entry_overrides(content->entries[i], folder, location);
    return ticalcs_calc_send_var(calculator(), var_send_mode(defer_eot), content.get());
}

static int send_selected_regular(const FileContent& content, unsigned index,
                                  const char* folder, int location, int defer_eot) {
    if (index >= content.num_entries || !content.entries[index]) return ERR_WEB_INVALID_ENTRY_INDEX;
    auto single = create_single_entry_content(&content, content.entries[index]);
    if (!single) return ERR_WEB_OUT_OF_MEMORY;
    return send_regular_content(std::move(single), folder, location, defer_eot);
}

static int validate_transfer_file(const char* filename) {
    if (!filename || !*filename) return ERR_WEB_INVALID_ARGUMENT;
    if (!tifiles_file_is_ti(filename)) return ERR_WEB_NOT_TI_FILE;
    return 0;
}

int finish_var_send(CableHandle* cable_handle) {
    if (current_model() != CALC_TI82 && current_model() != CALC_TI85) return 0;
    if (!is_attached_owned_cable(cable_handle)) return ERR_WEB_INVALID_ARGUMENT;
    // End an empty or completed batch without sending another VAR.
    FileContent content{};
    content.model = content.model_dst = current_model();
    return ticalcs_calc_send_var(calculator(), MODE_SEND_LAST_VAR, &content);
}

int send_file_custom(CableHandle* cable_handle, const char* filename, const char* folder, int location, int defer_eot) {
    int result = validate_transfer_file(filename);
    if (result) return result;
    printf("=== Sending File: %s ===\n", filename);
    const bool is_os = tifiles_file_is_os(filename);
    // OS boot/receive mode cannot answer the normal ready query.
    result = is_os ? ensure_calc_handle_attached(cable_handle) : ensure_calc_ready(cable_handle, 0);
    if (result) return result;
    if (is_os) {
        result = ticalcs_calc_send_os2(calculator(), filename);
    } else if (tifiles_file_is_app(filename)) {
        result = ticalcs_calc_send_app2(calculator(), filename);
    } else if (tifiles_file_is_tigroup(filename)) {
        result = ticalcs_calc_send_tigroup2(calculator(), filename, (TigMode)(TIG_ALL | TIG_BACKUP));
    } else if (tifiles_file_get_class(filename) == TIFILE_BACKUP) {
        result = ticalcs_calc_send_backup2(calculator(), filename);
    } else {
        auto content = load_regular(filename, current_model(), result);
        if (content) result = send_regular_content(std::move(content), folder, location, defer_eot);
    }
    printf("Send result: %d\n", result);
    return result;
}

int send_file_entry_custom(CableHandle* cable_handle, const char* filename, int entry_index, int container_kind,
                           const char* folder, int location, int defer_eot) {
    if (!filename || !*filename) return ERR_WEB_INVALID_ARGUMENT;
    if (entry_index < 0) return ERR_WEB_INVALID_ENTRY_INDEX;
    int result = validate_transfer_file(filename);
    if (result) return result;
    printf("=== Sending File Entry: %s [index=%d kind=%d] ===\n", filename, entry_index, container_kind);
    result = ensure_calc_ready(cable_handle, 0);
    if (result) return result;
    if (tifiles_file_get_class(filename) == TIFILE_TIGROUP) {
        auto content = load_tigroup(filename, current_model(), result);
        if (!content) return result;
        if (container_kind == 2) {
            if ((unsigned)entry_index >= content->n_apps || !content->app_entries[entry_index]
                || !content->app_entries[entry_index]->content.flash) return ERR_WEB_INVALID_ENTRY_INDEX;
            result = ticalcs_calc_send_app(calculator(), content->app_entries[entry_index]->content.flash);
        } else {
            if ((unsigned)entry_index >= content->n_vars || !content->var_entries[entry_index]
                || !content->var_entries[entry_index]->content.regular) return ERR_WEB_INVALID_ENTRY_INDEX;
            result = send_selected_regular(*content->var_entries[entry_index]->content.regular, 0, folder, location, defer_eot);
        }
    } else {
        auto content = load_regular(filename, current_model(), result);
        if (!content) return result;
        result = send_selected_regular(*content, entry_index, folder, location, defer_eot);
    }
    printf("Send entry result: %d\n", result);
    return result;
}
} // namespace ti
