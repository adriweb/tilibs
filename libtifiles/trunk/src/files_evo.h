/*  libtifiles - file format library, a part of the TiLP project
 *  Copyright (C) 1999-2005  Romain Lievin
 *
 *  This program is free software; you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation; either version 2 of the License, or
 *  (at your option) any later version.
 */

#ifndef __TIFILES_FILES_EVO_H__
#define __TIFILES_FILES_EVO_H__

#include "tifiles.h"

#ifdef __cplusplus
extern "C" {
#endif

int evo_file_read_regular(const char *filename, FileContent *content);
int evo_file_write_regular(const char *filename, FileContent *content, char **filename2);
int evo_file_read_flash(const char *filename, FlashContent *content);

#ifdef __cplusplus
}
#endif

#endif
