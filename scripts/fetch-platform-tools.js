'use strict';

/**
 * Put a copy of adb next to the app, so a bench PC needs nothing installed.
 *
 * Finding adb was the one step of setting up a bench PC that could not be done
 * from inside Panda Bench: download the SDK platform-tools, unzip them
 * somewhere sensible, then come back and point at the exe. Shipping adb in the
 * installer deletes that step, and it also pins the version - the copy in the
 * installer is the one every bench runs, rather than whatever Android Studio
 * happened to leave on that particular PC.
 *
 * The binaries are NOT in git. They are downloaded here at build time, into
 * vendor/, which is gitignored: three files totalling ~6 MB would otherwise sit
 * in the repo's history forever and have to be re-committed on every bump. The
 * build downloads them once and reuses them until you delete the folder.
 *
 * Google's NOTICE.txt and source.properties come along for the ride, because
 * this is Google's software and it travels with its notice and its version.
 *
 * Windows only, like the rest of the build: it shells out to Expand-Archive so
 * nothing here needs an unzip dependency.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const URL = 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip';
const VENDOR = path.join(__dirname, '..', 'vendor', 'platform-tools');

/** adb needs both DLLs beside it on Windows, or it dies on the first device. */
const WANTED = ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll', 'NOTICE.txt', 'source.properties'];

function have() {
  return WANTED.every((f) => fs.existsSync(path.join(VENDOR, f)));
}

/** Pkg.Revision out of source.properties - what to print, and what to compare. */
function vendoredVersion() {
  try {
    const props = fs.readFileSync(path.join(VENDOR, 'source.properties'), 'utf8');
    const match = props.match(/Pkg\.Revision\s*=\s*(.+)/);
    return match ? match[1].trim() : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function download(dest) {
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`${URL} returned ${res.status} ${res.statusText}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function main() {
  if (have() && !process.argv.includes('--force')) {
    console.log(`[platform-tools] already vendored: ${vendoredVersion()} in vendor/platform-tools`);
    return;
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'panda-bench-tools-'));
  const zip = path.join(temp, 'platform-tools.zip');

  try {
    console.log(`[platform-tools] downloading ${URL}`);
    await download(zip);

    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${temp}' -Force`],
      { stdio: 'inherit' }
    );

    const unpacked = path.join(temp, 'platform-tools');
    fs.mkdirSync(VENDOR, { recursive: true });
    for (const file of WANTED) {
      const from = path.join(unpacked, file);
      if (!fs.existsSync(from)) throw new Error(`the download has no ${file} in it`);
      fs.copyFileSync(from, path.join(VENDOR, file));
    }

    console.log(`[platform-tools] vendored ${vendoredVersion()} to vendor/platform-tools`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`[platform-tools] ${err && err.message ? err.message : err}`);
  // A refresh that cannot reach Google is not a reason to fail a build that
  // already has a working adb vendored - it just ships the one it has.
  if (have()) {
    console.error(`[platform-tools] keeping the vendored ${vendoredVersion()}.`);
    return;
  }
  console.error('[platform-tools] Panda Bench will still build, but the installer will carry no adb.');
  process.exitCode = 1;
});
