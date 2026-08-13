'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The whole renderer surface. contextIsolation is on and nodeIntegration is
 * off, so this is the only way the UI can reach adb - it cannot invent new
 * commands, only call the ones listed here.
 */
contextBridge.exposeInMainWorld('bench', {
  adbInfo: () => ipcRenderer.invoke('adb:info'),
  locateAdb: () => ipcRenderer.invoke('adb:locate'),

  listDevices: () => ipcRenderer.invoke('devices:list'),
  audit: (serial, opts) => ipcRenderer.invoke('audit:run', serial, opts),
  /** Audit + the exact plan Apply would execute, in one round trip. */
  preview: (serial, opts) => ipcRenderer.invoke('plan:run', serial, opts),
  apply: (serial, opts) => ipcRenderer.invoke('apply:run', serial, opts),
  revert: (serial, file) => ipcRenderer.invoke('revert:run', serial, file),
  discover: (serial) => ipcRenderer.invoke('discover:run', serial),
  disablePackages: (serial, packages) => ipcRenderer.invoke('packages:disable', serial, packages),

  scanApks: () => ipcRenderer.invoke('apk:scan'),
  chooseApk: () => ipcRenderer.invoke('apk:choose'),
  inspectInstall: (serial, apkPath) => ipcRenderer.invoke('install:inspect', serial, apkPath),
  install: (serial, apkPath, opts) => ipcRenderer.invoke('install:run', serial, apkPath, opts),
  openPlay: (serial, pkg) => ipcRenderer.invoke('play:open', serial, pkg),
  launchApp: (serial, pkg) => ipcRenderer.invoke('app:launch', serial, pkg),

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
