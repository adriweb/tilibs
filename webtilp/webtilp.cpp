#include <unistd.h>
#include <stdio.h>
#include <string.h>
#include <emscripten.h>
#include <libusb.h>
#include <glib.h>
#include <archive.h>
#include <archive_entry.h>

#include <ticables.h>
#include <ticalcs.h>
#include <tifiles.h>
#include <ticonv.h>
#include <nsp_cmd.h>

#ifndef __EMSCRIPTEN__
#define gssize ssize_t
#endif

extern "C" {

enum {
    TICALCS_ERR_NOT_READY = 257,
    TICALCS_ERR_BUSY = 269,
    TICABLES_ERR_READ_ERROR = 3,
    TICABLES_ERR_READ_TIMEOUT = 4,
    TICABLES_ERR_WRITE_ERROR = 5,
    TICABLES_ERR_WRITE_TIMEOUT = 6,
    ERR_WEB_INVALID_ARGUMENT = -1001,
    ERR_WEB_NOT_TI_FILE = -1002,
    ERR_WEB_INVALID_ENTRY_INDEX = -1003,
    ERR_WEB_OUT_OF_MEMORY = -1004
};

enum{
    LOC_RAM = 1,
    LOC_ARCHIVE = 2
};

enum {
    WEBTILP_EVO_TYPE_RCL_WINDOW = 13
};

static constexpr uint32_t WEBTILP_EVO_PYTHON_SCRIPT_HEADER = 0x113;

static CableModel g_cable_model = CABLE_USB;
static CalcModel g_calc_model;
static CalcHandle* g_calc_handle = nullptr;
static int g_calc_attached = 0;
static int g_calc_ready = 0;
static CableHandle* g_cable_handle = nullptr;
static int g_force_cable = 0;
static int g_force_calc = 0;
static int g_cable_timeout = 50;
static int g_cable_delay = 10;
static int g_convert_python_files = 1;
static int g_cable_reopen_needed = 0;
static CalcModel g_last_model_from = CALC_NONE;
static CalcModel g_last_model_to = CALC_NONE;
static int g_model_update_pending = 0;
static CalcUpdate g_update;
static int g_update_ready = 0;
static volatile uint32_t g_progress_tick = 0;
static char g_native_warnings[2048];
static int g_log_handlers_installed = 0;

static void append_native_warning(const char* domain, const char* message)
{
    (void)domain;
    if (!message || !*message) {
        return;
    }

    char line[512];
    snprintf(line, sizeof(line), "%s", message);

    if (strstr(g_native_warnings, line) != nullptr) {
        return;
    }

    const size_t used = strlen(g_native_warnings);
    const size_t avail = sizeof(g_native_warnings) - used;
    if (avail <= 1) {
        return;
    }
    snprintf(g_native_warnings + used, avail, "%s%s", used ? "\n" : "", line);
}

static void webtilp_log_handler(const gchar* log_domain, GLogLevelFlags log_level, const gchar* message, gpointer user_data)
{
    if ((log_level & G_LOG_LEVEL_WARNING) != 0) {
        append_native_warning(log_domain, message);
    }
    g_log_default_handler(log_domain, log_level, message, user_data);
}

static void install_log_handlers(void)
{
    if (g_log_handlers_installed) {
        return;
    }
    g_log_set_handler("ticables", G_LOG_LEVEL_WARNING, webtilp_log_handler, nullptr);
    g_log_set_handler("ticalcs", G_LOG_LEVEL_WARNING, webtilp_log_handler, nullptr);
    g_log_set_handler("tifiles", G_LOG_LEVEL_WARNING, webtilp_log_handler, nullptr);
    g_log_handlers_installed = 1;
}

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

static void reset_calc_handle_state(void)
{
    if (g_calc_handle) {
        if (g_calc_attached) {
            ticalcs_cable_detach(g_calc_handle);
        }
        ticalcs_handle_del(g_calc_handle);
    }
    g_calc_handle = nullptr;
    g_calc_attached = 0;
    g_calc_ready = 0;
}

static void update_calc_model_from_infos(const CalcInfos* infos)
{
    if (!infos || g_force_calc) {
        return;
    }
    CalcModel desired_model = infos->model;
    if (g_cable_model == CABLE_USB) {
        desired_model = ticalcs_remap_model_to_usb(g_cable_model, desired_model);
    } else {
        desired_model = ticalcs_remap_model_from_usb(g_cable_model, desired_model);
    }
    if (desired_model == CALC_NONE || desired_model == g_calc_model) {
        return;
    }
    printf("Updating calculator model from %s to %s based on device info\n",
           ticalcs_model_to_string(g_calc_model),
           ticalcs_model_to_string(desired_model));
    g_last_model_from = g_calc_model;
    g_last_model_to = desired_model;
    g_model_update_pending = 1;
    g_calc_model = desired_model;
    if (g_cable_model == CABLE_USB && !ticonv_model_is_tinspire(desired_model)) {
        const int was_attached = g_calc_attached;
        reset_calc_handle_state();
        if (was_attached) {
            g_cable_reopen_needed = 1;
        }
    }
}

static void update_progress_tick(void)
{
    __atomic_fetch_add(&g_progress_tick, 1, __ATOMIC_RELAXED);
    EM_ASM({
        if (Module.__progressTick) {
            Module.__progressTick();
        }
    });
}

static void ensure_update_callbacks(void)
{
    if (g_update_ready) {
        return;
    }
    memset(&g_update, 0, sizeof(g_update));
    g_update.start = update_progress_tick;
    g_update.stop = update_progress_tick;
    g_update.refresh = update_progress_tick;
    g_update.pbar = update_progress_tick;
    g_update.label = update_progress_tick;
    g_update_ready = 1;
}

EMSCRIPTEN_KEEPALIVE
uint32_t* get_progress_tick_ptr(void)
{
    return (uint32_t*)&g_progress_tick;
}

EMSCRIPTEN_KEEPALIVE
uint32_t get_progress_tick_value(void)
{
    return g_progress_tick;
}

EMSCRIPTEN_KEEPALIVE
void reset_progress_info(void)
{
    ensure_update_callbacks();
    g_update.text[0] = '\0';
    g_update.rate = 0.0f;
    g_update.cnt1 = 0;
    g_update.max1 = 0;
    g_update.cnt2 = 0;
    g_update.max2 = 0;
    g_update.cnt3 = 0;
    g_update.max3 = 0;
    if (g_calc_handle && g_calc_handle->cable) {
        ticables_progress_reset(g_calc_handle->cable);
    }
}

EMSCRIPTEN_KEEPALIVE
const char* get_progress_info_json(void)
{
    static char buf[256];
    if (!g_calc_handle || !g_calc_handle->updat) {
        return "";
    }

    const CalcUpdate* up = g_calc_handle->updat;
    int cnt = 0;
    int max = 0;
    if (up->max3 > 0) {
        cnt = up->cnt3;
        max = up->max3;
    } else if (up->max2 > 0) {
        cnt = up->cnt2;
        max = up->max2;
    } else if (up->max1 > 0) {
        cnt = up->cnt1;
        max = up->max1;
    }

    char text[128];
    size_t i = 0;
    for (; i < sizeof(text) - 1 && up->text[i]; i++) {
        char c = up->text[i];
        if (c == '\"') {
            c = '\'';
        } else if (c == '\n' || c == '\r') {
            c = ' ';
        }
        text[i] = c;
    }
    text[i] = '\0';

    snprintf(buf, sizeof(buf),
             R"({"cnt":%d,"max":%d,"rate":%.6f,"text":"%s"})",
             cnt, max, (double)up->rate, text);
    return buf;
}
static int found_port(const int *ports)
{
    for(int i = PORT_1; i <= PORT_4; i++)
        if(ports[i])
            return i;

    return 0;
}

static CablePort find_silverlink_port()
{
    int *list = nullptr;
    int len = 0;
    CablePort port = (CablePort)0;

    if (ticables_get_usb_devices(&list, &len) != 0 || !list) {
        return (CablePort)0;
    }

    for (int i = 0; i < len; i++) {
        if (list[i] == PID_TIGLUSB) {
            port = (CablePort)(i + 1);
            break;
        }
    }

    ticables_free_usb_devices(list);
    return port;
}

/* Scan for USB devices only (fast, returns the first device found) */
int tilp_device_probe_usb(CalcModel* calc_model, int probe_calc)
{
    int ret = -1;
    int **cables = nullptr;
    CableHandle* handle;
    CablePort port = (CablePort)0;

    printf("Searching for link cables...");
    const CablePort slv_port = find_silverlink_port();
    if (slv_port) {
        printf("Detected SilverLink on #%d\n", slv_port);
        g_cable_model = CABLE_SLV;
        if (!probe_calc) {
            return 0;
        }
        printf("SilverLink detected; manual calculator model selection required\n");
        return -1;
    }

    int err = ticables_probing_do(&cables, 5, (ProbingMethod)(PROBE_USB | PROBE_FIRST));
    if(err)
    {
        printf("error ticables_probing_do...\n");
        ticables_probing_finish(&cables);
        return -1;
    }

    port = (CablePort)found_port(cables[CABLE_USB]);
    if (port) {
        printf("Searching for handhelds on DirectLink...\n");
        g_cable_model = CABLE_USB;

        if (!probe_calc) {
            ret = 0;
            goto step3;
        }

        handle = ticables_handle_new(CABLE_USB, port);
        ticables_options_set_timeout(handle, 10);

        err = ticables_cable_open(handle);
        if (err) {
            printf("error ticables_cable_open...\n");
            ticables_handle_del(handle);
            goto step2;
        }

        err = ticalcs_probe_usb_calc(handle, calc_model);
        if (err) {
            printf("error ticalcs_probe_usb_calc...\n");
            ticables_cable_close(handle);
            ticables_handle_del(handle);
            goto step2;
        }

        ticables_cable_close(handle);
        ticables_handle_del(handle);

        ret = 0;
        goto step3;
    }

step2:
    port = (CablePort)found_port(cables[CABLE_SLV]);
    if (port) {
        printf("Searching for handhelds on SilverLink...\n");
        g_cable_model = CABLE_SLV;
        if (!probe_calc) {
            ret = 0;
            goto step3;
        }
        printf("SilverLink detected; manual calculator model selection required\n");
        ret = -1;
        goto step3;
    }

step3:
    ticables_probing_finish(&cables);
    return ret;
}

static int ensure_calc_handle_attached(CableHandle* cable_handle)
{
    if (!cable_handle) {
        printf("ERROR: NULL cable handle provided\n");
        return -1;
    }

    if (g_force_calc && g_calc_model == CALC_NONE) {
        printf("ERROR: Forced calc model is not set\n");
        return -2;
    }

    if (g_calc_model == CALC_NONE && !g_force_calc) {
        if (g_force_cable && (g_cable_model == CABLE_SLV || g_cable_model == CABLE_GRY)) {
            printf("ERROR: %s requires manual calculator model selection\n",
                   g_cable_model == CABLE_GRY ? "GrayLink" : "SilverLink");
            return -2;
        }
        printf("Calculator model unknown, probing...\n");
        if (g_force_cable) {
            const int err = ticalcs_probe_usb_calc(cable_handle, &g_calc_model);
            if (err || g_calc_model == CALC_NONE) {
                printf("ERROR: Failed to probe calculator model\n");
                return -2;
            }
        } else {
            if (tilp_device_probe_usb(&g_calc_model, 1) != 0 || g_calc_model == CALC_NONE) {
                printf("ERROR: Failed to probe calculator model\n");
                return -2;
            }
        }
    }

    if (!g_calc_handle) {
        g_calc_handle = ticalcs_handle_new(g_calc_model);
        if (!g_calc_handle) {
            printf("ERROR: Failed to create calc handle\n");
            return -3;
        }
        ensure_update_callbacks();
        ticalcs_update_set(g_calc_handle, &g_update);
    }

    if (!g_calc_attached) {
        ticables_cable_close(cable_handle);
        const int attach_result = ticalcs_cable_attach(g_calc_handle, cable_handle);
        if (attach_result != 0) {
            printf("ERROR: Failed to attach cable (error %d)\n", attach_result);
            return attach_result;
        }
        g_calc_attached = 1;
        g_calc_ready = 0;
    }

    return 0;
}

static int ensure_calc_ready(CableHandle* cable_handle, int force)
{
    const int attach_result = ensure_calc_handle_attached(cable_handle);
    if (attach_result != 0) {
        return attach_result;
    }

    if (!g_calc_ready || force) {
        usleep(100000);
        int ready_result = ticalcs_calc_isready(g_calc_handle);
        int retries = 0;
        while ((ready_result == TICALCS_ERR_BUSY
            || ready_result == TICALCS_ERR_NOT_READY
            || ready_result == TICABLES_ERR_READ_ERROR
            || ready_result == TICABLES_ERR_READ_TIMEOUT
            || ready_result == TICABLES_ERR_WRITE_ERROR
            || ready_result == TICABLES_ERR_WRITE_TIMEOUT) && retries < 4) {
            printf("Calculator busy or link error, retrying...\n");
            usleep(100000);
            emscripten_sleep(100);
            ready_result = ticalcs_calc_isready(g_calc_handle);
            retries++;
        }
        if (ready_result != 0) {
            printf("ERROR: Calculator not ready (error %d)\n", ready_result);
            g_calc_ready = 0;
            return ready_result;
        }
        usleep(100000);
        g_calc_ready = 1;
    }

    return 0;
}

static size_t safe_strnlen(const char* text, size_t maxlen)
{
    size_t len = 0;
    while (len < maxlen && text[len]) {
        len++;
    }
    return len;
}

static void json_append_escaped(GString* out, const char* text)
{
    if (!text) {
        return;
    }
    const size_t len = safe_strnlen(text, 4096);
    for (size_t i = 0; i < len; i++) {
        const unsigned char c = (unsigned char)text[i];
        switch (c) {
            case '\"': g_string_append(out, "\\\""); break;
            case '\\': g_string_append(out, "\\\\"); break;
            case '\n': g_string_append(out, "\\n"); break;
            case '\r': g_string_append(out, "\\r"); break;
            case '\t': g_string_append(out, "\\t"); break;
            default:
                if (c < 0x20) {
                    g_string_append_printf(out, "\\u%04x", (unsigned int)c);
                } else {
                    g_string_append_c(out, (char)c);
                }
        }
    }
}

static void json_escape_bytes(FILE* fp, const char* text, size_t maxlen)
{
    const size_t len = safe_strnlen(text, maxlen);
    for (size_t i = 0; i < len; i++) {
        const unsigned char c = (unsigned char)text[i];
        switch (c) {
            case '\"': fputs("\\\"", fp); break;
            case '\\': fputs("\\\\", fp); break;
            case '\n': fputs("\\n", fp); break;
            case '\r': fputs("\\r", fp); break;
            case '\t': fputs("\\t", fp); break;
            default:
                if (c < 0x20) {
                    fprintf(fp, "\\u%04x", (unsigned int)c);
                } else {
                    fputc(c, fp);
                }
        }
    }
}

static void write_var_entry_json(FILE* fp, const VarEntry* ve, const char* kind)
{
    char name_buf[VARNAME_MAX * 4];
    char folder_buf[FLDNAME_MAX * 4];
    char raw_name[VARNAME_MAX + 1];
    char raw_folder[FLDNAME_MAX + 1];
    const size_t name_len = safe_strnlen(ve->name, sizeof(ve->name));
    const size_t folder_len = safe_strnlen(ve->folder, sizeof(ve->folder));

    memcpy(raw_name, ve->name, name_len);
    raw_name[name_len] = '\0';
    memcpy(raw_folder, ve->folder, folder_len);
    raw_folder[folder_len] = '\0';

    name_buf[0] = '\0';
    folder_buf[0] = '\0';

    if (ticonv_varname_to_utf8_sn(g_calc_model, raw_name, name_buf, sizeof(name_buf), ve->type) == nullptr) {
        strncpy(name_buf, raw_name, sizeof(name_buf) - 1);
        name_buf[sizeof(name_buf) - 1] = '\0';
    }

    if (raw_folder[0]) {
        if (ticonv_varname_to_utf8_sn(g_calc_model, raw_folder, folder_buf, sizeof(folder_buf), ve->type) == nullptr) {
            strncpy(folder_buf, raw_folder, sizeof(folder_buf) - 1);
            folder_buf[sizeof(folder_buf) - 1] = '\0';
        }
    }

    const char* type_name = tifiles_vartype2type(g_calc_model, ve->type);
    const int folder_type = tifiles_folder_type(g_calc_model);
    const int is_folder = (folder_type != 0 && ve->type == folder_type);

    fprintf(fp, R"({"name":")");
    json_escape_bytes(fp, name_buf, sizeof(name_buf));
    fprintf(fp, R"(","folder":")");
    json_escape_bytes(fp, folder_buf, sizeof(folder_buf));
    fprintf(fp, R"(","type":%u,"type_name":")", ve->type);
    if (type_name && *type_name) {
        json_escape_bytes(fp, type_name, strlen(type_name));
    }
    fprintf(fp, R"(","size":%u,"attr":%u,"kind":"%s","is_folder":%d})",
            (unsigned int)ve->size, ve->attr, kind, is_folder ? 1 : 0);
}

static void write_dirlist_json(FILE* fp, const GNode* node, const char* kind, int* first)
{
    if (!node) {
        return;
    }
    if (node->parent == nullptr) {
        const GNode* child = node->children;
        while (child) {
            write_dirlist_json(fp, child, kind, first);
            child = child->next;
        }
        return;
    }
    const VarEntry* ve = (VarEntry*)node->data;
    if (ve) {
        if (!ve->name[0]) {
            goto next_node;
        }
        if (!*first) {
            fputc(',', fp);
        }
        *first = 0;
        write_var_entry_json(fp, ve, kind);
    }
    next_node:
        const GNode* child = node->children;
        while (child) {
            write_dirlist_json(fp, child, kind, first);
            child = child->next;
        }
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

static int is_ce_python_model(CalcModel model)
{
    return model == CALC_TI83PCE_USB
        || model == CALC_TI84PCE_USB
        || model == CALC_TI82AEP_USB;
}

static int read_file_bytes(const char* path, uint8_t** data, size_t* size)
{
    *data = nullptr;
    *size = 0;
    FILE* fp = fopen(path, "rb");
    if (!fp) {
        return -1;
    }
    if (fseek(fp, 0, SEEK_END) != 0) {
        fclose(fp);
        return -1;
    }
    const long length = ftell(fp);
    if (length < 0 || fseek(fp, 0, SEEK_SET) != 0) {
        fclose(fp);
        return -1;
    }
    uint8_t* buffer = (uint8_t*)g_malloc(length ? (size_t)length : 1);
    if (!buffer) {
        fclose(fp);
        return -1;
    }
    if (length > 0 && fread(buffer, 1, (size_t)length, fp) != (size_t)length) {
        g_free(buffer);
        fclose(fp);
        return -1;
    }
    fclose(fp);
    *data = buffer;
    *size = (size_t)length;
    return 0;
}

static int write_file_bytes(const char* path, const uint8_t* data, size_t size)
{
    FILE* fp = fopen(path, "wb");
    if (!fp) {
        return -1;
    }
    const int ok = size == 0 || fwrite(data, 1, size, fp) == size;
    fclose(fp);
    return ok ? 0 : -1;
}

static uint8_t* strip_utf8_bom_copy(const uint8_t* data, size_t size, size_t* out_size)
{
    size_t offset = 0;
    if (size >= 3 && data[0] == 0xEF && data[1] == 0xBB && data[2] == 0xBF) {
        offset = 3;
    }
    *out_size = size - offset;
    uint8_t* out = (uint8_t*)g_malloc(*out_size ? *out_size : 1);
    if (!out) {
        *out_size = 0;
        return nullptr;
    }
    if (*out_size) {
        memcpy(out, data + offset, *out_size);
    }
    return out;
}

static uint8_t* normalize_python_text_for_download(const uint8_t* data, size_t size, size_t* out_size)
{
    size_t offset = 0;
    if (size >= 3 && data[0] == 0xEF && data[1] == 0xBB && data[2] == 0xBF) {
        offset = 3;
    }
    GByteArray* out = g_byte_array_sized_new(size - offset);
    if (!out) {
        return nullptr;
    }
    for (size_t i = offset; i < size; i++) {
        if (data[i] == '\r') {
            if (i + 1 < size && data[i + 1] == '\n') {
                i++;
            }
            const uint8_t lf = '\n';
            g_byte_array_append(out, &lf, 1);
        } else {
            g_byte_array_append(out, data + i, 1);
        }
    }
    *out_size = out->len;
    return g_byte_array_free(out, FALSE);
}

static void sanitize_python_var_name(const char* raw, int uppercase, size_t max_len, char* out, size_t out_size)
{
    size_t pos = 0;
    if (!raw || !*raw || out_size == 0) {
        return;
    }
    for (const unsigned char* p = (const unsigned char*)raw; *p && pos + 1 < out_size && pos < max_len; p++) {
        unsigned char c = *p;
        if (g_ascii_isalnum(c)) {
            out[pos++] = uppercase ? (char)g_ascii_toupper(c) : (char)c;
        } else if (c == '_') {
            out[pos++] = '_';
        }
    }
    if (pos == 0) {
        const char* fallback = uppercase ? "PYTHON" : "python";
        g_strlcpy(out, fallback, out_size);
    } else {
        out[pos] = '\0';
    }
}

static char* basename_without_extension(const char* path)
{
    char* base = g_path_get_basename(path);
    if (!base) {
        return nullptr;
    }
    char* dot = strrchr(base, '.');
    if (dot) {
        *dot = '\0';
    }
    return base;
}

static int append_python_metadata_length(GByteArray* out, size_t value)
{
    if (value == 0 || value > 0x3FFF) {
        return -1;
    }
    do {
        uint8_t byte = (uint8_t)(value & 0x7F);
        value >>= 7;
        if (value) {
            byte |= 0x80;
        }
        g_byte_array_append(out, &byte, 1);
    } while (value);
    return 0;
}

static int ce_python_data_to_script(const uint8_t* data, size_t size, const uint8_t** script, size_t* script_size)
{
    *script = nullptr;
    *script_size = 0;
    if (!data || size < 7) {
        return -1;
    }
    const size_t payload_size = (size_t)data[0] | ((size_t)data[1] << 8);
    if (payload_size != size - 2) {
        return -1;
    }
    if (memcmp(data + 2, "PYCD", 4) != 0 && memcmp(data + 2, "PYSC", 4) != 0) {
        return -1;
    }
    size_t pos = 6;
    while (pos < size) {
        if (data[pos] == 0x00) {
            pos++;
            *script = data + pos;
            *script_size = size - pos;
            return 0;
        }
        size_t record_length = 0;
        int shift = 0;
        int length_bytes = 0;
        while (pos < size) {
            const uint8_t byte = data[pos++];
            record_length |= (size_t)(byte & 0x7F) << shift;
            length_bytes++;
            if ((byte & 0x80) == 0) {
                break;
            }
            shift += 7;
            if (length_bytes >= 2) {
                return -1;
            }
        }
        if (record_length == 0 || pos + record_length > size) {
            return -1;
        }
        pos += record_length;
    }
    return -1;
}

static GByteArray* build_ce_python_appvar_data(const uint8_t* source, size_t source_size, const char* filename)
{
    size_t script_size = 0;
    uint8_t* script = strip_utf8_bom_copy(source, source_size, &script_size);
    if (!script) {
        return nullptr;
    }

    GByteArray* payload = g_byte_array_new();
    if (!payload) {
        g_free(script);
        return nullptr;
    }
    const uint8_t magic[] = { 'P', 'Y', 'C', 'D' };
    g_byte_array_append(payload, magic, sizeof(magic));
    if (filename && *filename) {
        const size_t filename_len = strlen(filename);
        if (append_python_metadata_length(payload, filename_len + 1) == 0) {
            const uint8_t filename_type = 0x01;
            g_byte_array_append(payload, &filename_type, 1);
            g_byte_array_append(payload, (const uint8_t*)filename, filename_len);
        }
    }
    const uint8_t terminator = 0x00;
    g_byte_array_append(payload, &terminator, 1);

    const size_t max_payload_size = 65512;
    if (payload->len > max_payload_size) {
        g_byte_array_free(payload, TRUE);
        g_free(script);
        return nullptr;
    }
    if (script_size > max_payload_size - payload->len) {
        script_size = max_payload_size - payload->len;
    }
    g_byte_array_append(payload, script, script_size);
    g_free(script);

    GByteArray* out = g_byte_array_sized_new(payload->len + 2);
    if (!out) {
        g_byte_array_free(payload, TRUE);
        return nullptr;
    }
    const uint8_t length_bytes[] = {
        (uint8_t)(payload->len & 0xFF),
        (uint8_t)((payload->len >> 8) & 0xFF)
    };
    g_byte_array_append(out, length_bytes, sizeof(length_bytes));
    g_byte_array_append(out, payload->data, payload->len);
    g_byte_array_free(payload, TRUE);
    return out;
}

static uint16_t evo_python_checksum(const uint8_t* body, size_t body_len)
{
    if (body_len < 3) {
        return 0;
    }
    size_t adjusted = body_len - 3;
    size_t word_count = adjusted >> 1;
    if ((adjusted & 1U) != 0 && word_count > 0) {
        word_count--;
    }
    uint16_t checksum = 0;
    for (size_t i = 0; i < word_count; i++) {
        checksum ^= (uint16_t)(body[i * 2] | (body[i * 2 + 1] << 8));
    }
    return checksum;
}

static void append_cbor_uint(GByteArray* out, uint32_t value)
{
    if (value < 24) {
        const uint8_t b = (uint8_t)value;
        g_byte_array_append(out, &b, 1);
    } else if (value <= 0xFF) {
        const uint8_t b[] = { 0x18, (uint8_t)value };
        g_byte_array_append(out, b, sizeof(b));
    } else if (value <= 0xFFFF) {
        const uint8_t b[] = { 0x19, (uint8_t)(value >> 8), (uint8_t)(value & 0xFF) };
        g_byte_array_append(out, b, sizeof(b));
    } else {
        const uint8_t b[] = { 0x1A, (uint8_t)(value >> 24), (uint8_t)(value >> 16), (uint8_t)(value >> 8), (uint8_t)value };
        g_byte_array_append(out, b, sizeof(b));
    }
}

static void append_cbor_text(GByteArray* out, const char* text)
{
    const size_t len = strlen(text);
    if (len < 24) {
        const uint8_t b = (uint8_t)(0x60 | len);
        g_byte_array_append(out, &b, 1);
    } else {
        const uint8_t b[] = { 0x78, (uint8_t)len };
        g_byte_array_append(out, b, sizeof(b));
    }
    g_byte_array_append(out, (const uint8_t*)text, len);
}

static void append_cbor_bytes(GByteArray* out, const uint8_t* bytes, size_t len)
{
    if (len < 24) {
        const uint8_t b = (uint8_t)(0x40 | len);
        g_byte_array_append(out, &b, 1);
    } else if (len <= 0xFF) {
        const uint8_t b[] = { 0x58, (uint8_t)len };
        g_byte_array_append(out, b, sizeof(b));
    } else {
        const uint8_t b[] = { 0x59, (uint8_t)(len >> 8), (uint8_t)(len & 0xFF) };
        g_byte_array_append(out, b, sizeof(b));
    }
    if (len) {
        g_byte_array_append(out, bytes, len);
    }
}

static void append_cbor_key_uint(GByteArray* out, const char* key, uint32_t value)
{
    append_cbor_text(out, key);
    append_cbor_uint(out, value);
}

static void append_evo_name_word(GByteArray* out, uint16_t word)
{
    const uint8_t b[] = { (uint8_t)(word & 0xFF), (uint8_t)(word >> 8) };
    g_byte_array_append(out, b, sizeof(b));
}

static GByteArray* encode_evo_python_var_name(const char* name)
{
    GByteArray* out = g_byte_array_new();
    if (!out) {
        return nullptr;
    }
    for (const unsigned char* p = (const unsigned char*)name; p && *p; p++) {
        const unsigned char c = *p;
        if (c >= 'A' && c <= 'Z') {
            append_evo_name_word(out, (uint16_t)(0xE800 + (c - 'A')));
        } else if (c >= '0' && c <= '9') {
            append_evo_name_word(out, (uint16_t)(0xE401 + (c - '0')));
        } else if (c >= 'a' && c <= 'z') {
            append_evo_name_word(out, c);
        } else if (c == '_') {
            append_evo_name_word(out, 0xE400);
        }
    }
    append_evo_name_word(out, 0);
    return out;
}

static GByteArray* build_evo_python_script_payload(const uint8_t* source, size_t source_size, const char* filename)
{
    size_t script_size = 0;
    uint8_t* script = strip_utf8_bom_copy(source, source_size, &script_size);
    if (!script) {
        return nullptr;
    }
    if (script_size > 0xFFFF) {
        script_size = 0xFFFF;
    }
    GByteArray* payload = g_byte_array_new();
    if (!payload) {
        g_free(script);
        return nullptr;
    }
    const size_t filename_len = strlen(filename);
    const uint32_t data_len = (uint32_t)(12 + filename_len + 1 + 4 + script_size + 1);
    const uint8_t length_header[] = {
        (uint8_t)(WEBTILP_EVO_PYTHON_SCRIPT_HEADER & 0xFF),
        (uint8_t)((WEBTILP_EVO_PYTHON_SCRIPT_HEADER >> 8) & 0xFF),
        (uint8_t)((WEBTILP_EVO_PYTHON_SCRIPT_HEADER >> 16) & 0xFF),
        (uint8_t)((WEBTILP_EVO_PYTHON_SCRIPT_HEADER >> 24) & 0xFF),
        (uint8_t)(data_len & 0xFF),
        (uint8_t)((data_len >> 8) & 0xFF),
        (uint8_t)((data_len >> 16) & 0xFF),
        (uint8_t)((data_len >> 24) & 0xFF)
    };
    g_byte_array_append(payload, length_header, sizeof(length_header));
    const uint8_t name_len[] = {
        (uint8_t)(filename_len & 0xFF),
        (uint8_t)((filename_len >> 8) & 0xFF),
        (uint8_t)((filename_len >> 16) & 0xFF),
        (uint8_t)((filename_len >> 24) & 0xFF)
    };
    g_byte_array_append(payload, name_len, sizeof(name_len));
    g_byte_array_append(payload, (const uint8_t*)filename, filename_len);
    const uint8_t nul = 0x00;
    g_byte_array_append(payload, &nul, 1);
    const uint8_t script_len[] = { (uint8_t)(script_size & 0xFF), (uint8_t)((script_size >> 8) & 0xFF) };
    g_byte_array_append(payload, script_len, sizeof(script_len));
    const uint8_t script_type[] = { 0x00, 0x02 };
    g_byte_array_append(payload, script_type, sizeof(script_type));
    g_byte_array_append(payload, script, script_size);
    g_byte_array_append(payload, &nul, 1);
    g_free(script);
    return payload;
}

static GByteArray* build_evo_python_file_data(const uint8_t* source, size_t source_size, const char* var_name, const char* script_name)
{
    GByteArray* payload = build_evo_python_script_payload(source, source_size, script_name);
    GByteArray* encoded_name = encode_evo_python_var_name(var_name);
    GByteArray* body = g_byte_array_new();
    if (!payload || !encoded_name || !body) {
        if (payload) g_byte_array_free(payload, TRUE);
        if (encoded_name) g_byte_array_free(encoded_name, TRUE);
        if (body) g_byte_array_free(body, TRUE);
        return nullptr;
    }

    const uint8_t map = 0xBF;
    const uint8_t end = 0xFF;
    g_byte_array_append(body, &map, 1);
    append_cbor_text(body, "metaData");
    g_byte_array_append(body, &map, 1);
    append_cbor_key_uint(body, "type", 15);
    append_cbor_key_uint(body, "version", 1);
    append_cbor_key_uint(body, "flags", 1);
    append_cbor_text(body, "name");
    append_cbor_bytes(body, encoded_name->data, encoded_name->len);
    g_byte_array_append(body, &end, 1);
    append_cbor_key_uint(body, "version", 1);
    append_cbor_key_uint(body, "size", payload->len);
    append_cbor_text(body, "data");
    append_cbor_bytes(body, payload->data, payload->len);
    g_byte_array_append(body, &end, 1);
    g_byte_array_free(payload, TRUE);
    g_byte_array_free(encoded_name, TRUE);

    const uint16_t checksum = evo_python_checksum(body->data, body->len);
    const uint8_t checksum_bytes[] = { (uint8_t)(checksum >> 8), (uint8_t)(checksum & 0xFF) };
    g_byte_array_append(body, checksum_bytes, sizeof(checksum_bytes));
    return body;
}

static int read_cbor_uint_arg(const uint8_t* data, size_t size, size_t* pos, uint8_t additional, size_t* value)
{
    if (additional < 24) {
        *value = additional;
        return 0;
    }
    if (additional == 24 && *pos < size) {
        *value = data[(*pos)++];
        return 0;
    }
    if (additional == 25 && *pos + 1 < size) {
        *value = ((size_t)data[*pos] << 8) | data[*pos + 1];
        *pos += 2;
        return 0;
    }
    if (additional == 26 && *pos + 3 < size) {
        *value = ((size_t)data[*pos] << 24) | ((size_t)data[*pos + 1] << 16) | ((size_t)data[*pos + 2] << 8) | data[*pos + 3];
        *pos += 4;
        return 0;
    }
    return -1;
}

static int skip_cbor_value(const uint8_t* data, size_t size, size_t* pos)
{
    if (*pos >= size) {
        return -1;
    }
    const uint8_t initial = data[(*pos)++];
    if (initial == 0xFF) {
        return 0;
    }
    const uint8_t major = initial >> 5;
    const uint8_t additional = initial & 0x1F;
    size_t count = 0;
    if (major == 0) {
        return read_cbor_uint_arg(data, size, pos, additional, &count);
    }
    if (major == 2 || major == 3) {
        if (read_cbor_uint_arg(data, size, pos, additional, &count) != 0 || *pos + count > size) {
            return -1;
        }
        *pos += count;
        return 0;
    }
    if (major == 4) {
        if (additional == 31) {
            while (*pos < size && data[*pos] != 0xFF) {
                if (skip_cbor_value(data, size, pos) != 0) return -1;
            }
            if (*pos >= size) return -1;
            (*pos)++;
            return 0;
        }
        if (read_cbor_uint_arg(data, size, pos, additional, &count) != 0) return -1;
        for (size_t i = 0; i < count; i++) {
            if (skip_cbor_value(data, size, pos) != 0) return -1;
        }
        return 0;
    }
    if (major == 5) {
        if (additional == 31) {
            while (*pos < size && data[*pos] != 0xFF) {
                if (skip_cbor_value(data, size, pos) != 0 || skip_cbor_value(data, size, pos) != 0) return -1;
            }
            if (*pos >= size) return -1;
            (*pos)++;
            return 0;
        }
        if (read_cbor_uint_arg(data, size, pos, additional, &count) != 0) return -1;
        for (size_t i = 0; i < count; i++) {
            if (skip_cbor_value(data, size, pos) != 0 || skip_cbor_value(data, size, pos) != 0) return -1;
        }
        return 0;
    }
    if (major == 7) {
        if (additional == 24) {
            if (*pos >= size) return -1;
            (*pos)++;
        } else if (additional == 25) {
            if (*pos + 1 >= size) return -1;
            *pos += 2;
        } else if (additional == 26) {
            if (*pos + 3 >= size) return -1;
            *pos += 4;
        }
        return 0;
    }
    return -1;
}

static int evo_file_data_to_python_payload(const uint8_t* data, size_t size, const uint8_t** payload, size_t* payload_size)
{
    *payload = nullptr;
    *payload_size = 0;
    if (!data || size < 5 || data[0] != 0xBF) {
        return -1;
    }
    const uint16_t stored = (uint16_t)((data[size - 2] << 8) | data[size - 1]);
    if (stored != evo_python_checksum(data, size - 2)) {
        return -1;
    }
    const size_t body_size = size - 2;
    size_t pos = 1;
    while (pos < body_size) {
        if (data[pos] == 0xFF) {
            return -1;
        }
        const uint8_t key_initial = data[pos++];
        if ((key_initial >> 5) != 3) {
            return -1;
        }
        size_t key_len = 0;
        if (read_cbor_uint_arg(data, body_size, &pos, key_initial & 0x1F, &key_len) != 0 || pos + key_len > body_size) {
            return -1;
        }
        const char* key = (const char*)data + pos;
        pos += key_len;
        if (key_len == 4 && memcmp(key, "data", 4) == 0) {
            if (pos >= body_size) return -1;
            const uint8_t value_initial = data[pos++];
            if ((value_initial >> 5) != 2) return -1;
            size_t value_len = 0;
            if (read_cbor_uint_arg(data, body_size, &pos, value_initial & 0x1F, &value_len) != 0 || pos + value_len > body_size) {
                return -1;
            }
            *payload = data + pos;
            *payload_size = value_len;
            return 0;
        }
        if (skip_cbor_value(data, body_size, &pos) != 0) {
            return -1;
        }
    }
    return -1;
}

static int evo_python_payload_to_script(const uint8_t* data, size_t size, const uint8_t** script, size_t* script_size)
{
    *script = nullptr;
    *script_size = 0;
    if (!data || size < 18) {
        return -1;
    }
    const uint32_t script_header = (uint32_t)data[0] | ((uint32_t)data[1] << 8) | ((uint32_t)data[2] << 16) | ((uint32_t)data[3] << 24);
    const uint32_t data_len = (uint32_t)data[4] | ((uint32_t)data[5] << 8) | ((uint32_t)data[6] << 16) | ((uint32_t)data[7] << 24);
    const uint32_t name_len = (uint32_t)data[8] | ((uint32_t)data[9] << 8) | ((uint32_t)data[10] << 16) | ((uint32_t)data[11] << 24);
    if (name_len == 0 || name_len > 255 || 12U + name_len + 1U + 4U > size) {
        return -1;
    }
    if (data_len > size) {
        return -1;
    }
    const size_t after_name = 12 + name_len;
    if (data[after_name] != 0) {
        return -1;
    }
    const size_t len_pos = after_name + 1;
    const uint16_t body_len = (uint16_t)(data[len_pos] | (data[len_pos + 1] << 8));
    const size_t body_pos = len_pos + 4;
    if (script_header != WEBTILP_EVO_PYTHON_SCRIPT_HEADER) {
        return -1;
    }
    if (body_pos + body_len > data_len) {
        return -1;
    }
    *script = data + body_pos;
    *script_size = body_len;
    return 0;
}

static int convert_ti_python_file_to_py(const char* ti_path, const char* out_dir, char** out_path)
{
    *out_path = nullptr;
    if (!ti_path || !*ti_path || !out_dir || !*out_dir || !tifiles_file_is_ti(ti_path)) {
        return -1;
    }

    CalcModel parse_model = tifiles_file_get_model(ti_path);
    if (parse_model == CALC_NONE) {
        parse_model = g_calc_model;
    }
    FileContent* content = tifiles_content_create_regular(parse_model);
    if (!content) {
        return -1;
    }
    if (tifiles_file_read_regular(ti_path, content) != 0 || content->num_entries == 0 || !content->entries || !content->entries[0]) {
        tifiles_content_delete_regular(content);
        return -1;
    }

    VarEntry* ve = content->entries[0];
    const uint8_t* script = nullptr;
    size_t script_size = 0;
    int ok = -1;
    if (ticonv_model_is_tievo(content->model) && ve->type == 15) {
        const uint8_t* payload = nullptr;
        size_t payload_size = 0;
        if (evo_file_data_to_python_payload(ve->data, ve->size, &payload, &payload_size) == 0) {
            ok = evo_python_payload_to_script(payload, payload_size, &script, &script_size);
        }
    } else if (ve->type == TI84p_APPV) {
        ok = ce_python_data_to_script(ve->data, ve->size, &script, &script_size);
    }
    if (ok != 0) {
        tifiles_content_delete_regular(content);
        return -1;
    }

    size_t py_size = 0;
    uint8_t* py = normalize_python_text_for_download(script, script_size, &py_size);
    if (!py) {
        tifiles_content_delete_regular(content);
        return -1;
    }
    char* base = basename_without_extension(ti_path);
    char safe_name[96] = {};
    sanitize_python_var_name(base, 0, 64, safe_name, sizeof(safe_name));
    g_free(base);
    char* path = g_strdup_printf("%s/%s.py", out_dir, safe_name);
    if (!path) {
        g_free(py);
        tifiles_content_delete_regular(content);
        return -1;
    }
    ok = write_file_bytes(path, py, py_size);
    g_free(py);
    tifiles_content_delete_regular(content);
    if (ok != 0) {
        g_free(path);
        return -1;
    }
    *out_path = path;
    return 0;
}

EMSCRIPTEN_KEEPALIVE
const char* convert_python_source_for_calc(const char* py_path, const char* out_dir)
{
    static char* result_path = nullptr;
    g_free(result_path);
    result_path = nullptr;

    if (!py_path || !*py_path || !out_dir || !*out_dir || !g_convert_python_files) {
        return "";
    }
    const char* ext = strrchr(py_path, '.');
    if (!ext || g_ascii_strcasecmp(ext + 1, "py") != 0) {
        return "";
    }
    if (!is_ce_python_model(g_calc_model) && !ticonv_model_is_tievo(g_calc_model)) {
        return "";
    }

    uint8_t* source = nullptr;
    size_t source_size = 0;
    if (read_file_bytes(py_path, &source, &source_size) != 0) {
        return "";
    }
    char* base = basename_without_extension(py_path);
    char var_name[96] = {};
    sanitize_python_var_name(base, !ticonv_model_is_tievo(g_calc_model), ticonv_model_is_tievo(g_calc_model) ? 64 : 8, var_name, sizeof(var_name));
    char* ce_filename = g_strdup_printf("%s.py", var_name[0] ? var_name : "python");

    int ok = -1;
    if (ticonv_model_is_tievo(g_calc_model)) {
        GByteArray* data = build_evo_python_file_data(source, source_size, var_name, var_name[0] ? var_name : "python");
        if (data) {
            result_path = g_strdup_printf("%s/%s.8xpy2", out_dir, var_name);
            ok = result_path ? write_file_bytes(result_path, data->data, data->len) : -1;
            g_byte_array_free(data, TRUE);
        }
    } else {
        GByteArray* data = build_ce_python_appvar_data(source, source_size, ce_filename);
        if (data) {
            FileContent* content = tifiles_content_create_regular(g_calc_model);
            VarEntry* ve = tifiles_ve_create();
            VarEntry** entries = tifiles_ve_create_array(1);
            if (content && ve && entries) {
                ve->type = TI84p_APPV;
                ve->version = 0;
                ve->attr = ATTRB_NONE;
                ve->size = data->len;
                ve->data = (uint8_t*)tifiles_ve_alloc_data(data->len ? data->len : 1);
                if (ve->data) {
                    memcpy(ve->data, data->data, data->len);
                    char* raw_name = ticonv_varname_tokenize(g_calc_model, var_name, ve->type);
                    if (raw_name) {
                        g_strlcpy(ve->name, raw_name, sizeof(ve->name));
                        ticonv_varname_free(raw_name);
                    } else {
                        g_strlcpy(ve->name, var_name, sizeof(ve->name));
                    }
                    content->num_entries = 1;
                    content->entries = entries;
                    content->entries[0] = ve;
                    ve = nullptr;
                    entries = nullptr;
                    result_path = g_strdup_printf("%s/%s.8xv", out_dir, var_name);
                    ok = result_path ? tifiles_file_write_regular(result_path, content, nullptr) : -1;
                }
            }
            if (entries) {
                g_free(entries);
            }
            if (ve) {
                tifiles_ve_delete(ve);
            }
            if (content) {
                tifiles_content_delete_regular(content);
            }
            g_byte_array_free(data, TRUE);
        }
    }
    g_free(source);
    g_free(base);
    g_free(ce_filename);
    if (ok != 0) {
        g_free(result_path);
        result_path = nullptr;
        return "";
    }
    return result_path;
}

static const char* maybe_convert_received_python_file(const char* ti_path, const char* out_dir)
{
    static char* converted_path = nullptr;
    g_free(converted_path);
    converted_path = nullptr;
    if (!g_convert_python_files) {
        return ti_path;
    }
    if (convert_ti_python_file_to_py(ti_path, out_dir, &converted_path) != 0 || !converted_path) {
        return ti_path;
    }
    remove(ti_path);
    return converted_path;
}

EMSCRIPTEN_KEEPALIVE
int init() {
    printf("Initializing tilibs...\n");
    install_log_handlers();
    int result = ticables_library_init();
    printf("ticables_library_init: %d\n", result);
    result = tifiles_library_init();
    printf("tifiles_library_init: %d\n", result);
    result = ticalcs_library_init();
    printf("ticalcs_library_init: %d\n", result);

    printf("tilibs init done!\n");

    return result;
}

EMSCRIPTEN_KEEPALIVE
void clear_native_warnings(void)
{
    g_native_warnings[0] = '\0';
}

EMSCRIPTEN_KEEPALIVE
const char* get_native_warnings(void)
{
    return g_native_warnings;
}

EMSCRIPTEN_KEEPALIVE
const char* get_version() {
    printf("ticables_version_get()...\n");
    const char* version = ticables_version_get();
    printf("Version: %s\n", version);
    return version;
}

EMSCRIPTEN_KEEPALIVE
void set_cable_model(int model) {
    g_cable_model = (CableModel)model;
    reset_calc_handle_state();
}

EMSCRIPTEN_KEEPALIVE
void set_calc_model(int model) {
    g_calc_model = (CalcModel)model;
    reset_calc_handle_state();
}

EMSCRIPTEN_KEEPALIVE
const char* get_flash_os_ext(int model) {
    const CalcModel calc = model ? (CalcModel)model : g_calc_model;
    if (calc == CALC_NONE) {
        return nullptr;
    }
    return tifiles_fext_of_flash_os(calc);
}

EMSCRIPTEN_KEEPALIVE
const char* get_calc_model_string(void) {
    return ticalcs_model_to_string(g_calc_model);
}

EMSCRIPTEN_KEEPALIVE
int consume_cable_reopen_flag(void) {
    const int value = g_cable_reopen_needed;
    g_cable_reopen_needed = 0;
    return value;
}

EMSCRIPTEN_KEEPALIVE
const char* consume_model_update_info(void) {
    static char buf[160];
    if (!g_model_update_pending) {
        return "";
    }
    g_model_update_pending = 0;
    snprintf(buf, sizeof(buf),
             R"({"from":%d,"to":%d,"fromName":"%s","toName":"%s"})",
             g_last_model_from,
             g_last_model_to,
             ticalcs_model_to_string(g_last_model_from),
             ticalcs_model_to_string(g_last_model_to));
    return buf;
}

EMSCRIPTEN_KEEPALIVE
void notify_usb_disconnect(void) {
    reset_calc_handle_state();
    if (g_cable_handle) {
        ticables_cable_close(g_cable_handle);
        ticables_handle_del(g_cable_handle);
        g_cable_handle = nullptr;
    }
    g_cable_reopen_needed = 0;
}

EMSCRIPTEN_KEEPALIVE
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

EMSCRIPTEN_KEEPALIVE
uint16_t get_raw_protocol_code(int number) {
    uint16_t raw = 0;
    if (ticalcs_error_get_raw_protocol_code(number, &raw) != 0) {
        return 0;
    }
    return raw;
}

EMSCRIPTEN_KEEPALIVE
void set_force_cable(int force) {
    g_force_cable = force ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE
void set_force_calc(int force) {
    g_force_calc = force ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE
void set_cable_timeout(int timeout) {
    if (timeout > 0) {
        g_cable_timeout = timeout;
        if (g_cable_handle) {
            ticables_options_set_timeout(g_cable_handle, g_cable_timeout);
        }
    }
}

EMSCRIPTEN_KEEPALIVE
void set_cable_delay(int delay) {
    if (delay >= 0) {
        g_cable_delay = delay;
        if (g_cable_handle) {
            ticables_options_set_delay(g_cable_handle, g_cable_delay);
        }
    }
}

EMSCRIPTEN_KEEPALIVE
void set_convert_python_files(int enabled) {
    g_convert_python_files = enabled ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE
int check_webusb_support() {
    printf("cable support for CABLE_USB (WebUSB backend)...\n");
    const uint64_t supported = ticables_supported_cables();
    const int usb_supported = (supported & (1ULL << CABLE_USB)) != 0;
    printf("USB supported: %d\n", usb_supported);
    return usb_supported;
}

EMSCRIPTEN_KEEPALIVE
CableHandle* create_handle() {
    printf("ticables_handle_new()...\n");
    if (g_cable_handle) {
        ticables_options_set_timeout(g_cable_handle, g_cable_timeout);
        ticables_options_set_delay(g_cable_handle, g_cable_delay);
        printf("Reusing existing cable handle: %p\n", (void*)g_cable_handle);
        return g_cable_handle;
    }
    if (!g_force_cable) {
        tilp_device_probe_usb(nullptr, 0);
    }
    if (g_calc_model == CALC_NONE && !g_force_calc) {
        tilp_device_probe_usb(&g_calc_model, 1);
    }
    g_cable_handle = ticables_handle_new(g_cable_model, PORT_1);
    printf("Handle created: %p\n", (void*)g_cable_handle);

    ticables_options_set_timeout(g_cable_handle, g_cable_timeout);
    ticables_options_set_delay(g_cable_handle, g_cable_delay);
    ticables_handle_show(g_cable_handle);

    return g_cable_handle;
}

EMSCRIPTEN_KEEPALIVE
int open_cable(CableHandle* handle) {
    if (!handle) {
        printf("ERROR: NULL handle provided\n");
        return -1;
    }
    printf("ticables_cable_open()...\n");

    // First, try to enumerate libusb devices to see what we have
    printf("DEBUG: Enumerating libusb devices...\n");
    libusb_context *ctx = nullptr;
    libusb_device **devs;
    const ssize_t cnt = libusb_get_device_list(ctx, &devs);
    printf("DEBUG: Found %d libusb devices\n", (int)cnt);
    if (cnt > 0) {
        for (int i = 0; i < cnt; i++) {
            libusb_device_descriptor desc{};
            const int r = libusb_get_device_descriptor(devs[i], &desc);
            if (r == 0) {
                printf("DEBUG: Device %d: VID=%04x PID=%04x\n", i, desc.idVendor, desc.idProduct);
            }
        }
        libusb_free_device_list(devs, 1);
    }

    const int result = ticables_cable_open(handle);
    printf("Open result: %d\n", result);
    return result;
}

EMSCRIPTEN_KEEPALIVE
int check_cable(CableHandle* handle) {
    if (!handle) {
        printf("ERROR: NULL handle provided\n");
        return -1;
    }
    printf("ticables_cable_check()...\n");
    CableStatus status;
    const int result = ticables_cable_check(handle, &status);
    printf("Check result: %d, status: %d\n", result, status);
    return result;
}

EMSCRIPTEN_KEEPALIVE
int is_ready(CableHandle* cable_handle) {
    if (!cable_handle) {
        printf("ERROR: NULL cable handle provided\n");
        return -1;
    }

    printf("=== Testing Calculator IsReady ===\n");
    printf("is_ready()...\n");
    const int ready_result = ensure_calc_ready(cable_handle, 1);
    printf("Send result: %d\n", ready_result);
    return ready_result;
}

EMSCRIPTEN_KEEPALIVE
int send_probe(CableHandle* handle) {
    if (!handle) {
        printf("ERROR: NULL handle provided\n");
        return -1;
    }
    printf("ticables_cable_send()...\n");
    uint8_t probe_data[] = {0x08, 0x68, 0x00, 0x00};
    const int result = ticables_cable_send(handle, probe_data, sizeof(probe_data));
    printf("Send result: %d\n", result);
    return result;
}

EMSCRIPTEN_KEEPALIVE
int receive_data(CableHandle* handle) {
    if (!handle) {
        printf("ERROR: NULL handle provided\n");
        return -1;
    }
    printf("ticables_cable_recv()...\n");
    uint8_t buffer[256];
    const int result = ticables_cable_recv(handle, buffer, sizeof(buffer));
    printf("Recv result: %d\n", result);
    if (result > 0) {
        printf("Received %d bytes\n", result);
    }
    return result;
}

EMSCRIPTEN_KEEPALIVE
int close_cable(CableHandle* handle) {
    if (!handle) {
        printf("ERROR: NULL handle provided\n");
        return -1;
    }
    printf("ticables_cable_close()...\n");
    if (g_calc_handle && g_calc_attached) {
        ticalcs_cable_detach(g_calc_handle);
        g_calc_attached = 0;
        g_calc_ready = 0;
    }
    const int result = ticables_cable_close(handle);
    printf("Close result: %d\n", result);
    return result;
}

EMSCRIPTEN_KEEPALIVE
int cleanup() {
    printf("library exits...\n");
    if (g_calc_handle) {
        if (g_calc_attached) {
            ticalcs_cable_detach(g_calc_handle);
            g_calc_attached = 0;
            g_calc_ready = 0;
        }
        ticalcs_handle_del(g_calc_handle);
        g_calc_handle = nullptr;
    }
    if (g_cable_handle) {
        ticables_handle_del(g_cable_handle);
        g_cable_handle = nullptr;
    }
    g_calc_model = CALC_NONE;
    g_cable_model = CABLE_USB;
    g_force_cable = 0;
    g_force_calc = 0;
    const int result_tifiles = tifiles_library_exit();
    const int result_ticalcs = ticalcs_library_exit();
    const int result_ticables = ticables_library_exit();
    printf("tifiles_library_exit: %d\n", result_tifiles);
    printf("ticalcs_library_exit: %d\n", result_ticalcs);
    printf("ticables_library_exit: %d\n", result_ticables);
    if (result_ticables != 0) {
        return result_ticables;
    }
    if (result_ticalcs != 0) {
        return result_ticalcs;
    }
    return result_tifiles;
}

EMSCRIPTEN_KEEPALIVE
int get_device_info(CableHandle* handle) {
    if (!handle) {
        printf("ERROR: NULL handle provided\n");
        return -1;
    }
    printf("ticables_cable_get_device_info()...\n");
    CableDeviceInfo info;
    const int result = ticables_cable_get_device_info(handle, &info);
    if (result == 0) {
        printf("Device info: family=%d, variant=%d\n", info.family, info.variant);
    }
    return result;
}

// Helper function to traverse and print directory tree
static void print_dirlist_node(const GNode* node, int depth) {
    if (!node) return;

    VarEntry* ve = (VarEntry*)node->data;
    if (ve) {
        // Print indentation
        for (int i = 0; i < depth; i++) printf("  ");
        printf("%s (type=%02x, size=%u bytes)\n", ve->name, ve->type, ve->size);
    }

    // Recursively print children
    const GNode* child = node->children;
    while (child) {
        print_dirlist_node(child, depth + 1);
        child = child->next;
    }
}

EMSCRIPTEN_KEEPALIVE
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
    const int result = ticalcs_calc_recv_screen_rgb888(g_calc_handle, &sc, &bitmap);

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

EMSCRIPTEN_KEEPALIVE
uint32_t calc_features(CableHandle* cable_handle) {
    if (!cable_handle) {
        printf("ERROR: NULL cable handle provided\n");
        return 0;
    }
    const int attach_result = ensure_calc_handle_attached(cable_handle);
    if (attach_result != 0) {
        return 0;
    }
    return (uint32_t)ticalcs_calc_features(g_calc_handle);
}

EMSCRIPTEN_KEEPALIVE
int calc_send_key(CableHandle* cable_handle, uint32_t key) {
    if (!cable_handle) {
        printf("ERROR: NULL cable handle provided\n");
        return -1;
    }
    const int ready_result = ensure_calc_ready(cable_handle, 0);
    if (ready_result != 0) {
        return ready_result;
    }
    return ticalcs_calc_send_key(g_calc_handle, key);
}

EMSCRIPTEN_KEEPALIVE
const char* calc_get_info_string(CableHandle* cable_handle) {
    if (!cable_handle) {
        printf("ERROR: NULL cable handle provided\n");
        return "";
    }

    const int ready_result = ensure_calc_ready(cable_handle, 0);
    if (ready_result != 0) {
        return "";
    }

    static char info_buf[4096];
    CalcInfos infos{};

    const int result = ticalcs_calc_get_version(g_calc_handle, &infos);
    if (result != 0) {
        printf("ERROR: Failed to get calc infos (error %d)\n", result);
        if (g_cable_model == CABLE_SLV || g_cable_model == CABLE_GRY) {
            printf("Resetting legacy cable session after failed optional device info query\n");
            reset_calc_handle_state();
            g_cable_reopen_needed = 1;
        }
        return "";
    }

    if (ticalcs_infos_to_string(&infos, info_buf, sizeof(info_buf)) != 0) {
        return "";
    }

    update_calc_model_from_infos(&infos);
    return info_buf;
}

static int tilp_calc_check_version(const char *ti9x_ver)
{
    if (tifiles_is_flash(g_calc_model) && ticonv_model_is_ti68k(g_calc_model))
    {
        CalcInfos infos;
        usleep(100000);
        if (ticalcs_calc_get_version(g_calc_handle, &infos) != 0)
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

EMSCRIPTEN_KEEPALIVE
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

    const int result = ticalcs_calc_get_clock(g_calc_handle, &clock);
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

EMSCRIPTEN_KEEPALIVE
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

    return ticalcs_calc_set_clock(g_calc_handle, &clock);
}

EMSCRIPTEN_KEEPALIVE
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
    const int result = ticalcs_calc_get_dirlist(g_calc_handle, &vars, &apps);
    if (result != 0) {
        return result;
    }

    int mem_ok = 0;
    uint32_t ram_free = 0, flash_free = 0;
    if(ticalcs_calc_features(g_calc_handle) & FTS_MEMFREE) {
        usleep(150000);
        mem_ok = (ticalcs_calc_get_memfree(g_calc_handle, &ram_free, &flash_free) == 0);
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
    write_dirlist_json(fp, vars, "var", &first);
    fprintf(fp, "],\"apps\":[");
    first = 1;
    write_dirlist_json(fp, apps, "app", &first);
    fprintf(fp, "]}");
    fclose(fp);

    ticalcs_dirlist_destroy(&vars);
    ticalcs_dirlist_destroy(&apps);

    return 0;
}

EMSCRIPTEN_KEEPALIVE
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

    const int result = ticalcs_calc_recv_backup2(g_calc_handle, path);
    if (result == 0) {
        write_last_path(path);
    }
    return result;
}

EMSCRIPTEN_KEEPALIVE
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

    const int result = ticalcs_calc_recv_tigroup2(g_calc_handle, path, (TigMode)mode);
    if (result == 0) {
        write_last_path(path);
    }
    return result;
}

EMSCRIPTEN_KEEPALIVE
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

    const int result = ticalcs_calc_recv_os2(g_calc_handle, path);
    if (result == 0) {
        write_last_path(path);
    }
    return result;
}

EMSCRIPTEN_KEEPALIVE
int calc_dump_rom_1(CableHandle* cable_handle) {
    if (!cable_handle) {
        printf("ERROR: NULL cable handle provided\n");
        return -1;
    }

    const int ready_result = ensure_calc_ready(cable_handle, 0);
    if (ready_result != 0) {
        return ready_result;
    }

    return ticalcs_calc_dump_rom_1(g_calc_handle);
}

EMSCRIPTEN_KEEPALIVE
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

    const int result = ticalcs_calc_dump_rom_2(g_calc_handle, (CalcDumpSize)size, path);
    if (result == 0) {
        write_last_path(path);
    }
    return result;
}

EMSCRIPTEN_KEEPALIVE
int calc_leave_exam_mode(CableHandle* cable_handle) {
    if (!cable_handle) {
        printf("ERROR: NULL cable handle provided\n");
        return -1;
    }
    const int ready_result = ensure_calc_ready(cable_handle, 0);
    if (ready_result != 0) {
        return ready_result;
    }

    if (model_supports_rclwindw_leave_exam(g_calc_model)) {
        VarRequest vr{};
        VarEntry ve{};

        strncpy(vr.name, "RclWindw", sizeof(vr.name));
        vr.type = rclwindw_type_for_model(g_calc_model);
        strncpy(ve.name, vr.name, sizeof(ve.name));
        ve.type = vr.type;

        char* base = tifiles_build_filename(g_calc_model, &ve);
        if (!base) {
            return 512; // ERR_MALLOC
        }
        char* path = g_build_filename("/tmp", base, nullptr);
        tifiles_filename_free(base);
        if (!path) {
            return 512; // ERR_MALLOC
        }

        int ret = ticalcs_calc_recv_var2(g_calc_handle, MODE_NORMAL, path, &vr);
        if (!ret) {
            ret = ticalcs_calc_send_var2(g_calc_handle, MODE_NORMAL, path);
        }
        remove(path);
        g_free(path);
        return ret;
    }
    if (ticonv_model_is_tinspire(g_calc_model)) {
        int ret = 0;
        if (!ret) {
            // Leave PTT packet
            const uint8_t data[9] = { 0x00, 0x00, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00 };
            ret = nsp_cmd_s_generic_data(g_calc_handle, sizeof(data) / sizeof(data[0]), data, NSP_SID_REMOTE_MGMT, 0x00);
            if (!ret || ret == 266 /*ERR_INVALID_PACKET*/) {
                ret = nsp_cmd_r_generic_data(g_calc_handle, nullptr, nullptr);
            }
        }
        if (!ret) {
            // Reset packet
            const uint8_t data[9] = { 0x00, 0x00, 0x06, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00 };
            ret = nsp_cmd_s_generic_data(g_calc_handle, sizeof(data) / sizeof(data[0]), data, NSP_SID_REMOTE_MGMT, 0x00);
            if (!ret || ret == 266 /*ERR_INVALID_PACKET*/) {
                (void)nsp_cmd_r_generic_data(g_calc_handle, nullptr, nullptr);
            }
        }
        return ret;
    }

    printf("ERROR: Leave exam mode is only supported on TI-Nspire, CE or Evo models\n");
    return -2;
}

EMSCRIPTEN_KEEPALIVE
int calc_leave_exam_mode_supported(void) {
    if (ticonv_model_is_tinspire(g_calc_model)) {
        return 1;
    }
    return model_supports_rclwindw_leave_exam(g_calc_model) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE
int string_to_calc_model(const char* value) {
    if (!value || !*value) {
        return -1;
    }
    return ticonv_string_to_model(value);
}

EMSCRIPTEN_KEEPALIVE
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

    VarEntry req{};
    if (folder && *folder) {
        strncpy(req.folder, folder, sizeof(req.folder) - 1);
    }
    strncpy(req.name, name, sizeof(req.name) - 1);
    req.type = type;

    char* base = tifiles_build_filename(g_calc_model, &req);
    if (!base) {
        return -3;
    }
    const size_t full_len = strlen(dir) + strlen(base) + 2;
    char* full_path = (char*)malloc(full_len);
    if (!full_path) {
        g_free(base);
        return -4;
    }
    snprintf(full_path, full_len, "%s/%s", dir, base);
    g_free(base);

    const int result = ticalcs_calc_recv_var2(g_calc_handle, MODE_NORMAL, full_path, &req);
    if (result == 0) {
        const char* download_path = maybe_convert_received_python_file(full_path, dir);
        write_last_path(download_path);
    }
    free(full_path);
    return result;
}

EMSCRIPTEN_KEEPALIVE
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

    VarEntry req{};
    strncpy(req.name, name, sizeof(req.name) - 1);
    req.type = type;

    char* base = tifiles_build_filename(g_calc_model, &req);
    if (!base) {
        return -3;
    }
    const size_t full_len = strlen(dir) + strlen(base) + 2;
    char* full_path = (char*)malloc(full_len);
    if (!full_path) {
        g_free(base);
        return -4;
    }
    snprintf(full_path, full_len, "%s/%s", dir, base);
    g_free(base);

    const int result = ticalcs_calc_recv_app2(g_calc_handle, full_path, &req);
    if (result == 0) {
        write_last_path(full_path);
    }
    free(full_path);
    return result;
}

EMSCRIPTEN_KEEPALIVE
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

    VarEntry req{};
    if (folder && *folder) {
        strncpy(req.folder, folder, sizeof(req.folder) - 1);
    }
    strncpy(req.name, name, sizeof(req.name) - 1);
    req.type = type;

    return ticalcs_calc_del_var(g_calc_handle, &req);
}

EMSCRIPTEN_KEEPALIVE
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

    return ticalcs_calc_new_fld(g_calc_handle, &req);
}

EMSCRIPTEN_KEEPALIVE
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

    return ticalcs_calc_del_fld(g_calc_handle, &req);
}

EMSCRIPTEN_KEEPALIVE
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

    VarEntry old_req{};
    if (old_folder && *old_folder) {
        strncpy(old_req.folder, old_folder, sizeof(old_req.folder) - 1);
    }
    strncpy(old_req.name, old_name, sizeof(old_req.name) - 1);
    old_req.type = old_type;

    VarEntry new_req{};
    if (new_folder && *new_folder) {
        strncpy(new_req.folder, new_folder, sizeof(new_req.folder) - 1);
    }
    strncpy(new_req.name, new_name, sizeof(new_req.name) - 1);
    new_req.type = new_type;

    return ticalcs_calc_rename_var(g_calc_handle, &old_req, &new_req);
}

EMSCRIPTEN_KEEPALIVE
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

    VarEntry req{};
    if (folder && *folder) {
        strncpy(req.folder, folder, sizeof(req.folder) - 1);
    }
    strncpy(req.name, name, sizeof(req.name) - 1);
    req.type = type;

    return ticalcs_calc_change_attr(g_calc_handle, &req, (FileAttr)attr);
}

static unsigned int compute_location_mask_for_entry(const VarEntry* ve) {
    if (!ve) {
        return (LOC_RAM | LOC_ARCHIVE);
    }
    unsigned int location_mask = (LOC_RAM | LOC_ARCHIVE);
    const int flash_type = tifiles_flash_type(g_calc_model);
    const char* type_name = tifiles_vartype2type(g_calc_model, ve->type);
    if ((flash_type >= 0 && ve->type == (uint8_t)flash_type)
        || (type_name &&
            (  g_ascii_strcasecmp(type_name, "CERT") == 0
            || g_ascii_strcasecmp(type_name, "PIC") == 0
            || g_ascii_strcasecmp(type_name, "IMAGE") == 0
            || g_ascii_strcasecmp(type_name, "GRP") == 0))) {
        location_mask = LOC_ARCHIVE;
    }
    return location_mask;
}

static void append_var_entry_json_with_container(GString* out, const VarEntry* ve, const char* container_type, int container_index) {
    if (!out || !ve) {
        return;
    }
    char name_buf[128] = {};
    char folder_buf[128] = {};
    const char* raw_name = ve->name;
    const char* raw_folder = ve->folder;
    if (raw_name && *raw_name) {
        if (ticonv_varname_to_utf8_sn(g_calc_model, raw_name, name_buf, sizeof(name_buf), ve->type) == nullptr) {
            strncpy(name_buf, raw_name, sizeof(name_buf) - 1);
        }
    }
    if (raw_folder && *raw_folder) {
        if (ticonv_varname_to_utf8_sn(g_calc_model, raw_folder, folder_buf, sizeof(folder_buf), ve->type) == nullptr) {
            strncpy(folder_buf, raw_folder, sizeof(folder_buf) - 1);
        }
    }

    const char* type_name = tifiles_vartype2type(g_calc_model, ve->type);
    const unsigned int location_mask = compute_location_mask_for_entry(ve);

    g_string_append(out, "{\"name\":\"");
    json_append_escaped(out, name_buf);
    g_string_append(out, "\",\"folder\":\"");
    json_append_escaped(out, folder_buf);
    g_string_append(out, "\",\"type\":");
    g_string_append_printf(out, "%u", ve->type);
    g_string_append(out, ",\"type_name\":\"");
    json_append_escaped(out, type_name ? type_name : "");
    g_string_append(out, "\"");
    g_string_append(out, ",\"attr\":");
    g_string_append_printf(out, "%u", ve->attr);
    g_string_append(out, ",\"location_mask\":");
    g_string_append_printf(out, "%u", location_mask);
    g_string_append(out, ",\"size\":");
    g_string_append_printf(out, "%u", ve->size);
    if (container_type && *container_type) {
        g_string_append(out, ",\"container_type\":\"");
        json_append_escaped(out, container_type);
        g_string_append(out, "\"");
        g_string_append(out, ",\"container_index\":");
        g_string_append_printf(out, "%d", container_index);
    }
    g_string_append(out, "}");
}

static void append_var_entry_json(GString* out, const VarEntry* ve) {
    append_var_entry_json_with_container(out, ve, nullptr, -1);
}

static uint32_t get_flash_content_size(const FlashContent* content) {
    if (!content) {
        return 0;
    }
    if (content->data_length > 0) {
        return content->data_length;
    }
    if (content->num_pages > 0 && content->pages) {
        uint64_t total = 0;
        for (unsigned int i = 0; i < content->num_pages; i++) {
            const FlashPage* page = content->pages[i];
            if (!page) {
                continue;
            }
            total += page->size;
        }
        if (total > G_MAXUINT32) {
            return G_MAXUINT32;
        }
        return (uint32_t)total;
    }
    return 0;
}

static void append_flash_entry_json(GString* out, const FlashContent* content, const char* container_type, int container_index, FileClass flash_class) {
    if (!out || !content) {
        return;
    }

    const bool is_os = (flash_class == TIFILE_OS);
    const CalcModel model_for_type = (content->model != CALC_NONE) ? content->model : g_calc_model;
    const uint8_t app_type_id = tifiles_flash_type(model_for_type);
    const uint8_t type_id = (content->data_type != 0)
        ? content->data_type
        : (is_os ? TI83p_AMS : app_type_id);

    char name_buf[128] = {};
    const char* raw_name = content->name;
    if (raw_name && *raw_name) {
        strncpy(name_buf, raw_name, sizeof(name_buf) - 1);
        name_buf[sizeof(name_buf) - 1] = '\0';
        if (!is_os && model_for_type != CALC_NONE && type_id != 0) {
            if (ticonv_varname_to_utf8_sn(model_for_type, raw_name, name_buf, sizeof(name_buf), type_id) == nullptr) {
                strncpy(name_buf, raw_name, sizeof(name_buf) - 1);
                name_buf[sizeof(name_buf) - 1] = '\0';
            }
        }
    }

    // Keep type_name empty for OS so JS falls back to the already-detected file class ("os").
    const char* type_name = (!is_os && model_for_type != CALC_NONE && type_id != 0)
        ? tifiles_vartype2type(model_for_type, type_id)
        : "";

    g_string_append(out, "{\"name\":\"");
    json_append_escaped(out, name_buf);
    g_string_append(out, "\",\"folder\":\"\"");
    g_string_append(out, ",\"type\":");
    g_string_append_printf(out, "%u", (unsigned int)type_id);
    g_string_append(out, ",\"type_name\":\"");
    json_append_escaped(out, type_name ? type_name : "");
    g_string_append(out, "\"");
    g_string_append(out, ",\"attr\":");
    g_string_append_printf(out, "%u", (unsigned int)ATTRB_ARCHIVED);
    g_string_append(out, ",\"location_mask\":");
    g_string_append_printf(out, "%u", (unsigned int)LOC_ARCHIVE);
    g_string_append(out, ",\"size\":");
    g_string_append_printf(out, "%u", get_flash_content_size(content));
    if (container_type && *container_type) {
        g_string_append(out, ",\"container_type\":\"");
        json_append_escaped(out, container_type);
        g_string_append(out, "\"");
        g_string_append(out, ",\"container_index\":");
        g_string_append_printf(out, "%d", container_index);
    }
    g_string_append(out, "}");
}

static void get_file_metadata_json(const char* filename, const char** class_name_out, GString* entries_json_out) {
    if (class_name_out) {
        *class_name_out = "unknown";
    }
    if (!entries_json_out) {
        return;
    }
    if (!filename || !*filename || !tifiles_file_is_ti(filename)) {
        return;
    }

    const FileClass fclass = tifiles_file_get_class(filename);
    CalcModel parse_model = tifiles_file_get_model(filename);
    if (parse_model == CALC_NONE) {
        parse_model = g_calc_model;
    }
    const char* class_name = tifiles_class_to_string(fclass);
    if (class_name_out) {
        *class_name_out = class_name ? class_name : "unknown";
    }

    if (fclass == TIFILE_TIGROUP) {
        TigContent* content = tifiles_content_create_tigroup(parse_model, 0);
        if (!content) {
            return;
        }
        const int ret = tifiles_file_read_tigroup(filename, content);
        if (ret != 0) {
            tifiles_content_delete_tigroup(content);
            return;
        }

        bool first = true;
        for (unsigned int i = 0; i < content->n_vars; i++) {
            const TigEntry* te = content->var_entries[i];
            if (!te || !te->content.regular || te->content.regular->num_entries == 0 || !te->content.regular->entries[0]) {
                continue;
            }
            if (!first) {
                g_string_append(entries_json_out, ",");
            }
            append_var_entry_json_with_container(entries_json_out, te->content.regular->entries[0], "var", (int)i);
            first = false;
        }
        for (unsigned int i = 0; i < content->n_apps; i++) {
            const TigEntry* te = content->app_entries[i];
            if (!te || !te->content.flash) {
                continue;
            }
            if (!first) {
                g_string_append(entries_json_out, ",");
            }
            append_flash_entry_json(entries_json_out, te->content.flash, "app", (int)i, TIFILE_APP);
            first = false;
        }

        tifiles_content_delete_tigroup(content);
        return;
    }

    if (fclass == TIFILE_FLASH || fclass == TIFILE_APP || fclass == TIFILE_OS) {
        FlashContent* content = tifiles_content_create_flash(parse_model);
        if (!content) {
            return;
        }
        const int ret = tifiles_file_read_flash(filename, content);
        if (ret == 0) {
            append_flash_entry_json(entries_json_out, content, nullptr, -1, fclass);
        }
        tifiles_content_delete_flash(content);
        return;
    }

    FileContent* content = tifiles_content_create_regular(parse_model);
    if (!content) {
        return;
    }
    const int ret = tifiles_file_read_regular(filename, content);
    if (ret != 0) {
        tifiles_content_delete_regular(content);
        return;
    }

    bool first = true;
    for (unsigned int i = 0; i < content->num_entries; i++) {
        const VarEntry* ve = content->entries[i];
        if (!ve) {
            continue;
        }
        if (!first) {
            g_string_append(entries_json_out, ",");
        }
        append_var_entry_json(entries_json_out, ve);
        first = false;
    }
    tifiles_content_delete_regular(content);
}

static void apply_var_entry_overrides(VarEntry* ve, const char* folder, int location) {
    if (!ve) {
        return;
    }

    if (folder && *folder) {
        char* raw_folder = ticonv_varname_tokenize(g_calc_model, folder, ve->type);
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
}

static FileContent* create_single_entry_content(const FileContent* source, VarEntry* source_entry) {
    if (!source || !source_entry) {
        return nullptr;
    }

    FileContent* single = tifiles_content_create_regular(source->model);
    if (!single) {
        return nullptr;
    }

    single->model = source->model;
    single->model_dst = source->model_dst;
    single->checksum = source->checksum;
    single->stored_checksum = source->stored_checksum;
    strncpy(single->default_folder, source->default_folder, sizeof(single->default_folder) - 1);
    single->default_folder[sizeof(single->default_folder) - 1] = '\0';
    strncpy(single->comment, source->comment, sizeof(single->comment) - 1);
    single->comment[sizeof(single->comment) - 1] = '\0';
    single->num_entries = 1;
    single->entries = tifiles_ve_create_array(1);
    if (!single->entries) {
        tifiles_content_delete_regular(single);
        return nullptr;
    }
    single->entries[0] = tifiles_ve_dup(source_entry);
    if (!single->entries[0]) {
        tifiles_content_delete_regular(single);
        return nullptr;
    }

    return single;
}

EMSCRIPTEN_KEEPALIVE
const char* file_get_entries_json(const char* filename) {
    static char* json_buf = nullptr;
    static size_t json_len = 0;

    if (!filename || !*filename) {
        return "[]";
    }
    const char* class_name = "unknown";
    GString* entries_json = g_string_new(nullptr);
    get_file_metadata_json(filename, &class_name, entries_json);

    GString* json = g_string_new(nullptr);
    g_string_append(json, "{\"class\":\"");
    json_append_escaped(json, class_name ? class_name : "unknown");
    g_string_append(json, "\",\"entries\":[");
    g_string_append(json, entries_json->str);
    g_string_append(json, "]}");
    g_string_free(entries_json, TRUE);

    if (json_len < json->len + 1) {
        char* new_buf = (char*)realloc(json_buf, json->len + 1);
        if (!new_buf) {
            g_string_free(json, TRUE);
            return "[]";
        }
        json_buf = new_buf;
        json_len = json->len + 1;
    }
    memcpy(json_buf, json->str, json->len + 1);
    g_string_free(json, TRUE);

    return json_buf;
}

EMSCRIPTEN_KEEPALIVE
const char* files_get_entries_json(const char* paths_blob) {
    static char* json_buf = nullptr;
    static size_t json_len = 0;
    gchar** paths = nullptr;
    bool first_file = true;

    GString* json = g_string_new(R"({"files":[)");

    if (!paths_blob || !*paths_blob) {
        g_string_append(json, "]}");
        goto finish;
    }

    paths = g_strsplit(paths_blob, "\n", -1);
    if (!paths) {
        g_string_append(json, "]}");
        goto finish;
    }

    for (gchar** it = paths; it && *it; ++it) {
        const char* filename = *it;
        if (!filename || !*filename) {
            continue;
        }

        char* base = g_path_get_basename(filename);
        if (!base || !*base) {
            g_free(base);
            continue;
        }

        const char* class_name = "unknown";
        GString* entries_json = g_string_new(nullptr);
        get_file_metadata_json(filename, &class_name, entries_json);

        if (!first_file) {
            g_string_append(json, ",");
        }
        g_string_append(json, "{\"name\":\"");
        json_append_escaped(json, base);
        g_string_append(json, "\",\"path\":\"");
        json_append_escaped(json, filename);
        g_string_append(json, "\",\"class\":\"");
        json_append_escaped(json, class_name ? class_name : "unknown");
        g_string_append(json, "\",\"entries\":[");
        g_string_append(json, entries_json->str);
        g_string_append(json, "]");
        g_string_append(json, "}");
        first_file = false;

        g_string_free(entries_json, TRUE);
        g_free(base);
    }

    g_strfreev(paths);
    paths = nullptr;
    g_string_append(json, "]}");

finish:
    if (paths) {
        g_strfreev(paths);
        paths = nullptr;
    }
    if (json_len < json->len + 1) {
        char* new_buf = (char*)realloc(json_buf, json->len + 1);
        if (!new_buf) {
            g_string_free(json, TRUE);
            return R"({"files":[]})";
        }
        json_buf = new_buf;
        json_len = json->len + 1;
    }
    memcpy(json_buf, json->str, json->len + 1);
    g_string_free(json, TRUE);
    return json_buf;
}

EMSCRIPTEN_KEEPALIVE
const char* bundle_extract_json(const char* filename, const char* out_dir) {
    static char* json_buf = nullptr;
    static size_t json_len = 0;
    archive* archive = nullptr;
    archive_entry* entry = nullptr;
    FILE* fp = nullptr;

    if (!out_dir || !*out_dir) {
        return "[]";
    }

    g_mkdir_with_parents(out_dir, 0755);

    GString* json = g_string_new(R"({"dir":")");
    json_append_escaped(json, out_dir);
    g_string_append(json, "\",\"files\":[");

    if (!filename || !*filename) {
        g_string_append(json, "]}");
        goto finish;
    }

    archive = archive_read_new();
    if (!archive) {
        g_string_append(json, "]}");
        goto finish;
    }
    archive_read_support_format_zip(archive);
    archive_read_support_filter_all(archive);

    if (archive_read_open_filename(archive, filename, 10240) != ARCHIVE_OK) {
        fp = fopen(filename, "rb");
        if (fp) {
            if (archive_read_open_FILE(archive, fp) != ARCHIVE_OK) {
                fclose(fp);
                fp = nullptr;
                g_string_append(json, "]}");
                goto finish;
            }
        } else {
            g_string_append(json, "]}");
            goto finish;
        }
    }

    {
        bool first = true;
        while (true) {
            int header_status = archive_read_next_header(archive, &entry);
            if (header_status == ARCHIVE_EOF) {
                break;
            }
            if (header_status != ARCHIVE_OK) {
                break;
            }
            const char* pathname = archive_entry_pathname(entry);
            if (!pathname || !*pathname) {
                archive_read_data_skip(archive);
                continue;
            }
            if (archive_entry_filetype(entry) == AE_IFDIR) {
                archive_read_data_skip(archive);
                continue;
            }
            char* base = g_path_get_basename(pathname);
            if (!base || !*base) {
                g_free(base);
                archive_read_data_skip(archive);
                continue;
            }
            if (g_ascii_strcasecmp(base, "METADATA") == 0 || g_ascii_strcasecmp(base, "_CHECKSUM") == 0) {
                g_free(base);
                archive_read_data_skip(archive);
                continue;
            }

            char* out_path = g_build_filename(out_dir, base, nullptr);
            if (g_file_test(out_path, G_FILE_TEST_EXISTS)) {
                const char* dot = strrchr(base, '.');
                char* stem = nullptr;
                const char* ext = "";
                if (dot && dot != base) {
                    stem = g_strndup(base, (gsize)(dot - base));
                    ext = dot;
                } else {
                    stem = g_strdup(base);
                }

                unsigned int suffix = 1;
                while (g_file_test(out_path, G_FILE_TEST_EXISTS)) {
                    g_free(out_path);
                    char* suffixed = g_strdup_printf("%s_%u%s", stem, suffix, ext);
                    out_path = g_build_filename(out_dir, suffixed, nullptr);
                    g_free(suffixed);
                    suffix++;
                }
                g_free(stem);
            }
            FILE* fp_out = fopen(out_path, "wb");
            if (!fp_out) {
                g_free(out_path);
                g_free(base);
                archive_read_data_skip(archive);
                continue;
            }
            int fd = fileno(fp_out);
            la_ssize_t bytes = archive_read_data_into_fd(archive, fd);
            fclose(fp_out);
            if (bytes < 0) {
                unlink(out_path);
                g_free(out_path);
                g_free(base);
                continue;
            }

            const char* class_name = "unknown";
            GString* entries_json = g_string_new(nullptr);
            get_file_metadata_json(out_path, &class_name, entries_json);
            char* out_base = g_path_get_basename(out_path);
            if (!first) {
                g_string_append(json, ",");
            }
            g_string_append(json, "{\"name\":\"");
            json_append_escaped(json, out_base ? out_base : base);
            g_string_append(json, "\",\"path\":\"");
            json_append_escaped(json, out_path);
            g_string_append(json, "\",\"class\":\"");
            json_append_escaped(json, class_name ? class_name : "unknown");
            g_string_append(json, "\",\"entries\":[");
            g_string_append(json, entries_json->str);
            g_string_append(json, "]");
            g_string_append(json, "}");
            first = false;

            g_string_free(entries_json, TRUE);
            g_free(out_base);
            g_free(out_path);
            g_free(base);
        }
    }

    g_string_append(json, "]}");

finish:
    if (archive) {
        archive_read_close(archive);
        archive_read_free(archive);
    }
    if (fp) {
        fclose(fp);
    }

    if (json_len < json->len + 1) {
        char* new_buf = (char*)realloc(json_buf, json->len + 1);
        if (!new_buf) {
            g_string_free(json, TRUE);
            return "[]";
        }
        json_buf = new_buf;
        json_len = json->len + 1;
    }
    memcpy(json_buf, json->str, json->len + 1);
    g_string_free(json, TRUE);
    return json_buf;
}

EMSCRIPTEN_KEEPALIVE
int send_file_custom(CableHandle* cable_handle, const char* filename, const char* folder, int location) {
    if (!filename || !*filename) {
        printf("ERROR: No filename provided\n");
        return ERR_WEB_INVALID_ARGUMENT;
    }

    printf("=== Sending File: %s ===\n", filename);
    if (!tifiles_file_is_ti(filename)) {
        printf("ERROR: Not a recognized TI file\n");
        return ERR_WEB_NOT_TI_FILE;
    }

    int result = 0;
    const FileClass fclass = tifiles_file_get_class(filename);
    int ready_result = 0;

    if (tifiles_file_is_os(filename)) {
        // OS receive/boot mode does not support the standard ready check.
        ready_result = ensure_calc_handle_attached(cable_handle);
    } else {
        ready_result = ensure_calc_ready(cable_handle, 0);
    }
    if (ready_result != 0) {
        return ready_result;
    }

    if (tifiles_file_is_os(filename)) {
        result = ticalcs_calc_send_os2(g_calc_handle, filename);
    } else if (tifiles_file_is_app(filename)) {
        result = ticalcs_calc_send_app2(g_calc_handle, filename);
    } else if (tifiles_file_is_tigroup(filename)) {
        result = ticalcs_calc_send_tigroup2(g_calc_handle, filename, (TigMode)(TIG_ALL | TIG_BACKUP));
    } else if (fclass == TIFILE_BACKUP) {
        result = ticalcs_calc_send_backup2(g_calc_handle, filename);
    } else {
        FileContent* content = tifiles_content_create_regular(g_calc_model);
        if (!content) {
            return ERR_WEB_OUT_OF_MEMORY;
        }
        result = tifiles_file_read_regular(filename, content);
        if (result != 0) {
            tifiles_content_delete_regular(content);
            return result;
        }

        for (unsigned int i = 0; i < content->num_entries; i++) {
            VarEntry* ve = content->entries[i];
            if (!ve) {
                continue;
            }
            apply_var_entry_overrides(ve, folder, location);
        }

        result = ticalcs_calc_send_var(g_calc_handle, MODE_NORMAL, content);
        tifiles_content_delete_regular(content);
    }

    printf("Send result: %d\n", result);
    return result;
}

EMSCRIPTEN_KEEPALIVE
int send_file_entry_custom(CableHandle* cable_handle, const char* filename, int entry_index, int container_kind, const char* folder, int location) {
    if (!filename || !*filename) {
        printf("ERROR: No filename provided\n");
        return ERR_WEB_INVALID_ARGUMENT;
    }
    if (entry_index < 0) {
        printf("ERROR: Invalid entry index %d\n", entry_index);
        return ERR_WEB_INVALID_ENTRY_INDEX;
    }

    printf("=== Sending File Entry: %s [index=%d kind=%d] ===\n", filename, entry_index, container_kind);
    if (!tifiles_file_is_ti(filename)) {
        printf("ERROR: Not a recognized TI file\n");
        return ERR_WEB_NOT_TI_FILE;
    }

    const int ready_result = ensure_calc_ready(cable_handle, 0);
    if (ready_result != 0) {
        return ready_result;
    }

    int result = 0;
    const FileClass fclass = tifiles_file_get_class(filename);
    if (fclass == TIFILE_TIGROUP) {
        TigContent* content = tifiles_content_create_tigroup(g_calc_model, 0);
        if (!content) {
            return ERR_WEB_OUT_OF_MEMORY;
        }
        result = tifiles_file_read_tigroup(filename, content);
        if (result != 0) {
            tifiles_content_delete_tigroup(content);
            return result;
        }

        if (container_kind == 2) {
            if ((unsigned int)entry_index >= content->n_apps || !content->app_entries[entry_index] || !content->app_entries[entry_index]->content.flash) {
                tifiles_content_delete_tigroup(content);
                return ERR_WEB_INVALID_ENTRY_INDEX;
            }
            result = ticalcs_calc_send_app(g_calc_handle, content->app_entries[entry_index]->content.flash);
        } else {
            if ((unsigned int)entry_index >= content->n_vars || !content->var_entries[entry_index] || !content->var_entries[entry_index]->content.regular) {
                tifiles_content_delete_tigroup(content);
                return ERR_WEB_INVALID_ENTRY_INDEX;
            }
            FileContent* regular = content->var_entries[entry_index]->content.regular;
            if (!regular || regular->num_entries == 0 || !regular->entries[0]) {
                tifiles_content_delete_tigroup(content);
                return ERR_WEB_INVALID_ENTRY_INDEX;
            }
            FileContent* single = create_single_entry_content(regular, regular->entries[0]);
            if (!single) {
                tifiles_content_delete_tigroup(content);
                return ERR_WEB_OUT_OF_MEMORY;
            }
            apply_var_entry_overrides(single->entries[0], folder, location);
            result = ticalcs_calc_send_var(g_calc_handle, MODE_NORMAL, single);
            tifiles_content_delete_regular(single);
        }

        tifiles_content_delete_tigroup(content);
    } else {
        FileContent* content = tifiles_content_create_regular(g_calc_model);
        if (!content) {
            return ERR_WEB_OUT_OF_MEMORY;
        }
        result = tifiles_file_read_regular(filename, content);
        if (result != 0) {
            tifiles_content_delete_regular(content);
            return result;
        }
        if ((unsigned int)entry_index >= content->num_entries || !content->entries[entry_index]) {
            tifiles_content_delete_regular(content);
            return ERR_WEB_INVALID_ENTRY_INDEX;
        }

        FileContent* single = create_single_entry_content(content, content->entries[entry_index]);
        if (!single) {
            tifiles_content_delete_regular(content);
            return ERR_WEB_OUT_OF_MEMORY;
        }

        apply_var_entry_overrides(single->entries[0], folder, location);
        result = ticalcs_calc_send_var(g_calc_handle, MODE_NORMAL, single);
        tifiles_content_delete_regular(single);
        tifiles_content_delete_regular(content);
    }

    printf("Send entry result: %d\n", result);
    return result;
}

} // extern "C"

int main() {
    //g_setenv("G_MESSAGES_DEBUG", "all", TRUE);
    return 0;
}
