#pragma once
#include "ti_common.h"
#include <cstdio>

namespace ti {
int finish_var_send(CableHandle* cable_handle);
int send_file_custom(CableHandle* cable_handle, const char* filename, const char* folder, int location, int defer_eot);
int send_file_entry_custom(CableHandle* cable_handle, const char* filename, int entry_index, int container_kind, const char* folder, int location, int defer_eot);

} // namespace ti
