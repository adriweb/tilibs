#include <archive.h>
#include <archive_entry.h>
#include <emscripten.h>

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <algorithm>
#include <sstream>
#include <string>
#include <vector>

#include "hp_prime_app.h"

extern "C" {
#include <hpcables.h>
#include <hpcalcs.h>
#include <hpfiles.h>
#include <hplibs.h>
#include <prime_cmd.h>
}

EM_JS(void, hp_prime_file_arrived_js, (const char* json), {
    if (Module.__hpPrimeFileArrived) {
        Module.__hpPrimeFileArrived(UTF8ToString(json));
    }
});

namespace {

static cable_handle* g_hp_cable = nullptr;
static calc_handle* g_hp_calc = nullptr;
static files_var_entry** g_hp_file_cache = nullptr;
static bool g_hp_libraries_initialized = false;
static bool g_hp_connected = false;
static std::string g_hp_protocol_diagnostics;

enum {
    HP_WEB_INVALID_ARGUMENT = -2001,
    HP_WEB_NOT_CONNECTED = -2002,
    HP_WEB_FILE_ERROR = -2003,
    HP_WEB_ARCHIVE_ERROR = -2004,
    HP_WEB_APP_FORMAT_ERROR = -2005,
    HP_WEB_APP_CORE_READ_ONLY = -2006
};

static void capture_hp_log(const char* format, va_list args)
{
    char line[768];
    size_t length;
    if (!format || (!strstr(format, " WARN: ") && !strstr(format, " ERROR: "))) {
        return;
    }
    vsnprintf(line, sizeof(line), format, args);
    length = strlen(line);
    while (length != 0 && (line[length - 1] == '\n' || line[length - 1] == '\r')) {
        line[--length] = '\0';
    }
    if (g_hp_protocol_diagnostics.size() >= 2048 || length == 0) {
        return;
    }
    if (!g_hp_protocol_diagnostics.empty()) {
        if (g_hp_protocol_diagnostics.size() > 2048U - 3U) {
            return;
        }
        g_hp_protocol_diagnostics += " | ";
    }
    g_hp_protocol_diagnostics.append(line,
        std::min(length, 2048U - g_hp_protocol_diagnostics.size()));
}

static void clear_hp_protocol_diagnostics()
{
    g_hp_protocol_diagnostics.clear();
}

static void append_utf8(std::string& out, uint32_t codepoint)
{
    if (codepoint <= 0x7f) {
        out.push_back((char)codepoint);
    } else if (codepoint <= 0x7ff) {
        out.push_back((char)(0xc0 | (codepoint >> 6)));
        out.push_back((char)(0x80 | (codepoint & 0x3f)));
    } else if (codepoint <= 0xffff) {
        out.push_back((char)(0xe0 | (codepoint >> 12)));
        out.push_back((char)(0x80 | ((codepoint >> 6) & 0x3f)));
        out.push_back((char)(0x80 | (codepoint & 0x3f)));
    } else {
        out.push_back((char)(0xf0 | (codepoint >> 18)));
        out.push_back((char)(0x80 | ((codepoint >> 12) & 0x3f)));
        out.push_back((char)(0x80 | ((codepoint >> 6) & 0x3f)));
        out.push_back((char)(0x80 | (codepoint & 0x3f)));
    }
}

static std::string prime_name_to_utf8(const char16_t* name)
{
    std::string result;
    if (!name) {
        return result;
    }
    for (size_t i = 0; i < FILES_VARNAME_MAXLEN && name[i]; i++) {
        uint32_t codepoint = name[i];
        if (codepoint >= 0xd800 && codepoint <= 0xdbff
            && i + 1 < FILES_VARNAME_MAXLEN
            && name[i + 1] >= 0xdc00 && name[i + 1] <= 0xdfff) {
            codepoint = 0x10000U + ((codepoint - 0xd800U) << 10)
                + (name[++i] - 0xdc00U);
        } else if (codepoint >= 0xd800 && codepoint <= 0xdfff) {
            codepoint = 0xfffd;
        }
        append_utf8(result, codepoint);
    }
    return result;
}

static bool utf8_to_prime_name(const char* input, char16_t* output)
{
    if (!input || !output) {
        return false;
    }
    size_t count = 0;
    const unsigned char* ptr = (const unsigned char*)input;
    while (*ptr) {
        uint32_t codepoint;
        size_t continuation;
        if (*ptr < 0x80) {
            codepoint = *ptr++;
            continuation = 0;
        } else if ((*ptr & 0xe0) == 0xc0) {
            codepoint = *ptr++ & 0x1f;
            continuation = 1;
        } else if ((*ptr & 0xf0) == 0xe0) {
            codepoint = *ptr++ & 0x0f;
            continuation = 2;
        } else if ((*ptr & 0xf8) == 0xf0) {
            codepoint = *ptr++ & 0x07;
            continuation = 3;
        } else {
            return false;
        }
        for (size_t i = 0; i < continuation; i++) {
            if ((*ptr & 0xc0) != 0x80) {
                return false;
            }
            codepoint = (codepoint << 6) | (*ptr++ & 0x3f);
        }
        if (codepoint > 0x10ffffU || (codepoint >= 0xd800U && codepoint <= 0xdfffU)) {
            return false;
        }
        if (codepoint <= 0xffffU) {
            if (count >= FILES_VARNAME_MAXLEN) {
                return false;
            }
            output[count++] = (char16_t)codepoint;
        } else {
            if (count + 1 >= FILES_VARNAME_MAXLEN) {
                return false;
            }
            codepoint -= 0x10000U;
            output[count++] = (char16_t)(0xd800U | (codepoint >> 10));
            output[count++] = (char16_t)(0xdc00U | (codepoint & 0x3ffU));
        }
    }
    output[count] = 0;
    return count != 0;
}

static void clear_file_cache()
{
    if (g_hp_file_cache) {
        hpfiles_ve_delete_array(g_hp_file_cache);
    }
    g_hp_file_cache = nullptr;
}

static std::string safe_archive_component(const std::string& input)
{
    std::string result;
    for (unsigned char c : input) {
        if (c == '/' || c == '\\' || c < 0x20 || c == 0x7f) {
            result.push_back('_');
        } else {
            result.push_back((char)c);
        }
    }
    if (result.empty()) {
        result = "unnamed";
    }
    return result;
}

static std::string json_escape(const std::string& input)
{
    std::string result;
    for (unsigned char c : input) {
        switch (c) {
            case '"': result += "\\\""; break;
            case '\\': result += "\\\\"; break;
            case '\b': result += "\\b"; break;
            case '\f': result += "\\f"; break;
            case '\n': result += "\\n"; break;
            case '\r': result += "\\r"; break;
            case '\t': result += "\\t"; break;
            default:
                if (c < 0x20) {
                    char encoded[7];
                    snprintf(encoded, sizeof(encoded), "\\u%04x", c);
                    result += encoded;
                } else {
                    result.push_back((char)c);
                }
        }
    }
    return result;
}

static std::string filename_extension(const std::string& name)
{
    const size_t slash = name.find_last_of("/\\");
    const size_t dot = name.find_last_of('.');
    if (dot == std::string::npos || dot + 1U >= name.size()
        || (slash != std::string::npos && dot < slash)) {
        return std::string();
    }
    return name.substr(dot + 1U);
}

static const char* app_part_kind_name(hp_prime_app::PartKind kind)
{
    switch (kind) {
        case hp_prime_app::PartKind::Descriptor: return "descriptor";
        case hp_prime_app::PartKind::Note: return "note";
        case hp_prime_app::PartKind::Program: return "program";
        case hp_prime_app::PartKind::Resource: return "resource";
    }
    return "resource";
}

static std::string prime_file_to_json(const files_var_entry* file, size_t index)
{
    const char* extension = hpfiles_vartype2fext(CALC_PRIME, file->type);
    std::ostringstream output;
    output << "{\"index\":" << index
           << ",\"name\":\"" << json_escape(prime_name_to_utf8(file->name))
           << "\",\"type\":" << (unsigned int)file->type
           << ",\"typeName\":\""
           << json_escape(hpfiles_vartype2str(CALC_PRIME, file->type))
           << "\",\"extension\":\""
           << json_escape(extension ? extension : "")
           << "\",\"size\":" << file->size
           << ",\"invalid\":" << (file->invalid ? "true" : "false");
    if (file->type == PRIME_TYPE_APP && file->data) {
        hp_prime_app::Parsed app;
        std::string error;
        const bool valid = hp_prime_app::parse(file->data, file->size,
            prime_name_to_utf8(file->name), &app, &error);
        output << ",\"appContainerValid\":" << (valid ? "true" : "false");
        if (valid) {
            output << ",\"children\":[";
            for (size_t child_index = 0; child_index < app.parts.size(); child_index++) {
                const hp_prime_app::Part& part = app.parts[child_index];
                if (child_index != 0) {
                    output << ',';
                }
                output << "{\"index\":" << child_index
                       << ",\"name\":\"" << json_escape(part.name)
                       << "\",\"kind\":\"" << app_part_kind_name(part.kind)
                       << "\",\"extension\":\""
                       << json_escape(filename_extension(part.name))
                       << "\",\"size\":" << part.data_size
                       << ",\"editable\":"
                       << (part.kind == hp_prime_app::PartKind::Resource
                           ? "true" : "false")
                       << '}';
            }
            output << ']';
        }
    }
    output << '}';
    return output.str();
}

static files_var_entry* cached_file_at(size_t index)
{
    if (!g_hp_file_cache) {
        return nullptr;
    }
    size_t count = 0;
    while (g_hp_file_cache[count] && count < index) {
        count++;
    }
    return count == index ? g_hp_file_cache[count] : nullptr;
}

static bool parse_cached_app(size_t index, files_var_entry** file,
                             hp_prime_app::Parsed* app)
{
    files_var_entry* cached = cached_file_at(index);
    std::string error;
    if (!cached || cached->type != PRIME_TYPE_APP || !cached->data
        || !hp_prime_app::parse(cached->data, cached->size,
            prime_name_to_utf8(cached->name), app, &error)) {
        g_hp_protocol_diagnostics = error.empty()
            ? "cached entry is not a parsed HP Prime application" : error;
        return false;
    }
    *file = cached;
    return true;
}

static int read_binary_file(const char* path, std::vector<uint8_t>* data)
{
    FILE* fp = fopen(path, "rb");
    if (!fp) {
        return HP_WEB_FILE_ERROR;
    }
    int result = HP_WEB_FILE_ERROR;
    if (fseek(fp, 0, SEEK_END) == 0) {
        const long length = ftell(fp);
        if (length >= 0 && (unsigned long)length <= UINT32_MAX
            && fseek(fp, 0, SEEK_SET) == 0) {
            data->resize((size_t)length);
            if (length == 0
                || fread(data->data(), 1, (size_t)length, fp) == (size_t)length) {
                result = 0;
            }
        }
    }
    fclose(fp);
    return result;
}

static bool read_manifest_u32(const std::vector<uint8_t>& manifest,
                              size_t* offset, uint32_t* value)
{
    if (!offset || !value || *offset > manifest.size()
        || manifest.size() - *offset < 4U) {
        return false;
    }
    *value = ((uint32_t)manifest[*offset] << 24)
        | ((uint32_t)manifest[*offset + 1U] << 16)
        | ((uint32_t)manifest[*offset + 2U] << 8)
        | (uint32_t)manifest[*offset + 3U];
    *offset += 4U;
    return true;
}

static int send_rebuilt_app(size_t index, files_var_entry* original,
                            const std::vector<uint8_t>& rebuilt)
{
    if (rebuilt.size() > UINT32_MAX) {
        return HP_WEB_FILE_ERROR;
    }
    files_var_entry* replacement = hpfiles_ve_create_with_size(
        (uint32_t)rebuilt.size());
    if (!replacement) {
        return HP_WEB_FILE_ERROR;
    }
    std::copy(original->name, original->name + FILES_VARNAME_MAXLEN + 1,
              replacement->name);
    replacement->type = original->type;
    replacement->model = original->model;
    replacement->invalid = 0;
    if (!rebuilt.empty()) {
        memcpy(replacement->data, rebuilt.data(), rebuilt.size());
    }
    const int result = hpcalcs_calc_send_file(g_hp_calc, replacement);
    if (result == 0) {
        hpfiles_ve_delete(g_hp_file_cache[index]);
        g_hp_file_cache[index] = replacement;
    } else {
        hpfiles_ve_delete(replacement);
    }
    return result;
}

static bool ascii_case_equal(const std::string& left, const std::string& right)
{
    if (left.size() != right.size()) {
        return false;
    }
    for (size_t i = 0; i < left.size(); i++) {
        unsigned char a = (unsigned char)left[i];
        unsigned char b = (unsigned char)right[i];
        if (a >= 'A' && a <= 'Z') a = (unsigned char)(a + 32);
        if (b >= 'A' && b <= 'Z') b = (unsigned char)(b + 32);
        if (a != b) {
            return false;
        }
    }
    return true;
}

static int refresh_file_cache()
{
    clear_file_cache();
    g_hp_file_cache = hpfiles_ve_create_array(0);
    if (!g_hp_file_cache) {
        return HP_WEB_FILE_ERROR;
    }

    int result = calc_prime_s_recv_backup(g_hp_calc);
    if (result != 0) {
        return result;
    }

    size_t count = 0;
    for (;;) {
        files_var_entry* entry = nullptr;
        result = calc_prime_r_recv_file(g_hp_calc, &entry);
        if (result != 0) {
            if (entry) {
                hpfiles_ve_delete(entry);
            }
            return result;
        }
        if (!entry) {
            return 0;
        }

        files_var_entry** resized = hpfiles_ve_resize_array(
            g_hp_file_cache, (uint32_t)(count + 1));
        if (!resized) {
            hpfiles_ve_delete(entry);
            return HP_WEB_FILE_ERROR;
        }
        g_hp_file_cache = resized;
        g_hp_file_cache[count] = entry;
        g_hp_file_cache[++count] = nullptr;

        const std::string json = prime_file_to_json(entry, count - 1);
        hp_prime_file_arrived_js(json.c_str());
    }
}

static int add_archive_file(struct archive* output, const std::string& path,
                            const void* data, size_t size)
{
    struct archive_entry* entry = archive_entry_new();
    if (!entry) {
        return HP_WEB_ARCHIVE_ERROR;
    }
    archive_entry_set_pathname(entry, path.c_str());
    archive_entry_set_filetype(entry, AE_IFREG);
    archive_entry_set_perm(entry, 0644);
    archive_entry_set_size(entry, (la_int64_t)size);
    int result = archive_write_header(output, entry);
    if (result >= ARCHIVE_WARN && size != 0) {
        const la_ssize_t written = archive_write_data(output, data, size);
        if (written < 0 || (size_t)written != size) {
            result = ARCHIVE_FATAL;
        }
    }
    archive_entry_free(entry);
    return result >= ARCHIVE_WARN ? 0 : HP_WEB_ARCHIVE_ERROR;
}

static int write_backup_archive(const char* path, files_var_entry** entries)
{
    std::vector<std::string> archive_paths;
    std::ostringstream manifest;
    size_t count = 0;
    while (entries && entries[count] && count < 100000) {
        count++;
    }

    manifest << "{\"format\":\"webtilp-hp-prime-backup-v1\",\"files\":[";
    for (size_t i = 0; i < count; i++) {
        const files_var_entry* file = entries[i];
        const std::string name = prime_name_to_utf8(file->name);
        const std::string safe_name = safe_archive_component(name);
        const char* extension = hpfiles_vartype2fext(CALC_PRIME, file->type);
        char prefix[32];
        snprintf(prefix, sizeof(prefix), "files/%05zu-", i);
        std::string archive_path = prefix + safe_name;
        if (extension && *extension) {
            archive_path += ".";
            archive_path += safe_archive_component(extension);
        }
        archive_paths.push_back(archive_path);
        if (i != 0) {
            manifest << ',';
        }
        manifest << "{\"path\":\"" << json_escape(archive_path)
                 << "\",\"name\":\"" << json_escape(name)
                 << "\",\"type\":" << (unsigned int)file->type
                 << ",\"typeName\":\""
                 << json_escape(hpfiles_vartype2str(CALC_PRIME, file->type))
                 << "\",\"size\":" << file->size
                 << ",\"invalid\":" << (file->invalid ? "true" : "false")
                 << '}';
    }
    manifest << "]}";

    struct archive* output = archive_write_new();
    if (!output) {
        return HP_WEB_ARCHIVE_ERROR;
    }
    int result = archive_write_set_format_zip(output);
    if (result == ARCHIVE_OK) {
        result = archive_write_open_filename(output, path);
    }
    if (result == ARCHIVE_OK) {
        const std::string manifest_data = manifest.str();
        result = add_archive_file(output, "manifest.json", manifest_data.data(),
                                  manifest_data.size()) == 0
            ? ARCHIVE_OK : ARCHIVE_FATAL;
    }
    for (size_t i = 0; result == ARCHIVE_OK && i < count; i++) {
        result = add_archive_file(output, archive_paths[i], entries[i]->data,
                                  entries[i]->size) == 0
            ? ARCHIVE_OK : ARCHIVE_FATAL;
    }
    const int close_result = archive_write_close(output);
    archive_write_free(output);
    return result == ARCHIVE_OK && close_result == ARCHIVE_OK
        ? 0 : HP_WEB_ARCHIVE_ERROR;
}

static void destroy_connection()
{
    clear_file_cache();
    if (g_hp_calc) {
        hpcalcs_handle_del(g_hp_calc);
        g_hp_calc = nullptr;
    }
    if (g_hp_cable) {
        hpcables_handle_del(g_hp_cable);
        g_hp_cable = nullptr;
    }
    g_hp_connected = false;
}

} // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE
int hp_prime_library_init(void)
{
    hpfiles_config files_config{};
    hpcables_config cables_config{};
    hpcalcs_config calcs_config{};
    if (g_hp_libraries_initialized) {
        return 0;
    }
    files_config.version = HPFILES_CONFIG_VERSION;
    files_config.log_callback = capture_hp_log;
    cables_config.version = HPCABLES_CONFIG_VERSION;
    cables_config.log_callback = capture_hp_log;
    calcs_config.version = HPCALCS_CONFIG_VERSION;
    calcs_config.log_callback = capture_hp_log;
    int result = hpfiles_init(&files_config);
    if (result != 0) {
        return result;
    }
    result = hpcables_init(&cables_config);
    if (result != 0) {
        hpfiles_exit();
        return result;
    }
    result = hpcalcs_init(&calcs_config);
    if (result != 0) {
        hpcables_exit();
        hpfiles_exit();
        return result;
    }
    g_hp_libraries_initialized = true;
    return 0;
}

EMSCRIPTEN_KEEPALIVE
int hp_prime_disconnect(void)
{
    destroy_connection();
    return 0;
}

EMSCRIPTEN_KEEPALIVE
int hp_prime_library_exit(void)
{
    destroy_connection();
    if (!g_hp_libraries_initialized) {
        return 0;
    }
    const int calcs_result = hpcalcs_exit();
    const int cables_result = hpcables_exit();
    const int files_result = hpfiles_exit();
    g_hp_libraries_initialized = false;
    if (calcs_result != 0) {
        return calcs_result;
    }
    if (cables_result != 0) {
        return cables_result;
    }
    return files_result;
}

EMSCRIPTEN_KEEPALIVE
int hp_prime_connect(void)
{
    clear_hp_protocol_diagnostics();
    int result = hp_prime_library_init();
    if (result != 0) {
        return result;
    }
    destroy_connection();
    g_hp_cable = hpcables_handle_new(CABLE_PRIME_HID);
    g_hp_calc = hpcalcs_handle_new(CALC_PRIME);
    if (!g_hp_cable || !g_hp_calc) {
        destroy_connection();
        return HP_WEB_FILE_ERROR;
    }
    result = hpcalcs_cable_attach(g_hp_calc, g_hp_cable);
    if (result != 0) {
        destroy_connection();
        return result;
    }

    calc_infos infos{};
    result = hpcalcs_calc_get_infos(g_hp_calc, &infos);
    free(infos.data);
    if (result != 0) {
        destroy_connection();
        return result;
    }

    result = hpcalcs_prime_negotiate_protocol(g_hp_calc);
    if (result != 0) {
        destroy_connection();
        return result;
    }
    g_hp_connected = true;
    return 0;
}

EMSCRIPTEN_KEEPALIVE
int hp_prime_is_connected(void)
{
    return g_hp_connected ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE
const char* hp_prime_get_error_message(int error)
{
    static std::string result;
    switch (error) {
        case 0: result = "Success"; return result.c_str();
        case HP_WEB_INVALID_ARGUMENT:
            result = "Invalid HP Prime argument or unsupported filename";
            return result.c_str();
        case HP_WEB_NOT_CONNECTED:
            result = "HP Prime is not connected";
            return result.c_str();
        case HP_WEB_FILE_ERROR:
            result = "Unable to read or write the transfer file";
            return result.c_str();
        case HP_WEB_ARCHIVE_ERROR:
            result = "Unable to create the HP Prime backup archive";
            return result.c_str();
        case HP_WEB_APP_FORMAT_ERROR:
            result = "Unable to parse or rebuild the HP Prime application";
            if (!g_hp_protocol_diagnostics.empty()) {
                result += ": ";
                result += g_hp_protocol_diagnostics;
            }
            return result.c_str();
        case HP_WEB_APP_CORE_READ_ONLY:
            result = "HP Prime application descriptor, note, and program parts are read-only";
            return result.c_str();
        default: break;
    }

    char* native_message = nullptr;
    hplibs_error_get(error, &native_message);
    if (native_message && *native_message) {
        result = native_message;
    } else {
        result = "Unknown HP Prime error";
    }
    free(native_message);
    if (!g_hp_protocol_diagnostics.empty()) {
        result += ": ";
        result += g_hp_protocol_diagnostics;
    }
    return result.c_str();
}

EMSCRIPTEN_KEEPALIVE
const char* hp_prime_get_info_json(void)
{
    static std::string json;
    if (!g_hp_connected || !g_hp_calc) {
        json.clear();
        return json.c_str();
    }
    calc_prime_protocol_info info{};
    if (hpcalcs_prime_get_protocol_info(g_hp_calc, &info) != 0) {
        json.clear();
        return json.c_str();
    }
    std::ostringstream output;
    output << "{\"build\":" << info.build
           << ",\"version\":\"" << json_escape(info.version)
           << "\",\"serial\":\"" << json_escape(info.serial)
           << "\",\"protocol\":" << (unsigned int)info.protocol_version
           << ",\"supportsV2\":" << (info.supports_v2 ? "true" : "false")
           << '}';
    json = output.str();
    return json.c_str();
}

EMSCRIPTEN_KEEPALIVE
int hp_prime_screenshot(const char* path, int requested_format)
{
    clear_hp_protocol_diagnostics();
    if (!g_hp_connected || !g_hp_calc) {
        return HP_WEB_NOT_CONNECTED;
    }
    const char* output_path = path && *path ? path : "/hp-prime-screenshot.png";
    calc_screenshot_format format = (calc_screenshot_format)requested_format;
    if (format < CALC_SCREENSHOT_FORMAT_FIRST
        || format >= CALC_SCREENSHOT_FORMAT_LAST) {
        format = CALC_SCREENSHOT_FORMAT_PRIME_PNG_320x240x16;
    }
    uint8_t* data = nullptr;
    uint32_t size = 0;
    int result = hpcalcs_calc_recv_screen(g_hp_calc, format, &data, &size);
    if (result == 0) {
        FILE* fp = fopen(output_path, "wb");
        if (!fp || (size != 0 && fwrite(data, 1, size, fp) != size)) {
            result = HP_WEB_FILE_ERROR;
        }
        if (fp) {
            fclose(fp);
        }
    }
    free(data);
    return result;
}

EMSCRIPTEN_KEEPALIVE
int hp_prime_backup(const char* path)
{
    clear_hp_protocol_diagnostics();
    if (!g_hp_connected || !g_hp_calc) {
        return HP_WEB_NOT_CONNECTED;
    }
    if (!path || !*path) {
        return HP_WEB_INVALID_ARGUMENT;
    }
    int result = refresh_file_cache();
    if (result == 0) {
        result = write_backup_archive(path, g_hp_file_cache);
    }
    return result;
}

EMSCRIPTEN_KEEPALIVE
int hp_prime_refresh_files(void)
{
    clear_hp_protocol_diagnostics();
    if (!g_hp_connected || !g_hp_calc) {
        return HP_WEB_NOT_CONNECTED;
    }
    return refresh_file_cache();
}

EMSCRIPTEN_KEEPALIVE
const char* hp_prime_get_files_json(void)
{
    static std::string json;
    std::ostringstream output;
    output << '[';
    for (size_t i = 0; g_hp_file_cache && g_hp_file_cache[i]; i++) {
        if (i != 0) {
            output << ',';
        }
        output << prime_file_to_json(g_hp_file_cache[i], i);
    }
    output << ']';
    json = output.str();
    return json.c_str();
}

EMSCRIPTEN_KEEPALIVE
int hp_prime_download_cached_file(unsigned int index, const char* path)
{
    clear_hp_protocol_diagnostics();
    if (!g_hp_connected || !g_hp_calc) {
        return HP_WEB_NOT_CONNECTED;
    }
    if (!path || !*path || !g_hp_file_cache) {
        return HP_WEB_INVALID_ARGUMENT;
    }
    size_t count = 0;
    while (g_hp_file_cache[count] && count <= index) {
        count++;
    }
    if (index >= count) {
        return HP_WEB_INVALID_ARGUMENT;
    }
    const files_var_entry* file = g_hp_file_cache[index];
    FILE* fp = fopen(path, "wb");
    if (!fp) {
        return HP_WEB_FILE_ERROR;
    }
    const bool ok = file->size == 0
        || fwrite(file->data, 1, file->size, fp) == file->size;
    fclose(fp);
    return ok ? 0 : HP_WEB_FILE_ERROR;
}

EMSCRIPTEN_KEEPALIVE
int hp_prime_download_cached_app_child(unsigned int index,
                                       unsigned int child_index,
                                       const char* path)
{
    clear_hp_protocol_diagnostics();
    if (!g_hp_connected || !g_hp_calc) {
        return HP_WEB_NOT_CONNECTED;
    }
    if (!path || !*path) {
        return HP_WEB_INVALID_ARGUMENT;
    }
    files_var_entry* file = nullptr;
    hp_prime_app::Parsed app;
    if (!parse_cached_app(index, &file, &app)) {
        return HP_WEB_APP_FORMAT_ERROR;
    }
    const uint8_t* child_data = nullptr;
    size_t child_size = 0;
    std::string error;
    if (!hp_prime_app::extract(file->data, file->size, app, child_index,
                              &child_data, &child_size, &error)) {
        g_hp_protocol_diagnostics = error;
        return HP_WEB_APP_FORMAT_ERROR;
    }
    FILE* fp = fopen(path, "wb");
    if (!fp) {
        return HP_WEB_FILE_ERROR;
    }
    const bool ok = child_size == 0
        || fwrite(child_data, 1, child_size, fp) == child_size;
    fclose(fp);
    return ok ? 0 : HP_WEB_FILE_ERROR;
}

EMSCRIPTEN_KEEPALIVE
int hp_prime_send_cached_app_resources(unsigned int index,
                                       const char* manifest_path)
{
    clear_hp_protocol_diagnostics();
    if (!g_hp_connected || !g_hp_calc) {
        return HP_WEB_NOT_CONNECTED;
    }
    if (!manifest_path || !*manifest_path) {
        return HP_WEB_INVALID_ARGUMENT;
    }
    files_var_entry* file = nullptr;
    hp_prime_app::Parsed app;
    if (!parse_cached_app(index, &file, &app)) {
        return HP_WEB_APP_FORMAT_ERROR;
    }
    std::vector<uint8_t> manifest;
    int result = read_binary_file(manifest_path, &manifest);
    if (result != 0) {
        return result;
    }
    size_t offset = 0;
    uint32_t count = 0;
    if (!read_manifest_u32(manifest, &offset, &count)
        || count == 0 || count > 10000U) {
        g_hp_protocol_diagnostics = "application resource manifest has an invalid count";
        return HP_WEB_APP_FORMAT_ERROR;
    }
    std::vector<hp_prime_app::ResourceUpdate> updates;
    updates.reserve(count);
    for (uint32_t i = 0; i < count; i++) {
        uint32_t name_size = 0;
        uint32_t data_size = 0;
        if (!read_manifest_u32(manifest, &offset, &name_size)
            || name_size == 0 || name_size > manifest.size() - offset) {
            g_hp_protocol_diagnostics = "application resource manifest has an invalid name";
            return HP_WEB_APP_FORMAT_ERROR;
        }
        std::string name((const char*)manifest.data() + offset, name_size);
        offset += name_size;
        if (!read_manifest_u32(manifest, &offset, &data_size)
            || data_size > manifest.size() - offset) {
            g_hp_protocol_diagnostics = "application resource manifest has invalid file data";
            return HP_WEB_APP_FORMAT_ERROR;
        }
        for (size_t core_index = 0; core_index < 3; core_index++) {
            if (ascii_case_equal(name, app.parts[core_index].name)) {
                return HP_WEB_APP_CORE_READ_ONLY;
            }
        }
        updates.push_back({name, manifest.data() + offset, data_size});
        offset += data_size;
    }
    if (offset != manifest.size()) {
        g_hp_protocol_diagnostics = "application resource manifest has trailing data";
        return HP_WEB_APP_FORMAT_ERROR;
    }
    std::vector<uint8_t> rebuilt;
    std::string error;
    if (!hp_prime_app::replace_or_add_resources(file->data, file->size, app,
            updates, &rebuilt, &error)) {
        g_hp_protocol_diagnostics = error;
        return HP_WEB_APP_FORMAT_ERROR;
    }
    return send_rebuilt_app(index, file, rebuilt);
}

EMSCRIPTEN_KEEPALIVE
int hp_prime_rename_cached_app_resource(unsigned int index,
                                        unsigned int child_index,
                                        const char* new_name)
{
    clear_hp_protocol_diagnostics();
    if (!g_hp_connected || !g_hp_calc) {
        return HP_WEB_NOT_CONNECTED;
    }
    if (!new_name || !*new_name) {
        return HP_WEB_INVALID_ARGUMENT;
    }
    files_var_entry* file = nullptr;
    hp_prime_app::Parsed app;
    if (!parse_cached_app(index, &file, &app)) {
        return HP_WEB_APP_FORMAT_ERROR;
    }
    if (child_index >= app.parts.size()
        || app.parts[child_index].kind != hp_prime_app::PartKind::Resource) {
        return HP_WEB_APP_CORE_READ_ONLY;
    }
    for (size_t core_index = 0; core_index < 3; core_index++) {
        if (ascii_case_equal(new_name, app.parts[core_index].name)) {
            return HP_WEB_APP_CORE_READ_ONLY;
        }
    }
    std::vector<uint8_t> rebuilt;
    std::string error;
    if (!hp_prime_app::rename_resource(file->data, file->size, app,
            child_index, new_name, &rebuilt, &error)) {
        g_hp_protocol_diagnostics = error;
        return HP_WEB_APP_FORMAT_ERROR;
    }
    return send_rebuilt_app(index, file, rebuilt);
}

EMSCRIPTEN_KEEPALIVE
int hp_prime_delete_cached_app_resource(unsigned int index,
                                        unsigned int child_index)
{
    clear_hp_protocol_diagnostics();
    if (!g_hp_connected || !g_hp_calc) {
        return HP_WEB_NOT_CONNECTED;
    }
    files_var_entry* file = nullptr;
    hp_prime_app::Parsed app;
    if (!parse_cached_app(index, &file, &app)) {
        return HP_WEB_APP_FORMAT_ERROR;
    }
    if (child_index >= app.parts.size()
        || app.parts[child_index].kind != hp_prime_app::PartKind::Resource) {
        return HP_WEB_APP_CORE_READ_ONLY;
    }
    std::vector<uint8_t> rebuilt;
    std::string error;
    if (!hp_prime_app::delete_resource(file->data, file->size, app,
            child_index, &rebuilt, &error)) {
        g_hp_protocol_diagnostics = error;
        return HP_WEB_APP_FORMAT_ERROR;
    }
    return send_rebuilt_app(index, file, rebuilt);
}

EMSCRIPTEN_KEEPALIVE
int hp_prime_send_file(const char* path, const char* original_filename)
{
    clear_hp_protocol_diagnostics();
    if (!g_hp_connected || !g_hp_calc) {
        return HP_WEB_NOT_CONNECTED;
    }
    if (!path || !*path || !original_filename || !*original_filename) {
        return HP_WEB_INVALID_ARGUMENT;
    }
    uint8_t type = HPLIBS_FILE_TYPE_UNKNOWN;
    char* calculator_filename = nullptr;
    int result = hpfiles_parsefilename(CALC_PRIME, original_filename, &type,
                                       &calculator_filename);
    if (result != 0 || type == HPLIBS_FILE_TYPE_UNKNOWN
        || !calculator_filename) {
        free(calculator_filename);
        return result != 0 ? result : HP_WEB_INVALID_ARGUMENT;
    }
    FILE* fp = fopen(path, "rb");
    if (!fp) {
        free(calculator_filename);
        return HP_WEB_FILE_ERROR;
    }
    files_var_entry* file = nullptr;
    if (fseek(fp, 0, SEEK_END) == 0) {
        const long length = ftell(fp);
        if (length >= 0 && (unsigned long)length <= UINT32_MAX
            && fseek(fp, 0, SEEK_SET) == 0) {
            file = hpfiles_ve_create_with_size((uint32_t)length);
            if (file && length != 0
                && fread(file->data, 1, (size_t)length, fp) != (size_t)length) {
                hpfiles_ve_delete(file);
                file = nullptr;
            }
        }
    }
    fclose(fp);
    if (!file) {
        free(calculator_filename);
        return HP_WEB_FILE_ERROR;
    }
    file->type = type;
    if (!utf8_to_prime_name(calculator_filename, file->name)) {
        hpfiles_ve_delete(file);
        free(calculator_filename);
        return HP_WEB_INVALID_ARGUMENT;
    }
    free(calculator_filename);
    result = hpcalcs_calc_send_file(g_hp_calc, file);
    hpfiles_ve_delete(file);
    if (result == 0) {
        clear_file_cache();
    }
    return result;
}

EMSCRIPTEN_KEEPALIVE
int hp_prime_send_key(unsigned int code)
{
    clear_hp_protocol_diagnostics();
    if (!g_hp_connected || !g_hp_calc) {
        return HP_WEB_NOT_CONNECTED;
    }
    /* Public Prime key IDs cover the 51 physical keys, numbered 0..50. */
    if (code > 50U) {
        return HP_WEB_INVALID_ARGUMENT;
    }
    return hpcalcs_calc_send_key(g_hp_calc, code);
}

} // extern "C"
