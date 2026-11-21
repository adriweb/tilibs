# Zero ZGC4 link

Connect the calculator by USB with Zero Connect closed. Use **Connect
Calculator** in a browser with WebUSB and WebSerial. Select the calculator
in the USB chooser. WebTILP reuses an existing serial permission when it
can, or opens the serial chooser automatically. If the serial chooser
returns no selection, WebTILP retries it once. If the browser needs a fresh
click or there is still no serial selection, click **Connect Calculator**
again to open the serial chooser directly.
**Settings → Calculator model → Zero ZGC4** can be used to open the serial
chooser directly.

The calculator presents as USB CDC ACM with VID:PID `0483:5740`. The main
USB chooser uses that ID for discovery. The device appears as
`GD32-CDC_ACM` on the tested ZGC4. This ID is shared with other hardware,
so WebTILP checks for a Zero protocol response before issuing file commands.

## Packet format

Zero Connect 2.6.1 for macOS opens the port at the Qt defaults (9600 baud,
8N1). Every packet contains the four ASCII bytes `CALC`, a little-endian
16-bit payload length, then a proto3 message. The message type is varint
field 1. Nested frame, file info, and device info are length-delimited
fields 2, 3, and 4 respectively.

| Operation | Request and response |
| --- | --- |
| Device info | Request 1, response 8. The nested fields 1–4 are hardware, firmware, protocol and device name. Field 5 is the negotiated chunk size. |
| List files | Request 2, response 9 with the file count in field 5. Request 3 to start the list, then read one response 10 per file and send ACK 11 after each response except the last. |
| Download | Request 4 with the exact file name and size. Read response 13 for each chunk and ACK 11 after each except the last. Zero Connect returns an empty file locally for a zero-byte entry. |
| Upload | Request 5 with file name and size. Wait for ACK 11, then send a type 13 frame and wait for ACK 11 for each chunk. |
| Delete | Request 6 with exact file name and size. Wait for ACK 11. |
| Backup inventory (Zero Connect) | Request 14, then read successive file-info responses (type 10) without ACKs. An empty filename ends the inventory. Download each record using request 4 with its exact path and size. |

File info uses field 2 for the UTF-8 name and field 3 for size. A frame
uses field 1 for the byte count, field 2 for the zero-based chunk index and
field 3 for the byte string. Error replies have type 12.

On a ZGC4 HW v1 running firmware 2.22.0 and loader 2.21.1, the link returned
`CALC`, version fields `0.0`, and chunk size 236. It listed and downloaded
the existing 1,337,420-byte `FIRMWARE.BAK`. It also accepted a scratch text
file, returned it byte for byte, and removed it on request. The About screen
is the source for the actual version when the serial fields show `0.0`.

After saving a scalar, program, matrix, list, and two functions on that ZGC4,
the ordinary list exposed the 12-byte program as `ABC.zcb`, alongside
`FIRMWARE.BAK`. The backup inventory exposed `/exchange/ABC.zcb` with
identical bytes, plus `/vars.sav` (254 bytes), `/lists.sav` (101 bytes),
`/matrixes` (263 bytes), and `~yfunc.sav` (961 bytes). All four state
containers downloaded successfully using their exact paths.

## Variable previews

Use **List from backup…** or **Refresh List** to load calculator variables
alongside the exchange files. The preview reads only the four state files
above. Those variable rows represent a read-only snapshot. Program files
remain individually transferable, and their preview can download the original.

The version-50 state formats use little-endian 32-bit lengths. Numeric
records store separate length-prefixed decimal strings for the real and
imaginary components followed by a metadata byte. WebTILP formats these
strings directly so that JavaScript floating-point conversion cannot round
their mantissas. Lists store a count, and matrices store row and column
dimensions followed by the values in row order.

`/vars.sav` stores a count and named values, then ten length-prefixed
string slots. The observed named-record types are 4 for a number and 16
for a list. The public simulator's serializer also uses type 32 for
matrices inside the named values. `~yfunc.sav` stores the original equation
text, 14 bytes of settings, and a length-prefixed expression tree in each
of 40 slots. The preview displays the original equation text.

ZeroBasic programs use Zero's single-byte character set. The preview
renders documented mathematical glyphs and uses hexadecimal escapes for
unmapped bytes. Python files are previewed as UTF-8 source.
[ZeroBasic reference](https://storage.googleapis.com/zerocalculators-downloads/ZEROBASIC_v2.31.1.pdf)

## Firmware

The official 2.31.1 Automatic Updater uses a mounted USB recovery volume
and selects a single- or two-stage process based on the existing loader.
That process is separate from the CDC file link. WebTILP sends ordinary
files over CDC and directs firmware uploads to the
[official Zero updater](https://www.zerocalculators.com/downloads).

The supplied standalone `ZGC4v2311.bin` was 1,478,400 bytes with SHA-256
`96cc90e437a2316116d3794b615a367778139d52b36f22fc9e7b7837025892a3`.
Its use in the updater's version-dependent recovery stages was not verified.
No firmware was installed during link testing.
