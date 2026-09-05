/* GTest's g_test_add_func casts a void(void) callback to GTestFixtureFunc.
 * WASM enforces the parameter count, so adapt registration with a correctly
 * typed wrapper while running the original file-format test functions.
 */
#include <glib.h>

template<void (*Test)()>
static void run_test(gpointer, gconstpointer)
{
    Test();
}

#define g_test_add_func(path, test) \
    g_test_add_vtable(path, 0, nullptr, nullptr, run_test<test>, nullptr)
#include "../../libtifiles/trunk/tests/test_evo_files.cc"
