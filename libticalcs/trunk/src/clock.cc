/* Hey EMACS -*- linux-c -*- */
/* $Id$ */

/*  libticalcs - Ti Calculator library, a part of the TiLP project
 *  Copyright (C) 1999-2005  Romain Liévin
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
	Clock support for AMS >= 2.08.
*/

#include <stdio.h>
#include <string.h>
#include <time.h>

#include "ticalcs.h"
#include "logging.h"
#include "internal.h"

#ifdef __WIN32__
#define strcasecmp _stricmp
#endif

#define MAX_FORMAT_89	8
#define MAX_FORMAT_84	3

static const char *TI_CLOCK_89[] =
{
	"",
	"MM/DD/YY",
	"DD/MM/YY",
	"MM.DD.YY",
	"DD.MM.YY",
	"YY.MM.DD",
	"MM-DD-YY",
	"DD-MM-YY",
	"YY-MM-DD",
	""
};

static const char *TI_CLOCK_84[] =
{
	"",
	"M/D/Y",
	"D/M/Y",
	"Y/M/D",
	""
};

/**
 * ticalcs_clock_format2date:
 * @model: a calculator model
 * @value: a format type
 *
 * Convert a format type into a format string.
 * Example: 1 -> "MM/DD/YY"
 *
 * Return value: a format string.
 **/
const char *TICALL ticalcs_clock_format2date(CalcModel model, int value)
{
	int v;

	if (tifiles_calc_is_ti9x(model))
	{
		if (value < 1)
		{
			v = 1;
		}
		else if (value > MAX_FORMAT_89)
		{
			v = MAX_FORMAT_89;
		}
		else
		{
			v = value;
		}

		return TI_CLOCK_89[v];
	}
	else if (tifiles_calc_is_ti8x(model))
	{
		if (value < 1)
		{
			v = 1;
		}
		else if (value > MAX_FORMAT_84)
		{
			v = MAX_FORMAT_84;
		}
		else
		{
			v = value;
		}

		return TI_CLOCK_84[v];
	}

	return "";
}

/**
 * ticalcs_clock_date2format:
 * @model: a calculator model
 * @format: a format string
 *
 * Convert a format string into a format type.
 * Example: "MM/DD/YY" -> 1
 *
 * Return value: a format string.
 **/
int TICALL ticalcs_clock_date2format(CalcModel model, const char *format)
{
	int i = 1;

	if (format == nullptr)
	{
		ticalcs_critical("ticalcs_clock_date2format: format is NULL");
		return 0;
	}

	if (tifiles_calc_is_ti9x(model))
	{
		for (i = 1; i <= MAX_FORMAT_89; i++)
		{
			if (!strcasecmp(TI_CLOCK_89[i], format))
			{
				break;
			}
		}
		if (i > MAX_FORMAT_89)
		{
			return 1;
		}
	}
	else if (tifiles_calc_is_ti8x(model))
	{
		for (i = 1; i <= MAX_FORMAT_84; i++)
		{
			if (!strcasecmp(TI_CLOCK_84[i], format))
			{
				break;
			}
		}
		if (i > MAX_FORMAT_84)
		{
			return 1;
		}
	}

	return i;
}

/**
 * ticalcs_clock_show:
 * @model: calc model
 * @clock: a #CalcClock structure
 *
 * Display to stdout the content of the structure.
 *
 * Return value: always 0.
 **/
int TICALL ticalcs_clock_show(CalcModel model, CalcClock* s)
{
	if (s != nullptr)
	{
		ticalcs_info("Date: %04i/%02i/%02i", s->year, s->month, s->day);
		ticalcs_info("Time: %02i/%02i/%02i", s->hours, s->minutes, s->seconds);
		ticalcs_info("Time format: %02i", s->time_format);
		ticalcs_info("Date format: %s", ticalcs_clock_format2date(model, s->date_format));
	}

	return 0;
}

// Use libc's local time conversion, including the browser timezone in Emscripten.
int ticalcs_clock_now(CalcClock* clock, int offset_seconds, gint64 ahead_us)
{
	const time_t now = (g_get_real_time() + ahead_us) / G_USEC_PER_SEC + offset_seconds;
	struct tm local;
#ifdef HAVE_LOCALTIME_R
	if (!localtime_r(&now, &local))
	{
		return ERR_INVALID_PARAMETER;
	}
#else
	const struct tm* result = localtime(&now);
	if (!result)
	{
		return ERR_INVALID_PARAMETER;
	}
	local = *result;
#endif
	clock->year = local.tm_year + 1900;
	clock->month = local.tm_mon + 1;
	clock->day = local.tm_mday;
	clock->hours = local.tm_hour;
	clock->minutes = local.tm_min;
	clock->seconds = local.tm_sec;

	return 0;
}

// DUSB classic clocks store civil seconds since 1997-01-01, without a timezone.
// UTC conversion avoids applying the host's DST rules to calculator dates.
int ticalcs_clock_to_dusb(const CalcClock* clock, uint32_t* value)
{
	if (clock->seconds > 59)
	{
		return ERR_INVALID_PARAMETER;
	}
	GDateTime* date = g_date_time_new_utc(clock->year, clock->month, clock->day,
		clock->hours, clock->minutes, clock->seconds);
	if (!date)
	{
		return ERR_INVALID_PARAMETER;
	}
	const gint64 seconds = g_date_time_to_unix(date) - 852076800;
	g_date_time_unref(date);
	if (seconds < 0 || seconds > G_MAXUINT32)
	{
		return ERR_INVALID_PARAMETER;
	}
	*value = (uint32_t)seconds;
	return 0;
}

void ticalcs_clock_from_dusb(uint32_t value, CalcClock* clock)
{
	GDateTime* date = g_date_time_new_from_unix_utc(852076800 + gint64(value));
	clock->year = g_date_time_get_year(date);
	clock->month = g_date_time_get_month(date);
	clock->day = g_date_time_get_day_of_month(date);
	clock->hours = g_date_time_get_hour(date);
	clock->minutes = g_date_time_get_minute(date);
	clock->seconds = g_date_time_get_second(date);
	g_date_time_unref(date);
}
