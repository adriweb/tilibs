#include "../hp_prime_app.h"

#include <stdint.h>

#include <cstdlib>
#include <fstream>
#include <iostream>
#include <iterator>
#include <string>
#include <vector>

namespace {

static void append_u32be(std::vector<uint8_t>* output, uint32_t value)
{
    output->push_back((uint8_t)(value >> 24));
    output->push_back((uint8_t)(value >> 16));
    output->push_back((uint8_t)(value >> 8));
    output->push_back((uint8_t)value);
}

static void append_core(std::vector<uint8_t>* output,
                        const std::vector<uint8_t>& data)
{
    append_u32be(output, (uint32_t)data.size());
    output->insert(output->end(), data.begin(), data.end());
}

static void append_le(std::vector<uint8_t>* output, uint32_t value)
{
    for (unsigned int i = 0; i < 4; i++) output->push_back((uint8_t)(value >> (i * 8)));
}

static void append_record(std::vector<uint8_t>* output, uint32_t id,
                          const std::vector<uint8_t>& payload)
{
    append_le(output, (uint32_t)payload.size() + 4);
    append_le(output, id);
    output->insert(output->end(), payload.begin(), payload.end());
}

static std::vector<uint8_t> serialized_program(const std::vector<uint8_t>& source)
{
    // Repository-authored fixture for the CK editor-state layout, not CK code
    // or Gallery's copyrighted program. USB requires just the source field.
    std::vector<uint8_t> result, fields, units;
    append_le(&result, 0xb28a617c);
    append_le(&result, 0xfffffffe);
    append_le(&result, 0);
    append_record(&result, 0x007fff05, {0, 0, 0, 0});
    append_record(&fields, 0x0040008b, {'M', 0, 'a', 0, 'i', 0, 'n', 0, 0, 0});
    append_record(&fields, 0x00800085, {0, 0, 0, 0});
    append_record(&fields, 0x00c0009b, source);
    append_le(&units, (uint32_t)fields.size());
    units.insert(units.end(), fields.begin(), fields.end());
    append_record(&result, 0x014000be, units);
    return result;
}

static bool check(bool condition, const char* message);
static void append_resource(std::vector<uint8_t>* output,
                            const std::u16string& name,
                            const std::vector<uint8_t>& data);

static bool test_serialized_program()
{
    bool passed = true;
    std::string error;
    const std::vector<uint8_t> text = {'A', 0, ':', 0, '=', 0, '2', 0, ';', 0, 0, 0};
    const auto binary = serialized_program(text);
    const uint8_t* source = nullptr;
    size_t source_size = 0;
    passed &= check(hp_prime_app::program_source(binary.data(), binary.size(),
        &source, &source_size, &error) && source_size == text.size()
        && std::vector<uint8_t>(source, source + source_size) == text,
        "extract source from serialized CK program without treating magic as text");
    passed &= check(hp_prime_app::program_source(text.data(), text.size(),
        &source, &source_size, &error) && source == text.data() && source_size == text.size(),
        "leave received UTF-16LE source unchanged");
    for (size_t length = 4; length < binary.size(); length++) {
        passed &= check(!hp_prime_app::program_source(binary.data(), length,
            &source, &source_size, &error), "reject truncated serialized records");
    }
    auto invalid = binary;
    invalid[4] = 0xff;
    passed &= check(!hp_prime_app::program_source(invalid.data(), invalid.size(),
        &source, &source_size, &error), "reject unsupported serialized version");
    invalid = serialized_program({'A', 0});
    passed &= check(!hp_prime_app::program_source(invalid.data(), invalid.size(),
        &source, &source_size, &error), "reject unterminated serialized source");
    invalid = serialized_program({'A', 0, 0, 0, 'B', 0, 0, 0});
    passed &= check(!hp_prime_app::program_source(invalid.data(), invalid.size(),
        &source, &source_size, &error), "reject embedded source terminator");
    invalid.assign(binary.begin(), binary.begin() + 24);
    append_record(&invalid, 0x0240028e, {});
    passed &= check(hp_prime_app::program_source(invalid.data(), invalid.size(),
        &source, &source_size, &error) && source_size == 0, "recognize an empty built-in editor state");
    append_record(&invalid, 0x00c001be, {1, 2, 3, 4});
    passed &= check(!hp_prime_app::program_source(invalid.data(), invalid.size(),
        &source, &source_size, &error), "never erase a compiled program with missing source");
    invalid = binary;
    invalid.insert(invalid.end(), binary.begin() + 24, binary.end());
    passed &= check(!hp_prime_app::program_source(invalid.data(), invalid.size(),
        &source, &source_size, &error), "reject duplicate source lists");

    std::vector<uint8_t> app, expected, prepared;
    append_core(&app, {1, 2}); append_core(&app, {'N', 0}); append_core(&app, binary);
    append_resource(&app, u"test.png", {9, 8, 7});
    append_core(&expected, {1, 2}); append_core(&expected, {'N', 0}); append_core(&expected, text);
    append_resource(&expected, u"test.png", {9, 8, 7});
    passed &= check(hp_prime_app::prepare_for_send(app.data(), app.size(), "test",
        &prepared, &error) && prepared == expected,
        "replace only the serialized program section, preserving every other byte");
    passed &= check(hp_prime_app::prepare_for_send(expected.data(), expected.size(), "test",
        &prepared, &error) && prepared == expected, "app preparation is idempotent");
    hp_prime_app::Parsed parsed;
    hp_prime_app::parse(expected.data(), expected.size(), "test", &parsed, &error);
    const std::vector<hp_prime_app::ResourceUpdate> updates = {{"test.hpappprgm", binary.data(), binary.size()}};
    passed &= check(hp_prime_app::replace_or_add_resources(expected.data(), expected.size(),
        parsed, updates, &prepared, &error, true) && prepared == app,
        "explicit program replacement updates the core section, not a named resource");
    passed &= check(!hp_prime_app::replace_or_add_resources(expected.data(), expected.size(),
        parsed, updates, &prepared, &error), "resource-only API keeps core update guard");
    passed &= check(!hp_prime_app::replace_or_add_resources(expected.data(), expected.size(),
        parsed, {{"test.hpapp", text.data(), text.size()}}, &prepared, &error, true),
        "descriptor replacement remains forbidden");
    return passed;
}

static void append_resource(std::vector<uint8_t>* output,
                            const std::u16string& name,
                            const std::vector<uint8_t>& data)
{
    append_u32be(output, (uint32_t)(name.size() * 2U + 2U + data.size()));
    for (char16_t value : name) {
        output->push_back((uint8_t)value);
        output->push_back((uint8_t)(value >> 8));
    }
    output->push_back(0);
    output->push_back(0);
    output->insert(output->end(), data.begin(), data.end());
}

static bool check(bool condition, const char* message)
{
    if (!condition) {
        std::cerr << "FAIL: " << message << '\n';
        return false;
    }
    return true;
}

static std::vector<uint8_t> make_fixture()
{
    std::vector<uint8_t> result;
    append_core(&result, {0x10, 0x11, 0x12});
    append_core(&result, {0x20, 0x21});
    append_core(&result, {0x30, 0x31, 0x32, 0x33});
    append_resource(&result, u"icon.png", {0x89, 0x50, 0x4e, 0x47});
    append_resource(&result, u"caf\u00e9.txt", {0x41, 0x42, 0x43});
    return result;
}

} // namespace

int main(int argc, char** argv)
{
    if (argc > 1) {
        std::ifstream input(argv[1], std::ios::binary);
        const std::vector<uint8_t> data(
            (std::istreambuf_iterator<char>(input)),
            std::istreambuf_iterator<char>());
        hp_prime_app::Parsed parsed;
        std::string error;
        if (data.empty() || !hp_prime_app::parse(data.data(), data.size(),
                argc > 2 ? argv[2] : "application", &parsed, &error)) {
            std::cerr << "FAIL: real aggregate: " << error << '\n';
            return EXIT_FAILURE;
        }
        if (parsed.parts.size() > 3) {
            const hp_prime_app::Part& resource = parsed.parts[3];
            std::vector<uint8_t> rebuilt;
            if (!hp_prime_app::replace_or_add_resource(
                    data.data(), data.size(), parsed, resource.name,
                    data.data() + resource.data_offset, resource.data_size,
                    &rebuilt, &error) || rebuilt != data) {
                std::cerr << "FAIL: real aggregate round-trip: "
                          << error << '\n';
                return EXIT_FAILURE;
            }
        }
        std::cout << "Parsed " << data.size() << " bytes into "
                  << parsed.parts.size()
                  << " application parts with exact round-trip\n";
        return EXIT_SUCCESS;
    }
    bool passed = test_serialized_program();
    std::string error;
    const std::vector<uint8_t> fixture = make_fixture();
    hp_prime_app::Parsed parsed;
    passed &= check(hp_prime_app::parse(fixture.data(), fixture.size(),
                                       "sample", &parsed, &error),
                    "parse a complete aggregate");
    passed &= check(parsed.parts.size() == 5,
                    "expose three core parts and two resources");
    passed &= check(parsed.parts[0].name == "sample.hpapp"
                    && parsed.parts[1].name == "sample.hpappnote"
                    && parsed.parts[2].name == "sample.hpappprgm",
                    "name the core application parts");
    passed &= check(parsed.parts[3].name == "icon.png"
                    && parsed.parts[4].name == "caf\xc3\xa9.txt",
                    "decode UTF-16LE resource names");

    const uint8_t* child_data = nullptr;
    size_t child_size = 0;
    passed &= check(hp_prime_app::extract(fixture.data(), fixture.size(),
                                         parsed, 3, &child_data,
                                         &child_size, &error)
                    && child_size == 4 && child_data[0] == 0x89,
                    "extract a child as a zero-copy view");

    std::vector<uint8_t> rebuilt;
    passed &= check(hp_prime_app::replace_or_add_resource(
                        fixture.data(), fixture.size(), parsed, "icon.png",
                        child_data, child_size, &rebuilt, &error)
                    && rebuilt == fixture,
                    "preserve an unchanged aggregate byte-for-byte");

    const std::vector<uint8_t> replacement = {1, 2, 3, 4, 5};
    passed &= check(hp_prime_app::replace_or_add_resource(
                        fixture.data(), fixture.size(), parsed, "new.bin",
                        replacement.data(), replacement.size(),
                        &rebuilt, &error),
                    "append a new resource");
    hp_prime_app::Parsed with_new;
    passed &= check(hp_prime_app::parse(rebuilt.data(), rebuilt.size(),
                                       "sample", &with_new, &error)
                    && with_new.parts.size() == 6
                    && with_new.parts.back().name == "new.bin"
                    && with_new.parts.back().data_size == replacement.size(),
                    "parse the appended resource");
    const std::vector<uint8_t> single_added = rebuilt;

    const std::vector<uint8_t> second = {9, 8};
    const std::vector<hp_prime_app::ResourceUpdate> batch = {
        {"icon.png", replacement.data(), replacement.size()},
        {"second.dat", second.data(), second.size()}
    };
    passed &= check(hp_prime_app::replace_or_add_resources(
                        fixture.data(), fixture.size(), parsed, batch,
                        &rebuilt, &error),
                    "apply multiple resource changes in one rebuild");
    hp_prime_app::Parsed with_batch;
    passed &= check(hp_prime_app::parse(rebuilt.data(), rebuilt.size(),
                                       "sample", &with_batch, &error)
                    && with_batch.parts.size() == 6
                    && with_batch.parts[3].data_size == replacement.size()
                    && with_batch.parts.back().name == "second.dat",
                    "replace and append batched resources");

    std::vector<uint8_t> renamed;
    passed &= check(hp_prime_app::rename_resource(
                        single_added.data(), single_added.size(), with_new, 5,
                        "renamed.bin", &renamed, &error),
                    "rename a resource");
    hp_prime_app::Parsed with_rename;
    passed &= check(hp_prime_app::parse(renamed.data(), renamed.size(),
                                       "sample", &with_rename, &error)
                    && with_rename.parts.back().name == "renamed.bin",
                    "retain renamed resource data");

    std::vector<uint8_t> deleted;
    passed &= check(hp_prime_app::delete_resource(
                        renamed.data(), renamed.size(), with_rename, 5,
                        &deleted, &error)
                    && deleted == fixture,
                    "delete a resource without changing other sections");

    passed &= check(!hp_prime_app::rename_resource(
                        fixture.data(), fixture.size(), parsed, 1,
                        "note.bin", &rebuilt, &error),
                    "keep core application parts read-only");
    passed &= check(!hp_prime_app::rename_resource(
                        fixture.data(), fixture.size(), parsed, 4,
                        "ICON.PNG", &rebuilt, &error),
                    "reject case-insensitive duplicate resource names");

    std::vector<uint8_t> truncated = fixture;
    truncated.pop_back();
    passed &= check(!hp_prime_app::parse(truncated.data(), truncated.size(),
                                        "sample", &parsed, &error),
                    "reject a truncated resource section");

    std::vector<uint8_t> bad_name;
    append_core(&bad_name, {});
    append_core(&bad_name, {});
    append_core(&bad_name, {});
    append_u32be(&bad_name, 4);
    bad_name.insert(bad_name.end(), {0x00, 0xd8, 0x00, 0x00});
    passed &= check(!hp_prime_app::parse(bad_name.data(), bad_name.size(),
                                        "sample", &parsed, &error),
                    "reject an unpaired UTF-16 surrogate");

    if (!passed) {
        return EXIT_FAILURE;
    }
    std::cout << "HP Prime application aggregate tests passed\n";
    return EXIT_SUCCESS;
}
