cmake_minimum_required(VERSION 3.12)

project(libhpcalcs
        VERSION 0.0.1
        LANGUAGES C)

set(HPCALCS_SOURCES
        src/hpfiles.c
        src/hpcables.c
        src/hpcalcs.c
        src/hpopers.c
        src/error.c
        src/logging.c
        src/utils.c
        src/type2str.c
        src/filetypes.c
        src/typesprime.c
        src/link_nul.c
        src/prime_rpkt.c
        src/prime_vpkt.c
        src/prime_protocol_v2.c
        src/prime_cmd.c
        src/calc_prime.c
        src/calc_none.c
        src/link_prime_hid.c)

add_library(hpcalcs STATIC ${HPCALCS_SOURCES})
target_include_directories(hpcalcs PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")
target_compile_definitions(hpcalcs
        PUBLIC HPCALCS_EXPORTS
        PRIVATE
            VERSION="${PROJECT_VERSION}"
            PACKAGE="libhpcalcs"
            GETTEXT_PACKAGE="libhpcalcs")

find_package(ZLIB REQUIRED)
find_package(PkgConfig REQUIRED)
if(APPLE OR WIN32)
    pkg_check_modules(HIDAPI REQUIRED IMPORTED_TARGET hidapi>=0.8.0)
else()
    pkg_check_modules(HIDAPI REQUIRED IMPORTED_TARGET hidapi-hidraw>=0.8.0)
endif()
target_link_libraries(hpcalcs PRIVATE PkgConfig::HIDAPI ZLIB::ZLIB)

set_target_properties(hpcalcs PROPERTIES
        OUTPUT_NAME hpcalcs
        POSITION_INDEPENDENT_CODE ON)

if(BUILD_TESTS)
    enable_testing()

    add_executable(hpcalcs_prime_transport_test
            tests/test_prime_transport.c)
    target_link_libraries(hpcalcs_prime_transport_test PRIVATE hpcalcs)
    add_test(NAME hpcalcs_prime_transport
            COMMAND hpcalcs_prime_transport_test)

    add_executable(hpcalcs_prime_protocol_v2_test
            tests/test_prime_protocol_v2.c)
    target_link_libraries(hpcalcs_prime_protocol_v2_test PRIVATE hpcalcs)
    add_test(NAME hpcalcs_prime_protocol_v2
            COMMAND hpcalcs_prime_protocol_v2_test)

    add_custom_target(hpcalcs_check
            COMMAND ${CMAKE_CTEST_COMMAND} --output-on-failure
                    -R "^hpcalcs_prime_"
            DEPENDS hpcalcs_prime_transport_test hpcalcs_prime_protocol_v2_test
            WORKING_DIRECTORY ${CMAKE_BINARY_DIR}
            COMMENT "Run libhpcalcs transport tests")
endif()
