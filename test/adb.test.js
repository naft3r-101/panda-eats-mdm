'use strict';

/**
 * The parsers in adb.js, fed the exact text real tablets produce.
 *
 * Every sample here was captured from hardware (an SM-T227U on Android 14
 * unless noted) and then trimmed. Two of them exist to guard landmines the
 * README documents: adb's CRLF on Windows, and dumpsys prefix-matching.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const adb = require('../electron/adb');

test('normalise strips CRLF so package names compare exactly', () => {
  assert.equal(adb.normalise('package:com.foo\r\npackage:com.bar\r\n'), 'package:com.foo\npackage:com.bar\n');
  assert.deepEqual(adb.toLines('a\r\nb\r\n\r\nc'), ['a', 'b', 'c']);
});

const PACKAGE_DUMP = `
Packages:
  Package [com.pandaeats.ordertaking] (1a2b3c):
    userId=10235
    versionCode=93 minSdk=28 targetSdk=36
    versionName=1.4.4
    install permissions:
      android.permission.INTERNET: granted=true
      android.permission.WAKE_LOCK: granted=true
    User 0: ceDataInode=0 installed=true hidden=false suspended=false distractionFlags=0 stopped=false notLaunched=false enabled=0 instant=false virtual=false
      runtime permissions:
        android.permission.POST_NOTIFICATIONS: granted=false, flags=[ USER_SENSITIVE_WHEN_GRANTED|USER_SENSITIVE_WHEN_DENIED]
        android.permission.BLUETOOTH_CONNECT: granted=true, flags=[ USER_SENSITIVE_WHEN_GRANTED|USER_SENSITIVE_WHEN_DENIED]
  Package [com.pandaeats.ordertaking.staging] (4d5e6f):
    userId=10240
    versionCode=94 minSdk=28 targetSdk=36
    versionName=1.4.5-staging
    User 0: ceDataInode=0 installed=true hidden=false suspended=false distractionFlags=0 stopped=false notLaunched=false enabled=0 instant=false virtual=false
      runtime permissions:
        android.permission.POST_NOTIFICATIONS: granted=true, flags=[ USER_SENSITIVE_WHEN_GRANTED|USER_SENSITIVE_WHEN_DENIED]
`.replace(/\n/g, '\r\n');

test('parsePackageBlocks keys on the exact package, not the prefix', () => {
  const blocks = adb.parsePackageBlocks(PACKAGE_DUMP);
  assert.deepEqual([...blocks.keys()], ['com.pandaeats.ordertaking', 'com.pandaeats.ordertaking.staging']);
  assert.match(blocks.get('com.pandaeats.ordertaking').join('\n'), /versionName=1\.4\.4/);
  assert.match(blocks.get('com.pandaeats.ordertaking.staging').join('\n'), /versionName=1\.4\.5-staging/);
});

test('parseRuntimePermissions reads only the runtime section of the exact package', () => {
  const prod = adb.parseRuntimePermissions(PACKAGE_DUMP, 'com.pandaeats.ordertaking');
  assert.deepEqual(prod, {
    'android.permission.POST_NOTIFICATIONS': false,
    'android.permission.BLUETOOTH_CONNECT': true,
  });
  // Install permissions print granted=true too and must not leak in.
  assert.equal('android.permission.INTERNET' in prod, false);

  // The staging neighbour has notifications granted; prod must not inherit it.
  const staging = adb.parseRuntimePermissions(PACKAGE_DUMP, 'com.pandaeats.ordertaking.staging');
  assert.equal(staging['android.permission.POST_NOTIFICATIONS'], true);

  assert.equal(adb.parseRuntimePermissions(PACKAGE_DUMP, 'com.pandaeats.ordertaking.dev'), null);
});

const SERVICES_DUMP = `
ACTIVITY MANAGER SERVICES (dumpsys activity services)
  User 0 active services:
  * ServiceRecord{42d7d7c u0 com.pandaeats.ordertaking/.service.OrderListenerService}
    intent={cmp=com.pandaeats.ordertaking/.service.OrderListenerService}
    isForeground=true foregroundId=1 types=40000000 foregroundNoti=Notification(channel=panda.listener)
  * ServiceRecord{410e96f u0 com.pandaeats.ordertaking/.service.PandaFirebaseMessagingService}
    intent={cmp=com.pandaeats.ordertaking/.service.PandaFirebaseMessagingService}
  * ServiceRecord{9a8b7c6 u0 com.pandaeats.ordertaking.staging/.service.OrderListenerService}
    intent={cmp=com.pandaeats.ordertaking.staging/.service.OrderListenerService}
    isForeground=true foregroundId=1
`.replace(/\n/g, '\r\n');

test('parseRunningServices keeps the exact package and reads the foreground flag', () => {
  const prod = adb.parseRunningServices(SERVICES_DUMP, 'com.pandaeats.ordertaking');
  assert.deepEqual(prod, [
    { name: 'com.pandaeats.ordertaking.service.OrderListenerService', foreground: true },
    { name: 'com.pandaeats.ordertaking.service.PandaFirebaseMessagingService', foreground: false },
  ]);
  const dev = adb.parseRunningServices(SERVICES_DUMP, 'com.pandaeats.ordertaking.dev');
  assert.deepEqual(dev, []);
});

test('parseLockScreen tells swipe, credential and off apart', () => {
  assert.deepEqual(adb.parseLockScreen('false\r\n', 'CredentialType: NONE'), { disabled: false, credentialType: 'NONE' });
  assert.deepEqual(adb.parseLockScreen('false', '    CredentialType: PIN\n'), { disabled: false, credentialType: 'PIN' });
  assert.deepEqual(adb.parseLockScreen('true', ''), { disabled: true, credentialType: null });
  assert.deepEqual(adb.parseLockScreen('', ''), { disabled: null, credentialType: null });
});

const WIFI_STATUS = `Wifi is enabled
Wifi scanning is always available
==== Primary ClientModeManager instance ====
Wifi is connected to "Srinivas-extender"
WifiInfo: SSID: "Srinivas-extender", BSSID: 9c:4f:5f:75:aa:9c, MAC: de:df:2a:3f:a5:55, IP: /192.168.86.142, Security type: 2, Supplicant state: COMPLETED, Wi-Fi standard: 5, RSSI: -42, Link speed: 390Mbps
successfulTxPackets: 7599
`.replace(/\n/g, '\r\n');

test('parseWifiStatus reads SSID, address and signal from cmd wifi status', () => {
  assert.deepEqual(adb.parseWifiStatus(WIFI_STATUS), {
    enabled: true,
    connected: true,
    ssid: 'Srinivas-extender',
    ip: '192.168.86.142',
    rssi: -42,
  });
  assert.deepEqual(adb.parseWifiStatus('Wifi is disabled\nWifi is not connected'), {
    enabled: false,
    connected: false,
    ssid: null,
    ip: null,
    rssi: null,
  });
});

test('parseWifiDump handles the older dumpsys shape', () => {
  const dump = `mWifiInfo SSID: "Kitchen", BSSID: aa:bb:cc:dd:ee:ff, MAC: 02:00:00:00:00:00, Supplicant state: COMPLETED, RSSI: -55, Link speed: 72Mbps
mNetworkInfo [type: WIFI[], state: CONNECTED/CONNECTED, reason: (unspecified)]`;
  const r = adb.parseWifiDump(dump);
  assert.equal(r.connected, true);
  assert.equal(r.ssid, 'Kitchen');
  assert.equal(r.rssi, -55);
});

test('parsePing accepts one reply and rejects none', () => {
  const good = `PING app.getpandaeats.com (165.227.255.138) 56(84) bytes of data.
64 bytes from 165.227.255.138: icmp_seq=1 ttl=47 time=45.7 ms

--- app.getpandaeats.com ping statistics ---
1 packets transmitted, 1 received, 0% packet loss, time 0ms`;
  assert.deepEqual(adb.parsePing(good), { ok: true, ms: 45.7 });
  const none = `PING 192.168.99.100 (192.168.99.100) 56(84) bytes of data.

--- 192.168.99.100 ping statistics ---
1 packets transmitted, 0 received, 100% packet loss, time 0ms`;
  assert.deepEqual(adb.parsePing(none), { ok: false, ms: null });
  assert.equal(adb.parsePing('ping: unknown host nowhere.invalid').ok, false);
});

test('pingHost refuses anything that is not a host name', async () => {
  const r = await adb.pingHost('SERIAL', '192.168.1.1; reboot');
  assert.equal(r.ok, false);
  assert.match(r.error, /not a valid host/);
});

test('deviceWentDown spots system_server dying and stays quiet for plain refusals', () => {
  assert.equal(adb.deviceWentDown({ stdout: '', stderr: 'Failure calling service package: Broken pipe (32)' }), true);
  assert.equal(adb.deviceWentDown("cmd: Can't find service: package"), true);
  assert.equal(adb.deviceWentDown({ stdout: 'Failure [not installed for 0]', stderr: '' }), false);
  assert.equal(adb.deviceWentDown('SecurityException: Cannot disable a protected package'), false);
});

test('explainInstallFailure names the signing-key case', () => {
  assert.match(adb.explainInstallFailure('Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: ...]'), /different signing key/);
  assert.equal(adb.explainInstallFailure('Success'), null);
});
