# TI-Nspire exact filenames and generated log archive

The file-management service reports all regular files as type `NSP_TNS` (zero),
including TNS documents, `/themes.csv`, `/NspireLogs.zip`, and application data
with other extensions or no extension. Directory enumeration preserves the exact
wire filename in `VarEntry.filename`. The existing `name` remains a document
basename when the filename ends in `.tns` (case insensitive), and otherwise keeps
the complete name. Only the final `.tns` is stripped: `config.dat.tns` retains
`config.dat` as its basename; `config.dat` and `.hidden` stay unchanged.

Receive, delete, rename and move requests use the exact filename when present.
`tifiles_build_filename()` preserves its extension (or lack of one), with the
usual folder prefix for local downloads. Legacy callers that leave `filename`
empty retain the document-basename convention and get `.tns` appended. The
metadata is a fixed array, copied with `VarEntry`; callers must zero-initialize
new entries, and consumers must rebuild against the updated structure.

WebTILP exposes `filename` separately from `name` in directory JSON and uses the
exact filename bytes in `name_hex`. Existing selection and action paths carry
those bytes through the bridge. Rows show full filenames, so `config` and
`config.tns` are distinct; document-upload overwrite matching also distinguishes
them. Renaming a document retains its TNS suffix; renaming app data does not add
one. A move preserves the complete original filename.

Computer-to-calculator uploads remain restricted to `.tns`: arbitrary app-data
uploads are not supported by the OS. Exact filename metadata does not bypass
this restriction. This change does not make files visible if the calculator's
file-management service itself omits them from directory enumeration.

`NspireLogs.zip` reports size zero in directory entries and attributes because
the OS creates the archive on demand. Reception uses the size returned by
GET_FILE, rather than treating the directory size as an empty download.

## Hardware investigation, 2026-11-15

Tested on a TI-Nspire CX II-T, USB `0451:E022`, OS `6.40.0074`, through native
libusb on macOS, then the rebuilt local WebTILP browser page.

The initial native patch could receive the 191-byte `themes.csv`, but its
normal filename builder still produced `.tns` names. The log request failed
while waiting for its initial file-size reply: NNSE capped that wait at eight
seconds, then recovery closed the service. A valid file-size reply arrived
after the service had already closed, over thirteen seconds after the request.

The log request now allows 120 seconds for that initial reply, restoring both
the cable timeout and the NNSE override before receiving the contents, including
when the reply fails. Ordinary requests retain their existing timeout ceiling.
WebTILP's inactivity watchdog allows 125 seconds for this root ZIP in single,
selected and folder download flows, so it also tolerates the generation delay.

The corrected native download produced a 403,939-byte ZIP with 19 members;
the initial size reply took 14.4 seconds. The browser then downloaded a
415,599-byte ZIP with 19 members. Both ZIP CRC checks passed, and the browser's
191-byte CSV matched the native download byte-for-byte. Archive size/content
may change between requests. No calculator files were uploaded, renamed or
deleted during testing.

Regression checks cover the actual outgoing request paths, downloaded filenames,
ordinary same-base-name documents, nested names, failure-path timeout restoration,
NNSE timeout selection, and frontend single/selected/root-folder downloads.

The generalized filename handling has scripted native directory/protocol tests
and compiled WASM bridge/frontend coverage for extensionless and dot-prefixed
files, nested folders, dotted TNS basenames, case-preserved extensions, and
same-basename collisions. Native tests also reject non-TNS uploads. The hidden
app-data cases have not yet been tested on physical hardware; the hardware
results above apply to the original CSV/log downloads.
