/*  libtifiles - file format library, a part of the TiLP project
 *  Copyright (C) 1999-2005  Romain Lievin
 *
 *  This program is free software; you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation; either version 2 of the License, or
 *  (at your option) any later version.
 */

#ifdef HAVE_CONFIG_H
#include <config.h>
#endif

#include "files8x.h"
#include "files_evo.h"

int evo_file_read_regular(const char *filename, FileContent *content)
{
	return ti8x_file_read_regular(filename, (Ti8xRegular *)content);
}

int evo_file_write_regular(const char *filename, FileContent *content, char **filename2)
{
	return ti8x_file_write_regular(filename, (Ti8xRegular *)content, filename2);
}

int evo_file_read_flash(const char *filename, FlashContent *content)
{
	return ti8x_file_read_flash(filename, (Ti8xFlash *)content);
}
