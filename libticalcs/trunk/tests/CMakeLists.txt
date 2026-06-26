cmake_minimum_required(VERSION 3.12)

project(libticalcs2-tests
        LANGUAGES   CXX)

add_executable(torture_ticalcs torture_ticalcs.cc)
add_executable(test_evo_errors test_evo_errors.cc)
add_executable(test_evo_protocol test_evo_protocol.cc)
if(NOT WIN32) # not compatible for now
    add_executable(test_ticalcs_2 test_ticalcs_2.cc)
endif()

# external deps lookup
if(WIN32)
    find_library(LIBUSB0 NAMES libusb0.lib usb0 REQUIRED)
    target_link_libraries(torture_ticalcs PRIVATE ${LIBUSB0})
    target_link_libraries(test_evo_errors PRIVATE ${LIBUSB0})
    target_link_libraries(test_evo_protocol PRIVATE ${LIBUSB0})
else()
    pkg_check_modules(libusb REQUIRED IMPORTED_TARGET libusb-1.0>=1.0.16)
    target_link_libraries(torture_ticalcs PRIVATE PkgConfig::libusb)
    target_link_libraries(test_evo_errors PRIVATE PkgConfig::libusb)
    target_link_libraries(test_evo_protocol PRIVATE PkgConfig::libusb)
    target_link_libraries(test_ticalcs_2 PRIVATE PkgConfig::libusb)
endif()
pkg_check_modules(glib REQUIRED IMPORTED_TARGET glib-2.0)
pkg_check_modules(LibArchive REQUIRED IMPORTED_TARGET libarchive)
if(NOT EMSCRIPTEN)
    find_package(ZLIB REQUIRED) # for libtifiles
    target_link_libraries(torture_ticalcs PRIVATE ZLIB::ZLIB PkgConfig::glib PkgConfig::LibArchive)
    target_link_libraries(test_evo_errors PRIVATE ZLIB::ZLIB PkgConfig::glib PkgConfig::LibArchive)
    target_link_libraries(test_evo_protocol PRIVATE ZLIB::ZLIB PkgConfig::glib PkgConfig::LibArchive)
    if(NOT WIN32) # not compatible for now
        target_link_libraries(test_ticalcs_2 PRIVATE ZLIB::ZLIB PkgConfig::glib PkgConfig::LibArchive)
    endif()
else()
    set(ZLIB_FOUND TRUE)
    target_link_libraries(torture_ticalcs PRIVATE PkgConfig::glib)
    target_link_libraries(test_evo_errors PRIVATE PkgConfig::glib)
    target_link_libraries(test_evo_protocol PRIVATE PkgConfig::glib)
    target_link_libraries(test_ticalcs_2 PRIVATE PkgConfig::glib)
endif()

if(WIN32 AND NOT MINGW)
    find_library(GETOPT_LIB getopt REQUIRED)
endif()

if(USE_ICONV)
    find_package(Iconv REQUIRED)
    add_compile_definitions(USE_ICONV)
endif()

foreach(tar torture_ticalcs test_evo_errors test_evo_protocol test_ticalcs_2)
    if(tar STREQUAL test_ticalcs_2 AND WIN32)
        continue() # not compatible for now
    endif ()

    if(Iconv_FOUND AND NOT Iconv_IS_BUILT_IN)
        target_include_directories(${tar} PRIVATE ${Iconv_INCLUDE_DIRS})
        target_link_libraries(${tar} PRIVATE ${Iconv_LIBRARIES})
    endif()

    if(GETOPT_LIB)
        target_link_libraries(${tar} PRIVATE ${GETOPT_LIB})
    endif()

    target_include_directories(${tar} PRIVATE
        ${PROJECT_SOURCE_DIR}/../../../libticonv/trunk/src
        ${PROJECT_SOURCE_DIR}/../../../libtifiles/trunk/src
        ${PROJECT_SOURCE_DIR}/../../../libticables/trunk/src
        ${PROJECT_SOURCE_DIR}/../src)

    target_link_directories(${tar} PRIVATE ${PROJECT_BINARY_DIR}/..)
    target_link_libraries(${tar} PRIVATE ticonv tifiles2 ticables2 ticalcs2)
endforeach()

add_custom_target(ticalcs2_check
    COMMAND "$<TARGET_FILE:torture_ticalcs>"
    COMMAND "$<TARGET_FILE:test_evo_errors>"
    COMMAND "$<TARGET_FILE:test_evo_protocol>"
    DEPENDS torture_ticalcs test_evo_errors test_evo_protocol
    COMMENT "Run the ticalcs2 torture tests"
    EXCLUDE_FROM_ALL
)
