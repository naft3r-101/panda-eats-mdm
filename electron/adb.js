'use strict';

/**
 * adb plumbing for Panda Bench.
 *
 * Everything in here is mechanical: run adb, normalise its output, parse it.
 * All policy (what to disable, what to set, what is safe) lives in provision.js.
 *
 * Two Windows-specific hazards this module exists to absorb:
 *
 *   1. adb on Windows returns CRLF. Every parser downstream would otherwise see
 *      a trailing \r glued to the last field of every line, which silently
 *      breaks exact string comparison against package names and setting values.
 *
 *   2. `dumpsys package <pkg>` PREFIX-MATCHES. Asking about
 *      com.pandaeats.ordertaking returns the .staging and .dev blocks too, and
 *      reading the first versionName you find gives you a confidently wrong
 *      answer about which build is on the tablet. parsePackageBlocks() splits
 *      the dump into exact-keyed blocks so callers cannot make that mistake.
 *      (This is a documented, repeatedly-rediscovered landmine in the order-app
 *      repo's CLAUDE.md.)
 */

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_BUFFER = 64 * 1024 * 1024; // dumpsys package on a stock Samsung is multi-MB

let cachedAdbPath = null;

/**
 * The adb that ships inside the installer, which is the one Panda Bench wants
 * to use: finding adb was the only part of setting up a bench PC that happened
 * outside this app, and a pinned copy means every bench runs the same version
 * rather than whatever Android Studio left behind. Packaged it sits in
 * resources/, and running from source it sits in vendor/ - where the build
 * script puts it - so both are tried.
 *
 * Returns the path whether or not it exists; callers check.
 */
function bundledAdbCandidates() {
  const out = [];
  if (process.resourcesPath) out.push(path.join(process.resourcesPath, 'platform-tools', 'adb.exe'));
  out.push(path.join(__dirname, '..', 'vendor', 'platform-tools', 'adb.exe'));
  return out;
}

/** The bundled adb, if this copy of Panda Bench actually carries one. */
function bundledAdb() {
  for (const candidate of bundledAdbCandidates()) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // unreadable path, keep looking
    }
  }
  return null;
}

/** Candidate adb locations, best guess first. */
function adbCandidates() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const out = [];

  // An explicit override still wins - someone debugging a version difference
  // has to be able to force the issue.
  if (process.env.PANDA_BENCH_ADB) out.push(process.env.PANDA_BENCH_ADB);
  out.push(...bundledAdbCandidates());
  for (const root of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]) {
    if (root) out.push(path.join(root, 'platform-tools', 'adb.exe'));
  }
  out.push(path.join(localAppData, 'Android', 'Sdk', 'platform-tools', 'adb.exe'));
  out.push(path.join(home, 'Android', 'Sdk', 'platform-tools', 'adb.exe'));
  out.push('C:\\Program Files\\Android\\platform-tools\\adb.exe');
  out.push('C:\\platform-tools\\adb.exe');
  return out;
}

/**
 * Locate adb. Explicit override wins, then the SDK locations, then bare "adb"
 * on PATH as a last resort.
 * @returns {string} path or bare command name
 */
function resolveAdb() {
  if (cachedAdbPath) return cachedAdbPath;
  for (const candidate of adbCandidates()) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        cachedAdbPath = candidate;
        return cachedAdbPath;
      }
    } catch {
      // unreadable path, keep looking
    }
  }
  cachedAdbPath = 'adb'; // hope it is on PATH; run() will surface ENOENT clearly
  return cachedAdbPath;
}

/** The bundled adb's version, read from the file Google ships beside it. */
function bundledAdbVersion() {
  const exe = bundledAdb();
  if (!exe) return null;
  try {
    const props = fs.readFileSync(path.join(path.dirname(exe), 'source.properties'), 'utf8');
    const match = props.match(/Pkg\.Revision\s*=\s*(.+)/);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function setAdbPath(p) {
  cachedAdbPath = p || null;
}

/** Strip CR and trailing whitespace so downstream equality checks are honest. */
function normalise(text) {
  return String(text == null ? '' : text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Run adb. Never throws on a non-zero exit - callers get {ok, code, stdout}
 * and decide, because plenty of adb failures (package not installed, setting
 * absent) are normal answers rather than errors.
 */
function run(args, opts = {}) {
  const { serial, timeout = DEFAULT_TIMEOUT_MS } = opts;
  const argv = serial ? ['-s', serial, ...args] : args.slice();
  const bin = resolveAdb();

  return new Promise((resolve) => {
    execFile(bin, argv, { timeout, maxBuffer: MAX_BUFFER, windowsHide: true }, (err, stdout, stderr) => {
      const out = normalise(stdout).trim();
      const errText = normalise(stderr).trim();
      if (err && err.code === 'ENOENT') {
        resolve({
          ok: false,
          code: -1,
          stdout: '',
          stderr: `adb not found at "${bin}". Set it in Settings, or install Android platform-tools.`,
          argv,
        });
        return;
      }
      resolve({
        ok: !err,
        code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
        stdout: out,
        stderr: errText,
        argv,
      });
    });
  });
}

/** Run a command on the device. The whole command goes to adb as one argv
 *  element, so no local shell mangles the quoting. */
function shell(command, opts = {}) {
  return run(['shell', command], opts);
}

/** Convenience: shell command, stdout only, empty string on failure. */
async function shellOut(command, opts = {}) {
  const r = await shell(command, opts);
  return r.ok ? r.stdout : '';
}

function toLines(text) {
  return normalise(text)
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
}

/**
 * Signatures of the device losing the ability to answer mid-run.
 *
 * `pm`, `settings`, `am` and `cmd` are thin clients for services that live
 * inside system_server. When it dies they do not fail gracefully: the call that
 * was in flight reports a broken pipe, and every call after it reports the
 * service as simply missing. adb itself keeps answering the whole time, so the
 * exit code alone is indistinguishable from an ordinary refusal.
 *
 * Seen for real on the SM-T510: one `pm disable-user` took system_server down
 * with it, and the run carried on firing thirty more commands into a tablet
 * that was busy restarting - burying the one line that explained everything.
 *
 * "Failure calling service" is deliberately broad: it is a binder-transport
 * failure in every case seen so far, and the cost of being wrong is asymmetric.
 * A false positive stops a run that could have continued, which costs a re-run
 * and nothing else; a false negative is the bug this exists to prevent.
 */
const DEVICE_DOWN_PATTERNS = [
  /Can't find service:/i,
  /Failure calling service \w+/i,
  /Broken pipe/i,
  /DeadObjectException/i,
  /DeadSystemException/i,
  /device offline/i,
  /device (?:'[^']*' )?not found/i,
  /error: closed/i,
];

/**
 * Did this come back because the device stopped being able to answer, rather
 * than because the command was refused? Accepts run() results or raw strings.
 *
 * Callers use it to stop a run instead of hammering a rebooting tablet with the
 * rest of the queue.
 */
function deviceWentDown(...outputs) {
  const text = outputs
    .map((o) => (o && typeof o === 'object' ? `${o.stdout || ''}\n${o.stderr || ''}` : String(o == null ? '' : o)))
    .join('\n');
  return DEVICE_DOWN_PATTERNS.some((p) => p.test(text));
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<Array<{serial:string, state:string, model:string, product:string, usable:boolean}>>}
 */
async function listDevices() {
  const r = await run(['devices', '-l']);
  if (!r.ok) return [];
  const devices = [];
  for (const line of toLines(r.stdout)) {
    if (/^List of devices/i.test(line)) continue;
    const m = line.match(/^(\S+)\s+(\S+)(.*)$/);
    if (!m) continue;
    const [, serial, state, rest] = m;
    const grab = (key) => {
      const hit = rest.match(new RegExp(`${key}:(\\S+)`));
      return hit ? hit[1] : '';
    };
    devices.push({
      serial,
      state,
      model: grab('model').replace(/_/g, ' '),
      product: grab('product'),
      transport: grab('transport_id'),
      usable: state === 'device',
    });
  }
  return devices;
}

/** Full getprop dump as a plain object. One round trip instead of dozens. */
async function getProps(serial) {
  const text = await shellOut('getprop', { serial });
  const props = {};
  for (const line of toLines(text)) {
    const m = line.match(/^\[([^\]]+)\]:\s*\[(.*)\]$/);
    if (m) props[m[1]] = m[2];
  }
  return props;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** @returns {Promise<string|null>} null when the key is unset on this device. */
async function getSetting(serial, scope, key) {
  const r = await shell(`settings get ${scope} ${key}`, { serial });
  if (!r.ok) return null;
  const v = r.stdout.trim();
  if (v === '' || v === 'null') return null;
  return v;
}

async function putSetting(serial, scope, key, value) {
  return shell(`settings put ${scope} ${key} ${value}`, { serial });
}

async function deleteSetting(serial, scope, key) {
  return shell(`settings delete ${scope} ${key}`, { serial });
}

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------

function parsePackageList(text) {
  const set = new Set();
  for (const line of toLines(text)) {
    const m = line.match(/^package:(\S+)$/);
    if (m) set.add(m[1]);
  }
  return set;
}

/** Every package visible to user 0, enabled or not. Exact names. */
async function listPackages(serial) {
  return parsePackageList(await shellOut('pm list packages', { serial }));
}

/** Currently disabled packages. Used to make apply idempotent. */
async function listDisabledPackages(serial) {
  return parsePackageList(await shellOut('pm list packages -d', { serial }));
}

/** System (non-sideloaded) packages - the pool Discover looks at. */
async function listSystemPackages(serial) {
  return parsePackageList(await shellOut('pm list packages -s', { serial }));
}

/** Third-party packages - anything the restaurant installed themselves. */
async function listThirdPartyPackages(serial) {
  return parsePackageList(await shellOut('pm list packages -3', { serial }));
}

/**
 * Split a `dumpsys package` dump into exact-package-keyed blocks.
 *
 * This is the antidote to the prefix-match trap: dumpsys hands back a block for
 * every package that STARTS WITH the argument, so the caller must key on the
 * exact header rather than trusting the first match it reads.
 *
 * @returns {Map<string, string[]>} exact package name -> its block's lines
 */
function parsePackageBlocks(text) {
  const blocks = new Map();
  let current = null;
  for (const line of normalise(text).split('\n')) {
    const header = line.match(/^\s*Package \[([^\]]+)\]\s*\(/);
    if (header) {
      current = header[1];
      blocks.set(current, []);
      continue;
    }
    if (current) blocks.get(current).push(line);
  }
  return blocks;
}

/**
 * versionName / versionCode / enabled state for one EXACT package.
 * @returns {Promise<{installed:boolean, versionName:string|null, versionCode:string|null, enabled:boolean|null}>}
 */
async function getPackageInfo(serial, pkg) {
  const text = await shellOut(`dumpsys package ${pkg}`, { serial });
  const blocks = parsePackageBlocks(text);
  const lines = blocks.get(pkg); // exact key - never the prefix neighbours
  if (!lines) return { installed: false, versionName: null, versionCode: null, enabled: null };

  const body = lines.join('\n');
  const name = body.match(/versionName=(\S+)/);
  const code = body.match(/versionCode=(\d+)/);
  // enabled=0 means "default", which is enabled. 2 and 3 are the disabled states.
  const enabledState = body.match(/enabled=(\d+)/);
  let enabled = null;
  if (enabledState) {
    const n = Number(enabledState[1]);
    enabled = n === 0 || n === 1;
  }
  return {
    installed: true,
    versionName: name ? name[1] : null,
    versionCode: code ? code[1] : null,
    enabled,
  };
}

async function disablePackage(serial, pkg) {
  return shell(`pm disable-user --user 0 ${pkg}`, { serial });
}

async function enablePackage(serial, pkg) {
  return shell(`pm enable ${pkg}`, { serial });
}

// ---------------------------------------------------------------------------
// Per-app background survival
// ---------------------------------------------------------------------------

/** Packages currently exempt from doze. */
async function getDozeWhitelist(serial) {
  const text = await shellOut('dumpsys deviceidle whitelist', { serial });
  const set = new Set();
  for (const line of toLines(text)) {
    // Lines look like "system,com.foo,10123" or occasionally just "com.foo".
    for (const field of line.split(',')) {
      const f = field.trim();
      if (/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i.test(f)) set.add(f);
    }
  }
  return set;
}

async function addToDozeWhitelist(serial, pkg) {
  return shell(`dumpsys deviceidle whitelist +${pkg}`, { serial });
}

async function removeFromDozeWhitelist(serial, pkg) {
  return shell(`dumpsys deviceidle whitelist -${pkg}`, { serial });
}

/** 10 active, 20 working set, 30 frequent, 40 rare, 45 restricted. */
async function getStandbyBucket(serial, pkg) {
  const out = await shellOut(`am get-standby-bucket ${pkg}`, { serial });
  const n = parseInt(out.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

async function setStandbyBucket(serial, pkg, bucket = 'active') {
  return shell(`am set-standby-bucket ${pkg} ${bucket}`, { serial });
}

async function getAppOp(serial, pkg, op) {
  const out = await shellOut(`cmd appops get ${pkg} ${op}`, { serial });
  const m = out.match(new RegExp(`${op}:\\s*(\\w+)`));
  return m ? m[1] : null;
}

async function setAppOp(serial, pkg, op, mode) {
  return shell(`cmd appops set ${pkg} ${op} ${mode}`, { serial });
}

// ---------------------------------------------------------------------------
// Device-specific things worth protecting
// ---------------------------------------------------------------------------

/** The package that owns the current keyboard. Disabling it strands the device. */
async function getDefaultImePackage(serial) {
  const v = await getSetting(serial, 'secure', 'default_input_method');
  if (!v) return null;
  return v.split('/')[0] || null;
}

/**
 * The package that owns HOME. Disabling it leaves a black screen on boot, so a
 * null here silently weakens the guard list - it is worth being stubborn.
 *
 * The action MUST be passed with -a. Supplying it positionally returns
 * "No activity found" on real hardware (verified on an SM-T227U, Android 14),
 * which looked exactly like "this device has no launcher".
 */
async function getLauncherPackage(serial) {
  const attempts = [
    'cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME',
    'cmd package resolve-activity -a android.intent.action.MAIN -c android.intent.category.HOME',
  ];
  for (const command of attempts) {
    const out = await shellOut(command, { serial });
    if (/No activity found/i.test(out)) continue;
    for (const line of toLines(out).reverse()) {
      // "com.sec.android.app.launcher/.activities.LauncherActivity"
      const brief = line.match(/^([a-z][\w.]*\.[\w.]+)\//i);
      if (brief) return brief[1];
      // Verbose form: "packageName=com.sec.android.app.launcher"
      const verbose = line.match(/packageName=([a-z][\w.]*\.[\w.]+)/i);
      if (verbose) return verbose[1];
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Health readouts
// ---------------------------------------------------------------------------

/** BatteryManager.BATTERY_HEALTH_* as dumpsys prints them. */
const BATTERY_HEALTH = { 1: 'unknown', 2: 'good', 3: 'overheat', 4: 'dead', 5: 'over voltage', 6: 'failure', 7: 'cold' };

async function getBattery(serial) {
  const text = await shellOut('dumpsys battery', { serial });
  const level = text.match(/level:\s*(\d+)/);
  const acPowered = /AC powered:\s*true/.test(text);
  const usbPowered = /USB powered:\s*true/.test(text);
  const wirelessPowered = /Wireless powered:\s*true/.test(text);
  // A tablet that lives on a charger is the one whose battery swells, so the
  // health and temperature the kernel reports are worth a line on the Verify
  // tab. Temperature is in tenths of a degree C.
  const health = text.match(/health:\s*(\d+)/);
  const temperature = text.match(/temperature:\s*(-?\d+)/);
  return {
    level: level ? Number(level[1]) : null,
    charging: acPowered || usbPowered || wirelessPowered,
    health: health ? BATTERY_HEALTH[Number(health[1])] || health[1] : null,
    temperatureC: temperature ? Number(temperature[1]) / 10 : null,
  };
}

async function getMemory(serial) {
  const text = await shellOut('cat /proc/meminfo', { serial });
  const kb = (key) => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'));
    return m ? Number(m[1]) * 1024 : null;
  };
  return { total: kb('MemTotal'), available: kb('MemAvailable') };
}

async function getStorage(serial) {
  const text = await shellOut('df /data', { serial });
  const lines = toLines(text);
  const last = lines[lines.length - 1] || '';
  const cols = last.split(/\s+/);
  if (cols.length < 4) return { total: null, available: null };
  const toBytes = (v) => (Number.isFinite(Number(v)) ? Number(v) * 1024 : null);
  return { total: toBytes(cols[1]), available: toBytes(cols[3]) };
}

/**
 * Whether any Google account is signed in.
 *
 * This decides whether the tablet can ever update itself. With no account,
 * Play cannot install or update anything, so every future version of the order
 * app has to arrive over a USB cable. Worth knowing BEFORE the tablet leaves
 * the bench rather than three months later when it is silently out of date.
 *
 * `dumpsys account` is the obvious source and is useless on One UI: it prints
 * an add/remove audit history and the list of registered AUTHENTICATORS, but
 * never the accounts themselves. Verified on an SM-T510 running Android 11,
 * where it reported "no Google account" on a tablet that had one signed in -
 * the worst kind of wrong answer, because it is the reassuring one.
 *
 * `dumpsys content` (the sync manager) does list them, one header line per
 * real account in its Sync Status section:
 *
 *     Sync Status
 *     Account someone@gmail.com u0 com.google
 *     Account Meet u0 com.google.android.apps.tachyon
 *
 * Note the second line: Meet/Duo registers an account of its own, so the
 * "Accounts: N" total in the same dump is NOT the number of Google accounts.
 * Only an entry whose type is exactly com.google means Play has something to
 * work with.
 */
async function getAccounts(serial) {
  const content = await shellOut('dumpsys content', { serial });

  // Anchored to the start of the line so the SyncAdapterType and ServiceInfo
  // registrations further down the dump - which also carry type=com.google on
  // a device with no account at all - cannot be mistaken for a real account.
  let types = [...content.matchAll(/^Account\s+(.+?)\s+u(\d+)\s+([\w.]+)\s*$/gm)].map((m) => m[3]);

  const totalMatch = content.match(/^Accounts:\s*(\d+)/m);
  let count = totalMatch ? Number(totalMatch[1]) : null;

  // Fallback for platforms whose sync manager dump is shaped differently but
  // whose `dumpsys account` does emit real "Account {name=..., type=...}"
  // blocks. Only consulted when the primary source found nothing, so the
  // common case stays at one adb round trip.
  if (types.length === 0) {
    const legacy = await shellOut('dumpsys account', { serial });
    types = [...legacy.matchAll(/Account\s*\{[^}]*?type=([\w.]+)/g)].map((m) => m[1]);
    if (count == null) {
      const legacyCount = legacy.match(/Accounts:\s*(\d+)/);
      if (legacyCount) count = Number(legacyCount[1]);
    }
  }

  const googleCount = types.filter((t) => t === 'com.google').length;

  return {
    count: count == null ? types.length || null : count,
    googleCount,
    hasGoogle: googleCount > 0,
    types: [...new Set(types)],
  };
}

/**
 * Whether another MDM already owns this tablet.
 *
 * A Device Owner outranks everything adb can do: it can re-enable packages you
 * disable, re-impose settings you change, and it cannot be removed with
 * `dpm remove-active-admin`, `pm uninstall` or `pm disable-user` - all three
 * are refused (verified on a Hexnode-enrolled SM-T227U). Finding one means
 * Panda Bench's changes are provisional, and the operator needs to know that
 * before shipping the tablet.
 */
async function getManagement(serial) {
  const text = await shellOut('dumpsys device_policy', { serial });

  const owner = text.match(/Device Owner:[\s\S]{0,600}?admin=ComponentInfo\{([\w.]+)\//);
  const profile = text.match(/Profile Owner[\s\S]{0,600}?admin=ComponentInfo\{([\w.]+)\//);

  // A Device Owner can forbid the very things this tool tries to do - most
  // importantly changing the wallpaper (no_wallpaper) and the one action that
  // would remove it (no_factory_reset). Reading these is what stops Panda Bench
  // reporting success for an action the platform silently refused.
  const restrictionDump = await shellOut('dumpsys user', { serial });
  const restrictions = [...new Set((restrictionDump.match(/\bno_[a-z_]+/g) || []))].sort();

  return {
    deviceOwner: owner ? owner[1] : null,
    profileOwner: profile ? profile[1] : null,
    organizationOwned: /isOrganizationOwnedDevice=true/.test(text),
    factoryResetBlocked: restrictions.includes('no_factory_reset'),
    wallpaperBlocked: restrictions.includes('no_wallpaper'),
    restrictions,
  };
}

/** Which package last set the wallpaper - names the MDM when one owns it. */
async function getWallpaperOwner(serial) {
  const text = await shellOut('dumpsys wallpaper', { serial });
  const m = text.match(/mLastCallingPackage=([\w.]+)/);
  return m ? m[1] : null;
}

async function getUptimeSeconds(serial) {
  const text = await shellOut('cat /proc/uptime', { serial });
  const n = parseFloat(text.split(/\s+/)[0]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Media stream volume and its device-specific maximum (the max is 15 on some
 * devices and 150 on others, so it has to be read rather than assumed).
 *
 * The bare `media` binary does NOT exist on every device - on an SM-T227U it is
 * "inaccessible or not found". `cmd media_session` is the portable spelling,
 * and dumpsys is the backstop when even that is missing.
 */
async function getMediaVolume(serial) {
  for (const command of ['cmd media_session volume --stream 3 --get', 'media volume --stream 3 --get']) {
    const out = await shellOut(command, { serial });
    // "[V] volume is 15 in range [0..15]" - the [V] prefix lines are noise.
    const m = out.match(/volume is (\d+) in range \[(\d+)\.\.(\d+)\]/);
    if (m) return { current: Number(m[1]), max: Number(m[3]) };
  }

  // Backstop: parse the STREAM_MUSIC block out of dumpsys audio.
  const audio = await shellOut('dumpsys audio', { serial });
  const block = normalise(audio).split(/^-\s*STREAM_/m).find((b) => b.startsWith('MUSIC'));
  if (block) {
    const max = block.match(/Max:\s*(\d+)/);
    const current = block.match(/streamVolume:\s*(\d+)/) || block.match(/Current:[^\n]*?:\s*(\d+)/);
    if (max) {
      return { current: current ? Number(current[1]) : null, max: Number(max[1]) };
    }
  }
  return { current: null, max: null };
}

async function setMediaVolume(serial, value) {
  const r = await shell(`cmd media_session volume --stream 3 --set ${value}`, { serial });
  if (r.ok && !/not found|Exception/i.test(r.stdout + r.stderr)) return r;
  return shell(`media volume --stream 3 --set ${value}`, { serial });
}

/**
 * Screen brightness and the device's own maximum.
 *
 * `settings get system screen_brightness` is an int on a scale the OEM picks.
 * 255 is the AOSP maximum and what Android 11+ syncs its internal float back
 * to, but 1023 and 2047 devices exist, so the scale has to be read before a
 * percentage means anything.
 *
 * There is no adb accessor for that maximum - it is a framework resource - so
 * it gets scraped out of the display and power dumps, with 255 as the backstop
 * when neither names it. Android 11+ prints those fields as 0..1 floats, which
 * are a different scale entirely and would read as a maximum of 1, so anything
 * that small is ignored rather than believed. A maximum below the value the
 * device is already storing is wrong by definition, so it widens to fit.
 */
async function getBrightness(serial) {
  const raw = await getSetting(serial, 'system', 'screen_brightness');
  const current = raw != null && /^\d+$/.test(raw) ? Number(raw) : null;

  let max = null;
  for (const command of ['dumpsys display', 'dumpsys power']) {
    const text = await shellOut(command, { serial });
    const m = text.match(/(?:mScreenBrightnessSettingMaximum|mScreenBrightnessRangeMaximum)=(\d+)(?![\d.])/);
    if (m && Number(m[1]) > 1) {
      max = Number(m[1]);
      break;
    }
  }
  if (max == null) max = 255;
  if (current != null && current > max) max = current;

  return { current, max };
}

async function setBrightness(serial, value) {
  return putSetting(serial, 'system', 'screen_brightness', value);
}

async function trimCaches(serial) {
  return shell('pm trim-caches 999G', { serial });
}

// ---------------------------------------------------------------------------
// Power
// ---------------------------------------------------------------------------

/**
 * Reboot the tablet.
 *
 * The device drops off adb for roughly a minute afterwards, so the caller has
 * to expect it to vanish from the device list and come back on its own.
 *
 * Losing the connection is the SUCCESS case for both of these, not a failure:
 * adb stops answering precisely because the command worked. deviceWentDown()
 * exists to spot a tablet dying unexpectedly mid-run, so here its signatures
 * mean the opposite of what they usually do and are treated as confirmation.
 */
async function rebootDevice(serial) {
  const r = await run(['reboot'], { serial });
  return { ok: r.ok || deviceWentDown(r), stderr: r.stderr };
}

/**
 * Power the tablet off.
 *
 * `adb reboot -p` is the portable spelling and the one that works on One UI;
 * `svc power shutdown` is a fallback for builds that refuse it.
 *
 * There is no adb path back from this. With the tablet off there is no adbd
 * listening, so nothing here or anywhere else can turn it back on - someone
 * has to walk over and hold the power button.
 */
async function powerOffDevice(serial) {
  const first = await run(['reboot', '-p'], { serial });
  if (first.ok || deviceWentDown(first)) return { ok: true, via: 'adb reboot -p', stderr: '' };

  const second = await shell('svc power shutdown', { serial });
  return {
    ok: second.ok || deviceWentDown(second),
    via: 'svc power shutdown',
    stderr: second.stderr || first.stderr,
  };
}

// ---------------------------------------------------------------------------
// Installing and launching
// ---------------------------------------------------------------------------

/** Turn pm's shouty failure codes into something worth reading. */
function explainInstallFailure(output) {
  const map = [
    [
      /INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i,
      'A build with the same package but a different signing key is already installed. Uninstall the existing one first - note that uninstalling the paired production app loses its pairing.',
    ],
    [/INSTALL_FAILED_VERSION_DOWNGRADE/i, 'The tablet already has a newer version of this app. Uninstall it first, or install a newer build.'],
    [/INSTALL_FAILED_INSUFFICIENT_STORAGE/i, 'Not enough free space on the tablet.'],
    [/INSTALL_FAILED_OLDER_SDK/i, 'This APK requires a newer Android version than the tablet runs.'],
    [/INSTALL_FAILED_ALREADY_EXISTS/i, 'Already installed. Reinstall was not permitted.'],
    [/INSTALL_FAILED_TEST_ONLY/i, 'This APK is marked test-only. Build a release variant, or install with -t.'],
    [/INSTALL_PARSE_FAILED[_A-Z]*/i, 'The file could not be parsed as an APK. It may be corrupt or only partly downloaded.'],
    [/device unauthorized/i, 'The tablet has not authorised this PC. Accept the USB debugging prompt on its screen.'],
  ];
  for (const [pattern, message] of map) {
    if (pattern.test(output)) return message;
  }
  return null;
}

/**
 * Install an APK. `-r` keeps existing app data on reinstall, `-g` pre-grants
 * runtime permissions so nobody has to tap through dialogs on a counter tablet.
 * Older platforms reject `-g`, so it retries without.
 */
async function installApk(serial, apkPath, opts = {}) {
  const { grantPermissions = true, allowDowngrade = false } = opts;
  const build = (withGrant) => {
    const args = ['install', '-r'];
    if (withGrant) args.push('-g');
    if (allowDowngrade) args.push('-d');
    args.push(apkPath);
    return args;
  };

  let r = await run(build(grantPermissions), { serial, timeout: 600000 });
  const output = `${r.stdout}\n${r.stderr}`;

  if (grantPermissions && /Unknown option|flag.*-g|Invalid|bad argument/i.test(output)) {
    r = await run(build(false), { serial, timeout: 600000 });
  }

  const combined = `${r.stdout}\n${r.stderr}`;
  const success = /^Success$/m.test(combined) || (r.ok && !/Failure|Error/i.test(combined));
  return { ok: success, output: combined.trim(), reason: success ? null : explainInstallFailure(combined) };
}

async function uninstallPackage(serial, pkg) {
  return run(['uninstall', pkg], { serial, timeout: 120000 });
}

/**
 * Launch an app without needing to know its launcher activity name.
 * monkey resolves the LAUNCHER intent itself, which survives the activity
 * being renamed.
 */
async function launchApp(serial, pkg) {
  const r = await shell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`, { serial });
  const output = `${r.stdout}\n${r.stderr}`;
  return { ok: r.ok && !/No activities found|Error/i.test(output), output: output.trim() };
}

// ---------------------------------------------------------------------------
// Wallpaper
// ---------------------------------------------------------------------------

/**
 * Setting the wallpaper image outright is NOT possible over adb.
 * `cmd wallpaper` exists but only exposes dimming - there is no `set`. The AOSP
 * CROP_AND_SET_WALLPAPER activity resolves on One UI but dies instantly (it is
 * a vestigial stub; Samsung ships its own picker). Both verified on an SM-T227U
 * running Android 14.
 *
 * What DOES work is this three-step dance: push the file, register it with
 * MediaStore so it has a content:// identity, then fire the standard "Set as"
 * intent against that URI with a read grant. The operator taps "Set as
 * wallpaper" and picks home/lock. A file:// URI silently fails at the same
 * step, which is why the MediaStore round trip is not optional.
 */
async function pushFile(serial, localPath, devicePath) {
  return run(['push', localPath, devicePath], { serial, timeout: 300000 });
}

async function indexInMediaStore(serial, devicePath) {
  return shell(`content call --uri content://media/external --method scan_file --arg ${devicePath}`, { serial });
}

/** MediaStore rewrites /sdcard to /storage/emulated/0, so match on basename. */
async function findMediaId(serial, devicePath) {
  const basename = devicePath.split('/').pop();
  const out = await shellOut(
    `content query --uri content://media/external/images/media --projection _id --where "_data LIKE '%${basename}'"`,
    { serial }
  );
  const matches = [...out.matchAll(/_id=(\d+)/g)];
  return matches.length ? matches[matches.length - 1][1] : null;
}

async function openSetAsWallpaper(serial, contentUri, mimeType = 'image/png') {
  const r = await shell(
    `am start --grant-read-uri-permission -a android.intent.action.ATTACH_DATA -d ${contentUri} -t ${mimeType}`,
    { serial }
  );
  const output = `${r.stdout}\n${r.stderr}`;
  return { ok: r.ok && !/Error|Unable to resolve/i.test(output), output: output.trim() };
}

// ---------------------------------------------------------------------------
// System update
// ---------------------------------------------------------------------------

/**
 * Open the OS update screen on the tablet. There is no adb path to actually
 * downloading or applying a firmware update - that is signed, vendor-driven,
 * and requires taps on the device. This just gets the operator to the right
 * screen without hunting through Settings.
 */
async function openSystemUpdate(serial) {
  const attempts = [
    ['Android system update', 'am start -a android.settings.SYSTEM_UPDATE_SETTINGS'],
    ['Samsung software update', 'am start -n com.wssyncmldm/com.samsung.sdm.sdmviewer.SDMActivity'],
    ['Settings', 'am start -a android.settings.SETTINGS'],
  ];
  for (const [label, command] of attempts) {
    const r = await shell(command, { serial });
    const output = `${r.stdout}\n${r.stderr}`;
    if (r.ok && !/Error|Unable to resolve|No activity found/i.test(output)) {
      return { ok: true, via: label };
    }
  }
  return { ok: false, via: null };
}

/**
 * Open the app's Play Store page ON THE TABLET so the operator just taps
 * Install. Play is the production install path for the order app, and there is
 * no headless way to drive a Play install without an account on the device.
 */
async function openPlayListing(serial, pkg) {
  const market = await shell(`am start -a android.intent.action.VIEW -d "market://details?id=${pkg}"`, { serial });
  const marketOut = `${market.stdout}\n${market.stderr}`;
  if (market.ok && !/Error|Unable to resolve/i.test(marketOut)) return { ok: true, via: 'Play Store app' };

  // No Play app (or it is disabled) - fall back to the web listing.
  const web = await shell(
    `am start -a android.intent.action.VIEW -d "https://play.google.com/store/apps/details?id=${pkg}"`,
    { serial }
  );
  const webOut = `${web.stdout}\n${web.stderr}`;
  return {
    ok: web.ok && !/Error|Unable to resolve/i.test(webOut),
    via: 'browser',
    output: `${marketOut}\n${webOut}`.trim(),
  };
}

// ---------------------------------------------------------------------------
// Readiness - what the Verify tab reads after the reboot
// ---------------------------------------------------------------------------

/**
 * Services of one EXACT package that are running right now.
 *
 * `dumpsys activity services <pkg>` prefix-matches exactly like `dumpsys
 * package` does, so the .staging and .dev builds' services come back in the
 * same dump. Each record's header names its package, and only a header whose
 * package is an exact match is kept. `isForeground=` sits on a later line of
 * the same record - a foreground service is the one Android will not kill.
 *
 * @returns {Array<{name:string, foreground:boolean}>}
 */
function parseRunningServices(text, pkg) {
  const services = [];
  let current = null;
  for (const line of normalise(text).split('\n')) {
    const header = line.match(/^\s*\* ServiceRecord\{[0-9a-f]+ u\d+ ([\w.]+)\/([\w.$]+)\}/);
    if (header) {
      current = null;
      if (header[1] === pkg) {
        const cls = header[2].startsWith('.') ? `${pkg}${header[2]}` : header[2];
        current = { name: cls, foreground: false };
        services.push(current);
      }
      continue;
    }
    if (current) {
      const fg = line.match(/\bisForeground=(true|false)/);
      if (fg) current.foreground = fg[1] === 'true';
    }
  }
  return services;
}

async function getRunningServices(serial, pkg) {
  return parseRunningServices(await shellOut(`dumpsys activity services ${pkg}`, { serial }), pkg);
}

/**
 * Runtime permission grants for one EXACT package.
 *
 * Only the "runtime permissions:" section counts. The install permissions
 * above it also print granted=true, and they are always true - reading them
 * would report a denied notification permission as granted. A permission the
 * dump does not list is one this build does not declare, or one that is not a
 * runtime permission on this Android version; either way there is nothing to
 * grant, so it is simply absent from the result.
 *
 * @returns {Object<string, boolean>|null} null when the package is not installed
 */
function parseRuntimePermissions(text, pkg) {
  const lines = parsePackageBlocks(text).get(pkg);
  if (!lines) return null;
  const grants = {};
  let inRuntime = false;
  for (const line of lines) {
    if (/^\s*runtime permissions:/.test(line)) {
      inRuntime = true;
      continue;
    }
    if (!inRuntime) continue;
    const m = line.match(/^\s+([\w.]+): granted=(true|false)/);
    if (m) grants[m[1]] = m[2] === 'true';
    else if (line.trim() !== '') break;
  }
  return grants;
}

async function getRuntimePermissions(serial, pkg) {
  return parseRuntimePermissions(await shellOut(`dumpsys package ${pkg}`, { serial }), pkg);
}

/** Grant a runtime permission the way `install -g` would have. Reversible with revokePermission. */
async function grantPermission(serial, pkg, permission) {
  return shell(`pm grant ${pkg} ${permission}`, { serial });
}

async function revokePermission(serial, pkg, permission) {
  return shell(`pm revoke ${pkg} ${permission}`, { serial });
}

/**
 * Lock screen state, from two reads.
 *
 * `locksettings get-disabled` says whether the lock screen shows at all.
 * `dumpsys lock_settings` says whether a PIN, pattern or password is behind
 * it (CredentialType: NONE | PIN | PATTERN | PASSWORD). A swipe-only lock
 * screen can be turned off over adb; one with a credential needs that
 * credential, so it is reported rather than touched. Both verified on an
 * SM-T227U running Android 14.
 */
function parseLockScreen(disabledOut, dumpText) {
  const d = String(disabledOut || '').trim().toLowerCase();
  const disabled = d === 'true' ? true : d === 'false' ? false : null;
  const m = String(dumpText || '').match(/CredentialType:\s*(\w+)/);
  return { disabled, credentialType: m ? m[1].toUpperCase() : null };
}

async function getLockScreen(serial) {
  const [disabledOut, dump] = await Promise.all([
    shellOut('locksettings get-disabled', { serial }),
    shellOut('dumpsys lock_settings', { serial }),
  ]);
  return parseLockScreen(disabledOut, dump);
}

async function setLockScreenDisabled(serial, disabled) {
  return shell(`locksettings set-disabled ${disabled ? 'true' : 'false'}`, { serial });
}

/**
 * Wi-Fi state. `cmd wifi status` (Android 11+) prints one line per fact;
 * `dumpsys wifi` is the backstop for older builds, whose mWifiInfo line
 * carries the same SSID/RSSI fields.
 */
function parseWifiStatus(text) {
  const t = normalise(text);
  const enabled = /^Wifi is enabled/m.test(t) ? true : /^Wifi is disabled/m.test(t) ? false : null;
  const conn = t.match(/^Wifi is connected to "(.*?)"/m);
  const ip = t.match(/\bIP: \/?(\d+\.\d+\.\d+\.\d+)/);
  const rssi = t.match(/\bRSSI: (-?\d+)/);
  return {
    enabled,
    connected: Boolean(conn),
    ssid: conn ? conn[1] : null,
    ip: ip ? ip[1] : null,
    rssi: rssi ? Number(rssi[1]) : null,
  };
}

function parseWifiDump(text) {
  const t = normalise(text);
  const info = t.match(/mWifiInfo[^\n]*/);
  const line = info ? info[0] : '';
  const ssid = line.match(/SSID: "?([^",]*)"?,/);
  const rssi = line.match(/\bRSSI: (-?\d+)/);
  const connected = /mNetworkInfo[^\n]*state: CONNECTED/.test(t) || /Supplicant state: COMPLETED/.test(line);
  const enabled = /Wi-Fi is enabled|mWifiState=?\s*enabled|WifiState: ENABLED/i.test(t) ? true : null;
  return {
    enabled,
    connected,
    ssid: connected && ssid && ssid[1] && ssid[1] !== '<unknown ssid>' ? ssid[1] : null,
    ip: null,
    rssi: rssi ? Number(rssi[1]) : null,
  };
}

async function getWifi(serial) {
  const status = await shellOut('cmd wifi status', { serial });
  if (/^Wifi is/m.test(status)) return parseWifiStatus(status);
  return parseWifiDump(await shellOut('dumpsys wifi', { serial }));
}

/** The tablet's clock against this PC's, and its time zone. */
async function getClock(serial) {
  const [epochOut, tz] = await Promise.all([
    shellOut('date +%s', { serial }),
    shellOut('getprop persist.sys.timezone', { serial }),
  ]);
  const epoch = parseInt(epochOut.trim(), 10);
  return {
    epoch: Number.isFinite(epoch) ? epoch : null,
    timezone: tz.trim() || null,
    driftSeconds: Number.isFinite(epoch) ? Math.round(epoch - Date.now() / 1000) : null,
  };
}

/** A hostname or IPv4 address. Anything else never reaches the shell. */
const HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252}[A-Za-z0-9])?$/;

function parsePing(text) {
  const t = normalise(text);
  const time = t.match(/time=([\d.]+) ms/);
  const received = /\bbytes from\b/.test(t) && !/\b0 received\b/.test(t);
  return { ok: received, ms: time ? Number(time[1]) : null };
}

/**
 * One ping FROM THE TABLET, because that is the network the orders arrive on.
 * A host the PC can reach over Ethernet says nothing about a tablet on the
 * restaurant's Wi-Fi.
 */
async function pingHost(serial, host) {
  if (!HOST_PATTERN.test(String(host || ''))) return { ok: false, ms: null, error: 'not a valid host name or IP address' };
  const r = await shell(`ping -c 1 -W 3 ${host}`, { serial, timeout: 15000 });
  const parsed = parsePing(`${r.stdout}\n${r.stderr}`);
  const lines = toLines(`${r.stdout}\n${r.stderr}`);
  return { ok: r.ok && parsed.ok, ms: parsed.ms, output: lines[lines.length - 1] || '' };
}

/**
 * Send a file on the tablet to a TCP port, FROM THE TABLET. Toybox ships `nc`
 * on every Android build this tool has met, and a raw ESC/POS slip to port
 * 9100 is exactly how the order app prints to a LAN printer, so this proves
 * the tablet-to-printer path without touching the app.
 */
async function sendFileToPort(serial, host, port, deviceFile) {
  if (!HOST_PATTERN.test(String(host || ''))) return { ok: false, error: 'not a valid host name or IP address' };
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return { ok: false, error: 'not a valid port' };
  const r = await shell(`nc -w 5 ${host} ${p} < ${deviceFile}`, { serial, timeout: 20000 });
  const output = `${r.stdout}\n${r.stderr}`.trim();
  return { ok: r.ok && !/refused|unreachable|timed? ?out|No route|nc:/i.test(output), output };
}

/**
 * Turn USB debugging off. adbd stops the moment the setting lands, so losing
 * the connection is the success case here, exactly as it is for a reboot.
 * Getting it back on means Settings > Developer options on the tablet itself.
 */
async function disableUsbDebugging(serial) {
  const r = await putSetting(serial, 'global', 'adb_enabled', 0);
  return { ok: r.ok || deviceWentDown(r), stderr: r.stderr };
}

/** File contents from the tablet, or null when it is not there. */
async function readDeviceFile(serial, devicePath) {
  const r = await shell(`cat ${devicePath}`, { serial });
  if (!r.ok || /No such file|Permission denied|Is a directory/i.test(`${r.stdout}\n${r.stderr}`)) return null;
  return r.stdout;
}

async function ensureDeviceDir(serial, devicePath) {
  return shell(`mkdir -p ${devicePath}`, { serial });
}

module.exports = {
  resolveAdb,
  bundledAdb,
  bundledAdbVersion,
  setAdbPath,
  run,
  shell,
  shellOut,
  toLines,
  normalise,
  deviceWentDown,
  parseRunningServices,
  getRunningServices,
  parseRuntimePermissions,
  getRuntimePermissions,
  grantPermission,
  revokePermission,
  parseLockScreen,
  getLockScreen,
  setLockScreenDisabled,
  parseWifiStatus,
  parseWifiDump,
  getWifi,
  getClock,
  parsePing,
  pingHost,
  sendFileToPort,
  disableUsbDebugging,
  readDeviceFile,
  ensureDeviceDir,
  listDevices,
  getProps,
  getSetting,
  putSetting,
  deleteSetting,
  listPackages,
  listDisabledPackages,
  listSystemPackages,
  listThirdPartyPackages,
  parsePackageBlocks,
  getPackageInfo,
  disablePackage,
  enablePackage,
  getDozeWhitelist,
  addToDozeWhitelist,
  removeFromDozeWhitelist,
  getStandbyBucket,
  setStandbyBucket,
  getAppOp,
  setAppOp,
  getDefaultImePackage,
  getLauncherPackage,
  getBattery,
  getMemory,
  getStorage,
  getAccounts,
  getManagement,
  getWallpaperOwner,
  getUptimeSeconds,
  getMediaVolume,
  setMediaVolume,
  getBrightness,
  setBrightness,
  trimCaches,
  rebootDevice,
  powerOffDevice,
  installApk,
  uninstallPackage,
  launchApp,
  openPlayListing,
  explainInstallFailure,
  pushFile,
  indexInMediaStore,
  findMediaId,
  openSetAsWallpaper,
  openSystemUpdate,
};
