// Real WebTiLP bridge + libtifiles + libticalcs, with a scripted legacy cable.
#include "../webtilp.cpp"
#include <cassert>
#include <deque>

namespace {
std::deque<uint8_t> replies;
std::vector<uint8_t> sent;
int mock_send(CableHandle *, uint8_t *data, uint32_t size) {
    assert(size); sent.insert(sent.end(), data, data + size); return 0;
}
int mock_recv(CableHandle *, uint8_t *data, uint32_t size) {
    if (replies.size() < size) return TICABLES_ERR_READ_TIMEOUT;
    while (size--) { *data++ = replies.front(); replies.pop_front(); }
    return 0;
}
}
extern "C" EMSCRIPTEN_KEEPALIVE int test_ti86_os_transfer() {
    g_calc_model = CALC_TI86;
    g_cable_handle = ticables_handle_new(CABLE_NUL, PORT_1);
    assert(g_cable_handle);
    CableFncts *original = g_cable_handle->cable;
    CableFncts mock = *original;
    mock.send = mock_send; mock.recv = mock_recv;
    g_cable_handle->cable = &mock;
    g_calc_handle = ticalcs_handle_new(CALC_TI86);
    assert(!ticalcs_cable_attach(g_calc_handle, g_cable_handle));
    g_calc_attached = 1; g_calc_ready = 0; // No ordinary ready command in OS mode.
    const std::string extensions = get_file_extensions(CALC_TI86);
    assert(extensions.find("86u") != std::string::npos);
    assert(!strcmp(get_flash_os_ext(CALC_TI86), "86u"));
    auto *c = tifiles_content_create_flash(CALC_TI86);
    c->revision_major = c->flags = 1; c->object_type = 0x88;
    strcpy(c->name, "1.1003"); c->device_type = DEVICE_TYPE_86; c->data_type = TI86_AMS;
    c->data_length = 0x40000; c->num_pages = 16;
    c->pages = static_cast<FlashPage **>(g_malloc0(16 * sizeof(FlashPage *)));
    for (unsigned i = 0; i < 16; ++i) {
        auto *p = c->pages[i] = static_cast<FlashPage *>(g_malloc0(sizeof(FlashPage)));
        p->addr = p->size = 0x4000; p->page = i; p->flag = 0x80;
        p->data = static_cast<uint8_t *>(g_malloc(0x4000));
        for (unsigned j = 0; j < 0x4000; ++j) p->data[j] = i * 13 + j * 37;
    }
    assert(!tifiles_file_write_flash("/target.86u", c));
    const char *metadata = file_get_entries_json("/target.86u");
    assert(strstr(metadata, "\"class\":\"os\"") && strstr(metadata, "1.1003"));
    for (unsigned i = 0; i < 1026; ++i)
        for (uint8_t b : {0x85, 0x56, 10, 0, 0x85, 9, 10, 0, 0x85, 0x56, 0, 1}) replies.push_back(b);
    assert(!send_file_custom(g_cable_handle, "/target.86u", "", -1, 0));
    assert(replies.empty() && sent.size() == 289332);
    for (unsigned i = 0; i < 1026; ++i) {
        const auto *b = sent.data() + i * 282;
        assert(b[0] == 5 && b[1] == 6 && b[2] == 10 && b[3] == 0 && b[8] == 0x16);
        assert(!memcmp(b + 16, "\5\126\0\0\5\25\0\1", 8));
        if (i < 1024) assert(!memcmp(b + 24, c->pages[i / 64]->data + (i % 64)*256, 256));
    }
    sent.clear();
    // A file that is still classified as an OS must be rejected before cable
    // traffic when its declared payload length is wrong.
    FILE *f = fopen("/target.86u", "r+b"); assert(f);
    assert(!fseek(f, 74, SEEK_SET)); fputc(0, f); fclose(f);
    assert(strstr(file_get_entries_json("/target.86u"), "\"entries\":[]"));
    assert(send_file_custom(g_cable_handle, "/target.86u", "", -1, 0) != 0);
    assert(sent.empty());
    tifiles_content_delete_flash(c);
    ticalcs_cable_detach(g_calc_handle); ticalcs_handle_del(g_calc_handle);
    g_calc_handle = nullptr; g_calc_attached = g_calc_ready = 0;
    g_cable_handle->cable = original; ticables_handle_del(g_cable_handle); g_cable_handle = nullptr;
    remove("/target.86u");
    puts("WebTiLP WASM: .86u picker, strict parser, OS dispatch and all 1026 native records passed");
    return 0;
}
