#include "ti_backup_vat.h"

#include <cstring>
#include <utility>

namespace {
uint16_t word(const std::vector<uint8_t>& data, size_t offset) {
    return data[offset] | (uint16_t(data[offset + 1]) << 8);
}

size_t variable_size(const std::vector<uint8_t>& data, size_t offset, int model, uint8_t type) {
    if (offset >= data.size() || data.size() - offset < 2) return 0;
    if (model == 82) {
        switch (type) {
        case 0: return 9;
        case 1: return 2 + 9u * word(data, offset);
        case 2:
            return 2 + 9u * data[offset] * data[offset + 1];
        case 3: case 5: case 6: case 7: case 8:
            return 2u + word(data, offset);
        default: return 0;
        }
    }
    switch (type) {
    case 0: case 8: return 10;
    case 1: case 9: return 20;
    case 2: case 3: case 6: case 7:
        return 2 + (type & 1 ? 20u : 10u) * data[offset] * data[offset + 1];
    case 4: case 5:
        return 2 + (type & 1 ? 20u : 10u) * word(data, offset);
    case 10: case 12: case 13: case 14: case 15: case 16: case 17: case 18:
        return 2u + word(data, offset);
    default: return 0;
    }
}

} // namespace

// Parse a complete .82b/.85b file; model is 82 or 85, not a CalcModel enum.
// On failure, entries is empty and error describes the invalid data.
bool parse_ti_backup_vat(const std::vector<uint8_t>& file, int model,
                         std::vector<TiBackupVatEntry>& entries, std::string& error) {
    entries.clear();
    error.clear();
    std::vector<TiBackupVatEntry> parsed;
#define REQUIRE(condition, reason) do { if (!(condition)) { error = reason; return false; } } while (0)
    // TI Link Protocol & File Format Guide: three length-prefixed blocks,
    // system data / user data / backwards VAT. The header supplies the user
    // data's RAM base; do not assume a ROM-version-specific fixed address.
    REQUIRE(model == 82 || model == 85, "Unsupported backup model");
    REQUIRE(file.size() >= 74 && file.size() < 65536, "Invalid backup size");
    REQUIRE(std::memcmp(file.data(), model == 82 ? "**TI82**" : "**TI85**", 8) == 0,
            "Backup model does not match calculator");
    REQUIRE(file[8] == 0x1a && file[9] == (model == 85 ? 0x0c : 0x0a) && file[10] == 0,
            "Invalid backup signature");
    REQUIRE(word(file, 53) == file.size() - 57, "Invalid backup payload length");
    REQUIRE(word(file, 55) == 9, "Unsupported backup header");
    REQUIRE(file[59] == (model == 82 ? 0x0f : 0x1d), "Not a native backup");
    uint16_t checksum = 0;
    for (size_t i = 55; i < file.size() - 2; ++i) checksum += file[i];
    REQUIRE(checksum == word(file, file.size() - 2), "Backup checksum mismatch");

    const size_t lengths[] = {word(file, 57), word(file, 60), word(file, 62)};
    std::vector<uint8_t> parts[3];
    size_t offset = 66;
    for (size_t i = 0; i < 3; ++i) {
        REQUIRE(offset <= file.size() - 4, "Truncated backup block length");
        REQUIRE(word(file, offset) == lengths[i], "Backup block length mismatch");
        offset += 2;
        REQUIRE(offset <= file.size() - 2 && lengths[i] <= file.size() - 2 - offset,
                "Truncated backup block");
        parts[i].assign(file.begin() + offset, file.begin() + offset + lengths[i]);
        offset += lengths[i];
    }
    REQUIRE(offset == file.size() - 2, "Trailing backup data");
    const size_t base = word(file, 64);
    REQUIRE(base >= 0x8000 && base + parts[1].size() <= 0x10000,
            "Invalid backup user memory range");

    // TI-82: type/address + three token bytes, or length/name for programs.
    // TI-85: type/address + length/name for every entry. Read all fields from
    // the end backwards (including the little-endian RAM address).
    size_t cursor = parts[2].size();
    const auto byte = [&]() {
        return parts[2][--cursor];
    };
    while (cursor) {
        REQUIRE(cursor >= 4, "Truncated VAT entry");
        TiBackupVatEntry entry{};
        entry.type = byte() & (model == 82 ? 0x0f : 0x1f);
        entry.address = byte();
        entry.address |= uint16_t(byte()) << 8;
        const bool named = model == 85 || entry.type == 5 || entry.type == 6;
        const size_t name_length = named ? byte() : 3;
        REQUIRE(name_length > 0 && name_length <= 8, "Invalid VAT name length");
        REQUIRE(cursor >= name_length, "Truncated VAT name");
        for (size_t i = 0; i < name_length; ++i) entry.name[i] = char(byte());
        REQUIRE(entry.name[0] != 0, "Empty VAT name");
        REQUIRE(entry.address >= base, "VAT address below backup user data");
        const size_t position = entry.address - base;
        const size_t size = variable_size(parts[1], position, model, entry.type);
        REQUIRE(size && position < parts[1].size() && size <= parts[1].size() - position, "Variable extends beyond backup user data");
        entry.size = uint16_t(size);
        parsed.push_back(entry);
    }
    entries = std::move(parsed);
    return true;
#undef REQUIRE
}
