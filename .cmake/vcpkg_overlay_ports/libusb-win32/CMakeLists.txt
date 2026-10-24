cmake_minimum_required(VERSION 3.5)
project(libusb-win32 LANGUAGES C)

set(lib_headers src/lusb0_usb.h)

set(lib_srcs src/descriptors.c
             src/error.c
             src/install.c
             src/registry.c
             src/usb.c
             src/windows.c)

add_library(libusb0 ${lib_srcs})
target_include_directories(libusb0 PRIVATE "src/driver")
if(BUILD_SHARED_LIBS)
    target_sources(libusb0 PRIVATE src/resource.rc libusb0.def)
else()
    target_compile_definitions(libusb0 PRIVATE LIBUSB_STATIC)
endif()
target_link_libraries(libusb0 setupapi cfgmgr32)
target_compile_definitions(libusb0 PRIVATE LOG_APPNAME="libusb-dll")
set_target_properties(libusb0 PROPERTIES PREFIX "" IMPORT_PREFIX "")

install(
    TARGETS libusb0
    RUNTIME DESTINATION bin
    ARCHIVE DESTINATION lib
    LIBRARY DESTINATION lib)

install(
    FILES ${lib_headers}
    DESTINATION include)
