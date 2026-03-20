/* Hey EMACS -*- linux-c -*- */

/*  libtifiles - file format library, a part of the TiLP project
 *  Copyright (C) 1999-2024  Romain Lievin
 *
 *  This program is free software; you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation; either version 2 of the License, or
 *  (at your option) any later version.
 *
 *  This program is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU General Public License for more details.
 *
 *  You should have received a copy of the GNU General Public License
 *  along with this program; if not, write to the Free Software Foundation,
 *  Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA
 */

/*
 * libFuzzer entry point for libtifiles.
 *
 * Exercises all file-parsing paths (regular/group, backup, flash, tigroup)
 * across every supported calculator model by writing the fuzzer-supplied
 * bytes to a temporary file and feeding the filename to the library APIs.
 *
 * Build with:
 *   cmake -DBUILD_FUZZING=ON -DCMAKE_CXX_COMPILER=clang++ ...
 *
 * Run with (example):
 *   ./fuzz_tifiles corpus/  -max_len=65536
 */

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <unistd.h>

#include "../src/tifiles.h"

/* ------------------------------------------------------------------ */
/* One-time library initialisation / teardown                          */
/* ------------------------------------------------------------------ */

static struct TiFilesLibInit
{
	TiFilesLibInit()  { tifiles_library_init(); }
	~TiFilesLibInit() { tifiles_library_exit(); }
} s_tifiles_init;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/* Calculator models to rotate through – mirrors the set used by
   test_tifiles_2.cc so the same code paths are exercised.             */
static const CalcModel kModels[] =
{
	CALC_TI73,
	CALC_TI82,
	CALC_TI83,
	CALC_TI83P,
	CALC_TI84P,
	CALC_TI85,
	CALC_TI86,
	CALC_TI89,
	CALC_TI92,
	CALC_TI92P,
	CALC_V200,
	CALC_NSPIRE,
};
static const size_t kNumModels = sizeof(kModels) / sizeof(kModels[0]);

/* Write `data` to a fresh temp file; returns the open fd (>= 0) and
   fills `name`.  The caller must close() and unlink() the file.       */
static int write_tmp(const uint8_t *data, size_t size, char *name)
{
	/* Use /tmp directly; TMPDIR could be noexec on some systems. */
	strcpy(name, "/tmp/fuzz_tifiles_XXXXXX");
	int fd = mkstemp(name);
	if (fd < 0)
		return -1;

	size_t written = 0;
	while (written < size)
	{
		ssize_t n = write(fd, data + written, size - written);
		if (n <= 0)
		{
			close(fd);
			unlink(name);
			return -1;
		}
		written += (size_t)n;
	}

	close(fd);
	return 0;
}

/* ------------------------------------------------------------------ */
/* Fuzzer entry point                                                  */
/* ------------------------------------------------------------------ */

/*
 * Byte layout of `data`:
 *   [0]  selector byte – low nibble picks CalcModel, high nibble picks mode
 *   [1…] raw file content passed to the parser
 *
 * Modes:
 *   0 – tifiles_file_read_regular  (covers single + group vars)
 *   1 – tifiles_file_read_backup
 *   2 – tifiles_file_read_flash    (covers apps + OS images)
 *   3 – tifiles_file_read_tigroup  (covers the .tig container)
 */
extern "C" int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size)
{
	if (size < 2)
		return 0;

	const uint8_t selector  = data[0];
	const CalcModel model   = kModels[(selector & 0x0Fu) % kNumModels];
	const uint8_t mode      = (selector >> 4) & 0x03u;

	const uint8_t *file_data = data + 1;
	const size_t   file_size = size - 1;

	char tmpname[64];
	if (write_tmp(file_data, file_size, tmpname) < 0)
		return 0;

	switch (mode)
	{
		case 0:
		{
			/* Regular file: single variable or group of variables.
			 * tifiles_file_read_regular frees content on error, so only
			 * call delete on success (same pattern as test_tifiles_2.cc). */
			FileContent *content = tifiles_content_create_regular(model);
			if (content)
			{
				if (tifiles_file_read_regular(tmpname, content) == 0)
					tifiles_content_delete_regular(content);
			}
			break;
		}

		case 1:
		{
			/* Backup file – same ownership rule as above. */
			BackupContent *content = tifiles_content_create_backup(model);
			if (content)
			{
				if (tifiles_file_read_backup(tmpname, content) == 0)
					tifiles_content_delete_backup(content);
			}
			break;
		}

		case 2:
		{
			/* Flash file: application or OS image – same ownership rule. */
			FlashContent *content = tifiles_content_create_flash(model);
			if (content)
			{
				if (tifiles_file_read_flash(tmpname, content) == 0)
					tifiles_content_delete_flash(content);
			}
			break;
		}

		case 3:
		{
			/* TiGroup container (.tig).
			 * tifiles_file_read_tigroup documents that content is NOT released
			 * on error, so the caller must always free it. */
			TigContent *content = tifiles_content_create_tigroup(CALC_NONE, 0);
			if (content)
			{
				tifiles_file_read_tigroup(tmpname, content);
				tifiles_content_delete_tigroup(content);
			}
			break;
		}

		default:
			break;
	}

	unlink(tmpname);
	return 0;
}
