# Web'nTILP

Web'nTILP packages WebTILP with Electron and its own Chromium runtime. The
application, WASM libraries, Python/Lua converters, icons and translations are
bundled locally: it works offline from the first launch, without installing a
browser, starting a server, or first visiting the website.

Calculator support and transfer behavior come from the existing WebTILP
backends. Packaging does not establish compatibility with hardware that has
not been tested with those backends.

## Download and run

The **Build Web'nTILP** GitHub Actions workflow produces these downloads:

| Platform | Architecture | Downloads |
| --- | --- | --- |
| Windows | x64 | `.exe` installer and portable `.exe` |
| macOS | Intel x64 and Apple Silicon arm64 | `.dmg` and `.zip` |
| Linux | x64 and arm64 | `.AppImage` and `.tar.gz` |

Open the Windows installer, or run the portable executable. On macOS, open
the DMG and drag **Web'nTILP.app** to Applications, or extract the ZIP. On
Linux, make the AppImage executable and run it, or extract the tarball and
run `webntilp` from its directory. Keep the extracted application directory
intact, including Electron's runtime and license files. If your distribution
does not provide AppImage's FUSE support, use the tarball instead.

Choose **Connect Calculator** and select your calculator or serial adapter
in the app's device dialog. Use **Rescan** if a device was plugged in after
the dialog opened. Ordinary file and folder
pickers and **Save As** dialogs handle incoming and outgoing calculator files.
Settings are saved in the local application profile. Source/license links
open in the system browser when requested; transfers require no network.
Device authorizations last for the current app session; select the device
again after quitting and reopening the app.

Current packages are unsigned prototypes. Local runtime validation covers
macOS; Windows/Linux runtime and physical calculator transfer validation
remain pending. macOS may require explicit approval in
**System Settings → Privacy & Security**, and Windows may show a publisher
warning. Release publishers should configure platform signing and macOS
notarization before distributing to a broader audience. No system security
setting needs to be disabled.

## USB and serial setup

The bundled browser still follows the operating system's device permissions
and drivers:

- **Windows:** raw WebUSB transfers need a WinUSB-compatible driver for the
  relevant calculator/cable interface. If using Zadig, select the exact
  calculator interface and retain a way to reinstall the vendor's driver.
  HP Prime uses the system HID driver. Evo connections use their serial
  drivers: preserve those drivers rather than replacing them with WinUSB.
- **macOS:** HID and serial devices use the system driver or the adapter's
  supported serial driver. Close other calculator software before connecting
  so it releases the interface.
- **Linux:** the desktop user needs access to the USB device, HID node or
  serial port. Distribution packages for TILP/Cahute may already supply USB
  rules. Existing project guidance is in [libticables CONFIG](../../libticables/trunk/CONFIG)
  and [Cahute's rules template](../../cahute/misc/60-casio-calculators.rules.in).
  Serial access commonly uses the `dialout` or `uucp` group; use your
  distribution's instructions and log out/in after changing group membership.

On Linux systems with systemd-logind, this example gives the locally logged-in
user access to WebTILP's supported TI USB IDs. Put it in
`/etc/udev/rules.d/69-webntilp.rules` if equivalent rules are not already installed:

```udev
SUBSYSTEM=="usb", ATTR{idVendor}=="0451", ATTR{idProduct}=="e001|e003|e004|e008|e012|e018|e01c|e022", TAG+="uaccess"
```

Then run `sudo udevadm control --reload-rules` and reconnect the calculator.
Other families need rules for their own device IDs; HP Prime may additionally
need permission on its `hidraw` node. Rules for the USB device alone do not
grant serial-port access. Run the app as your ordinary desktop user.

## Ubuntu's sandbox namespace restriction

On Ubuntu 24.04 and related systems using AppArmor 4, the kernel can block
Chromium's sandbox namespaces with a **No usable sandbox** startup error.
For this specific restriction, use the tarball at a fixed installation path
and the bundled [AppArmor profile](linux/webntilp.apparmor), following
[Ubuntu's documented namespace permission setup](https://documentation.ubuntu.com/release-notes/24.04/#unprivileged-user-namespace-restrictions).
This profile is optional and requires AppArmor 4's ABI; it is unnecessary on
systems where the app already starts.

Extract the complete tarball first. Replace `/path/to/extracted-app` below
with the directory containing `webntilp` and `resources`, then run:

```sh
sudo install -d -m 0755 /opt/webntilp
sudo cp -a /path/to/extracted-app/. /opt/webntilp/
sudo chown -R root:root /opt/webntilp
sudo install -m 0644 /opt/webntilp/resources/linux/webntilp.apparmor /etc/apparmor.d/webntilp
sudo apparmor_parser -r /etc/apparmor.d/webntilp
/opt/webntilp/webntilp
```

The profile permits sandbox namespaces only for `/opt/webntilp/webntilp`.
Run that executable as your ordinary user. AppImage mount paths change and
are outside this profile. Chromium's sandbox stays enabled, and the system's
global namespace policy stays in place.

For an update or rollback, quit the app and replace `/opt/webntilp` with the
complete new or previous tarball contents, preserving the same executable
path and root ownership. Your application profile is stored elsewhere.
To remove this optional AppArmor setup after quitting the app, run
`sudo apparmor_parser -R /etc/apparmor.d/webntilp`, then
`sudo rm /etc/apparmor.d/webntilp`.

## Develop and package

First build WebTILP's WASM libraries and converters following
[the WASM dependency instructions](../../deps/wasm/README.md), then run
`make -C webtilp prod` from the repository root. Desktop builds reuse those
generated assets; they do not fetch a hosted copy of the app.

With Node.js 22.12 or newer, from this directory:

```sh
npm ci
npm test
npm start
```

`npm start` stages the offline app before launching Electron. To build the
current platform's downloads, run:

```sh
npm run dist
```

Explicit examples are `npm run dist -- --win --x64`,
`npm run dist -- --mac --arm64`, and
`npm run dist -- --linux --x64`. Use the corresponding operating system for
release builds; the workflow handles the supported platform/architecture
matrix. `npm run pack` builds an unpacked application for inspection.
`npm run stage` only prepares `app/`, and `npm run smoke` checks the real
Chromium renderer. Linux smoke runs require a desktop or `xvfb-run`.

Staging reads the service worker's complete offline asset list and includes
all translation dictionaries, optional generated workers, build provenance,
and local license texts. Missing WASM/converter assets stop the build.
Only the staged HTML, manifest and translations receive desktop branding;
the website sources and backend API names remain intact. Tests, unrelated
local files, C++ source and arbitrary directories are excluded from packages.

## CI and releases

[build.webntilp.workflow.yml](../../.github/workflows/build.webntilp.workflow.yml)
builds the web assets once using the pinned WebTILP toolchain, then packages
the same source revision on Windows, macOS and Linux. Each platform runs the
desktop tests and an actual Chromium smoke test before packaging. Manual
workflow runs expose downloadable artifacts without publishing a release.

To prepare a release, update `package.json` and `package-lock.json` to the
same version, then tag that source revision `webntilp-v<VERSION>`. The tag
must match the package version. Successful tagged builds create or update a
**draft** GitHub release with the installers, portable archives and checksums;
publishing the draft is a separate maintainer action.

Upgrades replace the installed app while retaining its profile. There is no
automatic network updater. To recover from a failed update, reinstall the
previous complete package. **View → Reload** restarts the renderer; quit and
reopen the app if a failed transfer leaves the transport unavailable, then
reconnect the calculator. **View → Toggle Developer Tools** exposes console
diagnostics. The application keeps Chromium's sandbox enabled.

## Licenses and source

**Help → Licenses** lists bundled local license texts and source information.
WebTILP and the wrapper are GPLv2-or-later; dependencies retain their own
licenses. See [licenses/README.md](licenses/README.md) for the license text
origins. Electron's `LICENSE` and `LICENSES.chromium.html` are preserved in
`resources/electron-licenses` (`Contents/Resources/electron-licenses` on macOS)
and readable through **Help → Licenses**. When publishing binaries, provide the corresponding
sources for that exact release, including dependency modifications and the
build recipes required by their licenses.
