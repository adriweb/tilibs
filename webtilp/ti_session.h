#pragma once
#include "ti_common.h"
#include <cstdio>

namespace ti {
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
const char* get_calc_model_string(void);
int get_calc_model_id(void);
int consume_cable_reopen_flag(void);
const char* consume_model_update_info(void);
void notify_usb_disconnect(void);
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
const char* calc_get_info_string(CableHandle* cable_handle);

// All connection state lives in this implementation. Operations borrow handles;
// only session lifecycle functions attach, reset or dispose them.
CalcModel current_model();
CalcHandle* calculator();
CableModel current_cable_model();
unsigned int evo_python_type();
int ensure_calc_handle_attached(CableHandle*);
int ensure_calc_ready(CableHandle*, int force);
bool is_attached_owned_cable(CableHandle*);

} // namespace ti
