#ifndef WEBTILP_JSON_H
#define WEBTILP_JSON_H

#include <cstddef>
#include <cstdio>
#include <string>
#include <string_view>

namespace webtilp_json {

// Existing TI responses use Unicode escapes for backspace and form feed;
// HP Prime responses use their equivalent short escapes.
enum class ControlEscapes { Unicode, Short };

size_t bounded_length(const char* text, size_t max_length);
std::string escape(std::string_view text,
                   ControlEscapes controls = ControlEscapes::Unicode);
std::string escape_bounded(const char* text, size_t max_length,
                           ControlEscapes controls = ControlEscapes::Unicode);
void write_escaped(FILE* output, const char* text, size_t max_length,
                   ControlEscapes controls = ControlEscapes::Unicode);

} // namespace webtilp_json

#endif
