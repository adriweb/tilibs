#pragma once
#include "ti_common.h"

extern "C" {
uint32_t* get_progress_tick_ptr(void);
uint32_t get_progress_tick_value(void);
void reset_progress_info(void);
const char* get_progress_info_json(void);
int init();
void clear_native_warnings(void);
const char* get_native_warnings(void);
const char* get_version();
void set_cable_model(int model);
void set_calc_model(int model);
const char* get_flash_os_ext(int model);
const char* get_calc_model_string(void);
int get_calc_model_id(void);
const char* get_file_extensions(int model);
const char* get_backup_ext(void);
int consume_cable_reopen_flag(void);
const char* consume_model_update_info(void);
void notify_usb_disconnect(void);
const char* get_error_message(int code);
uint16_t get_raw_protocol_code(int number);
void set_force_cable(int force);
void set_force_calc(int force);
void set_cable_timeout(int timeout);
void set_cable_delay(int delay);
int check_webusb_support();
CableHandle* create_handle();
int open_cable(CableHandle* handle);
int check_cable(CableHandle* handle);
int is_ready(CableHandle* cable_handle);
int send_probe(CableHandle* handle);
int receive_data(CableHandle* handle);
int close_cable(CableHandle* handle);
int cleanup();
int get_device_info(CableHandle* handle);
int calc_screenshot(CableHandle* cable_handle);
uint32_t calc_features(CableHandle* cable_handle);
int calc_send_key(CableHandle* cable_handle, uint32_t key);
const char* calc_get_info_string(CableHandle* cable_handle);
const char* calc_get_clock_json(CableHandle* cable_handle);
int calc_set_clock(CableHandle* cable_handle, int year, int month, int day, int hours, int minutes, int seconds,
    int time_format, int date_format, int state);
int calc_sync_clock(CableHandle* cable_handle, int offset_minutes);
int calc_dirlist_json(CableHandle* cable_handle, const char* path);
int calc_backup_dirlist_json(const char* backup_path, const char* output_path);
int calc_recv_backup(CableHandle* cable_handle, const char* path);
int calc_recv_tigroup(CableHandle* cable_handle, const char* path, int mode);
int calc_recv_os(CableHandle* cable_handle, const char* path);
int calc_dump_rom_1(CableHandle* cable_handle);
int calc_dump_rom_2(CableHandle* cable_handle, int size, const char* path);
int calc_leave_exam_mode(CableHandle* cable_handle);
int calc_leave_exam_mode_supported(void);
int string_to_calc_model(const char* value);
int calc_recv_var(CableHandle* cable_handle, const char* folder, const char* name, uint8_t type, const char* out_dir);
int calc_recv_app(CableHandle* cable_handle, const char* name, uint8_t type, const char* out_dir);
int calc_del_var(CableHandle* cable_handle, const char* folder, const char* name, uint8_t type);
int calc_new_folder(CableHandle* cable_handle, const char* folder_path);
int calc_del_folder(CableHandle* cable_handle, const char* folder_path);
int calc_rename_var(CableHandle* cable_handle,
                    const char* old_folder,
                    const char* old_name,
                    uint8_t old_type,
                    const char* new_folder,
                    const char* new_name,
                    uint8_t new_type);
int calc_change_attr(CableHandle* cable_handle, const char* folder, const char* name, uint8_t type, int attr);
const char* file_get_entries_json(const char* filename);
const char* files_get_entries_json(const char* paths_blob);
const char* bundle_extract_json(const char* filename, const char* out_dir);
int finish_var_send(CableHandle* cable_handle);
int send_file_custom(CableHandle* cable_handle, const char* filename, const char* folder, int location, int defer_eot);
int send_file_entry_custom(CableHandle* cable_handle, const char* filename, int entry_index, int container_kind, const char* folder, int location, int defer_eot);
}
