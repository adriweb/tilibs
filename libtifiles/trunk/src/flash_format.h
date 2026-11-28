/* Internal helpers shared by the TIFL readers and classifiers. */

#ifndef __TIFILES_FLASH_FORMAT__
#define __TIFILES_FLASH_FORMAT__

#include "tifiles.h"

/* CBL 2 / LabPro and TI Presenter updates use the TI-Z80 TIFL container and
   Intel HEX payload format even though those devices are not calculators in
   the TI-8x model family. */
static inline int tifiles_model_uses_ti8x_flash(CalcModel model)
{
	return (   tifiles_calc_is_ti8x(model)
	        || model == CALC_CBL2
	        || model == CALC_LABPRO
	        || model == CALC_LABPRO_USB
	        || model == CALC_TIPRESENTER);
}

static inline int tifiles_device_uses_ti8x_flash(uint8_t device_type)
{
	return (   device_type == DEVICE_TYPE_73
	        || device_type == DEVICE_TYPE_83P
	        || device_type == DEVICE_TYPE_CBL2
	        || device_type == DEVICE_TYPE_TIPRESENTER);
}

static inline int tifiles_tifl_type_is_os(uint8_t device_type, uint8_t data_type)
{
	(void)device_type;
	return data_type == TI83p_AMS;
}

static inline int tifiles_tifl_type_is_app(uint8_t device_type, uint8_t data_type)
{
	return (   ((device_type == DEVICE_TYPE_73
	            || device_type == DEVICE_TYPE_83P
	            || device_type == DEVICE_TYPE_89
	            || device_type == DEVICE_TYPE_92P)
	             && data_type == TI83p_APPL)
	        || (device_type == DEVICE_TYPE_CBL2 && data_type == 0x29));
}

static inline int tifiles_tifl_type_is_raw(uint8_t device_type, uint8_t data_type)
{
	if (   data_type == TI83p_CERT       /* certificate */
	        || data_type == TI83p_IDLIST     /* ID list */
	        || data_type == TI83p_GETCERT    /* certificate memory */
	        || data_type == 0x28             /* unit certificate */
	        || data_type == TI83p_LICENSE    /* Flash license */
	        || data_type == 0xF0)            /* information */
	{
		return !0;
	}
	if (device_type == DEVICE_TYPE_CBL2)
	{
		return (   data_type == 0x07       /* string */
		        || data_type == 0x08       /* list */
		        || data_type == 0x0A       /* setup */
		        || data_type == 0x0D       /* normal data list */
		        || data_type == 0x1F       /* full directory */
		        || data_type == 0x2A);     /* archive record */
	}
	return device_type == DEVICE_TYPE_TIPRESENTER && data_type == 0x1F;
}

static inline int tifiles_tifl_payload_is_intel_hex(uint8_t flags, uint8_t object_type)
{
	return (flags & 1) && object_type == 0x88;
}

#endif
