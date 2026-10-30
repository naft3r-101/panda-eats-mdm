'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { overview, settingLabel, packageLabel } = require('../renderer/presentation');

test('missing readings never turn the friendly overview green', () => {
  assert.ok(overview({}).every(card => card.kind !== 'ok'));
});

test('a test build does not count as the production order app', () => {
  const [card] = overview({ app: [{ pkg: 'com.pandaeats.ordertaking.staging', enabled: true }] });
  assert.equal(card.value, 'Needs setup');
});

test('an installed production app is not presented as order-ready', () => {
  const [card] = overview({ app: [{ pkg: 'com.pandaeats.ordertaking', enabled: true }] });
  assert.equal(card.kind, 'info');
  assert.match(card.detail, /Run Check/);
});

test('DuraSpeed needs attention unless the audit confirms every control', () => {
  const report = { backgroundSurvival: { packageDisabled: true, ok: false } };
  assert.equal(overview(report)[1].kind, 'warn');
  report.backgroundSurvival.ok = true;
  assert.equal(overview(report)[1].kind, 'ok');
});

test('an unsupported Lenovo battery control cannot become a confirmed limit', () => {
  assert.equal(overview({ batteryProtection: { supported: false, ok: true } })[2].value, 'Not confirmed');
  assert.equal(overview({ batteryProtection: { supported: true, ok: false } })[2].kind, 'warn');
  assert.equal(overview({ batteryProtection: { supported: true, ok: true } })[2].value, '60% limit is on');
});

test('friendly labels preserve unknown keys and identify previous operator apps', () => {
  assert.match(settingLabel({ key: 'app_standby_enabled' }), /sleep/);
  assert.equal(settingLabel({ key: 'new_oem_key' }), 'new_oem_key');
  assert.match(packageLabel('com.grubhub.android.orderhub'), /Grubhub/);
  assert.equal(packageLabel('com.owner.special'), 'com.owner.special');
});
