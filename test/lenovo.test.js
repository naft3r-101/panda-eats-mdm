'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const adb = require('../electron/adb');
const profiles = require('../electron/profiles');
const provision = require('../electron/provision');

const requested = [
  'com.motorola.demo', 'com.tblenovo.whatsnewclient', 'com.android.wantjoin.settings',
  'com.android.wantjoin.childmode.ctrl', 'com.lmsa.app.lmsapad', 'com.verizon.remoteSimlock',
  'com.dolby.daxappui', 'com.dti.lenovo.tablet', 'com.king.candycrushsaga', 'com.pandora.android',
  'com.particlenews.newsbreak', 'com.futureplay.boots', 'com.pivotmobile.android.metrics',
  'com.upgenicsint.phonechecklite', 'com.grubhub.android.orderhub', 'com.grubhub.android.orderhub.settings',
  'com.grubhub.android.orderhub.installer', 'com.grubhub.android.orderhub.recovery', 'com.gears42.surelock',
];

test('TB-8505F safe tier includes data-app junk and previous operator apps, protecting the Dolby engine', () => {
  const safe = profiles.loadBloat('Lenovo').safe;
  for (const pkg of requested) assert.ok(safe.includes(pkg), pkg);
  assert.ok(profiles.loadProtected().has('com.dolby.daxservice'));
  assert.ok(!safe.includes('com.dolby.daxservice'));
  assert.match(provision.packageNote('com.grubhub.android.orderhub'), /Grubhub's order app/);
  assert.match(provision.packageNote('com.gears42.surelock'), /SureLock.*another operator/);
});

test('battery controls are OEM-specific; DuraSpeed controls follow package presence on any OEM', () => {
  for (const brand of ['lenovo', 'samsung', 'acme']) {
    const settings = profiles.loadSettings(brand);
    assert.equal(settings.some(s => s.key === 'battery_protected_charge'), brand === 'lenovo');
    assert.equal(settings.some(s => s.key === 'protect_battery'), brand === 'samsung');
    assert.equal(settings.some(s => s.key === 'setting.duraspeed.enabled'), false);
    const dura = profiles.loadSettings(brand, new Set(['com.mediatek.duraspeed'])).filter(s => s.key === 'setting.duraspeed.enabled');
    assert.deepEqual(dura.map(s => [s.scope, s.value]), [['system', '0'], ['global', '0']]);
  }
});

function tablet(t, { ignoredSetting, ignoredPackage, dataPackages = [], ignoredUninstall = false } = {}) {
  const installed = new Set(['android', 'com.dolby.daxservice', 'com.mediatek.duraspeed', ...requested,
    ...Array.from({ length: 45 }, (_, i) => `com.fixture.app${i}`)]);
  const disabled = new Set();
  const values = new Map(profiles.loadSettings('lenovo', installed).map(s => [`${s.scope}/${s.key}`, s.value]));
  values.set('system/battery_protected_charge', '0');
  values.set('system/setting.duraspeed.enabled', '1');
  values.set('global/setting.duraspeed.enabled', null);
  const success = { ok: true, stdout: '', stderr: '' };
  const mock = (name, fn) => t.mock.method(adb, name, fn);
  const fixed = {
    getProps: { 'ro.product.manufacturer': 'lenovo', 'ro.product.model': 'Lenovo TB-8505F', 'ro.build.version.sdk': '29' },
    getBattery: {}, getMemory: {}, getStorage: {}, getUptimeSeconds: 10,
    getMediaVolume: { current: 15, max: 15 }, getBrightness: { current: 255, max: 255 },
    getDozeWhitelist: new Set(), getAccounts: {}, getLockScreen: { disabled: true, credentialType: 'NONE' },
    getManagement: {}, getDefaultImePackage: 'com.fixture.keyboard', getLauncherPackage: 'com.fixture.launcher',
    readDeviceFile: null, ensureDeviceDir: success, pushFile: success, setMediaVolume: success, trimCaches: success,
  };
  for (const [name, value] of Object.entries(fixed)) mock(name, async () => structuredClone(value));
  mock('listPackages', async () => new Set(installed));
  mock('getPackagePaths', async (_, pkg) => [`${dataPackages.includes(pkg) ? '/data/app' : '/system/app'}/${pkg}/base.apk`]);
  const removals = [];
  mock('uninstallProfilePackage', async (_, pkg) => {
    removals.push(pkg);
    if (!ignoredUninstall) installed.delete(pkg);
    return { ...success, stdout: 'Success' };
  });
  mock('listDisabledPackages', async () => new Set(disabled));
  mock('shell', async command => {
    assert.equal(command, 'pm list packages -e --user 0');
    return { ...success, stdout: [...installed].filter(p => !disabled.has(p)).map(p => `package:${p}`).join('\n') };
  });
  mock('getSetting', async (_, scope, key) => values.get(`${scope}/${key}`) ?? null);
  mock('putSetting', async (_, scope, key, value) => { if (key !== ignoredSetting) values.set(`${scope}/${key}`, value); return success; });
  mock('deleteSetting', async (_, scope, key) => { values.delete(`${scope}/${key}`); return success; });
  mock('disablePackage', async (_, pkg) => { if (pkg !== ignoredPackage) disabled.add(pkg); return success; });
  mock('enablePackage', async (_, pkg) => { disabled.delete(pkg); return success; });
  mock('setBrightness', async () => success);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-test-'));
  provision.setStateDir(dir);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { values, disabled, installed, removals };
}

test('audit finds enabled M8 packages, Apply verifies all changes, Revert restores unset keys and packages', async t => {
  const fake = tablet(t);
  const before = await provision.preview('TEST');
  assert.equal(before.report.backgroundSurvival.ok, false);
  assert.equal(before.report.batteryProtection.ok, false);
  for (const pkg of requested) assert.ok(before.plan.packages.includes(pkg));
  assert.ok(!before.plan.packages.includes('com.dolby.daxservice'));
  const run = await provision.apply('TEST');
  assert.equal(run.ok, true);
  const after = await provision.preview('TEST');
  assert.equal(after.report.backgroundSurvival.ok, true);
  assert.equal(after.report.batteryProtection.ok, true);
  assert.equal(after.plan.total, 0);
  await provision.revert('TEST', run.backupFile);
  assert.equal(fake.values.get('system/battery_protected_charge'), '0');
  assert.equal(fake.values.get('system/setting.duraspeed.enabled'), '1');
  assert.equal(fake.values.has('global/setting.duraspeed.enabled'), false);
  assert.equal(fake.disabled.size, 0);
});

test('successful command exits do not hide refused Lenovo, DuraSpeed or package changes', async t => {
  tablet(t, { ignoredSetting: 'setting.duraspeed.enabled', ignoredPackage: 'com.motorola.demo' });
  const messages = [];
  const run = await provision.apply('TEST', {}, message => messages.push(message));
  assert.equal(run.ok, false);
  assert.equal(run.results.packages.find(p => p.pkg === 'com.motorola.demo').ok, false);
  assert.ok(run.results.settings.filter(s => /duraspeed/.test(s.key)).every(s => !s.ok));
  assert.equal(messages.at(-1).level, 'warn');
});

test('ignored Lenovo battery write stays off in the audit', async t => {
  tablet(t, { ignoredSetting: 'battery_protected_charge' });
  const run = await provision.apply('TEST');
  assert.equal(run.ok, false);
  assert.equal((await provision.audit('TEST')).batteryProtection.ok, false);
});

test('missing Lenovo control is reported as unconfirmed and is not invented', async t => {
  const fake = tablet(t);
  fake.values.delete('system/battery_protected_charge');
  const { report, plan } = await provision.preview('TEST');
  assert.equal(report.batteryProtection.supported, false);
  assert.equal(report.batteryProtection.ok, false);
  assert.equal(plan.settings.some(s => s.key === 'battery_protected_charge'), false);
});

test('profile-named data apps are deleted, even if disabled, and never offered as restorable', async t => {
  const pkg = 'com.king.candycrushsaga';
  const fake = tablet(t, { dataPackages: [pkg, 'com.owner.personalapp'] });
  fake.installed.add('com.owner.personalapp');
  fake.disabled.add(pkg);
  const before = await provision.preview('TEST');
  assert.deepEqual(before.plan.uninstallPackages.map(p => p.pkg), [pkg]);
  assert.ok(!before.plan.packages.includes(pkg));
  assert.equal(provision.buildPlan(before.report, { skipBloat: true }).uninstallPackages.length, 0);
  const run = await provision.apply('TEST');
  assert.equal(run.ok, true);
  assert.deepEqual(fake.removals, [pkg]);
  assert.ok(fake.installed.has('com.owner.personalapp'));
  const backup = JSON.parse(fs.readFileSync(run.backupFile));
  assert.equal(backup.deletions[0].status, 'deleted');
  assert.equal(backup.packages.some(p => p.pkg === pkg), false);
  const messages=[];
  await provision.revert('TEST', run.backupFile, r => messages.push(r.message));
  assert.ok(messages.some(m => /cannot restore the app or its data/.test(m)));
  assert.equal(fake.installed.has(pkg), false);
});

test('uninstall success output is not enough if the package is still installed', async t => {
  tablet(t, { dataPackages: ['com.king.candycrushsaga'], ignoredUninstall: true });
  const run = await provision.apply('TEST');
  assert.equal(run.ok, false);
  assert.equal(run.results.uninstalls[0].ok, false);
  const backup=provision.listBackups('TEST').find(b=>b.file===run.backupFile);
  assert.equal(backup.deletions,0);
  assert.equal(backup.unconfirmedDeletions,1);
});

test('protected, Panda Eats, live launcher and keyboard packages cannot be deleted even if a profile names them', async t => {
  const guarded = ['com.dolby.daxservice', 'com.pandaeats.bench.wallpaper', 'com.fixture.launcher', 'com.fixture.keyboard'];
  const fake = tablet(t, { dataPackages: guarded });
  for (const pkg of guarded) fake.installed.add(pkg);
  const real = profiles.loadBloat('lenovo');
  t.mock.method(profiles, 'loadBloat', () => ({ ...real, safe: [...real.safe, ...guarded] }));
  const { plan } = await provision.preview('TEST');
  assert.equal(plan.uninstallPackages.length, 0);
  await provision.apply('TEST');
  assert.deepEqual(fake.removals, []);
});

test('a package that moves out of data/app after the audit is not deleted', async t => {
  const pkg='com.king.candycrushsaga'; const fake=tablet(t, { dataPackages:[pkg] });
  let reads=0;
  t.mock.method(adb,'getPackagePaths',async(_,name)=>{
    if(name===pkg && ++reads===1)return ['/data/app/test/base.apk'];
    return [`/system/app/${name}/base.apk`];
  });
  const run=await provision.apply('TEST');
  assert.equal(run.ok,false);
  assert.deepEqual(fake.removals,[]);
});

test('DuraSpeed background tuning never authorizes deletion when no bloat profile names it', async t => {
  const fake=tablet(t,{dataPackages:['com.mediatek.duraspeed']});
  const {report,plan}=await provision.preview('TEST');
  assert.equal(report.bloat.find(b=>b.pkg==='com.mediatek.duraspeed').profileNamed,false);
  assert.ok(plan.packages.includes('com.mediatek.duraspeed'));
  assert.equal(plan.uninstallPackages.length,0);
  await provision.apply('TEST');
  assert.deepEqual(fake.removals,[]);
});
