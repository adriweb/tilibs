#pragma once
#include "ti_common.h"
#include <memory>

namespace ti {
struct RegularDeleter {
    void operator()(FileContent* content) const { tifiles_content_delete_regular(content); }
};
struct FlashDeleter {
    void operator()(FlashContent* content) const { tifiles_content_delete_flash(content); }
};
struct TigroupDeleter {
    void operator()(TigContent* content) const { tifiles_content_delete_tigroup(content); }
};
using RegularContent = std::unique_ptr<FileContent, RegularDeleter>;
using FlashContentOwner = std::unique_ptr<FlashContent, FlashDeleter>;
using TigroupContent = std::unique_ptr<TigContent, TigroupDeleter>;

// Valid regular/flash reader arguments transfer ownership to libtifiles on
// failure. TiGroup retains ownership on failure. Keep that difference here.
RegularContent load_regular(const char* filename, CalcModel destination, int& result);
FlashContentOwner load_flash(const char* filename, CalcModel destination, int& result);
TigroupContent load_tigroup(const char* filename, CalcModel destination, int& result);
} // namespace ti
