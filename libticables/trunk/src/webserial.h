#ifndef __TICABLES_WEBSERIAL_H__
#define __TICABLES_WEBSERIAL_H__

#include <stdint.h>

typedef enum
{
	WEBSERIAL_KIND_EVO = 1,
	WEBSERIAL_KIND_GRAYLINK = 2
} WebSerialKind;

int webserial_has_authorized_evo(void);
int webserial_has_bound_evo(void);
int webserial_has_bound_kind(WebSerialKind kind);
int webserial_open(WebSerialKind kind, int baud_rate, int data_bits, int stop_bits, int require_signals, uint16_t vid, uint16_t pid);
int webserial_close(WebSerialKind kind);
int webserial_reset(WebSerialKind kind);
int webserial_write(WebSerialKind kind, const uint8_t *data, int len);
int webserial_read(WebSerialKind kind, uint8_t *data, int len, int timeout_ms);
int webserial_available(WebSerialKind kind);
int webserial_set_signals(WebSerialKind kind, int signals);
int webserial_get_signals(WebSerialKind kind);

#endif
