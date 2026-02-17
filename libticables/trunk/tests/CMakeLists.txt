cmake_minimum_required(VERSION 3.12)

project(libticables2-tests
        LANGUAGES   C CXX)

add_executable(torture_ticables torture_ticables.c)
add_executable(test_ticables_2 test_ticables_2.cc)
if(NOT WIN32)
    add_executable(test_usb_endpoints test_usb_endpoints.cc)
endif()

set(TICABLES_TEST_TARGETS torture_ticables test_ticables_2)
if(NOT WIN32)
    list(APPEND TICABLES_TEST_TARGETS test_usb_endpoints)
endif()

foreach(tar ${TICABLES_TEST_TARGETS})
    if(WIN32)
        find_library(LIBUSB0 NAMES libusb0.lib usb0 REQUIRED)
        target_link_libraries(${tar} PRIVATE ${LIBUSB0})
    else()
        pkg_check_modules(libusb REQUIRED IMPORTED_TARGET libusb-1.0>=1.0.16)
        target_link_libraries(${tar} PRIVATE PkgConfig::libusb)
    endif()
    target_include_directories(${tar} PRIVATE ${PROJECT_SOURCE_DIR}/../src)
    target_link_directories(${tar} PRIVATE ${PROJECT_BINARY_DIR}/..)
    target_link_libraries(${tar} PRIVATE PkgConfig::glib ticables2)
endforeach()

if(NOT WIN32)
    add_custom_target(ticables2_check
        COMMAND "$<TARGET_FILE:torture_ticables>"
        COMMAND "$<TARGET_FILE:test_usb_endpoints>"
        DEPENDS torture_ticables test_usb_endpoints
        COMMENT "Run the ticables2 torture tests"
        EXCLUDE_FROM_ALL
    )
else()
    add_custom_target(ticables2_check
        COMMAND "$<TARGET_FILE:torture_ticables>"
        DEPENDS torture_ticables
        COMMENT "Run the ticables2 torture tests"
        EXCLUDE_FROM_ALL
    )
endif()
