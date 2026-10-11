#include "webtilp_json.h"

namespace webtilp_json {
namespace {

template <typename Sink>
void write_escaped_bytes(std::string_view text, ControlEscapes controls, Sink sink)
{
    static constexpr char hex[] = "0123456789abcdef";
    for (unsigned char value : text) {
        switch (value) {
        case '"': sink("\\\"", 2); break;
        case '\\': sink("\\\\", 2); break;
        case '\n': sink("\\n", 2); break;
        case '\r': sink("\\r", 2); break;
        case '\t': sink("\\t", 2); break;
        default:
            if (controls == ControlEscapes::Short && value == '\b') {
                sink("\\b", 2);
            } else if (controls == ControlEscapes::Short && value == '\f') {
                sink("\\f", 2);
            } else if (value < 0x20) {
                const char encoded[] = {'\\', 'u', '0', '0',
                                        hex[value >> 4], hex[value & 0x0f]};
                sink(encoded, sizeof(encoded));
            } else {
                const char byte = char(value);
                sink(&byte, 1);
            }
        }
    }
}

} // namespace

size_t bounded_length(const char* text, size_t max_length)
{
    if (!text) return 0;
    size_t length = 0;
    while (length < max_length && text[length]) ++length;
    return length;
}

std::string escape(std::string_view text, ControlEscapes controls)
{
    std::string result;
    result.reserve(text.size());
    write_escaped_bytes(text, controls, [&result](const char* bytes, size_t length) {
        result.append(bytes, length);
    });
    return result;
}

std::string escape_bounded(const char* text, size_t max_length, ControlEscapes controls)
{
    const size_t length = bounded_length(text, max_length);
    return escape(std::string_view(text ? text : "", length), controls);
}

void write_escaped(FILE* output, const char* text, size_t max_length, ControlEscapes controls)
{
    const size_t length = bounded_length(text, max_length);
    write_escaped_bytes(std::string_view(text ? text : "", length), controls,
                        [output](const char* bytes, size_t size) {
                            fwrite(bytes, 1, size, output);
                        });
}

} // namespace webtilp_json
