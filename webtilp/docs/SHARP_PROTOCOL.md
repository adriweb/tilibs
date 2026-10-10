# Sharp EL-99xx support

## Native hardware investigation (2026-11-13)

The Sharp backend, frontend and regression tests have been restored. Native
investigation preceded browser testing; native and browser share the protocol
backend. No firmware-writing command is exposed.

`node webtilp/tools/sharp_native.cjs version list screen backup receive` is a
macOS diagnostic that runs the same protocol backend through Python 3 + libusb
1.0, without a serial driver. `listen` captures incoming traffic for 45 seconds
without transmitting. Do not replace the Windows Sunplus driver for this tool.
Captures and timestamped hex traffic are saved under a temporary directory,
or `SHARP_OUTPUT_DIR`. These commands only read calculator data.
The native tool defaults to Auto; set `SHARP_MODEL=sharp-el9900gsii` (or another
exact supported model) when a `99` reply cannot identify it uniquely.
The `system` and `rom` commands listen for the corresponding REPROGRAM Send
choice and save the image plus manifest. `SHARP_TIMEOUT_MS` overrides the
diagnostic inactivity timeout when coordinating a manual Send. Its USB bridge
requests one 16-byte IN packet per read and supports UART changes in place.

On this macOS machine, the official CE-LK4 is `04fc:0201`, revision `7109`,
with interface 0, bulk IN `81` (16-byte packets), bulk OUT `02` (8-byte packets).
No `/dev/cu.*` serial device is created. Native libusb can claim it and accepts
UART setup `bmRequestType=40, bRequest=21, wValue=0709, wIndex=0`
(38400, 8N2). The SPCP825 variant does not support the UART-status or
working-mode controls used by newer Sunplus adapters; see Linux's
`drivers/usb/serial/spcp8x5.c`. The bundled official SPCP825 Windows driver
independently uses request `21` and the same baud/format encoding.

The official EL-9950 manual (printed page 227) says to leave the calculator
powered on: PC communication requires no calculator operation. Link → Receive
is for calculator-to-calculator communication, not a separate PC-Link mode.
The first male-to-male lead was a TI calculator link cable; neither native Mac
probes nor official Windows PC-Link received any bytes. The user replaced it
with a Casio calculator-to-calculator lead and confirmed official PC-Link works
on a separate Windows PC. Cable continuity was not measured. Sharp identifies
the supplied lead as CE-451L-equivalent; crossing tip/ring remains a wiring
explanation, not a measurement of either lead.

With that same CE-LK4 + Casio lead on this Mac, through its existing USB-C to
USB-A adapter, native communication now validates:

- Firmware version 1.20, identity `9:` and checksum-checked directory.
- A 132×64 screenshot displaying √90 and 9.486832981.
- Native RAM backup: E32B bytes + 54-byte header = 58,209 bytes.
- Program `integral` (3,536-byte g4p), VARIABLE, ZOOM, WINDOW and TABLE files.

The initial native tests exposed two software issues:

1. A single session start `31 31 42 a4 00` often gets no reply. Two or three
   attempts were needed on repeated sessions. The backend retries only session
   establishment (up to five attempts, 1.2 seconds each), and only after a
   response timeout with zero received bytes. Partial frames, failed writes,
   rejected commands, and ordinary operations are not replayed on silence.
2. USB bulk completion does not mean the UART finished sending. Immediate
   final ACK / session-end writes could lose the end reply after a program
   download. Waiting the UART wire time plus 5 ms between native writes allowed
   the program and all four fixed-block downloads to complete.

The browser additionally exposed a full-USB-packet receive deadlock. A directory
with one program is a 16-byte frame, exactly EP81's maximum packet size. The
SPCP825 does not reliably send a zero-length terminator; transferIn(64) can
therefore wait forever while the calculator waits for our ACK. Direct WebUSB
now requests one endpoint-sized packet at a time. Native libusb's timed reads
already return partial buffers, so its 64-byte receive buffer did not have
that same behavior. The USB mock regression models full packets without ZLPs and fails with the
old 64-byte request. The corrected transport also passed the physical
one-program directory read.

Continuous transfers need queued USB reads as well. One outstanding 16-byte
read leaves a gap while the browser schedules JavaScript; the UART can keep
sending during that gap and overflow the adapter. The transport now keeps 64
endpoint-sized reads submitted (1 KiB on this CE-LK4), consuming results in
submission order. This retains the no-ZLP fix without making reception wait
for the main thread to submit each individual packet. Closing the device aborts
all pending reads, whose promise rejections are handled from submission time.

The regression peer models a finite 512-byte FIFO and continuous bursts while
JavaScript callbacks wait. That FIFO size is a test condition, not a measured
SPCP825 specification. The old one-read transport loses data and times out in
that test; queued reads receive the complete checksum-validated RAM frame.

After the reported 99% failure (57,647/58,157 bytes in the payload-prefix
read), three consecutive native backups succeeded. Three consecutive Brave
WebUSB backups with queued reads then succeeded in 20.823, 20.822 and 19.660
seconds. Each deliberately blocked the page's JavaScript for 250 ms during
reception, received 58,187 wire bytes including the session/control frames,
and downloaded a valid 58,209-byte native backup. These are EL-9950G + CE-LK4
hardware checks; they do not establish the adapter's physical FIFO size or
unlimited tolerance of main-thread suspension.

The screenshot handler at F7B8DE exits PC-Link after the final host ACK. It
must not be followed by session-end `41`; that would time out despite a valid
bitmap. The native tool uses a 30-second inactivity timeout: the E32B-byte backup needs
about 17 seconds on a 38400-baud 8N2 wire (plus adapter overhead).

Normal frame reads reset that timeout when more bytes arrive. The earlier
whole-frame deadline could reject a progressing backup when WebUSB packet
overhead pushed its total duration past 30 seconds. A stalled partial frame
still times out, reports the received/expected byte count and closes the port;
it is never automatically replayed. No partial backup is downloaded.

Screenshot, object and backup receptions report payload progress as fragments
arrive. Uploads split the same checksum-framed packet into 1 KiB serial writes,
reporting progress after each write; they reach 100% only after the calculator
ACK. Receive progress reaches 100% after checksum validation. Protocol ACKs
and session-end replies do not overwrite payload progress. The native tool
also prints percentages and includes progress events in its trace.

On 2026-11-14, native backup and screenshot progress reached 100% on the
EL-9950G. A renamed 3,536-byte program was uploaded in chunks and received
byte-for-byte; restoring the pre-test RAM backup removed that test program,
and firmware 1.20 plus the original directory remained readable. Brave WebUSB
then displayed live backup percentages and downloaded a valid 58,209-byte g4b
file (58,155-byte RAM payload). The screenshot taken after a successful native
backup was entirely blank, so that display change also occurs without a
transfer failure; it is not sufficient evidence of a calculator crash.

The original native adapter initialization worked with the protocol fixes;
adding the SPCP825 break-off request was not required. Native configuration
changes now go through libusb / IOKit only, avoiding raw SET_CONFIGURATION
after interface claim. A USB reconnect was used before browser testing; the
chooser's accessibility tree omits its device rows, so that tree alone cannot
establish that a chooser was empty. The USB-C adapter is not implicated by the
successful transfers.

The upload/readback test exposed another firmware behavior: command 22 appends
named objects even if the same name already exists. Two `integral` RAM objects
had identical name/payload SHA-256
`e310b70ce58198428242914d350853f6db074cdecbfc44b8d7c27897e8558400`.
A native file comparison alone was insufficient because a name lookup could
still return the original. Upload now queries the category directory and
rejects duplicate dynamic names before sending 22. Fixed objects have their
own replacement commands. The delete probe (66, category, name) returned 83
and is not exposed in the UI. With explicit user authorization, the original
same-calculator backup was restored using 27; firmware 1.20, exactly one
`integral`, its original byte-exact file, and all four fixed blocks were then
verified. Native RAM restore is therefore hardware-tested too.

Browser WebUSB connection, firmware 1.20 reception, screenshot transfer,
directory reception and a 58,209-byte native backup download succeeded on this
Mac in Brave. A uniquely named `WEBTEST.g4p` was uploaded and downloaded
byte-for-byte (3,536 bytes; SHA-256
`8b203370be37016ae54065c136835e3d124074c4ef514e3c087e35b14ef4edba`).
A second browser send was rejected; a native directory check confirmed exactly
one WEBTEST. The original backup was then restored again and native checks
confirmed WEBTEST absent, one original `integral`, byte-exact original program
contents, firmware 1.20 and all four fixed blocks.

The alternative tested USB adapter is Prolific `067b:23a3`, revision `0305`.
Its macOS driver creates `/dev/cu.PL2303G-USBtoUART110`; native open and
`tcgetattr` succeeded, reporting 9600 baud. The user confirmed that its DB9
connects to a grey TI Graph-Link. That converter implements the TI two-wire
link on its calculator side, not Sharp's UART, so it is not a replacement
for the CE-LK4. No serial bytes were transmitted through it; the port was
closed after inspecting its attributes. The existing grey-link driver is
`libticables/trunk/src/linux/link_gry.cc` (also used on macOS).

## Browser transport and operations

WebTILP uses a standalone JavaScript backend for EL-9900, EL-9900G,
EL-9900G SII and EL-9950. The Sunplus cable is `04FC:0201` (Windows:
“Sunplus USB to Serial COM Port”). On macOS, `sharp_usb.js` carries UART bytes
directly through WebUSB because this adapter creates no native serial port.
It configures SPCP825 request 21, validates the bulk endpoints, paces writes
and closes the USB device to abort outstanding reads. On Windows/Linux with
WebSerial, the existing OS serial driver is retained. Do not replace that
driver with WinUSB. Other USB IDs are not assumed compatible.

Choose the exact Sharp model in **Settings → Calculator model**, or select the
Sunplus cable in the normal Connect chooser. The exact setting goes directly
to the appropriate Sharp transport chooser. Multiple authorized matching ports require a chooser. If a
chained chooser loses browser user activation, click Connect again to authorize
the serial port. After opening the transport, connection automatically refreshes device
information through a serialized PC-Link version/identity probe. A completely
silent initial probe leaves the transport open so REPROGRAM remains available;
a partial reply, rejection or established-session failure still closes it. Normal operations leave the calculator powered
on at its normal screen. No calculator flash-writing commands are exposed.

Auto mode identifies an EL-9950 from a checksum-validated `9:` reply during
normal operations. Refresh Device Info starts a session, identifies that model
and requests firmware with command `74` in the same session; the displayed model
and firmware are retained across later operations without changing Settings.
A first RAM backup can identify the model through a separate clean session
before requesting its data. The shared `99` identity remains ambiguous between
EL-9900, EL-9900G and SII: Auto never sends `74` to those peers, and RAM backup
still requires an exact model selection. Explicit SII selection enables `74`.
Invalid checksums and explicit model mismatches never confirm a detected model.
Native Auto firmware reception and a first-operation Auto RAM backup passed on
the EL-9950G. Brave with Settings left on Auto identified EL-9950 and firmware
1.20 through Refresh Device Info; the firmware display survived a screenshot.

Normal operations support native variable listing/upload/download, screenshots,
native RAM backup/restore, and version reception on SII/9950. Files use Sharp's
`g4p/e/s/y/m/i/d/l/n/v/z/w/t/b` formats, including on EL-9950. Browser uploads
also expand g4 groups and convert BASIC source/images; variable rows offer
program, numeric and picture previews (see below). Token/source editing,
delete/rename, folders, keys and clock setting are not implemented. Normal operations are serialized; a timeout, disconnect or
protocol failure closes the serial port, except for the wholly silent automatic
connection probe described above. Restart PC-Link and reconnect before
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
Screenshot is an exception: its final host ACK exits PC-Link, without `41`.
Restore can exit PC-Link after its final ACK because the restored RAM includes
session state; no extra end command is sent after native restore.

All numeric lengths below are little-endian. Each listed command, metadata or
body is its own checked frame unless explicitly combined.

```
61 → ACK
category11 → ACK
← 21; host ACK
← category11; host ACK
← count8 + descriptor table; host ACK (see fixed-directory quirk below)

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
not reliable byte sizes, so most directory sizes are shown as unknown. The
firmware filters the reported count of fixed objects, but not necessarily their
wire descriptors (see below). Lists are a MATRIX-category subtype
(selector high byte `08`), not a separate LIST directory. Known categories are
`PROGRAM`, `SOLVE EQU`, `ANIME`, `GRAPH EQU`, `MATRIX`, `PICT`, `GDB`, `LISTDB`,
space-padded to 11 bytes. Fixed descriptors start with a LE16 selector; dynamic
descriptors start with eight name bytes.

### Fixed-directory count mismatch

A populated L1 exposed a deterministic firmware behavior on EL-9950G 1.20:
MATRIX announces **2**, but sends **29** descriptors in one **324-byte** frame,
with checksum `07EF`. One descriptor is L1, another its internal `0840` working
copy; empty fixed slots are also present. Reading only `1 + count×11` consumes
27 bytes of that frame, sends a premature NAK, then mistakes remaining descriptor
bytes (`00 00`, for example) for a sender identity. This is reproducible natively
and is not a browser scheduling failure.

The count filter at `F7BCA4–F7BCD7` compares each object's total length, while
the send loop at `F7B7FD–F7B82D` first advances to its selector and compares that
word instead. When the filtered count is nonzero, the whole allocated fixed
table is sent. When it is zero, the packet has no descriptors. The count filter
and descriptor-sending loop are byte-identical in the four supplied ROMs;
the directory handler's final dispatcher target differs by model. Native RAM category tables
independently establish the fixed slot counts: GRAPH EQU 31, MATRIX 29, PICT 10,
GDB 10 and LISTDB 10. Dynamic named categories still use `count×11`.

The reader now consumes the full fixed table, validates its checksum, and only
then sends ACK. No identity scanning, idle-gap heuristic or mid-frame replay is
used. Empty list/matrix dimensions and the private `0840–0843` work buffers are
removed from the visible result. PICT descriptors cannot reliably distinguish
an empty object from a white bitmap, so listing reads each candidate object in
the same session and omits only the 11-byte empty objects. All-white pictures
remain visible. Other fixed categories retain their previous listing behavior.
Identity errors now include the received bytes and directory category.

The regression transcript preserves the actual 324-byte MATRIX frame, covers
checksum retry on the complete frame, and checks populated-L1 visibility. A
PICT peer covers the same count mismatch, complete object reads, empty-slot
filtering and retention of an all-white picture. Automatic connection-info
coverage includes success and silent/partial/rejected probes.

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

Executable analysis here was static; the user separately validated official
Windows PC-Link with the working cable. Sources:

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

WebTILP writes the identified or selected model in the backup's native description field.
A tagged backup from a different model is rejected. Untagged native backups
require explicit confirmation of the same model **and firmware**. The wire ID
cannot distinguish the three EL-9900 variants and the file header does not
identify exact firmware; compatibility cannot be inferred from the USB ID.
Restore files must be sent alone. Successful restore closes the serial session;
leave the calculator powered on at its normal screen and reconnect before transferring again.

The downloaded `CE-LK4 for EL-9950 Ver1.10/CE-LK4_EL-9950.msi` has SHA-256
`b49faf0ed343acaeb77d52b84fed5772a41b5528ea4010b139dbf54f1a6d0743`.
Its statically extracted PC-LINK executable matches the analyzed archive copy:
`9e540b532857242b6fad867d1cbba7cf77dd10cd0656b53d1c8854c016d55a16`.

## Receive-only REPROGRAM dumps

Use Receive OS for system-only (**REPROGRAM → 2:Send**), or Dump ROM for the
full image (**REPROGRAM → 3:Send(with Boot Page)**). Open the calculator's
REPROGRAM menu, confirm the browser's reception prompt first, then choose the
corresponding Send option. No helper or
firmware is uploaded. The calculator's own dump mode sends:

`address LE32 + length LE16 + payload + additive checksum LE16`.

The header is address=0, length=5, data `39 39 01 mode boot`, where mode70 is
19200 and mode80 is the 19200→38400 mode. Replies are raw ASCII `OK`/`NG`.
End is `FF FF FF FF 00 00 FC 03`. Blocks are 16 KiB below FF0000, 8 KiB above.
Erased blocks may be omitted and are reconstructed as FF.

The transfer header always arrives at 19200, including system-only mode.
System-only mode80 switches immediately after ACKing that header. Full reception
starts with boot at FFC000/FFE000 at 19200, ACKs the final boot
block, then switches serial to 38400 for the system. Direct CE-LK4 WebUSB and
the native bridge change UART settings without closing the device, preserving
queued reads. Standard WebSerial requires closing/reopening its port. A manifest records
all accepted blocks, any recovered first header, and the inferred erased gaps. Incomplete, bad-checksum,
overlapping, out-of-order, out-of-range, unexpected-mode and extra-byte
captures never download an image. Mode90 is not enabled.
After a baud-transition or final ACK, the backend waits
for the two-byte wire time plus 3 ms, following the supplied receiver's guard.
WebSerial has no equivalent of its Windows bridge's atomic baud change and
`FlushFileBuffers`; this guard alone does not establish uninterrupted reception.

The separately supplied `sharp-receiver` validated a specific first-system-header
failure on all four supplied models: the expected six-byte address/length can
arrive as `18 1C 10 FF`, followed by an intact payload and checksum. WebTILP now
parses dump input incrementally rather than trusting this corrupted length.
Recovery is confined to the first system block in mode80, after the header ACK
or the final boot-block ACK. It finds the ROM's intact 32-byte `81..A0` payload
prefix within offsets 0–6, requires all 16384 payload bytes and the original
trailing checksum, and validates that checksum with the canonical
`00 00 F0 00 00 40` header. It never invents payload bytes or repairs boot/later
blocks. Missing or corrupt payload/checksum data fails reception.

`recoveredFirstHeader` in the downloaded JSON records the raw prefix, inferred
header, payload offset, received payload length, alignment signature and checksum. The activity
log also discloses recovery after a successful transfer. An intact first header
uses ordinary validation and records no recovery.

Hardware retest on 2026-11-14: EL-9950G 1.20 / CE-LK4 / macOS / Brave direct
WebUSB received the complete system, 1,032,192 bytes in 42 checked blocks,
byte-identical to the supplied independent reference. SHA-256:
`7ef9acb7263d83afd4ea744682938420df4743e9422305b6ef4de06f633a9a0e`.
The raw first system prefix was exactly `18 1C 10 FF`; all payload bytes and
the original checksum were retained. The raw RX capture was independently
reparsed with the tester's `sharp-receiver` and produced the same reference.
The subsequent full-ROM capture validated 43 blocks (one non-erased boot block
followed by 42 system blocks), producing 1,048,576 bytes byte-identical to the
full reference, SHA-256
`deae0913c635b02e5b273db20905fa57993ec035edb7cbf78f08f9bc79f42082`.
Its damaged first system prefix was `10 1E 10` (three bytes); boot was received
strictly at 19200 before switching to 38400. Its preserved raw capture also
reconstructed the exact full image with the tester's independent receiver.

The native libusb diagnostic still stalled before delivering the initial
REPROGRAM header on this Mac, with both in-place settings and close/reopen.
It successfully read PC-Link version 1.20 after a USB reconnect. That native
transport limitation is separate from the validated WebUSB capture; neither
the native dump path nor Windows/Linux WebSerial is claimed validated here.

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
and requires exact byte equality for system and full-ROM images, with both clean
headers and the captured first-header damage. Full-ROM hashes must match the
original SHA-256 for all four images.
These are synthetic receiver tests, not serial captures. Normal transcript tests
check actual outgoing packets, fragmented responses, both sender IDs, native
file round trips, both selector-response paths, native backup/restore, checksum
retry, errors, cancellation and timeouts. Frontend tests check routing, grant
lifecycle, ambiguity, disconnect isolation, selectors and capability gates.

WebUSB transport tests exercise the shared backend through a mock USB device,
including UART setup, screenshot framing, both dump choices with in-place baud
changes and damaged-header recovery, partial-write failure and cancellation
of pending USB reads and writes on close. Hardware evidence is recorded at the top of
this document; it is separate from these deterministic tests.

Remaining physical coverage: EL-9900 variants, Windows/Linux browser serial
drivers, fixed-object uploads, the native libusb dump path, and REPROGRAM
reception across WebSerial's 19200→38400 close/reopen. The EL-9950G direct
WebUSB system and full-ROM captures validate both in-place baud transitions. Firmware flashing
is not part of this backend.

## Source conversion and previews

`sharp_files.js` adds a standalone, dependency-free codec shared by browser
uploads/previews and Node tests. With the conversion setting enabled, `.bas`
and UTF-8 `.txt` sources become `.g4p` programs before transfer. Names use up to
eight ASCII letters/digits/underscores, starting with a letter; unsuitable
filenames prompt for a name. Token spellings are case-sensitive, as in PC-Link
(`sin ` is a function; `SIN` is three variable letters). This accepts plain
BASIC source, not PC-Link's annotated exports of other variable types.

The token banks and official `@symbol@` TXT spellings were reconstructed from
the EL-9950 PC-Link executable already identified above. Longest-match lookup
at VA `409390–40993E` scans these banks in order:

| Bank | First code | Count | Table VA | Entry bytes |
|---|---:|---:|---:|---:|
| single | 17 | E7 | 42D608 | 11 |
| 05 | 10 | 17 | 42DFF8 | 8 |
| 07 | 10 | 39 | 42E0B0 | 15 |
| 08 | 10 | 16 | 42E408 | 11 |
| 09 | 10 | 0A | 42E4FC | 6 |
| 0A | 10 | C4 | 42E538 | 15 |
| 0B | 10 | 31 | 42F0B8 | 11 |
| 0C | 10 | 36 | 42F2D8 | 5 |
| 0D | 10 | 2A | 42F3E8 | 8 |

Codes, counts and addresses are hexadecimal; entry sizes are decimal. Empty
entries are excluded. PC-Link's whole-source wrapper at `403BE0` uses the same
lookup inside quotes and comments. Its 160-byte line limit is enforced rather
than silently splitting long lines. FD is a newline; FF terminates a program. New source uploads finish with FD FF,
matching PC-Link’s writer at `4057A1`; low-level tokenization remains lossless.
Unicode mathematical symbols and official forms such as `@sto@` / `@root@`
are accepted, along with `->` and `sqrt`. Undefined tokens and ambiguous
spellings use reversible `\x{HH}` or `\x{HHHH}` byte escapes in previews.
The Heron sample body and the saved hardware `integral` program both round-trip
byte-exactly, including trailing empty lines.

Groups have a **two-byte `4g` header**, not the ordinary 54-byte header.
PC-Link's writer `405840–405B08` and reader `405B10–405D41` use repeated
LE32 record sizes, a 260-byte NUL-terminated filename, then the complete native
file. Record size includes these 264 bytes. A zero-filled 264-byte record ends
the group. Group uploads expand these records only after checking all bounds,
filenames and member files; nesting, RAM backups and duplicate destinations
are rejected before transfer. This does not create calculator-side groups.

PICT differs from screenshots. PC-Link reader `415680–41592C` expects a
1,073-byte `.g4i`: header54, selector16, mode8, and **127×64** page-major pixel
data. Each page contains 127 bytes; bit `1 << (y & 7)` is black. The native
selector is `[10..19, 0D]`, representing Pict1..Pict9,Pict0. PC-Link's bitmap
transpose at `414C92–414DA8` establishes the LSB-first vertical bit order;
screenshot decoding remains MSB-first and 132 columns wide. Import creates
mode 0 pictures, fits without cropping, centers on white, composites alpha,
and applies a 128 luminance threshold. PNG/JPEG/BMP/GIF/WebP decoding and
resampling use browser ImageBitmap/Canvas; each upload asks for a slot.
Animated images use the browser's initial decoded frame.

Numeric previews preserve decimal strings rather than rounding through JS
binary floats. PC-Link formatter `409AD0–409E75` decodes nine-byte numbers:
three BCD exponent digits (negative exponents use 1000's complement), a flags
nibble (sign / imaginary), then fourteen BCD mantissa digits. VARIABLE stores
27 complex pairs (A–Z and theta). LIST (`403F80–40410B`) stores selector16,
one metadata byte, count16, number-format16 and 9/18-byte values. MATRIX
(`4043A0–40452F`) stores selector16, metadata8, columns16, rows16, then real
values in column order. Unsupported numeric encodings are reported, not
interpreted as invented values. Remaining native types have metadata/hex
previews; solve-equation, animation and graph-database editing is not provided.

`node webtilp/tests/test_sharp_files.js` covers the independent Heron reference,
every single-byte code and every secondary code in prefix banks 05–0F,
reversible aliases, malformed groups, decimal precision and asymmetric picture
pixels. Frontend tests cover batch conversion and opt-out, collisions, prompt
cancellation, group expansion, stale connections and preview retirement.
Browser fixture QA exercises the shared modal and actual browser image decoder;
that is not proof of a physical picture/program transfer.
