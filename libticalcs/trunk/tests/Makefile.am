## Process this file with automake to produce Makefile.in

AM_CPPFLAGS = -I$(top_srcdir)/src \
	@GLIB_CFLAGS@ @TICABLES_CFLAGS@ @TIFILES_CFLAGS@ @TICONV_CFLAGS@

EXTRA_DIST = ticalcs2.supp vcheck

noinst_PROGRAMS = test_ticalcs_2 torture_ticalcs test_evo_errors test_evo_protocol test_nsp_protocol test_dusb_var_header test_receive_bounds

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
test_dusb_var_header_SOURCES = test_dusb_var_header.cc
test_dusb_var_header_LDADD = $(top_builddir)/src/libticalcs2.la \
	@GLIB_LIBS@ @TICABLES_LIBS@ @TIFILES_LIBS@ @TICONV_LIBS@
test_receive_bounds_SOURCES = test_receive_bounds.cc
test_receive_bounds_LDADD = $(top_builddir)/src/libticalcs2.la \
	@GLIB_LIBS@ @TICABLES_LIBS@ @TIFILES_LIBS@ @TICONV_LIBS@

TESTS = torture_ticalcs test_evo_errors test_evo_protocol test_nsp_protocol test_dusb_var_header test_receive_bounds
