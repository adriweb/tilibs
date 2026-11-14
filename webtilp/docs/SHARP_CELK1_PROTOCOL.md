# Sharp CE-LK1P: EL-9400 / EL-9450 / EL-9600 / EL-9650

## Evidence and scope

Implemented from Xavier's supplied CE-LK1P dossier and a separate check of its
PC-LINK x86 disassembly. The source executable is PC-LINK 2.0, 593,920 bytes,
SHA-256 `0a8ee1e40569db83c98281f9fa3cf788486b9ebcc75c3c2ff01ab8950a5cb179`.
Neither that executable nor its disassembly is distributed here.

The tests use constructed transcripts derived from that static evidence, not
recordings from a calculator. No physical EL-94xx/96xx validation has been done.
These models have no Flash; OS/boot transfers do not apply.

The backend shares serial buffering, additive checksums, retries and screenshot
decoding with the EL-99xx backend. Its operation sequences are separate because
session boundaries and object layouts differ.

## Profiles and connection

| Selected model | Sender identity (ASCII) | Screen | Native file family |
| --- | --- | --- | --- |
| EL-9400 | `94` | 96×64 | `g2` |
| EL-9450 | `95` | 96×64 | `g5` |
| EL-9600 | `96` | 132×64 | `g3` |
| EL-9650 | `96` | 132×64 | `g3` |

Select the exact model. The EL-9600/9650 share the PC software's profile; this
does not establish compatibility with every model variant or with other file
families. The EL-9600c has not been established separately.

Use a CE-LK1P-compatible cable and a driver exposing a WebSerial port. Settings
are fixed at **9600 baud, 8 data bits, even parity, 1 stop bit, hardware RTS/CTS
flow control**. No operation changes speed. WebTILP requests an unfiltered serial
port because generic USB-to-serial adapters have different USB identities.
The CE-LK4 macOS WebUSB transport cannot supply these serial settings and is
deliberately excluded for these models.

WebTILP asserts DTR and leaves RTS to the driver's hardware flow control. The
official software clears RTS/DTR and closes the COM handle after each successful
operation (`4015E0` → `401DA0`). WebTILP keeps the port open between operations;
whether that difference requires a hardware-specific adjustment remains untested.

## Wire sequences

Each frame is `sender[2] + body + additive checksum uint16 LE`. The PC sender is
ASCII `11`. A short command's body is one byte; data bodies have no opcode
prefix. Hex values below denote short commands unless marked `DATA`.

PC-LINK's internal phase identifiers are not necessarily wire opcodes. The
constructor direction flags and TX dispatcher (`401E10`) resolve ambiguities
in the dossier's prose. In particular, `21` and `23` below are calculator replies,
and phases `10`, `13`, `14`, `15` etc. describe data layouts.

Identification (`401000` / `401290`):

```text
TX 42; RX 01; END
```

No firmware-version query is established. The automatic device-info read checks
the selected profile through this handshake, without sending EL-99xx command 74.

Directory (`401050`, repeated by `4033D0` for SOLVE EQU, PROGRAM, ANIME):

```text
TX 61; RX 01
TX DATA category11; RX 01
RX 21; TX 01
RX DATA category11; TX 01
RX DATA count8 + count*selector11; TX 01; END
```

Category fields are space-padded to eleven bytes. Selectors retain all eleven
raw bytes; displayed names must not replace them in protocol requests.

Screenshot (`4011C0`, renderer `410790`):

```text
TX 42; RX 01; TX 63; RX 01
RX 23; TX 01
RX DATA opaque metadata4; TX 01
RX DATA bitmap(width*8); TX 01; END
```

The four metadata bytes are not interpreted as dimensions or commands. Pixels
use `raw[(y >> 3) * width + x] & (0x80 >> (y & 7))`; set means black.
The Windows renderer's DIB padding is not part of the wire bitmap.

Named-object download (`401100`):

```text
TX 62; RX 01
TX DATA category11; RX 01
TX DATA selector11; RX 01
RX 22; TX 01
RX DATA category11 + opaque2; TX 01
RX DATA L16LE + opaque2 + selector11 + usefulBody; TX 01; END
```

`L` includes the entire final data body, including its length field; it must be
at least 15. Complete frame size is `L+4`. Both echoed category and selector are
checked. The useful body starts at body offset 15.

Native program upload (`401300`, `40E9C0`, `402670`):

```text
object = uint16LE(payload.length+16) + 30 00 + selector11 + 00 + payload
TX 22; RX 01
TX DATA PROGRAM11 + uint16LE(object.length); RX 01
TX DATA object; RX 01; END
```

Directory, object download and upload have no leading `42` or trailing `41` in
their constructors. No internal phase `13` is prepended to an upload object.
WebTILP checks the PROGRAM directory before upload and rejects duplicate names.

## Files and available operations

Individual files have a 54-byte header: ASCII profile digit, ASCII type letter,
selector11, comment40, zero terminator. Program export omits the useful body's
first flag byte (`40E8B0`–`40E9AF`); equation and animation export retain their
useful bodies. Header type letters are accepted case-insensitively.

Implemented: identification, screenshots, the three dynamic directories,
native program/equation/animation downloads, and native program uploads
(`.g2p`, `.g5p`, `.g3p`, according to selected model).

Not implemented: fixed-object transfers, RAM backup/restore, groups, previews,
BASIC tokenization/detokenization and picture conversion/upload. Their complete
model-specific semantics/codecs have not been established. Renaming a file or
replacing its profile digit is not a supported family conversion.

Run `node webtilp/tests/test_sharp_legacy_backend.js` for the constructed wire
tests, including all four profiles, fragmented/coalesced reads, raw selectors,
checksum retries, native program roundtrips and unsupported-operation rejection.
