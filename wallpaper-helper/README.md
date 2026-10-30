# Wallpaper helper

This 13 KB app is separate from the Bench location agent. It has no launcher, service, receiver,
network permission or enrollment. Bench installs the bundled APK, uses its content provider over
USB, and disables it when finished. It is never part of debloat or order-app tuning.

The provider requires android.permission.DUMP and checks that the caller is the shell UID.
Only four fixed filenames can be read or written. Calls run under the helper's own identity.
SET_WALLPAPER is a normal install permission. Reading the previous wallpaper for rollback also
needs READ_EXTERNAL_STORAGE through Android 12, or temporary MANAGE_EXTERNAL_STORAGE access on
Android 13 and 14. Bench restores the previous storage app-op, revokes the runtime storage grant,
clears temporary files and disables the helper, including after failures.

Snapshot saves home and lock images to the PC before set changes either. Live wallpapers or
unreadable previous images stop automatic setting. The picker fallback stays available but is
reported as pending. Set uses one uniform scale and a centered crop, then sets both targets
separately. The PC compares returned IDs with dumpsys wallpaper. Restore also verifies those IDs.

The API contract supports Android 10 through 14. Physical testing so far is on HGT502R3,
Android 10. Android 11 through 14 still need physical checks; no success is assumed on them.
See [WallpaperManager](https://developer.android.com/reference/android/app/WallpaperManager).

To rebuild, install JDK 17, Android platform 35 and build-tools 35.0.0, then run:

```powershell
$env:PANDA_BENCH_HELPER_KEY_PASSWORD = 'android'
pnpm build:wallpaper-helper
```

The default signing key is the developer's .android/debug.keystore. Set
PANDA_BENCH_HELPER_KEYSTORE, PANDA_BENCH_HELPER_KEY_ALIAS, and PANDA_BENCH_HELPER_KEY_PASSWORD
to use another key. Keep the existing signing key for updates. A key mismatch falls back to
the picker; Bench never uninstalls the helper to work around it. The signed APK is checked in
and shipped as an extra resource so operators do not need a Java or Android SDK installation.
