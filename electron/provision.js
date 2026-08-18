'use strict';

/**
 * The Panda Bench engine: audit, apply, revert, discover.
 *
 * Design rules this file is built on:
 *
 *   - Nothing is uninstalled. Bloat is `pm disable-user --user 0`, which `pm
 *     enable` undoes completely.
 *   - Nothing is changed before its previous value is written to disk. Apply
 *     writes the rollback file BEFORE it touches the device, so a tool crash
 *     mid-run still leaves a working Revert.
 *   - A package is only disabled if it survives the guard list, and the guard
 *     list is resolved per device (the current keyboard and launcher differ
 *     between Samsung and Lenovo, and disabling either one bricks the tablet
 *     for practical purposes).
 *   - Packages that are not installed are skipped silently, so an over-broad
 *     bloat list is safe rather than dangerous.
 */

const fs = require('node:fs');
const path = require('node:path');
const adb = require('./adb');
const apk = require('./apk');
const profiles = require('./profiles');

const PANDA_PREFIX = 'com.pandaeats.';
const APP_OPS = ['RUN_IN_BACKGROUND', 'RUN_ANY_IN_BACKGROUND'];

/**
 * Counter tablets get read from across a counter, usually with the room lights
 * up, so brightness is held at a floor rather than pinned to a value: a tablet
 * the restaurant has already turned up brighter than this is left alone.
 */
const BRIGHTNESS_FLOOR = 0.8;

/**
 * The lowest acceptable brightness on this device's own scale, or null when
 * that scale could not be read.
 */
function brightnessFloorFor(brightness) {
  if (!brightness || brightness.max == null) return null;
  return Math.ceil(brightness.max * BRIGHTNESS_FLOOR);
}

/**
 * The framework package. Listed by `pm list packages` on every Android device
 * there is, so its absence means the read failed - not that the device is
 * unusually bare.
 */
const FRAMEWORK_PACKAGE = 'android';

/** A stripped AOSP build lists well over this; a stock Samsung lists 300+. */
const MIN_PLAUSIBLE_PACKAGES = 40;

/**
 * Refuse to plan from a package list that cannot be true.
 *
 * `pm list packages` is a thin client for a service inside system_server, and
 * shellOut() turns any failure into an empty string, which parses into an empty
 * - and entirely plausible-looking - Set. A tablet that is mid-restart
 * therefore reads as "almost nothing is installed", and every entry in the
 * profile silently drops out of the plan as "not on this device". The run then
 * reports success for a device it never actually touched.
 *
 * A partial read is the nastier version of this: enough packages come back to
 * look like a real device, so the count alone does not catch it. Requiring the
 * framework package does.
 */
function assertInventorySane(installed) {
  if (installed.has(FRAMEWORK_PACKAGE) && installed.size >= MIN_PLAUSIBLE_PACKAGES) return;
  throw new Error(
    `Could not read the tablet's installed packages - only ${installed.size} came back` +
      `${installed.has(FRAMEWORK_PACKAGE) ? '' : ', and the Android framework package was not among them'}. ` +
      'The tablet is most likely still booting or has just restarted. Wait for it to settle, then try again.'
  );
}

/**
 * Android standby buckets, lower is better:
 *   5 EXEMPTED, 10 ACTIVE, 20 WORKING_SET, 30 FREQUENT, 40 RARE, 45 RESTRICTED
 *
 * The goal is "at least as good as ACTIVE", not "exactly ACTIVE". A tablet
 * whose order app sits in EXEMPTED (5) is in the best possible state, and
 * testing for equality with ACTIVE reported that as broken and re-applied the
 * fix on every single run.
 */
const BUCKET_ACTIVE = 10;
const bucketIsGoodEnough = (bucket) => bucket != null && bucket <= BUCKET_ACTIVE;

let stateDir = path.join(__dirname, '..', 'state');

function setStateDir(dir) {
  stateDir = dir;
  ensureStateDir();
}

function ensureStateDir() {
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
  return stateDir;
}

/**
 * Android reports "1.0" where the profile says "1", and "0.0" where it says
 * "0". Compare numerically when both sides are numbers so the audit does not
 * report permanent phantom drift.
 */
function valuesEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  return String(a).trim() === String(b).trim();
}

/**
 * The set of packages that must not be disabled on THIS device.
 * Static guard list, plus the live keyboard, the live launcher, and everything
 * of ours.
 */
async function resolveProtected(serial, installed) {
  const set = profiles.loadProtected();
  const [ime, launcher] = await Promise.all([
    adb.getDefaultImePackage(serial),
    adb.getLauncherPackage(serial),
  ]);
  if (ime) set.add(ime);
  if (launcher) set.add(launcher);
  for (const pkg of installed) {
    if (pkg.startsWith(PANDA_PREFIX)) set.add(pkg);
  }
  return { set, ime, launcher };
}

/**
 * Our own packages actually present on the device.
 * `pm list packages` returns exact names, so prefix-filtering that list is safe
 * - unlike prefix-matching dumpsys, which is the documented trap.
 */
function pandaPackages(installed) {
  return [...installed].filter((p) => p.startsWith(PANDA_PREFIX)).sort();
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * Read-only. Touches nothing. This is what Apply plans from, so if the audit
 * says a device is clean, Apply has nothing to do.
 */
async function audit(serial, opts = {}) {
  const aggressive = !!opts.aggressive;

  const props = await adb.getProps(serial);
  const manufacturer = props['ro.product.manufacturer'] || '';

  const [battery, memory, storage, uptime, mediaVolume, brightness, installed, disabled, doze, accounts] =
    await Promise.all([
      adb.getBattery(serial),
      adb.getMemory(serial),
      adb.getStorage(serial),
      adb.getUptimeSeconds(serial),
      adb.getMediaVolume(serial),
      adb.getBrightness(serial),
      adb.listPackages(serial),
      adb.listDisabledPackages(serial),
      adb.getDozeWhitelist(serial),
      adb.getAccounts(serial),
    ]);

  // Everything below plans from this list. If it is not trustworthy, nothing
  // downstream is either, so stop before the audit produces a confident answer
  // about a device that was never read.
  assertInventorySane(installed);

  const management = await adb.getManagement(serial);
  // Samsung's Knox Mobile Enrollment agent re-applies enrolment on first boot
  // after a factory reset, so its presence changes the advice from "reset it"
  // to "you must be released from the enrolment console first".
  management.knoxEnrollment = installed.has('com.sec.enterprise.knox.cloudmdm.smdms');
  management.managed = Boolean(management.deviceOwner || management.profileOwner);

  const { set: protectedSet, ime, launcher } = await resolveProtected(serial, installed);

  const device = {
    serial,
    manufacturer,
    model: props['ro.product.model'] || '',
    device: props['ro.product.device'] || '',
    androidRelease: props['ro.build.version.release'] || '',
    sdk: props['ro.build.version.sdk'] || '',
    buildId: props['ro.build.display.id'] || props['ro.build.id'] || '',
    securityPatch: props['ro.build.version.security_patch'] || '',
    battery,
    memory,
    storage,
    uptime,
    mediaVolume,
    brightness,
    accounts,
    management,
    ime,
    launcher,
    packageCount: installed.size,
    disabledCount: disabled.size,
  };

  // --- settings drift ---
  const wanted = profiles.loadSettings();
  const settings = [];
  for (const entry of wanted) {
    const current = await adb.getSetting(serial, entry.scope, entry.key);
    settings.push({
      scope: entry.scope,
      key: entry.key,
      desired: entry.value,
      current,
      ok: valuesEqual(current, entry.value),
    });
  }

  // --- bloat ---
  const lists = profiles.loadBloat(manufacturer);
  const candidates = aggressive ? [...lists.safe, ...lists.aggressive] : lists.safe;
  const aggressiveHeld = aggressive
    ? []
    : lists.aggressive.filter((p) => installed.has(p) && !disabled.has(p));

  const bloat = [];
  for (const pkg of candidates) {
    if (!installed.has(pkg)) continue; // not on this device, nothing to do
    const isProtected = protectedSet.has(pkg);
    bloat.push({
      pkg,
      disabled: disabled.has(pkg),
      protected: isProtected,
      protectedReason: isProtected ? protectionReason(pkg, ime, launcher) : null,
      tier: lists.aggressive.includes(pkg) ? 'aggressive' : 'safe',
    });
  }
  bloat.sort((a, b) => a.pkg.localeCompare(b.pkg));

  // --- the order app itself ---
  const app = [];
  for (const pkg of pandaPackages(installed)) {
    const info = await adb.getPackageInfo(serial, pkg);
    const bucket = await adb.getStandbyBucket(serial, pkg);
    const ops = {};
    for (const op of APP_OPS) {
      ops[op] = await adb.getAppOp(serial, pkg, op);
    }
    app.push({
      pkg,
      versionName: info.versionName,
      versionCode: info.versionCode,
      enabled: info.enabled,
      dozeExempt: doze.has(pkg),
      standbyBucket: bucket,
      bucketOk: bucketIsGoodEnough(bucket),
      ops,
      opsOk: APP_OPS.every((op) => ops[op] === 'allow' || ops[op] === null),
    });
  }

  const settingsDrift = settings.filter((s) => !s.ok).length;
  const toDisable = bloat.filter((b) => !b.disabled && !b.protected).length;
  const appIssues = app.filter((a) => !a.dozeExempt || !a.bucketOk || !a.opsOk).length;

  const volumeTarget = mediaVolume.max;
  const volumeOk =
    mediaVolume.current == null || volumeTarget == null || mediaVolume.current >= volumeTarget;

  const brightnessTarget = brightnessFloorFor(brightness);
  const brightnessOk =
    brightness.current == null || brightnessTarget == null || brightness.current >= brightnessTarget;

  return {
    device,
    settings,
    bloat,
    app,
    aggressiveHeld,
    profileSources: lists.sources,
    blocked: bloat.filter((b) => b.protected).map((b) => b.pkg),
    volumeOk,
    brightnessOk,
    summary: {
      settingsDrift,
      settingsTotal: settings.length,
      toDisable,
      bloatPresent: bloat.length,
      appIssues,
      appPackages: app.length,
      clean: settingsDrift === 0 && toDisable === 0 && appIssues === 0 && volumeOk && brightnessOk,
    },
  };
}

function protectionReason(pkg, ime, launcher) {
  if (pkg === ime) return 'current keyboard';
  if (pkg === launcher) return 'current launcher';
  if (pkg.startsWith(PANDA_PREFIX)) return 'Panda Eats app';
  return 'guard list';
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Turn an audit into the concrete list of actions to take.
 *
 * This is the ONLY place that decides what Apply will do. The Provision tab's
 * preview and apply() below both call it, so the plan you are shown and the
 * plan that executes cannot drift apart.
 *
 * @param {object} report an audit() result
 * @param {object} opts {skipSettings, skipBloat, skipAppTuning}
 */
function buildPlan(report, opts = {}) {
  const settings = opts.skipSettings ? [] : report.settings.filter((s) => !s.ok);
  const packages = opts.skipBloat
    ? []
    : report.bloat.filter((b) => !b.disabled && !b.protected).map((b) => b.pkg);
  const apps = opts.skipAppTuning ? [] : report.app.filter((a) => !a.dozeExempt || !a.bucketOk || !a.opsOk);

  return {
    settings,
    packages,
    apps,
    blocked: report.blocked,
    total: settings.length + packages.length + apps.length,
  };
}

/**
 * Audit plus plan, in one round trip. This is what the Provision tab shows
 * before you commit to anything.
 */
async function preview(serial, opts = {}) {
  const report = await audit(serial, opts);
  return { report, plan: buildPlan(report, opts) };
}

/**
 * The three things that keep the order listener alive on a counter tablet.
 * Shared by Apply and by Install, so a freshly installed app is tuned the same
 * way whether it arrived by sideload or by Play.
 */
async function tuneAppBackground(serial, pkg) {
  const steps = [];
  steps.push(['doze whitelist', await adb.addToDozeWhitelist(serial, pkg)]);
  steps.push(['standby bucket', await adb.setStandbyBucket(serial, pkg, 'active')]);
  for (const op of APP_OPS) {
    steps.push([op, await adb.setAppOp(serial, pkg, op, 'allow')]);
  }
  const failed = steps.filter(([, r]) => !r.ok).map(([name]) => name);
  return {
    pkg,
    ok: failed.length === 0,
    failed,
    // These are am/cmd calls into system_server too, so they can be the step
    // that catches the device going down. Reported rather than acted on here:
    // this helper is shared with Install, and only Apply has a run to abort.
    deviceDown: steps.some(([, r]) => adb.deviceWentDown(r)),
  };
}

function backupPath(serial) {
  ensureStateDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeSerial = String(serial).replace(/[^\w.-]/g, '_');
  return path.join(stateDir, `${safeSerial}-${stamp}.json`);
}

/**
 * Apply the profile. `onProgress({level, message})` is called per step so the
 * UI can stream a log rather than freeze on a spinner.
 *
 * @param {object} opts {aggressive, skipBloat, skipSettings, skipAppTuning}
 */
async function apply(serial, opts = {}, onProgress = () => {}) {
  const log = (level, message) => onProgress({ level, message });

  // Re-read the device rather than trusting whatever the UI last showed. The
  // preview may be minutes old, or may even belong to a different tablet that
  // has since been unplugged, so the plan that executes is always built from a
  // read taken right now.
  log('info', 'Reading current device state...');
  const report = await audit(serial, opts);
  const plan = buildPlan(report, opts);

  const plannedSettings = plan.settings;
  const plannedBloat = plan.packages;
  const plannedApps = plan.apps;

  log('info', `Plan: ${plannedSettings.length} setting(s), ${plannedBloat.length} package(s), ${plannedApps.length} app fix(es).`);

  // Rollback file is written BEFORE anything is touched. A crash mid-apply must
  // still leave a usable Revert.
  const backup = {
    tool: 'panda-bench',
    version: 1,
    serial,
    model: report.device.model,
    manufacturer: report.device.manufacturer,
    timestamp: new Date().toISOString(),
    aggressive: !!opts.aggressive,
    settings: plannedSettings.map((s) => ({
      scope: s.scope,
      key: s.key,
      previous: s.current,
      applied: s.desired,
    })),
    packages: plannedBloat.map((pkg) => ({ pkg, wasDisabled: false })),
    appTuning: plannedApps.map((a) => ({
      pkg: a.pkg,
      previousBucket: a.standbyBucket,
      previousDoze: a.dozeExempt,
      previousOps: a.ops,
    })),
    mediaVolume: report.device.mediaVolume,
    brightness: report.device.brightness,
    results: null,
  };

  const file = backupPath(serial);
  fs.writeFileSync(file, JSON.stringify(backup, null, 2), 'utf8');
  log('info', `Rollback point saved: ${path.basename(file)}`);

  const results = { settings: [], packages: [], appTuning: [], misc: [], abortedAt: null };
  const disabledOk = [];

  // Narrow the rollback record to what actually changed. It was written up
  // front with the full plan so a crash mid-run still reverts (re-enabling an
  // already-enabled package is harmless), but the finished record should not
  // claim credit for packages the platform refused to disable. Called on the
  // normal path and on an abort, so a run that dies halfway still leaves an
  // accurate record rather than the untouched up-front one.
  const persist = () => {
    backup.packages = disabledOk.map((pkg) => ({ pkg, wasDisabled: false }));
    backup.results = results;
    fs.writeFileSync(file, JSON.stringify(backup, null, 2), 'utf8');
  };

  /**
   * Stop the run when the tablet stops being able to answer.
   *
   * Continuing past this point achieves nothing: every remaining command fails
   * identically, the log fills with noise that buries the one line that
   * mattered, and the run still ends by announcing success. Worse, the device
   * is rebooting, so the commands that "failed" may land in any order once it
   * comes back.
   */
  const bail = (what) => {
    results.abortedAt = what;
    persist();
    log('error', `The tablet stopped responding while ${what}.`);
    log('error', 'Android restarted on the device - that is a crash on the tablet, not an adb problem.');
    log(
      'warn',
      `Stopped here rather than sending the rest of the plan to a restarting tablet. Rollback point ${path.basename(file)} covers everything applied up to this point.`
    );
    throw new Error(
      `The tablet restarted while ${what}. Nothing after that step was applied - wait for it to boot, then Revert or re-run.`
    );
  };

  const bailIfDown = (r, what) => {
    if (adb.deviceWentDown(r)) bail(what);
  };

  // --- settings ---
  // Every write is read back. `settings put` exits 0 even when the platform
  // silently refuses the write (Android 12+ does this for keys it has taken
  // over), so trusting the exit code alone reports success for changes that
  // never landed and leaves the audit permanently dirty.
  for (const s of plannedSettings) {
    const r = await adb.putSetting(serial, s.scope, s.key, s.desired);
    bailIfDown(r, `writing ${s.scope}/${s.key}`);
    const readBack = await adb.getSetting(serial, s.scope, s.key);
    const stuck = valuesEqual(readBack, s.desired);
    const label = `${s.scope}/${s.key}: ${s.current == null ? 'unset' : s.current} -> ${s.desired}`;

    results.settings.push({
      key: `${s.scope}/${s.key}`,
      ok: r.ok && stuck,
      readBack,
      error: r.ok ? (stuck ? null : 'write ignored by platform') : r.stderr,
    });

    if (!r.ok) log('error', `${label} - adb refused: ${r.stderr || 'unknown error'}`);
    else if (!stuck) {
      log('warn', `${label} - did not stick, still ${readBack == null ? 'unset' : readBack}. The platform is ignoring this key; consider removing it from the profile.`);
    } else log('ok', label);
  }
  if (plannedSettings.length === 0 && !opts.skipSettings) log('ok', 'Settings already match the profile.');

  // --- bloat ---
  for (const pkg of plannedBloat) {
    const r = await adb.disablePackage(serial, pkg);
    const output = `${r.stdout}\n${r.stderr}`;

    // A package whose disable took system_server down with it has almost
    // certainly been written to disk already - pm commits the new state and the
    // crash follows. It comes back looking like a plain failure, so the ordinary
    // path below would drop it from the rollback record: precisely the one
    // package Revert has to undo, and the only one that will crash the tablet
    // again on the next run. Claim it before bailing. Re-enabling a package
    // that was never actually disabled costs nothing.
    if (adb.deviceWentDown(r)) {
      disabledOk.push(pkg);
      results.packages.push({ pkg, ok: false, oemProtected: false, uncertain: true, error: r.stderr || r.stdout });
      log('error', `Disabling ${pkg} took the tablet down with it. Recorded for rollback anyway.`);
      bail(`disabling ${pkg}`);
    }

    // pm prints "Package ... new state: disabled-user" on success; a non-zero
    // exit or a "not installed" message means it did not take.
    const ok = r.ok && !/not installed|Unknown package|Failure/i.test(output);

    // OEMs mark some packages undisableable. This is permanent, not transient,
    // so say so plainly - the fix is to delete the line from the profile, not
    // to run Apply again.
    const oemProtected = /Cannot disable a protected package|SecurityException/i.test(output);

    results.packages.push({ pkg, ok, oemProtected, error: ok ? null : (r.stderr || r.stdout) });
    if (ok) {
      disabledOk.push(pkg);
      log('ok', `Disabled ${pkg}`);
    } else if (oemProtected) {
      log('warn', `${pkg} is protected by the manufacturer and can never be disabled over adb. Remove it from the profile.`);
    } else {
      log('warn', `Could not disable ${pkg}`);
    }
  }
  if (plannedBloat.length === 0 && !opts.skipBloat) log('ok', 'No bloat left to disable.');
  for (const pkg of report.blocked) log('warn', `Skipped ${pkg} - protected (${protectionReason(pkg, report.device.ime, report.device.launcher)})`);

  // --- order app background survival ---
  for (const a of plannedApps) {
    const outcome = await tuneAppBackground(serial, a.pkg);
    results.appTuning.push(outcome);
    if (outcome.deviceDown) bail(`tuning ${a.pkg}`);
    if (outcome.ok) log('ok', `${a.pkg}: exempt from doze, standby bucket active, background ops allowed`);
    else log('warn', `${a.pkg}: could not set ${outcome.failed.join(', ')}`);
  }
  if (plannedApps.length === 0 && !opts.skipAppTuning) {
    log(
      report.app.length === 0 ? 'warn' : 'ok',
      report.app.length === 0
        ? 'The order app is not installed on this tablet - skipped background tuning.'
        : 'Order app already exempt from doze, bucketed active, and allowed in background.'
    );
  }

  // --- media volume: orders have to be audible ---
  const vol = report.device.mediaVolume;
  if (vol && vol.max != null) {
    const r = await adb.setMediaVolume(serial, vol.max);
    results.misc.push({ step: 'media volume', ok: r.ok });
    log(r.ok ? 'ok' : 'warn', `Media volume set to max (${vol.max})`);
  }

  // --- screen brightness: it has to be readable from across the counter ---
  // A floor, not a pin: a tablet the restaurant turned up past it is left
  // alone. The write is read back because adaptive brightness can drive the
  // panel straight back down, which is why screen_brightness_mode is in the
  // settings profile applied above rather than left to chance here.
  const bright = report.device.brightness;
  const floor = brightnessFloorFor(bright);
  if (floor != null && bright.current != null && bright.current >= floor) {
    log('ok', `Screen brightness already at ${Math.round((bright.current / bright.max) * 100)}% (${bright.current} of ${bright.max})`);
  } else if (floor != null) {
    const r = await adb.setBrightness(serial, floor);
    bailIfDown(r, 'setting screen brightness');
    const readBack = await adb.getSetting(serial, 'system', 'screen_brightness');
    const stuck = valuesEqual(readBack, floor);
    results.misc.push({ step: 'screen brightness', ok: r.ok && stuck });
    if (!r.ok) log('error', `Screen brightness - adb refused: ${r.stderr || 'unknown error'}`);
    else if (!stuck) {
      log('warn', `Screen brightness did not stick, still ${readBack == null ? 'unset' : readBack} of ${bright.max}. Something on the tablet is driving the panel.`);
    } else log('ok', `Screen brightness set to ${floor} of ${bright.max} (${Math.round(BRIGHTNESS_FLOOR * 100)}%)`);
  }

  // --- free up cache ---
  const trim = await adb.trimCaches(serial);
  results.misc.push({ step: 'trim caches', ok: trim.ok });
  log(trim.ok ? 'ok' : 'warn', 'Trimmed app caches');

  persist();

  log('done', 'Provisioning complete. Reboot the tablet to settle the changes.');
  return { backupFile: file, results, planned: { settings: plannedSettings.length, packages: plannedBloat.length, apps: plannedApps.length } };
}

// ---------------------------------------------------------------------------
// Revert
// ---------------------------------------------------------------------------

/** Rollback points for a serial, newest first. */
function listBackups(serial) {
  ensureStateDir();
  const safeSerial = String(serial || '').replace(/[^\w.-]/g, '_');
  return fs
    .readdirSync(stateDir)
    .filter((f) => f.endsWith('.json'))
    .filter((f) => (serial ? f.startsWith(`${safeSerial}-`) : true))
    .map((f) => {
      const full = path.join(stateDir, f);
      let meta = {};
      try {
        meta = JSON.parse(fs.readFileSync(full, 'utf8'));
      } catch {
        meta = {};
      }
      return {
        file: full,
        name: f,
        timestamp: meta.timestamp || null,
        model: meta.model || '',
        serial: meta.serial || '',
        settings: (meta.settings || []).length,
        packages: (meta.packages || []).length,
        aggressive: !!meta.aggressive,
      };
    })
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
}

/** Put a device back exactly how a given rollback point found it. */
async function revert(serial, file, onProgress = () => {}) {
  const log = (level, message) => onProgress({ level, message });
  if (!fs.existsSync(file)) throw new Error(`Rollback file not found: ${file}`);
  const backup = JSON.parse(fs.readFileSync(file, 'utf8'));

  if (backup.serial && backup.serial !== serial) {
    log('warn', `This rollback point was taken from ${backup.serial}, not ${serial}.`);
  }

  log('info', `Reverting from ${path.basename(file)}...`);

  for (const s of backup.settings || []) {
    if (s.previous == null) {
      const r = await adb.deleteSetting(serial, s.scope, s.key);
      log(r.ok ? 'ok' : 'warn', `${s.scope}/${s.key} -> unset`);
    } else {
      const r = await adb.putSetting(serial, s.scope, s.key, s.previous);
      log(r.ok ? 'ok' : 'warn', `${s.scope}/${s.key} -> ${s.previous}`);
    }
  }

  for (const p of backup.packages || []) {
    const r = await adb.enablePackage(serial, p.pkg);
    log(r.ok ? 'ok' : 'warn', `Re-enabled ${p.pkg}`);
  }

  for (const a of backup.appTuning || []) {
    if (a.previousDoze === false) await adb.removeFromDozeWhitelist(serial, a.pkg);
    if (a.previousBucket != null) await adb.setStandbyBucket(serial, a.pkg, String(a.previousBucket));
    for (const [op, mode] of Object.entries(a.previousOps || {})) {
      if (mode) await adb.setAppOp(serial, a.pkg, op, mode);
    }
    log('ok', `Restored background settings for ${a.pkg}`);
  }

  if (backup.mediaVolume && backup.mediaVolume.current != null) {
    await adb.setMediaVolume(serial, backup.mediaVolume.current);
    log('ok', `Media volume restored to ${backup.mediaVolume.current}`);
  }

  if (backup.brightness && backup.brightness.current != null) {
    await adb.setBrightness(serial, backup.brightness.current);
    log('ok', `Screen brightness restored to ${backup.brightness.current}`);
  }

  log('done', 'Revert complete. Reboot the tablet.');
  return { file };
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/**
 * What is on the tablet right now, and what the chosen APK would do to it.
 * Read-only - this is what the Install tab shows before you commit.
 */
async function inspectInstall(serial, apkPath) {
  const installed = await adb.listPackages(serial);
  const present = [];
  for (const pkg of pandaPackages(installed)) {
    const info = await adb.getPackageInfo(serial, pkg);
    present.push({ pkg, versionName: info.versionName, versionCode: info.versionCode, enabled: info.enabled });
  }

  if (!apkPath) return { present, candidate: null, warning: null };

  const candidate = await apk.readApkInfo(apkPath);
  if (!candidate.ok) return { present, candidate, warning: null };

  const existing = present.find((p) => p.pkg === candidate.applicationId);
  let warning = null;

  if (candidate.replacesPlayBuild && existing) {
    // The order-app repo's own standing rule. Worth being loud about.
    warning =
      `${candidate.applicationId} is already installed (v${existing.versionName || '?'}). ` +
      'The production applicationId carries no suffix, so this REPLACES that build rather than ' +
      'installing beside it. If the tablet is paired to a restaurant and the signing keys differ, ' +
      'the install will fail; if they match, the app is replaced. Use a staging or dev build to ' +
      'test without touching a paired app.';
  } else if (candidate.replacesPlayBuild && !existing) {
    warning = null; // fresh tablet, prod is exactly right
  } else if (existing && candidate.versionCode && existing.versionCode) {
    if (Number(candidate.versionCode) < Number(existing.versionCode)) {
      warning = `The tablet has a newer build (${existing.versionCode}) than this APK (${candidate.versionCode}). Android refuses downgrades unless you allow it explicitly.`;
    }
  }

  return { present, candidate, existing: existing || null, warning };
}

/**
 * Install an APK and immediately apply the background tuning, because an
 * untuned order app is one Android decides to put to sleep.
 */
async function installApp(serial, apkPath, opts = {}, onProgress = () => {}) {
  const log = (level, message) => onProgress({ level, message });

  const info = await apk.readApkInfo(apkPath);
  if (!info.ok) {
    log('error', info.error || 'Could not read the APK.');
    return { ok: false, error: info.error };
  }

  log('info', `${info.label || info.applicationId} v${info.versionName} (${info.versionCode}), ${(info.sizeBytes / 1024 / 1024).toFixed(1)} MB`);
  log('info', `applicationId ${info.applicationId} - ${info.note}`);
  log('info', 'Installing. A large APK over USB takes a minute or two.');

  const result = await adb.installApk(serial, apkPath, {
    grantPermissions: opts.grantPermissions !== false,
    allowDowngrade: Boolean(opts.allowDowngrade),
  });

  if (!result.ok) {
    log('error', result.reason || 'Install failed.');
    if (result.output) log('info', result.output.split('\n').slice(-3).join(' ').trim());
    return { ok: false, error: result.reason || result.output };
  }
  log('ok', `Installed ${info.applicationId}`);

  // Confirm from the device rather than trusting pm's "Success".
  const after = await adb.getPackageInfo(serial, info.applicationId);
  if (after.installed) {
    log('ok', `Tablet reports v${after.versionName || '?'} (${after.versionCode || '?'})`);
  } else {
    log('warn', 'pm reported success but the package is not visible on the tablet.');
  }

  let tuning = null;
  if (opts.tune !== false) {
    tuning = await tuneAppBackground(serial, info.applicationId);
    if (tuning.ok) log('ok', `${info.applicationId}: exempt from doze, standby bucket active, background ops allowed`);
    else log('warn', `${info.applicationId}: could not set ${tuning.failed.join(', ')}`);
  }

  if (opts.launch) {
    const launched = await adb.launchApp(serial, info.applicationId);
    log(launched.ok ? 'ok' : 'warn', launched.ok ? 'Launched on the tablet - pair it from the merchant dashboard.' : 'Could not launch the app.');
  }

  log('done', 'Install complete.');
  return { ok: true, applicationId: info.applicationId, versionName: info.versionName, versionCode: info.versionCode, tuning };
}

// ---------------------------------------------------------------------------
// Wallpaper
// ---------------------------------------------------------------------------

const WALLPAPER_DEVICE_DIR = '/sdcard/Download';

/**
 * Get a wallpaper onto the tablet and open the "Set as" chooser with it
 * already loaded.
 *
 * This is deliberately NOT part of Apply. Android gives adb no way to set the
 * wallpaper image outright (see the note in adb.js), so this always ends with
 * the operator tapping "Set as wallpaper" on the tablet. Burying a step that
 * needs a human inside a batch that otherwise runs unattended would make Apply
 * a liar about having finished.
 */
async function setWallpaper(serial, localPath, onProgress = () => {}) {
  const log = (level, message) => onProgress({ level, message });

  if (!fs.existsSync(localPath)) {
    log('error', `No such file: ${localPath}`);
    return { ok: false, error: 'File not found' };
  }

  // Refuse rather than theatre. If an MDM has set DISALLOW_SET_WALLPAPER the
  // chooser still opens and the tap still appears to work, but the system
  // silently discards it - so reporting success here would be a lie.
  const management = await adb.getManagement(serial);
  if (management.wallpaperBlocked) {
    const owner = await adb.getWallpaperOwner(serial);
    log(
      'error',
      `Wallpaper changes are blocked on this tablet. ${
        management.deviceOwner || 'An MDM'
      } has set the DISALLOW_SET_WALLPAPER restriction${owner ? `, and ${owner} set the current wallpaper` : ''}.`
    );
    log(
      'info',
      'The chooser would still open and the tap would appear to work, but Android discards it. Only the device owner can lift this - remove the MDM first.'
    );
    return { ok: false, error: 'blocked by device policy', blockedBy: management.deviceOwner || null };
  }

  const basename = `panda-wallpaper${path.extname(localPath) || '.png'}`;
  const devicePath = `${WALLPAPER_DEVICE_DIR}/${basename}`;
  const mime = path.extname(localPath).toLowerCase() === '.jpg' ? 'image/jpeg' : 'image/png';

  log('info', `Pushing ${path.basename(localPath)} to the tablet...`);
  const pushed = await adb.pushFile(serial, localPath, devicePath);
  if (!pushed.ok) {
    log('error', `Push failed: ${pushed.stderr || pushed.stdout}`);
    return { ok: false, error: 'push failed' };
  }
  log('ok', `Copied to ${devicePath}`);

  // Without this the file has no content:// identity and the chooser silently
  // refuses to open it.
  await adb.indexInMediaStore(serial, devicePath);
  const mediaId = await adb.findMediaId(serial, devicePath);
  if (!mediaId) {
    log('warn', 'The tablet did not index the image. It is on the tablet in Downloads - set it from the Gallery by hand.');
    return { ok: false, error: 'not indexed', devicePath };
  }

  const uri = `content://media/external/images/media/${mediaId}`;
  const opened = await adb.openSetAsWallpaper(serial, uri, mime);
  if (!opened.ok) {
    log('warn', `Could not open the chooser. The image is at ${devicePath} - set it from the Gallery by hand.`);
    return { ok: false, error: 'chooser failed', devicePath };
  }

  log('done', 'The tablet is showing the "Set as" chooser with this image. Tap Set as wallpaper, then choose Home screen.');
  return { ok: true, devicePath, uri };
}

// ---------------------------------------------------------------------------
// System update
// ---------------------------------------------------------------------------

/** How stale the tablet's security patch is. Purely informational. */
function patchAge(securityPatch) {
  if (!securityPatch) return null;
  const then = new Date(`${securityPatch}T00:00:00Z`);
  if (Number.isNaN(then.getTime())) return null;
  const months = Math.floor((Date.now() - then.getTime()) / (1000 * 60 * 60 * 24 * 30.44));
  return { date: securityPatch, months, stale: months >= 6 };
}

/**
 * Open the OS update screen. Applying a firmware update over adb is not
 * possible - it is signed and vendor-driven - so this is a shortcut to the
 * right screen, not an automated update.
 */
async function openSystemUpdate(serial, onProgress = () => {}) {
  const log = (level, message) => onProgress({ level, message });
  const props = await adb.getProps(serial);
  const age = patchAge(props['ro.build.version.security_patch']);

  if (age) {
    log(
      age.stale ? 'warn' : 'info',
      `Security patch ${age.date}, about ${age.months} month(s) old.${age.stale ? ' That is behind - worth updating before this tablet ships.' : ''}`
    );
  }
  log('info', `Build ${props['ro.build.display.id'] || 'unknown'}`);

  const r = await adb.openSystemUpdate(serial);
  if (r.ok) {
    log('done', `Opened ${r.via} on the tablet. Tap Download and install there. Panda Bench cannot apply a firmware update for you - it is signed and vendor-driven.`);
  } else {
    log('error', 'Could not open the update screen on the tablet.');
  }
  return { ...r, patch: age };
}

/** Open the Play listing on the tablet. Play is the production install path. */
async function openPlay(serial, pkg, onProgress = () => {}) {
  const log = (level, message) => onProgress({ level, message });
  const target = pkg || apk.PROD_ID;
  const r = await adb.openPlayListing(serial, target);
  if (r.ok) {
    log('ok', `Opened the Play listing for ${target} on the tablet (via the ${r.via}). Tap Install there, then come back and run Provision.`);
  } else {
    log('error', `Could not open the Play listing on the tablet. ${r.output || ''}`.trim());
  }
  return r;
}

// ---------------------------------------------------------------------------
// Discover
// ---------------------------------------------------------------------------

/**
 * System packages on this device that no profile mentions. This is how the
 * bloat lists get better: run it against a real tablet, read the names, paste
 * the junk into the OEM profile.
 */
async function discover(serial) {
  const props = await adb.getProps(serial);
  const manufacturer = props['ro.product.manufacturer'] || '';

  const [system, disabled, thirdParty, installed] = await Promise.all([
    adb.listSystemPackages(serial),
    adb.listDisabledPackages(serial),
    adb.listThirdPartyPackages(serial),
    adb.listPackages(serial),
  ]);

  const { set: protectedSet } = await resolveProtected(serial, installed);
  const lists = profiles.loadBloat(manufacturer);
  const known = new Set([...lists.safe, ...lists.aggressive]);

  const unknown = [...system]
    .filter((pkg) => !known.has(pkg))
    .filter((pkg) => !protectedSet.has(pkg))
    .map((pkg) => ({ pkg, disabled: disabled.has(pkg) }))
    .sort((a, b) => a.pkg.localeCompare(b.pkg));

  const sideloaded = [...thirdParty]
    .filter((pkg) => !pkg.startsWith(PANDA_PREFIX))
    .map((pkg) => ({ pkg, disabled: disabled.has(pkg) }))
    .sort((a, b) => a.pkg.localeCompare(b.pkg));

  return {
    manufacturer,
    profileSources: lists.sources,
    unknown,
    sideloaded,
    counts: {
      system: system.size,
      known: known.size,
      unknown: unknown.length,
      sideloaded: sideloaded.length,
    },
  };
}

/**
 * Disable an operator-picked set of packages on one tablet.
 *
 * This is the Discover tab's escape hatch for things no profile covers -
 * carrier junk, a competitor's app, whatever a previous owner installed. It is
 * deliberately per-device and never writes to a profile: these are one-tablet
 * decisions, not fleet policy.
 *
 * It runs the SAME guard list as Apply and writes the SAME rollback format, so
 * a bad pick is undone from the Rollback tab like anything else.
 */
async function disableSelected(serial, packages, onProgress = () => {}) {
  const log = (level, message) => onProgress({ level, message });

  const installed = await adb.listPackages(serial);
  assertInventorySane(installed);
  const disabled = await adb.listDisabledPackages(serial);
  const { set: protectedSet, ime, launcher } = await resolveProtected(serial, installed);

  const targets = [];
  for (const pkg of packages) {
    if (!installed.has(pkg)) {
      log('warn', `${pkg} is not installed - skipped.`);
    } else if (disabled.has(pkg)) {
      log('ok', `${pkg} is already disabled.`);
    } else if (protectedSet.has(pkg)) {
      log('warn', `${pkg} is protected (${protectionReason(pkg, ime, launcher)}) - refused.`);
    } else {
      targets.push(pkg);
    }
  }

  if (targets.length === 0) {
    log('done', 'Nothing to disable.');
    return { ok: true, disabled: [], backupFile: null };
  }

  const backup = {
    tool: 'panda-bench',
    version: 1,
    serial,
    timestamp: new Date().toISOString(),
    source: 'discover',
    settings: [],
    packages: targets.map((pkg) => ({ pkg, wasDisabled: false })),
    appTuning: [],
    mediaVolume: null,
    brightness: null,
    results: null,
  };
  const file = backupPath(serial);
  fs.writeFileSync(file, JSON.stringify(backup, null, 2), 'utf8');
  log('info', `Rollback point saved: ${path.basename(file)}`);

  const done = [];
  const save = () => {
    backup.packages = done.map((pkg) => ({ pkg, wasDisabled: false }));
    backup.results = { packages: done };
    fs.writeFileSync(file, JSON.stringify(backup, null, 2), 'utf8');
  };

  for (const pkg of targets) {
    const r = await adb.disablePackage(serial, pkg);
    const output = `${r.stdout}\n${r.stderr}`;

    // Hand-picked packages are the ones no profile has ever been tested with,
    // so this path is the likeliest place to meet a new device-killer. Same
    // rule as Apply: claim the package for rollback, then stop rather than
    // feeding the rest of the selection to a rebooting tablet.
    if (adb.deviceWentDown(r)) {
      done.push(pkg);
      save();
      log('error', `Disabling ${pkg} took the tablet down with it. Recorded for rollback anyway.`);
      log('error', 'Android restarted on the device - that is a crash on the tablet, not an adb problem.');
      log('warn', `Stopped here. Rollback point ${path.basename(file)} covers ${done.length} package(s), including this one.`);
      throw new Error(
        `The tablet restarted while disabling ${pkg}. Nothing after it was touched - wait for it to boot, then Revert.`
      );
    }

    const ok = r.ok && !/not installed|Unknown package|Failure/i.test(output);
    if (ok) {
      done.push(pkg);
      log('ok', `Disabled ${pkg}`);
    } else if (/Cannot disable a protected package|SecurityException/i.test(output)) {
      log('warn', `${pkg} is protected by the manufacturer or an MDM and can never be disabled over adb.`);
    } else {
      log('warn', `Could not disable ${pkg}`);
    }
  }

  save();

  log('done', `Disabled ${done.length} of ${targets.length}. Reboot the tablet to settle it.`);
  return { ok: true, disabled: done, backupFile: file };
}

module.exports = {
  audit,
  disableSelected,
  preview,
  buildPlan,
  apply,
  revert,
  discover,
  listBackups,
  setStateDir,
  valuesEqual,
  tuneAppBackground,
  inspectInstall,
  installApp,
  openPlay,
  setWallpaper,
  openSystemUpdate,
  patchAge,
};
