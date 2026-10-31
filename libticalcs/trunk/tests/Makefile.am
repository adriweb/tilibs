## Process this file with automake to produce Makefile.in

AM_CPPFLAGS = -I$(top_srcdir)/src \
	@GLIB_CFLAGS@ @TICABLES_CFLAGS@ @TIFILES_CFLAGS@ @TICONV_CFLAGS@

EXTRA_DIST = ticalcs2.supp vcheck

noinst_PROGRAMS = test_ticalcs_2 torture_ticalcs test_evo_errors test_evo_protocol test_nsp_protocol test_ti92_backup test_dbus_protocol

test_ticalcs_2_SOURCES = test_ticalcs_2.cc
test_ticalcs_2_LDADD = $(top_builddir)/src/libticalcs2.la \
	@GLIB_LIBS@ @TICABLES_LIBS@ @TIFILES_LIBS@ @TICONV_LIBS@
torture_ticalcs_SOURCES = torture_ticalcs.cc
torture_ticalcs_LDADD = $(top_builddir)/src/libticalcs2.la \
	@GLIB_LIBS@ @TICABLES_LIBS@ @TIFILES_LIBS@ @TICONV_LIBS@
test_evo_errors_SOURCES = test_evo_errors.cc
test_evo_errors_LDADD = $(top_builddir)/src/libticalcs2.la \
	@GLIB_LIBS@ @TICABLES_LIBS@ @TIFILES_LIBS@ @TICONV_LIBS@
test_evo_protocol_SOURCES = test_evo_protocol.cc
test_evo_protocol_LDADD = $(top_builddir)/src/libticalcs2.la \
	@GLIB_LIBS@ @TICABLES_LIBS@ @TIFILES_LIBS@ @TICONV_LIBS@
test_nsp_protocol_SOURCES = test_nsp_protocol.cc
test_nsp_protocol_LDADD = $(top_builddir)/src/libticalcs2.la \
	@GLIB_LIBS@ @TICABLES_LIBS@ @TIFILES_LIBS@ @TICONV_LIBS@

TESTS = torture_ticalcs test_evo_errors test_evo_protocol test_nsp_protocol test_ti92_backup test_dbus_protocol

test_ti92_backup_SOURCES = test_ti92_backup.cc
test_ti92_backup_LDADD = $(top_builddir)/src/libticalcs2.la \
	@GLIB_LIBS@ @TICABLES_LIBS@ @TIFILES_LIBS@ @TICONV_LIBS@

test_dbus_protocol_SOURCES = test_dbus_protocol.cc
test_dbus_protocol_LDADD = $(top_builddir)/src/libticalcs2.la \
	@GLIB_LIBS@ @TICABLES_LIBS@ @TIFILES_LIBS@ @TICONV_LIBS@

noinst_PROGRAMS += test_ti86_os_sender
test_ti86_os_sender_SOURCES = test_ti86_os.cc
test_ti86_os_sender_LDADD = $(top_builddir)/src/libticalcs2.la \
	@GLIB_LIBS@ @TICABLES_LIBS@ @TIFILES_LIBS@ @TICONV_LIBS@
TESTS += test_ti86_os_sender

EXTRA_DIST += ti86_os_emulator.cc
