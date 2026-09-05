/* Runtime checks for the patched dependencies, without connected hardware. */
#include <archive.h>
#include <archive_entry.h>
#include <assert.h>
#include <glib.h>
#include <libusb.h>
#include <stdio.h>
#include <string.h>
#include <zlib.h>

static GMutex mutex;
static int counter;
static int freed_items;

static void count_free(gpointer data)
{
    assert(data);
    ++freed_items;
    g_free(data);
}

static gpointer increment(gpointer unused)
{
    (void)unused;
    for (int i = 0; i < 1000; ++i) {
        g_mutex_lock(&mutex);
        ++counter;
        g_mutex_unlock(&mutex);
    }
    return NULL;
}

int main(void)
{
    const char payload[] = "WebTILP: éà Ω 📟";
    const struct libusb_version *usb = libusb_get_version();
    assert(glib_major_version == GLIB_MAJOR_VERSION);
    assert(glib_minor_version == GLIB_MINOR_VERSION);
    assert(glib_micro_version == GLIB_MICRO_VERSION);
    assert(strcmp(zlibVersion(), ZLIB_VERSION) == 0);
    assert(archive_version_number() == ARCHIVE_VERSION_NUMBER);
    assert(usb->major == 1 && usb->minor == 0 && usb->micro == 30);
    assert(usb->rc && usb->rc[0] == '\0');
    printf("GLib %u.%u.%u; zlib %s; libarchive %s; libusb %u.%u.%u\n",
           glib_major_version, glib_minor_version, glib_micro_version,
           zlibVersion(), archive_version_string(), usb->major, usb->minor, usb->micro);

    gunichar2 *utf16 = g_utf8_to_utf16(payload, -1, NULL, NULL, NULL);
    assert(utf16);
    char *utf8 = g_utf16_to_utf8(utf16, -1, NULL, NULL, NULL);
    assert(utf8 && strcmp(payload, utf8) == 0);
    g_free(utf8);
    g_free(utf16);
    g_mutex_init(&mutex);
    GThread *thread = g_thread_new("dependency-smoke", increment, NULL);
    increment(NULL);
    g_thread_join(thread);
    assert(counter == 2000);
    g_mutex_clear(&mutex);

    GSList *slist = g_slist_append(NULL, g_strdup("one"));
    slist = g_slist_append(slist, g_strdup("two"));
    g_slist_free_full(slist, count_free);
    assert(freed_items == 2);
    GList *list = g_list_append(NULL, g_strdup("three"));
    list = g_list_append(list, g_strdup("four"));
    g_list_free_full(list, count_free);
    assert(freed_items == 4);

    unsigned char compressed[256];
    char restored[256];
    uLongf compressed_size = sizeof compressed;
    uLongf restored_size = sizeof restored;
    assert(compress2(compressed, &compressed_size, (const Bytef *)payload,
                     sizeof payload, Z_BEST_COMPRESSION) == Z_OK);
    assert(uncompress((Bytef *)restored, &restored_size, compressed, compressed_size) == Z_OK);
    assert(restored_size == sizeof payload && memcmp(restored, payload, sizeof payload) == 0);

    char zip[4096];
    size_t zip_size = 0;
    struct archive *writer = archive_write_new();
    assert(writer);
    assert(archive_write_set_format_zip(writer) == ARCHIVE_OK);
    assert(archive_write_set_options(writer, "zip:compression=deflate") == ARCHIVE_OK);
    assert(archive_write_open_memory(writer, zip, sizeof zip, &zip_size) == ARCHIVE_OK);
    struct archive_entry *entry = archive_entry_new();
    assert(entry);
    archive_entry_set_pathname(entry, "sample.txt");
    archive_entry_set_filetype(entry, AE_IFREG);
    archive_entry_set_perm(entry, 0644);
    archive_entry_set_size(entry, sizeof payload);
    assert(archive_write_header(writer, entry) == ARCHIVE_OK);
    assert(archive_write_data(writer, payload, sizeof payload) == sizeof payload);
    archive_entry_free(entry);
    assert(archive_write_close(writer) == ARCHIVE_OK);
    assert(archive_write_free(writer) == ARCHIVE_OK);

    struct archive *reader = archive_read_new();
    assert(reader);
    assert(archive_read_support_format_zip(reader) == ARCHIVE_OK);
    assert(archive_read_open_memory(reader, zip, zip_size) == ARCHIVE_OK);
    assert(archive_read_next_header(reader, &entry) == ARCHIVE_OK);
    assert(strcmp(archive_entry_pathname(entry), "sample.txt") == 0);
    assert(archive_read_data(reader, restored, sizeof restored) == sizeof payload);
    assert(memcmp(restored, payload, sizeof payload) == 0);
    assert(archive_read_next_header(reader, &entry) == ARCHIVE_EOF);
    assert(archive_read_free(reader) == ARCHIVE_OK);
    puts("PASS: Unicode, GLib threads/mutexes and list destructors, zlib compression, and ZIP round-trip");
    return 0;
}
