#ifdef HAVE_CONFIG_H
#include <config.h>
#endif

#if defined(__WIN32__)

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef _WINSOCKAPI_
#include <winsock2.h>
#endif
#include <windows.h>
#include <setupapi.h>
#include <cfgmgr32.h>
#include <devguid.h>

#include "../evo_serial.h"
#include "../error.h"
#include "../gettext.h"
#include "../logging.h"

#ifndef INVALID_HANDLE_VALUE
#define INVALID_HANDLE_VALUE ((HANDLE)(LONG_PTR)-1)
#endif

static void evo_windows_serial_device_name(const char *path, char *device, size_t device_size)
{
	if (!strncmp(path, "\\\\.\\", 4))
	{
		snprintf(device, device_size, "%s", path);
	}
	else
	{
		snprintf(device, device_size, "\\\\.\\%s", path);
	}
}

static int evo_product_kind(const char *product)
{
	if (product == nullptr)
	{
		return 0;
	}
	if (strstr(product, "TI-83") != nullptr || strstr(product, "TI_83") != nullptr || strstr(product, "83 Evo") != nullptr || strstr(product, "83Evo") != nullptr)
	{
		return 83;
	}
	if (strstr(product, "Evo-T") != nullptr || strstr(product, "Evo_T") != nullptr)
	{
		return 84;
	}
	return 0;
}

static const char *evo_product_name_from_kind(int kind)
{
	if (kind == 83)
	{
		return "TI-83 Evo";
	}
	if (kind == 84)
	{
		return "TI-84 Evo-T";
	}
	return "TI-84 Evo";
}

static int windows_get_devnode_string(DEVINST devinst, ULONG property, char *out, size_t out_size)
{
	ULONG reg_type = 0;
	ULONG size = (ULONG)out_size;
	CONFIGRET cr;

	out[0] = 0;
	cr = CM_Get_DevNode_Registry_PropertyA(devinst, property, &reg_type, out, &size, 0);
	return cr == CR_SUCCESS && (reg_type == REG_SZ || reg_type == REG_MULTI_SZ) && out[0] != 0;
}

static int windows_multi_sz_contains(const char *multi, const char *needle)
{
	const char *p = multi;
	while (*p)
	{
		if (strstr(p, needle) != nullptr)
		{
			return 1;
		}
		p += strlen(p) + 1;
	}
	return 0;
}

static int windows_devnode_chain_has_hwid(DEVINST devinst, const char *needle)
{
	DEVINST cur = devinst;
	int depth;

	for (depth = 0; depth < 8; depth++)
	{
		char ids[1024];
		DEVINST parent;

		if (windows_get_devnode_string(cur, CM_DRP_HARDWAREID, ids, sizeof(ids)) && windows_multi_sz_contains(ids, needle))
		{
			return 1;
		}
		if (CM_Get_Parent(&parent, cur, 0) != CR_SUCCESS)
		{
			break;
		}
		cur = parent;
	}
	return 0;
}

static int windows_devnode_chain_evo_product_kind(DEVINST devinst)
{
	DEVINST cur = devinst;
	int depth;

	for (depth = 0; depth < 8; depth++)
	{
		char text[512];
		DEVINST parent;
		int kind;

		if (windows_get_devnode_string(cur, CM_DRP_FRIENDLYNAME, text, sizeof(text)) || windows_get_devnode_string(cur, CM_DRP_DEVICEDESC, text, sizeof(text)))
		{
			kind = evo_product_kind(text);
			if (kind)
			{
				return kind;
			}
		}
		if (CM_Get_Parent(&parent, cur, 0) != CR_SUCCESS)
		{
			break;
		}
		cur = parent;
	}
	return 0;
}

static int windows_get_port_name(HDEVINFO devs, SP_DEVINFO_DATA *devinfo, char *port, size_t port_size)
{
	HKEY key = SetupDiOpenDevRegKey(devs, devinfo, DICS_FLAG_GLOBAL, 0, DIREG_DEV, KEY_READ);
	DWORD type = 0;
	DWORD size = (DWORD)port_size;
	LONG ret;

	if (key == INVALID_HANDLE_VALUE)
	{
		return 0;
	}

	ret = RegQueryValueExA(key, "PortName", nullptr, &type, (LPBYTE)port, &size);
	RegCloseKey(key);
	return ret == ERROR_SUCCESS && type == REG_SZ && !strncmp(port, "COM", 3);
}

static int evo_find_windows_serial_path(char *path, size_t path_size, const char *product)
{
	HDEVINFO devs = SetupDiGetClassDevsA(&GUID_DEVCLASS_PORTS, nullptr, nullptr, DIGCF_PRESENT);
	const int want_kind = evo_product_kind(product);
	int ret = ERR_SERIAL_OPEN;
	DWORD i;

	if (devs == INVALID_HANDLE_VALUE)
	{
		return ERR_SERIAL_OPEN;
	}

	for (i = 0; ret; i++)
	{
		SP_DEVINFO_DATA devinfo;
		memset(&devinfo, 0, sizeof(devinfo));
		devinfo.cbSize = sizeof(devinfo);
		if (!SetupDiEnumDeviceInfo(devs, i, &devinfo))
		{
			break;
		}
		if (!windows_devnode_chain_has_hwid(devinfo.DevInst, "VID_0451&PID_E018"))
		{
			continue;
		}
		if (want_kind != 0 && windows_devnode_chain_evo_product_kind(devinfo.DevInst) != want_kind)
		{
			continue;
		}
		if (windows_get_port_name(devs, &devinfo, path, path_size))
		{
			ret = 0;
		}
	}

	SetupDiDestroyDeviceInfoList(devs);
	return ret;
}

static int evo_find_configured_path(char *path, size_t path_size, const USBCableInfo *info)
{
	const char *configured = getenv("TICABLES_EVO_SERIAL");
	if (configured != nullptr && *configured != 0)
	{
		ticables_slprintf(path, path_size, "%s", configured);
		return 0;
	}

	if (info != nullptr && info->device_path[0] != 0)
	{
		ticables_slprintf(path, path_size, "%s", info->device_path);
		return 0;
	}

	return ERR_SERIAL_OPEN;
}

static int evo_serial_configure(HANDLE handle)
{
	DCB dcb;
	COMMTIMEOUTS timeouts;

	memset(&dcb, 0, sizeof(dcb));
	dcb.DCBlength = sizeof(dcb);
	if (!GetCommState(handle, &dcb))
	{
		return ERR_READ_ERROR;
	}

	dcb.BaudRate = CBR_115200;
	dcb.ByteSize = 8;
	dcb.Parity = NOPARITY;
	dcb.StopBits = ONESTOPBIT;
	dcb.fBinary = TRUE;
	dcb.fDtrControl = DTR_CONTROL_ENABLE;
	dcb.fRtsControl = RTS_CONTROL_ENABLE;
	if (!SetCommState(handle, &dcb))
	{
		return ERR_WRITE_ERROR;
	}

	memset(&timeouts, 0, sizeof(timeouts));
	timeouts.ReadIntervalTimeout = MAXDWORD;
	timeouts.ReadTotalTimeoutConstant = 100;
	timeouts.WriteTotalTimeoutConstant = 100;
	SetCommTimeouts(handle, &timeouts);
	PurgeComm(handle, PURGE_RXCLEAR | PURGE_TXCLEAR);
	return 0;
}

void evo_serial_init(EvoSerial *serial)
{
	if (serial != nullptr)
	{
		serial->fd = -1;
		serial->handle = nullptr;
	}
}

int evo_serial_is_open(const EvoSerial *serial)
{
	return serial != nullptr && serial->handle != nullptr;
}

int evo_serial_find_path(char *path, size_t path_size, const USBCableInfo *info)
{
	int ret = evo_find_configured_path(path, path_size, info);
	if (!ret)
	{
		return 0;
	}
	return evo_find_windows_serial_path(path, path_size, info != nullptr ? info->product_str : nullptr);
}

int evo_serial_add_devices(USBCableInfo *devices, int start, int max_devices, uint16_t vid, uint16_t pid)
{
	HDEVINFO devs = SetupDiGetClassDevsA(&GUID_DEVCLASS_PORTS, nullptr, nullptr, DIGCF_PRESENT);
	int j = start;
	DWORD i;

	if (devs == INVALID_HANDLE_VALUE)
	{
		return start;
	}

	for (i = 0; j < max_devices; i++)
	{
		SP_DEVINFO_DATA devinfo;
		char port[sizeof(devices[j].device_path)];
		bool already_listed = false;
		int idx;

		memset(&devinfo, 0, sizeof(devinfo));
		devinfo.cbSize = sizeof(devinfo);
		if (!SetupDiEnumDeviceInfo(devs, i, &devinfo))
		{
			break;
		}
		if (!windows_devnode_chain_has_hwid(devinfo.DevInst, "VID_0451&PID_E018"))
		{
			continue;
		}
		if (!windows_get_port_name(devs, &devinfo, port, sizeof(port)))
		{
			continue;
		}
		for (idx = 0; idx < j; idx++)
		{
			if (!strcmp(devices[idx].device_path, port))
			{
				already_listed = true;
				break;
			}
		}
		if (already_listed)
		{
			continue;
		}

		devices[j].vid = vid;
		devices[j].pid = pid;
		devices[j].version = 0;
		ticables_slprintf(devices[j].product_str, sizeof(devices[j].product_str), "%s", evo_product_name_from_kind(windows_devnode_chain_evo_product_kind(devinfo.DevInst)));
		ticables_slprintf(devices[j].device_path, sizeof(devices[j].device_path), "%s", port);
		devices[j].dev = nullptr;
		ticables_info(_(" found %s on #%i through CDC serial <%s>\n"), devices[j].product_str, j + 1, port);
		j++;
	}

	SetupDiDestroyDeviceInfoList(devs);
	return j;
}

int evo_serial_open(CableHandle *h, EvoSerial *serial, const USBCableInfo *info)
{
	char path[PATH_MAX];
	char device[64];
	HANDLE handle;
	int ret = evo_serial_find_path(path, sizeof(path), info);

	if (ret)
	{
		return ret;
	}

	evo_windows_serial_device_name(path, device, sizeof(device));
	handle = CreateFileA(device, GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
	if (handle == INVALID_HANDLE_VALUE)
	{
		ticables_warning("failed to open TI-84 Evo serial device %s: %lu\n", path, GetLastError());
		return ERR_SERIAL_OPEN;
	}

	ret = evo_serial_configure(handle);
	if (ret)
	{
		ticables_warning("failed to configure TI-84 Evo serial device %s\n", path);
		CloseHandle(handle);
		return ret;
	}

	serial->handle = handle;
	free(h->device);
	h->device = strdup(path);
	ticables_info("using TI-84 Evo serial device %s\n", path);
	return 0;
}

void evo_serial_close(EvoSerial *serial)
{
	if (serial != nullptr && serial->handle != nullptr)
	{
		CloseHandle((HANDLE)serial->handle);
	}
	evo_serial_init(serial);
}

int evo_serial_reset(EvoSerial *serial)
{
	if (serial == nullptr || serial->handle == nullptr)
	{
		return ERR_SERIAL_IOCTL;
	}
	return PurgeComm((HANDLE)serial->handle, PURGE_RXCLEAR | PURGE_TXCLEAR) ? 0 : ERR_SERIAL_IOCTL;
}

int evo_serial_send(CableHandle *h, EvoSerial *serial, uint8_t *data, uint32_t len)
{
	uint32_t done = 0;
	while (done < len)
	{
		DWORD written = 0;
		if (!WriteFile((HANDLE)serial->handle, data + done, len - done, &written, nullptr))
		{
			return ERR_WRITE_ERROR;
		}
		if (written == 0)
		{
			return ERR_WRITE_TIMEOUT;
		}
		done += written;
	}
	return 0;
}

int evo_serial_recv(CableHandle *h, EvoSerial *serial, uint8_t *data, uint32_t len)
{
	uint32_t done = 0;
	COMMTIMEOUTS timeouts;

	memset(&timeouts, 0, sizeof(timeouts));
	timeouts.ReadIntervalTimeout = MAXDWORD;
	timeouts.ReadTotalTimeoutConstant = evo_serial_timeout_ms(h);
	timeouts.WriteTotalTimeoutConstant = evo_serial_timeout_ms(h);
	SetCommTimeouts((HANDLE)serial->handle, &timeouts);

	while (done < len)
	{
		DWORD got = 0;
		if (!ReadFile((HANDLE)serial->handle, data + done, len - done, &got, nullptr))
		{
			return ERR_READ_ERROR;
		}
		if (got == 0)
		{
			return ERR_READ_TIMEOUT;
		}
		done += got;
	}
	return 0;
}

int evo_serial_check(CableHandle *h, EvoSerial *serial, int *status)
{
	COMSTAT stat;
	DWORD errors = 0;

	if (!ClearCommError((HANDLE)serial->handle, &errors, &stat))
	{
		return ERR_READ_ERROR;
	}
	*status = stat.cbInQue > 0 ? STATUS_RX : STATUS_NONE;
	return 0;
}

#endif
