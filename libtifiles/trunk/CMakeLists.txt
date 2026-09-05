cmake_minimum_required(VERSION 3.12)

project(libtifiles2
        VERSION     1.1.8
        LANGUAGES   CXX)

file(GLOB HEADER_FILES src/*.h)
set(SRC_FILES
        ${HEADER_FILES}
        src/cert.cc
        src/comments.cc
        src/error.cc
        src/files8x.cc
        src/files_evo.cc
        src/files9x.cc
        src/filesnsp.cc
        src/filesxx.cc
        src/filetypes.cc
        src/grouped.cc
        src/intelhex.cc
        src/misc.cc
        src/rwfile.cc
        src/tifiles.cc
        src/tigroup.cc
        src/type2str.cc
        src/types68k.cc
        src/types83p.cc
        src/typesnsp.cc
        src/typesoldz80.cc
        src/typesxx.cc
        src/ve_fp.cc)

set(PUBLIC_HEADERS
        src/tifiles.h
        src/export2.h
        src/files8x.h
        src/files9x.h
        src/types73.h
        src/types82.h
        src/types83.h
        src/types83p.h
        src/types84p.h
        src/types85.h
        src/types86.h
        src/types89.h
        src/types89t.h
        src/types92.h
        src/types92p.h
        src/typesnsp.h
        src/typesv2.h
        src/typesxx.h)

# external deps lookup
if(NOT EMSCRIPTEN)
    find_package(ZLIB REQUIRED)
else()
    # build_wasm.sh supplies the same zlib archive as WebTILP's final link.
    # Retain the SDK port for standalone builds without an external install.
    find_package(ZLIB QUIET)
endif()
pkg_check_modules(glib REQUIRED IMPORTED_TARGET glib-2.0)
pkg_check_modules(LibArchive REQUIRED IMPORTED_TARGET libarchive)

# auto-creation of all targets with flags etc., alongside with internal deps
create_lib_target_with_deps(tifiles2 ticonv)

if(LINUX)
    target_link_libraries(tifiles2 PRIVATE Threads::Threads)
endif()

target_link_libraries(tifiles2 PRIVATE PkgConfig::glib PkgConfig::LibArchive)

if(EMSCRIPTEN)
    target_link_options(tifiles2 PRIVATE
        "SHELL:--bind"
        "SHELL:-s ASYNCIFY=1"
        "SHELL:-s EXPORT_ES6=1"
        "SHELL:-s ENVIRONMENT=web,worker"
        "SHELL:-s EXPORTED_RUNTIME_METHODS=['ccall','cwrap','UTF8ToString','stringToUTF8']"
        "SHELL:-s ALLOW_MEMORY_GROWTH=1"
        "SHELL:-s INITIAL_MEMORY=33554432"
        "SHELL:-s STACK_SIZE=5242880"
        "SHELL:-s ASYNCIFY_STACK_SIZE=5242880"
        "SHELL:-s MODULARIZE=1"
        "SHELL:-s EXPORT_NAME='libtifiles'"
    )
    if(NOT TARGET ZLIB::ZLIB)
        target_link_options(tifiles2 PRIVATE "SHELL:-sUSE_ZLIB=1")
    endif()
endif()
if(TARGET ZLIB::ZLIB)
    target_link_libraries(tifiles2 PRIVATE ZLIB::ZLIB)
endif()

set_target_properties(tifiles2 PROPERTIES VERSION 11.0.2 SOVERSION 11)

# Takes care of the i18n po/pot/gmo/mo files
if(ENABLE_NLS)
    i18n_mo_from_po_pot()
    add_dependencies(tifiles2 potfiles_1)
endif()

# public export define
target_compile_definitions(tifiles2 PUBLIC TIFILES_EXPORTS)

# tests
if (BUILD_TESTS)
    add_subdirectory(tests)
endif()
