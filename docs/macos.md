# macOS (Apple silicon)

Status: a base exists, but **nothing here has been run on a Mac yet**. It was written on Linux
and checked there only (typecheck, tests, Linux run).

## Done

- Per-platform dirs (`src/bun/store/dirs.ts`): `~/Library/Caches/org.mkuhlmann.cataglyph` and
  `~/Library/Application Support/org.mkuhlmann.cataglyph` (settings live next to the data).
  `APP_ID` is also the bundle id in `scripts/package.ts`.
- Trash: the Bun process calls the Electron main process (`shell.trashItem`), so "Put Back" in
  the Finder works (`setHostTrash` in `src/bun/apply/trash.ts`, set only on darwin).
- PATH: an app started from the Finder gets `/usr/bin:/bin:/usr/sbin:/sbin`; the main process
  appends `/opt/homebrew/bin` and `/usr/local/bin` for the Bun process so ffmpeg/ffprobe are found.
- App menu with the Edit roles (without them Cmd+C/V/A do nothing in text fields).
- Packaging (`bun run package` on a Mac): `@electron/packager` 20.3.0, no asar, ICNS generated
  from `assets/cataglyph-1024.png`, `.zip` via `ditto`, `.dmg` via `hdiutil`.
  - Signing is optional: `CATAGLYPH_MAC_SIGN_IDENTITY`, with hardened runtime and
    `assets/entitlements.mac.plist`. It signs every Mach-O file in the bundle (bundled `bun`,
    cjxl/djxl, `.dylib`, `.node`).
  - Notarization: `CATAGLYPH_NOTARY_PROFILE` (a `notarytool store-credentials` profile; needs
    the identity).
  - Unsigned builds are refused by Gatekeeper until "Open Anyway" in System Settings.

## Open

a. **cjxl/djxl 0.12:** libjxl publishes no macOS binaries and Homebrew's are linked against
   Homebrew's dylibs (not relocatable). Build static ones and put them, with the `LICENSE.*`
   files, in `vendor/jxl/`; `package.ts` refuses to run without them.
b. **GPU inference:** the `ai-edge-litert` 2.3.0 macOS arm64 wheel (cp312, sha256
   `2cd92f02fc9616755670027c5b020bfee5c72ae50cf5d33e92465a863b705a8b`) contains
   `libLiteRtMetalAccelerator.dylib`. Unknown whether Eye's darwin `libEyeNode.dylib` can load
   it. Linux hands the accelerator over via `LD_LIBRARY_PATH`; `DYLD_LIBRARY_PATH` is stripped
   under the hardened runtime unless `com.apple.security.cs.allow-dyld-environment-variables`
   is set. Until this works Eye runs on the CPU.
c. **Intel Macs:** Eye ships a native core for darwin-arm64 only, so there is no x64 build.
d. **perl:** exiftool needs it; `/usr/bin/perl` exists on current macOS.
e. **HEIC:** Bun.Image may decode it natively on macOS; the libheif-js path still works.
f. **APFS:** case-insensitive by default and normalizes file names. Pairing
   (`src/bun/scan/pairing.ts`) has not been checked against that.
g. **Signing/notarization** of the bundled bun and the native modules is untested.
