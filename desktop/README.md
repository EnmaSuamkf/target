# Target Desktop Apps

Double-click launch (or standard install) for each platform. No terminal required.

## Linux

**AppImage (portable):** Double-click `Target for Linux-0.2.0.AppImage` in your file manager. If prompted, mark it as executable first (Properties → Permissions, or right-click → Allow executing).

**Debian/Ubuntu (.deb):** Double-click `target-desktop-linux_0.2.0_amd64.deb` to install via your package manager, then launch **Target for Linux** from the application menu.

Build output: `desktop/linux/dist/`

## macOS

Double-click `Target for Mac-0.2.0.dmg` to mount the disk image, drag **Target for Mac** to **Applications**, then double-click the app in Applications (or Launchpad).

Build output: `desktop/mac/dist/`

## Windows

**Installer (recommended):** Double-click `Target for Windows Setup 0.2.0.exe`, complete the installer, then double-click the desktop or Start Menu shortcut.

**Portable:** Double-click `Target for Windows 0.2.0.exe` — no install step.

Build output: `desktop/windows/dist/`

## Building from source

From the repo root (requires Node.js ≥ 24):

```bash
npm run desktop:install
npm run desktop:build:all
```

Or build one platform: `npm run desktop:build:linux`, `desktop:build:mac`, or `desktop:build:windows`.

**Cross-platform notes:** Linux builds AppImage + `.deb` natively. macOS `.dmg` and Windows NSIS `Setup.exe` require their native OS (or Wine via Docker for NSIS). On Linux, `desktop:build:mac` produces the `.app` bundle; run the same command on macOS to get the `.dmg`. For NSIS on Linux without Wine: `docker run --rm -v "$PWD/desktop:/project/desktop" -w /project/desktop/windows electronuserland/builder:wine bash -lc "node link-shared.mjs && ./node_modules/.bin/electron-builder --win nsis"`.
