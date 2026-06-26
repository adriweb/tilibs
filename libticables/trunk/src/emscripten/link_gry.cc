/* "Grey TIGraphLink" link cable unit, WebSerial backend */

#ifdef HAVE_CONFIG_H
#include <config.h>
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <emscripten.h>

#include "../ticables.h"
#include "../logging.h"
#include "../error.h"
#include "../gettext.h"
#include "../internal.h"
#include "../webserial.h"

#define gry_is_open(h) (GPOINTER_TO_INT((h)->priv) != 0)

static int gry_prepare(CableHandle *h)
{
	if (h->port != PORT_1)
	{
		return ERR_ILLEGAL_ARG;
	}

	h->address = 0;
	if (h->device == NULL)
	{
		h->device = strdup("WebSerial GrayLink");
	}
	return 0;
}

static int gry_open(CableHandle *h)
{
	int ret = webserial_open(WEBSERIAL_KIND_GRAYLINK, 9600, 8, 1, 1, 0, 0);
	if (ret == -3)
	{
		ticables_warning("%s", _("WebSerial GrayLink requires DTR/RTS and CTS/DSR signal support."));
		return ERR_GRY_IOCTL;
	}
	if (ret)
	{
		return ERR_GRY_OPEN;
	}

	h->priv = GINT_TO_POINTER(1);
	free(h->device);
	h->device = strdup("WebSerial GrayLink");
	ticables_info("%s", _("using GrayLink WebSerial device"));
	return 0;
}

static int gry_close(CableHandle *h)
{
	if (gry_is_open(h))
	{
		webserial_close(WEBSERIAL_KIND_GRAYLINK);
	}
	h->priv = GINT_TO_POINTER(0);
	return 0;
}

static int gry_reset(CableHandle *h)
{
	(void)h;
	return webserial_reset(WEBSERIAL_KIND_GRAYLINK) ? ERR_FLUSH_ERROR : 0;
}

static int gry_put(CableHandle* h, uint8_t *data, uint32_t len)
{
	(void)h;
	uint32_t done = 0;
	while (done < len)
	{
		int ret = webserial_write(WEBSERIAL_KIND_GRAYLINK, data + done, (int)(len - done));
		if (ret < 0)
		{
			return ERR_WRITE_ERROR;
		}
		if (ret == 0)
		{
			return ERR_WRITE_TIMEOUT;
		}
		done += (uint32_t)ret;
	}
	return 0;
}

static int gry_get(CableHandle* h, uint8_t *data, uint32_t len)
{
	uint32_t done = 0;
	while (done < len)
	{
		int ret = webserial_read(WEBSERIAL_KIND_GRAYLINK, data + done, (int)(len - done), (int)(100 * h->timeout));
		if (ret == -2)
		{
			return ERR_READ_TIMEOUT;
		}
		if (ret < 0)
		{
			return ERR_READ_ERROR;
		}
		if (ret == 0)
		{
			return ERR_READ_TIMEOUT;
		}
		done += (uint32_t)ret;
	}
	return 0;
}

static int dcb_read_io(CableHandle *h)
{
	(void)h;
	int ret = webserial_get_signals(WEBSERIAL_KIND_GRAYLINK);
	return ret < 0 ? ERR_GRY_IOCTL : ret;
}

static int dcb_write_io(CableHandle *h, const int data)
{
	(void)h;
	return webserial_set_signals(WEBSERIAL_KIND_GRAYLINK, data) ? ERR_GRY_IOCTL : 0;
}

static int gry_probe(CableHandle *h)
{
	int i;
	static const int seq_in[] =  { 3, 2, 0, 1, 3 };
	static const int seq_out[] = { 2, 0, 0, 2, 2 };

	for (i = 0; i < 5; i++)
	{
		if (dcb_write_io(h, seq_in[i]))
		{
			return ERR_GRY_IOCTL;
		}
		emscripten_sleep(1000);

		if ((dcb_read_io(h) & 0x3) != seq_out[i])
		{
			dcb_write_io(h, 3);
			return ERR_PROBE_FAILED;
		}
	}

	return 0;
}

static int gry_check(CableHandle *h, int *status)
{
	if (!gry_is_open(h))
	{
		return ERR_READ_ERROR;
	}
	*status = webserial_available(WEBSERIAL_KIND_GRAYLINK) > 0 ? STATUS_RX : STATUS_NONE;
	return 0;
}

static int gry_timeout(CableHandle *h)
{
	(void)h;
	return 0;
}

static int gry_set_extra_options(CableHandle * h, CableExtraOptions * options_ex)
{
	(void)h, (void)options_ex;
	return ERR_ILLEGAL_ARG;
}

static int gry_get_extra_options(CableHandle * h, CableExtraOptions * options_ex)
{
	options_ex->version = 1;
	options_ex->has_parameters = 1;
	memset((void *)&options_ex->parameters, 0, sizeof(options_ex->parameters));
	options_ex->parameters.parameters_gry.device = h->device;
	options_ex->parameters.parameters_gry.address = h->address;
	options_ex->parameters.parameters_gry.quirk_speed_input = 9600;
	options_ex->parameters.parameters_gry.quirk_speed_output = 9600;
	options_ex->parameters.parameters_gry.quirk_enable_rtscts = 0;
	return 0;
}

extern const CableFncts cable_gry =
{
	CABLE_GRY,
	"GRY",
	N_("GrayLink"),
	N_("GrayLink serial cable"),
	!0,
	&gry_prepare,
	&gry_open, &gry_close, &gry_reset, &gry_probe, &gry_timeout,
	&gry_put, &gry_get, &gry_check,
	&noop_set_red_wire, &noop_set_white_wire,
	&noop_get_red_wire, &noop_get_white_wire,
	NULL, NULL,
	NULL,
	&gry_set_extra_options, &gry_get_extra_options
};
