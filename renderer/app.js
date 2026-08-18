'use strict';

/* Panda Bench renderer. No framework on purpose - this is four screens over an
   IPC bridge, and a build step would cost more than it returns.

   Audit and Provision are the same data. Both call bench.preview(), which
   returns an audit AND the exact plan Apply would execute, built by the single
   planner in provision.js. Flipping a toggle re-reads the tablet and both tabs
   move together. Apply then re-reads the device again at execution time, so a
   preview left open for an hour cannot cause a stale write. */

const state = {
  devices: [],
  selected: null,
  report: null,
  plan: null,
  busy: false,
  opts: { aggressive: false, skipSettings: false, skipBloat: false, skipAppTuning: false },
  install: {
    candidates: [],
    selectedApk: null,
    inspect: null,
    aapt2: null,
    wallpapers: [],
    selectedWallpaper: null,
    opts: { grantPermissions: true, tune: true, launch: true },
  },
};

/** Absolute Windows path -> a file:// URL the renderer can load. */
const fileUrl = (p) => `file:///${String(p).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')}`;

/** Months since an Android security patch date, or null if unparseable. */
function patchMonths(date) {
  if (!date) return null;
  const then = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(then.getTime())) return null;
  return Math.floor((Date.now() - then.getTime()) / (1000 * 60 * 60 * 24 * 30.44));
}

/* Which log element progress events land in. Install and Provision each keep
   their own history so an install does not scroll past under the Provision
   tab where nobody is looking. */
let logTarget = 'log';

const $ = (id) => document.getElementById(id);

const esc = (value) =>
  String(value == null ? '' : value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

/** Unwrap the {ok, data} envelope every IPC handler returns. */
async function call(fn, ...args) {
  const res = await fn(...args);
  if (!res || !res.ok) throw new Error(res && res.error ? res.error : 'Unknown error');
  return res.data;
}

// --------------------------------------------------------------------------
// Formatting
// --------------------------------------------------------------------------

function formatBytes(bytes) {
  if (bytes == null) return '-';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

function formatUptime(seconds) {
  if (seconds == null) return '-';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const BUCKETS = { 5: 'exempted', 10: 'active', 20: 'working set', 30: 'frequent', 40: 'rare', 45: 'restricted' };
const bucketName = (n) => (n == null ? 'unknown' : BUCKETS[n] || String(n));

const chip = (text, kind) => `<span class="chip ${kind}">${esc(text)}</span>`;

const tile = (label, value, sub, kind) => `
  <div class="tile ${kind || ''}">
    <div class="tile-label">${esc(label)}</div>
    <div class="tile-value">${esc(value)}</div>
    <div class="tile-sub">${esc(sub)}</div>
  </div>`;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// --------------------------------------------------------------------------
// Tabs
// --------------------------------------------------------------------------

const tabs = [...document.querySelectorAll('[role="tab"]')];

function selectTab(tab) {
  for (const t of tabs) {
    const selected = t === tab;
    t.setAttribute('aria-selected', String(selected));
    t.tabIndex = selected ? 0 : -1;
    $(t.getAttribute('aria-controls')).hidden = !selected;
  }
  tab.focus();
  // Opening Provision with nothing to show reads the tablet rather than
  // presenting an Apply button with no idea what it would do.
  if (tab.id === 'tab-provision' && state.selected && !state.plan && !state.busy) refreshPlan();
  if (tab.id === 'tab-install' && state.selected && !state.busy) {
    refreshInstallView().catch(() => {});
    if (state.install.candidates.length === 0) scanApks().catch(() => {});
    if (state.install.wallpapers.length === 0) loadWallpapers().catch(() => {});
    renderPatchStatus();
    renderWallpaperBlock();
  }
}

for (const tab of tabs) {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (event) => {
    const index = tabs.indexOf(tab);
    let next = null;
    if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
    if (event.key === 'ArrowLeft') next = tabs[(index - 1 + tabs.length) % tabs.length];
    if (event.key === 'Home') next = tabs[0];
    if (event.key === 'End') next = tabs[tabs.length - 1];
    if (next) {
      event.preventDefault();
      selectTab(next);
    }
  });
}

// --------------------------------------------------------------------------
// Option switches - every flip re-plans against the real tablet
// --------------------------------------------------------------------------

for (const sw of document.querySelectorAll('.switch')) {
  sw.addEventListener('click', () => {
    if (state.busy) return;

    // Install-tab switches carry data-iopt and do not touch the provisioning plan.
    const installKey = sw.dataset.iopt;
    if (installKey) {
      state.install.opts[installKey] = !state.install.opts[installKey];
      sw.setAttribute('aria-checked', String(state.install.opts[installKey]));
      return;
    }

    const key = sw.dataset.opt;
    state.opts[key] = !state.opts[key];
    sw.setAttribute('aria-checked', String(state.opts[key]));

    // Aggressive changes which packages are even candidates, so the device has
    // to be re-read. The skip toggles only re-filter what we already know.
    if (key === 'aggressive') refreshPlan();
    else applyPlanFromReport();
  });
}

// --------------------------------------------------------------------------
// Devices
// --------------------------------------------------------------------------

function renderDevices() {
  const host = $('devices');
  if (state.devices.length === 0) {
    host.innerHTML =
      '<p class="empty">No tablet detected.<br />Connect over USB and accept the "Allow USB debugging" prompt on the tablet.</p>';
    return;
  }

  host.innerHTML = state.devices
    .map((d) => {
      const selected = state.selected === d.serial;
      const label = d.model || d.product || d.serial;
      const status = d.usable ? d.serial : `${d.serial} - ${d.state}`;
      return `
        <button class="device ${d.usable ? '' : 'device-unusable'}" role="radio"
                aria-checked="${selected}" data-serial="${esc(d.serial)}"
                ${d.usable ? '' : 'disabled'} type="button">
          <span class="device-name">${esc(label)}</span>
          <span class="device-meta">${esc(status)}</span>
        </button>`;
    })
    .join('');

  for (const el of host.querySelectorAll('.device')) {
    el.addEventListener('click', () => selectDevice(el.dataset.serial));
  }
}

function selectDevice(serial) {
  state.selected = serial;
  state.report = null;
  state.plan = null;

  const device = state.devices.find((d) => d.serial === serial);
  $('deviceTitle').textContent = device ? device.model || device.serial : 'No tablet selected';
  $('deviceSubtitle').textContent = device
    ? `${device.serial}${device.product ? ` · ${device.product}` : ''}`
    : 'Plug a tablet in over USB and accept the debugging prompt on its screen.';

  state.install.inspect = null;
  state.install.selectedApk = null;

  $('auditBody').innerHTML = '<p class="empty">Run an audit to see what is drifted on this tablet.</p>';
  $('discoverBody').innerHTML = '<p class="empty">Run a scan to see what this tablet ships that the profiles do not cover.</p>';
  $('installedApps').innerHTML = '';
  $('installSelected').innerHTML = '';
  renderPlan(null);
  renderDevices();
  setBusy(state.busy);
  loadBackups().catch(() => {});

  // If the operator is already looking at Provision, fill it in immediately.
  const onProvision = $('tab-provision').getAttribute('aria-selected') === 'true';
  if (onProvision) refreshPlan();
}

async function refreshDevices() {
  try {
    const devices = await call(window.bench.listDevices);
    const changed =
      devices.length !== state.devices.length ||
      devices.some(
        (d, i) => !state.devices[i] || state.devices[i].serial !== d.serial || state.devices[i].state !== d.state
      );
    state.devices = devices;
    if (changed) renderDevices();

    if (!state.selected || !devices.some((d) => d.serial === state.selected && d.usable)) {
      const first = devices.find((d) => d.usable);
      if (first) selectDevice(first.serial);
      else if (state.selected) {
        state.selected = null;
        state.report = null;
        state.plan = null;
        $('deviceTitle').textContent = 'No tablet selected';
        renderPlan(null);
        renderDevices();
        setBusy(false);
      }
    }
  } catch {
    // adb missing or unhappy; the footer already says so
  }
}

// --------------------------------------------------------------------------
// Busy state
// --------------------------------------------------------------------------

function setBusy(busy) {
  state.busy = busy;
  const ready = Boolean(state.selected) && !busy;
  $('runAudit').disabled = !ready;
  $('runDiscover').disabled = !ready;
  $('loadBackups').disabled = !ready;
  $('refreshPlan').disabled = !ready;
  $('runApply').disabled = !ready || !state.plan || state.plan.total === 0;

  const chosen = state.install.selectedApk;
  const present = state.install.inspect && state.install.inspect.present;
  $('openPlay').disabled = !ready;
  $('chooseApk').disabled = busy;
  $('rescanApks').disabled = busy;
  $('runInstall').disabled = !ready || !chosen || !chosen.ok;
  $('launchAppBtn').disabled = !ready || !present || present.length === 0;
  const wallpaperLocked = Boolean(
    state.report && state.report.device && state.report.device.management && state.report.device.management.wallpaperBlocked
  );
  $('setWallpaper').disabled = !ready || !state.install.selectedWallpaper || wallpaperLocked;
  $('setWallpaper').textContent = wallpaperLocked ? 'Blocked by device policy' : 'Send to tablet';
  $('chooseWallpaper').disabled = busy;
  $('openUpdate').disabled = !ready;
  $('rebootDevice').disabled = !ready;
  $('powerOffDevice').disabled = !ready;
  $('disableSelected').disabled = !ready || discoverPicked.size === 0;
  $('disableSelected').textContent =
    discoverPicked.size === 0 ? 'Disable selected' : `Disable ${plural(discoverPicked.size, 'package')}`;

  for (const el of document.querySelectorAll('.revert-btn')) el.disabled = !ready;
}

// --------------------------------------------------------------------------
// Plan - what Apply would actually do, read from the tablet
// --------------------------------------------------------------------------

/** Re-read the device and rebuild both the plan and the audit view. */
async function refreshPlan() {
  if (!state.selected || state.busy) return;
  setBusy(true);
  renderPlan('loading');
  try {
    const result = await call(window.bench.preview, state.selected, { ...state.opts });
    state.report = result.report;
    state.plan = result.plan;
    renderPlan({ report: state.report, plan: state.plan });
    renderAudit(state.report);
  } catch (err) {
    state.report = null;
    state.plan = null;
    renderPlan({ error: err.message });
  } finally {
    setBusy(false);
  }
}

/**
 * Re-filter the plan from the report we already have. Used by the skip
 * toggles, which change what we do with what we know rather than what we know,
 * so they do not need another round trip to the tablet.
 */
function applyPlanFromReport() {
  if (!state.report) return;
  const r = state.report;
  const settings = state.opts.skipSettings ? [] : r.settings.filter((s) => !s.ok);
  const packages = state.opts.skipBloat ? [] : r.bloat.filter((b) => !b.disabled && !b.protected).map((b) => b.pkg);
  const apps = state.opts.skipAppTuning ? [] : r.app.filter((a) => !a.dozeExempt || !a.bucketOk || !a.opsOk);
  state.plan = { settings, packages, apps, blocked: r.blocked, total: settings.length + packages.length + apps.length };
  renderPlan({ report: r, plan: state.plan });
  setBusy(state.busy);
}

function renderPlan(planState) {
  const host = $('plan');

  if (!state.selected) {
    host.innerHTML = '<p class="empty">Select a tablet to see exactly what would change.</p>';
    $('runApply').textContent = 'Apply to tablet';
    return;
  }
  if (planState === 'loading') {
    host.innerHTML = '<p class="empty">Reading the tablet...</p>';
    $('runApply').textContent = 'Reading tablet...';
    return;
  }
  if (planState && planState.error) {
    host.innerHTML = `<p class="empty">Could not read the tablet: ${esc(planState.error)}</p>`;
    $('runApply').textContent = 'Apply to tablet';
    return;
  }
  if (!planState) {
    host.innerHTML = '<p class="empty">Re-read the tablet to build a plan.</p>';
    $('runApply').textContent = 'Apply to tablet';
    return;
  }

  const { report, plan } = planState;

  $('runApply').textContent = plan.total === 0 ? 'Nothing to apply' : `Apply ${plural(plan.total, 'change')}`;

  const tiles = `
    <div class="tiles">
      ${tile('Settings', String(plan.settings.length), state.opts.skipSettings ? 'skipped' : 'to change', plan.settings.length ? 'warn' : 'good')}
      ${tile('Packages', String(plan.packages.length), state.opts.skipBloat ? 'skipped' : 'to disable', plan.packages.length ? 'warn' : 'good')}
      ${tile('Order app', String(plan.apps.length), state.opts.skipAppTuning ? 'skipped' : 'fixes needed', plan.apps.length ? 'bad' : 'good')}
      ${tile('Protected', String(plan.blocked.length), 'never touched', 'good')}
    </div>`;

  if (plan.total === 0) {
    host.innerHTML = `${tiles}
      <div class="card">
        <div class="card-head"><h3>Plan</h3><span class="count">nothing to do</span></div>
        <p class="card-note">This tablet already matches the profile${
          state.opts.skipSettings || state.opts.skipBloat || state.opts.skipAppTuning ? ', with the skips you have set' : ''
        }. ${esc(report.device.model || report.device.serial)} is ready to hand over.</p>
      </div>`;
    return;
  }

  const section = (title, items, render, cap = 14) => {
    if (items.length === 0) return '';
    const shown = items.slice(0, cap);
    const more = items.length - shown.length;
    return `
      <div class="plan-group">
        <div class="plan-group-head">${esc(title)} <span class="count">${items.length}</span></div>
        <div class="rows">
          ${shown.map(render).join('')}
          ${more > 0 ? `<div class="row"><span class="row-key plan-more">and ${more} more</span></div>` : ''}
        </div>
      </div>`;
  };

  const settingRow = (s) => `
    <div class="row">
      <span class="row-key">${esc(s.scope)}/${esc(s.key)}</span>
      <span class="row-val">${esc(s.current == null ? 'unset' : s.current)} &rarr; <strong>${esc(s.desired)}</strong></span>
    </div>`;

  const packageRow = (pkg) => `<div class="row"><span class="row-key">${esc(pkg)}</span>${chip('disable', 'warn')}</div>`;

  const appRow = (a) => {
    const missing = [];
    if (!a.dozeExempt) missing.push('doze exemption');
    if (!a.bucketOk) missing.push(`bucket ${bucketName(a.standbyBucket)} &rarr; active`);
    if (!a.opsOk) missing.push('background ops');
    return `<div class="row"><span class="row-key">${esc(a.pkg)}</span><span class="row-val">${missing.join(', ')}</span></div>`;
  };

  host.innerHTML = `${tiles}
    <div class="card">
      <div class="card-head">
        <h3>Plan</h3>
        <span class="count">${esc(report.device.model || report.device.serial)} · ${esc(report.profileSources.join(' + '))}</span>
      </div>
      <div class="card-body">
        ${section('Settings to change', plan.settings, settingRow, 20)}
        ${section('Packages to disable', plan.packages, packageRow)}
        ${section('Order app fixes', plan.apps, appRow)}
      </div>
      <p class="card-note">Nothing is uninstalled - packages are disabled for user 0 and come back with Revert. ${
        plan.blocked.length
      } protected package(s) matched the profile and were excluded.</p>
    </div>`;
}

$('refreshPlan').addEventListener('click', () => refreshPlan());

// --------------------------------------------------------------------------
// Audit
// --------------------------------------------------------------------------

function renderAudit(report) {
  if (!report) return;
  const { device, summary } = report;

  const tiles = `
    <div class="tiles">
      ${tile(
        'Overall',
        summary.clean ? 'Ready' : 'Needs work',
        summary.clean ? 'Matches the profile' : 'See the Provision tab',
        summary.clean ? 'good' : 'warn'
      )}
      ${tile('Settings drift', String(summary.settingsDrift), `of ${summary.settingsTotal} checked`, summary.settingsDrift ? 'warn' : 'good')}
      ${tile('Bloat to disable', String(summary.toDisable), `${summary.bloatPresent} candidates on device`, summary.toDisable ? 'warn' : 'good')}
      ${tile('Order app issues', String(summary.appIssues), summary.appPackages ? `${summary.appPackages} package(s) installed` : 'app not installed', summary.appIssues ? 'bad' : 'good')}
    </div>`;

  const cell = (label, value) => `<div class="info-cell"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;
  const battery = device.battery.level == null ? '-' : `${device.battery.level}%${device.battery.charging ? ' (charging)' : ''}`;
  const ram = device.memory.total == null ? '-' : `${formatBytes(device.memory.available)} free of ${formatBytes(device.memory.total)}`;
  const disk = device.storage.total == null ? '-' : `${formatBytes(device.storage.available)} free of ${formatBytes(device.storage.total)}`;
  const volume = device.mediaVolume.current == null ? '-' : `${device.mediaVolume.current} of ${device.mediaVolume.max}`;
  const brightness =
    device.brightness.current == null
      ? '-'
      : `${device.brightness.current} of ${device.brightness.max} (${Math.round((device.brightness.current / device.brightness.max) * 100)}%)`;

  // Another MDM owning the device outranks everything this tool does, so it is
  // the first thing on the page rather than a footnote.
  const mgmt = device.management || {};
  const managedBanner = mgmt.managed
    ? `<div class="card">
         <div class="card-head"><h3>This tablet is managed by another MDM</h3><span class="count">${esc(mgmt.deviceOwner ? 'device owner' : 'profile owner')}</span></div>
         <div class="alert danger">
           <span class="alert-mark" aria-hidden="true">!</span>
           <span><strong>${esc(mgmt.deviceOwner || mgmt.profileOwner)}</strong> ${
             mgmt.deviceOwner ? 'is the Device Owner' : 'is the Profile Owner'
           }${mgmt.organizationOwned ? ', and the tablet is flagged organization-owned' : ''}.
           It outranks adb: it can re-enable packages Panda Bench disables and re-impose settings at its next sync,
           and it cannot be removed with adb - <code>dpm remove-active-admin</code>, <code>pm uninstall</code> and
           <code>pm disable-user</code> are all refused.
           A factory reset DOES clear a Device Owner${
             mgmt.factoryResetBlocked ? ', but this MDM has blocked factory reset on the device' : ' and is not blocked here'
           }. The cleanest route is to unenrol from the MDM console.
           ${
             mgmt.knoxEnrollment
               ? 'The Samsung Knox enrolment client is present. That client ships on every Samsung enterprise device, so it is NOT proof of enrolment - but if this tablet IS registered in a Knox Mobile Enrollment account it will re-enrol itself during setup after a wipe, and only the account holder who sold it can release it. You find out by resetting and watching the setup wizard.'
               : ''
           }
           Anything Panda Bench changes here should be treated as provisional.</span>
         </div>
       </div>`
    : '';

  const info = `
    ${managedBanner}
    <div class="card">
      <div class="card-head"><h3>Device</h3><span class="count">${esc(report.profileSources.join(' + '))}</span></div>
      <dl class="info-grid">
        ${cell('Model', `${device.manufacturer} ${device.model}`.trim() || '-')}
        ${cell('Android', device.androidRelease ? `${device.androidRelease} (SDK ${device.sdk})` : '-')}
        ${cell('Build', device.buildId || '-')}
        ${cell(
          'Security patch',
          device.securityPatch
            ? `${device.securityPatch}${patchMonths(device.securityPatch) != null ? ` (${patchMonths(device.securityPatch)} mo old)` : ''}`
            : '-'
        )}
        ${cell('Serial', device.serial)}
        ${cell('Battery', battery)}
        ${cell('Uptime', formatUptime(device.uptime))}
        ${cell('Memory', ram)}
        ${cell('Storage', disk)}
        ${cell('Media volume', volume)}
        ${cell('Screen brightness', brightness)}
        ${cell('Packages', `${device.packageCount} installed, ${device.disabledCount} disabled`)}
        ${cell('Keyboard', device.ime || 'unknown')}
        ${cell('Launcher', device.launcher || 'unknown')}
        ${cell(
          'Google account',
          device.accounts
            ? device.accounts.hasGoogle
              ? `signed in (${device.accounts.googleCount || device.accounts.count})`
              : 'none'
            : 'unknown'
        )}
      </dl>
      ${
        device.accounts && !device.accounts.hasGoogle
          ? `<div class="alert"><span class="alert-mark" aria-hidden="true">!</span><span>No Google account is signed in, so Google Play cannot install or update anything on this tablet. The order app will only ever change when you sideload a new build over USB. Sign in an account during setup if you want it to keep itself up to date.</span></div>`
          : ''
      }
    </div>`;

  let appCard;
  if (report.app.length === 0) {
    appCard = `
      <div class="card">
        <div class="card-head"><h3>Order app</h3><span class="count">not installed</span></div>
        <p class="card-note">No com.pandaeats.ordertaking package on this tablet. Install it from Play and pair it before provisioning, or provision now and tune the app later.</p>
      </div>`;
  } else {
    const rows = report.app
      .map((a) => {
        const chips = [
          a.enabled === false ? chip('disabled', 'bad') : chip('enabled', 'ok'),
          a.dozeExempt ? chip('doze exempt', 'ok') : chip('not doze exempt', 'bad'),
          a.bucketOk ? chip(`bucket ${bucketName(a.standbyBucket)}`, 'ok') : chip(`bucket ${bucketName(a.standbyBucket)}`, 'bad'),
          a.opsOk ? chip('background ok', 'ok') : chip('background limited', 'bad'),
        ].join('');
        const version = a.versionName ? `v${a.versionName}${a.versionCode ? ` (${a.versionCode})` : ''}` : 'version unknown';
        return `<div class="row">
            <span class="row-key">${esc(a.pkg)}</span>
            <span class="chip-row">${chips}</span>
            <span class="row-val"><strong>${esc(version)}</strong></span>
          </div>`;
      })
      .join('');
    appCard = `
      <div class="card">
        <div class="card-head"><h3>Order app</h3><span class="count">${report.app.length} package(s)</span></div>
        <div class="rows">${rows}</div>
        <p class="card-note">Versions are read from an exact-matched dumpsys block, so the .staging and .dev builds cannot be mistaken for the paired production app.</p>
      </div>`;
  }

  const drifted = report.settings.filter((s) => !s.ok);
  const settingRows = [...drifted, ...report.settings.filter((s) => s.ok)]
    .map(
      (s) => `<div class="row">
        <span class="row-key">${esc(s.scope)}/${esc(s.key)}</span>
        ${s.ok ? chip('ok', 'ok') : chip('drift', 'warn')}
        <span class="row-val">${esc(s.current == null ? 'unset' : s.current)} &rarr; <strong>${esc(s.desired)}</strong></span>
      </div>`
    )
    .join('');

  const settingsCard = `
    <div class="card">
      <div class="card-head"><h3>Settings</h3><span class="count">${drifted.length} drifted of ${report.settings.length}</span></div>
      <div class="rows">${settingRows}</div>
    </div>`;

  const toDisable = report.bloat.filter((b) => !b.disabled && !b.protected);
  const alreadyOff = report.bloat.filter((b) => b.disabled);
  const blocked = report.bloat.filter((b) => b.protected);

  const bloatRows = [
    ...toDisable.map((b) => ({
      b,
      badge: chip(b.tier === 'aggressive' ? 'aggressive' : 'will disable', b.tier === 'aggressive' ? 'info' : 'warn'),
    })),
    ...blocked.map((b) => ({ b, badge: chip(`protected: ${b.protectedReason}`, 'bad') })),
    ...alreadyOff.map((b) => ({ b, badge: chip('already off', 'muted') })),
  ]
    .map(({ b, badge }) => `<div class="row"><span class="row-key">${esc(b.pkg)}</span>${badge}</div>`)
    .join('');

  const held = report.aggressiveHeld.length
    ? `<p class="card-note">${report.aggressiveHeld.length} further package(s) are held back by the aggressive tier. Turn on Aggressive in Provision to include them.</p>`
    : '';

  const bloatCard = `
    <div class="card">
      <div class="card-head"><h3>Bloat</h3><span class="count">${toDisable.length} to disable · ${alreadyOff.length} already off · ${blocked.length} protected</span></div>
      <div class="rows">${bloatRows || '<div class="row"><span class="row-key">Nothing from the profile is present on this device.</span></div>'}</div>
      ${held}
    </div>`;

  $('auditBody').innerHTML = tiles + info + appCard + settingsCard + bloatCard;
  renderPatchStatus();
  renderWallpaperBlock();
  setBusy(state.busy);
}

$('runAudit').addEventListener('click', () => refreshPlan());

// --------------------------------------------------------------------------
// Provision
// --------------------------------------------------------------------------

const BADGES = { ok: '✓', warn: '!', error: '✗', info: '·', done: '✓' };

function logLine({ level, message }) {
  const host = $(logTarget);
  const placeholder = host.querySelector('.empty');
  if (placeholder) placeholder.remove();
  const div = document.createElement('div');
  div.className = `log-line log-${level}`;
  div.innerHTML = `<span class="log-badge">${BADGES[level] || '·'}</span><span class="log-msg">${esc(message)}</span>`;
  host.appendChild(div);
  host.scrollTop = host.scrollHeight;
}

window.bench.onProgress(logLine);

$('clearLog').addEventListener('click', () => {
  $('log').innerHTML = '<p class="empty">Nothing run yet.</p>';
});

$('runApply').addEventListener('click', async () => {
  if (!state.selected || !state.plan || state.plan.total === 0) return;
  logTarget = 'log';
  setBusy(true);
  try {
    await call(window.bench.apply, state.selected, { ...state.opts });
    await loadBackups();
  } catch (err) {
    logLine({ level: 'error', message: err.message });
  } finally {
    setBusy(false);
  }
  // Re-read the tablet so the plan and the audit both show the result rather
  // than what was true before the run.
  await refreshPlan();
});

// --------------------------------------------------------------------------
// Install
// --------------------------------------------------------------------------

const formatMb = (bytes) => (bytes == null ? '?' : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/** Re-read what is on the tablet and how the chosen APK relates to it. */
async function refreshInstallView() {
  if (!state.selected) {
    $('installedApps').innerHTML = '';
    $('installSelected').innerHTML = '';
    return;
  }
  const chosen = state.install.selectedApk;
  const data = await call(
    window.bench.inspectInstall,
    state.selected,
    chosen && chosen.ok ? chosen.path : null
  );
  state.install.inspect = data;
  renderInstalledApps(data);
  renderSelectedApk(data);
  setBusy(state.busy);
}

function renderInstalledApps(data) {
  const rows = data.present
    .map(
      (p) => `<div class="row">
        <span class="row-key">${esc(p.pkg)}</span>
        ${p.enabled === false ? chip('disabled', 'bad') : chip('enabled', 'ok')}
        <span class="row-val"><strong>v${esc(p.versionName || '?')}</strong> (${esc(p.versionCode || '?')})</span>
      </div>`
    )
    .join('');

  $('installedApps').innerHTML = `
    <div class="card">
      <div class="card-head"><h3>On the tablet now</h3><span class="count">${data.present.length} Panda Eats package(s)</span></div>
      ${
        data.present.length
          ? `<div class="rows">${rows}</div>`
          : '<p class="card-note">No Panda Eats app is installed on this tablet yet.</p>'
      }
    </div>`;
}

function renderApkCandidates() {
  const host = $('apkCandidates');
  const { candidates, aapt2 } = state.install;

  $('aapt2Status').textContent = aapt2 ? 'aapt2 found' : 'aapt2 missing - details unavailable';

  if (candidates.length === 0) {
    host.innerHTML =
      '<div class="row"><span class="row-key">No APKs found in the order-app build output or your Downloads folder. Use "Choose an APK..." to point at one.</span></div>';
    return;
  }

  host.innerHTML = candidates
    .map((c, i) => {
      const selected = state.install.selectedApk && state.install.selectedApk.path === c.path;
      const title = c.ok ? c.applicationId : 'Unreadable APK';
      const ver = c.ok ? `v${c.versionName || '?'} (${c.versionCode || '?'}) · ${formatMb(c.sizeBytes)}` : c.error || '';
      const tier = c.flavor && c.flavor !== 'unknown' ? chip(c.flavor, c.flavor === 'prod' ? 'warn' : 'info') : '';
      return `<button class="apk-row" role="radio" aria-checked="${selected}" data-index="${i}" type="button">
          <span class="apk-row-top">
            <span class="apk-id">${esc(title)}</span>${tier}
            <span class="apk-ver">${esc(ver)}</span>
          </span>
          <span class="apk-path">${esc(c.path)}</span>
        </button>`;
    })
    .join('');

  for (const btn of host.querySelectorAll('.apk-row')) {
    btn.addEventListener('click', async () => {
      state.install.selectedApk = state.install.candidates[Number(btn.dataset.index)];
      renderApkCandidates();
      await refreshInstallView();
    });
  }
}

function renderSelectedApk(data) {
  const host = $('installSelected');
  const c = data.candidate;
  if (!c) {
    host.innerHTML = '';
    return;
  }
  if (!c.ok) {
    host.innerHTML = `<div class="card"><div class="card-head"><h3>Selected APK</h3></div>
      <p class="card-note">${esc(c.error || 'Could not read this file.')}</p></div>`;
    return;
  }

  const alert = data.warning
    ? `<div class="alert ${c.replacesPlayBuild && data.existing ? 'danger' : ''}">
         <span class="alert-mark" aria-hidden="true">!</span><span>${esc(data.warning)}</span>
       </div>`
    : '';

  const cell = (label, value) => `<div class="info-cell"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;

  host.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h3>Selected APK</h3>
        <span class="count">${esc(c.flavor)} flavour</span>
      </div>
      ${alert}
      <dl class="info-grid">
        ${cell('Application id', c.applicationId)}
        ${cell('Version', `${c.versionName || '?'} (${c.versionCode || '?'})`)}
        ${cell('Label', c.label || '-')}
        ${cell('Min SDK', c.minSdk || '-')}
        ${cell('Size', formatMb(c.sizeBytes))}
        ${cell('Installed now', data.existing ? `v${data.existing.versionName || '?'} (${data.existing.versionCode || '?'})` : 'not installed')}
        ${cell('Signed', c.signature && c.signature.known ? (c.signature.debugSigned ? 'debug key' : 'release key') : 'unknown')}
      </dl>
      ${
        c.signature && c.signature.known && c.signature.debugSigned
          ? `<div class="alert"><span class="alert-mark" aria-hidden="true">!</span><span>${esc(c.signature.note)}</span></div>`
          : ''
      }
      <p class="card-note">${esc(c.note)}${
        c.signature && c.signature.known && !c.signature.debugSigned ? ` ${esc(c.signature.note)}` : ''
      }</p>
    </div>`;
}

$('openPlay').addEventListener('click', async () => {
  if (!state.selected) return;
  logTarget = 'installLog';
  setBusy(true);
  try {
    await call(window.bench.openPlay, state.selected, null);
  } catch (err) {
    logLine({ level: 'error', message: err.message });
  } finally {
    setBusy(false);
  }
});

$('chooseApk').addEventListener('click', async () => {
  try {
    const result = await call(window.bench.chooseApk);
    if (!result.chosen) return;
    // Put the hand-picked file at the top of the list so it is obviously selected.
    state.install.selectedApk = result.chosen;
    if (!state.install.candidates.some((c) => c.path === result.chosen.path)) {
      state.install.candidates.unshift({ ...result.chosen, mtime: Date.now() });
    }
    renderApkCandidates();
    await refreshInstallView();
  } catch (err) {
    logTarget = 'installLog';
    logLine({ level: 'error', message: err.message });
  }
});

$('rescanApks').addEventListener('click', () => scanApks().catch(() => {}));

async function scanApks() {
  const res = await call(window.bench.scanApks);
  state.install.candidates = res.candidates;
  state.install.aapt2 = res.aapt2;
  renderApkCandidates();
}

$('runInstall').addEventListener('click', async () => {
  const chosen = state.install.selectedApk;
  if (!state.selected || !chosen || !chosen.ok) return;
  logTarget = 'installLog';
  setBusy(true);
  try {
    await call(window.bench.install, state.selected, chosen.path, { ...state.install.opts });
  } catch (err) {
    logLine({ level: 'error', message: err.message });
  } finally {
    setBusy(false);
  }
  await refreshInstallView();
  // A new app changes the provisioning picture, so drop the stale plan.
  state.report = null;
  state.plan = null;
  renderPlan(null);
});

$('launchAppBtn').addEventListener('click', async () => {
  const present = state.install.inspect && state.install.inspect.present;
  if (!state.selected || !present || present.length === 0) return;
  logTarget = 'installLog';
  setBusy(true);
  try {
    const r = await call(window.bench.launchApp, state.selected, present[0].pkg);
    logLine({ level: r.ok ? 'ok' : 'warn', message: r.ok ? `Launched ${present[0].pkg}` : 'Could not launch the app.' });
  } catch (err) {
    logLine({ level: 'error', message: err.message });
  } finally {
    setBusy(false);
  }
});

$('clearInstallLog').addEventListener('click', () => {
  $('installLog').innerHTML = '<p class="empty">Nothing run yet.</p>';
});

// --- Wallpaper -------------------------------------------------------------

async function loadWallpapers() {
  const res = await call(window.bench.listWallpapers);
  state.install.wallpapers = res.wallpapers;
  if (!state.install.selectedWallpaper && res.wallpapers.length) {
    state.install.selectedWallpaper = res.wallpapers[0];
  }
  renderWallpapers();
}

function renderWallpapers() {
  const host = $('wallpapers');
  const list = state.install.wallpapers;
  if (list.length === 0) {
    host.innerHTML = '<p class="empty">No wallpapers bundled. Use "Use my own image..." to pick one.</p>';
    setBusy(state.busy);
    return;
  }
  host.innerHTML = list
    .map((w, i) => {
      const selected = state.install.selectedWallpaper && state.install.selectedWallpaper.path === w.path;
      return `<button class="wallpaper" role="radio" aria-checked="${selected}" data-index="${i}" type="button">
          <img src="${esc(fileUrl(w.preview))}" alt="" />
          <span class="wallpaper-name">${esc(w.name)}</span>
        </button>`;
    })
    .join('');
  for (const btn of host.querySelectorAll('.wallpaper')) {
    btn.addEventListener('click', () => {
      state.install.selectedWallpaper = state.install.wallpapers[Number(btn.dataset.index)];
      renderWallpapers();
    });
  }
  setBusy(state.busy);
}

$('chooseWallpaper').addEventListener('click', async () => {
  try {
    const res = await call(window.bench.chooseWallpaper);
    if (!res.chosen) return;
    if (!state.install.wallpapers.some((w) => w.path === res.chosen.path)) {
      state.install.wallpapers.unshift(res.chosen);
    }
    state.install.selectedWallpaper = res.chosen;
    renderWallpapers();
  } catch {
    /* cancelled */
  }
});

$('setWallpaper').addEventListener('click', async () => {
  const chosen = state.install.selectedWallpaper;
  if (!state.selected || !chosen) return;
  logTarget = 'installLog';
  setBusy(true);
  try {
    await call(window.bench.setWallpaper, state.selected, chosen.path);
  } catch (err) {
    logLine({ level: 'error', message: err.message });
  } finally {
    setBusy(false);
  }
});

// --- System update ---------------------------------------------------------

/**
 * Say up front when an MDM has locked the wallpaper, rather than letting the
 * operator push an image that Android will silently discard.
 */
function renderWallpaperBlock() {
  const host = $('wallpaperBlocked');
  const mgmt = state.report && state.report.device && state.report.device.management;
  if (!mgmt || !mgmt.wallpaperBlocked) {
    host.innerHTML = '';
    return;
  }
  host.innerHTML = `<div class="alert danger">
      <span class="alert-mark" aria-hidden="true">!</span>
      <span>Wallpaper changes are blocked on this tablet. <strong>${esc(mgmt.deviceOwner || 'An MDM')}</strong>
      has set the <code>DISALLOW_SET_WALLPAPER</code> restriction, which is why the chooser opens, the tap
      looks like it worked, and nothing changes. Only the device owner can lift it. Sending is disabled
      until the MDM is removed.</span>
    </div>`;
}

function renderPatchStatus() {
  const el = $('patchStatus');
  const patch = state.report && state.report.device && state.report.device.securityPatch;
  if (!patch) {
    el.textContent = 'run an audit to see the patch level';
    return;
  }
  const months = patchMonths(patch);
  el.textContent = months == null ? patch : `patched ${patch}, about ${months} month(s) old`;
  el.style.color = months != null && months >= 6 ? 'var(--amber)' : '';
}

$('openUpdate').addEventListener('click', async () => {
  if (!state.selected) return;
  logTarget = 'installLog';
  setBusy(true);
  try {
    await call(window.bench.openSystemUpdate, state.selected);
  } catch (err) {
    logLine({ level: 'error', message: err.message });
  } finally {
    setBusy(false);
  }
});

// --- Power -----------------------------------------------------------------

/**
 * Both actions take the tablet off adb, so the device list is re-read
 * afterwards rather than left showing a serial that is no longer there.
 *
 * The audit and plan are thrown away explicitly rather than left to
 * refreshDevices() to clear. `adb reboot` returns the instant the command is
 * accepted, well before the tablet actually goes away, so a re-read taken
 * immediately afterwards can still list it as usable and keep it selected -
 * with an audit describing a device that is now restarting. Apply builds from
 * that picture, and firing a run at a tablet mid-restart is the exact failure
 * this app already had to be taught to stop doing.
 */
async function powerAction(fn, verb) {
  if (!state.selected) return;
  logTarget = 'installLog';
  setBusy(true);
  let acted = false;
  try {
    const r = await call(fn, state.selected);
    if (!r.confirmed) return;
    acted = true;
    logLine({
      level: r.ok ? 'ok' : 'warn',
      message: r.ok ? `${verb} ${state.selected}` : `Could not ${verb.toLowerCase()} the tablet. ${r.stderr || ''}`.trim(),
    });
  } catch (err) {
    logLine({ level: 'error', message: err.message });
  } finally {
    setBusy(false);
  }

  if (acted) {
    state.report = null;
    state.plan = null;
    renderPlan(null);
    setBusy(false);
  }
  await refreshDevices();
}

$('rebootDevice').addEventListener('click', () => powerAction(window.bench.rebootDevice, 'Rebooting'));
$('powerOffDevice').addEventListener('click', () => powerAction(window.bench.powerOffDevice, 'Powering off'));

// --------------------------------------------------------------------------
// Discover
// --------------------------------------------------------------------------

/** Packages the operator has ticked for disabling on THIS tablet. */
const discoverPicked = new Set();

function renderDiscover(result) {
  const rows = (list, emptyText) => {
    if (list.length === 0) return `<div class="row"><span class="row-key">${esc(emptyText)}</span></div>`;
    return list
      .map((p) => {
        if (p.disabled) {
          return `<div class="row"><span class="row-key">${esc(p.pkg)}</span>${chip('already off', 'muted')}</div>`;
        }
        const picked = discoverPicked.has(p.pkg);
        return `<button class="pick-row" role="checkbox" aria-checked="${picked}" data-pkg="${esc(p.pkg)}" type="button">
            <span class="pick-box" aria-hidden="true"></span>
            <span class="row-key">${esc(p.pkg)}</span>
          </button>`;
      })
      .join('');
  };

  $('discoverBody').innerHTML = `
    <div class="card">
      <div class="card-head">
        <h3>Installed by someone</h3>
        <span class="count">${result.counts.sideloaded}</span>
      </div>
      <div class="rows">${rows(result.sideloaded, 'Nothing sideloaded.')}</div>
      <p class="card-note">Third-party apps that are not ours: carrier junk, whatever a previous owner left behind, anything staff installed. Ticking these disables them on this tablet only - nothing is written to a profile, because these are one-tablet decisions.</p>
    </div>
    <div class="card">
      <div class="card-head">
        <h3>System packages not in any profile</h3>
        <span class="count">${result.counts.unknown} of ${result.counts.system}</span>
      </div>
      <div class="rows">${rows(result.unknown, 'Nothing uncovered.')}</div>
      <p class="card-note">Protected packages and everything already in ${esc(result.profileSources.join(' + '))} are filtered out. Anything here you recognise as junk on every tablet of this make belongs in profiles/bloat/${esc(result.manufacturer.toLowerCase() || 'common')}.txt rather than ticked one device at a time.</p>
    </div>`;

  for (const btn of $('discoverBody').querySelectorAll('.pick-row')) {
    btn.addEventListener('click', () => {
      const pkg = btn.dataset.pkg;
      if (discoverPicked.has(pkg)) discoverPicked.delete(pkg);
      else discoverPicked.add(pkg);
      btn.setAttribute('aria-checked', String(discoverPicked.has(pkg)));
      setBusy(state.busy);
    });
  }
  setBusy(state.busy);
}

$('runDiscover').addEventListener('click', async () => {
  if (!state.selected) return;
  setBusy(true);
  $('discoverBody').innerHTML = '<p class="empty">Scanning...</p>';
  try {
    state.discoverResult = await call(window.bench.discover, state.selected);
    renderDiscover(state.discoverResult);
  } catch (err) {
    $('discoverBody').innerHTML = `<p class="empty">Scan failed: ${esc(err.message)}</p>`;
  } finally {
    setBusy(false);
  }
});

$('disableSelected').addEventListener('click', async () => {
  if (!state.selected || discoverPicked.size === 0) return;
  logTarget = 'discoverLog';
  setBusy(true);
  try {
    await call(window.bench.disablePackages, state.selected, [...discoverPicked]);
    discoverPicked.clear();
    state.discoverResult = await call(window.bench.discover, state.selected);
    renderDiscover(state.discoverResult);
    await loadBackups();
  } catch (err) {
    logLine({ level: 'error', message: err.message });
  } finally {
    setBusy(false);
  }
  // The tablet changed, so the provisioning plan is stale.
  state.report = null;
  state.plan = null;
  renderPlan(null);
});

// --------------------------------------------------------------------------
// Rollback
// --------------------------------------------------------------------------

async function loadBackups() {
  if (!state.selected) return;
  const backups = await call(window.bench.listBackups, state.selected);
  if (backups.length === 0) {
    $('rollbackBody').innerHTML = '<p class="empty">No rollback points for this tablet yet. One is written every time you apply.</p>';
    return;
  }
  $('rollbackBody').innerHTML = `
    <div class="card">
      <div class="card-head"><h3>Rollback points</h3><span class="count">${backups.length}</span></div>
      <div class="rows">
        ${backups
          .map((b) => {
            const when = b.timestamp ? new Date(b.timestamp).toLocaleString('en-US') : b.name;
            const detail = `${b.settings} setting(s), ${b.packages} package(s)${b.aggressive ? ', aggressive' : ''}`;
            return `<div class="row">
                <span class="row-key">${esc(when)}</span>
                <span class="row-val">${esc(detail)}</span>
                <button class="ghost-btn revert-btn" data-file="${esc(b.file)}" type="button">Revert to this</button>
              </div>`;
          })
          .join('')}
      </div>
      <p class="card-note">Reverting restores every setting to the value it held before that run, re-enables every package that run disabled, and undoes the order-app background tuning.</p>
    </div>`;

  for (const btn of $('rollbackBody').querySelectorAll('.revert-btn')) {
    btn.addEventListener('click', async () => {
      logTarget = 'log';
      setBusy(true);
      selectTab($('tab-provision'));
      try {
        await call(window.bench.revert, state.selected, btn.dataset.file);
      } catch (err) {
        logLine({ level: 'error', message: err.message });
      } finally {
        setBusy(false);
      }
      await refreshPlan();
    });
  }
}

$('loadBackups').addEventListener('click', () => loadBackups().catch(() => {}));
$('openState').addEventListener('click', () => window.bench.openStateFolder());
$('openProfiles').addEventListener('click', () => window.bench.openProfilesFolder());
$('refresh').addEventListener('click', () => refreshDevices());

$('locateAdb').addEventListener('click', async () => {
  try {
    const result = await call(window.bench.locateAdb);
    if (result.changed) {
      await showAdbStatus();
      await refreshDevices();
    }
  } catch {
    /* dialog cancelled */
  }
});

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------

async function showAdbStatus() {
  try {
    const info = await call(window.bench.adbInfo);
    $('adbPath').textContent = info.found ? info.path : 'adb not found - click Locate adb';
    $('adbDot').className = `adb-dot ${info.found ? 'ok' : 'bad'}`;
  } catch (err) {
    $('adbPath').textContent = err.message;
    $('adbDot').className = 'adb-dot bad';
  }
}

showAdbStatus();
refreshDevices();
setInterval(refreshDevices, 4000);
