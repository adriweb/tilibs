/* Link smoke: force the Emscripten WebHID cable object out of libhpcalcs.a. */

#include <stdlib.h>

#include "hpcables.h"

int main(void) {
    cable_handle *handle;
    int result = hpcables_init(NULL);
    if (result != 0) {
        return EXIT_FAILURE;
    }
    handle = hpcables_handle_new(CABLE_PRIME_HID);
    if (handle == NULL) {
        hpcables_exit();
        return EXIT_FAILURE;
    }
    /* Do not open here: the smoke is also runnable without browser hardware. */
    hpcables_handle_del(handle);
    hpcables_exit();
    return EXIT_SUCCESS;
}
