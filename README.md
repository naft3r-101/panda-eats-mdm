# Panda Bench

Tablet provisioning workbench for Panda Eats order-taking tablets.

You plug a tablet into your PC over USB, run an audit, hit Apply, and it comes out debloated,
tuned for always-on counter duty, and set up so the order listener does not get put to sleep by
Android's battery managers.

**No root. No factory reset. Everything reversible.** It is a GUI over `adb`, which means it works
on a tablet that is already in the field, including one that is already paired to a restaurant.

---

## What it does

| Area | What happens |
| ---- | ------------ |
| **Speed** | Window and transition animations off, animator scale halved, app caches trimmed |
| **Debloat** | `pm disable-user --user 0` on Bixby, Samsung Free, Facebook stubs, Game Launcher, AR Emoji, Lenovo's store, and ~60 more per OEM |
| **Always-on** | Screen never sleeps while plugged in, 30 minute timeout when unplugged, no screensaver |
| **Audible** | Do Not Disturb off, media volume pinned to the device maximum |
| **Readable** | Adaptive brightness off, no pre-sleep dim, no battery-saver brightness limiter, screen held at 80% of the tablet's own maximum or higher |
| **Background survival** | Order app added to the doze whitelist, standby bucket forced to `active`, background app-ops allowed, adaptive battery and app standby turned off |
| **Allowed to alert** | The notification and Bluetooth runtime permissions granted to the order app. Play grants neither; a Play-installed build starts silent |
| **Nothing in the way** | A swipe-only lock screen turned off, so orders are on screen the moment the tablet is. A PIN is reported, never removed |
| **Battery longevity** | Charge capped at 80% (Samsung's Battery protection, "Maximum"), fast charging off. These tablets never leave the cable, and a cell held at 100% and warm is the one that swells |
| **Clock** | Automatic date, time and time zone on. A drifted clock breaks the backend connection and prints wrong times |
| **Network** | Wi-Fi scan throttling off, Wi-Fi stays up while asleep, captive-portal nagging off |

### What it deliberately does NOT do

These were decisions, not omissions.

- **Google Play is untouched.** Auto-update stays exactly as the tablet had it. Play is how the
  order app reaches the field, and it is also how the 8/4/2026 update silently broke the SM-T510.
  Panda Bench takes no position on that tradeoff.
- **No lockdown.** The browser, Play Store, and Galaxy Store stay reachable. Tablets remain
  general-purpose. Nothing is pinned to the order app.
- **Nothing is uninstalled.** Every "removed" package is disabled for user 0 and comes back with
  `pm enable`. A factory reset also restores everything.
- **Rotation is left alone.** `MainActivity` is `screenOrientation="fullUser"` on purpose, and
  forcing portrait would contradict that.

---

## Setup

**On your PC**

Nothing. **adb ships inside the installer**, so a fresh bench PC needs no Android SDK, no
download and nothing on `PATH` - the sidebar just says `adb 37.0.1 (included)`.

It is still possible to run a different one. Panda Bench looks for `adb.exe` in this order:

1. `PANDA_BENCH_ADB` environment variable
2. The copy that came with the installer
3. `ANDROID_HOME` / `ANDROID_SDK_ROOT` + `platform-tools`
4. `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe`
5. `adb` on `PATH`

If somehow none of those exist, the sidebar turns red and the **Locate adb** button lets you point
at one.

The bundled copy is not in this repo. `scripts/fetch-platform-tools.js` downloads Google's
platform-tools into gitignored `vendor/` on every `pnpm build`, keeps `adb.exe`, its two DLLs and
Google's `NOTICE.txt`, and electron-builder packs them as `resources/platform-tools`. Run
`pnpm vendor:adb --force` to pick up a newer platform-tools release.

**On the tablet**

1. Settings → About tablet → Software information → tap **Build number** seven times
2. Settings → Developer options → turn on **USB debugging**
3. Plug into the PC, then accept the **Allow USB debugging** prompt on the tablet's own screen

**Running**

```bash
pnpm install
pnpm start          # or: pnpm dev, which opens devtools
```

---

## Keeping Panda Bench itself up to date

An installed copy checks the repo's releases when it starts, and **Updates** in the sidebar checks
on demand. A new version downloads quietly in the background and a popup offers to install it; it
only ever installs when you press **Restart now**, and if a tablet is mid-run the popup waits until
the run finishes rather than interrupting it. Releases are public, so a bench PC needs no token and
no GitHub account.

Publishing a new version, from this PC:

```bash
GH_TOKEN="$(gh auth token)" pnpm release
```

That refreshes the bundled adb, creates the GitHub release for the version in `package.json`, builds
the installer and uploads it. Every bench PC picks it up the next time it starts.

---

## The workflow

Four tabs, in the order a tablet goes through them: **Setup**, **Provision**, **Verify**, **Tools**.

```
1. Plug tablet in       -> verify: it appears in the sidebar with its model name, and the chip
                                   under it says whether it was ever provisioned
2. Setup tab            -> verify: the order app is installed (Play, or an APK), wallpaper set
3. Provision tab        -> verify: the plan lists every change it is about to make, and the
                                   audit detail below the log shows why (read-only until Apply)
4. Set Aggressive?      -> verify: the plan re-reads the tablet and the counts move
5. Apply                -> verify: every log line is a green check
6. Reboot the tablet    -> verify: the plan re-reads to "Nothing to apply"
7. Verify tab           -> verify: Overall says Ready; every red row is gone; a test slip printed
8. Tick the checklist   -> verify: pair, Wi-Fi, printer, test order - the taps only a human
                                   can do, kept per tablet
9. Ship                 -> verify: the handover is on the tablet and USB debugging is off
```

Step 6 matters. Some settings only fully take effect after a reboot, and an audit on a freshly
rebooted tablet is the only audit worth trusting.

Step 7 is the difference between "matches the profile" and "can take an order". The Provision tab
answers the first question; the Verify tab answers the second, from the tablet's own point of view.

**The audit and the plan are the same read**, which is why they share a tab. One call to
`preview()` returns the audit and the exact plan Apply would execute, built by the single planner
in `provision.js`; the plan sits above the Apply button and the audit detail (device, order app,
settings, bloat) below its log. There is no way for the preview and the execution to disagree
about what "disable this package" means.

**Tools** holds Rollback and Discover, the two things used once a month.

**Apply still re-reads the tablet at execution time.** The preview on screen may be minutes old,
or may belong to a tablet you have since unplugged, so the plan that actually runs is always built
from a read taken at that moment. If the two differ, the log is the truth.

### The Setup tab

Three things a fresh tablet needs that Provision cannot do unattended, because each one ends in a
tap on the tablet's own screen. They are deliberately kept out of Apply - burying a step that
needs a human inside a batch that otherwise runs by itself would make Apply a liar about having
finished.

**Install the order app.** Two paths, because there are genuinely two:

- *From Google Play* - the production path. Opens the app's listing on the tablet so you tap
  Install there. Play needs a signed-in Google account on the device, so there is no remote way to
  drive it.
- *From an APK file* - scans the sibling order-app repo's Gradle output and your Downloads folder,
  reads each APK with `aapt2` and shows its applicationId, version and flavour **before** you
  install anything. Installs with `-r` (keeps app data) and `-g` (pre-grants runtime permissions),
  then applies the background tuning automatically and offers to launch it.

  The flavour matters and the tool says so out loud. `com.pandaeats.ordertaking` carries no
  applicationIdSuffix, so installing it **replaces** a Play-installed build rather than sitting
  beside it. If the tablet is paired and the signing keys differ the install fails outright; if
  they match, the live app is replaced. `.staging` and `.dev` install alongside and are safe.
  Panda Bench shows a red warning whenever the chosen APK would replace something already there.

#### Will a sideloaded app still update itself?

Only if two things are both true, and the audit now tells you about both.

1. **A Google account is signed in.** With none, Play cannot install or update anything, so every
   future build has to arrive over a USB cable. The Audit tab reports the account state and warns
   when there is none, because a tablet that can never update itself is a thing you want to know
   about before it leaves the bench, not three months later.

2. **The APK's signing certificate matches the one Play distributes.** The order app is published
   as an AAB, so Play App Signing re-signs it with Google's key - which is not the local
   `release.jks` unless that key was uploaded as the app signing key. The Setup tab reads each
   APK's certificate with `apksigner` and shows whether it is debug- or release-signed. A
   debug-signed build can never be updated by Play and cannot even install over a Play build; it
   fails with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`.

So there are three workable routes: sign an account in once and let Play handle updates (the
documented production path), sideload with no account and own every update yourself, or sideload a
release-signed build after verifying its certificate matches Play's. Either way the heartbeat's
`min_supported_version_code` is the backstop - a tablet stuck on an old build gets flagged
server-side.

**Wallpaper.** Ships with Panda Eats wallpapers, or pick your own image. See the limits section -
this one always needs a tap.

**System update.** Shows the tablet's security patch level and how old it is, and opens the update
screen on the device. Firmware updates are signed and vendor-driven; nothing can apply one over
adb.

### Aggressive tier

Off by default. It adds a second list: the Google app and Assistant, Photos, Drive, Maps, Gmail,
Galaxy Store, Samsung Cloud, Samsung Notes, and similar. Bigger speed win, but the tablet loses
real features. Fine for a tablet that only ever runs the order app. Think twice if the restaurant
uses it for anything else.

The audit tells you how many packages the aggressive tier is holding back, so you can see what
you would gain before turning it on.

### Drift, and what happens when a tablet comes back

Brightness and media volume are **floors**, not profile lines: Apply raises a tablet that is under
them and leaves one the restaurant turned up higher alone. That is also why they cannot be enforced
the way a setting is - an exact-match profile would drag a bright tablet back down.

The consequence is that a tablet which has been on a counter for a month comes back dimmed, and
nobody would think to run an audit on a tablet that was already provisioned. So selecting a tablet
runs a three-read check on the spot - brightness, adaptive brightness, media volume - and says so
under the device name:

```
Not counter-ready: screen at 11%, adaptive brightness on. Apply fixes it.
```

Both levels are in the Provision plan as **Levels to set**, so Apply runs on a tablet whose only
fault is a dimmed screen. Before that they were applied but never planned, and the button did
nothing on a tablet the audit had just called not ready.

### Rollback

Every Apply writes a rollback point **before it touches the device**, so even a crash mid-run
leaves a working revert. The Rollback tab lists them per tablet. Reverting:

- puts every setting back to the exact value it held (or unsets it, if it was unset)
- re-enables every package that run disabled
- restores the doze exemption, standby bucket, and app-ops to what they were
- restores the previous media volume and screen brightness

Rollback points live in `state/` during development, and in the app's userData folder once
packaged. The **Open folder** button on the Rollback tab takes you there.

Reverting also revokes the runtime permissions that run granted and turns a lock screen that run
switched off back on.

### The Verify tab

Read-only, and meant for the moment after the reboot. Where the audit asks "does this tablet match
the profile", Verify asks "can it take an order right now", and it asks the tablet rather than the
PC:

| Check | How it is read |
| ----- | -------------- |
| Order app installed, and the **production** build | `pm list packages`, exact match. A `.staging` or `.dev` build beside it is a test tool and does not count |
| Order listener running as a foreground service | `dumpsys activity services`, split into exact-keyed records the same way the package dump is. The `.staging` build's service cannot stand in for prod's |
| Notifications and Bluetooth allowed | The `runtime permissions:` section of the exact package block. The install permissions above it print `granted=true` too, and always will |
| Survives in the background | Doze whitelist, standby bucket, app-ops - the same three reads the audit makes |
| On the build Play is serving | The production track, read through the Play Developer API with the order app's own publishing service account (`../panda-eats-orderapp-kotlin/play-api-key.json`, or `PANDA_BENCH_PLAY_KEY`). A tablet behind is a warning, not a block; without the key the row is skipped and says so |
| On Wi-Fi, with a usable signal | `cmd wifi status`: network name, address, RSSI. Below -70 dBm is flagged |
| Reaches Panda Eats | One `ping` **from the tablet** to `app.getpandaeats.com`. What this PC can reach says nothing about a tablet on the restaurant's Wi-Fi |
| Reaches the printer | Same, against the address you type in. Remembered per tablet. USB and Bluetooth printers have no address; leave it empty and the row is skipped |
| Clock set automatically | `auto_time`, `auto_time_zone`, and the tablet's epoch against this PC's. More than a minute out is red |
| No lock screen | `locksettings get-disabled` plus the credential type. Swipe-only is red and Apply fixes it; a PIN is red and only a human can |
| Battery healthy | Health and temperature from `dumpsys battery`. A warning, never a block |
| Google account signed in | So Play can update the app. A warning |
| Provisioned with the current profile | The record on the tablet (below) against a fingerprint of `profiles/` as it is now |

Only red rows make the tablet **Not ready**. Each one says where it gets fixed: the Provision tab,
the Setup tab, "Open order app on tablet", or the tablet's own screen.

**Print test slip** sends a short ESC/POS receipt to the printer address **from the tablet**: the
bytes are pushed to the tablet and its own `nc` opens port 9100, so what is proved is the exact
path the order app prints over, with no need for the app to be paired or the printer configured in
it. The slip opens with `ESC @` and closes with a feed-and-cut, the same framing the app's
templates use. LAN printers only; USB and Bluetooth have no address.

Under the checks is the **by-hand checklist**: pairing, the restaurant's Wi-Fi, the printer and
its "Always allow", a test order. Each of these ends in a tap on the tablet or needs something only
the restaurant has, so Apply cannot do them and they used to live only in this file. Ticks are kept
per serial on this PC, in `state/handover/`, so a tablet that comes back shows what was done last
time.

Three things that were on that list are not any more, because they turned out not to need a human.
The battery optimization dialog asks for exactly what Apply's doze exemption grants, and the order
app skips the prompt when it is already exempt. Samsung's "Never sleeping apps" list never offers
PE Orders, because the same exemption is what Settings calls battery usage "Unrestricted" and the
sleeping-app pickers only list apps that can be put to sleep; on One UI 6.1 the whole Background
usage limits menu is gone from the Battery page anyway. Play auto-update cannot be read or set over
adb, but what it is for - being on the build Play serves - is now a check. Of what is left, pairing and
the printer setup could be automated with a hook in the order app (it owns the credential store
and the printer database), a test order needs an endpoint in the backend, and joining Wi-Fi from
adb is refused on One UI 6.1 (`connect-network` needs system rights). Those are order-app and
backend cards, not bench ones.

**Ship** is the last button. It writes the ticks into the tablet's record, then turns USB
debugging off, because a counter tablet has an unlocked screen and with debugging on anyone with a
cable can accept the prompt on that screen and do everything this tool does. It asks first and
names anything still red or unticked; shipping anyway is allowed, and recorded. Putting the tablet
back on the bench means Settings > Developer options on the tablet itself, so do not ship one you
are about to need.

### The record on the tablet

Apply writes `/sdcard/Documents/panda-bench.json` on the tablet: when it was provisioned, with which
Panda Bench, with which profile (an 8-character fingerprint of `profiles/`, comments excluded),
whether Aggressive was on. Ship adds when it shipped and the checklist. The chip under the device
name reads it the moment a tablet is plugged in:

```
Provisioned 9/15/2026 with v0.3.6, shipped 9/15/2026 - profile has changed since
```

A tablet with no record has never been through this tool, and the chip says so. The file is in
Documents on purpose: it survives the order app being uninstalled and is visible in the Files app,
so the tablet carries its own history without anyone having to find the bench PC it was done on.

---

## Extending the bloat lists

The lists in `profiles/bloat/` are plain text and hot-loaded on every run. No rebuild needed.

```
profiles/
  settings.txt       what to set, with the reasoning inline
  protected.txt      the never-disable guard list
  bloat/
    common.txt       applies to every device
    samsung.txt      matched on ro.product.manufacturer = samsung
    lenovo.txt       matched on ro.product.manufacturer = lenovo
```

A `!` prefix on a line marks it aggressive-tier.

To grow a list: run the **Discover** tab against a real tablet. It shows every system package that
no profile mentions and that is not protected. Paste the junk you recognise into the OEM file and
re-audit. The Lenovo list in particular is thin and expects this.

Adding a new OEM is one file: `profiles/bloat/<manufacturer>.txt`, lowercased to match
`ro.product.manufacturer`. Unknown manufacturers fall back to `common.txt` alone, which is safe.

---

## Safety

The thing that separates a debloat tool from a brick is the guard list, so it is worth knowing
exactly what protects you.

**A package is skipped if any of these is true:**

- it is in `profiles/protected.txt` (58 entries: framework, providers, WebView, GMS, Play, keyboards, launchers, Chrome)
- it is the device's **current keyboard**, resolved live from `default_input_method`
- it is the device's **current launcher**, resolved live from `resolve-activity HOME`
- it starts with `com.pandaeats.`
- it is not actually installed on this tablet

The last one is why an over-broad list is safe rather than dangerous: entries that do not exist are
skipped silently, and the audit shows you exactly which ones were found before anything is touched.

Protected packages that appear in a bloat list are shown in the audit with the reason they were
blocked, rather than being hidden.

### Writes that lie

Two things on real hardware report success and then do nothing. Both were found on an
**SM-T227U running Android 14**, and both would otherwise leave an audit that can never go clean.

- **`settings put` exits 0 even when the platform refuses the write.** Android 12+ took over
  some keys; you can write them all day and the value never moves. Apply now **reads every
  setting back** after writing it and warns when it did not stick, naming the key so you can
  delete it from the profile. `network_recommendations_enabled` was exactly this and has been
  removed.
- **OEMs mark some packages undisableable.** `pm disable-user com.samsung.android.themecenter`
  throws `SecurityException: Cannot disable a protected package` and exits 255. There is no adb
  path around it. Apply recognises this specific failure and says so in plain words, rather than
  letting you retry it forever. That package has been removed from the Samsung profile.

If you hit a third one, the log will tell you which it is and the fix is always the same: delete
the line from `profiles/`.

### Two Windows / Android landmines this handles for you

1. **adb returns CRLF on Windows.** Every parser here strips it, because a trailing `\r` glued to a
   package name silently breaks exact-match comparison and would make the guard list miss.

2. **`dumpsys package <pkg>` prefix-matches.** Asking about `com.pandaeats.ordertaking` returns the
   `.staging` and `.dev` blocks too, and reading the first `versionName` you find gives a
   confidently wrong answer about which build is on the tablet. Panda Bench splits the dump into
   exact-keyed blocks so this cannot happen. This is a documented, repeatedly-rediscovered trap in
   the order-app repo.

---

## When another MDM already owns the tablet

The Audit tab checks for an existing Device Owner or Profile Owner and puts a red banner at the
top of the page when it finds one. This matters more than anything else on that screen: a Device
Owner outranks adb completely. It can re-enable packages Panda Bench disables and re-impose
settings at its next sync, so everything this tool does to such a tablet is provisional.

**It cannot be removed with adb.** All three routes are refused - verified on a Hexnode-enrolled
SM-T227U running Android 14:

| Attempt | Result |
| ------- | ------ |
| `dpm remove-active-admin` | `SecurityException: Attempt to remove non-test admin` |
| `pm uninstall --user 0` | `Failure [DELETE_FAILED_INTERNAL_ERROR]` |
| `pm disable-user` | `SecurityException: Cannot disable a protected package` |

**A factory reset does clear a Device Owner**, and Panda Bench checks whether the MDM has blocked
that (`no_factory_reset`). If it has not, a wipe is a real option.

The one thing that can undo a wipe is **Knox Mobile Enrollment**: if the tablet is registered in a
KME account, it re-enrols itself during the setup wizard, because that registration lives in
Samsung's console keyed to the device, not on the device. Panda Bench reports whether the Knox
enrolment client is installed - but be careful how you read that, because **the client ships on
every Samsung enterprise device and its presence is not proof of enrolment**. The only reliable
test is to reset and watch the setup wizard. If an enrolment screen appears, the tablet is in
someone's KME account and only that account holder can release it.

So the removal paths, best first:

1. **Unenrol from the MDM console.** Even a lapsed subscription usually still lets you sign in and
   delete the device, and the agent removes itself on next check-in. If the account is gone, the
   MDM vendor's support can deprovision it for you.
2. **Factory reset**, if not blocked. Remove any Google account first so Factory Reset Protection
   does not lock you out afterwards.
3. If it re-enrols after the reset, it is KME-registered and whoever sold it has to remove it from
   their Knox Deployment account.

`dpm remove-active-admin`, `pm uninstall` and `pm disable-user` are all dead ends, as above.

If you are buying tablets second-hand or on a carrier business account, run an audit before you
count on one. A carrier-managed device is not a blank device.

## What adb cannot reach

Be honest about the gaps. These still need a human on the tablet's own screen:

- **Setting the wallpaper image.** There is no adb path to it, and this was tested rather than
  assumed. `cmd wallpaper` exists but exposes only dimming - there is no `set`. The AOSP
  `CROP_AND_SET_WALLPAPER` activity resolves on One UI but dies the instant it starts (a vestigial
  stub; Samsung ships its own picker). A `file://` URI is silently rejected by the chooser.

  What does work, and what Panda Bench does: push the image, register it with MediaStore so it has
  a `content://` identity, then fire the standard "Set as" intent against that URI with a read
  grant. The chooser opens with the picture already loaded, so it is one tap rather than a hunt
  through the Gallery. Verified on an SM-T227U running Android 14.

  **Why an MDM can do this and adb cannot:** the wallpaper is set through `WallpaperManager`, and
  any *app* holding the ordinary `SET_WALLPAPER` permission can call it directly with no user
  interaction. adb is not an app and has no shell command for it. That asymmetry is the whole
  story - it is not a privilege gap, it is a missing shell command.

  **And an MDM can lock it.** A Device Owner can set `DISALLOW_SET_WALLPAPER`, after which the
  chooser still opens and the tap still looks like it worked, but Android discards the result.
  Panda Bench reads that restriction before it does anything and refuses with an explanation
  instead of reporting a success that never happened - the Setup tab disables the button and names
  the package holding the lock. Only the device owner can lift it.

- **Applying a firmware update.** Signed and vendor-driven. Panda Bench opens the update screen and
  tells you how stale the patch level is; the taps are yours.

- **Installing from Google Play.** Needs a Google account signed in on the device. Panda Bench
  opens the right listing so there is nothing to type.

- **Samsung "Sleeping apps"** is not a gap after all. The doze exemption Apply sets is what
  Settings > Apps > PE Orders > Battery shows as **Unrestricted**, Samsung's sleeper skips such
  apps, and its pickers do not even offer them. If a Samsung tablet goes quiet overnight, check that
  page reads Unrestricted (the Verify tab's "Survives in the background" row is the same fact).
- **Battery optimization dialog.** The order app already fires this itself once per pairing
  (`MainActivity.maybeRequestBatteryExemption`), so accept it when it appears.
- **A screen lock with a code.** Swipe-only is handled: `locksettings set-disabled true` turns it
  off and Apply does that. A PIN, pattern or password needs the code itself, so it is reported on
  the Audit and Verify tabs and left alone.
- **Wi-Fi credentials and Google sign-in.** Manual. `cmd wifi connect-network` exists but is
  refused to the shell user on One UI 6.1, so there is no adb path onto a network.
- **Play auto-update.** A per-app toggle inside the Play Store UI. Untouched by decision, and
  unreadable over adb - the Verify tab checks the outcome instead (is the tablet on the build Play
  is serving).

The ones that need a tap are on the Verify tab's checklist, so they get ticked rather than
remembered.

---

## Limits

- Windows only in practice. The adb discovery paths are Windows paths, though nothing else is
  platform-specific.
- USB only. There is no `adb connect` path, so fixing a tablet in the field means being in front of
  it. Fleet *monitoring* is a different job and already has a home: `paired_devices` in
  `panda-eats-project` heartbeats battery, OS version, app version, and printer status.
- One tablet at a time.
- The Lenovo list is incomplete and known to be. Use Discover.
- Not signed. Building an installer with `pnpm build` produces an exe that Windows SmartScreen will
  warn about. Running from source with `pnpm start` avoids that entirely and is the intended use.
- Running from a shell that Claude Code opened needs `ELECTRON_RUN_AS_NODE` unset first, or
  Electron starts as plain Node and `app` is undefined.

---

## Tests and CI

```bash
pnpm test
```

`node:test`, no framework, no tablet needed. The parsers in `adb.js` are fed text captured from
real tablets (CRLF included), the planner and the readiness checks are exercised as pure functions,
and `profiles/` is held to a few invariants - the most important being that **no bloat entry names
a protected package**, which is the mistake that once rebooted a tablet mid-run. Add a sample to
`test/adb.test.js` whenever a new dump shape bites.

`.github/workflows/ci.yml` runs the suite on the self-hosted `panda-ci` pool on every push and PR.
It skips the Electron binary download, because nothing in the suite launches Electron. A job that
queues and never starts means this repo has no runner registered yet.

---

## Layout

```
electron/
  main.js        window + IPC handlers
  preload.js     the entire renderer surface (contextIsolation on, nodeIntegration off)
  adb.js         adb plumbing: run, normalise, parse. No policy.
  provision.js   the engine: audit, apply, revert, verify, test slip, ship, discover. All policy.
  profiles.js    loads the text profiles, fingerprints them
  play.js        what Play is serving, via the Developer API and the order app's service account
renderer/
  index.html     four tabs: Setup, Provision, Verify, Tools
  styles.css     brand tokens mirroring the order app's Color.kt
  app.js         no framework
profiles/        editable text, hot-loaded, no rebuild needed
state/           rollback points, one JSON per Apply
  handover/      the per-tablet checklist and printer address
test/            node:test suites for the parsers, planner, checks and profiles
```
