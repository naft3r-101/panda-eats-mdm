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
 * The checking itself only ever happens in a packaged build: in development
 * electron-updater looks for a dev-app-update.yml that does not exist and
 * throws, which reads as a broken app rather than as "there is nothing to
 * update". The operator can still ask, and gets told why it is off.
 *
 * Everything the operator sees is drawn by the renderer, not by a native
 * dialog: one popup that follows the check from "looking" through "ready to
 * install", so a manual check and a background one land in the same place.
 */

const { app } = require('electron');

let autoUpdater = null;
let getWindow = () => null;

/**
 * The last thing the updater knew. A window that opens after a check, or one
 * that missed the push, asks for this rather than starting a second check.
 */
let status = { state: 'idle', current: '' };

/** Why the updater is not going to do anything, or null if it will. */
function disabledReason() {
  if (!app.isPackaged) return 'Updates only run in an installed build. This window is running from source.';
  return null;
}

function setStatus(next) {
  status = { current: app.getVersion(), ...next };
  const win = getWindow();
  if (win && !win.isDestroyed()) win.webContents.send('selfupdate:status', status);
}

const message = (err) => (err && err.message ? err.message : String(err));

/** Release notes as plain text - the feed hands them over as HTML. */
function plainNotes(info) {
  const raw = Array.isArray(info && info.releaseNotes)
    ? info.releaseNotes.map((n) => (n && n.note) || '').join('\n\n')
    : (info && info.releaseNotes) || '';
  return String(raw)
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) =>
      ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' })[m]
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 700);
}

/**
 * The feed is the repo's public releases, so the check needs no credential at
 * all and a fresh bench PC self-updates out of the box. That was not always
 * true: the repo was private to begin with, every bench needed a token, and in
 * practice none of them had one.
 *
 * PANDA_BENCH_UPDATE_TOKEN is still honoured for the day the repo goes private
 * again, or for a rate-limited network. It is read from our own variable
 * rather than GH_TOKEN because GH_TOKEN is what the gh CLI reads, and gh
 * prefers it over its own keyring login - a machine-wide GH_TOKEN scoped to
 * this one repo would silently break every other gh command on the bench PC.
 * So it is copied onto GH_TOKEN inside this process only, where nothing else
 * sees it.
 */
function loadUpdater() {
  if (autoUpdater) return autoUpdater;
  if (process.env.PANDA_BENCH_UPDATE_TOKEN) process.env.GH_TOKEN = process.env.PANDA_BENCH_UPDATE_TOKEN;

  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('error', (err) => {
    console.error('[updater]', message(err));
    setStatus({ state: 'error', message: message(err) });
  });
  autoUpdater.on('update-available', (info) => {
    setStatus({ state: 'available', version: info.version, notes: plainNotes(info) });
  });
  autoUpdater.on('update-not-available', () => {
    setStatus({ state: 'current' });
  });
  autoUpdater.on('download-progress', (p) => {
    setStatus({ state: 'downloading', version: status.version, notes: status.notes, percent: Math.round(p.percent || 0) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    setStatus({ state: 'downloaded', version: info.version, notes: plainNotes(info) });
  });

  return autoUpdater;
}

/**
 * Ask the feed. Resolves once the answer is known - the download that may
 * follow carries on in the background and reports itself through the pushes.
 */
async function checkForUpdates() {
  const reason = disabledReason();
  if (reason) {
    setStatus({ state: 'disabled', reason });
    return status;
  }
  setStatus({ state: 'checking' });
  try {
    await loadUpdater().checkForUpdates();
  } catch (err) {
    console.error('[updater] check failed:', message(err));
    setStatus({ state: 'error', message: message(err) });
  }
  return status;
}

/** Only ever reached by the operator pressing the button in the popup. */
function installUpdate() {
  if (!autoUpdater || status.state !== 'downloaded') return { restarting: false };
  autoUpdater.quitAndInstall();
  return { restarting: true };
}

function currentStatus() {
  return status;
}

function initAutoUpdate(getWin = () => null) {
  getWindow = getWin;
  const reason = disabledReason();
  if (reason) {
    console.log(`[updater] ${reason}`);
    setStatus({ state: 'disabled', reason });
    return;
  }
  checkForUpdates();
}

module.exports = { initAutoUpdate, checkForUpdates, installUpdate, currentStatus };
