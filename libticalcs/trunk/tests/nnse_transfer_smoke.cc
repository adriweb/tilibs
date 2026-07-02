/* Hey EMACS -*- linux-c -*- */

/*
 * Manual TI-Nspire CX II NNSE hardware smoke test.
 *
 * This intentionally is not part of ticalcs2_check: it requires a calculator
 * with the named files present. Override the defaults with:
 *   NNSE_SMOKE_FOLDER
 *   NNSE_SMOKE_FILE1
 *   NNSE_SMOKE_FILE2
 *   NNSE_SMOKE_RECEIVES comma-separated calculator paths to receive
 *   NNSE_SMOKE_ATTRS    comma-separated paths to probe with file attributes
 *   NNSE_SMOKE_DIRLIST_REPEAT number of recursive dirlists to run
 *   NNSE_SMOKE_KEY      key code to send, defaults to 0x99500 (TAB)
 *   NNSE_SMOKE_STEPS    comma-separated attrs,files,file1,file2,screen,key,dirlist
 *   NNSE_SMOKE_SEQUENCE ordered comma-separated version,attrs,files,file1,file2,screen,key,dirlist
 */

#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "ticables.h"
#include "tifiles.h"
#include "ticalcs.h"

#include "error.h"
#include "nsp_cmd.h"
#include "nsp_vpkt.h"

static const char *env_or_default(const char *name, const char *fallback)
{
	const char *value = getenv(name);
	return (value != nullptr && value[0] != 0) ? value : fallback;
}

static unsigned int env_uint_or_default(const char *name, unsigned int fallback)
{
	const char *value = getenv(name);
	if (value == nullptr || value[0] == 0)
	{
		return fallback;
	}

	char *end = nullptr;
	const unsigned long parsed = strtoul(value, &end, 10);
	if (end == value || (end != nullptr && *end != 0) || parsed == 0)
	{
		return fallback;
	}

	return (unsigned int)parsed;
}

static uint32_t env_key_or_default(void)
{
	const char *value = getenv("NNSE_SMOKE_KEY");
	if (value == nullptr || value[0] == 0)
	{
		return 0x99500;
	}

	char *end = nullptr;
	const unsigned long parsed = strtoul(value, &end, 0);
	if (end == value || (end != nullptr && *end != 0))
	{
		return 0x99500;
	}

	return (uint32_t)parsed;
}

static bool step_enabled(const char *step)
{
	const char *steps = getenv("NNSE_SMOKE_STEPS");
	if (steps == nullptr || steps[0] == 0)
	{
		return true;
	}

	const size_t step_len = strlen(step);
	for (const char *cur = steps; cur != nullptr && *cur != 0;)
	{
		const char *next = strchr(cur, ',');
		const size_t len = next != nullptr ? (size_t)(next - cur) : strlen(cur);
		if (len == step_len && strncmp(cur, step, step_len) == 0)
		{
			return true;
		}
		cur = next != nullptr ? next + 1 : nullptr;
	}

	return false;
}

static int run_version(CalcHandle *calc)
{
	CalcInfos infos;
	memset(&infos, 0, sizeof(infos));
	const int ret = ticalcs_calc_get_version(calc, &infos);
	printf("get_version ret=%d model=%s bpp=%u\n", ret, ticalcs_model_to_string(infos.model), infos.bits_per_pixel);
	return ret;
}

static int run_screen(CalcHandle *calc)
{
	CalcScreenCoord sc;
	memset(&sc, 0, sizeof(sc));
	uint8_t *bitmap = nullptr;
	const int ret = ticalcs_calc_recv_screen_rgb888(calc, &sc, &bitmap);
	printf("recv_screen_rgb888 ret=%d width=%u height=%u format=%u\n", ret, sc.width, sc.height, sc.pixel_format);
	if (!ret)
	{
		ticalcs_free_screen(bitmap);
	}
	return ret;
}

static int run_key(CalcHandle *calc)
{
	const uint32_t key = env_key_or_default();
	const int ret = ticalcs_calc_send_key(calc, key);
	printf("send_key ret=%d key=%06X\n", ret, key);
	return ret;
}

static int run_dirlist(CalcHandle *calc)
{
	GNode *vars = nullptr;
	GNode *apps = nullptr;
	const int ret = ticalcs_calc_get_dirlist(calc, &vars, &apps);
	printf("get_dirlist ret=%d\n", ret);
	if (!ret)
	{
		unsigned int count = 0;
		for (GNode *child = vars ? vars->children : nullptr; child != nullptr; child = child->next)
		{
			count++;
		}
		printf("root_entries=%u\n", count);
		ticalcs_dirlist_destroy(&vars);
		ticalcs_dirlist_destroy(&apps);
	}
	return ret;
}

static int probe_attr(CalcHandle *calc, const char *path)
{
	uint32_t size = 0;
	uint32_t date = 0;
	uint8_t type = 0;
	int ret = nsp_session_open(calc, NSP_SID_FILE_MGMT);
	if (!ret)
	{
		ret = nsp_cmd_s_dir_attributes(calc, path);
		if (!ret)
		{
			ret = nsp_cmd_r_dir_attributes(calc, &size, &type, &date);
		}
		const int close_ret = nsp_session_close(calc);
		if (!ret)
		{
			ret = close_ret;
		}
	}

	printf("attr %s ret=%d type=%u size=%u date=%u\n", path, ret, type, size, date);
	return ret;
}

static int run_attr_probes(CalcHandle *calc)
{
	const char *paths = getenv("NNSE_SMOKE_ATTRS");
	if (paths == nullptr || paths[0] == 0)
	{
		return 0;
	}

	char *copy = strdup(paths);
	if (copy == nullptr)
	{
		return ERR_MALLOC;
	}

	int ret = 0;
	for (char *cur = copy; cur != nullptr && *cur != 0;)
	{
		char *next = strchr(cur, ',');
		if (next != nullptr)
		{
			*next = 0;
		}
		if (*cur != 0)
		{
			const int probe_ret = probe_attr(calc, cur);
			if (!ret)
			{
				ret = probe_ret;
			}
		}
		cur = next != nullptr ? next + 1 : nullptr;
	}

	free(copy);
	return ret;
}

static int receive_file(CalcHandle *calc, const char *folder, const char *name, const char *out)
{
	VarEntry req;
	memset(&req, 0, sizeof(req));
	strncpy(req.folder, folder, sizeof(req.folder) - 1);
	strncpy(req.name, name, sizeof(req.name) - 1);
	req.type = NSP_TNS;

	const int ret = ticalcs_calc_recv_var2(calc, MODE_NORMAL, out, &req);
	printf("recv_var2 %s/%s ret=%d size=%u\n", folder, name, ret, req.size);
	return ret;
}

static void strip_tns_extension(char *name)
{
	const size_t len = strlen(name);
	if (len >= 4 && !strcasecmp(name + len - 4, ".tns"))
	{
		name[len - 4] = 0;
	}
}

static int receive_path(CalcHandle *calc, const char *path, unsigned int index)
{
	char folder[FLDNAME_MAX];
	char name[VARNAME_MAX];
	char out[64];
	const char *normalized = path;
	const char *slash;

	if (normalized[0] == '/')
	{
		normalized++;
	}

	slash = strrchr(normalized, '/');
	if (slash != nullptr)
	{
		const size_t folder_len = slash - normalized;
		if (folder_len >= sizeof(folder) || strlen(slash + 1) >= sizeof(name))
		{
			return ERR_INVALID_PARAM;
		}
		memcpy(folder, normalized, folder_len);
		folder[folder_len] = 0;
		snprintf(name, sizeof(name), "%s", slash + 1);
	}
	else
	{
		const char *default_folder = env_or_default("NNSE_SMOKE_FOLDER", "Examples/subfolder/this is deep");
		if (strlen(normalized) >= sizeof(name))
		{
			return ERR_INVALID_PARAM;
		}
		snprintf(folder, sizeof(folder), "%s", default_folder);
		snprintf(name, sizeof(name), "%s", normalized);
	}

	strip_tns_extension(name);
	snprintf(out, sizeof(out), "/tmp/nnse-smoke-%u.tns", index);
	return receive_file(calc, folder, name, out);
}

static int run_receive_list(CalcHandle *calc)
{
	const char *paths = getenv("NNSE_SMOKE_RECEIVES");
	if (paths == nullptr || paths[0] == 0)
	{
		return 0;
	}

	char *copy = strdup(paths);
	if (copy == nullptr)
	{
		return ERR_MALLOC;
	}

	int ret = 0;
	unsigned int index = 1;
	for (char *cur = copy; cur != nullptr && *cur != 0;)
	{
		char *next = strchr(cur, ',');
		if (next != nullptr)
		{
			*next = 0;
		}
		if (*cur != 0)
		{
			ret = receive_path(calc, cur, index++);
			if (ret)
			{
				break;
			}
		}
		cur = next != nullptr ? next + 1 : nullptr;
	}

	free(copy);
	return ret;
}

static int run_sequence(CalcHandle *calc, const char *sequence, const char *folder, const char *file1, const char *file2)
{
	char *copy = strdup(sequence);
	if (copy == nullptr)
	{
		return ERR_MALLOC;
	}

	int ret = 0;
	for (char *cur = copy; cur != nullptr && *cur != 0 && !ret;)
	{
		char *next = strchr(cur, ',');
		if (next != nullptr)
		{
			*next = 0;
		}

		if (!strcmp(cur, "version"))
		{
			ret = run_version(calc);
		}
		else if (!strcmp(cur, "attrs"))
		{
			ret = run_attr_probes(calc);
		}
		else if (!strcmp(cur, "files"))
		{
			ret = run_receive_list(calc);
		}
		else if (!strcmp(cur, "file1"))
		{
			ret = receive_file(calc, folder, file1, "/tmp/nnse-smoke-1.tns");
		}
		else if (!strcmp(cur, "file2"))
		{
			ret = receive_file(calc, folder, file2, "/tmp/nnse-smoke-2.tns");
		}
		else if (!strcmp(cur, "screen"))
		{
			ret = run_screen(calc);
		}
		else if (!strcmp(cur, "key"))
		{
			ret = run_key(calc);
		}
		else if (!strcmp(cur, "dirlist"))
		{
			const unsigned int repeat = env_uint_or_default("NNSE_SMOKE_DIRLIST_REPEAT", 1);
			for (unsigned int i = 0; !ret && i < repeat; i++)
			{
				printf("dirlist iteration %u/%u\n", i + 1, repeat);
				ret = run_dirlist(calc);
			}
		}
		else if (*cur != 0)
		{
			fprintf(stderr, "unknown NNSE_SMOKE_SEQUENCE step: %s\n", cur);
			ret = ERR_INVALID_PARAM;
		}

		cur = next != nullptr ? next + 1 : nullptr;
	}

	free(copy);
	return ret;
}

int main(void)
{
	setvbuf(stdout, nullptr, _IONBF, 0);

	int ret = ticables_library_init();
	if (!ret)
	{
		return 2;
	}
	ret = tifiles_library_init();
	if (!ret)
	{
		return 2;
	}
	ret = ticalcs_library_init();
	if (!ret)
	{
		return 2;
	}

	CableHandle *cable = ticables_handle_new(CABLE_USB, PORT_1);
	CalcHandle *calc = ticalcs_handle_new(CALC_NSPIRE);
	if (cable == nullptr || calc == nullptr)
	{
		return 2;
	}

	ticables_options_set_timeout(cable, 50);

	ret = ticalcs_cable_attach(calc, cable);
	printf("attach ret=%d\n", ret);

	const char *folder = env_or_default("NNSE_SMOKE_FOLDER", "Examples/subfolder/this is deep");
	const char *file1 = env_or_default("NNSE_SMOKE_FILE1", "linalg");
	const char *file2 = env_or_default("NNSE_SMOKE_FILE2", "Copy (2) of linalg");
	const char *sequence = getenv("NNSE_SMOKE_SEQUENCE");

	if (!ret && sequence != nullptr && sequence[0] != 0)
	{
		ret = run_sequence(calc, sequence, folder, file1, file2);
	}
	else if (!ret)
	{
		ret = run_version(calc);
	}

	if ((sequence == nullptr || sequence[0] == 0) && !ret && step_enabled("attrs"))
	{
		ret = run_attr_probes(calc);
	}
	const char *receive_paths = getenv("NNSE_SMOKE_RECEIVES");
	if ((sequence == nullptr || sequence[0] == 0) && !ret && receive_paths != nullptr && receive_paths[0] != 0 && step_enabled("files"))
	{
		ret = run_receive_list(calc);
	}
	else if ((sequence == nullptr || sequence[0] == 0) && !ret && step_enabled("file1"))
	{
		ret = receive_file(calc, folder, file1, "/tmp/nnse-smoke-1.tns");
	}
	if ((sequence == nullptr || sequence[0] == 0) && !ret && (receive_paths == nullptr || receive_paths[0] == 0) && step_enabled("file2"))
	{
		ret = receive_file(calc, folder, file2, "/tmp/nnse-smoke-2.tns");
	}
	if ((sequence == nullptr || sequence[0] == 0) && !ret && step_enabled("screen"))
	{
		ret = run_screen(calc);
	}
	if ((sequence == nullptr || sequence[0] == 0) && !ret && step_enabled("key"))
	{
		ret = run_key(calc);
	}
	if ((sequence == nullptr || sequence[0] == 0) && !ret && step_enabled("dirlist"))
	{
		const unsigned int repeat = env_uint_or_default("NNSE_SMOKE_DIRLIST_REPEAT", 1);
		for (unsigned int i = 0; !ret && i < repeat; i++)
		{
			printf("dirlist iteration %u/%u\n", i + 1, repeat);
			ret = run_dirlist(calc);
		}
	}

	ticalcs_cable_detach(calc);
	ticalcs_handle_del(calc);
	ticables_cable_close(cable);
	ticables_handle_del(cable);

	return ret;
}
