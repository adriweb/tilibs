# TI-82 / TI-85 backup listings

When `OPS_DIRLIST` is absent but native backup is supported, TI-82 and TI-85
show **List from backup…**. This is an explicit operation: the user confirms
receiving a full backup, then sends Backup from the calculator's LINK menu.
The variables panel stays hidden until parsing succeeds. Its rows form a
read-only snapshot; **Refresh List** requests another backup with confirmation.
Automatic refreshes and transfer preflights never request a backup. Successful
file transfers invalidate the snapshot.

The parser in `webtilp.cpp` validates the model signature, payload and block lengths,
checksum, VAT entry boundaries, names, and variable data ranges. It uses the RAM
base stored in the backup header, not a fixed ROM-version address. Unknown VAT
types or pointers outside the user-data block reject the entire listing.
The WASM bridge uses the existing ticonv/tifiles name and type conversions.
Temporary backup and listing files are removed after each attempt.

Format references:

- [TI Link Protocol & File Format Guide](https://www.ticalc.org/pub/text/calcinfo/tixx_guide.zip), TI-82/TI-85 backup, file-format and variable-format sections.
- [TI-82 variable/VAT layout](https://www.ticalc.org/pub/text/calcinfo/82-var.txt), VAT section.
- [TI-85 memory documentation](https://www.ticalc.org/pub/text/calcinfo/85hack.txt), symbol-table description only.

## Samples checked

| Sample | Expected listing | SHA-256 |
| --- | --- | --- |
| `libtifiles/trunk/tests/ti82/backup.82b` (existing repository fixture) | 73 entries; `POLY`: program, 284 bytes, address `0x9189` | `2cf8c9db220ceaa6ec833931273e9f4662bd2186687977630311d9bcd0bcf403` |
| `ZSHELL40.85B` from the public [ZShell archive](https://www.ticalc.org/pub/85/asm/shells/zshell.zip) | 9 entries; `ZShell`: 1196 bytes, `Organise`: 4128 bytes, `texan`: 2262 bytes | `60a2f6bc1752ec78c07a6c97385954b5daeacf4dc30134a29e9c18c5c475e55f` |

The ZShell archive SHA-256 is
`b24336da7ac5ffed033fcdf58cdf10f83678f3a5b50cdc46c0cf7b36149679d0`.
It is an external, optional fixture; tests do not download it or execute its
contents. An additional local modified TI-82 shell backup (`CRASH19006.82B`)
was rejected because a VAT address points below its user-data block.

## Checks

The native parser test includes `webtilp.cpp` with `WEBTILP_BACKUP_VAT_TEST`
defined, excluding the USB/WASM backend while compiling the production parser.

Run the regular suite with `make -C webtilp test`. It includes the existing
TI-82 sample, synthetic TI-82/85 variable types, invalid checksums, truncation,
invalid lengths/names/pointers, consent/cancel, failure cleanup, stale receive
results after disconnect, and automatic-refresh suppression.

With WebTiLP's WASM module built:

```sh
node webtilp/tests/test_backup_vat_wasm.cjs /path/to/ZSHELL40.85B
```

To exercise both real samples with sanitizers:

```sh
c++ -std=c++17 -Wall -Wextra -Werror -fsanitize=address,undefined \
  webtilp/tests/test_ti_backup_vat.cpp \
  -o /tmp/test-ti-backup-vat
(cd webtilp && /tmp/test-ti-backup-vat /path/to/ZSHELL40.85B)
```

These checks validate file parsing and the frontend flow. Physical backup
reception from a TI-82 or TI-85 still needs hardware validation.
