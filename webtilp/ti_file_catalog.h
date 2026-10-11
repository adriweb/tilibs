#pragma once
#include "ti_common.h"
#include <cstdio>
#include <string>
#include <vector>

namespace ti {
struct EntryDescription {
    std::string name, folder, type_name, container_type;
    uint8_t type = 0, attr = 0;
    uint32_t size = 0;
    unsigned int location_mask = LOC_RAM | LOC_ARCHIVE;
    int container_index = -1;
    bool is_folder = false;
};
struct FileDescription {
    std::string file_class = "unknown";
    std::vector<EntryDescription> entries;
};
// Readers may transcode names into model_dst while preserving the file's
// source model/type. Keep the name representation separate from type identity.
EntryDescription describe_entry(const VarEntry&, CalcModel source_model,
                                CalcModel destination_model, CalcModel name_model = CALC_NONE);
FileDescription inspect_file(const char* filename, CalcModel destination_model);

const char* get_flash_os_ext(int model);
const char* get_file_extensions(int model);
std::string file_get_entries_json(const char* filename);
std::string files_get_entries_json(const char* paths_blob);
std::string bundle_extract_json(const char* filename, const char* out_dir);

void write_var_entry_json(FILE*, const VarEntry*, const char* kind, CalcModel source_model);
void write_dirlist_json(FILE*, const GNode*, const char* kind, int* first, CalcModel source_model);

} // namespace ti
