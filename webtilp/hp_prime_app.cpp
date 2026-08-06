#include "hp_prime_app.h"

#include <algorithm>
#include <limits>
#include <set>

namespace hp_prime_app {
namespace {

static void set_error(std::string* error, const char* message)
{
    if (error) {
        *error = message;
    }
}

static bool read_u32be(const uint8_t* data, size_t size, size_t offset,
                       uint32_t* value)
{
    if (!data || !value || offset > size || size - offset < 4) {
        return false;
    }
    *value = ((uint32_t)data[offset] << 24)
        | ((uint32_t)data[offset + 1] << 16)
        | ((uint32_t)data[offset + 2] << 8)
        | (uint32_t)data[offset + 3];
    return true;
}

static void append_u32be(std::vector<uint8_t>* output, uint32_t value)
{
    output->push_back((uint8_t)(value >> 24));
    output->push_back((uint8_t)(value >> 16));
    output->push_back((uint8_t)(value >> 8));
    output->push_back((uint8_t)value);
}

static void append_utf8(std::string* output, uint32_t codepoint)
{
    if (codepoint <= 0x7fU) {
        output->push_back((char)codepoint);
    } else if (codepoint <= 0x7ffU) {
        output->push_back((char)(0xc0U | (codepoint >> 6)));
        output->push_back((char)(0x80U | (codepoint & 0x3fU)));
    } else if (codepoint <= 0xffffU) {
        output->push_back((char)(0xe0U | (codepoint >> 12)));
        output->push_back((char)(0x80U | ((codepoint >> 6) & 0x3fU)));
        output->push_back((char)(0x80U | (codepoint & 0x3fU)));
    } else {
        output->push_back((char)(0xf0U | (codepoint >> 18)));
        output->push_back((char)(0x80U | ((codepoint >> 12) & 0x3fU)));
        output->push_back((char)(0x80U | ((codepoint >> 6) & 0x3fU)));
        output->push_back((char)(0x80U | (codepoint & 0x3fU)));
    }
}

static bool decode_utf16le(const uint8_t* data, size_t size,
                           std::string* output)
{
    if (!output || (!data && size != 0) || (size & 1U) != 0) {
        return false;
    }
    output->clear();
    for (size_t offset = 0; offset < size; offset += 2) {
        uint32_t codepoint = (uint32_t)data[offset]
            | ((uint32_t)data[offset + 1] << 8);
        if (codepoint >= 0xd800U && codepoint <= 0xdbffU) {
            if (size - offset < 4) {
                return false;
            }
            const uint32_t low = (uint32_t)data[offset + 2]
                | ((uint32_t)data[offset + 3] << 8);
            if (low < 0xdc00U || low > 0xdfffU) {
                return false;
            }
            codepoint = 0x10000U + ((codepoint - 0xd800U) << 10)
                + (low - 0xdc00U);
            offset += 2;
        } else if (codepoint >= 0xdc00U && codepoint <= 0xdfffU) {
            return false;
        }
        append_utf8(output, codepoint);
    }
    return true;
}

static bool encode_utf16le(const std::string& input,
                           std::vector<uint8_t>* output)
{
    if (!output) {
        return false;
    }
    output->clear();
    const uint8_t* cursor = (const uint8_t*)input.data();
    const uint8_t* end = cursor + input.size();
    while (cursor < end) {
        uint32_t codepoint;
        size_t continuation;
        const uint8_t first = *cursor++;
        if (first < 0x80U) {
            codepoint = first;
            continuation = 0;
        } else if ((first & 0xe0U) == 0xc0U) {
            codepoint = first & 0x1fU;
            continuation = 1;
            if (codepoint < 2U) {
                return false;
            }
        } else if ((first & 0xf0U) == 0xe0U) {
            codepoint = first & 0x0fU;
            continuation = 2;
        } else if ((first & 0xf8U) == 0xf0U) {
            codepoint = first & 0x07U;
            continuation = 3;
        } else {
            return false;
        }
        if ((size_t)(end - cursor) < continuation) {
            return false;
        }
        for (size_t i = 0; i < continuation; i++) {
            if ((*cursor & 0xc0U) != 0x80U) {
                return false;
            }
            codepoint = (codepoint << 6) | (*cursor++ & 0x3fU);
        }
        if ((continuation == 2 && codepoint < 0x800U)
            || (continuation == 3 && codepoint < 0x10000U)
            || codepoint > 0x10ffffU
            || (codepoint >= 0xd800U && codepoint <= 0xdfffU)) {
            return false;
        }
        if (codepoint <= 0xffffU) {
            output->push_back((uint8_t)codepoint);
            output->push_back((uint8_t)(codepoint >> 8));
        } else {
            codepoint -= 0x10000U;
            const uint16_t high = (uint16_t)(0xd800U | (codepoint >> 10));
            const uint16_t low = (uint16_t)(0xdc00U | (codepoint & 0x3ffU));
            output->push_back((uint8_t)high);
            output->push_back((uint8_t)(high >> 8));
            output->push_back((uint8_t)low);
            output->push_back((uint8_t)(low >> 8));
        }
    }
    return true;
}

static std::string lowercase_ascii(const std::string& input)
{
    std::string result = input;
    std::transform(result.begin(), result.end(), result.begin(),
        [](unsigned char value) {
            return value >= 'A' && value <= 'Z' ? (char)(value + 32) : (char)value;
        });
    return result;
}

static bool valid_resource_name(const std::string& name,
                                std::vector<uint8_t>* encoded,
                                std::string* error)
{
    if (name.empty() || name == "." || name == "..") {
        set_error(error, "resource name is empty or reserved");
        return false;
    }
    for (unsigned char value : name) {
        if (value < 0x20U || value == 0x7fU || value == '/' || value == '\\') {
            set_error(error, "resource name contains a path separator or control character");
            return false;
        }
    }
    if (!encode_utf16le(name, encoded) || encoded->empty()) {
        set_error(error, "resource name is not valid UTF-8");
        return false;
    }
    if (encoded->size() / 2U > 128U) {
        set_error(error, "resource name exceeds 128 UTF-16 code units");
        return false;
    }
    return true;
}

static bool append_bytes(std::vector<uint8_t>* output, const uint8_t* data,
                         size_t size)
{
    if (size == 0) {
        return true;
    }
    if (!data || size > output->max_size() - output->size()) {
        return false;
    }
    output->insert(output->end(), data, data + size);
    return true;
}

static bool append_named_resource(std::vector<uint8_t>* output,
                                  const std::vector<uint8_t>& encoded_name,
                                  const uint8_t* data, size_t size,
                                  std::string* error)
{
    if (encoded_name.size() > UINT32_MAX - 2U
        || size > UINT32_MAX - encoded_name.size() - 2U) {
        set_error(error, "resource section is too large");
        return false;
    }
    append_u32be(output, (uint32_t)(encoded_name.size() + 2U + size));
    if (!append_bytes(output, encoded_name.data(), encoded_name.size())) {
        set_error(error, "resource output is too large");
        return false;
    }
    output->push_back(0);
    output->push_back(0);
    if (!append_bytes(output, data, size)) {
        set_error(error, "resource output is too large");
        return false;
    }
    return true;
}

static bool validate_source(const uint8_t* data, size_t size,
                            const Parsed& parsed, std::string* error)
{
    if (!data || parsed.parts.size() < 3) {
        set_error(error, "application container is missing required sections");
        return false;
    }
    for (const Part& part : parsed.parts) {
        if (part.section_offset > size
            || part.section_size > size - part.section_offset
            || part.data_offset > size
            || part.data_size > size - part.data_offset) {
            set_error(error, "application section is outside the source data");
            return false;
        }
    }
    return true;
}

static bool has_duplicate_name(const Parsed& parsed, const std::string& name,
                               size_t ignored_index)
{
    const std::string key = lowercase_ascii(name);
    for (size_t i = 0; i < parsed.parts.size(); i++) {
        if (i != ignored_index
            && lowercase_ascii(parsed.parts[i].name) == key) {
            return true;
        }
    }
    return false;
}

} // namespace

bool parse(const uint8_t* data, size_t size, const std::string& app_name,
           Parsed* parsed, std::string* error)
{
    static const PartKind core_kinds[] = {
        PartKind::Descriptor, PartKind::Note, PartKind::Program
    };
    if (!data || !parsed) {
        set_error(error, "application data is unavailable");
        return false;
    }
    Parsed result;
    size_t offset = 0;
    const std::string core_names[] = {
        app_name + ".hpapp",
        app_name + ".hpappnote",
        app_name + ".hpappprgm"
    };
    for (size_t i = 0; i < 3; i++) {
        uint32_t field_size;
        if (!read_u32be(data, size, offset, &field_size)
            || field_size > size - offset - 4U) {
            set_error(error, "application core section exceeds the container");
            return false;
        }
        Part part;
        part.kind = core_kinds[i];
        part.name = core_names[i];
        part.section_offset = offset;
        part.section_size = 4U + field_size;
        part.data_offset = offset + 4U;
        part.data_size = field_size;
        result.parts.push_back(part);
        offset += 4U + field_size;
    }

    std::set<std::string> names;
    while (offset < size) {
        uint32_t field_size;
        if (!read_u32be(data, size, offset, &field_size)
            || field_size > size - offset - 4U || field_size < 2U) {
            set_error(error, "application resource section exceeds the container");
            return false;
        }
        const size_t payload_offset = offset + 4U;
        size_t terminator = 0;
        bool found_terminator = false;
        for (; terminator + 1U < field_size; terminator += 2U) {
            if (data[payload_offset + terminator] == 0
                && data[payload_offset + terminator + 1U] == 0) {
                found_terminator = true;
                break;
            }
        }
        std::string name;
        if (!found_terminator || terminator == 0
            || !decode_utf16le(data + payload_offset, terminator, &name)) {
            set_error(error, "application resource has an invalid UTF-16LE name");
            return false;
        }
        std::vector<uint8_t> encoded;
        if (!valid_resource_name(name, &encoded, error)) {
            return false;
        }
        const std::string name_key = lowercase_ascii(name);
        if (!names.insert(name_key).second) {
            set_error(error, "application contains duplicate resource names");
            return false;
        }
        Part part;
        part.kind = PartKind::Resource;
        part.name = name;
        part.section_offset = offset;
        part.section_size = 4U + field_size;
        part.data_offset = payload_offset + terminator + 2U;
        part.data_size = field_size - terminator - 2U;
        result.parts.push_back(part);
        offset += 4U + field_size;
    }
    *parsed = std::move(result);
    if (error) {
        error->clear();
    }
    return true;
}

bool extract(const uint8_t* data, size_t size, const Parsed& parsed,
             size_t part_index, const uint8_t** part_data,
             size_t* part_size, std::string* error)
{
    if (!part_data || !part_size || !validate_source(data, size, parsed, error)
        || part_index >= parsed.parts.size()) {
        if (part_index >= parsed.parts.size()) {
            set_error(error, "application child index is out of range");
        }
        return false;
    }
    const Part& part = parsed.parts[part_index];
    *part_data = data + part.data_offset;
    *part_size = part.data_size;
    return true;
}

bool replace_or_add_resource(const uint8_t* data, size_t size,
                             const Parsed& parsed,
                             const std::string& resource_name,
                             const uint8_t* resource_data,
                             size_t resource_size,
                             std::vector<uint8_t>* rebuilt,
                             std::string* error)
{
    const ResourceUpdate update = {
        resource_name, resource_data, resource_size
    };
    return replace_or_add_resources(data, size, parsed, {update}, rebuilt,
                                    error);
}

bool replace_or_add_resources(const uint8_t* data, size_t size,
                              const Parsed& parsed,
                              const std::vector<ResourceUpdate>& updates,
                              std::vector<uint8_t>* rebuilt,
                              std::string* error)
{
    if (!rebuilt || !validate_source(data, size, parsed, error)) {
        return false;
    }
    std::vector<std::vector<uint8_t>> encoded_names(updates.size());
    std::set<std::string> update_names;
    size_t additional_size = 0;
    for (size_t i = 0; i < updates.size(); i++) {
        const ResourceUpdate& update = updates[i];
        if ((!update.data && update.size != 0)
            || !valid_resource_name(update.name, &encoded_names[i], error)) {
            return false;
        }
        if (!update_names.insert(lowercase_ascii(update.name)).second) {
            set_error(error, "resource update contains duplicate names");
            return false;
        }
        for (size_t core_index = 0; core_index < 3; core_index++) {
            if (lowercase_ascii(update.name)
                == lowercase_ascii(parsed.parts[core_index].name)) {
                set_error(error, "core application part names are reserved");
                return false;
            }
        }
        const size_t maximum = std::numeric_limits<size_t>::max();
        if (update.size > maximum - additional_size) {
            set_error(error, "resource updates are too large");
            return false;
        }
        additional_size += update.size;
        if (additional_size > maximum - 6U
            || encoded_names[i].size() > maximum - additional_size - 6U) {
            set_error(error, "resource updates are too large");
            return false;
        }
        additional_size += encoded_names[i].size() + 6U;
    }

    rebuilt->clear();
    if (additional_size > rebuilt->max_size() - size) {
        set_error(error, "application output is too large");
        return false;
    }
    rebuilt->reserve(size + additional_size);
    std::vector<bool> used(updates.size(), false);
    for (const Part& part : parsed.parts) {
        size_t update_index = updates.size();
        if (part.kind == PartKind::Resource) {
            const std::string part_key = lowercase_ascii(part.name);
            for (size_t i = 0; i < updates.size(); i++) {
                if (lowercase_ascii(updates[i].name) == part_key) {
                    update_index = i;
                    break;
                }
            }
        }
        if (update_index != updates.size()) {
            std::vector<uint8_t> original_name;
            if (!encode_utf16le(part.name, &original_name)
                || !append_named_resource(rebuilt, original_name,
                    updates[update_index].data, updates[update_index].size,
                    error)) {
                return false;
            }
            used[update_index] = true;
        } else if (!append_bytes(rebuilt, data + part.section_offset,
                                 part.section_size)) {
            set_error(error, "application output is too large");
            return false;
        }
    }
    for (size_t i = 0; i < updates.size(); i++) {
        if (!used[i] && !append_named_resource(rebuilt, encoded_names[i],
                updates[i].data, updates[i].size, error)) {
            return false;
        }
    }
    return true;
}

bool rename_resource(const uint8_t* data, size_t size, const Parsed& parsed,
                     size_t part_index, const std::string& new_name,
                     std::vector<uint8_t>* rebuilt, std::string* error)
{
    std::vector<uint8_t> encoded_name;
    if (!rebuilt || !validate_source(data, size, parsed, error)
        || part_index >= parsed.parts.size()
        || parsed.parts[part_index].kind != PartKind::Resource) {
        set_error(error, "only application resources can be renamed");
        return false;
    }
    if (!valid_resource_name(new_name, &encoded_name, error)) {
        return false;
    }
    if (has_duplicate_name(parsed, new_name, part_index)) {
        set_error(error, "an application resource already has that name");
        return false;
    }
    if (size > rebuilt->max_size() - encoded_name.size() - 2U) {
        set_error(error, "application output is too large");
        return false;
    }
    rebuilt->clear();
    rebuilt->reserve(size + encoded_name.size() + 2U);
    for (size_t i = 0; i < parsed.parts.size(); i++) {
        const Part& part = parsed.parts[i];
        if (i == part_index) {
            if (!append_named_resource(rebuilt, encoded_name,
                data + part.data_offset, part.data_size, error)) {
                return false;
            }
        } else if (!append_bytes(rebuilt, data + part.section_offset,
                                 part.section_size)) {
            set_error(error, "application output is too large");
            return false;
        }
    }
    return true;
}

bool delete_resource(const uint8_t* data, size_t size, const Parsed& parsed,
                     size_t part_index, std::vector<uint8_t>* rebuilt,
                     std::string* error)
{
    if (!rebuilt || !validate_source(data, size, parsed, error)
        || part_index >= parsed.parts.size()
        || parsed.parts[part_index].kind != PartKind::Resource) {
        set_error(error, "only application resources can be deleted");
        return false;
    }
    rebuilt->clear();
    rebuilt->reserve(size - parsed.parts[part_index].section_size);
    for (size_t i = 0; i < parsed.parts.size(); i++) {
        if (i == part_index) {
            continue;
        }
        const Part& part = parsed.parts[i];
        if (!append_bytes(rebuilt, data + part.section_offset,
                          part.section_size)) {
            set_error(error, "application output is too large");
            return false;
        }
    }
    return true;
}

} // namespace hp_prime_app
