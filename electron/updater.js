'use strict';

/**
 * Auto-update for Panda Bench.
 *
 * Two rules shape everything here:
 *
 *   1. An update must never interrupt a tablet. Provisioning is a sequence of
 *      adb commands against hardware sitting on a bench, and swapping the app
 *      out mid-run is exactly the class of problem this tool exists to avoid.
 *      So updates download quietly and are only ever installed when the
 *      operator says so - autoInstallOnAppQuit is deliberately off.
 *
 *   2. Every failure is swallowed. The bench PC is not always online, the feed
 *      may have no release yet, and a private feed needs credentials that may
 *      not be present. None of that should stop anyone provisioning a tablet,
 *      so failures are logged and the app carries on.
 *
 * Only ever runs in a packaged build: in development electron-updater looks for
 * a dev-app-update.yml that does not exist and throws, which reads as a broken
 * app rather than as "there is nothing to update".
 */

const { app, dialog } = require('electron');

function initAutoUpdate(getWindow = () => null) {
  if (!app.isPackaged) return;

  const { autoUpdater } = require('electron-updater');

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('error', (err) => {
    console.error('[updater]', err && err.message ? err.message : err);
  });

  autoUpdater.on('update-downloaded', async (info) => {
    const win = getWindow();
    const { response } = await dialog.showMessageBox(win || undefined, {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `Panda Bench ${info.version} is ready to install.`,
      detail: 'It installs when the app restarts. Finish anything running on a tablet first.',
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });

  autoUpdater.checkForUpdates().catch((err) => {
    console.error('[updater] check failed:', err && err.message ? err.message : err);
  });
}

module.exports = { initAutoUpdate };
