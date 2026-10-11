#include "ti_session.h"
#include "webtilp_json.h"
#include <cstring>
#include <string>
#include <unistd.h>
#include <emscripten.h>
#include <libusb.h>
#include <glib.h>
#include <ticonv.h>

extern "C" int hp_prime_library_init(void);
extern "C" int hp_prime_library_exit(void);
extern "C" int casio_library_init(void);
extern "C" int casio_library_exit(void);

namespace ti {
namespace {
struct SessionState {
    CableModel cable_model = CABLE_USB;
    CalcModel calc_model = CALC_NONE;
    CalcHandle* calc_handle = nullptr;
    int calc_attached = 0;
    int calc_ready = 0;
    unsigned int evo_python_type = 0;
    CableHandle* cable_handle = nullptr;
    int force_cable = 0;
    int force_calc = 0;
    int cable_timeout = 50;
    int cable_delay = 10;
    int cable_reopen_needed = 0;
    CalcModel last_model_from = CALC_NONE;
    CalcModel last_model_to = CALC_NONE;
    int model_update_pending = 0;
    CalcUpdate update{};
    int update_ready = 0;
    volatile uint32_t progress_tick = 0;
    char native_warnings[2048]{};
    int log_handlers_installed = 0;
};
SessionState state;
} // namespace

static void append_native_warning(const char* domain, const char* message)
{
    (void)domain;
    if (!message || !*message) {
        return;
    }

    char line[512];
    snprintf(line, sizeof(line), "%s", message);

    if (strstr(state.native_warnings, line) != nullptr) {
        return;
    }

    const size_t used = strlen(state.native_warnings);
    const size_t avail = sizeof(state.native_warnings) - used;
    if (avail <= 1) {
        return;
    }
    snprintf(state.native_warnings + used, avail, "%s%s", used ? "\n" : "", line);
}

static void webtilp_log_handler(const gchar* log_domain, GLogLevelFlags log_level, const gchar* message, gpointer user_data)
{
    if ((log_level & G_LOG_LEVEL_WARNING) != 0) {
        append_native_warning(log_domain, message);
    }
    g_log_default_handler(log_domain, log_level, message, user_data);
}

static void install_log_handlers(void)
{
    if (state.log_handlers_installed) {
        return;
    }
    g_log_set_handler("ticables", G_LOG_LEVEL_WARNING, webtilp_log_handler, nullptr);
    g_log_set_handler("ticalcs", G_LOG_LEVEL_WARNING, webtilp_log_handler, nullptr);
    g_log_set_handler("tifiles", G_LOG_LEVEL_WARNING, webtilp_log_handler, nullptr);
    state.log_handlers_installed = 1;
}


static void ensure_update_callbacks();
static inline unsigned int evo_python_type_for_os(const char *version)
{
    if (!version) return 0;
    unsigned int parts[4] = {};
    for (unsigned int i = 0; i < 4; i++) {
        if (*version < '0' || *version > '9') return 0;
        while (*version >= '0' && *version <= '9') {
            parts[i] = parts[i] * 10 + (*version++ - '0');
            if (parts[i] > 65535) return 0;
        }
        if (i < 3 && *version++ != '.') return 0;
    }
    if (*version || parts[0] < 7) return 0;
    return parts[0] == 7 && parts[1] == 0 ? WEBTILP_EVO_TYPE_PYTHON_SCRIPT : WEBTILP_EVO_TYPE_PYTHON_MODULE;
}

static void reset_calc_handle_state(void)
{
    state.evo_python_type = 0;
    if (state.calc_handle) {
        if (state.calc_attached) {
            ticalcs_cable_detach(state.calc_handle);
        }
        ticalcs_handle_del(state.calc_handle);
    }
    state.calc_handle = nullptr;
    state.calc_attached = 0;
    state.calc_ready = 0;
}

static void update_calc_model_from_infos(const CalcInfos* infos)
{
    if (!infos || state.force_calc) {
        return;
    }
    CalcModel desired_model = infos->model;
    if (state.cable_model == CABLE_USB) {
        desired_model = ticalcs_remap_model_to_usb(state.cable_model, desired_model);
    } else {
        desired_model = ticalcs_remap_model_from_usb(state.cable_model, desired_model);
    }
    if (desired_model == CALC_NONE || desired_model == state.calc_model) {
        return;
    }
    printf("Updating calculator model from %s to %s based on device info\n",
           ticalcs_model_to_string(state.calc_model),
           ticalcs_model_to_string(desired_model));
    state.last_model_from = state.calc_model;
    state.last_model_to = desired_model;
    state.model_update_pending = 1;
    state.calc_model = desired_model;
    if (state.cable_model == CABLE_USB && !ticonv_model_is_tinspire(desired_model)) {
        const int was_attached = state.calc_attached;
        reset_calc_handle_state();
        if (was_attached) {
            state.cable_reopen_needed = 1;
        }
    }
}

static void update_progress_tick(void)
{
    __atomic_fetch_add(&state.progress_tick, 1, __ATOMIC_RELAXED);
    EM_ASM({
        if (Module.__progressTick) {
            Module.__progressTick();
        }
    });
}

static void ensure_update_callbacks(void)
{
    if (state.update_ready) {
        return;
    }
    memset(&state.update, 0, sizeof(state.update));
    state.update.start = update_progress_tick;
    state.update.stop = update_progress_tick;
    state.update.refresh = update_progress_tick;
    state.update.pbar = update_progress_tick;
    state.update.label = update_progress_tick;
    state.update_ready = 1;
}

static int found_port(const int *ports)
{
    for(int i = PORT_1; i <= PORT_4; i++)
        if(ports[i])
            return i;

    return 0;
}

static CablePort find_silverlink_port()
{
    int *list = nullptr;
    int len = 0;
    CablePort port = (CablePort)0;

    if (ticables_get_usb_devices(&list, &len) != 0 || !list) {
        return (CablePort)0;
    }

    for (int i = 0; i < len; i++) {
        if (list[i] == PID_TIGLUSB) {
            port = (CablePort)(i + 1);
            break;
        }
    }

    ticables_free_usb_devices(list);
    return port;
}

int tilp_device_probe_usb(CalcModel* calc_model, int probe_calc)
{
    int ret = -1;
    int **cables = nullptr;
    CableHandle* handle;
    CablePort port = (CablePort)0;

    printf("Searching for link cables...");
    const CablePort slv_port = find_silverlink_port();
    if (slv_port) {
        printf("Detected SilverLink on #%d\n", slv_port);
        state.cable_model = CABLE_SLV;
        if (!probe_calc) {
            return 0;
        }
        printf("SilverLink detected; manual calculator model selection required\n");
        return -1;
    }

    int err = ticables_probing_do(&cables, 5, (ProbingMethod)(PROBE_USB | PROBE_FIRST));
    if(err)
    {
        printf("error ticables_probing_do...\n");
        ticables_probing_finish(&cables);
        return -1;
    }

    port = (CablePort)found_port(cables[CABLE_USB]);
    if (port) {
        printf("Searching for handhelds on DirectLink...\n");
        state.cable_model = CABLE_USB;

        if (!probe_calc) {
            ret = 0;
            goto step3;
        }

        handle = ticables_handle_new(CABLE_USB, port);
        ticables_options_set_timeout(handle, 10);

        err = ticables_cable_open(handle);
        if (err) {
            printf("error ticables_cable_open...\n");
            ticables_handle_del(handle);
            goto step2;
        }

        err = ticalcs_probe_usb_calc(handle, calc_model);
        if (err) {
            printf("error ticalcs_probe_usb_calc...\n");
            ticables_cable_close(handle);
            ticables_handle_del(handle);
            goto step2;
        }

        ticables_cable_close(handle);
        ticables_handle_del(handle);

        ret = 0;
        goto step3;
    }

step2:
    port = (CablePort)found_port(cables[CABLE_SLV]);
    if (port) {
        printf("Searching for handhelds on SilverLink...\n");
        state.cable_model = CABLE_SLV;
        if (!probe_calc) {
            ret = 0;
            goto step3;
        }
        printf("SilverLink detected; manual calculator model selection required\n");
        ret = -1;
        goto step3;
    }

step3:
    ticables_probing_finish(&cables);
    return ret;
}

int ensure_calc_handle_attached(CableHandle* cable_handle)
{
    if (!cable_handle) {
        printf("ERROR: NULL cable handle provided\n");
        return -1;
    }

    if (state.force_calc && state.calc_model == CALC_NONE) {
        printf("ERROR: Forced calc model is not set\n");
        return -2;
    }

    if (state.calc_model == CALC_NONE && !state.force_calc) {
        if (state.force_cable && (state.cable_model == CABLE_SLV || state.cable_model == CABLE_GRY)) {
            printf("ERROR: %s requires manual calculator model selection\n",
                   state.cable_model == CABLE_GRY ? "GrayLink" : "SilverLink");
            return -2;
        }
        printf("Calculator model unknown, probing...\n");
        if (state.force_cable) {
            const int err = ticalcs_probe_usb_calc(cable_handle, &state.calc_model);
            if (err || state.calc_model == CALC_NONE) {
                printf("ERROR: Failed to probe calculator model\n");
                return -2;
            }
        } else {
            if (tilp_device_probe_usb(&state.calc_model, 1) != 0 || state.calc_model == CALC_NONE) {
                printf("ERROR: Failed to probe calculator model\n");
                return -2;
            }
        }
    }

    if (!state.calc_handle) {
        state.calc_handle = ticalcs_handle_new(state.calc_model);
        if (!state.calc_handle) {
            printf("ERROR: Failed to create calc handle\n");
            return -3;
        }
        ensure_update_callbacks();
        ticalcs_update_set(state.calc_handle, &state.update);
    }

    if (!state.calc_attached) {
        ticables_cable_close(cable_handle);
        const int attach_result = ticalcs_cable_attach(state.calc_handle, cable_handle);
        if (attach_result != 0) {
            printf("ERROR: Failed to attach cable (error %d)\n", attach_result);
            return attach_result;
        }
        state.calc_attached = 1;
        state.calc_ready = 0;
    }

    return 0;
}

int ensure_calc_ready(CableHandle* cable_handle, int force)
{
    const int attach_result = ensure_calc_handle_attached(cable_handle);
    if (attach_result != 0) {
        return attach_result;
    }

    if (!state.calc_ready || force) {
        usleep(100000);
        int ready_result = ticalcs_calc_isready(state.calc_handle);
        int retries = 0;
        while ((ready_result == TICALCS_ERR_BUSY
            || ready_result == TICALCS_ERR_NOT_READY
            || ready_result == TICABLES_ERR_READ_ERROR
            || ready_result == TICABLES_ERR_READ_TIMEOUT
            || ready_result == TICABLES_ERR_WRITE_ERROR
            || ready_result == TICABLES_ERR_WRITE_TIMEOUT) && retries < 4) {
            printf("Calculator busy or link error, retrying...\n");
            usleep(100000);
            emscripten_sleep(100);
            ready_result = ticalcs_calc_isready(state.calc_handle);
            retries++;
        }
        if (ready_result != 0) {
            printf("ERROR: Calculator not ready (error %d)\n", ready_result);
            state.calc_ready = 0;
            return ready_result;
        }
        usleep(100000);
        state.calc_ready = 1;
    }

    return 0;
}

uint32_t* get_progress_tick_ptr(void) {
    return (uint32_t*)&state.progress_tick;
}

uint32_t get_progress_tick_value(void) {
    return state.progress_tick;
}

void reset_progress_info(void) {
    ensure_update_callbacks();
    state.update.text[0] = '\0';
    state.update.rate = 0.0f;
    state.update.cnt1 = 0;
    state.update.max1 = 0;
    state.update.cnt2 = 0;
    state.update.max2 = 0;
    state.update.cnt3 = 0;
    state.update.max3 = 0;
    if (state.calc_handle && state.calc_handle->cable) {
        ticables_progress_reset(state.calc_handle->cable);
    }
}

const char* get_progress_info_json(void) {
    static std::string result;
    char counts[128];
    if (!state.calc_handle || !state.calc_handle->updat) {
        return "";
    }

    const CalcUpdate* up = state.calc_handle->updat;
    int cnt = 0;
    int max = 0;
    if (up->max3 > 0) {
        cnt = up->cnt3;
        max = up->max3;
    } else if (up->max2 > 0) {
        cnt = up->cnt2;
        max = up->max2;
    } else if (up->max1 > 0) {
        cnt = up->cnt1;
        max = up->max1;
    }

    const std::string text = webtilp_json::escape_bounded(up->text, sizeof(up->text));
    snprintf(counts, sizeof(counts), R"({"cnt":%d,"max":%d,"rate":%.6f,"text":")",
             cnt, max, (double)up->rate);
    result = std::string(counts) + text + "\"}";
    return result.c_str();
}

int init() {
    printf("Initializing tilibs...\n");
    install_log_handlers();
    int result = ticables_library_init();
    printf("ticables_library_init: %d\n", result);
    result = tifiles_library_init();
    printf("tifiles_library_init: %d\n", result);
    result = ticalcs_library_init();
    printf("ticalcs_library_init: %d\n", result);
    const int hp_result = hp_prime_library_init();
    printf("hp_prime_library_init: %d\n", hp_result);
    if (hp_result != 0) {
        fprintf(stderr, "HP Prime support initialization failed (%d); continuing with TI support.\n",
                hp_result);
    }
    const int casio_result = casio_library_init();
    printf("casio_library_init: %d\n", casio_result);
    if (casio_result != 0) {
        fprintf(stderr, "Casio support initialization failed (%d); continuing with other families.\n",
                casio_result);
    }

    printf("tilibs init done!\n");

    return result;
}

void clear_native_warnings(void) {
    state.native_warnings[0] = '\0';
}

const char* get_native_warnings(void) {
    return state.native_warnings;
}

const char* get_version() {
    printf("ticables_version_get()...\n");
    const char* version = ticables_version_get();
    printf("Version: %s\n", version);
    return version;
}

void set_cable_model(int model) {
    state.cable_model = (CableModel)model;
    reset_calc_handle_state();
}

void set_calc_model(int model) {
    state.calc_model = (CalcModel)model;
    reset_calc_handle_state();
}

const char* get_calc_model_string(void) {
    return ticalcs_model_to_string(state.calc_model);
}

int get_calc_model_id(void) {
    return (int)state.calc_model;
}

int consume_cable_reopen_flag(void) {
    const int value = state.cable_reopen_needed;
    state.cable_reopen_needed = 0;
    return value;
}

const char* consume_model_update_info(void) {
    static char buf[160];
    if (!state.model_update_pending) {
        return "";
    }
    state.model_update_pending = 0;
    snprintf(buf, sizeof(buf),
             R"({"from":%d,"to":%d,"fromName":"%s","toName":"%s"})",
             state.last_model_from,
             state.last_model_to,
             ticalcs_model_to_string(state.last_model_from),
             ticalcs_model_to_string(state.last_model_to));
    return buf;
}

void notify_usb_disconnect(void) {
    reset_calc_handle_state();
    if (state.cable_handle) {
        ticables_cable_close(state.cable_handle);
        ticables_handle_del(state.cable_handle);
        state.cable_handle = nullptr;
    }
    state.cable_reopen_needed = 0;
}

void set_force_cable(int force) {
    state.force_cable = force ? 1 : 0;
}

void set_force_calc(int force) {
    state.force_calc = force ? 1 : 0;
}

void set_cable_timeout(int timeout) {
    if (timeout > 0) {
        state.cable_timeout = timeout;
        if (state.cable_handle) {
            ticables_options_set_timeout(state.cable_handle, state.cable_timeout);
        }
    }
}

void set_cable_delay(int delay) {
    if (delay >= 0) {
        state.cable_delay = delay;
        if (state.cable_handle) {
            ticables_options_set_delay(state.cable_handle, state.cable_delay);
        }
    }
}

int check_webusb_support() {
    printf("cable support for CABLE_USB (WebUSB backend)...\n");
    const uint64_t supported = ticables_supported_cables();
    const int usb_supported = (supported & (1ULL << CABLE_USB)) != 0;
    printf("USB supported: %d\n", usb_supported);
    return usb_supported;
}

CableHandle* create_handle() {
    printf("ticables_handle_new()...\n");
    if (state.cable_handle) {
        ticables_options_set_timeout(state.cable_handle, state.cable_timeout);
        ticables_options_set_delay(state.cable_handle, state.cable_delay);
        printf("Reusing existing cable handle: %p\n", (void*)state.cable_handle);
        return state.cable_handle;
    }
    if (!state.force_cable) {
        tilp_device_probe_usb(nullptr, 0);
    }
    if (state.calc_model == CALC_NONE && !state.force_calc) {
        tilp_device_probe_usb(&state.calc_model, 1);
    }
    state.cable_handle = ticables_handle_new(state.cable_model, PORT_1);
    printf("Handle created: %p\n", (void*)state.cable_handle);

    ticables_options_set_timeout(state.cable_handle, state.cable_timeout);
    ticables_options_set_delay(state.cable_handle, state.cable_delay);
    ticables_handle_show(state.cable_handle);

    return state.cable_handle;
}

int open_cable(CableHandle* handle) {
    if (!handle) {
        printf("ERROR: NULL handle provided\n");
        return -1;
    }
    printf("ticables_cable_open()...\n");

    // First, try to enumerate libusb devices to see what we have
    printf("DEBUG: Enumerating libusb devices...\n");
    libusb_context *ctx = nullptr;
    libusb_device **devs;
    const ssize_t cnt = libusb_get_device_list(ctx, &devs);
    printf("DEBUG: Found %d libusb devices\n", (int)cnt);
    if (cnt > 0) {
        for (int i = 0; i < cnt; i++) {
            libusb_device_descriptor desc{};
            const int r = libusb_get_device_descriptor(devs[i], &desc);
            if (r == 0) {
                printf("DEBUG: Device %d: VID=%04x PID=%04x\n", i, desc.idVendor, desc.idProduct);
            }
        }
        libusb_free_device_list(devs, 1);
    }

    const int result = ticables_cable_open(handle);
    printf("Open result: %d\n", result);
    return result;
}

int check_cable(CableHandle* handle) {
    if (!handle) {
        printf("ERROR: NULL handle provided\n");
        return -1;
    }
    printf("ticables_cable_check()...\n");
    CableStatus status;
    const int result = ticables_cable_check(handle, &status);
    printf("Check result: %d, status: %d\n", result, status);
    return result;
}

int is_ready(CableHandle* cable_handle) {
    if (!cable_handle) {
        printf("ERROR: NULL cable handle provided\n");
        return -1;
    }

    printf("=== Testing Calculator IsReady ===\n");
    printf("is_ready()...\n");
    const int ready_result = ensure_calc_ready(cable_handle, 1);
    printf("Send result: %d\n", ready_result);
    return ready_result;
}

int send_probe(CableHandle* handle) {
    if (!handle) {
        printf("ERROR: NULL handle provided\n");
        return -1;
    }
    printf("ticables_cable_send()...\n");
    uint8_t probe_data[] = {0x08, 0x68, 0x00, 0x00};
    const int result = ticables_cable_send(handle, probe_data, sizeof(probe_data));
    printf("Send result: %d\n", result);
    return result;
}

int receive_data(CableHandle* handle) {
    if (!handle) {
        printf("ERROR: NULL handle provided\n");
        return -1;
    }
    printf("ticables_cable_recv()...\n");
    uint8_t buffer[256];
    const int result = ticables_cable_recv(handle, buffer, sizeof(buffer));
    printf("Recv result: %d\n", result);
    if (result > 0) {
        printf("Received %d bytes\n", result);
    }
    return result;
}

int close_cable(CableHandle* handle) {
    state.evo_python_type = 0;
    if (!handle) {
        printf("ERROR: NULL handle provided\n");
        return -1;
    }
    printf("ticables_cable_close()...\n");
    if (state.calc_handle && state.calc_attached) {
        ticalcs_cable_detach(state.calc_handle);
        state.calc_attached = 0;
        state.calc_ready = 0;
    }
    const int result = ticables_cable_close(handle);
    printf("Close result: %d\n", result);
    return result;
}

int cleanup() {
    state.evo_python_type = 0;
    printf("library exits...\n");
    const int result_casio = casio_library_exit();
    const int result_hp = hp_prime_library_exit();
    if (state.calc_handle) {
        if (state.calc_attached) {
            ticalcs_cable_detach(state.calc_handle);
            state.calc_attached = 0;
            state.calc_ready = 0;
        }
        ticalcs_handle_del(state.calc_handle);
        state.calc_handle = nullptr;
    }
    if (state.cable_handle) {
        ticables_handle_del(state.cable_handle);
        state.cable_handle = nullptr;
    }
    state.calc_model = CALC_NONE;
    state.cable_model = CABLE_USB;
    state.force_cable = 0;
    state.force_calc = 0;
    const int result_tifiles = tifiles_library_exit();
    const int result_ticalcs = ticalcs_library_exit();
    const int result_ticables = ticables_library_exit();
    printf("tifiles_library_exit: %d\n", result_tifiles);
    printf("ticalcs_library_exit: %d\n", result_ticalcs);
    printf("ticables_library_exit: %d\n", result_ticables);
    printf("hp_prime_library_exit: %d\n", result_hp);
    printf("casio_library_exit: %d\n", result_casio);
    if (result_casio != 0) {
        return result_casio;
    }
    if (result_hp != 0) {
        return result_hp;
    }
    if (result_ticables != 0) {
        return result_ticables;
    }
    if (result_ticalcs != 0) {
        return result_ticalcs;
    }
    return result_tifiles;
}

int get_device_info(CableHandle* handle) {
    if (!handle) {
        printf("ERROR: NULL handle provided\n");
        return -1;
    }
    printf("ticables_cable_get_device_info()...\n");
    CableDeviceInfo info;
    const int result = ticables_cable_get_device_info(handle, &info);
    if (result == 0) {
        printf("Device info: family=%d, variant=%d\n", info.family, info.variant);
    }
    return result;
}

const char* calc_get_info_string(CableHandle* cable_handle) {
    state.evo_python_type = 0;
    if (!cable_handle) {
        printf("ERROR: NULL cable handle provided\n");
        return "";
    }

    const int ready_result = ensure_calc_ready(cable_handle, 0);
    if (ready_result != 0) {
        return "";
    }

    static char info_buf[4096];
    CalcInfos infos{};

    const int result = ticalcs_calc_get_version(state.calc_handle, &infos);
    if (result != 0) {
        printf("ERROR: Failed to get calc infos (error %d)\n", result);
        if (state.cable_model == CABLE_SLV || state.cable_model == CABLE_GRY) {
            printf("Resetting legacy cable session after failed optional device info query\n");
            reset_calc_handle_state();
            state.cable_reopen_needed = 1;
        }
        return "";
    }

    if (ticalcs_infos_to_string(&infos, info_buf, sizeof(info_buf)) != 0) {
        return "";
    }

    update_calc_model_from_infos(&infos);
    if (ticonv_model_is_tievo(state.calc_model) && (infos.mask & INFOS_OS_VERSION)) {
        state.evo_python_type = evo_python_type_for_os(infos.os_version);
    }
    return info_buf;
}
CalcModel current_model() { return state.calc_model; }
CalcHandle* calculator() { return state.calc_handle; }
CableModel current_cable_model() { return state.cable_model; }
unsigned int evo_python_type() { return state.evo_python_type; }
bool is_attached_owned_cable(CableHandle* cable) {
    return state.calc_handle && state.calc_attached && cable == state.cable_handle;
}

} // namespace ti
