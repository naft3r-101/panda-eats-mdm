'use strict';

/**
 * Reading APK files before they are installed.
 *
 * Knowing the applicationId and version BEFORE installing is the whole point:
 * the order app ships in three flavours whose ids differ only by suffix, and
 * installing the wrong one on a paired tablet is the difference between a
 * harmless side-by-side install and replacing the restaurant's live Play build.
 */

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PROD_ID = 'com.pandaeats.ordertaking';
let cachedAapt2 = null;
let cachedApksigner = null;

/** Newest build-tools wins; they are all backwards compatible for what we use. */
function resolveBuildTool(filename) {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const roots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(localAppData, 'Android', 'Sdk'),
    path.join(home, 'Android', 'Sdk'),
  ].filter(Boolean);

  for (const root of roots) {
    const buildTools = path.join(root, 'build-tools');
    if (!fs.existsSync(buildTools)) continue;
    const versions = fs
      .readdirSync(buildTools)
      .filter((v) => fs.existsSync(path.join(buildTools, v, filename)))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (versions.length > 0) return path.join(buildTools, versions[0], filename);
  }
  return null;
}

function resolveAapt2() {
  if (!cachedAapt2) cachedAapt2 = resolveBuildTool('aapt2.exe');
  return cachedAapt2;
}

function resolveApksigner() {
  if (!cachedApksigner) cachedApksigner = resolveBuildTool('apksigner.bat');
  return cachedApksigner;
}

/**
 * Read the APK's signing certificate.
 *
 * This is what decides whether Google Play will ever update a sideloaded
 * build. Play only treats a sideloaded app as the same app if the signing
 * certificate matches the one it distributes - and because the order app is
 * published as an AAB, Play App Signing re-signs it with Google's key, which
 * is NOT the local release keystore unless that key was uploaded as the app
 * signing key. A debug-signed APK never matches, cannot be updated by Play,
 * and cannot even install over a Play build.
 */
async function readSignature(apkPath) {
  const apksigner = resolveApksigner();
  if (!apksigner) return { known: false };

  const r = await run(apksigner, ['verify', '--print-certs', apkPath]);
  const output = `${r.stdout}\n${r.stderr}`;
  const dn = output.match(/certificate DN:\s*(.+)/);
  const sha256 = output.match(/certificate SHA-256 digest:\s*([0-9a-f]+)/i);
  if (!dn && !sha256) return { known: false };

  const subject = dn ? dn[1].trim() : '';
  const isDebug = /CN=Android Debug/i.test(subject);
  return {
    known: true,
    subject,
    sha256: sha256 ? sha256[1] : null,
    debugSigned: isDebug,
    note: isDebug
      ? 'Debug-signed. Google Play can never update this build, and it cannot install over a Play-installed app (signature mismatch).'
      : 'Release-signed. Play will only auto-update it if this certificate matches the one Play distributes.',
  };
}

/**
 * `shell` is required for .bat/.cmd wrappers - apksigner ships as apksigner.bat
 * and modern Node refuses to spawn it directly (EINVAL). Under a shell the
 * arguments are re-parsed, so every path is quoted explicitly.
 */
function run(bin, args) {
  const isBatch = /\.(bat|cmd)$/i.test(bin);
  const command = isBatch ? `"${bin}" ${args.map((a) => `"${a}"`).join(' ')}` : bin;
  const argv = isBatch ? [] : args;

  return new Promise((resolve) => {
    execFile(command, argv, { timeout: 30000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, shell: isBatch }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: String(stdout || '').replace(/\r\n/g, '\n'),
        stderr: String(stderr || '').replace(/\r\n/g, '\n'),
      });
    });
  });
}

/**
 * Which flavour an applicationId represents, and what installing it implies.
 * Mirrors the order-app repo's own rule: prod carries no applicationIdSuffix,
 * so it REPLACES the Play build rather than sitting beside it.
 */
function classify(applicationId) {
  if (applicationId === PROD_ID) {
    return {
      flavor: 'prod',
      replacesPlayBuild: true,
      note: 'Production applicationId - no suffix. This REPLACES any Play-installed build on the tablet.',
    };
  }
  if (applicationId === `${PROD_ID}.staging`) {
    return { flavor: 'staging', replacesPlayBuild: false, note: 'Installs alongside the production app. Safe on a paired tablet.' };
  }
  if (applicationId === `${PROD_ID}.dev`) {
    return { flavor: 'dev', replacesPlayBuild: false, note: 'Installs alongside the production app. Safe on a paired tablet.' };
  }
  return { flavor: 'unknown', replacesPlayBuild: false, note: 'Not a Panda Eats order-app package.' };
}

/**
 * @returns {Promise<{ok:boolean, error?:string, path:string, applicationId:string,
 *   versionName:string, versionCode:string, label:string, minSdk:string, sizeBytes:number}>}
 */
async function readApkInfo(apkPath) {
  if (!fs.existsSync(apkPath)) return { ok: false, error: 'File not found', path: apkPath };

  const aapt2 = resolveAapt2();
  const stat = fs.statSync(apkPath);
  const base = { ok: false, path: apkPath, sizeBytes: stat.size };

  if (!aapt2) {
    return {
      ...base,
      error: 'aapt2 not found. Install Android SDK build-tools to read APK details before installing.',
    };
  }

  const r = await run(aapt2, ['dump', 'badging', apkPath]);
  if (!r.ok && !r.stdout.includes('package:')) {
    return { ...base, error: r.stderr.trim().split('\n')[0] || 'Could not read APK' };
  }

  const grab = (re) => {
    const m = r.stdout.match(re);
    return m ? m[1] : '';
  };

  const applicationId = grab(/package: name='([^']+)'/);
  const signature = await readSignature(apkPath);
  return {
    ...base,
    signature,
    ok: Boolean(applicationId),
    error: applicationId ? undefined : 'No package name in APK',
    applicationId,
    versionCode: grab(/versionCode='([^']*)'/),
    versionName: grab(/versionName='([^']*)'/),
    label: grab(/application-label:'([^']*)'/),
    // Newer build-tools print minSdkVersion; older print sdkVersion.
    minSdk: grab(/minSdkVersion:'([^']*)'/) || grab(/(?:^|\n)sdkVersion:'([^']*)'/),
    ...classify(applicationId),
  };
}

/**
 * Look for order-app APKs in the places they actually land: the sibling Kotlin
 * repo's Gradle output, and the Downloads folder for a release asset.
 */
function scanForApks() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const workspace = path.resolve(__dirname, '..', '..');
  const found = [];

  const walk = (dir, depth) => {
    if (depth < 0 || !fs.existsSync(dir)) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth - 1);
      else if (entry.name.toLowerCase().endsWith('.apk')) {
        try {
          found.push({ path: full, mtime: fs.statSync(full).mtimeMs });
        } catch {
          /* vanished mid-scan */
        }
      }
    }
  };

  walk(path.join(workspace, 'panda-eats-orderapp-kotlin', 'app', 'build', 'outputs', 'apk'), 4);
  walk(path.join(home, 'Downloads'), 1);

  return found.sort((a, b) => b.mtime - a.mtime).slice(0, 12);
}

module.exports = { resolveAapt2, resolveApksigner, readApkInfo, readSignature, scanForApks, classify, PROD_ID };
