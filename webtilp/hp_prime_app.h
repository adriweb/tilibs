#ifndef WEBTILP_HP_PRIME_APP_H
#define WEBTILP_HP_PRIME_APP_H

#include <stddef.h>
#include <stdint.h>

#include <string>
#include <vector>

namespace hp_prime_app {

enum class PartKind {
    Descriptor,
    Note,
    Program,
    Resource
};

struct Part {
    PartKind kind;
    std::string name;
    size_t section_offset;
    size_t section_size;
    size_t data_offset;
    size_t data_size;
};

struct Parsed {
    std::vector<Part> parts;
};

struct ResourceUpdate {
    std::string name;
    const uint8_t* data;
    size_t size;
};

bool parse(const uint8_t* data, size_t size, const std::string& app_name,
           Parsed* parsed, std::string* error);

bool extract(const uint8_t* data, size_t size, const Parsed& parsed,
             size_t part_index, const uint8_t** part_data,
             size_t* part_size, std::string* error);

bool replace_or_add_resource(const uint8_t* data, size_t size,
                             const Parsed& parsed,
                             const std::string& resource_name,
                             const uint8_t* resource_data,
                             size_t resource_size,
                             std::vector<uint8_t>* rebuilt,
                             std::string* error);

bool replace_or_add_resources(const uint8_t* data, size_t size,
                              const Parsed& parsed,
                              const std::vector<ResourceUpdate>& updates,
                              std::vector<uint8_t>* rebuilt,
                              std::string* error);

bool rename_resource(const uint8_t* data, size_t size, const Parsed& parsed,
                     size_t part_index, const std::string& new_name,
                     std::vector<uint8_t>* rebuilt, std::string* error);

bool delete_resource(const uint8_t* data, size_t size, const Parsed& parsed,
                     size_t part_index, std::vector<uint8_t>* rebuilt,
                     std::string* error);

} // namespace hp_prime_app

#endif
