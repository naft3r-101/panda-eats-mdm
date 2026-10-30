'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const adb = require('../electron/adb');
const wallpaper = require('../electron/wallpaper');
const provision = require('../electron/provision');

test('wallpaper dumps keep home and lock separate and ignore fallback and other users', () => {
  const state = wallpaper.parseWallpaperDump('System wallpaper state:\r\n User 0: id=2\r\n User 10: id=99\r\nLock wallpaper state:\r\n User 0: id=3\r\nFallback wallpaper state:\r\n User 0: id=1');
  assert.deepEqual(state, { homeId: 2, lockId: 3, readable: true });
  assert.equal(wallpaper.parseWallpaperDump('Permission denied').readable, false);
});

test('wallpaper confirmation rejects unchanged IDs, missing lock, and helper-only success', () => {
  const before = { homeId: 1, lockId: null };
  const after = { homeId: 2, lockId: 3, readable: true };
  const result = { homeId: 2, lockId: 3, ok: true };
  assert.equal(wallpaper.confirms(before, after, result), true);
  assert.equal(wallpaper.confirms(after, after, result), false);
  assert.equal(wallpaper.confirms(before, { ...after, lockId: null }, result), false);
  assert.equal(wallpaper.confirms(before, { ...after, readable: false }, result), false);
  assert.equal(wallpaper.confirms(before, after, { ...result, ok: false }), false);
  assert.equal(wallpaper.confirms(null, { ...after, lockId: null }, { ...result, lockId: -1 }, true), true);
});

test('wallpaper is a planned Apply change even on a clean tablet', () => {
  const report = { settings: [], bloat: [], app: [], blocked: [], brightnessOk: true, volumeOk: true };
  assert.equal(provision.buildPlan(report).total, 0);
  const plan = provision.buildPlan(report, { wallpaperPath: '/wallpaper.png' });
  assert.equal(plan.total, 1);
  assert.equal(plan.wallpaper.name, 'wallpaper.png');
});

test('picker fallback is pending, never success; jpeg MIME is correct', async t => {
  const file = path.join(os.tmpdir(), 'bench-fallback-test.jpeg');
  fs.writeFileSync(file, 'fixture');
  t.after(() => fs.unlinkSync(file));
  t.mock.method(adb, 'getManagement', async () => ({}));
  t.mock.method(wallpaper, 'apply', async () => { throw new Error('OEM refused'); });
  t.mock.method(adb, 'pushFile', async () => ({ ok: true }));
  t.mock.method(adb, 'indexInMediaStore', async () => ({ ok: true }));
  t.mock.method(adb, 'findMediaId', async () => '123');
  t.mock.method(adb, 'openSetAsWallpaper', async (_, uri, mime) => {
    assert.equal(mime, 'image/jpeg'); return { ok: true, via: 'picker' };
  });
  const result = await provision.setWallpaper('TEST', file);
  assert.equal(result.ok, false);
  assert.equal(result.pending, true);
});

test('policy blocked wallpaper never invokes helper or opens picker', async t => {
  t.mock.method(adb, 'getManagement', async () => ({ wallpaperBlocked: true }));
  const helper = t.mock.method(wallpaper, 'apply', async () => { throw new Error('must not run'); });
  const result = await provision.setWallpaper('TEST', __filename);
  assert.equal(result.ok, false);
  assert.equal(helper.mock.callCount(), 0);
});

test('adb runs outside the repository so its server cannot lock a worktree', () => {
  assert.ok(!path.resolve(adb.adbWorkingDirectory()).startsWith(path.resolve(__dirname, '..')));
});

function helperTablet(t, sdk = 34, coldUpload = false) {
  let disabled = true, changed = false, storage = 'default';
  const calls = [], files = new Map([['home.png', Buffer.from('saved original image')]]);
  const pending = new Set();
  const success = { ok: true, stdout: '', stderr: '' };
  t.mock.method(adb, 'installApk', async () => success);
  t.mock.method(adb, 'enablePackage', async () => { disabled=false; return success; });
  t.mock.method(adb, 'disablePackage', async () => { disabled=true; return success; });
  t.mock.method(adb, 'listDisabledPackages', async () => new Set(disabled ? [wallpaper.PKG] : []));
  t.mock.method(adb, 'getProps', async () => ({ 'ro.build.version.sdk': String(sdk) }));
  t.mock.method(adb, 'getAppOp', async () => storage);
  t.mock.method(adb, 'setAppOp', async (_,pkg,op,mode) => { storage=mode; return success; });
  t.mock.method(adb, 'revokePermission', async () => success);
  t.mock.method(adb, 'shell', async command => {
    if(command==='dumpsys wallpaper') return {...success,stdout:`System wallpaper state:\n User 0: id=${changed?2:1}\nLock wallpaper state:\n${changed?' User 0: id=3\n':''}Fallback wallpaper state:\n User 0: id=1`};
    const method=command.match(/--method (\w+)/)[1];calls.push(method);
    const result=method==='snapshot'?{home:true,lock:false}:method==='set'?{homeId:2,lockId:3}:{};
    if(method==='set')changed=true;
    return {...success,stdout:`Result: Bundle[{result=${JSON.stringify({...result,ok:true})}}]`};
  });
  t.mock.method(adb, 'runBinary', async (_, args, input) => {
    const name=args.at(-1).split('/').at(-1);
    if(input) { files.set(name,input); if (coldUpload) pending.add(name); }
    else if (pending.delete(name)) return {...success,stdout:Buffer.from('Error while accessing provider: file not found')};
    return {...success,stdout:input?Buffer.alloc(0):files.get(name)};
  });
  return {calls, get disabled(){return disabled;}, get storage(){return storage;}};
}

test('wallpaper saves the backup before set, then restores storage access and disables the helper', async t => {
  const tablet=helperTablet(t);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wallpaper-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const result=await wallpaper.apply('TEST',__filename,dir, saved=>{
    assert.equal(tablet.calls.includes('set'),false);
    assert.equal(fs.readFileSync(path.join(saved.directory,'home.png'),'utf8'),'saved original image');
    tablet.calls.push('backup-persisted');
  });
  assert.equal(result.ok,true);
  assert.deepEqual(tablet.calls,['snapshot','backup-persisted','set','clean']);
  assert.equal(tablet.disabled,true);
  assert.equal(tablet.storage,'default');
});

test('failed backup persistence prevents wallpaper changes and still cleans up the helper', async t => {
  const tablet=helperTablet(t,29);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wallpaper-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  await assert.rejects(wallpaper.apply('TEST',__filename,dir,()=>{throw Error('disk full');}),/disk full/);
  assert.deepEqual(tablet.calls,['snapshot','clean']);
  assert.equal(tablet.disabled,true);
});

test('cold helper upload waits for complete bytes before setting wallpaper', async t => {
  const tablet=helperTablet(t,29,true);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wallpaper-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  assert.equal((await wallpaper.apply('TEST',__filename,dir,()=>{})).ok,true);
  assert.equal(tablet.disabled,true);
});

test('Android 14 dump fields do not confuse the wallpaper IDs', () => {
  const state=wallpaper.parseWallpaperDump('mDefaultWallpaperComponent=null\nSystem wallpaper state:\n User 0: id=52: mWhich=1: mSystemWasBoth=false\nLock wallpaper state:\n User 0: id=53: mWhich=2: mSystemWasBoth=false\nFallback wallpaper state:\n User 0: id=1: mWhich=1');
  assert.deepEqual(state,{homeId:52,lockId:53,readable:true});
});
