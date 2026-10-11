#include "ti_file_io.h"

namespace ti {
RegularContent load_regular(const char* filename, CalcModel destination, int& result) {
    if (!filename || !*filename) {
        result = ERR_WEB_INVALID_ARGUMENT;
        return {};
    }
    FileContent* content = tifiles_content_create_regular(destination);
    if (!content) {
        result = ERR_WEB_OUT_OF_MEMORY;
        return {};
    }
    result = tifiles_file_read_regular(filename, content);
    return RegularContent(result ? nullptr : content);
}

FlashContentOwner load_flash(const char* filename, CalcModel destination, int& result) {
    if (!filename || !*filename) {
        result = ERR_WEB_INVALID_ARGUMENT;
        return {};
    }
    FlashContent* content = tifiles_content_create_flash(destination);
    if (!content) {
        result = ERR_WEB_OUT_OF_MEMORY;
        return {};
    }
    result = tifiles_file_read_flash(filename, content);
    return FlashContentOwner(result ? nullptr : content);
}

TigroupContent load_tigroup(const char* filename, CalcModel destination, int& result) {
    if (!filename || !*filename) {
        result = ERR_WEB_INVALID_ARGUMENT;
        return {};
    }
    TigroupContent content(tifiles_content_create_tigroup(destination, 0));
    if (!content) {
        result = ERR_WEB_OUT_OF_MEMORY;
        return {};
    }
    result = tifiles_file_read_tigroup(filename, content.get());
    if (result) content.reset();
    return content;
}
} // namespace ti
