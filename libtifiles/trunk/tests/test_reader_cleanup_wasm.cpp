// Exercise cleanup by public grouping APIs against real libtifiles readers.
// Link with --wrap=tifiles_file_read_{regular,flash} and --wrap=g_free.
#include <tifiles.h>
#include <types83p.h>
#include <glib.h>
#include <emscripten.h>
#include <cassert>
#include <cstdio>
#include <cstring>

extern "C" void __real_g_free(void* memory);

namespace {
struct Allocation {
    void* memory;
    unsigned releases;
};
Allocation allocations[64];
unsigned allocation_count = 0;
unsigned regular_successes = 0, regular_failures = 0;
unsigned flash_successes = 0, flash_failures = 0;
bool observing = false;

void own(void* memory)
{
    if (!memory) return;
    assert(allocation_count < sizeof(allocations) / sizeof(allocations[0]));
    for (unsigned i = 0; i < allocation_count; ++i) {
        assert(allocations[i].memory != memory);
    }
    allocations[allocation_count++] = {memory, 0};
}

void own_entries(FileContent* content)
{
    own(content->entries);
    for (unsigned i = 0; i < content->num_entries; ++i) {
        own(content->entries[i]);
        own(content->entries[i]->data);
    }
}

void own_pages(FlashContent* content)
{
    for (FlashContent* part = content; part; part = part->next) {
        if (part != content) own(part);
        own(part->data_part);
        own(part->pages);
        for (unsigned i = 0; i < part->num_pages; ++i) {
            own(part->pages[i]);
            own(part->pages[i]->data);
        }
    }
}

void begin()
{
    assert(!observing);
    allocation_count = 0;
    regular_successes = regular_failures = flash_successes = flash_failures = 0;
    observing = true;
}

void finish(unsigned regular_ok, unsigned regular_bad,
            unsigned flash_ok = 0, unsigned flash_bad = 0)
{
    observing = false;
    assert(regular_successes == regular_ok && regular_failures == regular_bad);
    assert(flash_successes == flash_ok && flash_failures == flash_bad);
    // Count nested allocations as well as roots: a valid earlier input must
    // be fully destroyed when a later reader fails.
    assert(allocation_count >= regular_ok * 4 + regular_bad + flash_ok * 4 + flash_bad);
    for (unsigned i = 0; i < allocation_count; ++i) {
        if (allocations[i].releases != 1) {
            fprintf(stderr, "Grouping leaked allocation %p (releases: %u)\n",
                    allocations[i].memory, allocations[i].releases);
        }
        assert(allocations[i].releases == 1);
        __real_g_free(allocations[i].memory);
    }
}

void malformed(const char* filename, const char* contents)
{
    FILE* file = fopen(filename, "wb");
    assert(file);
    const size_t length = strlen(contents);
    assert(fwrite(contents, 1, length, file) == length);
    assert(fclose(file) == 0);
}

void valid_regular()
{
    FileContent* content = tifiles_content_create_regular(CALC_TI83P);
    assert(content);
    content->num_entries = 1;
    content->entries = tifiles_ve_create_array(1);
    VarEntry* entry = content->entries[0] = tifiles_ve_create();
    assert(entry);
    strcpy(entry->name, "PROGRAM");
    entry->type = TI83p_PRGM;
    entry->size = 3;
    entry->data = static_cast<uint8_t*>(g_malloc0(entry->size));
    assert(tifiles_file_write_regular("/cleanup_valid.8xp", content, nullptr) == 0);
    tifiles_content_delete_regular(content);
}

void valid_flash()
{
    FlashContent* content = tifiles_content_create_flash(CALC_TI83P);
    assert(content);
    strcpy(content->name, "APP");
    content->data_type = TI83p_APPL;
    content->device_type = DEVICE_TYPE_83P;
    content->num_pages = 1;
    content->pages = tifiles_fp_create_array(1);
    FlashPage* page = content->pages[0] = tifiles_fp_create_alloc_data(3);
    assert(page);
    page->addr = 0x4000;
    memset(page->data, 0, page->size);
    assert(tifiles_file_write_flash("/cleanup_valid.8xk", content) == 0);
    tifiles_content_delete_flash(content);
}

void truncated_flash()
{
    FILE* source = fopen("/cleanup_valid.8xk", "rb");
    FILE* destination = fopen("/cleanup_invalid.8xk", "wb");
    assert(source && destination);
    // Preserve the TIFL header and APP classification, but declare a payload
    // larger than Flash memory. This must fail before any body is parsed.
    unsigned char header[78];
    assert(fread(header, 1, sizeof(header), source) == sizeof(header));
    memset(header + 74, 0xff, 4);
    assert(fwrite(header, 1, sizeof(header), destination) == sizeof(header));
    assert(fclose(source) == 0 && fclose(destination) == 0);
}
} // namespace

extern "C" {
int __real_tifiles_file_read_regular(const char* filename, FileContent* content);
int __real_tifiles_file_read_flash(const char* filename, FlashContent* content);

bool ti_reader_cleanup_observe_free(void* memory)
{
    if (!observing || !memory) return false;
    for (unsigned i = 0; i < allocation_count; ++i) {
        if (allocations[i].memory == memory) {
            ++allocations[i].releases;
            assert(allocations[i].releases == 1);
            // Quarantine until the API returns, so a broken caller's second
            // destruction is detected without dereferencing freed memory or
            // mistaking a reused address for the original allocation.
            return true;
        }
    }
    return false;
}

void __wrap_g_free(void* memory)
{
    if (!ti_reader_cleanup_observe_free(memory)) __real_g_free(memory);
}

int __wrap_tifiles_file_read_regular(const char* filename, FileContent* content)
{
    if (observing) own(content);
    const int result = __real_tifiles_file_read_regular(filename, content);
    if (observing) {
        if (result) ++regular_failures;
        else {
            ++regular_successes;
            own_entries(content);
        }
    }
    return result;
}

int __wrap_tifiles_file_read_flash(const char* filename, FlashContent* content)
{
    if (observing) own(content);
    const int result = __real_tifiles_file_read_flash(filename, content);
    if (observing) {
        if (result) ++flash_failures;
        else {
            ++flash_successes;
            own_pages(content);
        }
    }
    return result;
}

EMSCRIPTEN_KEEPALIVE int test_ti_reader_cleanup()
{
    valid_regular();
    valid_flash();
    truncated_flash();
    malformed("/cleanup_invalid.8xp2", "invalid Evo checksum and CBOR");
    malformed("/cleanup_invalid.84pk2", "invalid Evo OS package");
    assert(tifiles_file_is_regular("/cleanup_invalid.8xp2"));
    assert(tifiles_file_is_flash("/cleanup_invalid.84pk2"));
    assert(tifiles_file_get_class("/cleanup_invalid.8xk") == TIFILE_APP);

    char regular[] = "/cleanup_valid.8xp", flash[] = "/cleanup_valid.8xk";
    char bad_regular[] = "/cleanup_invalid.8xp2", bad_flash[] = "/cleanup_invalid.84pk2";
    char bad_app[] = "/cleanup_invalid.8xk";
    char* regular_only[] = {bad_regular, nullptr};
    char* flash_only[] = {bad_flash, nullptr};
    char* later_regular[] = {regular, bad_regular, nullptr};
    char* mixed_regular[] = {regular, flash, bad_regular, nullptr};
    char* mixed_flash[] = {regular, flash, bad_flash, nullptr};
    char* valid[] = {regular, flash, nullptr};
    char* valid_group[] = {regular, regular, nullptr};

    for (unsigned repeat = 0; repeat < 2; ++repeat) {
        begin();
        assert(tifiles_group_files(regular_only, "/cleanup_group.8xg") != 0);
        finish(0, 1);
        begin();
        assert(tifiles_group_files(later_regular, "/cleanup_group.8xg") != 0);
        finish(1, 1);

        begin();
        assert(tifiles_tigroup_files(regular_only, "/cleanup_output.tig") != 0);
        finish(0, 1);
        begin();
        assert(tifiles_tigroup_files(flash_only, "/cleanup_output.tig") != 0);
        finish(0, 0, 0, 1);
        begin();
        assert(tifiles_tigroup_files(mixed_regular, "/cleanup_output.tig") != 0);
        finish(1, 1, 1, 0);
        begin();
        assert(tifiles_tigroup_files(mixed_flash, "/cleanup_output.tig") != 0);
        finish(1, 0, 1, 1);

        // Adding a bad source to an existing archive must release only the
        // source. The destination does not need to be read on this path.
        assert(tifiles_tigroup_files(valid, "/cleanup_existing.tig") == 0);
        begin();
        assert(tifiles_tigroup_add_file(bad_regular, "/cleanup_existing.tig") != 0);
        finish(0, 1);
        begin();
        // Evo OS files have class TIFILE_OS, so add_file does not invoke their
        // flash reader. A truncated legacy app exercises its flash branch.
        assert(tifiles_tigroup_add_file(bad_app, "/cleanup_existing.tig") != 0);
        finish(0, 0, 0, 1);

        // The same ownership cleanup must also work on successful writes.
        begin();
        assert(tifiles_group_files(valid_group, "/cleanup_group.8xg") == 0);
        finish(2, 0);
        begin();
        assert(tifiles_tigroup_files(valid, "/cleanup_output.tig") == 0);
        finish(1, 0, 1, 0);
    }
    puts("TI grouping reader cleanup tests passed");
    return 0;
}
} // extern "C"

int main()
{
    tifiles_library_init();
    const int result = test_ti_reader_cleanup();
    tifiles_library_exit();
    return result;
}
