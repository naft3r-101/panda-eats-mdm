'use strict';

/* Panda Bench renderer. No framework on purpose - this is four screens over an
   IPC bridge, and a build step would cost more than it returns.

   The audit and the plan are the same data, on the same tab. One call to
   bench.preview() returns the audit AND the exact plan Apply would execute,
   built by the single planner in provision.js; the plan sits above the Apply
   button and the audit detail below its log. Apply then re-reads the device
   again at execution time, so a preview left open for an hour cannot cause a
   stale write. */

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
  verify: {
    report: null,
    /** The per-tablet checklist and printer address, from state/handover/. */
    handover: null,
  },
};

/** Runtime permissions Apply grants, keyed to how they read on screen. */
const PERMISSION_LABELS = {
  'android.permission.POST_NOTIFICATIONS': 'notifications',
  'android.permission.BLUETOOTH_CONNECT': 'Bluetooth',
};

const deniedPermissions = (a) =>
  Object.entries(a.permissions || {})
    .filter(([, granted]) => granted === false)
    .map(([permission]) => PERMISSION_LABELS[permission] || permission);

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
  // Same rule for Verify: opening it with nothing to show reads the tablet.
  if (tab.id === 'tab-verify' && state.selected && !state.busy) {
    if (!state.verify.handover) loadHandover().catch(() => {});
    if (!state.verify.report) runVerify();
  }
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
  state.verify.report = null;
  state.verify.handover = null;

  $('managedBanner').innerHTML = '';
  $('auditBody').innerHTML = '<p class="empty">Reading the tablet...</p>';
  $('discoverBody').innerHTML = '<p class="empty">Run a scan to see what this tablet ships that the profiles do not cover.</p>';
  $('verifyBody').innerHTML = '<p class="empty">Check readiness to see whether this tablet can take an order right now.</p>';
  $('checklistBody').innerHTML = '';
  $('installedApps').innerHTML = '';
  $('installSelected').innerHTML = '';
  renderPlan(null);
  renderDevices();
  setBusy(state.busy);
  loadBackups().catch(() => {});
  loadHandover().catch(() => {});
  showDrift(serial);

  // If the operator is already looking at Provision or Verify, fill it in immediately.
  const onProvision = $('tab-provision').getAttribute('aria-selected') === 'true';
  if (onProvision) refreshPlan();
  const onVerify = $('tab-verify').getAttribute('aria-selected') === 'true';
  if (onVerify) runVerify();
}

/** "9/15/2026" in the operator's own format. */
const shortDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US') : null);

/**
 * The counter-readiness check, run whenever a tablet is selected - which
 * includes the moment one is plugged in, because refreshDevices() selects the
 * first usable device on its own.
 *
 * Deliberately not the audit: three adb reads, so plugging a tablet in stays
 * instant. It exists for the tablet that comes back from a counter already
 * provisioned, where nobody would think to run an audit at all.
 */
async function showDrift(serial) {
  const chipEl = $('driftChip');
  const recordEl = $('recordChip');
  chipEl.hidden = true;
  recordEl.hidden = true;
  try {
    const drift = await call(window.bench.driftCheck, serial);
    // The operator may have clicked another tablet while this was reading.
    if (state.selected !== serial) return;

    // What the tablet says about itself. A tablet with no record has never
    // been through this tool, which is worth knowing before anything else.
    const record = drift.record;
    if (record && record.provisionedAt) {
      const stale = record.profile && drift.profile && record.profile !== drift.profile;
      recordEl.textContent = `Provisioned ${shortDate(record.provisionedAt)}${
        record.benchVersion ? ` with v${record.benchVersion}` : ''
      }${record.shippedAt ? `, shipped ${shortDate(record.shippedAt)}` : ''}${stale ? ' - profile has changed since' : ''}`;
    } else {
      recordEl.textContent = 'Never provisioned by Panda Bench';
    }
    recordEl.hidden = false;

    const problems = [];
    if (!drift.brightnessOk) problems.push(`screen at ${drift.percent}%`);
    if (drift.adaptiveOn) problems.push('adaptive brightness on');
    if (!drift.volumeOk) problems.push(`media volume ${drift.mediaVolume.current} of ${drift.mediaVolume.max}`);
    if (problems.length === 0) return;

    chipEl.textContent = `Not counter-ready: ${problems.join(', ')}. Apply fixes it.`;
    chipEl.hidden = false;
  } catch {
    // A tablet that cannot answer three reads has a bigger problem than a dim
    // screen, and the device list and adb footer already say so.
  }
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

  $('runVerify').disabled = !ready;
  $('printerHost').disabled = !state.selected || busy;
  $('printSlip').disabled = !ready || !$('printerHost').value.trim();
  const verified = state.verify.report;
  $('launchFromVerify').disabled = !ready || !verified || verified.apps.length === 0;
  $('shipDevice').disabled = !ready || !verified;

  for (const el of document.querySelectorAll('.revert-btn')) el.disabled = !ready;
  for (const el of document.querySelectorAll('.pick-row.check')) el.disabled = busy || !state.selected;

  // An update that arrived mid-run waits for the run, and Restart stays out of
  // reach until the tablet is done with us.
  renderUpdate();
  if (!busy && update.deferred) {
    update.deferred = false;
    openUpdateModal();
  }
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
    $('auditBody').innerHTML = `<p class="empty">Could not read the tablet: ${esc(err.message)}</p>`;
  } finally {
    setBusy(false);
  }
}

/**
 * Re-plan from the report we already have. Used by the skip toggles, which
 * change what we do with what we know rather than what we know, so they do
 * not need another round trip to the tablet.
 *
 * This goes through the same planner Apply uses, over IPC, rather than a
 * local copy of its filter. The copy this replaced had drifted: it dropped
 * the levels group, so flipping any skip switch turned a dim-screen-only
 * tablet into "Nothing to apply".
 */
async function applyPlanFromReport() {
  if (!state.report) return;
  try {
    state.plan = await call(window.bench.buildPlan, state.report, { ...state.opts });
    renderPlan({ report: state.report, plan: state.plan });
  } catch (err) {
    renderPlan({ error: err.message });
  }
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

  const levelRow = (l) => `
    <div class="row">
      <span class="row-key">${esc(l.what)}</span>
      <span class="row-val">${esc(l.current)} &rarr; <strong>${esc(l.desired)}</strong></span>
    </div>`;

  const appRow = (a) => {
    const missing = [];
    if (!a.dozeExempt) missing.push('doze exemption');
    if (!a.bucketOk) missing.push(`bucket ${bucketName(a.standbyBucket)} &rarr; active`);
    if (!a.opsOk) missing.push('background ops');
    for (const label of deniedPermissions(a)) missing.push(`grant ${esc(label)}`);
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
        ${section('Levels to set', plan.levels || [], levelRow)}
        ${section('Lock screen', plan.lockScreen ? [plan.lockScreen] : [], levelRow)}
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

/**
 * The audit detail: what the tablet looks like, under the Apply log. The
 * counts live in the plan tiles above; this is the evidence behind them. An
 * MDM banner goes to the top of the panel instead, because it outranks
 * everything else on it.
 */
function renderAudit(report) {
  if (!report) return;
  const { device } = report;

  const cell = (label, value) => `<div class="info-cell"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;
  const battery =
    device.battery.level == null
      ? '-'
      : `${device.battery.level}%${device.battery.charging ? ' (charging)' : ''}${
          device.battery.health ? `, ${device.battery.health}` : ''
        }${device.battery.temperatureC != null ? `, ${device.battery.temperatureC} C` : ''}`;
  const lock = device.lockScreen || {};
  const lockText =
    lock.disabled === true
      ? 'none'
      : lock.credentialType && lock.credentialType !== 'NONE'
        ? lock.credentialType.toLowerCase()
        : lock.disabled === false
          ? 'swipe'
          : 'unknown';
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

  $('managedBanner').innerHTML = managedBanner;

  const info = `
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
        ${cell('Screen lock', lockText)}
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
      ${
        lock.credentialType && lock.credentialType !== 'NONE'
          ? `<div class="alert"><span class="alert-mark" aria-hidden="true">!</span><span>A ${esc(
              lock.credentialType.toLowerCase()
            )} lock is set, so orders hide behind it after every reboot. adb cannot remove a lock code without knowing it. On the tablet: Settings &gt; Lock screen &gt; Screen lock type &gt; None.</span></div>`
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
        const denied = deniedPermissions(a);
        const chips = [
          a.enabled === false ? chip('disabled', 'bad') : chip('enabled', 'ok'),
          a.dozeExempt ? chip('doze exempt', 'ok') : chip('not doze exempt', 'bad'),
          a.bucketOk ? chip(`bucket ${bucketName(a.standbyBucket)}`, 'ok') : chip(`bucket ${bucketName(a.standbyBucket)}`, 'bad'),
          a.opsOk ? chip('background ok', 'ok') : chip('background limited', 'bad'),
          denied.length ? chip(`${denied.join(' + ')} denied`, 'bad') : chip('permissions ok', 'ok'),
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

  $('auditBody').innerHTML = info + appCard + settingsCard + bloatCard;
  renderPatchStatus();
  renderWallpaperBlock();
  setBusy(state.busy);
}

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
  await showDrift(state.selected);
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
// Verify - can this tablet take an order right now?
// --------------------------------------------------------------------------

const CHECK_CHIP = { ok: ['ok', 'ok'], warn: ['check', 'warn'], bad: ['fix', 'bad'], skip: ['skipped', 'muted'] };

/** Where each red or amber row gets fixed. */
const FIX_HINTS = {
  apply: 'Apply on the Provision tab fixes this.',
  manual: 'On the tablet itself.',
  launch: 'Use "Open order app on tablet" above.',
  setup: 'On the Setup tab.',
};

async function loadHandover() {
  if (!state.selected) return;
  const serial = state.selected;
  const handover = await call(window.bench.getHandover, serial);
  if (state.selected !== serial) return;
  state.verify.handover = handover;
  $('printerHost').value = handover.printerHost || '';
  renderChecklist();
}

/** Ticks the operator has made for this tablet, keyed by item id. */
const checklistDone = () => {
  const h = state.verify.handover;
  return (id) => Boolean(h && h.checklist[id] && h.checklist[id].done);
};

function renderChecklist() {
  const host = $('checklistBody');
  const h = state.verify.handover;
  if (!state.selected || !h) {
    host.innerHTML = '';
    return;
  }
  const done = checklistDone();
  const manufacturer = ((state.verify.report && state.verify.report.device.manufacturer) || '').toLowerCase();
  const items = h.items.filter((item) => !item.oem || !manufacturer || item.oem === manufacturer);
  const ticked = items.filter((item) => done(item.id)).length;

  host.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h3>By hand on the tablet</h3>
        <span class="count">${ticked} of ${items.length} ticked</span>
      </div>
      <div class="rows">
        ${items
          .map(
            (item) => `<button class="pick-row check" role="checkbox" aria-checked="${done(item.id)}" data-item="${esc(item.id)}" type="button">
              <span class="pick-box" aria-hidden="true"></span>
              <span class="row-key">${esc(item.label)}${item.oem ? ` <span class="chip muted">${esc(item.oem)}</span>` : ''}<span class="check-note">${esc(item.note)}</span></span>
            </button>`
          )
          .join('')}
      </div>
      <p class="card-note">Each of these ends in a tap on the tablet's own screen or needs something only the restaurant has, so Apply cannot do them. Ticks are kept per tablet on this PC and written into the tablet's record when you Ship.</p>
    </div>`;

  for (const btn of host.querySelectorAll('.pick-row.check')) {
    btn.addEventListener('click', async () => {
      if (state.busy || !state.selected) return;
      const id = btn.dataset.item;
      const next = !done(id);
      btn.setAttribute('aria-checked', String(next));
      try {
        state.verify.handover = await call(window.bench.saveHandover, state.selected, { checklist: { [id]: next } });
        renderChecklist();
      } catch (err) {
        logTarget = 'verifyLog';
        logLine({ level: 'error', message: err.message });
      }
      renderShipStatus();
    });
  }
  renderShipStatus();
  setBusy(state.busy);
}

$('printerHost').addEventListener('change', async () => {
  if (!state.selected) return;
  try {
    state.verify.handover = await call(window.bench.saveHandover, state.selected, { printerHost: $('printerHost').value });
  } catch {
    // The value is still in the box; it just did not persist for next time.
  }
});

// The slip button follows the box keystroke by keystroke.
$('printerHost').addEventListener('input', () => setBusy(state.busy));

/**
 * A raw ESC/POS slip, sent to the printer by the tablet itself. Proves the
 * path the order app prints over without needing the app to be paired or the
 * printer to be configured in it. LAN printers only.
 */
$('printSlip').addEventListener('click', async () => {
  const host = $('printerHost').value.trim();
  if (!state.selected || !host) return;
  logTarget = 'verifyLog';
  setBusy(true);
  try {
    await call(window.bench.printTestSlip, state.selected, host);
  } catch (err) {
    logLine({ level: 'error', message: err.message });
  } finally {
    setBusy(false);
  }
});

async function runVerify() {
  if (!state.selected || state.busy) return;
  const serial = state.selected;
  setBusy(true);
  $('verifyBody').innerHTML = '<p class="empty">Reading the tablet...</p>';
  $('runVerify').textContent = 'Reading tablet...';
  try {
    const report = await call(window.bench.verify, serial, { printerHost: $('printerHost').value });
    if (state.selected !== serial) return;
    state.verify.report = report;
    renderVerify(report);
    renderChecklist();
  } catch (err) {
    state.verify.report = null;
    $('verifyBody').innerHTML = `<p class="empty">Could not read the tablet: ${esc(err.message)}</p>`;
  } finally {
    $('runVerify').textContent = 'Check readiness';
    setBusy(false);
    renderShipStatus();
  }
}

function renderVerify(report) {
  const checks = report.checks;
  const bad = checks.filter((c) => c.status === 'bad').length;
  const warn = checks.filter((c) => c.status === 'warn').length;
  const pick = (ids) => checks.filter((c) => ids.includes(c.id));
  const worst = (list) => (list.some((c) => c.status === 'bad') ? 'bad' : list.some((c) => c.status === 'warn') ? 'warn' : 'good');
  const summarise = (list) => {
    const b = list.filter((c) => c.status === 'bad').length;
    const w = list.filter((c) => c.status === 'warn').length;
    if (b) return `${plural(b, 'problem')}`;
    if (w) return `${plural(w, 'thing')} to look at`;
    return 'all good';
  };

  const appChecks = pick(['app', 'listener', 'notifications', 'bluetooth', 'background', 'update']);
  const netChecks = pick(['wifi', 'backend', 'printer']);
  const deviceChecks = pick(['clock', 'lock', 'battery', 'account', 'record']);

  const tiles = `
    <div class="tiles">
      ${tile(
        'Overall',
        report.ready ? 'Ready' : 'Not ready',
        report.ready ? (warn ? `${plural(warn, 'thing')} to look at` : 'Can take an order now') : `${plural(bad, 'problem')} to fix`,
        report.ready ? (warn ? 'warn' : 'good') : 'bad'
      )}
      ${tile('Order app', report.prod ? `v${report.prod.versionName || '?'}` : 'Missing', summarise(appChecks), worst(appChecks))}
      ${tile('Network', report.wifi && report.wifi.connected ? 'On Wi-Fi' : 'Offline', summarise(netChecks), worst(netChecks))}
      ${tile('Tablet', report.device.model || report.device.serial, summarise(deviceChecks), worst(deviceChecks))}
    </div>`;

  const row = (c) => {
    const [text, kind] = CHECK_CHIP[c.status] || CHECK_CHIP.skip;
    const fix = c.status !== 'ok' && c.status !== 'skip' && c.fix ? ` <span class="check-fix">${esc(FIX_HINTS[c.fix] || '')}</span>` : '';
    return `<div class="row check-row">
        ${chip(text, kind)}
        <span class="row-key">${esc(c.label)}</span>
        <span class="check-detail">${esc(c.detail)}${fix}</span>
      </div>`;
  };

  const group = (title, list, note) => `
    <div class="card">
      <div class="card-head"><h3>${esc(title)}</h3><span class="count">${esc(summarise(list))}</span></div>
      <div class="rows">${list.map(row).join('')}</div>
      ${note ? `<p class="card-note">${note}</p>` : ''}
    </div>`;

  const others = report.apps.filter((a) => !report.prod || a.pkg !== report.prod.pkg);
  const appNote = others.length
    ? `Also installed: ${others.map((a) => `${esc(a.pkg)} v${esc(a.versionName || '?')}`).join(', ')}. Test builds do not count toward readiness.`
    : 'The listener, the permission and the background exemptions are read from an exact-matched dumpsys block, so a .staging or .dev build cannot stand in for the production app.';

  $('verifyBody').innerHTML =
    tiles +
    group('Order app', appChecks, appNote) +
    group('Network', netChecks, 'Everything here is checked from the tablet, over its own Wi-Fi. What this PC can reach says nothing about what the tablet can.') +
    group(
      'Tablet',
      deviceChecks,
      `Checked ${esc(new Date(report.checkedAt).toLocaleString('en-US'))}. USB debugging is ${report.usbDebugging === false ? 'off' : 'on'}${
        report.usbDebugging === false ? '' : ' - Ship turns it off'
      }.`
    );
  renderShipStatus();
}

/** What Ship would have to admit to. */
function shipUnmet() {
  const report = state.verify.report;
  if (!report) return [];
  const unmet = report.checks.filter((c) => c.status === 'bad').map((c) => c.label);
  const h = state.verify.handover;
  if (h) {
    const done = checklistDone();
    const manufacturer = (report.device.manufacturer || '').toLowerCase();
    for (const item of h.items) {
      if (item.oem && manufacturer && item.oem !== manufacturer) continue;
      if (!done(item.id)) unmet.push(`Not ticked: ${item.label}`);
    }
  }
  return unmet;
}

function renderShipStatus() {
  const el = $('shipStatus');
  if (!state.verify.report) {
    el.textContent = 'check readiness first';
    el.style.color = '';
    return;
  }
  const unmet = shipUnmet();
  el.textContent = unmet.length === 0 ? 'ready to ship' : `${plural(unmet.length, 'thing')} outstanding`;
  el.style.color = unmet.length === 0 ? 'var(--emerald)' : 'var(--amber)';
}

$('runVerify').addEventListener('click', () => runVerify());

$('launchFromVerify').addEventListener('click', async () => {
  const report = state.verify.report;
  if (!state.selected || !report || report.apps.length === 0) return;
  const pkg = report.prod ? report.prod.pkg : report.apps[0].pkg;
  logTarget = 'verifyLog';
  setBusy(true);
  try {
    const r = await call(window.bench.launchApp, state.selected, pkg);
    logLine({ level: r.ok ? 'ok' : 'warn', message: r.ok ? `Launched ${pkg}. Give it a few seconds, then check readiness again.` : 'Could not launch the app.' });
  } catch (err) {
    logLine({ level: 'error', message: err.message });
  } finally {
    setBusy(false);
  }
});

/**
 * Ship takes the tablet off adb on purpose, so it ends the way the power
 * actions do: the report is dropped and the device list re-read, rather than
 * left describing a tablet this PC can no longer see.
 */
$('shipDevice').addEventListener('click', async () => {
  if (!state.selected || !state.verify.report) return;
  logTarget = 'verifyLog';
  setBusy(true);
  let acted = false;
  try {
    const r = await call(window.bench.ship, state.selected, { unmet: shipUnmet() });
    if (!r.confirmed) return;
    acted = true;
  } catch (err) {
    logLine({ level: 'error', message: err.message });
  } finally {
    setBusy(false);
  }
  if (acted) {
    state.verify.report = null;
    state.report = null;
    state.plan = null;
    renderPlan(null);
    renderShipStatus();
    setBusy(false);
    await refreshDevices();
  }
});

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
// Panda Bench's own updates
// --------------------------------------------------------------------------

/* The popup is the only thing that ever installs an update, and it only does
   it when the button is pressed. A check that finds something while a tablet
   is mid-run waits for the run to finish before it says anything - see rule
   one in electron/updater.js. */

const update = {
  status: { state: 'idle' },
  /** Found something while busy: show it the moment the bench is free. */
  deferred: false,
  /** state+version already popped, so a download does not pop twice over. */
  announced: new Set(),
  lastFocus: null,
};

/** Title, body and buttons for whatever the updater last reported. */
function updateCopy(status) {
  const version = status.version ? `Panda Bench ${status.version}` : 'A new Panda Bench';
  switch (status.state) {
    case 'checking':
      return { title: 'Checking for updates', body: 'Asking for the latest Panda Bench release.' };
    case 'current':
      return {
        title: 'You are up to date',
        body: `Panda Bench v${status.current} is the latest release.`,
      };
    case 'available':
      return {
        title: `${version} is available`,
        body: 'Downloading it in the background. Nothing on a tablet is touched, and nothing installs until you say so.',
      };
    case 'downloading':
      return {
        title: `${version} is available`,
        body: `Downloading it in the background - ${status.percent || 0}% done. Nothing installs until you say so.`,
      };
    case 'downloaded':
      return {
        title: `${version} is ready to install`,
        body: 'It installs when Panda Bench restarts. Finish anything running on a tablet first.',
        action: 'Restart now',
      };
    case 'disabled':
      return { title: 'Updates are off', body: status.reason || 'This build does not check for updates.' };
    case 'error':
      return {
        title: 'Could not check for updates',
        body: `${status.message || 'The release feed could not be reached.'}\n\nPanda Bench works normally either way - provisioning never depends on this.`,
      };
    default:
      return { title: 'Updates', body: `Panda Bench v${status.current || '?'} is running.` };
  }
}

function renderUpdate() {
  const status = update.status;
  const copy = updateCopy(status);

  $('updateTitle').textContent = copy.title;
  $('updateBody').textContent = copy.body;

  const notes = status.notes || '';
  $('updateNotes').textContent = notes;
  $('updateNotes').hidden = !notes;

  const action = $('updateAction');
  action.hidden = !copy.action;
  action.textContent = copy.action || '';
  action.disabled = Boolean(copy.action) && state.busy;
  $('updateWarning').hidden = !(copy.action && state.busy);

  $('updateDismiss').textContent = copy.action ? 'Later' : 'Close';

  // The sidebar button doubles as the only badge there is.
  const waiting = status.state === 'available' || status.state === 'downloading' || status.state === 'downloaded';
  $('checkUpdates').textContent = waiting ? 'Update ready' : 'Updates';
}

function openUpdateModal() {
  update.lastFocus = document.activeElement;
  $('updateModal').hidden = false;
  renderUpdate();
  const action = $('updateAction');
  (action.hidden || action.disabled ? $('updateDismiss') : action).focus();
}

function closeUpdateModal() {
  $('updateModal').hidden = true;
  if (update.lastFocus && document.contains(update.lastFocus)) update.lastFocus.focus();
  update.lastFocus = null;
}

const updateModalOpen = () => !$('updateModal').hidden;

/** Everything the updater says arrives here, whoever asked for it. */
function applyUpdateStatus(status) {
  update.status = status || { state: 'idle' };
  renderUpdate();

  const announceable = update.status.state === 'available' || update.status.state === 'downloaded';
  const key = `${update.status.state}:${update.status.version || ''}`;
  if (!announceable || update.announced.has(key)) return;
  update.announced.add(key);

  if (state.busy) update.deferred = true;
  else if (!updateModalOpen()) openUpdateModal();
}

window.bench.onUpdateStatus(applyUpdateStatus);

$('checkUpdates').addEventListener('click', async () => {
  openUpdateModal();
  try {
    applyUpdateStatus(await call(window.bench.checkForUpdates));
  } catch (err) {
    applyUpdateStatus({ state: 'error', message: err.message, current: update.status.current });
  }
});

$('updateDismiss').addEventListener('click', closeUpdateModal);

$('updateAction').addEventListener('click', async () => {
  try {
    await call(window.bench.installUpdate);
  } catch (err) {
    applyUpdateStatus({ state: 'error', message: err.message, current: update.status.current });
  }
});

/* Escape closes it, and Tab stays inside it: the popup can appear over a run
   and must not become a place the keyboard gets stuck. */
$('updateModal').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeUpdateModal();
    return;
  }
  if (event.key !== 'Tab') return;
  const buttons = [$('updateDismiss'), $('updateAction')].filter((b) => !b.hidden && !b.disabled);
  if (buttons.length === 0) return;
  const edge = event.shiftKey ? buttons[0] : buttons[buttons.length - 1];
  if (document.activeElement === edge) {
    event.preventDefault();
    (event.shiftKey ? buttons[buttons.length - 1] : buttons[0]).focus();
  }
});

/* Clicking the dimmed area behind it is a dismissal, like every other dialog
   on this PC. */
$('updateModal').addEventListener('mousedown', (event) => {
  if (event.target === $('updateModal')) closeUpdateModal();
});

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------

/** The running build, in the sidebar - so a bench PC can be checked against a release. */
async function showAppVersion() {
  try {
    $('appVersion').textContent = `v${await call(window.bench.appVersion)}`;
  } catch {
    // Not worth an error state on screen: the label just stays empty.
  }
}

async function showAdbStatus() {
  try {
    const info = await call(window.bench.adbInfo);
    // A bundled adb was nobody's decision, so it reads as a fact rather than as
    // a path: the full path is still one hover away.
    $('adbPath').textContent = info.bundled
      ? `adb ${info.adbVersion || ''} (included)`.replace(/\s+/g, ' ')
      : info.found
        ? info.path
        : 'adb not found - click Locate adb';
    $('adbPath').title = info.found ? info.path : '';
    $('adbDot').className = `adb-dot ${info.found ? 'ok' : 'bad'}`;
  } catch (err) {
    $('adbPath').textContent = err.message;
    $('adbDot').className = 'adb-dot bad';
  }
}

/** The launch check may have finished before this window was ready to hear
 *  about it, so the state is read once rather than checked a second time. */
async function showUpdateStatus() {
  try {
    applyUpdateStatus(await call(window.bench.updateStatus));
  } catch {
    // Nothing on screen: the Updates button still works.
  }
}

showAppVersion();
showUpdateStatus();
showAdbStatus();
refreshDevices();
setInterval(refreshDevices, 4000);
