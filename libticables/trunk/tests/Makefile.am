## Process this file with automake to produce Makefile.in

AM_CPPFLAGS = -I$(top_srcdir)/src

EXTRA_DIST = ticables2.supp vcheck

noinst_PROGRAMS = test_ticables_2 torture_ticables

test_ticables_2_SOURCES = test_ticables_2.cc
test_ticables_2_LDADD = $(top_builddir)/src/libticables2.la
torture_ticables_SOURCES = torture_ticables.c
torture_ticables_LDADD = $(top_builddir)/src/libticables2.la

TESTS = torture_ticables

if !OS_WIN32
if HAVE_LIBUSB10
noinst_PROGRAMS += test_usb_endpoints
test_usb_endpoints_SOURCES = test_usb_endpoints.cc
test_usb_endpoints_CPPFLAGS = $(AM_CPPFLAGS) @LIBUSB10_CFLAGS@
test_usb_endpoints_LDADD = $(top_builddir)/src/libticables2.la
TESTS += test_usb_endpoints
endif
endif
