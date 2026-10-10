"""Native CE-LK4 bulk/UART transport for sharp_native.cjs (libusb 1.0).

Control-request values follow Linux drivers/usb/serial/spcp8x5.c. The exact
04fc:0201 SPCP825 variant has NO_UART_STATUS and NO_WORK_MODE quirks.
"""
import ctypes as c
import ctypes.util
import json
import sys
import threading
import time

library = ctypes.util.find_library('usb-1.0')
if not library:
    raise RuntimeError('libusb 1.0 is required (macOS: brew install libusb)')
usb = c.CDLL(library)
usb.libusb_init.argtypes = [c.POINTER(c.c_void_p)]
usb.libusb_open_device_with_vid_pid.argtypes = [c.c_void_p, c.c_uint16, c.c_uint16]
usb.libusb_open_device_with_vid_pid.restype = c.c_void_p
for name in ['libusb_set_configuration', 'libusb_claim_interface', 'libusb_release_interface', 'libusb_clear_halt']:
    getattr(usb, name).argtypes = [c.c_void_p, c.c_int]
usb.libusb_control_transfer.argtypes = [c.c_void_p, c.c_uint8, c.c_uint8, c.c_uint16, c.c_uint16, c.c_void_p, c.c_uint16, c.c_uint]
usb.libusb_bulk_transfer.argtypes = [c.c_void_p, c.c_uint8, c.c_void_p, c.c_int, c.POINTER(c.c_int), c.c_uint]
usb.libusb_close.argtypes = [c.c_void_p]
usb.libusb_exit.argtypes = [c.c_void_p]
usb.libusb_get_configuration.argtypes = [c.c_void_p, c.POINTER(c.c_int)]
ctx = c.c_void_p()
if usb.libusb_init(c.byref(ctx)) < 0:
    raise RuntimeError('libusb initialization failed')
handle = None
running = False
thread = None
lock = threading.Lock()
def emit(data):
    with lock:
        print(json.dumps(data), flush=True)
def check(result):
    if result < 0:
        raise RuntimeError('libusb error ' + str(result))
    return result
def receive():
    while running:
        # Match the CE-LK4's 16-byte IN packets. Larger reads can wait for
        # more UART data while the calculator is waiting for our header ACK.
        buf = c.create_string_buffer(16)
        count = c.c_int()
        result = usb.libusb_bulk_transfer(handle, 0x81, buf, 16, c.byref(count), 100)
        if count.value:
            emit({'rx': buf.raw[:count.value].hex()})
        if result not in (0, -7):
            emit({'error': 'USB read error ' + str(result)})
            break
def close():
    global running, handle
    running = False
    if thread:
        thread.join()
    if handle:
        usb.libusb_release_interface(handle, 0)
        usb.libusb_close(handle)
        handle = None
for line in sys.stdin:
    req = json.loads(line)
    try:
        if req['op'] == 'open':
            if handle:
                raise RuntimeError('CE-LK4 is already open')
            handle = usb.libusb_open_device_with_vid_pid(ctx, 0x04fc, 0x0201)
            if not handle:
                raise RuntimeError('Cannot open CE-LK4')
            configuration = c.c_int()
            check(usb.libusb_get_configuration(handle, c.byref(configuration)))
            if configuration.value != 1:
                check(usb.libusb_set_configuration(handle, 1))
            check(usb.libusb_claim_interface(handle, 0))
            check(usb.libusb_clear_halt(handle, 0x81))
            check(usb.libusb_clear_halt(handle, 0x02))
            # Configuration changes go through libusb / IOKit, never raw
            # SET_CONFIGURATION behind the OS after claiming the interface.
            # Skip unsupported SPCP825 UART-status and working-mode requests.
            baud = {19200: 7, 38400: 9}[req['baud']]
            req_baud, req_stop = req['baud'], req['stop']
            value = baud | ((3 | (4 if req['stop'] == 2 else 0)) << 8)
            check(usb.libusb_control_transfer(handle, 0x40, 0x21, value, 0, None, 0, 1000))
            # Official PC-Link allows one second after UART setup.
            time.sleep(1)
            running = True
            thread = threading.Thread(target=receive)
            thread.start()
        elif req['op'] == 'configure':
            if not handle:
                raise RuntimeError('CE-LK4 is closed')
            baud = {19200: 7, 38400: 9}[req['baud']]
            stop = {1: 0, 2: 4}[req['stop']]
            check(usb.libusb_control_transfer(handle, 0x40, 0x21, baud | ((3 | stop) << 8), 0, None, 0, 1000))
            req_baud, req_stop = req['baud'], req['stop']
        elif req['op'] == 'write':
            if not handle:
                raise RuntimeError('CE-LK4 is closed')
            data = bytes.fromhex(req['hex'])
            buf = c.create_string_buffer(data)
            count = c.c_int()
            wire_seconds = len(data) * (1 + 8 + req_stop) / req_baud
            started = time.monotonic()
            check(usb.libusb_bulk_transfer(handle, 0x02, buf, len(data), c.byref(count), int(wire_seconds * 1000) + 1000))
            if count.value != len(data):
                raise RuntimeError('Partial USB write')
            # Bulk completion means queued by the adapter, not UART drained.
            # Back-to-back final ACK / session-end writes otherwise lose the
            # end on the physical SPCP825. Keep the USB reader running meanwhile.
            time.sleep(max(0, wire_seconds - (time.monotonic() - started)) + 0.005)
        elif req['op'] == 'close':
            close()
        else:
            raise RuntimeError('Unknown operation')
        emit({'id': req['id'], 'ok': True})
    except Exception as exc:
        emit({'id': req['id'], 'error': str(exc)})
close()
usb.libusb_exit(ctx)
