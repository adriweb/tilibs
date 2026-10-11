#ifndef WEBTILP_TI_BACKUP_VAT_H
#define WEBTILP_TI_BACKUP_VAT_H

#include <array>
#include <cstdint>
#include <string>
#include <vector>

struct TiBackupVatEntry {
    uint8_t type;
    std::array<char, 9> name{};
    uint16_t address;
    uint16_t size;
};

// Parse a complete .82b/.85b file; model is 82 or 85, not a CalcModel enum.
// On failure, entries is empty and error describes the invalid data.
bool parse_ti_backup_vat(const std::vector<uint8_t>& file, int model,
                         std::vector<TiBackupVatEntry>& entries, std::string& error);

#endif
