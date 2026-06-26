/* Visibility helper for internal helpers that the test binaries link against.
   The autotools build compiles the library with -fvisibility=hidden, which
   would otherwise keep these symbols out of the shared library. */

#ifndef __TICALCS_TESTABLE__
#define __TICALCS_TESTABLE__

#if defined(__GNUC__) && !defined(_WIN32)
# define TICALCS_TESTABLE __attribute__ ((visibility("default")))
#else
# define TICALCS_TESTABLE
#endif

#endif
