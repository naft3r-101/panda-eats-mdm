'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const adb = require('../electron/adb');
test('pm path handles split APKs and CRLF, and unknown paths fail closed', () => {
  const paths = adb.parsePackagePaths('package:/data/app/~~abc/com.test/base.apk\r\npackage:/data/app/~~abc/com.test/split.apk\r\n');
  assert.equal(adb.packageLocation(paths), 'data');
  for (const dir of ['system','product','vendor','system_ext','odm','oem']) assert.equal(adb.packageLocation([`/${dir}/app/base.apk`]), 'system');
  assert.equal(adb.packageLocation([]), 'unknown');
  assert.equal(adb.packageLocation(['/data/app/test.apk', '/system/app/test.apk']), 'unknown');
  assert.equal(adb.packageLocation(['/data/application/test.apk']), 'unknown');
  assert.equal(adb.packageLocation(['/sdcard/base.apk']), 'unknown');
});
