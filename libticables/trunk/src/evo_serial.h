#ifndef __TICABLES_EVO_SERIAL_H__
#define __TICABLES_EVO_SERIAL_H__

#include <stddef.h>
#include <stdint.h>

#include "ticables.h"
#include "internal.h"

typedef struct
{
	int fd;
	void *handle;
} EvoSerial;

static inline unsigned int evo_serial_timeout_ms(CableHandle *h)
{
	return 100 * h->timeout;
}

void evo_serial_init(EvoSerial *serial);
int evo_serial_is_open(const EvoSerial *serial);
int evo_serial_open(CableHandle *h, EvoSerial *serial, const USBCableInfo *info);
void evo_serial_close(EvoSerial *serial);
int evo_serial_reset(EvoSerial *serial);
int evo_serial_send(CableHandle *h, EvoSerial *serial, uint8_t *data, uint32_t len);
int evo_serial_recv(CableHandle *h, EvoSerial *serial, uint8_t *data, uint32_t len);
int evo_serial_check(CableHandle *h, EvoSerial *serial, int *status);

int evo_serial_has_bound_device(void);
int evo_serial_find_path(char *path, size_t path_size, const USBCableInfo *info);
int evo_serial_add_devices(USBCableInfo *devices, int start, int max_devices, uint16_t vid, uint16_t pid);

int evo_posix_serial_open_path(CableHandle *h, EvoSerial *serial, const char *path);
void evo_posix_serial_close(EvoSerial *serial);
int evo_posix_serial_reset(EvoSerial *serial);
int evo_posix_serial_send(CableHandle *h, EvoSerial *serial, uint8_t *data, uint32_t len);
int evo_posix_serial_recv(CableHandle *h, EvoSerial *serial, uint8_t *data, uint32_t len);
int evo_posix_serial_check(CableHandle *h, EvoSerial *serial, int *status);

#endif
