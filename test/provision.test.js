'use strict';

/**
 * The planner and the readiness gate, both pure. A wrong plan is the whole
 * risk of this tool, and the readiness checks are what decides whether a
 * tablet leaves the bench.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const provision = require('../electron/provision');

test('valuesEqual compares numerically when both sides are numbers', () => {
  assert.equal(provision.valuesEqual('1.0', '1'), true);
  assert.equal(provision.valuesEqual('0.0', '0'), true);
  assert.equal(provision.valuesEqual('false', 'false'), true);
  assert.equal(provision.valuesEqual('false', '0'), false);
  assert.equal(provision.valuesEqual(null, '0'), false);
  assert.equal(provision.valuesEqual(' 7 ', '7'), true);
});

test('assertInventorySane refuses a package list that cannot be a real tablet', () => {
  assert.throws(() => provision.assertInventorySane(new Set()), /still booting/);
  const noFramework = new Set(Array.from({ length: 100 }, (_, i) => `com.example.pkg${i}`));
  assert.throws(() => provision.assertInventorySane(noFramework), /framework package was not among them/);
  const fine = new Set([...noFramework, 'android']);
  assert.doesNotThrow(() => provision.assertInventorySane(fine));
});

/** A report as audit() shapes it, with every knob turned to "clean". */
function cleanReport(overrides = {}) {
  return {
    device: {
      serial: 'R9PW10N9KCP',
      model: 'SM-T227U',
      brightness: { current: 255, max: 255 },
      mediaVolume: { current: 15, max: 15 },
      ime: 'com.samsung.android.honeyboard',
      launcher: 'com.sec.android.app.launcher',
    },
    settings: [{ scope: 'global', key: 'auto_time', desired: '1', current: '1', ok: true }],
    bloat: [],
    app: [
      {
        pkg: 'com.pandaeats.ordertaking',
        dozeExempt: true,
        bucketOk: true,
        opsOk: true,
        standbyBucket: 10,
        permissions: { 'android.permission.POST_NOTIFICATIONS': true, 'android.permission.BLUETOOTH_CONNECT': true },
        permissionsOk: true,
      },
    ],
    blocked: [],
    volumeOk: true,
    brightnessOk: true,
    lockScreen: { disabled: true, credentialType: null, fixable: false, ok: true },
    ...overrides,
  };
}

test('buildPlan on a clean tablet has nothing to do', () => {
  const plan = provision.buildPlan(cleanReport());
  assert.equal(plan.total, 0);
  assert.equal(plan.lockScreen, null);
});

test('buildPlan keeps the levels and the lock screen whatever the skip switches say', () => {
  const report = cleanReport({
    brightnessOk: false,
    device: { ...cleanReport().device, brightness: { current: 20, max: 255 } },
    lockScreen: { disabled: false, credentialType: 'NONE', fixable: true, ok: false },
  });
  const plan = provision.buildPlan(report, { skipSettings: true, skipBloat: true, skipAppTuning: true });
  assert.equal(plan.settings.length, 0);
  assert.equal(plan.packages.length, 0);
  assert.equal(plan.apps.length, 0);
  assert.equal(plan.levels.length, 1);
  assert.equal(plan.levels[0].what, 'Screen brightness');
  assert.equal(plan.levels[0].desired, '204 of 255');
  assert.deepEqual(plan.lockScreen, { what: 'Screen lock', current: 'swipe to unlock', desired: 'none' });
  assert.equal(plan.total, 2);
});

test('buildPlan never plans to remove a PIN', () => {
  const plan = provision.buildPlan(cleanReport({ lockScreen: { disabled: false, credentialType: 'PIN', fixable: false, ok: false } }));
  assert.equal(plan.lockScreen, null);
  assert.equal(plan.total, 0);
});

test('buildPlan treats a denied runtime permission as an order-app fix', () => {
  const report = cleanReport();
  report.app[0].permissions['android.permission.POST_NOTIFICATIONS'] = false;
  report.app[0].permissionsOk = false;
  const plan = provision.buildPlan(report);
  assert.equal(plan.apps.length, 1);
  assert.equal(plan.total, 1);
  assert.equal(provision.buildPlan(report, { skipAppTuning: true }).total, 0);
});

test('buildPlan excludes protected and already-disabled packages', () => {
  const report = cleanReport({
    bloat: [
      { pkg: 'com.samsung.android.bixby.agent', disabled: false, protected: false },
      { pkg: 'com.samsung.android.honeyboard', disabled: false, protected: true },
      { pkg: 'com.facebook.katana', disabled: true, protected: false },
    ],
    blocked: ['com.samsung.android.honeyboard'],
  });
  const plan = provision.buildPlan(report);
  assert.deepEqual(plan.packages, ['com.samsung.android.bixby.agent']);
  assert.deepEqual(plan.blocked, ['com.samsung.android.honeyboard']);
});

/** A verify() report with every readout in the good state. */
function readyReport(overrides = {}) {
  const prod = {
    pkg: 'com.pandaeats.ordertaking',
    versionName: '1.4.4',
    versionCode: '93',
    enabled: true,
    running: true,
    listener: { name: 'com.pandaeats.ordertaking.service.OrderListenerService', foreground: true },
    permissions: { 'android.permission.POST_NOTIFICATIONS': true, 'android.permission.BLUETOOTH_CONNECT': true },
    dozeExempt: true,
    bucketOk: true,
    opsOk: true,
  };
  return {
    device: { serial: 'R9PW10N9KCP', manufacturer: 'samsung', model: 'SM-T227U' },
    apps: [prod],
    prod,
    wifi: { enabled: true, connected: true, ssid: 'Kitchen', ip: '192.168.1.20', rssi: -50 },
    backend: { ok: true, ms: 40 },
    printer: null,
    printerHost: '',
    clock: { epoch: 1, timezone: 'America/New_York', driftSeconds: 2 },
    autoTime: { time: '1', zone: '1' },
    lockScreen: { disabled: true, credentialType: null },
    battery: { level: 80, charging: true, health: 'good', temperatureC: 31 },
    accounts: { hasGoogle: true },
    record: { tool: 'panda-bench', provisionedAt: '2026-09-15T18:00:00Z', profile: 'abcd1234', benchVersion: '0.3.6' },
    profile: 'abcd1234',
    ...overrides,
  };
}

const byId = (checks) => Object.fromEntries(checks.map((c) => [c.id, c]));
const noBad = (checks) => checks.every((c) => c.status !== 'bad');

test('readinessChecks passes a tablet that can take an order', () => {
  const checks = provision.readinessChecks(readyReport());
  assert.equal(noBad(checks), true);
  assert.equal(byId(checks).printer.status, 'skip');
  assert.equal(byId(checks).record.status, 'ok');
});

test('readinessChecks fails when the production app is missing, even with a staging build present', () => {
  const staging = { ...readyReport().prod, pkg: 'com.pandaeats.ordertaking.staging' };
  const checks = provision.readinessChecks(readyReport({ apps: [staging], prod: null }));
  const app = byId(checks).app;
  assert.equal(app.status, 'bad');
  assert.match(app.detail, /staging/);
  assert.equal(app.fix, 'setup');
});

test('readinessChecks sends the listener to Launch and permissions to Apply', () => {
  const r = readyReport();
  r.prod.listener = null;
  r.prod.running = false;
  r.prod.permissions['android.permission.POST_NOTIFICATIONS'] = false;
  const c = byId(provision.readinessChecks(r));
  assert.equal(c.listener.status, 'bad');
  assert.equal(c.listener.fix, 'launch');
  assert.equal(c.notifications.status, 'bad');
  assert.equal(c.notifications.fix, 'apply');
});

test('readinessChecks treats a permission the build does not declare as fine', () => {
  const r = readyReport();
  r.prod.permissions['android.permission.POST_NOTIFICATIONS'] = null;
  assert.equal(byId(provision.readinessChecks(r)).notifications.status, 'ok');
});

test('readinessChecks tells a swipe lock (Apply) from a PIN (by hand)', () => {
  const swipe = byId(provision.readinessChecks(readyReport({ lockScreen: { disabled: false, credentialType: 'NONE' } }))).lock;
  assert.equal(swipe.status, 'bad');
  assert.equal(swipe.fix, 'apply');
  const pin = byId(provision.readinessChecks(readyReport({ lockScreen: { disabled: false, credentialType: 'PIN' } }))).lock;
  assert.equal(pin.status, 'bad');
  assert.equal(pin.fix, 'manual');
});

test('readinessChecks fails the clock when automatic time is off or the drift is large', () => {
  const off = byId(provision.readinessChecks(readyReport({ autoTime: { time: '0', zone: '1' } }))).clock;
  assert.equal(off.status, 'bad');
  assert.equal(off.fix, 'apply');
  const drifted = byId(provision.readinessChecks(readyReport({ clock: { epoch: 1, timezone: 'UTC', driftSeconds: -400 } }))).clock;
  assert.equal(drifted.status, 'bad');
  assert.equal(drifted.fix, 'manual');
});

test('readinessChecks checks the printer only when an address is given', () => {
  const unreachable = byId(provision.readinessChecks(readyReport({ printerHost: '192.168.99.100', printer: { ok: false, ms: null, output: '' } }))).printer;
  assert.equal(unreachable.status, 'bad');
  const reachable = byId(provision.readinessChecks(readyReport({ printerHost: '192.168.99.100', printer: { ok: true, ms: 3 } }))).printer;
  assert.equal(reachable.status, 'ok');
});

test('readinessChecks only warns, never blocks, on battery, account and record', () => {
  const checks = provision.readinessChecks(
    readyReport({
      battery: { level: 100, charging: true, health: 'overheat', temperatureC: 48 },
      accounts: { hasGoogle: false },
      record: null,
    })
  );
  const c = byId(checks);
  assert.equal(c.battery.status, 'warn');
  assert.equal(c.account.status, 'warn');
  assert.equal(c.record.status, 'warn');
  assert.equal(noBad(checks), true);
});

test('readinessChecks flags a record from an older profile', () => {
  const c = byId(provision.readinessChecks(readyReport({ profile: 'ffffffff' }))).record;
  assert.equal(c.status, 'warn');
  assert.match(c.detail, /older profile/);
});

test('parseRecord accepts only this tool\'s records', () => {
  assert.equal(provision.parseRecord(null), null);
  assert.equal(provision.parseRecord('not json'), null);
  assert.equal(provision.parseRecord('{"tool":"other"}'), null);
  assert.deepEqual(provision.parseRecord('{"tool":"panda-bench","version":1}'), { tool: 'panda-bench', version: 1 });
});

test('every checklist item has an id, a label and a note, and none duplicates an automatic step', () => {
  const ids = new Set();
  for (const item of provision.CHECKLIST) {
    assert.ok(item.id && item.label && item.note, `incomplete item ${JSON.stringify(item)}`);
    assert.equal(ids.has(item.id), false, `duplicate id ${item.id}`);
    ids.add(item.id);
  }
  // Apply's doze exemption is what the battery dialog grants, and the Play
  // version check replaced the auto-update tick. Neither belongs on the list.
  assert.equal(ids.has('battery-dialog'), false);
  assert.equal(ids.has('play-updates'), false);
  // Samsung's sleeping-app pickers never offer an Unrestricted app, and the
  // doze exemption makes the order app Unrestricted.
  assert.equal(ids.has('sleeping-apps'), false);
});

test('readinessChecks compares the tablet against what Play is serving', () => {
  const current = byId(provision.readinessChecks(readyReport({ latest: { versionCode: 93, versionName: '1.4.4', status: 'completed' } }))).update;
  assert.equal(current.status, 'ok');
  const behind = byId(provision.readinessChecks(readyReport({ latest: { versionCode: 95, versionName: '1.4.6', status: 'completed' } }))).update;
  assert.equal(behind.status, 'warn');
  assert.equal(behind.fix, 'setup');
  assert.match(behind.detail, /1\.4\.6 \(95\)/);
  const unknown = byId(provision.readinessChecks(readyReport({ latest: { error: 'no key', source: null } }))).update;
  assert.equal(unknown.status, 'skip');
  assert.match(unknown.detail, /no key/);
});

test('testSlipBytes is a well-formed ESC/POS job', () => {
  const bytes = provision.testSlipBytes({ model: 'SM-T227U', serial: 'R9PW10N9KCP', host: '192.168.1.50', when: new Date('2026-09-15T18:00:00Z') });
  assert.deepEqual([...bytes.subarray(0, 2)], [0x1b, 0x40], 'starts with ESC @');
  assert.deepEqual([...bytes.subarray(-4)], [0x1d, 0x56, 0x42, 0x00], 'ends with feed and cut');
  const text = bytes.toString('latin1');
  assert.match(text, /PANDA EATS/);
  assert.match(text, /R9PW10N9KCP/);
  assert.match(text, /192\.168\.1\.50:9100/);
});
