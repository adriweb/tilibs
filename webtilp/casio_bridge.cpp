#include <cahute.h>
#include <emscripten/emscripten.h>

#include <cctype>
#include <cstdio>
#include <cstring>
#include <sstream>
#include <string>
#include <vector>

using namespace cahute;

namespace {

constexpr char CASIO_STORAGE[] = "fls0";
constexpr int CASIO_ERROR_RENAME_DELETE_FAILED = 0x7001;

struct CasioEntry {
    std::string directory;
    std::string name;
    unsigned long size = 0;
    bool is_directory = false;
};

cahute_context *g_context = nullptr;
cahute_link *g_link = nullptr;
std::vector<CasioEntry> g_entries;
std::string g_json;
bool g_storage_supported = false;
unsigned long g_storage_free = 0;

std::string json_escape(const char *value)
{
    std::ostringstream out;
    const unsigned char *cursor =
        reinterpret_cast<const unsigned char *>(value ? value : "");
    for (; *cursor; ++cursor) {
        switch (*cursor) {
        case '\"': out << "\\\""; break;
        case '\\': out << "\\\\"; break;
        case '\b': out << "\\b"; break;
        case '\f': out << "\\f"; break;
        case '\n': out << "\\n"; break;
        case '\r': out << "\\r"; break;
        case '\t': out << "\\t"; break;
        default:
            if (*cursor < 0x20) {
                char escaped[7];
                std::snprintf(escaped, sizeof(escaped), "\\u%04x", *cursor);
                out << escaped;
            } else {
                out << static_cast<char>(*cursor);
            }
        }
    }
    return out.str();
}

bool valid_remote_component(const char *value, bool allow_empty)
{
    if (!value) {
        return allow_empty;
    }
    const size_t size = std::strlen(value);
    if (size == 0) {
        return allow_empty;
    }
    // Cahute's Protocol 7.00 storage listing currently skips raw names whose
    // length is 23 bytes or more, so keep created names listable afterwards.
    if (size > 22 || !std::strcmp(value, ".") || !std::strcmp(value, "..")) {
        return false;
    }
    for (const unsigned char *cursor =
             reinterpret_cast<const unsigned char *>(value);
         *cursor; ++cursor) {
        if (*cursor > 0x7f || *cursor == '/' || *cursor == '\\'
            || std::iscntrl(*cursor)) {
            return false;
        }
    }
    return true;
}

const char *optional_directory(const char *directory)
{
    return directory && *directory ? directory : nullptr;
}

int require_link()
{
    return g_link ? CAHUTE_OK : CAHUTE_ERROR_GONE;
}

int collect_entry(void *cookie, const cahute_storage_entry *entry)
{
    auto *entries = static_cast<std::vector<CasioEntry> *>(cookie);
    if (!entry) {
        return 0;
    }
    CasioEntry result;
    result.directory = entry->cahute_storage_entry_directory
        ? entry->cahute_storage_entry_directory : "";
    result.name = entry->cahute_storage_entry_name
        ? entry->cahute_storage_entry_name : "";
    result.size = entry->cahute_storage_entry_size;
    result.is_directory = result.name.empty() && !result.directory.empty();
    if (result.is_directory) {
        result.name = result.directory;
        result.directory.clear();
    }
    if (!result.name.empty()) {
        entries->push_back(std::move(result));
    }
    return 0;
}

void append_string_property(std::ostringstream &out, bool &first,
                            const char *json_name, const char *property_name)
{
    char value[64] = {};
    if (!g_link
        || cahute_get_device_property(g_link, property_name,
                                      value, sizeof(value)) != CAHUTE_OK
        || !value[0]) {
        return;
    }
    if (!first) {
        out << ',';
    }
    first = false;
    out << '\"' << json_name << "\":\"" << json_escape(value) << '\"';
}

} // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE
int casio_library_init(void)
{
    if (g_context) {
        return CAHUTE_OK;
    }
    return cahute_create_context(&g_context);
}

EMSCRIPTEN_KEEPALIVE
int casio_disconnect(void)
{
    if (g_link) {
        cahute_close_link(g_link);
        g_link = nullptr;
    }
    g_entries.clear();
    g_storage_supported = false;
    g_storage_free = 0;
    return CAHUTE_OK;
}

EMSCRIPTEN_KEEPALIVE
int casio_library_exit(void)
{
    casio_disconnect();
    if (g_context) {
        cahute_destroy_context(g_context);
        g_context = nullptr;
    }
    return CAHUTE_OK;
}

EMSCRIPTEN_KEEPALIVE
int casio_connect(void)
{
    int err = casio_library_init();
    if (err) {
        return err;
    }
    casio_disconnect();
    err = cahute_open_simple_usb_link(
        g_context, &g_link, CAHUTE_USB_FILTER_SERIAL);
    if (err) {
        g_link = nullptr;
        return err;
    }

    unsigned long free_capacity = 0;
    err = cahute_request_storage_capacity(g_link, CASIO_STORAGE, &free_capacity);
    if (!err) {
        g_storage_supported = true;
        g_storage_free = free_capacity;
    } else if (err == CAHUTE_ERROR_IMPL || err == CAHUTE_ERROR_INCOMPAT) {
        // CAS300 uses the same vendor-specific USB transport, but Cahute's
        // storage API is only available for Protocol 7.00.
        g_storage_supported = false;
        g_storage_free = 0;
    } else {
        casio_disconnect();
        return err;
    }
    return CAHUTE_OK;
}

EMSCRIPTEN_KEEPALIVE
int casio_is_connected(void)
{
    return g_link ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE
const char *casio_get_error_message(int error)
{
    if (error == CASIO_ERROR_RENAME_DELETE_FAILED) {
        return "the file was copied under its new name, but the original could not be deleted";
    }
    const char *name = cahute_get_error_name(error);
    return name ? name : "CAHUTE_ERROR_UNKNOWN";
}

EMSCRIPTEN_KEEPALIVE
const char *casio_get_info_json(void)
{
    if (!g_link) {
        return nullptr;
    }
    std::ostringstream out;
    out << '{';
    bool first = true;
    append_string_property(out, first, "productId", "product_id");
    append_string_property(out, first, "hwid", "hwid");
    append_string_property(out, first, "cpuid", "cpuid");
    append_string_property(out, first, "osVersion", "os_version");
    append_string_property(out, first, "username", "username");
    append_string_property(out, first, "organisation", "organisation");
    if (!first) {
        out << ',';
    }
    out << "\"protocol\":\""
        << (g_storage_supported ? "Protocol 7.00" : "CAS300") << "\","
        << "\"storageSupported\":"
        << (g_storage_supported ? "true" : "false") << ','
        << "\"storageFree\":" << g_storage_free
        << '}';
    g_json = out.str();
    return g_json.c_str();
}

EMSCRIPTEN_KEEPALIVE
int casio_refresh_files(void)
{
    int err = require_link();
    if (err) {
        return err;
    }
    if (!g_storage_supported) {
        return CAHUTE_ERROR_IMPL;
    }
    std::vector<CasioEntry> entries;
    err = cahute_list_storage_entries(g_link, CASIO_STORAGE,
                                      collect_entry, &entries);
    if (err) {
        return err;
    }
    unsigned long free_capacity = 0;
    err = cahute_request_storage_capacity(g_link, CASIO_STORAGE, &free_capacity);
    if (err) {
        return err;
    }
    g_entries = std::move(entries);
    g_storage_free = free_capacity;
    return CAHUTE_OK;
}

EMSCRIPTEN_KEEPALIVE
const char *casio_get_files_json(void)
{
    if (!g_link) {
        return nullptr;
    }
    std::ostringstream out;
    out << '[';
    for (size_t i = 0; i < g_entries.size(); ++i) {
        const CasioEntry &entry = g_entries[i];
        if (i) {
            out << ',';
        }
        out << "{\"name\":\"" << json_escape(entry.name.c_str())
            << "\",\"folder\":\"" << json_escape(entry.directory.c_str())
            << "\",\"size\":" << entry.size
            << ",\"is_folder\":" << (entry.is_directory ? 1 : 0)
            << ",\"kind\":\"casio\",\"type\":0,\"type_name\":\""
            << (entry.is_directory ? "Directory" : "Storage file")
            << "\",\"attr\":3}";
    }
    out << ']';
    g_json = out.str();
    return g_json.c_str();
}

EMSCRIPTEN_KEEPALIVE
int casio_send_file(const char *path, const char *directory,
                    const char *name)
{
    int err = require_link();
    if (err) {
        return err;
    }
    if (!path || !*path || !valid_remote_component(directory, true)
        || !valid_remote_component(name, false)) {
        return CAHUTE_ERROR_INVALID;
    }
    cahute_file *file = nullptr;
    err = cahute_open_file(g_context, &file, 0, path, CAHUTE_PATH_TYPE_CLI);
    if (err) {
        return err;
    }
    err = cahute_send_file_to_storage(
        g_link,
        CAHUTE_SEND_FILE_FLAG_FORCE | CAHUTE_SEND_FILE_FLAG_OPTIMIZE,
        optional_directory(directory), name, CASIO_STORAGE, file,
        nullptr, nullptr, nullptr, nullptr);
    cahute_close_file(file);
    return err;
}

EMSCRIPTEN_KEEPALIVE
int casio_receive_file(const char *directory, const char *name,
                       const char *path)
{
    int err = require_link();
    if (err) {
        return err;
    }
    if (!path || !*path || !valid_remote_component(directory, true)
        || !valid_remote_component(name, false)) {
        return CAHUTE_ERROR_INVALID;
    }
    return cahute_request_file_from_storage(
        g_link, optional_directory(directory), name, CASIO_STORAGE,
        path, CAHUTE_PATH_TYPE_CLI, nullptr, nullptr);
}

EMSCRIPTEN_KEEPALIVE
int casio_delete_file(const char *directory, const char *name)
{
    int err = require_link();
    if (err) {
        return err;
    }
    if (!valid_remote_component(directory, true)
        || !valid_remote_component(name, false)) {
        return CAHUTE_ERROR_INVALID;
    }
    return cahute_delete_file_from_storage(
        g_link, optional_directory(directory), name, CASIO_STORAGE);
}

EMSCRIPTEN_KEEPALIVE
int casio_rename_file(const char *source_directory, const char *source_name,
                      const char *target_directory, const char *target_name)
{
    int err = require_link();
    if (err) {
        return err;
    }
    if (!valid_remote_component(source_directory, true)
        || !valid_remote_component(source_name, false)
        || !valid_remote_component(target_directory, true)
        || !valid_remote_component(target_name, false)) {
        return CAHUTE_ERROR_INVALID;
    }
    err = cahute_copy_file_on_storage(
        g_link, optional_directory(source_directory), source_name,
        optional_directory(target_directory), target_name, CASIO_STORAGE);
    if (err) {
        return err;
    }
    err = cahute_delete_file_from_storage(
        g_link, optional_directory(source_directory), source_name,
        CASIO_STORAGE);
    return err ? CASIO_ERROR_RENAME_DELETE_FAILED : CAHUTE_OK;
}

} // extern "C"
