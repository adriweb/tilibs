#ifdef HAVE_CONFIG_H
#include <config.h>
#endif

#include "webserial.h"

#if defined(__EMSCRIPTEN__)
# include <emscripten.h>

EM_ASYNC_JS(int, webserial_has_authorized_evo_js, (), {
	if (!navigator.serial) {
		return 0;
	}
	try {
		const ports = await navigator.serial.getPorts();
		for (const port of ports) {
			const info = port.getInfo ? port.getInfo() : {};
			if (info.usbVendorId === 0x0451 && info.usbProductId === 0xE018) {
				return 1;
			}
		}
	} catch (e) {
		console.warn("[ticables] WebSerial getPorts failed", e);
	}
	return 0;
});

EM_JS(int, webserial_has_bound_kind_js, (int kind), {
	const state = Module.__ticablesWebSerial;
	if (!state || !state.port) {
		return 0;
	}
	if ((state.kind | 0) !== (kind | 0)) {
		return 0;
	}
	return 1;
});

EM_JS(int, webserial_has_bound_evo_js, (), {
	const state = Module.__ticablesWebSerial;
	if (!state || !state.port || (state.kind | 0) !== 1 || !state.port.getInfo) {
		return 0;
	}
	const info = state.port.getInfo();
	return info.usbVendorId === 0x0451 && info.usbProductId === 0xE018 ? 1 : 0;
});

EM_ASYNC_JS(int, webserial_open_js, (int kind, int baud_rate, int data_bits, int stop_bits, int require_signals, int vid, int pid), {
	if (!navigator.serial) {
		return -1;
	}

	const getState = () => {
		if (!Module.__ticablesWebSerial) {
			Module.__ticablesWebSerial = {};
		}
		const state = Module.__ticablesWebSerial;
		if (!Array.isArray(state.queue)) {
			state.queue = [];
		}
		if (!Array.isArray(state.waiters)) {
			state.waiters = [];
		}
		if (typeof state.queuedBytes !== "number") {
			state.queuedBytes = 0;
		}
		state.port = state.port || null;
		state.reader = state.reader || null;
		state.writer = state.writer || null;
		state.running = !!state.running;
		state.error = state.error || null;
		state.kind = state.kind | 0;
		return state;
	};

	const state = getState();
	const notify = () => {
		const waiters = state.waiters.splice(0, state.waiters.length);
		for (const waiter of waiters) {
			waiter();
		}
	};
	const isTransientReadError = (error) => {
		if ((state.kind | 0) !== 2 || !error) {
			return false;
		}
		const name = String(error.name || "");
		const message = String(error.message || "");
		return name === "BreakError"
			|| name === "FramingError"
			|| name === "ParityError"
			|| name === "BufferOverrunError"
			|| message.includes("Break received")
			|| message.includes("Framing error")
			|| message.includes("Parity error")
			|| message.includes("Buffer overrun");
	};
	const clearIo = async (closePort) => {
		state.running = false;
		try {
			if (state.reader) {
				await state.reader.cancel();
			}
		} catch (e) {}
		try {
			if (state.reader) {
				state.reader.releaseLock();
			}
		} catch (e) {}
		state.reader = null;
		try {
			if (state.writer) {
				await state.writer.close();
			}
		} catch (e) {}
		try {
			if (state.writer) {
				state.writer.releaseLock();
			}
		} catch (e) {}
		state.writer = null;
		if (closePort) {
			try {
				if (state.port && (state.port.readable || state.port.writable)) {
					await state.port.close();
				}
			} catch (e) {}
			state.port = null;
			state.kind = 0;
		}
		state.queue = [];
		state.queuedBytes = 0;
		state.error = null;
		notify();
	};
	const startPump = () => {
		if (state.running || !state.port || !state.port.readable) {
			return;
		}
		state.running = true;
		state.error = null;
		state.reader = state.port.readable.getReader();
		(async () => {
			let restart = false;
			try {
				while (state.running) {
					const result = await state.reader.read();
					if (result.done) {
						break;
					}
					if (result.value && result.value.length) {
						state.queue.push({ data: result.value, off: 0 });
						state.queuedBytes += result.value.length;
						notify();
					}
				}
			} catch (e) {
				if (state.running && isTransientReadError(e)) {
					restart = true;
				} else {
					state.error = e;
					console.warn("[ticables] WebSerial read pump failed", e);
				}
			} finally {
				state.running = false;
				try {
					if (state.reader) {
						state.reader.releaseLock();
					}
				} catch (e) {}
				state.reader = null;
				notify();
			}
			if (restart && state.port && (state.kind | 0) === 2) {
				setTimeout(startPump, 10);
			}
		})();
	};

	try {
		let port = null;
		if (state.port && state.kind === (kind | 0)) {
			port = state.port;
		}
		if (!port && (kind | 0) === 1) {
			const ports = await navigator.serial.getPorts();
			for (const candidate of ports) {
				const info = candidate.getInfo ? candidate.getInfo() : {};
				if (info.usbVendorId === (vid | 0) && info.usbProductId === (pid | 0)) {
					port = candidate;
					break;
				}
			}
		}
		if (!port) {
			return -1;
		}
		if ((kind | 0) === 1) {
			const info = port.getInfo ? port.getInfo() : {};
			if (info.usbVendorId !== (vid | 0) || info.usbProductId !== (pid | 0)) {
				return -1;
			}
		}
		if (require_signals && (typeof port.setSignals !== "function" || typeof port.getSignals !== "function")) {
			return -3;
		}

		if (state.port !== port || state.kind !== (kind | 0)) {
			await clearIo(!!state.port && state.port !== port);
			state.port = port;
			state.kind = kind | 0;
		}

		if (!state.port.readable || !state.port.writable) {
			const openOptions = {
				baudRate: baud_rate | 0,
				dataBits: data_bits | 0,
				stopBits: stop_bits | 0,
				parity: "none",
				flowControl: "none"
			};
			let lastError = null;
			for (let attempt = 0; attempt < 5 && (!state.port.readable || !state.port.writable); attempt++) {
				try {
					await state.port.open(openOptions);
					lastError = null;
					break;
				} catch (e) {
					lastError = e;
					console.warn(`[ticables] WebSerial open attempt ${attempt + 1} failed`, e);
					await clearIo(false);
					try {
						if (state.port && (state.port.readable || state.port.writable)) {
							await state.port.close();
						}
					} catch (closeError) {}
					await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
				}
			}
			if (!state.port.readable || !state.port.writable) {
				throw lastError || new Error("WebSerial port did not open");
			}
		}
		if (!state.writer) {
			state.writer = state.port.writable.getWriter();
		}
		startPump();
		return 0;
	} catch (e) {
		console.warn("[ticables] WebSerial open failed", e);
		return -1;
	}
});

EM_ASYNC_JS(int, webserial_close_js, (int kind), {
	const state = Module.__ticablesWebSerial;
	if (!state || ((state.kind | 0) !== (kind | 0))) {
		return 0;
	}
	state.running = false;
	try {
		if (state.reader) {
			await state.reader.cancel();
		}
	} catch (e) {}
	try {
		if (state.reader) {
			state.reader.releaseLock();
		}
	} catch (e) {}
	state.reader = null;
	try {
		if (state.writer) {
			await state.writer.close();
		}
	} catch (e) {}
	try {
		if (state.writer) {
			state.writer.releaseLock();
		}
	} catch (e) {}
	state.writer = null;
	try {
		if (state.port && (state.port.readable || state.port.writable)) {
			await state.port.close();
		}
	} catch (e) {
		console.warn("[ticables] WebSerial close failed", e);
		return -1;
	}
	state.port = null;
	state.kind = 0;
	state.queue = [];
	state.queuedBytes = 0;
	state.waiters = [];
	state.error = null;
	return 0;
});

EM_JS(int, webserial_reset_js, (int kind), {
	const state = Module.__ticablesWebSerial;
	if (!state || ((state.kind | 0) !== (kind | 0))) {
		return -1;
	}
	state.queue = [];
	state.queuedBytes = 0;
	state.error = null;
	const waiters = Array.isArray(state.waiters) ? state.waiters.splice(0, state.waiters.length) : [];
	for (const waiter of waiters) {
		waiter();
	}
	return 0;
});

EM_ASYNC_JS(int, webserial_write_js, (int kind, const uint8_t *data, int len), {
	const state = Module.__ticablesWebSerial;
	if (!state || ((state.kind | 0) !== (kind | 0)) || !state.writer || len < 0) {
		return -1;
	}
	try {
		const bytes = HEAPU8.slice(data, data + len);
		await state.writer.write(bytes);
		return len;
	} catch (e) {
		console.warn("[ticables] WebSerial write failed", e);
		return -1;
	}
});

EM_ASYNC_JS(int, webserial_read_js, (int kind, uint8_t *data, int len, int timeout_ms), {
	const state = Module.__ticablesWebSerial;
	if (!state || ((state.kind | 0) !== (kind | 0)) || len < 0) {
		return -1;
	}
	const dequeue = () => {
		let copied = 0;
		while (copied < len && state.queue.length) {
			const chunk = state.queue[0];
			const take = Math.min(len - copied, chunk.data.length - chunk.off);
			HEAPU8.set(chunk.data.subarray(chunk.off, chunk.off + take), data + copied);
			chunk.off += take;
			copied += take;
			state.queuedBytes -= take;
			if (chunk.off >= chunk.data.length) {
				state.queue.shift();
			}
		}
		return copied;
	};
	let copied = dequeue();
	if (copied > 0 || len === 0) {
		return copied;
	}
	if (state.error) {
		return -1;
	}
	let timer = null;
	const woke = await new Promise((resolve) => {
		const waiter = () => {
			if (timer !== null) {
				clearTimeout(timer);
			}
			resolve(1);
		};
		state.waiters.push(waiter);
		timer = setTimeout(() => {
			const idx = state.waiters.indexOf(waiter);
			if (idx >= 0) {
				state.waiters.splice(idx, 1);
			}
			resolve(0);
		}, Math.max(1, timeout_ms));
	});
	if (!woke) {
		return -2;
	}
	copied = dequeue();
	if (copied > 0) {
		return copied;
	}
	return state.error ? -1 : -2;
});

EM_JS(int, webserial_available_js, (int kind), {
	const state = Module.__ticablesWebSerial;
	return state && ((state.kind | 0) === (kind | 0)) ? state.queuedBytes | 0 : 0;
});

EM_ASYNC_JS(int, webserial_set_signals_js, (int kind, int signals), {
	const state = Module.__ticablesWebSerial;
	if (!state || ((state.kind | 0) !== (kind | 0)) || !state.port || typeof state.port.setSignals !== "function") {
		return -1;
	}
	try {
		await state.port.setSignals({
			dataTerminalReady: !!(signals & 1),
			requestToSend: !!(signals & 2)
		});
		return 0;
	} catch (e) {
		console.warn("[ticables] WebSerial setSignals failed", e);
		return -1;
	}
});

EM_ASYNC_JS(int, webserial_get_signals_js, (int kind), {
	const state = Module.__ticablesWebSerial;
	if (!state || ((state.kind | 0) !== (kind | 0)) || !state.port || typeof state.port.getSignals !== "function") {
		return -1;
	}
	try {
		const signals = await state.port.getSignals();
		return (signals.clearToSend ? 1 : 0) | (signals.dataSetReady ? 2 : 0);
	} catch (e) {
		console.warn("[ticables] WebSerial getSignals failed", e);
		return -1;
	}
});

int webserial_has_authorized_evo(void)
{
	return webserial_has_authorized_evo_js();
}

int webserial_has_bound_evo(void)
{
	return webserial_has_bound_evo_js();
}

int webserial_has_bound_kind(WebSerialKind kind)
{
	return webserial_has_bound_kind_js((int)kind);
}

int webserial_open(WebSerialKind kind, int baud_rate, int data_bits, int stop_bits, int require_signals, uint16_t vid, uint16_t pid)
{
	return webserial_open_js((int)kind, baud_rate, data_bits, stop_bits, require_signals, (int)vid, (int)pid);
}

int webserial_close(WebSerialKind kind)
{
	return webserial_close_js((int)kind);
}

int webserial_reset(WebSerialKind kind)
{
	return webserial_reset_js((int)kind);
}

int webserial_write(WebSerialKind kind, const uint8_t *data, int len)
{
	return webserial_write_js((int)kind, data, len);
}

int webserial_read(WebSerialKind kind, uint8_t *data, int len, int timeout_ms)
{
	return webserial_read_js((int)kind, data, len, timeout_ms);
}

int webserial_available(WebSerialKind kind)
{
	return webserial_available_js((int)kind);
}

int webserial_set_signals(WebSerialKind kind, int signals)
{
	return webserial_set_signals_js((int)kind, signals);
}

int webserial_get_signals(WebSerialKind kind)
{
	return webserial_get_signals_js((int)kind);
}

#else

int webserial_has_authorized_evo(void) { return 0; }
int webserial_has_bound_evo(void) { return 0; }
int webserial_has_bound_kind(WebSerialKind kind) { (void)kind; return 0; }
int webserial_open(WebSerialKind kind, int baud_rate, int data_bits, int stop_bits, int require_signals, uint16_t vid, uint16_t pid)
{
	(void)kind, (void)baud_rate, (void)data_bits, (void)stop_bits, (void)require_signals, (void)vid, (void)pid;
	return -1;
}
int webserial_close(WebSerialKind kind) { (void)kind; return -1; }
int webserial_reset(WebSerialKind kind) { (void)kind; return -1; }
int webserial_write(WebSerialKind kind, const uint8_t *data, int len) { (void)kind, (void)data, (void)len; return -1; }
int webserial_read(WebSerialKind kind, uint8_t *data, int len, int timeout_ms) { (void)kind, (void)data, (void)len, (void)timeout_ms; return -1; }
int webserial_available(WebSerialKind kind) { (void)kind; return 0; }
int webserial_set_signals(WebSerialKind kind, int signals) { (void)kind, (void)signals; return -1; }
int webserial_get_signals(WebSerialKind kind) { (void)kind; return -1; }

#endif
