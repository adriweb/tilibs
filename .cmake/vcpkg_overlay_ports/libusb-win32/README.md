# Static libusb-win32

This overlay is based on the libusb-win32 1.4.0.2 port in vcpkg commit
`0c2a9ace1964b818b15f7ae50ba1c42404918a7b`. It retains the upstream source
archive and SHA512, but allows the static-library/static-CRT configuration
used by the Windows presets.

The DLL-only check was added to vcpkg in `f2d75c91c12214d064519d469d081ed04967b29c`.
The public header does not require DLL imports. For a static build, omit the
DLL resource/export files and replace the DLL detach cleanup with a single
`atexit` registration on initialization. Shared builds retain `DllMain`.

The Windows workflow checks the resulting USB-using test executables and the
installed utility for libusb0.dll and shared MSVC CRT imports.
