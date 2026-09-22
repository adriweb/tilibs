#define WEBTILP_BACKUP_VAT_TEST
#include "../webtilp.cpp"
#include <algorithm>
#include <cassert>
#include <fstream>
#include <iostream>
#include <iterator>

using Bytes = std::vector<uint8_t>;
static void put_word(Bytes& b, size_t p, uint16_t n) { b[p] = n; b[p + 1] = n >> 8; }
static void checksum(Bytes& b) {
    uint16_t sum = 0;
    for (size_t i = 55; i < b.size() - 2; ++i) sum += b[i];
    put_word(b, b.size() - 2, sum);
}
static Bytes read_file(const char* path) {
    std::ifstream in(path, std::ios::binary);
    assert(in.good());
    return Bytes(std::istreambuf_iterator<char>(in), {});
}
static Bytes backup(int model, uint8_t type, const Bytes& data, const Bytes& name) {
    Bytes b(66);
    const std::string signature = model == 82 ? "**TI82**" : "**TI85**";
    std::copy(signature.begin(), signature.end(), b.begin());
    b[8] = 0x1a; b[9] = model == 82 ? 0x0a : 0x0c;
    put_word(b, 55, 9); put_word(b, 60, data.size());
    b[59] = model == 82 ? 0x0f : 0x1d;
    put_word(b, 64, 0x9000); // Deliberately not a fixed model/ROM base.
    Bytes vat{type, 0, 0x90};
    if (model == 85 || (type & 15) == 5 || (type & 15) == 6) vat.push_back(name.size());
    vat.insert(vat.end(), name.begin(), name.end());
    put_word(b, 62, vat.size());
    b.insert(b.end(), {0, 0}); // empty system block
    b.push_back(data.size()); b.push_back(data.size() >> 8);
    b.insert(b.end(), data.begin(), data.end());
    b.push_back(vat.size()); b.push_back(vat.size() >> 8);
    b.insert(b.end(), vat.rbegin(), vat.rend());
    b.insert(b.end(), {0, 0});
    put_word(b, 53, b.size() - 57); checksum(b);
    return b;
}
static std::vector<TiBackupVatEntry> parse(const Bytes& b, int model) {
    std::vector<TiBackupVatEntry> entries;
    std::string error;
    if (!parse_ti_backup_vat(b, model, entries, error)) {
        std::cerr << error << '\n';
        std::abort();
    }
    assert(error.empty());
    return entries;
}
static void invalid(Bytes b, int model, bool fix_checksum = true) {
    if (fix_checksum) checksum(b);
    std::vector<TiBackupVatEntry> entries(1);
    std::string error;
    assert(!parse_ti_backup_vat(b, model, entries, error));
    assert(entries.empty() && !error.empty());
}
int main(int argc, char** argv) {
    const auto sample = read_file("../libtifiles/trunk/tests/ti82/backup.82b");
    const auto entries = parse(sample, 82);
    assert(entries.size() == 73);
    const auto poly = std::find_if(entries.begin(), entries.end(), [](const auto& e) {
        return std::string(e.name.data()) == "POLY";
    });
    assert(poly != entries.end() && poly->type == 5 && poly->size == 284 && poly->address == 0x9189);
    assert(entries.front().name[0] == '^' && entries.front().name[1] == 0x19);

    // Public sample is optional, never downloaded by the test suite.
    if (argc > 1) {
        const auto zs = parse(read_file(argv[1]), 85);
        assert(zs.size() == 9);
        assert(std::string(zs[0].name.data()) == "ZShell" && zs[0].size == 1196);
        assert(std::string(zs[7].name.data()) == "Organise" && zs[7].size == 4128);
        assert(std::string(zs[8].name.data()) == "texan" && zs[8].size == 2262);
    }
    for (const int model : {82, 85}) {
        const Bytes name = model == 82 ? Bytes{'A', 0, 0} : Bytes{'A'};
        const auto real = backup(model, 0, Bytes(model == 82 ? 9 : 10), name);
        assert(parse(real, model)[0].size == (model == 82 ? 9 : 10));
        for (size_t length = 0; length < real.size(); ++length) {
            invalid(Bytes(real.begin(), real.begin() + length), model, false);
        }
        auto bad = real; bad.back() ^= 1; invalid(bad, model, false);
        bad = real; bad[53] ^= 1; invalid(bad, model);
        bad = real; bad[66] = 1; invalid(bad, model);
        bad = real; bad[bad.size() - 5] = 0x7f; invalid(bad, model); // VAT address below base
        bad = real; bad[bad.size() - 3] = 0x1f; invalid(bad, model); // unknown type
        invalid(real, model == 82 ? 85 : 82);
    }
    assert(parse(backup(82, 0x85, {3, 0, 'a', 'b', 'c'}, {'P'}), 82)[0].size == 5);
    assert(parse(backup(82, 2, Bytes{2, 0}, {'\\', 0, 0}), 82)[0].size == 2);
    Bytes list82(20); list82[0] = 2;
    assert(parse(backup(82, 1, list82, {']', 0, 0}), 82)[0].size == 20);
    for (uint8_t type : {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16, 17, 18}) {
        Bytes data;
        if (type == 1 || type == 9) data.resize(20);
        else if (type == 8) data.resize(10);
        else if (type >= 10) data = {3, 0, 'a', 'b', 'c'};
        else {
            data.resize(2 + ((type & 1) ? 20 : 10));
            data[0] = 1;
            if (type != 4 && type != 5) data[1] = 1;
        }
        assert(parse(backup(85, type, data, {'T', 'e', 's', 't'}), 85)[0].size == data.size());
    }
    invalid(backup(85, 12, {0xff, 0xff}, {'A'}), 85);
    invalid(backup(85, 0, Bytes(10), Bytes(9, 'A')), 85);
    invalid(backup(85, 0, Bytes(10), {}), 85);
    std::cout << "TI-82/85 backup VAT parser tests passed\n";
}
