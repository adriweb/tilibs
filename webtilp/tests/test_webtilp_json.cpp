#include "../webtilp_json.h"

#include <cassert>
#include <cstdio>
#include <iostream>

int main()
{
    using namespace webtilp_json;
    assert(escape("plain text / <> ") == "plain text / <> ");
    assert(escape("\"\\\n\r\t") == "\\\"\\\\\\n\\r\\t");
    assert(escape("\b\f") == "\\u0008\\u000c");
    assert(escape("\b\f", ControlEscapes::Short) == "\\b\\f");
    assert(escape(std::string_view("\0\x01\x1f", 3)) == "\\u0000\\u0001\\u001f");
    assert(escape(u8"é π 🧮") == u8"é π 🧮");

    // Fixed-width names are not required to carry a terminating NUL.
    const char fixed_width[] = {'a', '"', '\\', 'b'};
    assert(bounded_length(fixed_width, sizeof(fixed_width)) == sizeof(fixed_width));
    assert(escape_bounded(fixed_width, sizeof(fixed_width)) == "a\\\"\\\\b");
    assert(escape_bounded(fixed_width, 2) == "a\\\"");
    assert(escape_bounded("before\0after", 12) == "before");
    assert(escape_bounded(fixed_width, 0).empty());
    assert(escape_bounded(nullptr, 4).empty());
    assert(bounded_length(nullptr, 4) == 0);

    FILE* output = tmpfile();
    assert(output);
    write_escaped(output, "\"\\\n\r\t\b\f\x01", 9);
    write_escaped(output, nullptr, 8);
    rewind(output);
    char contents[64]{};
    const size_t count = fread(contents, 1, sizeof(contents), output);
    assert(!ferror(output));
    assert(std::string(contents, count) == "\\\"\\\\\\n\\r\\t\\u0008\\u000c\\u0001");
    fclose(output);

    std::cout << "WebTiLP JSON helper tests passed\n";
}
