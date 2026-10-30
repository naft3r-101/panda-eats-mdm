'use strict';

const fs = require('node:fs');
const path = require('node:path');
const adb = require('./adb');
const PKG = 'com.pandaeats.bench.wallpaper';
const URI = `content://${PKG}`;

function helperApk() {
  const packaged = process.resourcesPath && path.join(process.resourcesPath, 'wallpaper-helper.apk');
  return packaged && fs.existsSync(packaged) ? packaged : path.join(__dirname, '../build/wallpaper-helper.apk');
}

// Read the current user's two records, never the fallback or another user's record.
function parseWallpaperDump(text) {
  const result = { homeId: null, lockId: null, readable: false };
  let section = null;
  for (const line of adb.normalise(text).split('\n')) {
    if (/^System wallpaper state:/.test(line)) { section = 'homeId'; result.readable = true; }
    else if (/^Lock wallpaper state:/.test(line)) section = 'lockId';
    else if (/^\S.*wallpaper state:/.test(line)) section = null;
    const id = line.match(/^\s*User 0:.*\bid=(\d+)/);
    if (section && id) result[section] = Number(id[1]);
  }
  result.readable = result.readable && result.homeId != null;
  return result;
}

async function readState(serial) {
  const r = await adb.shell('dumpsys wallpaper', { serial });
  if (!r.ok) throw new Error('Could not read the tablet wallpaper state');
  const state = parseWallpaperDump(r.stdout);
  if (!state.readable) throw new Error('Could not identify both wallpaper records');
  return state;
}

function confirms(before, after, result, restoring = false) {
  if (!result.ok || !after.readable || !(result.homeId > 0)) return false;
  const lock = result.lockId > 0 ? result.lockId : null;
  return after.homeId === result.homeId && after.lockId === lock &&
    (restoring || (result.lockId > 0 && before.homeId !== after.homeId && before.lockId !== after.lockId));
}

async function command(serial, method) {
  const r = await adb.shell(`content call --user 0 --uri ${URI} --method ${method}`, { serial, timeout: 60000 });
  const match = r.stdout.match(/result=(\{.*\})\}/s);
  if (!r.ok || !match) throw new Error(`Wallpaper helper did not answer: ${r.stderr || r.stdout}`);
  const result = JSON.parse(match[1]);
  if (!result.ok) throw new Error(result.error || 'Wallpaper helper refused the request');
  return result;
}

async function upload(serial, name, bytes) {
  const r = await adb.runBinary(serial, ['exec-in', 'content', 'write', '--user', '0', '--uri', `${URI}/${name}`], bytes);
  if (!r.ok || /Error|Exception/.test(String(r.stdout) + r.stderr)) throw new Error(`Could not send ${name} to the wallpaper helper`);
  // content write can exit 0 on an error. Compare the exact bytes through an independent read.
  // exec-in can finish before the remote provider has opened or flushed its file.
  for (let attempt = 0; attempt < 40; attempt++) {
    const saved = await download(serial, name).catch(() => null);
    if (saved && saved.equals(bytes)) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`The tablet did not receive all of ${name}`);
}

async function download(serial, name) {
  const r = await adb.runBinary(serial, ['exec-out', 'content', 'read', '--user', '0', '--uri', `${URI}/${name}`]);
  if (!r.ok || !r.stdout.length || /^Error|^Exception/.test(String(r.stdout.subarray(0, 120))))
    throw new Error(`Could not save ${name} from the tablet`);
  return r.stdout;
}

async function withHelper(serial, work, log = () => {}) {
  let installed = false;
  let storageMode = null;
  let result;
  try {
    const install = await adb.installApk(serial, helperApk());
    if (!install.ok) throw new Error(install.reason || install.output);
    installed = true;
    const enabled = await adb.enablePackage(serial, PKG);
    if (!enabled.ok || (await adb.listDisabledPackages(serial)).has(PKG)) throw new Error('Wallpaper helper could not be enabled');
    const sdk = Number((await adb.getProps(serial))['ro.build.version.sdk']);
    if (sdk >= 30) {
      storageMode = await adb.getAppOp(serial, PKG, 'MANAGE_EXTERNAL_STORAGE') || 'default';
      const grant = await adb.setAppOp(serial, PKG, 'MANAGE_EXTERNAL_STORAGE', 'allow');
      if (!grant.ok) throw new Error('Could not allow a temporary wallpaper backup');
    }
    result = await work();
  } finally {
    if (installed) {
      await command(serial, 'clean').catch(() => {});
      let storageRestored = true;
      if (storageMode != null) {
        await adb.setAppOp(serial, PKG, 'MANAGE_EXTERNAL_STORAGE', storageMode);
        storageRestored = (await adb.getAppOp(serial, PKG, 'MANAGE_EXTERNAL_STORAGE') || 'default') === storageMode;
      }
      await adb.revokePermission(serial, PKG, 'android.permission.READ_EXTERNAL_STORAGE');
      await adb.disablePackage(serial, PKG);
      if (!(await adb.listDisabledPackages(serial)).has(PKG)) {
        log('warn', 'The wallpaper helper could not be switched off. Retry after reconnecting the tablet.');
        throw new Error('Wallpaper helper cleanup did not finish');
      }
      if (!storageRestored) throw new Error('The helper is disabled, but its temporary storage access was not restored');
    }
  }
  return result;
}

/** onBackup must persist the rollback record before we call set. */
async function apply(serial, localPath, directory, onBackup, log) {
  return withHelper(serial, async () => {
    const before = await readState(serial);
    const snapshot = await command(serial, 'snapshot');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'snapshot.json'), JSON.stringify(snapshot));
    for (const name of ['home', 'lock']) {
      if (snapshot[name]) fs.writeFileSync(path.join(directory, `${name}.png`), await download(serial, `${name}.png`));
    }
    const backup = { directory, before, snapshot };
    await onBackup(backup);
    await upload(serial, 'input.png', fs.readFileSync(localPath));
    const result = await command(serial, 'set');
    // WallpaperManager writes asynchronously; wait for its matching dumpsys records.
    let after;
    for (let attempt = 0; attempt < 20; attempt++) {
      after = await readState(serial);
      if (confirms(before, after, result)) return { ...result, after };
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('The tablet did not confirm the new home and lock wallpapers');
  }, log);
}

async function restore(serial, backup, log) {
  return withHelper(serial, async () => {
    const snapshot = JSON.parse(fs.readFileSync(path.join(backup.directory, 'snapshot.json'), 'utf8'));
    for (const name of ['home', 'lock']) {
      if (snapshot[name]) await upload(serial, `${name}.png`, fs.readFileSync(path.join(backup.directory, `${name}.png`)));
    }
    await upload(serial, 'snapshot.json', Buffer.from(JSON.stringify(snapshot)));
    const result = await command(serial, 'restore');
    for (let attempt = 0; attempt < 20; attempt++) {
      if (confirms(null, await readState(serial), result, true)) return result;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('The tablet did not confirm the restored wallpaper');
  }, log);
}

module.exports = { PKG, parseWallpaperDump, confirms, readState, apply, restore };
