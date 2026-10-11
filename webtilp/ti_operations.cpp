#include "ti_operations.h"
#include "ti_session.h"
#include "ti_file_catalog.h"
#include "ti_backup_vat.h"
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
#include <unistd.h>
#include <glib.h>
#include <ticonv.h>
#include <nsp_cmd.h>

namespace ti {
static int model_supports_rclwindw_leave_exam(CalcModel model)
{
    return model == CALC_TI84PCE_USB
        || model == CALC_TI83PCE_USB
        || model == CALC_TI84PT_USB
        || model == CALC_TI82A_USB
        || model == CALC_TI82AEP_USB
        || ticonv_model_is_tievo(model);
}

static uint8_t rclwindw_type_for_model(CalcModel model)
{
    return ticonv_model_is_tievo(model) ? WEBTILP_EVO_TYPE_RCL_WINDOW : TI84p_ZSTO;
}

static int write_last_path(const char* path)
{
    const char* out_path = "/last_recv_path.txt";
    FILE* fp = fopen(out_path, "wb");
    if (!fp) {
        return -1;
    }
    fwrite(path, 1, strlen(path), fp);
    fclose(fp);
    return 0;
}

static int tilp_calc_check_version(const char *ti9x_ver)
{
    if (tifiles_is_flash(current_model()) && ticonv_model_is_ti68k(current_model()))
    {
        CalcInfos infos;
        usleep(100000);
        if (ticalcs_calc_get_version(calculator(), &infos) != 0)
        {
            return -1;
        }

        usleep(100000);

        if (strcmp(infos.os_version, ti9x_ver) < 0)
        {
            printf("You need AMS >=%s mini for this operation.", ti9x_ver);
            return -1;
        }
    }

    return 0;
}

const char* get_backup_ext(void) {
    if (!calculator()) {
        return nullptr;
    }
    // Match the native-backup / grouped-variables choice in recv_backup2.
    return (ticalcs_calc_features(calculator()) & FTS_BACKUP)
        ? tifiles_fext_of_backup(calculator()->model)
        : tifiles_fext_of_group(calculator()->model);
}

const char* get_error_message(int code) {
    static char buf[256];
    char* message = nullptr;
    enum class ErrorSource {
        NONE,
        TICALCS,
        TICABLES,
        TIFILES
    } source = ErrorSource::NONE;

    int ret = ticalcs_error_get(code, &message);
    if (ret == 0 && message != nullptr) {
        source = ErrorSource::TICALCS;
    }
    if (ret != 0 || message == nullptr) {
        message = nullptr;
        ret = ticables_error_get(code, &message);
        if (ret == 0 && message != nullptr) {
            source = ErrorSource::TICABLES;
        }
    }
    if (ret != 0 || message == nullptr) {
        message = nullptr;
        ret = tifiles_error_get(code, &message);
        if (ret == 0 && message != nullptr) {
            source = ErrorSource::TIFILES;
        }
    }
    if (ret != 0 || message == nullptr) {
        switch (code) {
            case ERR_WEB_INVALID_ARGUMENT:
                return "invalid or missing argument";
            case ERR_WEB_NOT_TI_FILE:
                return "not a recognized TI file";
            case ERR_WEB_INVALID_ENTRY_INDEX:
                return "invalid entry selection/index";
            case ERR_WEB_OUT_OF_MEMORY:
                return "out of memory";
            default:
                return "";
        }
    }
    strncpy(buf, message, sizeof(buf) - 1);
    buf[sizeof(buf) - 1] = '\0';
    switch (source) {
        case ErrorSource::TICALCS:
            ticalcs_error_free(message);
            break;
        case ErrorSource::TICABLES:
            ticables_error_free(message);
            break;
        case ErrorSource::TIFILES:
            tifiles_error_free(message);
            break;
        default:
            break;
    }
    return buf;
}

uint16_t get_raw_protocol_code(int number) {
    uint16_t raw = 0;
    if (ticalcs_error_get_raw_protocol_code(number, &raw) != 0) {
        return 0;
    }
    return raw;
}

int calc_screenshot(CableHandle* cable_handle) {
    if (!cable_handle) {
        printf("ERROR: NULL cable handle provided\n");
        return -1;
    }

    printf("=== Testing Calculator Screenshot ===\n");
    const int ready_result = ensure_calc_ready(cable_handle, 0);
    if (ready_result != 0) {
        return ready_result;
    }

    CalcScreenCoord sc;
    uint8_t* bitmap = nullptr;

    printf("Receiving screenshot from calculator...\n");
    const int result = ticalcs_calc_recv_screen_rgb888(calculator(), &sc, &bitmap);

    if (result == 0 && bitmap) {
        printf("Screenshot received successfully!\n");
        printf("  Format: RGB888\n");
        printf("  Width: %u\n", sc.width);
        printf("  Height: %u\n", sc.height);
        printf("  Clipped width: %u\n", sc.clipped_width);
        printf("  Clipped height: %u\n", sc.clipped_height);
        printf("  Pixel format: %d\n", sc.pixel_format);

        unsigned int out_width = sc.width;
        unsigned int out_height = sc.height;
        const uint8_t* out_bitmap = bitmap;

        if (sc.clipped_width && sc.clipped_height &&
            (sc.clipped_width < sc.width || sc.clipped_height < sc.height)) {
            out_width = sc.clipped_width;
            out_height = sc.clipped_height;
            for (unsigned int row = 0; row < out_height; row++) {
                memmove(bitmap + row * out_width * 3,
                        bitmap + row * sc.width * 3,
                        out_width * 3);
            }
            printf("  Output width: %u\n", out_width);
            printf("  Output height: %u\n", out_height);
        }

        printf("  Total size: %u bytes\n", (unsigned int)((size_t)out_width * out_height * 3));

        // Persist screenshot to a shared file for the JS side to render
        const size_t total_size = (size_t)out_width * out_height * 3;
        const char* path = "/screenshot.bin";
        FILE* fp = fopen(path, "wb");
        if (fp) {
            const uint32_t width_le = out_width;
            const uint32_t height_le = out_height;

            if (fwrite(&width_le, sizeof(uint32_t), 1, fp) != 1 ||
                fwrite(&height_le, sizeof(uint32_t), 1, fp) != 1 ||
                fwrite(out_bitmap, 1, total_size, fp) != total_size) {
                printf("ERROR: Failed to write complete screenshot file\n");
            } else {
                printf("Screenshot written to %s (%zu bytes)\n", path, total_size + 8);
            }
            fclose(fp);
        } else {
            printf("ERROR: Failed to open screenshot file for writing\n");
        }

        // Free the bitmap
        ticalcs_free_screen(bitmap);
    } else {
        printf("ERROR: Failed to receive screenshot (error %d)\n", result);
    }

    return result;
}

uint32_t calc_features(CableHandle* cable_handle) {
    if (!cable_handle) {
        printf("ERROR: NULL cable handle provided\n");
        return 0;
    }
    const int attach_result = ensure_calc_handle_attached(cable_handle);
    if (attach_result != 0) {
        return 0;
    }
    return (uint32_t)ticalcs_calc_features(calculator());
}

int calc_send_key(CableHandle* cable_handle, uint32_t key) {
    if (!cable_handle) {
        printf("ERROR: NULL cable handle provided\n");
        return -1;
    }
    const int ready_result = ensure_calc_ready(cable_handle, 0);
    if (ready_result != 0) {
        return ready_result;
    }
    return ticalcs_calc_send_key(calculator(), key);
}

const char* calc_get_clock_json(CableHandle* cable_handle) {
    if (!cable_handle) {
        printf("ERROR: NULL cable handle provided\n");
        return "";
    }

    if (ensure_calc_ready(cable_handle, 0) != 0) {
        return "";
    }

    if (tilp_calc_check_version("2.06") < 0)
    {
        return "";
    }

    static char clock_buf[256];
    CalcClock clock{};

    const int result = ticalcs_calc_get_clock(calculator(), &clock);
    if (result != 0) {
        printf("ERROR: Failed to get clock (error %d)\n", result);
        return "";
    }

    snprintf(clock_buf, sizeof(clock_buf),
             "{\"year\":%u,\"month\":%u,\"day\":%u,\"hours\":%u,\"minutes\":%u,\"seconds\":%u,"
             "\"time_format\":%u,\"date_format\":%u,\"state\":%d}",
             (unsigned int)clock.year, (unsigned int)clock.month, (unsigned int)clock.day,
             (unsigned int)clock.hours, (unsigned int)clock.minutes, (unsigned int)clock.seconds,
             (unsigned int)clock.time_format, (unsigned int)clock.date_format, clock.state);
    return clock_buf;
}

int calc_set_clock(CableHandle* cable_handle, int year, int month, int day, int hours, int minutes, int seconds,
    int time_format, int date_format, int state) {
    if (!cable_handle) {
        printf("ERROR: NULL cable handle provided\n");
        return -1;
    }

    const int ready_result = ensure_calc_ready(cable_handle, 0);
    if (ready_result != 0) {
        return ready_result;
    }

    CalcClock clock{};
    clock.year = (uint16_t)year;
    clock.month = (uint8_t)month;
    clock.day = (uint8_t)day;
    clock.hours = (uint8_t)hours;
    clock.minutes = (uint8_t)minutes;
    clock.seconds = (uint8_t)seconds;
    clock.time_format = (uint8_t)time_format;
    clock.date_format = (uint8_t)date_format;
    clock.state = state;

    return ticalcs_calc_set_clock(calculator(), &clock);
}

int calc_sync_clock(CableHandle* cable_handle, int offset_minutes) {
    if (!cable_handle || offset_minutes < -120 || offset_minutes > 120) {
        return ERR_WEB_INVALID_ARGUMENT;
    }
    const int ready_result = ensure_calc_ready(cable_handle, 0);
    if (ready_result) return ready_result;
    if (tilp_calc_check_version("2.06") < 0) return -1;
    return ticalcs_calc_sync_clock(calculator(), offset_minutes * 60);
}

int calc_dirlist_json(CableHandle* cable_handle, const char* path) {
    if (!cable_handle) {
        printf("ERROR: NULL cable handle provided\n");
        return -1;
    }

    const char* out_path = (path && *path) ? path : "/dirlist.json";
    const int ready_result = ensure_calc_ready(cable_handle, 0);
    if (ready_result != 0) {
        return ready_result;
    }

    GNode* vars = nullptr;
    GNode* apps = nullptr;
    const int result = ticalcs_calc_get_dirlist(calculator(), &vars, &apps);
    if (result != 0) {
        return result;
    }

    int mem_ok = 0;
    uint32_t ram_free = 0, flash_free = 0;
    if(ticalcs_calc_features(calculator()) & FTS_MEMFREE) {
        usleep(150000);
        mem_ok = (ticalcs_calc_get_memfree(calculator(), &ram_free, &flash_free) == 0);
    }

    FILE* fp = fopen(out_path, "wb");
    if (!fp) {
        ticalcs_dirlist_destroy(&vars);
        ticalcs_dirlist_destroy(&apps);
        return -2;
    }

    fprintf(fp, R"({"memory":{"ram_free":%u,"flash_free":%u,"ok":%d},"vars":[)",
            (unsigned int)ram_free, (unsigned int)flash_free, mem_ok);
    int first = 1;
    write_dirlist_json(fp, vars, "var", &first, current_model());
    fprintf(fp, "],\"apps\":[");
    first = 1;
    write_dirlist_json(fp, apps, "app", &first, current_model());
    fprintf(fp, "]}");
    fclose(fp);

    ticalcs_dirlist_destroy(&vars);
    ticalcs_dirlist_destroy(&apps);

    return 0;
}

int calc_backup_dirlist_json(const char* backup_path, const char* output_path) {
    if (!backup_path || !output_path || !*output_path) return -1;
    const int model = current_model() == CALC_TI82 ? 82 : current_model() == CALC_TI85 ? 85 : 0;
    if (!model) return -2;
    gchar* contents = nullptr;
    gsize length = 0;
    if (!g_file_get_contents(backup_path, &contents, &length, nullptr)) return -3;
    if (length >= 65536) { g_free(contents); return -4; }
    const std::vector<uint8_t> file(contents, contents + length);
    g_free(contents);
    std::vector<TiBackupVatEntry> entries;
    std::string error;
    if (!parse_ti_backup_vat(file, model, entries, error)) {
        printf("Backup listing failed: %s\n", error.c_str());
        return -4;
    }
    FILE* fp = fopen(output_path, "w");
    if (!fp) return -5;
    fprintf(fp, "{\"vars\":[");
    bool first = true;
    for (const auto& entry : entries) {
        VarEntry ve{};
        ve.type = entry.type;
        ve.size = entry.size;
        memcpy(ve.name, entry.name.data(), entry.name.size());
        if (!first) fputc(',', fp);
        first = false;
        write_var_entry_json(fp, &ve, "backup-var", current_model());
    }
    fprintf(fp, "],\"apps\":[]}");
    const bool failed = ferror(fp) != 0;
    const int close_result = fclose(fp);
    return failed || close_result != 0 ? -5 : 0;
}

int calc_recv_backup(CableHandle* cable_handle, const char* path) {
    if (!cable_handle) {
        printf("ERROR: NULL cable handle provided\n");
        return -1;
    }
    if (!path || !*path) {
        printf("ERROR: No backup path provided\n");
        return -2;
    }
    const int ready_result = ensure_calc_ready(cable_handle, 0);
    if (ready_result != 0) {
        return ready_result;
    }

    const int result = ticalcs_calc_recv_backup2(calculator(), path);
    if (result == 0) {
        write_last_path(path);
    }
    return result;
}

int calc_recv_tigroup(CableHandle* cable_handle, const char* path, int mode) {
    if (!cable_handle) {
        printf("ERROR: NULL cable handle provided\n");
        return -1;
    }
    if (!path || !*path) {
        printf("ERROR: No tigroup path provided\n");
        return -2;
    }
    const int ready_result = ensure_calc_ready(cable_handle, 0);
    if (ready_result != 0) {
        return ready_result;
    }

    const int result = ticalcs_calc_recv_tigroup2(calculator(), path, (TigMode)mode);
    if (result == 0) {
        write_last_path(path);
    }
    return result;
}

int calc_recv_os(CableHandle* cable_handle, const char* path) {
    if (!cable_handle) {
        printf("ERROR: NULL cable handle provided\n");
        return -1;
    }
    if (!path || !*path) {
        printf("ERROR: No OS output path provided\n");
        return -2;
    }
    const int ready_result = ensure_calc_ready(cable_handle, 0);
    if (ready_result != 0) {
        return ready_result;
    }

    const int result = ticalcs_calc_recv_os2(calculator(), path);
    if (result == 0) {
        write_last_path(path);
    }
    return result;
}

int calc_dump_rom_1(CableHandle* cable_handle) {
    if (!cable_handle) {
        printf("ERROR: NULL cable handle provided\n");
        return -1;
    }

    const int ready_result = ensure_calc_ready(cable_handle, 0);
    if (ready_result != 0) {
        return ready_result;
    }

    return ticalcs_calc_dump_rom_1(calculator());
}

int calc_dump_rom_2(CableHandle* cable_handle, int size, const char* path) {
    if (!cable_handle) {
        printf("ERROR: NULL cable handle provided\n");
        return -1;
    }
    if (!path || !*path) {
        printf("ERROR: No ROM dump path provided\n");
        return -2;
    }

    const int ready_result = ensure_calc_ready(cable_handle, 0);
    if (ready_result != 0) {
        return ready_result;
    }

    const int result = ticalcs_calc_dump_rom_2(calculator(), (CalcDumpSize)size, path);
    if (result == 0) {
        write_last_path(path);
    }
    return result;
}

int calc_leave_exam_mode(CableHandle* cable_handle) {
    if (!cable_handle) {
        printf("ERROR: NULL cable handle provided\n");
        return -1;
    }
    const int ready_result = ensure_calc_ready(cable_handle, 0);
    if (ready_result != 0) {
        return ready_result;
    }

    if (model_supports_rclwindw_leave_exam(current_model())) {
        VarRequest vr{};
        VarEntry ve{};

        strncpy(vr.name, "RclWindw", sizeof(vr.name));
        vr.type = rclwindw_type_for_model(current_model());
        strncpy(ve.name, vr.name, sizeof(ve.name));
        ve.type = vr.type;

        char* base = tifiles_build_filename(current_model(), &ve);
        if (!base) {
            return 512; // ERR_MALLOC
        }
        char* path = g_build_filename("/tmp", base, nullptr);
        tifiles_filename_free(base);
        if (!path) {
            return 512; // ERR_MALLOC
        }

        int ret = ticalcs_calc_recv_var2(calculator(), MODE_NORMAL, path, &vr);
        if (!ret) {
            ret = ticalcs_calc_send_var2(calculator(), MODE_NORMAL, path);
        }
        remove(path);
        g_free(path);
        return ret;
    }
    if (ticonv_model_is_tinspire(current_model())) {
        int ret = 0;
        if (!ret) {
            // Leave PTT packet
            const uint8_t data[9] = { 0x00, 0x00, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00 };
            ret = nsp_cmd_s_generic_data(calculator(), sizeof(data) / sizeof(data[0]), data, NSP_SID_REMOTE_MGMT, 0x00);
            if (!ret || ret == 266 /*ERR_INVALID_PACKET*/) {
                ret = nsp_cmd_r_generic_data(calculator(), nullptr, nullptr);
            }
        }
        if (!ret) {
            // Reset packet
            const uint8_t data[9] = { 0x00, 0x00, 0x06, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00 };
            ret = nsp_cmd_s_generic_data(calculator(), sizeof(data) / sizeof(data[0]), data, NSP_SID_REMOTE_MGMT, 0x00);
            if (!ret || ret == 266 /*ERR_INVALID_PACKET*/) {
                (void)nsp_cmd_r_generic_data(calculator(), nullptr, nullptr);
            }
        }
        return ret;
    }

    printf("ERROR: Leave exam mode is only supported on TI-Nspire, CE or Evo models\n");
    return -2;
}

int calc_leave_exam_mode_supported(void) {
    if (ticonv_model_is_tinspire(current_model())) {
        return 1;
    }
    return model_supports_rclwindw_leave_exam(current_model()) ? 1 : 0;
}

int string_to_calc_model(const char* value) {
    if (!value || !*value) {
        return -1;
    }
    return ticonv_string_to_model(value);
}

static VarEntry variable_request(const char* folder, const char* name, uint8_t type) {
    VarEntry request{};
    if (folder && *folder) strncpy(request.folder, folder, sizeof(request.folder) - 1);
    if (name) strncpy(request.name, name, sizeof(request.name) - 1);
    request.type = type;
    return request;
}

static int receive_entry(const VarEntry& request, const char* directory, bool application) {
    VarEntry mutable_request = request;
    char* base = tifiles_build_filename(current_model(), &mutable_request);
    if (!base) return -3;
    const size_t length = strlen(directory) + strlen(base) + 2;
    char* path = static_cast<char*>(malloc(length));
    if (!path) {
        g_free(base);
        return -4;
    }
    snprintf(path, length, "%s/%s", directory, base);
    g_free(base);
    const int result = application
        ? ticalcs_calc_recv_app2(calculator(), path, &mutable_request)
        : ticalcs_calc_recv_var2(calculator(), MODE_NORMAL, path, &mutable_request);
    if (!result) write_last_path(path);
    free(path);
    return result;
}

int calc_recv_var(CableHandle* cable_handle, const char* folder, const char* name, uint8_t type, const char* out_dir) {
    if (!cable_handle) {
        printf("ERROR: NULL cable handle provided\n");
        return -1;
    }
    if (!name || !*name) {
        printf("ERROR: No variable name provided\n");
        return -2;
    }
    const char* dir = (out_dir && *out_dir) ? out_dir : "/downloads";

    const int ready_result = ensure_calc_ready(cable_handle, 0);
    if (ready_result != 0) {
        return ready_result;
    }

    VarEntry req = variable_request(folder, name, type);

    return receive_entry(req, dir, false);
}

int calc_recv_app(CableHandle* cable_handle, const char* name, uint8_t type, const char* out_dir) {
    if (!cable_handle) {
        printf("ERROR: NULL cable handle provided\n");
        return -1;
    }
    if (!name || !*name) {
        printf("ERROR: No application name provided\n");
        return -2;
    }
    const char* dir = (out_dir && *out_dir) ? out_dir : "/downloads";

    const int ready_result = ensure_calc_ready(cable_handle, 0);
    if (ready_result != 0) {
        return ready_result;
    }

    VarEntry req = variable_request(nullptr, name, type);

    return receive_entry(req, dir, true);
}

int calc_del_var(CableHandle* cable_handle, const char* folder, const char* name, uint8_t type) {
    if (!cable_handle) {
        printf("ERROR: NULL cable handle provided\n");
        return -1;
    }
    if (!name || !*name) {
        printf("ERROR: No variable name provided\n");
        return -2;
    }

    const int ready_result = ensure_calc_ready(cable_handle, 0);
    if (ready_result != 0) {
        return ready_result;
    }

    if (tilp_calc_check_version("2.09") < 0) {
        return -3;
    }

    VarEntry req = variable_request(folder, name, type);

    return ticalcs_calc_del_var(calculator(), &req);
}

int calc_new_folder(CableHandle* cable_handle, const char* folder_path) {
    if (!cable_handle) {
        printf("ERROR: NULL cable handle provided\n");
        return -1;
    }
    if (!folder_path || !*folder_path) {
        printf("ERROR: No folder name provided\n");
        return -2;
    }

    const int ready_result = ensure_calc_ready(cable_handle, 0);
    if (ready_result != 0) {
        return ready_result;
    }

    if (tilp_calc_check_version("2.09") < 0) {
        return -3;
    }

    VarEntry req{};
    strncpy(req.folder, folder_path, sizeof(req.folder) - 1);

    return ticalcs_calc_new_fld(calculator(), &req);
}

int calc_del_folder(CableHandle* cable_handle, const char* folder_path) {
    if (!cable_handle) {
        printf("ERROR: NULL cable handle provided\n");
        return -1;
    }
    if (!folder_path || !*folder_path) {
        printf("ERROR: No folder name provided\n");
        return -2;
    }

    const int ready_result = ensure_calc_ready(cable_handle, 0);
    if (ready_result != 0) {
        return ready_result;
    }

    if (tilp_calc_check_version("2.09") < 0) {
        return -3;
    }

    VarEntry req{};
    strncpy(req.folder, folder_path, sizeof(req.folder) - 1);

    return ticalcs_calc_del_fld(calculator(), &req);
}

int calc_rename_var(CableHandle* cable_handle,
                    const char* old_folder,
                    const char* old_name,
                    uint8_t old_type,
                    const char* new_folder,
                    const char* new_name,
                    uint8_t new_type) {
    if (!cable_handle) {
        printf("ERROR: NULL cable handle provided\n");
        return -1;
    }
    if (!old_name || !*old_name || !new_name || !*new_name) {
        printf("ERROR: Invalid rename parameters\n");
        return -2;
    }

    const int ready_result = ensure_calc_ready(cable_handle, 0);
    if (ready_result != 0) {
        return ready_result;
    }

    if (tilp_calc_check_version("2.09") < 0) {
        return -3;
    }

    VarEntry old_req = variable_request(old_folder, old_name, old_type);
    VarEntry new_req = variable_request(new_folder, new_name, new_type);

    return ticalcs_calc_rename_var(calculator(), &old_req, &new_req);
}

int calc_change_attr(CableHandle* cable_handle, const char* folder, const char* name, uint8_t type, int attr) {
    if (!cable_handle) {
        printf("ERROR: NULL cable handle provided\n");
        return -1;
    }
    if (!name || !*name) {
        printf("ERROR: No variable name provided\n");
        return -2;
    }

    const int ready_result = ensure_calc_ready(cable_handle, 0);
    if (ready_result != 0) {
        return ready_result;
    }

    VarEntry req = variable_request(folder, name, type);

    return ticalcs_calc_change_attr(calculator(), &req, (FileAttr)attr);
}
} // namespace ti
