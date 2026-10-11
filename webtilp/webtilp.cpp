// Stable Emscripten C ABI. Implementations live behind focused TI modules.
#include <emscripten.h>
#include <string>
#include "webtilp.h"
#include "ti_session.h"
#include "ti_operations.h"
#include "ti_file_catalog.h"
#include "ti_transfers.h"

extern "C" {

EMSCRIPTEN_KEEPALIVE
uint32_t* get_progress_tick_ptr(void) {
    return ti::get_progress_tick_ptr();
}

EMSCRIPTEN_KEEPALIVE
uint32_t get_progress_tick_value(void) {
    return ti::get_progress_tick_value();
}

EMSCRIPTEN_KEEPALIVE
void reset_progress_info(void) {
    ti::reset_progress_info();
}

EMSCRIPTEN_KEEPALIVE
const char* get_progress_info_json(void) {
    static std::string response;
    const char* value = ti::get_progress_info_json();
    if (!value) return nullptr;
    response = value;
    return response.c_str();
}

EMSCRIPTEN_KEEPALIVE
int init() {
    return ti::init();
}

EMSCRIPTEN_KEEPALIVE
void clear_native_warnings(void) {
    ti::clear_native_warnings();
}

EMSCRIPTEN_KEEPALIVE
const char* get_native_warnings(void) {
    static std::string response;
    const char* value = ti::get_native_warnings();
    if (!value) return nullptr;
    response = value;
    return response.c_str();
}

EMSCRIPTEN_KEEPALIVE
const char* get_version() {
    static std::string response;
    const char* value = ti::get_version();
    if (!value) return nullptr;
    response = value;
    return response.c_str();
}

EMSCRIPTEN_KEEPALIVE
void set_cable_model(int model) {
    ti::set_cable_model(model);
}

EMSCRIPTEN_KEEPALIVE
void set_calc_model(int model) {
    ti::set_calc_model(model);
}

EMSCRIPTEN_KEEPALIVE
const char* get_flash_os_ext(int model) {
    static std::string response;
    const char* value = ti::get_flash_os_ext(model);
    if (!value) return nullptr;
    response = value;
    return response.c_str();
}

EMSCRIPTEN_KEEPALIVE
const char* get_calc_model_string(void) {
    static std::string response;
    const char* value = ti::get_calc_model_string();
    if (!value) return nullptr;
    response = value;
    return response.c_str();
}

EMSCRIPTEN_KEEPALIVE
int get_calc_model_id(void) {
    return ti::get_calc_model_id();
}

EMSCRIPTEN_KEEPALIVE
const char* get_file_extensions(int model) {
    static std::string response;
    const char* value = ti::get_file_extensions(model);
    if (!value) return nullptr;
    response = value;
    return response.c_str();
}

EMSCRIPTEN_KEEPALIVE
const char* get_backup_ext(void) {
    static std::string response;
    const char* value = ti::get_backup_ext();
    if (!value) return nullptr;
    response = value;
    return response.c_str();
}

EMSCRIPTEN_KEEPALIVE
int consume_cable_reopen_flag(void) {
    return ti::consume_cable_reopen_flag();
}

EMSCRIPTEN_KEEPALIVE
const char* consume_model_update_info(void) {
    static std::string response;
    const char* value = ti::consume_model_update_info();
    if (!value) return nullptr;
    response = value;
    return response.c_str();
}

EMSCRIPTEN_KEEPALIVE
void notify_usb_disconnect(void) {
    ti::notify_usb_disconnect();
}

EMSCRIPTEN_KEEPALIVE
const char* get_error_message(int code) {
    static std::string response;
    const char* value = ti::get_error_message(code);
    if (!value) return nullptr;
    response = value;
    return response.c_str();
}

EMSCRIPTEN_KEEPALIVE
uint16_t get_raw_protocol_code(int number) {
    return ti::get_raw_protocol_code(number);
}

EMSCRIPTEN_KEEPALIVE
void set_force_cable(int force) {
    ti::set_force_cable(force);
}

EMSCRIPTEN_KEEPALIVE
void set_force_calc(int force) {
    ti::set_force_calc(force);
}

EMSCRIPTEN_KEEPALIVE
void set_cable_timeout(int timeout) {
    ti::set_cable_timeout(timeout);
}

EMSCRIPTEN_KEEPALIVE
void set_cable_delay(int delay) {
    ti::set_cable_delay(delay);
}

EMSCRIPTEN_KEEPALIVE
int check_webusb_support() {
    return ti::check_webusb_support();
}

EMSCRIPTEN_KEEPALIVE
CableHandle* create_handle() {
    return ti::create_handle();
}

EMSCRIPTEN_KEEPALIVE
int open_cable(CableHandle* handle) {
    return ti::open_cable(handle);
}

EMSCRIPTEN_KEEPALIVE
int check_cable(CableHandle* handle) {
    return ti::check_cable(handle);
}

EMSCRIPTEN_KEEPALIVE
int is_ready(CableHandle* cable_handle) {
    return ti::is_ready(cable_handle);
}

EMSCRIPTEN_KEEPALIVE
int send_probe(CableHandle* handle) {
    return ti::send_probe(handle);
}

EMSCRIPTEN_KEEPALIVE
int receive_data(CableHandle* handle) {
    return ti::receive_data(handle);
}

EMSCRIPTEN_KEEPALIVE
int close_cable(CableHandle* handle) {
    return ti::close_cable(handle);
}

EMSCRIPTEN_KEEPALIVE
int cleanup() {
    return ti::cleanup();
}

EMSCRIPTEN_KEEPALIVE
int get_device_info(CableHandle* handle) {
    return ti::get_device_info(handle);
}

EMSCRIPTEN_KEEPALIVE
int calc_screenshot(CableHandle* cable_handle) {
    return ti::calc_screenshot(cable_handle);
}

EMSCRIPTEN_KEEPALIVE
uint32_t calc_features(CableHandle* cable_handle) {
    return ti::calc_features(cable_handle);
}

EMSCRIPTEN_KEEPALIVE
int calc_send_key(CableHandle* cable_handle, uint32_t key) {
    return ti::calc_send_key(cable_handle, key);
}

EMSCRIPTEN_KEEPALIVE
const char* calc_get_info_string(CableHandle* cable_handle) {
    static std::string response;
    const char* value = ti::calc_get_info_string(cable_handle);
    if (!value) return nullptr;
    response = value;
    return response.c_str();
}

EMSCRIPTEN_KEEPALIVE
const char* calc_get_clock_json(CableHandle* cable_handle) {
    static std::string response;
    const char* value = ti::calc_get_clock_json(cable_handle);
    if (!value) return nullptr;
    response = value;
    return response.c_str();
}

EMSCRIPTEN_KEEPALIVE
int calc_set_clock(CableHandle* cable_handle, int year, int month, int day, int hours, int minutes, int seconds,
    int time_format, int date_format, int state) {
    return ti::calc_set_clock(cable_handle, year, month, day, hours, minutes, seconds, time_format, date_format, state);
}

EMSCRIPTEN_KEEPALIVE
int calc_sync_clock(CableHandle* cable_handle, int offset_minutes) {
    return ti::calc_sync_clock(cable_handle, offset_minutes);
}

EMSCRIPTEN_KEEPALIVE
int calc_dirlist_json(CableHandle* cable_handle, const char* path) {
    return ti::calc_dirlist_json(cable_handle, path);
}

EMSCRIPTEN_KEEPALIVE
int calc_backup_dirlist_json(const char* backup_path, const char* output_path) {
    return ti::calc_backup_dirlist_json(backup_path, output_path);
}

EMSCRIPTEN_KEEPALIVE
int calc_recv_backup(CableHandle* cable_handle, const char* path) {
    return ti::calc_recv_backup(cable_handle, path);
}

EMSCRIPTEN_KEEPALIVE
int calc_recv_tigroup(CableHandle* cable_handle, const char* path, int mode) {
    return ti::calc_recv_tigroup(cable_handle, path, mode);
}

EMSCRIPTEN_KEEPALIVE
int calc_recv_os(CableHandle* cable_handle, const char* path) {
    return ti::calc_recv_os(cable_handle, path);
}

EMSCRIPTEN_KEEPALIVE
int calc_dump_rom_1(CableHandle* cable_handle) {
    return ti::calc_dump_rom_1(cable_handle);
}

EMSCRIPTEN_KEEPALIVE
int calc_dump_rom_2(CableHandle* cable_handle, int size, const char* path) {
    return ti::calc_dump_rom_2(cable_handle, size, path);
}

EMSCRIPTEN_KEEPALIVE
int calc_leave_exam_mode(CableHandle* cable_handle) {
    return ti::calc_leave_exam_mode(cable_handle);
}

EMSCRIPTEN_KEEPALIVE
int calc_leave_exam_mode_supported(void) {
    return ti::calc_leave_exam_mode_supported();
}

EMSCRIPTEN_KEEPALIVE
int string_to_calc_model(const char* value) {
    return ti::string_to_calc_model(value);
}

EMSCRIPTEN_KEEPALIVE
int calc_recv_var(CableHandle* cable_handle, const char* folder, const char* name, uint8_t type, const char* out_dir) {
    return ti::calc_recv_var(cable_handle, folder, name, type, out_dir);
}

EMSCRIPTEN_KEEPALIVE
int calc_recv_app(CableHandle* cable_handle, const char* name, uint8_t type, const char* out_dir) {
    return ti::calc_recv_app(cable_handle, name, type, out_dir);
}

EMSCRIPTEN_KEEPALIVE
int calc_del_var(CableHandle* cable_handle, const char* folder, const char* name, uint8_t type) {
    return ti::calc_del_var(cable_handle, folder, name, type);
}

EMSCRIPTEN_KEEPALIVE
int calc_new_folder(CableHandle* cable_handle, const char* folder_path) {
    return ti::calc_new_folder(cable_handle, folder_path);
}

EMSCRIPTEN_KEEPALIVE
int calc_del_folder(CableHandle* cable_handle, const char* folder_path) {
    return ti::calc_del_folder(cable_handle, folder_path);
}

EMSCRIPTEN_KEEPALIVE
int calc_rename_var(CableHandle* cable_handle,
                    const char* old_folder,
                    const char* old_name,
                    uint8_t old_type,
                    const char* new_folder,
                    const char* new_name,
                    uint8_t new_type) {
    return ti::calc_rename_var(cable_handle, old_folder, old_name, old_type, new_folder, new_name, new_type);
}

EMSCRIPTEN_KEEPALIVE
int calc_change_attr(CableHandle* cable_handle, const char* folder, const char* name, uint8_t type, int attr) {
    return ti::calc_change_attr(cable_handle, folder, name, type, attr);
}

EMSCRIPTEN_KEEPALIVE
const char* file_get_entries_json(const char* filename) {
    static std::string response;
    response = ti::file_get_entries_json(filename);
    return response.c_str();
}

EMSCRIPTEN_KEEPALIVE
const char* files_get_entries_json(const char* paths_blob) {
    static std::string response;
    response = ti::files_get_entries_json(paths_blob);
    return response.c_str();
}

EMSCRIPTEN_KEEPALIVE
const char* bundle_extract_json(const char* filename, const char* out_dir) {
    static std::string response;
    response = ti::bundle_extract_json(filename, out_dir);
    return response.c_str();
}

EMSCRIPTEN_KEEPALIVE
int finish_var_send(CableHandle* cable_handle) {
    return ti::finish_var_send(cable_handle);
}

EMSCRIPTEN_KEEPALIVE
int send_file_custom(CableHandle* cable_handle, const char* filename, const char* folder, int location, int defer_eot) {
    return ti::send_file_custom(cable_handle, filename, folder, location, defer_eot);
}

EMSCRIPTEN_KEEPALIVE
int send_file_entry_custom(CableHandle* cable_handle, const char* filename, int entry_index, int container_kind, const char* folder, int location, int defer_eot) {
    return ti::send_file_entry_custom(cable_handle, filename, entry_index, container_kind, folder, location, defer_eot);
}

} // extern "C"

#ifndef WEBTILP_NO_MAIN
int main() { return 0; }
#endif
