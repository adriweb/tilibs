# Sharp EL-99xx support

WebTILP uses a standalone JavaScript backend for EL-9900, EL-9900G,
EL-9900G SII and EL-9950. The Sunplus cable is `04FC:0201` (Windows:
“Sunplus USB to Serial COM Port”). WebUSB selects the cable only; WebSerial
carries the data through the operating system's serial driver. Do not replace
that driver with WinUSB. Other USB IDs and browser USB-serial shims are not
assumed compatible. A browser with WebSerial is required.

Choose the exact Sharp model in **Settings → Calculator model**, or select the
Sunplus cable in the normal Connect chooser. The exact setting goes directly
to WebSerial. Multiple authorized matching ports require a chooser. If a
chained chooser loses browser user activation, click Connect again to authorize
the serial port. Connection opens the transport without probing: this keeps the
REPROGRAM handshake available. Normal operations require the calculator's
PC-Link mode. No calculator flash-writing commands are exposed.

Normal operations support native variable listing/upload/download, screenshots,
native RAM backup/restore, and version reception on SII/9950. Files use Sharp's
`g4p/e/s/y/m/i/d/l/n/v/z/w/t/b` formats, including on EL-9950. Groups, text,
token/source editing, delete/rename, folders, keys and clock setting are not
implemented. Normal operations are serialized; a timeout, disconnect or
protocol failure closes the serial port. Restart PC-Link and reconnect before
retrying. Emergency Reset cancels the connection and any pending grant.

## Firmware evidence

The supplied files map to `F00000–FFFFFF`; system ends at `FFC000`, followed
by a shared 16 KiB boot region. No ROM is distributed in this repository.

| Input | Version bytes at FFBFE4 | SHA-256 |
|---|---|---|
| el9900_1.09_and_boot.bin | 01 09 | 3b9a9599c49d915fcce9dd23315d5e23540edaa508dcf8c3034b370ab93e776c |
| el9900g_3.01_and_boot.bin | 03 01 | f1c62cdfbeda144a7c32333a501823469fa705ffb19353c49a9a8d3baa79b0fb |
| el9900gs2_4.10_and_boot.bin | 04 10 | eb3dd761732315df152ac98bb43cfa412e46b4ac15cab847ce944d69f219d37a |
| el9950_1.20_and_boot.bin | 01 20 | deae0913c635b02e5b273db20905fa57993ec035edb7cbf78f08f9bc79f42082 |

Boot SHA-256:
`4cd06363e65f4814bb05808e4e854c48383eaa523ed3e500c33b630542418ed5`.
The REPROGRAM core `F3CC02–F3CE97` is byte-identical across all four inputs.

Disassembly used the local TLCS-900/L1 decoder (`tlcs900-dasm ROM START END`)
and traced calls, conditional branches, buffer pointers and lengths, rather
than treating strings as a protocol specification. The following addresses are
from EL-9950 1.20; common PC-Link handlers also occur at those addresses in the
other supplied ROMs. Dispatcher return targets differ: older models return to
`F7AFDD`, SII/9950 to `F9265D`. Command `74` is in the extended dispatcher only.

| Operation | Handler / evidence |
|---|---|
| Dispatch and session 42/41 | F7AFE6, F7B09E, F7B0AB; extended F92666 |
| Sender identity / frames | F7BCD8–F7BEBE; identity read F7BDFF |
| Framed ACK | F7BDD6 |
| Directory 61 | F7B712–F7B85C; empty-entry filtering F7BCA4 |
| Variable download 62 | F7B8FF–F7BA5E |
| Variable upload 22 | F7B34B onward |
| Screenshot 63 | F7B85D–F7B8FE, source RAM40116B |
| Native backup 67 | F7ACC3, RAM401CD5, length E32B |
| Native restore 27 | F7AD55–F7ADA8 |
| Fixed blocks 68/69/6A/6B | F7BA5F/F7BAEA/F7BB8E/F7BC19 |
| Version 74 | F927A9; six ASCII digits, no host ACK |
| Serial initialization | F7AFB9 calls FFEECA with A=0 |
| REPROGRAM | F3CC02–F3CE97, supplied sharp-receiver implementation |

## PC-Link wire framing

`sender[2] + payload[known length] + additive checksum LE16`.
The checksum includes sender bytes and payload. Host sender is ASCII `11`;
EL-9900 variants send `99`, EL-9950 sends `9:`. There is no common packet
length field: each command state determines the next payload length.

ACK is a **framed** single-byte `01`, not a raw byte. `81` requests retransmission;
`82`, `83`, `84` signal rejection/error (84 is insufficient memory). The backend
bounds complete-frame retransmission and checksum retries to three attempts.
It never replays an uncertain or partially failed serial write.

Normal serial settings are **38400, 8 data bits, no parity, 2 stop bits**.
This was checked against the boot serial setup and Sharp PC-Link's
`SetCommState` configuration: EL-9900G SII PC-LINK.EXE RVA `2A29` stores 38400,
`2A35` stores ByteSize=8 and `2A3A` stores StopBits=2 (`TWOSTOPBITS`).
REPROGRAM separately uses 8N1.

The host begins a normal operation with `42 → ACK`, then ends with `41 → ACK`.
Restore can exit PC-Link after its final ACK because the restored RAM includes
session state; no extra end command is sent after native restore.

All numeric lengths below are little-endian. Each listed command, metadata or
body is its own checked frame unless explicitly combined.

```
61 → ACK
category11 → ACK
← 21; host ACK
← category11; host ACK
← count8 + count×descriptor11; host ACK

62 → ACK
category11 → ACK
selector11 → [optional ACK] ← 22; host ACK
← category11 + objectLength32; host ACK
← complete RAM object; host ACK

22 → ACK
category11 + objectLength32 → ACK
complete RAM object → ACK

63 → ACK
← 23; host ACK
← width16=132 + height16=64; host ACK
← 1056 bitmap bytes; host ACK

67 → ACK
← 27; host ACK
← length32=E32B; host ACK
← E32B RAM bytes; host ACK

27 → ACK
length32=E32B → ACK
E32B RAM bytes → ACK
```

The optional ACK after a variable selector is controlled by RAM4033E7 bit0 at
`F7B9B0`; both branches are accepted. Directory descriptors contain selectors,
not reliable byte sizes, so directory sizes are shown as unknown. Empty fixed
objects are filtered by the firmware. Lists are a MATRIX-category subtype
(selector high byte `08`), not a separate LIST directory. Known categories are
`PROGRAM`, `SOLVE EQU`, `ANIME`, `GRAPH EQU`, `MATRIX`, `PICT`, `GDB`, `LISTDB`,
space-padded to 11 bytes. Fixed descriptors start with a LE16 selector; dynamic
descriptors start with eight name bytes.

The fixed RAM blocks use `command → ACK`, calculator replies
`command-40 → host ACK`, then a length frame and body frame, each acknowledged.
Sending uses `command-40`, length and body, each acknowledged.

| Command | Native type | Body size |
|---|---|---|
| 68 / 28 | Variables (v) | 486 |
| 69 / 29 | Zoom (z) | 19 |
| 6A / 2A | Window (w) | 54 |
| 6B / 2B | Table setup (t) | 324 |

The bitmap is page-major: index `(y >> 3)*132 + x`, mask `80 >> (y & 7)`.
This was independently checked by booting the adjacent EL-9950 headless
emulator, reading RAM40116B and comparing its live LCD screenshot: zero
mismatches across 8,448 pixels (LCD palette 24/185 thresholded at 100).
This is image-layout evidence; the emulator does not emulate the serial peer.

## Native PC-Link files

The PC-Link executable was **statically inspected, never executed**. Sources:

- [Sharp's Heron sample](https://global.sharp/contents/calculator/support/program/calculation.html#5), HERON_4.g4p inside HERON_4.EXE.
- [CE-LK4 for EL-9900G SII](https://tiplanet.org/forum/archives_voir.php?id=5366760).
- [CE-LK4 for EL-9950](https://tiplanet.org/forum/archives_voir.php?id=1922056).

The header is `4 + type-letter` (2 bytes), selector/name (11 bytes), description
(40 bytes), zero padding (1 byte), then binary data. The official 129-byte
Heron program has body offset 54. PC-Link SII serializer RVA `FAB0–FB80` and
loader `FB90–FDD4` move these fields. Upload construction `2150–2201` adds
object length and previous-size fields. EL-9950 PC-Link's format-prefix function
RVA `10B0` uses the same family setting, initialized to 4 around `5F91–5F9C`.

RAM objects have LE32 total length and LE32 previous-object length first.
Dynamic objects carry name11 plus a zero pad, then data. The file relocates
name11 into its header and omits the RAM size/link fields. Fixed objects carry
a selector16 then data; native files retain that selector in both the header
and body. The host constructs the ignored previous-size field as 48, matching
PC-Link, rather than copying potentially stale RAM links. Native backups have
the 54-byte header followed directly by E32B bytes from the dedicated backup
command; no variable iteration or parallel archive format is used.

WebTILP writes the selected model in the backup's native description field.
A tagged backup from a different model is rejected. Untagged native backups
require explicit confirmation of the same model **and firmware**. The wire ID
cannot distinguish the three EL-9900 variants and the file header does not
identify exact firmware; compatibility cannot be inferred from the USB ID.
Restore files must be sent alone. Successful restore closes the serial session;
restart PC-Link on the calculator and reconnect before transferring again.

The downloaded `CE-LK4 for EL-9950 Ver1.10/CE-LK4_EL-9950.msi` has SHA-256
`b49faf0ed343acaeb77d52b84fed5772a41b5528ea4010b139dbf54f1a6d0743`.
Its statically extracted PC-LINK executable matches the analyzed archive copy:
`9e540b532857242b6fad867d1cbba7cf77dd10cd0656b53d1c8854c016d55a16`.

## Receive-only REPROGRAM dumps

Use Receive OS for system-only (`19200→38400`, Boot Page OFF), or Dump ROM for the
full image (`19200→38400`, Boot Page ON). Enter REPROGRAM SEND on the calculator,
confirm the browser's reception prompt first, then start SEND. No helper or
firmware is uploaded. The calculator's own dump mode sends:

`address LE32 + length LE16 + payload + additive checksum LE16`.

The header is address=0, length=5, data `39 39 01 mode boot`, where mode70 is
19200 and mode80 is the 19200→38400 mode. Replies are raw ASCII `OK`/`NG`.
End is `FF FF FF FF 00 00 FC 03`. Blocks are 16 KiB below FF0000, 8 KiB above.
Erased blocks may be omitted and are reconstructed as FF.

The transfer header always arrives at 19200, including system-only mode.
System-only mode80 switches immediately after ACKing that header. Full reception
starts with boot at FFC000/FFE000 at 19200, ACKs the final boot
block, then closes/reopens serial at 38400 for the system. A manifest records
all accepted blocks and the inferred erased gaps. Incomplete, bad-checksum,
overlapping, out-of-order, out-of-range, unexpected-mode and extra-byte
captures never download an image. First-header corruption recovery and mode90
are deliberately not enabled: reconnect and repeat capture if the baud switch
loses bytes.
Before closing the port after a baud-transition or final ACK, the backend waits
for the two-byte wire time plus 3 ms, following the supplied receiver's guard.
WebSerial has no equivalent of its Windows bridge's atomic baud change and
`FlushFileBuffers`; this guard alone does not establish uninterrupted reception.

## Validation and remaining hardware work

### Serial discovery on Windows

WebUSB can see the Sunplus adapter as `04FC:0201` while its COM port exposes
different USB IDs or no IDs through WebSerial. For an explicitly selected Sharp
model or an adapter discovered through WebUSB, WebTILP opens an **unfiltered**
serial chooser: select the adapter's COM port manually. A fresh Connect click
may still be required after the USB chooser consumes browser user activation.
Automatic discovery continues to reuse only ports reporting the exact Sunplus
identity; other granted ports are never automatically assumed to be Sharp.

The log's `Sharp serial discovery` entry contains the actual selected port's
`getInfo()`, metadata for already-authorized ports, and the separately selected
WebUSB adapter's VID/PID. Empty serial metadata is preserved as `{}`. WebSerial
does not expose COM names/paths to JavaScript, and `getPorts()` cannot enumerate
ungranted ports. Matching USB IDs alone cannot uniquely associate two identical
adapters; missing or different IDs cannot establish the USB-to-COM association.
The information panel displays the selected serial port's actual IDs, or says
that the IDs are unavailable, instead of substituting the Sunplus defaults.

If the unfiltered chooser is still empty, check the Windows Device Manager COM
port and driver and close any application using the port. That result requires
OS/driver/browser evidence; adjusting the USB filter further cannot resolve it.

### Tests

```
make -C webtilp test
SHARP_DUMPS_DIR=/path/to/sharp_dumps node webtilp/tests/test_sharp_backend.js
```

The second command generates fragmented sparse captures from each supplied ROM
and requires exact byte equality and the original SHA-256 for all four images.
These are synthetic receiver tests, not serial captures. Normal transcript tests
check actual outgoing packets, fragmented responses, both sender IDs, native
file round trips, both selector-response paths, native backup/restore, checksum
retry, errors, cancellation and timeouts. Frontend tests check routing, grant
lifecycle, ambiguity, disconnect isolation, selectors and capability gates.

`tests/sharp_frontend.html` runs the real UI against a clearly marked simulated
serial peer. It is a browser QA harness, not proof of calculator compatibility.
Add `?serialInfo=missing` or `?serialInfo=alternate` to exercise manual selection
when the simulated serial driver omits or changes its USB identity.

The supplied `sharp-receiver/README.md` reports earlier physical system captures
for all four variants and byte-validated full ROM results. Those are evidence
from that receiver, not hardware validation of WebTILP. Its successful Windows
bridge captures used an atomic baud switch and first-header recovery, which
this WebSerial backend does not provide.

Physical Sunplus cable tests remain required on each model, particularly 8N2
configuration, calculator PC-Link mode entry/re-entry, variable overwrite and
native restore behavior, and preservation of the first system block across the
19200→38400 close/reopen. No physical Sharp transfer has been performed during
this implementation. Received ROM bytes are validated; firmware flashing is
not part of this backend.
