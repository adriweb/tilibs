/* Visibility helper for internal helpers that the test binaries link against.
   The autotools build compiles the library with -fvisibility=hidden, which
   would otherwise keep these symbols out of the shared library. */

#ifndef __TICABLES_TESTABLE__
#define __TICABLES_TESTABLE__

#if defined(__GNUC__) && !defined(_WIN32)
# define TICABLES_TESTABLE __attribute__ ((visibility("default")))
#else
# define TICABLES_TESTABLE
#endif

#endif
