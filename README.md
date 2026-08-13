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
| **Background survival** | Order app added to the doze whitelist, standby bucket forced to `active`, background app-ops allowed, adaptive battery and app standby turned off |
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

Android platform-tools must be installed. Panda Bench looks for `adb.exe` in this order:

1. `PANDA_BENCH_ADB` environment variable
2. `ANDROID_HOME` / `ANDROID_SDK_ROOT` + `platform-tools`
3. `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe` (where yours already is)
4. `adb` on `PATH`

If it cannot find it, the sidebar turns red and the **Locate adb** button lets you point at it.

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

## The workflow

```
1. Plug tablet in       -> verify: it appears in the sidebar with its model name
2. Audit tab -> Run     -> verify: tiles show what is drifted (read-only, changes nothing)
3. Provision tab        -> verify: the plan lists every change it is about to make
4. Set Aggressive?      -> verify: the plan re-reads the tablet and the counts move
5. Apply                -> verify: every log line is a green check
6. Reboot the tablet    -> verify: the plan re-reads to "Nothing to apply"
7. Open the order app   -> verify: it pairs, chimes on a test order, prints
```

Step 6 matters. Some settings only fully take effect after a reboot, and an audit on a freshly
rebooted tablet is the only audit worth trusting.

**Audit and Provision are the same read.** Both go through `preview()`, which returns an audit and
the exact plan Apply would execute, built by the single planner in `provision.js`. There is no way
for the preview and the execution to disagree about what "disable this package" means.

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

### Rollback

Every Apply writes a rollback point **before it touches the device**, so even a crash mid-run
leaves a working revert. The Rollback tab lists them per tablet. Reverting:

- puts every setting back to the exact value it held (or unsets it, if it was unset)
- re-enables every package that run disabled
- restores the doze exemption, standby bucket, and app-ops to what they were
- restores the previous media volume

Rollback points live in `state/` during development, and in the app's userData folder once
packaged. The **Open folder** button on the Rollback tab takes you there.

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

- **Samsung "Sleeping apps"** (Device Care → Battery → Background usage limits). Samsung's own
  sleeper is separate from AOSP's doze, and there is no reliable adb path to the never-sleeping
  list. Add the order app there by hand. On the SM-T510 this is the single most likely cause of a
  tablet that goes quiet overnight.
- **Battery optimization dialog.** The order app already fires this itself once per pairing
  (`MainActivity.maybeRequestBatteryExemption`), so accept it when it appears.
- **Screen lock.** Cannot be reliably removed over adb. Set the tablet to no lock screen manually.
- **Wi-Fi credentials and Google sign-in.** Manual, obviously.
- **Play auto-update.** A per-app toggle inside the Play Store UI. Untouched by decision.

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

---

## Layout

```
electron/
  main.js        window + IPC handlers
  preload.js     the entire renderer surface (contextIsolation on, nodeIntegration off)
  adb.js         adb plumbing: run, normalise, parse. No policy.
  provision.js   the engine: audit, apply, revert, discover. All policy.
  profiles.js    loads the text profiles
renderer/
  index.html     four tabs
  styles.css     brand tokens mirroring the order app's Color.kt
  app.js         no framework
profiles/        editable text, hot-loaded, no rebuild needed
state/           rollback points, one JSON per Apply
```
