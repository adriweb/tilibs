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
        src/calc_none.c)

if(EMSCRIPTEN)
    list(APPEND HPCALCS_SOURCES src/link_prime_webhid.c)
else()
    list(APPEND HPCALCS_SOURCES src/link_prime_hid.c)
endif()

add_library(hpcalcs STATIC ${HPCALCS_SOURCES})
target_include_directories(hpcalcs PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")
target_compile_definitions(hpcalcs
        PUBLIC HPCALCS_EXPORTS
        PRIVATE
            VERSION="${PROJECT_VERSION}"
            PACKAGE="libhpcalcs"
            GETTEXT_PACKAGE="libhpcalcs")

if(EMSCRIPTEN)
    target_compile_definitions(hpcalcs PRIVATE __EMSCRIPTEN__=1)
    # EM_ASYNC_JS WebHID calls suspend synchronous C operations while browser
    # promises complete.  CMake consumers must therefore link with Asyncify;
    # backup file payloads use the external zlib install when available.
    target_link_options(hpcalcs INTERFACE -sASYNCIFY=1)
    find_package(ZLIB QUIET)
    if(TARGET ZLIB::ZLIB)
        target_link_libraries(hpcalcs PRIVATE ZLIB::ZLIB)
    else()
        target_link_options(hpcalcs INTERFACE -sUSE_ZLIB=1)
    endif()
else()
    find_package(ZLIB REQUIRED)
    find_package(PkgConfig REQUIRED)
    if(APPLE OR WIN32)
        pkg_check_modules(HIDAPI REQUIRED IMPORTED_TARGET hidapi>=0.8.0)
    else()
        pkg_check_modules(HIDAPI REQUIRED IMPORTED_TARGET hidapi-hidraw>=0.8.0)
    endif()
    target_link_libraries(hpcalcs PRIVATE PkgConfig::HIDAPI ZLIB::ZLIB)
endif()

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

if(EMSCRIPTEN)
    add_executable(hpcalcs_webhid_link_smoke EXCLUDE_FROM_ALL
            tests/webhid_link_smoke.c)
    target_link_libraries(hpcalcs_webhid_link_smoke PRIVATE hpcalcs)

    add_executable(hpcalcs_webhid_mock_test EXCLUDE_FROM_ALL
            tests/test_webhid_mock.c)
    target_link_libraries(hpcalcs_webhid_mock_test PRIVATE hpcalcs)
    target_link_options(hpcalcs_webhid_mock_test PRIVATE
            --pre-js "${CMAKE_CURRENT_SOURCE_DIR}/tests/webhid_mock_pre.js"
            -sEXIT_RUNTIME=1 -sASSERTIONS=1 -O0)
endif()
