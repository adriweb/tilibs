cmake_minimum_required(VERSION 3.12)

project(libtifiles2-tests
        LANGUAGES   C CXX)

add_executable(torture_tifiles torture_tifiles.c)
add_executable(test_tifiles_2 test_tifiles_2.cc)

pkg_check_modules(glib REQUIRED IMPORTED_TARGET glib-2.0)
pkg_check_modules(LibArchive REQUIRED IMPORTED_TARGET libarchive)
if(USE_ICONV)
    find_package(Iconv REQUIRED)
    add_compile_definitions(USE_ICONV)
endif()

foreach(tar torture_tifiles test_tifiles_2)
    if(Iconv_FOUND AND NOT Iconv_IS_BUILT_IN)
        target_include_directories(${tar} PRIVATE ${Iconv_INCLUDE_DIRS})
        target_link_libraries(${tar} PRIVATE ${Iconv_LIBRARIES})
    endif()

    target_include_directories(${tar} PRIVATE
        ${PROJECT_SOURCE_DIR}/../../../libticonv/trunk/src
        ${PROJECT_SOURCE_DIR}/../src)

    target_link_directories(${tar} PRIVATE ${PROJECT_BINARY_DIR}/..)
    target_link_libraries(${tar} PRIVATE PkgConfig::glib PkgConfig::LibArchive ticonv tifiles2)
endforeach()

add_custom_target(tifiles2_check
    COMMAND "$<TARGET_FILE:torture_tifiles>"
    DEPENDS torture_tifiles
    COMMENT "Run the tifiles2 torture tests"
    EXCLUDE_FROM_ALL
)

# -----------------------------------------------------------------------
# libFuzzer target – only built when BUILD_FUZZING=ON with a Clang toolchain
# -----------------------------------------------------------------------
if(BUILD_FUZZING)
    if(NOT CMAKE_CXX_COMPILER_ID MATCHES "Clang")
        message(WARNING "BUILD_FUZZING=ON requires a Clang toolchain; skipping fuzz targets")
    else()
        add_executable(fuzz_tifiles fuzz_tifiles.cc)

        # -fsanitize=fuzzer instruments the binary AND links the fuzzer driver.
        # Combine with AddressSanitizer for maximum bug-finding power.
        target_compile_options(fuzz_tifiles PRIVATE -fsanitize=fuzzer,address -fno-omit-frame-pointer)
        target_link_options(fuzz_tifiles PRIVATE -fsanitize=fuzzer,address)

        target_include_directories(fuzz_tifiles PRIVATE
            ${PROJECT_SOURCE_DIR}/../../../libticonv/trunk/src
            ${PROJECT_SOURCE_DIR}/../src)

        target_link_directories(fuzz_tifiles PRIVATE ${PROJECT_BINARY_DIR}/..)
        target_link_libraries(fuzz_tifiles PRIVATE ticonv tifiles2)

        if(Iconv_FOUND AND NOT Iconv_IS_BUILT_IN)
            target_include_directories(fuzz_tifiles PRIVATE ${Iconv_INCLUDE_DIRS})
            target_link_libraries(fuzz_tifiles PRIVATE ${Iconv_LIBRARIES})
        endif()

        # Collect the existing test-data files as a seed corpus so the fuzzer
        # starts with valid inputs and quickly reaches interesting code paths.
        set(FUZZ_CORPUS_DIR "${CMAKE_CURRENT_BINARY_DIR}/fuzz_corpus")
        add_custom_command(
            OUTPUT  "${FUZZ_CORPUS_DIR}/.stamp"
            COMMAND ${CMAKE_COMMAND} -E make_directory "${FUZZ_CORPUS_DIR}"
            COMMAND ${CMAKE_COMMAND} -E copy_directory
                    "${CMAKE_CURRENT_SOURCE_DIR}" "${FUZZ_CORPUS_DIR}"
            COMMAND ${CMAKE_COMMAND} -E touch "${FUZZ_CORPUS_DIR}/.stamp"
            COMMENT "Copying seed corpus for fuzz_tifiles"
        )
        add_custom_target(fuzz_tifiles_corpus DEPENDS "${FUZZ_CORPUS_DIR}/.stamp")
        add_dependencies(fuzz_tifiles fuzz_tifiles_corpus)

        message(STATUS "fuzz_tifiles target created – run with:"
                       " ./fuzz_tifiles ${FUZZ_CORPUS_DIR}/ -max_len=65536")
    endif()
endif()
