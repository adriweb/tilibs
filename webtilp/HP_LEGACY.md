# Pre-Prime HP linking in WebTILP

WebTILP recognizes USB `03f0:0121`, the identity shared by the HP 39g+,
39gs, 40gs, 48gII, 49g+, and 50g.  This identity is not a model probe: the
browser must present a generic family name unless later protocol evidence can
distinguish the attached calculator.

## Transport

The current Linux `hp4x` entry is a one-port `usb-serial-simple` device:

- [Linux `usb-serial-simple.c`](https://github.com/torvalds/linux/blob/master/drivers/usb/serial/usb-serial-simple.c)
- [HPGCC Linux USB mini-HOWTO](https://github.com/lobakkang/patched-hpgcc-1.1-sdk-for-hp39gs/blob/7fa1503912338ea0fdf1d39eb584770f4d121cd2/Linux-USB-Mini-HOWTO.txt)

The HPGCC guide records configuration/interface 0 as vendor class `ff`, with
two endpoints, and uses the resulting `/dev/ttyUSB*` port.  On systems where
that driver owns the interface, WebTILP falls back from raw WebUSB to
WebSerial.  On systems where the interface is claimable, WebTILP discovers a
bulk IN/OUT endpoint pair from the active USB descriptors instead of assuming
endpoint numbers.  This matches the approach used by
[Hoppi](https://www.hpcalc.org/hp49/pc/link/).  Xcom-HP independently uses
configuration 1/interface 0 and observed bulk IN `0x81`, bulk OUT `0x03`, but
those endpoint addresses are intentionally not hard-coded here.

## Protocol boundary

The HP 50g/49g+/48gII Advanced User's Reference Manual, available from the
[HP calculator literature archive](https://literature.hpcalc.org/), documents:

- `SERVER`: Kermit server mode; `SEND`, `KGET`, `FINISH`/`LOGOUT`, and generic
  directory requests.
- `PKT`: an initialization exchange followed by an arbitrary Kermit packet;
  `"D" "G" PKT` is the documented generic directory request.
- `CKSM`: negotiated one-byte checksum, two-byte checksum, or three-byte CRC.
- `XSERV`: a separate XModem server with `P` (put), `G` (get), `E` (execute),
  `M` (memory), and `L` (list) commands.

The HPGCC guide demonstrates `rdir`, `rhost`, `get`, `send`, and `finish` on a
49g+ showing `Awaiting Server Cmd.`.  The
[Kermit Project's HP transfer guide](https://www.kermitproject.org/hp48filetransfer.html)
adds the important operational constraints: no flow control, prefix control
characters, binary object transfer, and an outbound packet-length cap of 80
bytes for reliable HP 50g reception.

The implemented Kermit path therefore uses classic short packets:

`SOH, LEN, SEQ, TYPE, DATA, CHECK, CR`

It negotiates `MAXL`, `TIME`, `NPAD`, `PADC`, `EOL`, `QCTL`, `QBIN`, `CHKT`,
and `REPT`; supports all three short-packet checksums; quotes control/binary
data; retries NAKs/timeouts; and caps every outgoing packet at 80 bytes.  The
high-level UI exposes directory listing, upload, download, and screenshot
capture.  It does not expose arbitrary `rhost`, delete, or rename commands.

## Targeted RHOST operations

WebTILP uses two fixed RHOST programs internally for capabilities that have a
dedicated UI:

- `VERSION + '<temporary>' STO` stores the two strings returned by `VERSION`
  without clearing or otherwise consuming the user's existing stack. WebTILP
  downloads that object and recognizes the `HP48`, `HP49-C`, and `HP50-C`
  runtime markers used by the 48gII, 49g+, and 50g.
- `SERIAL '<temporary>' STO` stores and downloads the calculator's software
  serial-number string for the Device Info panel. Failure is non-fatal for
  models or ROM versions that do not provide the command.
- `LCD\-> '<temporary>' STO` stores the current LCD GROB, which WebTILP
  downloads and renders through its normal screenshot canvas.

Both paths use a random temporary variable and attempt to purge it after the
download. They accept either the binary memory-image representation or the
`%%HP: T(3)A(R)F(.);` ASCII representation, so WebTILP does not need to alter
the user's flag -35 transfer-format setting. Screenshot capture is a display
feature; its GROB dimensions are not used for calculator identification.

SERVER emits its readiness `N0` only when that session starts. WebTILP opens
the selected USB or serial transport and starts its asynchronous read before
showing the SERVER prompt. Physical HP 50g testing showed that the reliable
order is to dismiss the prompt first and then immediately exit and re-enter
SERVER. That leaves WebTILP's initial `I0` write and bulk-IN read pending when
the fresh server session starts.

The HP 50g directory transaction has a two-stage checksum transition.  The
calculator first announces server readiness with checksum-1 `N0`.  WebTILP
then exchanges an extended 22-byte C-Kermit-compatible `I0`/`Y0`, but the
following `G0` directory command still uses checksum 1.  Only after the
calculator starts the transfer with checksum-1 `S0` and WebTILP acknowledges
with checksum-1 `Y0` do the `X1`, `D`, `Z`, and `B` packets use the negotiated
three-byte CRC.  Switching `G0` to the negotiated CRC early makes the HP 50g
reject the command.

## 39/40-series limitation

The official HP 39gs guide documents USB transfers through the HP
Connectivity Kit, but does not identify Kermit.  Xcom-HP targets this exact
USB identity and implements HP's XModem dialect for both 39g+ and 49g+.
Consequently, WebTILP does not infer that the 39g+/39gs/40gs speak the RPL
Kermit-server contract.  Selecting one of those models creates a
transport-only connection and leaves file operations disabled until the
XModem layer is implemented.

## Physical validation

On 2026-08-27, a physical HP 50g completed a read-only HOME directory listing
through WebUSB on macOS.  The native trace and the production WebTILP UI both
completed the readiness, initialization, generic-command, send-init, and
CRC-3 transfer sequence.  WebTILP rendered these five objects:

- `A` (Integer, `12.B`)
- `IOPAR` (List, `37.5B`)
- `Y1` (Program, `35.5B`)
- `PPAR` (List, `83.B`)
- `CASDIR` (Directory)

Model probing, screenshot capture, upload, download, WebSerial, the HP
48gII/49g+, and the HP 39/40-series paths have not yet been physically
validated. Rename and delete remain deliberately unsupported.
