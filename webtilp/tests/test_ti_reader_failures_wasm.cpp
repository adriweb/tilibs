// Link with --wrap=g_free and --wrap=tifiles_content_create_{regular,flash}
// to verify that failed readers consume their root allocation exactly once.
#include "../ti_file_io.h"

#include <emscripten.h>
#include <cassert>
#include <cstdio>
#include <cstring>

namespace {
void* watched_content = nullptr;
unsigned int frees = 0;
bool watch_created_content = false;

void watch(void* content)
{
    watched_content = content;
    frees = 0;
}

void fixture(const char* filename, const char* data)
{
    FILE* file = fopen(filename, "wb");
    assert(file);
    const size_t length = strlen(data);
    assert(fwrite(data, 1, length, file) == length);
    assert(fclose(file) == 0);
}

void regular_failure(const char* filename, CalcModel destination)
{
    FileContent* content = tifiles_content_create_regular(destination);
    assert(content);
    watch(content);
    assert(tifiles_file_read_regular(filename, content) != 0);
    assert(frees == 1);

    watch(nullptr);
    watch_created_content = true;
    int result = 0;
    auto loaded = ti::load_regular(filename, destination, result);
    assert(!loaded && result != 0);
    assert(watched_content && frees == 1);
    watch_created_content = false;
    watch(nullptr);
}

void flash_failure(const char* filename, CalcModel destination)
{
    FlashContent* content = tifiles_content_create_flash(destination);
    assert(content);
    watch(content);
    assert(tifiles_file_read_flash(filename, content) != 0);
    assert(frees == 1);

    watch(nullptr);
    watch_created_content = true;
    int result = 0;
    auto loaded = ti::load_flash(filename, destination, result);
    assert(!loaded && result != 0);
    assert(watched_content && frees == 1);
    watch_created_content = false;
    watch(nullptr);
}
} // namespace

extern "C" {
void __real_g_free(void* memory);
FileContent* __real_tifiles_content_create_regular(CalcModel model);
FlashContent* __real_tifiles_content_create_flash(CalcModel model);

void __wrap_g_free(void* memory)
{
    if (memory && memory == watched_content) ++frees;
    __real_g_free(memory);
}

FileContent* __wrap_tifiles_content_create_regular(CalcModel model)
{
    FileContent* content = __real_tifiles_content_create_regular(model);
    if (watch_created_content) watch(content);
    return content;
}

FlashContent* __wrap_tifiles_content_create_flash(CalcModel model)
{
    FlashContent* content = __real_tifiles_content_create_flash(model);
    if (watch_created_content) watch(content);
    return content;
}

EMSCRIPTEN_KEEPALIVE int test_ti_reader_failures()
{
    fixture("/reader_invalid.82p", "**TI82**");
    fixture("/reader_invalid.89p", "**TI89**");
    fixture("/reader_invalid.8xp2", "invalid checksum and CBOR");
    fixture("/reader_invalid.8xu", "**TIFL**");
    fixture("/reader_invalid.89u", "**TIFL**");
    fixture("/reader_invalid.tco2", "invalid Nspire OS");
    fixture("/reader_invalid.84pk2", "invalid Evo OS package");
    fixture("/reader_invalid.84b2", "invalid Evo ZIP package");
    fixture("/reader_invalid.unknown", "unknown format");
    remove("/reader_missing.tns");
    remove("/reader_missing.8xp2");
    remove("/reader_missing.84pk2");

    for (unsigned int repeat = 0; repeat < 4; ++repeat) {
        regular_failure("/reader_invalid.82p", CALC_TI82);
        regular_failure("/reader_invalid.89p", CALC_TI89);
        regular_failure("/reader_invalid.8xp2", CALC_TI84EVO_USB);
        regular_failure("/reader_missing.8xp2", CALC_TI84EVO_USB);
        // Nspire regular files are opaque to the reader; test an open failure.
        regular_failure("/reader_missing.tns", CALC_NSPIRE);
        regular_failure("/reader_invalid.unknown", CALC_TI82);
        flash_failure("/reader_invalid.8xu", CALC_TI83P);
        flash_failure("/reader_invalid.89u", CALC_TI89);
        flash_failure("/reader_invalid.tco2", CALC_NSPIRE_CXII);
        flash_failure("/reader_invalid.84pk2", CALC_TI84EVO_USB);
        flash_failure("/reader_invalid.84b2", CALC_TI84EVO_USB);
        flash_failure("/reader_missing.84pk2", CALC_TI84EVO_USB);
        flash_failure("/reader_invalid.unknown", CALC_TI82);
    }

    // Invalid arguments do not transfer ownership to the public readers.
    FileContent* regular = tifiles_content_create_regular(CALC_TI84EVO_USB);
    watch(regular);
    assert(tifiles_file_read_regular(nullptr, regular) != 0 && frees == 0);
    tifiles_content_delete_regular(regular);
    assert(frees == 1);
    FlashContent* flash = tifiles_content_create_flash(CALC_TI84EVO_USB);
    watch(flash);
    assert(tifiles_file_read_flash(nullptr, flash) != 0 && frees == 0);
    tifiles_content_delete_flash(flash);
    assert(frees == 1);
    watch(nullptr);
    assert(tifiles_file_read_regular("/reader_invalid.8xp2", nullptr) != 0);
    assert(tifiles_file_read_flash("/reader_invalid.84pk2", nullptr) != 0);
    assert(frees == 0);

    // A successful load retains ownership until the RAII owner is destroyed.
    fixture("/reader_valid.tns", "opaque Nspire document");
    watch_created_content = true;
    {
        int result = -1;
        auto loaded = ti::load_regular("/reader_valid.tns", CALC_NSPIRE, result);
        assert(loaded && result == 0);
        assert(watched_content == loaded.get() && frees == 0);
    }
    assert(frees == 1);
    watch_created_content = false;
    watch(nullptr);

    puts("TI regular/flash reader ownership tests passed");
    return 0;
}
} // extern "C"
