'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The whole renderer surface. contextIsolation is on and nodeIntegration is
 * off, so this is the only way the UI can reach adb - it cannot invent new
 * commands, only call the ones listed here.
 */
contextBridge.exposeInMainWorld('bench', {
  appVersion: () => ipcRenderer.invoke('app:version'),

  /** Panda Bench's own updates - nothing to do with openSystemUpdate below,
   *  which is the tablet's Android update screen. */
  updateStatus: () => ipcRenderer.invoke('selfupdate:status'),
  checkForUpdates: () => ipcRenderer.invoke('selfupdate:check'),
  installUpdate: () => ipcRenderer.invoke('selfupdate:install'),
  onUpdateStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('selfupdate:status', listener);
    return () => ipcRenderer.removeListener('selfupdate:status', listener);
  },

  adbInfo: () => ipcRenderer.invoke('adb:info'),
  locateAdb: () => ipcRenderer.invoke('adb:locate'),

  listDevices: () => ipcRenderer.invoke('devices:list'),
  audit: (serial, opts) => ipcRenderer.invoke('audit:run', serial, opts),
  /** Audit + the exact plan Apply would execute, in one round trip. */
  preview: (serial, opts) => ipcRenderer.invoke('plan:run', serial, opts),
  /** Re-plan from a report already in hand. No adb: the skip switches use it. */
  buildPlan: (report, opts) => ipcRenderer.invoke('plan:build', report, opts),
  /** The read-only readiness gate for the Verify tab. */
  verify: (serial, opts) => ipcRenderer.invoke('verify:run', serial, opts),
  getHandover: (serial) => ipcRenderer.invoke('handover:get', serial),
  saveHandover: (serial, patch) => ipcRenderer.invoke('handover:set', serial, patch),
  /** An ESC/POS slip sent to a LAN printer from the tablet itself. */
  printTestSlip: (serial, host) => ipcRenderer.invoke('slip:print', serial, host),
  /** Asks for confirmation in the main process, then turns USB debugging off. */
  ship: (serial, opts) => ipcRenderer.invoke('ship:run', serial, opts),
  apply: (serial, opts) => ipcRenderer.invoke('apply:run', serial, opts),
  /** The three-read counter-readiness check, run on every connect. */
  driftCheck: (serial) => ipcRenderer.invoke('drift:check', serial),
  revert: (serial, file) => ipcRenderer.invoke('revert:run', serial, file),
  discover: (serial) => ipcRenderer.invoke('discover:run', serial),
  disablePackages: (serial, packages) => ipcRenderer.invoke('packages:disable', serial, packages),

  scanApks: () => ipcRenderer.invoke('apk:scan'),
  chooseApk: () => ipcRenderer.invoke('apk:choose'),
  inspectInstall: (serial, apkPath) => ipcRenderer.invoke('install:inspect', serial, apkPath),
  install: (serial, apkPath, opts) => ipcRenderer.invoke('install:run', serial, apkPath, opts),
  openPlay: (serial, pkg) => ipcRenderer.invoke('play:open', serial, pkg),
  launchApp: (serial, pkg) => ipcRenderer.invoke('app:launch', serial, pkg),

  /** Both prompt for confirmation in the main process before doing anything. */
  rebootDevice: (serial) => ipcRenderer.invoke('device:reboot', serial),
  powerOffDevice: (serial) => ipcRenderer.invoke('device:poweroff', serial),

  listWallpapers: () => ipcRenderer.invoke('wallpaper:list'),
  chooseWallpaper: () => ipcRenderer.invoke('wallpaper:choose'),
  setWallpaper: (serial, localPath) => ipcRenderer.invoke('wallpaper:set', serial, localPath),
  openSystemUpdate: (serial) => ipcRenderer.invoke('update:open', serial),

  listBackups: (serial) => ipcRenderer.invoke('backups:list', serial),
  openStateFolder: () => ipcRenderer.invoke('state:open'),
  openProfilesFolder: () => ipcRenderer.invoke('profiles:open'),

  /** Streamed apply/revert log lines. Returns an unsubscribe function. */
  onProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('progress', listener);
    return () => ipcRenderer.removeListener('progress', listener);
  },
});
