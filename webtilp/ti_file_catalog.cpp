#include "ti_file_catalog.h"
#include "ti_file_io.h"
#include "ti_session.h"
#include "webtilp_json.h"
#include <algorithm>
#include <cstring>
#include <set>
#include <unistd.h>
#include <archive.h>
#include <archive_entry.h>
#include <glib.h>
#include <ticonv.h>

namespace ti {
namespace {
void json_append_escaped(GString* out, const char* text) {
    const auto escaped = webtilp_json::escape_bounded(text, 4096);
    g_string_append_len(out, escaped.data(), escaped.size());
}

std::string variable_name(CalcModel model, const char* raw, size_t bound, uint8_t type) {
    const std::string bounded(raw, webtilp_json::bounded_length(raw, bound));
    char converted[std::max(VARNAME_MAX, FLDNAME_MAX) * 4] = {};
    if (!bounded.empty()
        && ticonv_varname_to_utf8_sn(model, bounded.c_str(), converted, sizeof(converted), type)) {
        return converted;
    }
    return bounded;
}

static unsigned int compute_location_mask_for_entry(const VarEntry* ve, CalcModel source_model, CalcModel destination_model) {
    if (!ve) {
        return (LOC_RAM | LOC_ARCHIVE);
    }

    const char* type_id = tifiles_vartype2string(source_model, ve->type);
    // Graphing equation/Y-var records are system variables and cannot be archived.
    if (type_id
        && (  g_ascii_strcasecmp(type_id, "EQU") == 0
           || g_ascii_strcasecmp(type_id, "YVAR") == 0)) {
        return LOC_RAM;
    }

    if (ticonv_model_is_tievo(destination_model)) {
        if (tifiles_evo_is_python_module(ve->data, ve->size)) {
            return LOC_ARCHIVE;
        }
        switch (ve->type) {
            case WEBTILP_EVO_TYPE_PICTURE:
            case WEBTILP_EVO_TYPE_IMAGE:
            case WEBTILP_EVO_TYPE_GROUP:
            case WEBTILP_EVO_TYPE_PYTHON_MODULE:
                return LOC_ARCHIVE;
            case WEBTILP_EVO_TYPE_FLASH_APP:
                // The generic type-11 transfer is only a RAM staging path.
                return LOC_RAM;
            default:
                return (LOC_RAM | LOC_ARCHIVE);
        }
    }

    // Color 84+/CE models keep both Pic and Image vars in archive. Monochrome
    // Z80 and 68k Pic vars may live in either RAM or archive.
    const bool archive_only_graphics =
        destination_model == CALC_TI84PC
        || destination_model == CALC_TI84PC_USB
        || destination_model == CALC_TI83PCE_USB
        || destination_model == CALC_TI84PCE_USB
        || destination_model == CALC_TI82AEP_USB;
    const uint8_t flash_type = tifiles_flash_type(destination_model);
    if ((flash_type != G_MAXUINT8 && ve->type == flash_type)
        || (type_id &&
            (  g_ascii_strcasecmp(type_id, "CERT") == 0
            || g_ascii_strcasecmp(type_id, "GRP") == 0
            || (archive_only_graphics
                && (  g_ascii_strcasecmp(type_id, "PIC") == 0
                   || g_ascii_strcasecmp(type_id, "IMAGE") == 0))))) {
        return LOC_ARCHIVE;
    }
    return (LOC_RAM | LOC_ARCHIVE);
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


} // namespace

EntryDescription describe_entry(const VarEntry& entry, CalcModel source_model,
                                CalcModel destination_model, CalcModel name_model) {
    if (name_model == CALC_NONE) name_model = source_model;
    EntryDescription result;
    result.name = variable_name(name_model, entry.name, sizeof(entry.name), entry.type);
    result.folder = variable_name(name_model, entry.folder, sizeof(entry.folder), entry.type);
    result.type = entry.type;
    result.attr = entry.attr;
    result.size = entry.size;
    const char* type = tifiles_vartype2type(source_model, entry.type);
    result.type_name = type ? type : "";
    result.location_mask = compute_location_mask_for_entry(&entry, source_model, destination_model);
    const int folder_type = tifiles_folder_type(source_model);
    result.is_folder = folder_type != 0 && entry.type == folder_type;
    return result;
}

static EntryDescription describe_flash(const FlashContent& content, FileClass file_class, CalcModel fallback_model) {
    EntryDescription result;
    const bool is_os = file_class == TIFILE_OS;
    const CalcModel source_model = content.model != CALC_NONE ? content.model : fallback_model;
    result.type = content.data_type ? content.data_type
        : is_os ? TI83p_AMS : tifiles_flash_type(source_model);
    result.name = is_os ? std::string(content.name, webtilp_json::bounded_length(content.name, sizeof(content.name)))
        : variable_name(content.model_dst != CALC_NONE ? content.model_dst : source_model, content.name, sizeof(content.name), result.type);
    const char* type = !is_os && source_model != CALC_NONE && result.type
        ? tifiles_vartype2type(source_model, result.type) : "";
    result.type_name = type ? type : "";
    result.attr = ATTRB_ARCHIVED;
    result.location_mask = LOC_ARCHIVE;
    result.size = get_flash_content_size(&content);
    return result;
}

FileDescription inspect_file(const char* filename, CalcModel destination_model) {
    FileDescription result;
    if (!filename || !*filename || !tifiles_file_is_ti(filename)) return result;
    const FileClass file_class = tifiles_file_get_class(filename);
    CalcModel parse_model = tifiles_file_get_model(filename);
    if (parse_model == CALC_NONE) parse_model = destination_model;
    const char* class_name = tifiles_class_to_string(file_class);
    result.file_class = class_name ? class_name : "unknown";
    int error = 0;
    if (file_class == TIFILE_TIGROUP) {
        auto content = load_tigroup(filename, parse_model, error);
        if (!content) return result;
        for (unsigned i = 0; i < content->n_vars; ++i) {
            const TigEntry* member = content->var_entries[i];
            if (!member || !member->content.regular || !member->content.regular->num_entries
                || !member->content.regular->entries[0]) continue;
            const FileContent& regular = *member->content.regular;
            auto entry = describe_entry(*regular.entries[0], regular.model, destination_model, regular.model_dst);
            entry.container_type = "var";
            entry.container_index = i;
            result.entries.push_back(std::move(entry));
        }
        for (unsigned i = 0; i < content->n_apps; ++i) {
            const TigEntry* member = content->app_entries[i];
            if (!member || !member->content.flash) continue;
            auto entry = describe_flash(*member->content.flash, TIFILE_APP, parse_model);
            entry.container_type = "app";
            entry.container_index = i;
            result.entries.push_back(std::move(entry));
        }
    } else if (file_class == TIFILE_FLASH || file_class == TIFILE_APP || file_class == TIFILE_OS) {
        auto content = load_flash(filename, parse_model, error);
        if (content) result.entries.push_back(describe_flash(*content, file_class, parse_model));
    } else {
        auto content = load_regular(filename, parse_model, error);
        if (!content) return result;
        for (unsigned i = 0; i < content->num_entries; ++i) {
            if (content->entries[i]) result.entries.push_back(describe_entry(*content->entries[i], content->model, destination_model, content->model_dst));
        }
    }
    return result;
}

static void append_common_entry(GString* out, const EntryDescription& entry) {
    g_string_append(out, "{\"name\":\"");
    json_append_escaped(out, entry.name.c_str());
    g_string_append(out, "\",\"folder\":\"");
    json_append_escaped(out, entry.folder.c_str());
    g_string_append_printf(out, "\",\"type\":%u,\"type_name\":\"", entry.type);
    json_append_escaped(out, entry.type_name.c_str());
    g_string_append_c(out, '"');
}

static void append_upload_entry(GString* out, const EntryDescription& entry) {
    append_common_entry(out, entry);
    g_string_append_printf(out, ",\"attr\":%u,\"location_mask\":%u,\"size\":%u",
        entry.attr, entry.location_mask, entry.size);
    if (!entry.container_type.empty()) {
        g_string_append(out, ",\"container_type\":\"");
        json_append_escaped(out, entry.container_type.c_str());
        g_string_append_printf(out, "\",\"container_index\":%d", entry.container_index);
    }
    g_string_append_c(out, '}');
}

static void append_file_metadata(GString* out, const FileDescription& file) {
    g_string_append(out, "\"class\":\"");
    json_append_escaped(out, file.file_class.c_str());
    g_string_append(out, "\",\"entries\":[");
    bool first = true;
    for (const auto& entry : file.entries) {
        if (!first) g_string_append_c(out, ',');
        first = false;
        append_upload_entry(out, entry);
    }
    g_string_append_c(out, ']');
}

static void append_file_description(GString* out, const char* filename) {
    gchar* base = g_path_get_basename(filename);
    g_string_append(out, "{\"name\":\"");
    json_append_escaped(out, base);
    g_string_append(out, "\",\"path\":\"");
    json_append_escaped(out, filename);
    g_string_append(out, "\",");
    append_file_metadata(out, inspect_file(filename, current_model()));
    g_string_append_c(out, '}');
    g_free(base);
}

void write_var_entry_json(FILE* fp, const VarEntry* entry, const char* kind, CalcModel source_model) {
    if (!fp || !entry) return;
    const auto description = describe_entry(*entry, source_model, source_model);
    GString* json = g_string_new(nullptr);
    append_common_entry(json, description);
    g_string_append_printf(json, ",\"size\":%u,\"attr\":%u,\"kind\":\"", description.size, description.attr);
    json_append_escaped(json, kind);
    g_string_append_printf(json, "\",\"is_folder\":%d}", description.is_folder ? 1 : 0);
    fwrite(json->str, 1, json->len, fp);
    g_string_free(json, TRUE);
}

void write_dirlist_json(FILE* fp, const GNode* node, const char* kind, int* first, CalcModel source_model) {
    if (!node) return;
    if (node->parent) {
        const VarEntry* entry = static_cast<VarEntry*>(node->data);
        if (entry && entry->name[0]) {
            if (!*first) fputc(',', fp);
            *first = 0;
            write_var_entry_json(fp, entry, kind, source_model);
        }
    }
    for (const GNode* child = node->children; child; child = child->next)
        write_dirlist_json(fp, child, kind, first, source_model);
}

std::string file_get_entries_json(const char* filename) {
    if (!filename || !*filename) return "[]";
    GString* json = g_string_new("{");
    append_file_metadata(json, inspect_file(filename, current_model()));
    g_string_append_c(json, '}');
    std::string result(json->str, json->len);
    g_string_free(json, TRUE);
    return result;
}

std::string files_get_entries_json(const char* paths_blob) {
    GString* json = g_string_new("{\"files\":[");
    if (paths_blob && *paths_blob) {
        gchar** paths = g_strsplit(paths_blob, "\n", -1);
        bool first = true;
        for (gchar** path = paths; path && *path; ++path) {
            if (!**path) continue;
            if (!first) g_string_append_c(json, ',');
            first = false;
            append_file_description(json, *path);
        }
        g_strfreev(paths);
    }
    g_string_append(json, "]}");
    std::string result(json->str, json->len);
    g_string_free(json, TRUE);
    return result;
}

const char* get_flash_os_ext(int model) {
    const CalcModel calc = model ? (CalcModel)model : current_model();
    if (calc == CALC_NONE) {
        return nullptr;
    }
    return tifiles_fext_of_flash_os(calc);
}

const char* get_file_extensions(int model) {
    static std::string result;
    result.clear();
    const CalcModel calc = model ? (CalcModel)model : current_model();
    const bool z80 = tifiles_calc_is_ti8x(calc) && calc != CALC_TI80;
    const bool m68k = tifiles_calc_is_ti9x(calc);
    const bool nspire = tifiles_calc_is_tinspire(calc);
    const bool evo = ticonv_model_is_tievo(calc);
    if (!z80 && !m68k && !nspire && !evo) return result.c_str();

    std::set<std::string> extensions;
    auto add = [&](const char* ext) {
        if (!ext || !*ext) return;
        std::string normalized;
        for (const char* p = ext; *p; ++p) {
            if (!g_ascii_isalnum(*p)) return; // Ignore unknown-type placeholders.
            normalized += g_ascii_tolower(*p);
        }
        extensions.insert(normalized);
    };
    for (int type = 0; type < 256; ++type) {
        add(tifiles_vartype2fext(calc, (uint8_t)type));
    }
    add(tifiles_fext_of_group(calc));
    add(tifiles_fext_of_backup(calc));
    add(tifiles_fext_of_flash_os(calc));
    add(tifiles_fext_of_flash_app(calc));
    if (z80 || m68k) add("tig");

    // Alternate equation/group extensions are not all in the type tables.
    if (extensions.count("8xe")) add("8xy");
    if (extensions.count("8ci")) add("8cg");
    if (m68k) {
        // Regular variables can be transferred across the 68k family.
        for (CalcModel source : {CALC_TI89, CALC_TI92, CALC_TI92P, CALC_V200}) {
            for (int type = 0; type < 256; ++type) {
                if (type == 29 || type == 35 || type == 36 || type == 37) continue;
                add(tifiles_vartype2fext(source, (uint8_t)type));
            }
            add(tifiles_fext_of_group(source));
        }
        if (tifiles_fext_of_flash_os(calc)) add("tib");
    }
    if (evo) {
        switch (calc) {
        case CALC_TI83EVO_USB: add("83pk2"); break;
        case CALC_TI84EVOT_USB: add("84tpk2"); break;
        default: add("84pk2"); break;
        }
    }
    for (const auto& ext : extensions) {
        if (!result.empty()) result += ',';
        result += ext;
    }
    return result.c_str();
}

std::string bundle_extract_json(const char* filename, const char* out_dir) {
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

            if (!first) g_string_append_c(json, ',');
            append_file_description(json, out_path);
            first = false;

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

    std::string result(json->str, json->len);
    g_string_free(json, TRUE);
    return result;
}

} // namespace ti
