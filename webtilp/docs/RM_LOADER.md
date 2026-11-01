# Casio RM-7000 / RM-9000 native OS loader

Select **Casio RM-7000 (native OS loader)** or **Casio RM-9000 (native OS
loader)** under **Settings → Calculator**, save, then click **Connect
Calculator**. This opens the dedicated RM transfer screen. There is no direct
splash-screen shortcut and no automatic RM probing. The existing TI cable
setting is ignored for this mode. The two model choices use the same protocol;
the selection is not a hardware identification or a restriction on the PROGRAM
currently installed in the calculator.

The screen uses `rm_loader_backend.js` directly through WebSerial, independently
of Cahute, libusb and WASM. It shares WebTILP's stylesheet and saved theme and
starts in the saved language (English/French; English fallback for other
languages). Its files are in the common service-worker precache and therefore
also included in CI, Docker and Web'nTILP offline staging.

## Physical test instructions for Critor

1. Use desktop Chrome/Edge over HTTPS or localhost, or Web'nTILP. Connect the
   Casio USB-to-2.5 mm serial cable; close FA-124 and any other serial application.
2. Hold **OPTN + EXP while powering on** to enter the native **Flash Memory**
   menu. In WebTILP, select the RM model in Settings as described above, then
   open the loader screen and click **Connect serial cable**. Choose the cable's
   COM/serial port. USB vendor/product identifiers are not required.
3. First test **Receive OS**: click the PC's receive button, then choose
   **Upload [2]** on the calculator and confirm with **EXE**. Save the received
   installation `.bin` and its header/transfer-details `.json`. The `.bin` contains the received PROGRAM
   with a valid installation-file checksum; it can be selected for a later send.
4. To test **Send OS**, return to the calculator's Flash Memory menu, reconnect
   the serial cable in WebTILP, choose **Download [1]** on the calculator and
   confirm with **EXE**, select a known-good RM installation `.bin`, then click
   Send and confirm. File
   validation finishes before any command is transmitted.
5. X/Q preparation can take **up to six minutes**. Keep power and the cable
   connected. After the last block is acknowledged, check the calculator's
   actual restart and installed PROGRAM/version. ACKs alone do not prove a
   valid physical Flash checksum or successful reboot.
6. The port closes after each completed or failed transfer. For another
   operation, return to the loader menu and reconnect. **Disconnect / cancel
   transfer** also closes the port. Cancelling an installation can leave an
   incomplete PROGRAM; recover through Download [1], then EXE, with a known-good
   installer.

The diagnostic-log button exports phases and errors without exporting firmware.
The received JSON retains the six header bytes, PROGRAM SHA-256, declared length,
expected Flash sum and serial settings, and explicitly records that the physical
Flash checksum and reboot have not been verified by the browser.

## Wire and file contract

- Serial: **19200 baud, 8 data bits, odd parity, 2 stop bits**, no hardware flow
  control; 65536-byte WebSerial buffer. No forced DTR/RTS changes: the supplied
  successful tool sessions did not require `setSignals`.
- PC send: `16 → 13`, `58 (X) → 51 (Q)`, six-byte header → Q, then each 4096-byte
  PROGRAM block and its one-byte checksum → Q or `52 (R)`. A block can be
  retransmitted once. There is no extra end packet.
- PC receive: calculator initiates `16`; PC replies `13`, waits for calculator
  X and replies Q, validates the header before ACK, then validates and ACKs each
  block (R for a corrupt copy, with at most one retry). The PC receiver never
  sends X or an installation command.
- Header: group count N, unsigned full-Flash expected sum (32-bit little-endian),
  then `(-sum(first five bytes)) & 255`. Each block uses the same negative
  additive checksum. Native lengths are restricted to **1–13 groups of 65536**
  bytes, including on reception; the experimental dumper's wider limit is not
  adopted.
- Preserve the original 20 ms pauses. Send read deadlines are 3 seconds for
  connection, **360 seconds for X/Q**, then 20 seconds for header/block replies.
  Receive waits 120 seconds for the first connection byte, then 20 seconds per
  command/header/block. Writes have a separate 20-second deadline.
- Reads accumulate arbitrary serial chunks, preserve surplus bytes and request
  exact lengths. Unexpected leading bytes are errors, not silently skipped.
  Timeouts poison the link; the UI closes it before allowing a fresh operation.
- Inputs must be **0xE0000 bytes (896 KiB)**. Metadata at **0xD0000** consists of
  N, the expected Flash sum, and the 32-bit little-endian installation-file sum.
  That file sum covers all file bytes except 0xD0005–0xD0008. Only the first
  **N × 65536 PROGRAM bytes** are transmitted, never the whole container.
- Received PROGRAM and header are rebuilt into an 896 KiB container using FF
  padding and a new installation-file sum. The first five received header bytes
  are preserved. Untransmitted padding/marker bytes in an original installer
  cannot be recovered; canonical containers are **wire-equivalent**, not
  necessarily byte-identical to their source installers.
- The expected **Flash sum**, **framing checksums**, and **installation-file
  checksum** cover different data. The header's Flash sum must never be replaced
  with a payload-only sum. The native LOADER, full 1 MiB Flash ROMs and custom
  9600/8N2 dumpers are outside this feature.

## Provenance and verification

Adapted from Critor's `webtilp-rm-loader-handoff`, dated 2026-11-01: the native
parts of `tool/src/protocol.mjs`, buffered WebSerial transport in
`tool/src/app.mjs`, and `reference/installer-format.mjs`. The implementation
adds isolated transfers, strict native file/length validation, write deadlines,
resource cleanup, explicit UI directions and installable reception exports.
No private firmware, installer executable, raw capture, or LOADER was added to
WebTILP or its runtime assets.

Run normal offline regressions (no hardware or private data required):

```sh
make -C webtilp test
node --test webtilp/desktop/tests/*.test.cjs
```

Synthetic tests cover file-size/checksum/length rejection, 1/6/10/13-group
installer round trips, both directions, deadlines/pacing, bad header/block sums,
a successful retransmission and repeated failure, unexpected replies,
fragmented/coalesced reads, surplus bytes, timeout, cancellation, disconnect and
stream-lock release (including partial setup failure and a blocked write). Settings routing tests ensure neither TI/Cahute setup nor
automatic discovery is entered for an explicitly selected native RM model.

Optional replay against the original private handoff (read-only):

```sh
node webtilp/tests/test_rm_loader_captures.cjs /path/to/webtilp-rm-loader-handoff
```

This runs the **new backend and actual buffered SerialLink** against all recorded
RX/TX bytes and reference installers, with newly fragmented chunks. It checks
three native receives (fx-7400G+ 384 KiB twice, cfx-9850GB+ ZX 1.0 640 KiB) and
one send of a rebuilt 384 KiB installer. All PROGRAM/header bytes, block checksums
and recorded ACKs matched during implementation.

Chrome 156.0.8078.74 browser QA used a simulated serial peer with no USB IDs:
Settings selection → loader → invalid file → cancelled receive → fragmented
384 KiB receive → export/reparse installer and metadata → reconnect → confirmed
send. Desktop 1365×1050 and French 390×844 layouts passed with no console errors
or horizontal overflow. Offline reload and rejection of an unselected direct URL also passed. Browser plugin was not available; the existing
Playwright-core and installed Chrome were used. **The new WebTILP integration
has not yet been tested on physical RM hardware.** The handoff reports physical
success for the earlier standalone tool; replay does not replace the new test.
