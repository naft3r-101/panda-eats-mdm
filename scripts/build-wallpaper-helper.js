'use strict';
// No Gradle or dependencies. The small signed APK is checked in so operators need no SDK.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), 'AppData/Local/Android/Sdk');
const bt = path.join(sdk, 'build-tools', '35.0.0');
const android = path.join(sdk, 'platforms/android-35/android.jar');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-wallpaper-build-'));
const exe = name => name + (process.platform === 'win32' ? '.exe' : '');
function run(bin, args) { execFileSync(bin, args, { cwd: out, stdio: 'inherit', windowsHide: true }); }
fs.mkdirSync(path.join(out, 'classes'));
run(exe('javac'), ['-source', '8', '-target', '8', '-bootclasspath', android, '-d', path.join(out, 'classes'), path.join(root, 'wallpaper-helper/WallpaperProvider.java')]);
run(exe('jar'), ['cf', path.join(out, 'classes.jar'), '-C', path.join(out, 'classes'), '.']);
run(exe('java'), ['-cp', path.join(bt, 'lib/d8.jar'), 'com.android.tools.r8.D8', '--lib', android, '--min-api', '29', '--output', out, path.join(out, 'classes.jar')]);
run(path.join(bt, exe('aapt2')), ['link', '-I', android, '--manifest', path.join(root, 'wallpaper-helper/AndroidManifest.xml'), '-o', path.join(out, 'unsigned.apk')]);
run(exe('jar'), ['uf', path.join(out, 'unsigned.apk'), '-C', out, 'classes.dex']);
run(path.join(bt, exe('zipalign')), ['-f', '4', path.join(out, 'unsigned.apk'), path.join(out, 'aligned.apk')]);
const key = process.env.PANDA_BENCH_HELPER_KEYSTORE || path.join(os.homedir(), '.android/debug.keystore');
run(exe('java'), ['-jar', path.join(bt, 'lib/apksigner.jar'), 'sign', '--ks', key, '--ks-key-alias', process.env.PANDA_BENCH_HELPER_KEY_ALIAS || 'androiddebugkey', '--ks-pass', 'env:PANDA_BENCH_HELPER_KEY_PASSWORD', '--out', path.join(root, 'build/wallpaper-helper.apk'), path.join(out, 'aligned.apk')]);
console.log('Built build/wallpaper-helper.apk. Keep the same signing key for updates.');
