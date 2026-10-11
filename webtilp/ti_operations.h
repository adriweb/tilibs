#pragma once
#include "ti_common.h"
#include <cstdio>

namespace ti {
const char* get_backup_ext(void);
const char* get_error_message(int code);
uint16_t get_raw_protocol_code(int number);
int calc_screenshot(CableHandle* cable_handle);
uint32_t calc_features(CableHandle* cable_handle);
int calc_send_key(CableHandle* cable_handle, uint32_t key);
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

} // namespace ti
