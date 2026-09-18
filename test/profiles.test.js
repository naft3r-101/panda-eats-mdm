'use strict';

/**
 * The profiles as they sit on disk. These are invariants over the text files
 * people edit by hand, which is exactly where a typo becomes a bricked tablet.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const profiles = require('../electron/profiles');

test('settings.txt parses into known scopes with the lines this profile promises', () => {
  const settings = profiles.loadSettings();
  assert.ok(settings.length >= 20);
  for (const s of settings) {
    assert.ok(['global', 'system', 'secure'].includes(s.scope), `bad scope on ${s.key}`);
    assert.match(s.key, /^[a-z0-9_]+$/, `odd key ${s.key}`);
    assert.ok(s.value.length > 0, `empty value for ${s.key}`);
  }
  const byKey = Object.fromEntries(settings.map((s) => [s.key, s]));
  assert.equal(byKey.stay_on_while_plugged_in.value, '7');
  assert.equal(byKey.screen_brightness_mode.value, '0');
  assert.equal(byKey.animator_duration_scale.value, '0.5', 'zero freezes Compose spinners');
  assert.equal(byKey.auto_time.value, '1');
  assert.equal(byKey.auto_time_zone.value, '1');
  assert.equal(byKey.protect_battery.value, '1', '1 is the 80% cap on One UI 6.1');
  assert.equal(byKey.adaptive_fast_charging.value, '0');
  assert.equal('network_recommendations_enabled' in byKey, false, 'Android 12+ ignores the write');
});

test('no setting key is listed twice', () => {
  const keys = profiles.loadSettings().map((s) => `${s.scope}/${s.key}`);
  assert.deepEqual([...new Set(keys)], keys);
});

test('the guard list protects the things whose loss bricks a tablet', () => {
  const guarded = profiles.loadProtected();
  for (const pkg of [
    'android',
    'com.android.systemui',
    'com.android.settings',
    'com.android.permissioncontroller',
    'com.google.android.webview',
    'com.google.android.gms',
    'com.android.vending',
    'com.samsung.android.honeyboard',
    'com.sec.android.app.launcher',
    'com.google.android.googlequicksearchbox',
    'com.pandaeats.ordertaking',
  ]) {
    assert.ok(guarded.has(pkg), `${pkg} must be protected`);
  }
});

test('no bloat entry, in any tier or OEM file, names a protected package', () => {
  const guarded = profiles.loadProtected();
  for (const oem of ['', ...profiles.availableOems()]) {
    const lists = profiles.loadBloat(oem);
    for (const pkg of [...lists.safe, ...lists.aggressive]) {
      assert.equal(guarded.has(pkg), false, `${pkg} is in both a bloat list (${oem || 'common'}) and protected.txt`);
    }
  }
});

test('bloat lists parse the aggressive marker and fall back to common for unknown OEMs', () => {
  const samsung = profiles.loadBloat('Samsung');
  assert.deepEqual(samsung.sources, ['common.txt', 'samsung.txt']);
  assert.ok(samsung.safe.includes('com.samsung.android.bixby.agent'));
  assert.ok(samsung.aggressive.includes('com.sec.android.app.samsungapps'));
  assert.equal(samsung.safe.includes('com.sec.android.app.samsungapps'), false);
  for (const pkg of [...samsung.safe, ...samsung.aggressive]) assert.match(pkg, /^[a-z][\w.]*$/i, `odd package ${pkg}`);

  const unknown = profiles.loadBloat('acme');
  assert.deepEqual(unknown.sources, ['common.txt']);
});

test('the fingerprint is short, hex and stable across calls', () => {
  const a = profiles.fingerprint();
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.equal(profiles.fingerprint(), a);
});
