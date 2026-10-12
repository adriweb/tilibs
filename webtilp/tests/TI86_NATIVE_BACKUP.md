# TI-86 native backup reception

TI-86 native backups must be started on the calculator. In WebTILP, select
Create Backup first, then send a Backup from the calculator's LINK menu.
WebTILP waits for the calculator's VAR header, acknowledges it, sends CTS,
and receives the four backup blocks. TI-82 and TI-85 use the same manual
start; TI-83 retains its automatic request.

## ROM evidence

The unmodified retail TI-86 1.6 ROM (262144 bytes, SHA-256
`948dd974089987b2b96291d589c0d5ad46276a0988a2acbd1dcfd4c15d566854`)
recognizes command A2 but explicitly exits for backup type 1D. Bank 09,
mapped at CPU 4000, contains:

```asm
4916: FE A2       cp 0xA2
491A: CD 35 41    call 0x4135   ; receive request payload/checksum and ACK
; copy the requested type/name into OP1 and check its type
4935: FE 1D       cp 0x1D
4937: CA 0F 53    jp z,0x530F
530F: C3 16 0F    jp 0x0F16     ; fixed-bank cleanup/unwind
```

The cleanup releases the link lines, clears transfer flags, restores the
saved stack and ROM bank, and returns. It sends no backup header or data.

An ordinary boot of this ROM in the UniTI TilEm core, using native DBUS
byte handshakes and observation-only execute breakpoints, confirmed:

* Input: `06 A2 0B 00 00 00 1D 00 00 00 00 00 00 00 00 1D 00`.
* Output: `86 56 0B 00` (ACK), with no further output during two seconds
  of emulated execution.
* Execution reached bank 09:530F and fixed 0F16, with the complete request
  in RAM and OP1 type 1D.
* A subsequent `06 74 00 00` ID request still received a valid response.

Unmodified retail ROMs 1.2, 1.3 and 1.4 behaved identically. The malformed
supplied 1.5 dump was excluded. No ROM, RAM, register or saved-state edits
were used. This is ROM/emulator evidence, not a physical hardware test.

## Regression checks

`libticalcs/trunk/tests/test_dbus_protocol.cc` checks the four-block TI-86
receive sequence, no outgoing request before a manually sent VAR, timeout
propagation, and TI-83 automatic/TI-82 and TI-85 manual controls.

`make -C webtilp test` checks the instructions, cancellation of the backup
dialog, receive ordering, and manual versus automatic frontend deadlines.
`make -C webtilp test-silverlink-wasm` checks the actual compiled bridge:
the initial human wait exceeds 1.1 seconds without transmitting a request;
once bytes arrive the normal packet deadline resumes; a stalled backup
fails; subsequent reception and bomb cancellation recover with both
successful and rejected USB device resets.
