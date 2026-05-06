#ifdef HAVE_CONFIG_H
#include <config.h>
#endif

#include "evo_cmd.h"

#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <limits.h>

#include "evo_cbor.h"
#include "error.h"
#include "internal.h"

#define EVO_SOH 0x01
#define EVO_CR  0x0D
#define EVO_QCTL 0x23
#define EVO_REPT 0x7E
#define EVO_CHAR_BASE 0x20
#define EVO_SEQ_MOD 64
#define EVO_CHECKSUM_MASK 0x3f
#define EVO_CTL_MASK 0x40
#define EVO_SHORT_BODY_MAX 94
#define EVO_EXT_BODY_BASE 95
#define EVO_MAX_RUN 94
#define EVO_INIT_PAUSE_MS 100
#define EVO_PUT_CHUNK_SIZE 2000
#define EVO_PROGRESS_MIN_SIZE 2048
#define EVO_PROGRESS_REFRESH_CHUNKS 32

static const uint8_t evo_sinit[] = { 0x7e, 0x30, 0x20, 0x40, 0x2d, 0x23, 0x59, 0x31, 0x7e, 0x2e, 0x22, 0x35, 0x4d };

static uint8_t tochar(unsigned int x) { return (uint8_t)(x + EVO_CHAR_BASE); }
static unsigned int unchar(uint8_t x) { return x - EVO_CHAR_BASE; }
static uint8_t ctl(uint8_t x) { return x ^ EVO_CTL_MASK; }

static int evo_progress_count(size_t done, size_t total, int max)
{
	if (total == 0 || max <= 0)
	{
		return 0;
	}
	if (done >= total)
	{
		return max;
	}
	return (int)(((double)done * (double)max) / (double)total);
}

static void evo_progress_start(CalcHandle *handle, size_t total)
{
	ticables_progress_reset(handle->cable);
	handle->updat->cnt1 = 0;
	handle->updat->max1 = total > (size_t)INT_MAX ? INT_MAX : (int)total;
	if (total > EVO_PROGRESS_MIN_SIZE)
	{
		ticalcs_update_pbar(handle);
	}
}

static int evo_progress_update(CalcHandle *handle, size_t done, size_t total, int refresh)
{
	handle->updat->cnt1 = evo_progress_count(done, total, handle->updat->max1);
	if (refresh)
	{
		ticables_progress_get(handle->cable, nullptr, nullptr, &handle->updat->rate);
		if (total > EVO_PROGRESS_MIN_SIZE)
		{
			ticalcs_update_pbar(handle);
		}
	}
	if (ticalcs_update_canceled(handle))
	{
		return ERR_ABORT;
	}
	return 0;
}

static uint8_t evo_checksum(const uint8_t *body, size_t body_len)
{
	unsigned int s = 0;
	for (size_t i = 0; i < body_len; i++)
	{
		s += body[i];
	}
	return tochar((s + ((s >> 6) & 3)) & EVO_CHECKSUM_MASK);
}

static int evo_make_packet(EvoBuffer *pkt, uint8_t seq, char type, const uint8_t *data, size_t len)
{
	EvoBuffer body;
	evo_buffer_init(&body);

	size_t n = len + 3;
	int ret = 0;
	if (n <= EVO_SHORT_BODY_MAX)
	{
		ret = evo_buffer_append_byte(&body, tochar((unsigned int)n));
		if (!ret) ret = evo_buffer_append_byte(&body, tochar(seq % EVO_SEQ_MOD));
		if (!ret) ret = evo_buffer_append_byte(&body, (uint8_t)type);
		if (!ret) ret = evo_buffer_append(&body, data, len);
	}
	else
	{
		size_t dlen = len + 1;
		ret = evo_buffer_append_byte(&body, tochar(0));
		if (!ret) ret = evo_buffer_append_byte(&body, tochar(seq % EVO_SEQ_MOD));
		if (!ret) ret = evo_buffer_append_byte(&body, (uint8_t)type);
		if (!ret) ret = evo_buffer_append_byte(&body, tochar((unsigned int)(dlen / EVO_EXT_BODY_BASE)));
		if (!ret) ret = evo_buffer_append_byte(&body, tochar((unsigned int)(dlen % EVO_EXT_BODY_BASE)));
		if (!ret) ret = evo_buffer_append_byte(&body, evo_checksum(body.data, body.size));
		if (!ret) ret = evo_buffer_append(&body, data, len);
	}

	if (!ret) ret = evo_buffer_append_byte(pkt, EVO_SOH);
	if (!ret) ret = evo_buffer_append(pkt, body.data, body.size);
	if (!ret) ret = evo_buffer_append_byte(pkt, evo_checksum(body.data, body.size));
	if (!ret) ret = evo_buffer_append_byte(pkt, EVO_CR);

	evo_buffer_free(&body);
	return ret;
}

static int evo_recv_append(CalcHandle *handle, EvoBuffer *raw, size_t len);
static int evo_recv_byte(CalcHandle *handle, EvoBuffer *raw, uint8_t *byte);

static int evo_recv_raw(CalcHandle *handle, EvoBuffer *raw)
{
	raw->size = 0;
	uint8_t b = 0;
	for (;;)
	{
		int ret = evo_recv_byte(handle, raw, &b);
		if (ret) return ret;
		if (b == EVO_SOH)
		{
			break;
		}
		raw->size = 0;
	}

	int ret = evo_recv_byte(handle, raw, &b);
	if (ret) return ret;
	if (b < EVO_CHAR_BASE)
	{
		return ERR_INVALID_PACKET;
	}

	if (b != tochar(0))
	{
		const size_t body_len = unchar(b);
		if (body_len < 3)
		{
			return ERR_INVALID_PACKET;
		}
		ret = evo_recv_append(handle, raw, body_len + 1);
		if (ret) return ret;
	}
	else
	{
		ret = evo_recv_append(handle, raw, 4);
		if (ret) return ret;
		const size_t data_len = unchar(raw->data[4]) * EVO_EXT_BODY_BASE + unchar(raw->data[5]);
		if (data_len == 0)
		{
			return ERR_INVALID_PACKET;
		}
		ret = evo_recv_append(handle, raw, data_len + 2);
		if (ret) return ret;
	}

	return raw->size > 0 && raw->data[raw->size - 1] == EVO_CR ? 0 : ERR_INVALID_PACKET;
}

static int evo_parse_packet(const EvoBuffer *raw, uint8_t *seq, char *type, EvoBuffer *data)
{
	if (raw->size < 5 || raw->data[0] != EVO_SOH || raw->data[raw->size - 1] != EVO_CR)
	{
		return ERR_INVALID_PACKET;
	}

	const uint8_t *body = raw->data + 1;
	size_t body_len = raw->size - 2;
	int ext = body[0] == tochar(0);
	if (body_len < (ext ? 7U : 4U))
	{
		return ERR_INVALID_PACKET;
	}

	*seq = (uint8_t)unchar(body[1]);
	*type = (char)body[2];
	size_t off = ext ? 6 : 3;
	size_t end = body_len - 1;
	data->size = 0;
	return evo_buffer_append(data, body + off, end - off);
}

static int evo_send_packet(CalcHandle *handle, uint8_t seq, char type, const uint8_t *data, size_t len)
{
	EvoBuffer pkt;
	evo_buffer_init(&pkt);
	int ret = evo_make_packet(&pkt, seq, type, data, len);
	if (ret)
	{
		evo_buffer_free(&pkt);
		return ret;
	}

	for (int attempt = 0; attempt < 3; attempt++)
	{
		ret = ticables_cable_send(handle->cable, pkt.data, (uint32_t)pkt.size);
		if (ret) break;

		EvoBuffer raw;
		EvoBuffer rdata;
		evo_buffer_init(&raw);
		evo_buffer_init(&rdata);
		uint8_t rseq = 0;
		char rtype = 0;
		ret = evo_recv_raw(handle, &raw);
		if (!ret) ret = evo_parse_packet(&raw, &rseq, &rtype, &rdata);
		evo_buffer_free(&raw);
		evo_buffer_free(&rdata);
		if (ret) break;
		if (rtype == 'Y')
		{
			evo_buffer_free(&pkt);
			return 0;
		}
		if (rtype == 'E')
		{
			evo_buffer_free(&pkt);
			return ERR_CALC_ERROR2;
		}
	}

	evo_buffer_free(&pkt);
	return ret ? ret : ERR_NACK;
}

static int evo_recv_append(CalcHandle *handle, EvoBuffer *raw, size_t len)
{
	const size_t old_size = raw->size;
	int ret = evo_buffer_reserve(raw, old_size + len);
	if (ret)
	{
		return ret;
	}
	ret = ticables_cable_recv(handle->cable, raw->data + old_size, (uint32_t)len);
	if (ret)
	{
		return ret;
	}
	raw->size += len;
	return 0;
}

static int evo_recv_byte(CalcHandle *handle, EvoBuffer *raw, uint8_t *byte)
{
	int ret = ticables_cable_recv(handle->cable, byte, 1);
	if (ret)
	{
		return ret;
	}
	return evo_buffer_append_byte(raw, *byte);
}

static int evo_ack(CalcHandle *handle, uint8_t seq, const uint8_t *data, size_t data_len)
{
	EvoBuffer pkt;
	evo_buffer_init(&pkt);
	int ret = evo_make_packet(&pkt, seq, 'Y', data, data_len);
	if (!ret)
	{
		ret = ticables_cable_send(handle->cable, pkt.data, (uint32_t)pkt.size);
	}
	evo_buffer_free(&pkt);
	return ret;
}

static int encode_byte(uint8_t b, EvoBuffer *out)
{
	if ((b & 0x7f) < 0x20 || (b & 0x7f) == 0x7f)
	{
		int ret = evo_buffer_append_byte(out, EVO_QCTL);
		if (!ret) ret = evo_buffer_append_byte(out, ctl(b));
		return ret;
	}
	if (b == EVO_QCTL || b == EVO_REPT)
	{
		int ret = evo_buffer_append_byte(out, EVO_QCTL);
		if (!ret) ret = evo_buffer_append_byte(out, b);
		return ret;
	}
	return evo_buffer_append_byte(out, b);
}

static int evo_encode(EvoBuffer *out, const uint8_t *data, size_t len)
{
	int ret = evo_buffer_reserve(out, out->size + len * 2);
	if (ret) return ret;

	for (size_t i = 0; i < len;)
	{
		size_t run = 1;
		while (i + run < len && data[i + run] == data[i] && run < EVO_MAX_RUN)
		{
			run++;
		}
		if (run >= 3)
		{
			ret = evo_buffer_append_byte(out, EVO_REPT);
			if (!ret) ret = evo_buffer_append_byte(out, tochar((unsigned int)run));
			if (!ret) ret = encode_byte(data[i], out);
			if (ret) return ret;
		}
		else
		{
			for (size_t j = 0; j < run; j++)
			{
				ret = encode_byte(data[i], out);
				if (ret) return ret;
			}
		}
		i += run;
	}
	return 0;
}

static size_t evo_encoded_element_len(const uint8_t *data, size_t size, size_t off)
{
	if (off >= size)
	{
		return 0;
	}
	if (data[off] == EVO_REPT && off + 2 < size)
	{
		size_t pos = off + 2;
		if (data[pos] == EVO_QCTL && pos + 1 < size)
		{
			return pos + 2 - off;
		}
		return pos + 1 - off;
	}
	if (data[off] == EVO_QCTL && off + 1 < size)
	{
		return 2;
	}
	return 1;
}

static size_t evo_put_chunk_len(const EvoBuffer *wire, size_t off)
{
	size_t len = 0;
	while (off + len < wire->size && len < EVO_PUT_CHUNK_SIZE)
	{
		const size_t elem = evo_encoded_element_len(wire->data, wire->size, off + len);
		if (elem == 0)
		{
			break;
		}
		len += elem;
	}
	return len ? len : wire->size - off;
}

static uint8_t evo_unctl(uint8_t b)
{
	return ((b & 0x7f) == EVO_CHECKSUM_MASK || (b & 0x60) == EVO_CTL_MASK) ? (b ^ EVO_CTL_MASK) : b;
}

static int evo_decode(EvoBuffer *out, const EvoBuffer *data)
{
	for (size_t i = 0; i < data->size;)
	{
		size_t count = 1;
		if (data->data[i] == EVO_REPT && i + 2 < data->size)
		{
			count = unchar(data->data[i + 1]);
			i += 2;
		}
		uint8_t b = data->data[i++];
		if (b == EVO_QCTL && i < data->size)
		{
			b = evo_unctl(data->data[i++]);
		}
		int ret = evo_buffer_reserve(out, out->size + count);
		if (ret) return ret;
		for (size_t j = 0; j < count; j++)
		{
			ret = evo_buffer_append_byte(out, b);
			if (ret) return ret;
		}
	}
	return 0;
}

static int evo_file_attr(EvoBuffer *out, const char *tag, const char *value)
{
	size_t len = strlen(value);
	int ret = evo_buffer_append_byte(out, (uint8_t)tag[0]);
	if (!ret) ret = evo_buffer_append_byte(out, tochar((unsigned int)len));
	if (!ret) ret = evo_buffer_append(out, (const uint8_t *)value, len);
	return ret;
}

int evo_get_request(CalcHandle *handle, const char *url, uint8_t **payload, size_t *payload_len)
{
	if (payload == nullptr || payload_len == nullptr)
	{
		return ERR_INVALID_PARAMETER;
	}
	*payload = nullptr;
	*payload_len = 0;

	ticables_cable_reset(handle->cable);
	PAUSE(EVO_INIT_PAUSE_MS);

	EvoBuffer attrs;
	evo_buffer_init(&attrs);
	int ret = evo_file_attr(&attrs, "\"", "B8");
	if (!ret) ret = evo_file_attr(&attrs, "1", "1");
	if (!ret) ret = evo_file_attr(&attrs, "@", "");
	if (ret)
	{
		evo_buffer_free(&attrs);
		return ret;
	}

	uint8_t dummy = 0x68;
	uint8_t seq = 0;
	ret = evo_send_packet(handle, seq++, 'S', evo_sinit, sizeof(evo_sinit));
	if (!ret) ret = evo_send_packet(handle, seq++, 'F', (const uint8_t *)url, strlen(url));
	if (!ret) ret = evo_send_packet(handle, seq++, 'A', attrs.data, attrs.size);
	if (!ret) ret = evo_send_packet(handle, seq++, 'D', &dummy, 1);
	if (!ret) ret = evo_send_packet(handle, seq++, 'Z', nullptr, 0);
	if (!ret) ret = evo_send_packet(handle, seq++, 'B', nullptr, 0);
	evo_buffer_free(&attrs);
	if (ret) return ret;

	EvoBuffer raw;
	EvoBuffer rdata;
	EvoBuffer chunks;
	EvoBuffer decoded;
	evo_buffer_init(&raw);
	evo_buffer_init(&rdata);
	evo_buffer_init(&chunks);
	evo_buffer_init(&decoded);
	uint8_t rseq = 0;
	char rtype = 0;
	for (;;)
	{
		ret = evo_recv_raw(handle, &raw);
		if (!ret) ret = evo_parse_packet(&raw, &rseq, &rtype, &rdata);
		if (!ret) ret = evo_ack(handle, rseq, rtype == 'S' ? rdata.data : nullptr, rtype == 'S' ? rdata.size : 0);
		if (ret) break;
		if (rtype == 'D')
		{
			ret = evo_buffer_append(&chunks, rdata.data, rdata.size);
			if (ret) break;
		}
		else if (rtype == 'B')
		{
			ret = evo_decode(&decoded, &chunks);
			if (!ret)
			{
				*payload = decoded.data;
				*payload_len = decoded.size;
				evo_buffer_init(&decoded);
			}
			break;
		}
		raw.size = 0;
		rdata.size = 0;
	}

	evo_buffer_free(&raw);
	evo_buffer_free(&rdata);
	evo_buffer_free(&chunks);
	evo_buffer_free(&decoded);
	return ret;
}

static int evo_put_request_internal(CalcHandle *handle, const char *url, const uint8_t *payload, size_t payload_len, int ignore_final_status)
{
	ticables_cable_reset(handle->cable);
	PAUSE(EVO_INIT_PAUSE_MS);

	EvoBuffer wire;
	EvoBuffer attrs;
	evo_buffer_init(&wire);
	evo_buffer_init(&attrs);

	int ret = evo_encode(&wire, payload, payload_len);
	char sizebuf[32];
	snprintf(sizebuf, sizeof(sizebuf), "%zu", payload_len);
	if (!ret) ret = evo_file_attr(&attrs, "\"", "B8");
	if (!ret) ret = evo_file_attr(&attrs, "1", sizebuf);
	if (!ret) ret = evo_file_attr(&attrs, "@", "");
	if (ret)
	{
		evo_buffer_free(&wire);
		evo_buffer_free(&attrs);
		return ret;
	}

	uint8_t seq = 0;
	ret = evo_send_packet(handle, seq++, 'S', evo_sinit, sizeof(evo_sinit));
	if (!ret) ret = evo_send_packet(handle, seq++, 'F', (const uint8_t *)url, strlen(url));
	if (!ret) ret = evo_send_packet(handle, seq++, 'A', attrs.data, attrs.size);
	if (!ret) evo_progress_start(handle, payload_len);
	size_t chunk_count = 0;
	for (size_t off = 0; !ret && off < wire.size;)
	{
		const size_t chunk = evo_put_chunk_len(&wire, off);
		ret = evo_send_packet(handle, seq++, 'D', wire.data + off, chunk);
		off += chunk;
		chunk_count++;
		if (!ret)
		{
			const size_t done = wire.size == 0 ? payload_len : (size_t)(((double)off * (double)payload_len) / (double)wire.size);
			const int refresh = (chunk_count % EVO_PROGRESS_REFRESH_CHUNKS) == 0 || off >= wire.size;
			ret = evo_progress_update(handle, done, payload_len, refresh);
		}
	}
	if (!ret && payload_len > 0)
	{
		ret = evo_progress_update(handle, payload_len, payload_len, 1);
	}
	if (!ret) ret = evo_send_packet(handle, seq++, 'Z', nullptr, 0);
	if (!ret)
	{
		const int final_ret = evo_send_packet(handle, seq++, 'B', nullptr, 0);
		ret = ignore_final_status ? 0 : final_ret;
	}

	evo_buffer_free(&wire);
	evo_buffer_free(&attrs);
	return ret;
}

int evo_put_request(CalcHandle *handle, const char *url, const uint8_t *payload, size_t payload_len)
{
	return evo_put_request_internal(handle, url, payload, payload_len, 0);
}

int evo_put_request_ignore_final_status(CalcHandle *handle, const char *url, const uint8_t *payload, size_t payload_len)
{
	return evo_put_request_internal(handle, url, payload, payload_len, 1);
}
