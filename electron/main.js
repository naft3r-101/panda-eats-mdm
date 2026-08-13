'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const adb = require('./adb');
const apk = require('./apk');
const provision = require('./provision');
const profiles = require('./profiles');
const { initAutoUpdate } = require('./updater');

let mainWindow = null;

/**
 * Rollback points live next to the project during development so they are easy
 * to read, and in userData once packaged, because a packaged app cannot write
 * beside its own exe under Program Files.
 */
function resolveStateDir() {
  if (app.isPackaged) return path.join(app.getPath('userData'), 'state');
  return path.join(__dirname, '..', 'state');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 940,
    minHeight: 640,
    backgroundColor: '#FAFAFA',
    title: 'Panda Bench',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(() => {
  provision.setStateDir(resolveStateDir());
  createWindow();
  initAutoUpdate(() => mainWindow);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

/** Every handler returns {ok, data} or {ok:false, error} - the renderer never
 *  has to deal with a rejected promise. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      const data = await fn(event, ...args);
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
}

handle('adb:info', async () => ({
  path: adb.resolveAdb(),
  found: fs.existsSync(adb.resolveAdb()),
  profilesDir: profiles.profilesDir(),
  stateDir: resolveStateDir(),
  oems: profiles.availableOems(),
}));

handle('adb:locate', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Locate adb.exe',
    properties: ['openFile'],
    filters: [{ name: 'adb', extensions: ['exe'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return { changed: false };
  adb.setAdbPath(result.filePaths[0]);
  return { changed: true, path: result.filePaths[0] };
});

handle('devices:list', async () => adb.listDevices());

handle('audit:run', async (event, serial, opts) => provision.audit(serial, opts || {}));

handle('plan:run', async (event, serial, opts) => provision.preview(serial, opts || {}));

handle('apply:run', async (event, serial, opts) =>
  provision.apply(serial, opts || {}, (progress) => {
    if (!event.sender.isDestroyed()) event.sender.send('progress', progress);
  })
);

handle('revert:run', async (event, serial, file) =>
  provision.revert(serial, file, (progress) => {
    if (!event.sender.isDestroyed()) event.sender.send('progress', progress);
  })
);

handle('discover:run', async (event, serial) => provision.discover(serial));

handle('packages:disable', async (event, serial, packages) =>
  provision.disableSelected(serial, packages || [], (progress) => {
    if (!event.sender.isDestroyed()) event.sender.send('progress', progress);
  })
);

// --- Install ---------------------------------------------------------------

handle('apk:scan', async () => {
  const candidates = apk.scanForApks();
  const enriched = [];
  for (const c of candidates) {
    const info = await apk.readApkInfo(c.path);
    enriched.push({ ...info, mtime: c.mtime });
  }
  // Ours first, then anything else, newest within each group.
  return {
    aapt2: apk.resolveAapt2(),
    candidates: enriched.sort((a, b) => {
      const ours = (x) => (x.applicationId && x.applicationId.startsWith('com.pandaeats.') ? 0 : 1);
      if (ours(a) !== ours(b)) return ours(a) - ours(b);
      return b.mtime - a.mtime;
    }),
  };
});

handle('apk:choose', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose an APK to install',
    properties: ['openFile'],
    filters: [{ name: 'Android package', extensions: ['apk'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return { chosen: null };
  return { chosen: await apk.readApkInfo(result.filePaths[0]) };
});

handle('install:inspect', async (event, serial, apkPath) => provision.inspectInstall(serial, apkPath));

handle('install:run', async (event, serial, apkPath, opts) =>
  provision.installApp(serial, apkPath, opts || {}, (progress) => {
    if (!event.sender.isDestroyed()) event.sender.send('progress', progress);
  })
);

handle('play:open', async (event, serial, pkg) =>
  provision.openPlay(serial, pkg, (progress) => {
    if (!event.sender.isDestroyed()) event.sender.send('progress', progress);
  })
);

handle('app:launch', async (event, serial, pkg) => adb.launchApp(serial, pkg));

// --- Power ------------------------------------------------------------------

/**
 * Both power actions interrupt whatever the tablet is doing, and powering off
 * cannot be undone from here at all. The confirmation lives in main rather than
 * in the renderer so it cannot be skipped by a stray click path in the UI.
 */
async function confirmPowerAction({ message, detail, confirmLabel }) {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: [confirmLabel, 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Panda Bench',
    message,
    detail,
  });
  return response === 0;
}

handle('device:reboot', async (event, serial) => {
  const confirmed = await confirmPowerAction({
    message: `Reboot ${serial}?`,
    detail:
      'The tablet drops off USB for about a minute while it restarts, then comes back on its own. Do not do this in the middle of a provisioning run.',
    confirmLabel: 'Reboot',
  });
  if (!confirmed) return { confirmed: false, ok: false };
  return { confirmed: true, ...(await adb.rebootDevice(serial)) };
});

handle('device:poweroff', async (event, serial) => {
  const confirmed = await confirmPowerAction({
    message: `Power off ${serial}?`,
    detail:
      'There is no way to turn it back on over USB. Someone has to press the power button on the tablet itself.',
    confirmLabel: 'Power off',
  });
  if (!confirmed) return { confirmed: false, ok: false };
  return { confirmed: true, ...(await adb.powerOffDevice(serial)) };
});

// --- Wallpaper + system update ---------------------------------------------

/** Wallpapers that ship with the app, plus whatever the operator picks. */
handle('wallpaper:list', async () => {
  const dir = app.isPackaged ? path.join(process.resourcesPath, 'wallpapers') : path.join(__dirname, '..', 'build');
  if (!fs.existsSync(dir)) return { dir, wallpapers: [] };
  const wallpapers = fs
    .readdirSync(dir)
    .filter((f) => /^wallpaper-.*\.png$/i.test(f) && !/-preview\.png$/i.test(f))
    .map((f) => ({
      name: f.replace(/^wallpaper-/, '').replace(/\.png$/i, ''),
      path: path.join(dir, f),
      preview: fs.existsSync(path.join(dir, f.replace(/\.png$/i, '-preview.png')))
        ? path.join(dir, f.replace(/\.png$/i, '-preview.png'))
        : path.join(dir, f),
    }));
  return { dir, wallpapers };
});

handle('wallpaper:choose', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a wallpaper image',
    properties: ['openFile'],
    filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return { chosen: null };
  return { chosen: { name: path.basename(result.filePaths[0]), path: result.filePaths[0], preview: result.filePaths[0] } };
});

handle('wallpaper:set', async (event, serial, localPath) =>
  provision.setWallpaper(serial, localPath, (progress) => {
    if (!event.sender.isDestroyed()) event.sender.send('progress', progress);
  })
);

handle('update:open', async (event, serial) =>
  provision.openSystemUpdate(serial, (progress) => {
    if (!event.sender.isDestroyed()) event.sender.send('progress', progress);
  })
);

handle('backups:list', async (event, serial) => provision.listBackups(serial));

handle('state:open', async () => {
  const dir = resolveStateDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  await shell.openPath(dir);
  return { dir };
});

handle('profiles:open', async () => {
  const dir = profiles.profilesDir();
  await shell.openPath(dir);
  return { dir };
});
