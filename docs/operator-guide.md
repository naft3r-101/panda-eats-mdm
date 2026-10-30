# Panda Bench operator guide

Tablet provisioning workbench for Panda Eats order-taking tablets.

You plug a tablet into your PC over USB, run an audit, hit Apply, and it comes out debloated,
tuned for always-on counter duty, and set up so the order listener does not get put to sleep by
Android's battery managers.

**No root. No factory reset. Permanent app deletions are listed before Apply.** It is a GUI over `adb`, which means it works
on a tablet that is already in the field, including one that is already paired to a restaurant.

---

## What it does

| Area | What happens |
| ---- | ------------ |
| **Speed** | Window and transition animations off, animator scale halved, app caches trimmed |
| **Debloat** | For packages named in a bloat profile, read pm path. Apps in /data/app are deleted for good with their data. Built-in apps under /system, /product or /vendor are switched off for user 0. Protected and Panda Eats apps are never removed |
| **Always-on** | Screen never sleeps while plugged in, 30 minute timeout when unplugged, no screensaver |
| **Audible** | Do Not Disturb off, media volume pinned to the device maximum |
| **Readable** | Adaptive brightness off, no pre-sleep dim, no battery-saver brightness limiter, screen held at 80% of the tablet's own maximum or higher |
| **Background survival** | Order app added to the doze whitelist, standby bucket forced to `active`, background app-ops allowed, adaptive battery and app standby turned off. Where DuraSpeed is installed, its app and both background controls are switched off and read back |
| **Allowed to alert** | The notification and Bluetooth runtime permissions granted to the order app. Play grants neither; a Play-installed build starts silent |
| **Nothing in the way** | A swipe-only lock screen turned off, so orders are on screen the moment the tablet is. A PIN is reported, never removed |
| **Battery longevity** | 80% on Samsung with One UI 6.1 Maximum, 60% on Lenovo with Battery protection mode. Older Samsung versions use 85%. Samsung fast charging is switched off. Each brand uses its own control, read back after Apply |
| **Wallpaper** | Optional in Apply: counter, dark, light, or your own image. Sets home and lock screens without a tap, saves the old wallpaper for Revert, and checks both wallpaper IDs |
| **Clock** | Automatic date, time and time zone on. A drifted clock breaks the backend connection and prints wrong times |
| **Network** | Wi-Fi scan throttling off, Wi-Fi stays up while asleep, captive-portal nagging off |

### What it deliberately does NOT do

These were decisions, not omissions.

- **Google Play is untouched.** Auto-update stays exactly as the tablet had it. Play is how the
  order app reaches the field, and an automatic update can also change a tablet without warning.
  Panda Bench takes no position on that tradeoff.
- **No lockdown.** The browser, Play Store, and Galaxy Store stay reachable. Tablets remain
  general-purpose. Nothing is pinned to the order app.
- **Only named apps can be deleted.** Bench never uninstalls an app unless a bloat profile names it,
  its install path is /data/app, and it passes the guard list. Apps the restaurant installed that
  are not in the profile stay alone. Deleted apps and their data cannot be restored by Bench.
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

An installed copy checks the public releases repo,
[naft3r-101/panda-bench-releases](https://github.com/naft3r-101/panda-bench-releases), when it
starts, and **Updates** in the sidebar checks on demand. A new version downloads quietly in the background and a popup offers to install it; it
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

Four numbered steps across the top, in the order a tablet goes through them: **Set up**,
**Tune**, **Check**, **Ship**. Each step owns exactly one filled button, in the bar along the
bottom. Everything that is not part of that line lives in one of the two menus.

```
1. Plug tablet in       -> verify: it appears in the sidebar with its model name, and the strip
                                   under its name says whether it was ever provisioned
2. Step 1, Set up       -> verify: the order app is installed (Play, or an APK file)
3. Step 2, Tune         -> verify: the plan lists every change it is about to make, and
                                   "What the tablet looks like" shows why (read-only until Apply)
4. Aggressive tier?     -> verify: the plan re-reads the tablet and the counts move
5. Apply                -> verify: every line in the log drawer is a green check
6. Reboot the tablet    -> verify: the plan re-reads to "Nothing to apply"
7. Step 3, Check        -> verify: Overall says Ready; every red row is gone; a test slip printed
8. Tick the checklist   -> verify: pair, Wi-Fi, printer, test order - the taps only a human
                                   can do, kept per tablet
9. Step 4, Ship         -> verify: the handover is on the tablet and USB debugging is off
```

Step 6 matters. Some settings only fully take effect after a reboot, and an audit on a freshly
rebooted tablet is the only audit worth trusting.

Step 7 is the difference between "matches the profile" and "can take an order". Step 2 answers
the first question; step 3 answers the second, from the tablet's own point of view.

**The audit and the plan are the same read**, which is why they share a step. One call to
`preview()` returns the audit and the exact plan Apply would execute, built by the single planner
in `provision.js`; the plan separates **Delete for good** from **Switch off** at the top of step 2. The audit detail (device, order app,
settings, bloat) folds away underneath it. There is no way for the preview and the execution to
disagree about what "disable this package" means.

### Where everything else is

Nothing was removed in the move to four steps; the once-a-month controls were gathered up so the
forty-times-a-day ones stand alone.

| Menu | Holds |
| ---- | ----- |
| **Tablet actions**, top right | Set wallpaper, open the tablet's system update screen, reboot, power off |
| **Bench settings**, bottom left | Check for updates, locate adb, open the profiles folder, open the rollback folder |
| **Rollback & cleanup**, off the end of the step rail | Rollback points, and Discover - scanning for packages no profile covers |

The **log** is one drawer along the bottom for the whole app rather than one per step. It opens
itself the moment a run starts, and the bar keeps the last line visible when it is shut.

The strip under the tablet's name is the only place a warning appears outside a step: an MDM
owning the tablet, counter-readiness drift, and what the tablet's own record says about when it
was last provisioned.

**Apply still re-reads the tablet at execution time.** The preview on screen may be minutes old,
or may belong to a tablet you have since unplugged, so the plan that actually runs is always built
from a read taken at that moment. If the two differ, the log is the truth.

### Step 1, Set up

Two things a fresh tablet needs that Provision cannot do unattended, because each one ends in a
tap on the tablet's own screen. They are deliberately kept out of Apply - burying a step that
needs a human inside a batch that otherwise runs by itself would make Apply a liar about having
finished.

**Install the order app.** Two paths, because there are genuinely two:

- *From Google Play* - the production path. Opens the app's listing on the tablet so you tap
  Install there. Play needs a signed-in Google account on the device, so there is no remote way to
  drive it.
- *From an APK file* - scans the order app's local build output and your Downloads folder,
  reads each APK with `aapt2` and shows its applicationId, version and flavour **before** you
  install anything. Installs with `-r` (keeps app data) and `-g` (pre-grants runtime permissions),
  then applies the background tuning automatically and offers to launch it.

  The flavour matters and the tool says so out loud. The production build carries no
  applicationIdSuffix, so installing it **replaces** a Play-installed build rather than sitting
  beside it. If the tablet is paired and the signing keys differ the install fails outright; if
  they match, the live app is replaced. `.staging` and `.dev` install alongside and are safe.
  Panda Bench shows a red warning whenever the chosen APK would replace something already there.

#### Will a sideloaded app still update itself?

Only if two things are both true, and the audit now tells you about both.

1. **A Google account is signed in.** With none, Play cannot install or update anything, so every
   future build has to arrive over a USB cable. The audit on step 2 reports the account state and warns
   when there is none, because a tablet that can never update itself is a thing you want to know
   about before it leaves the bench, not three months later.

2. **The APK's signing certificate matches the one Play distributes.** The order app is published
   as an AAB, so Play App Signing re-signs it with Google's key - which is not the local
   upload keystore unless that key was uploaded as the app signing key. Step 1 reads each
   APK's certificate with `apksigner` and shows whether it is debug- or release-signed. A
   debug-signed build can never be updated by Play and cannot even install over a Play build; it
   fails with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`.

So there are three workable routes: sign an account in once and let Play handle updates (the
documented production path), sideload with no account and own every update yourself, or sideload a
release-signed build after verifying its certificate matches Play's. Either way the heartbeat's
`min_supported_version_code` is the backstop - a tablet stuck on an old build gets flagged
server-side.

**System update.** Shows the tablet's security patch level and how old it is, and opens the update
screen on the device. Firmware updates are signed and vendor-driven; nothing can apply one over
adb.

### Wallpaper with Apply

In step 2, choose **Wallpaper with Apply > Choose wallpaper**. Pick counter, dark, light,
or **Use my own image**, then **Use this wallpaper with Apply**. The plan includes the choice.
**Keep current wallpaper** removes it from the plan. Tablet actions > Set wallpaper also works
on its own and creates its own rollback point.

Bench installs a small helper with Android's normal SET_WALLPAPER permission. It saves the old
home and lock images to the rollback folder before changing either. On Android 11 and later,
it temporarily allows storage access to read the old wallpaper, then restores that access and
disables the helper. It does not uninstall anything. There is no network connection, launcher,
location access, or enrollment. Only the USB shell can call the helper.

The image fills the screen with a centered crop. Width and height use the same scale, so the
463 by 401 panda logo keeps its shape. A wide image on a tall screen loses its outer edges.
Bench sets home and lock separately, then reads both IDs from dumpsys wallpaper. A successful
command alone does not count. Revert restores both images, including a lock screen that used
to share the home wallpaper, and reads the result back.

If backup or automatic setting fails, Bench opens the existing picker and says the wallpaper
is **not confirmed**. Finish it on the tablet. Apply ends with a warning, not a success message.
A live wallpaper needs manual backup. An active wallpaper restriction stops the operation.

### Lenovo Tab M8 HD and MediaTek

The Lenovo profile covers the TB-8505F as well as the older TB-X606F. It covers the demo,
What's New, Kid's Mode, support helper, SIM lock helper, Dolby Audio controls, Digital Turbine,
and the listed preloaded games and news apps. It covers apps in /data/app as well as system apps.
**com.dolby.daxservice stays protected** because it is the audio engine used for order chimes.

The audit calls out Grubhub's order app and helpers and SureLock kiosk software in plain words.
These may be leftovers from a previous operator. Apply deletes them for good when pm path places
them in /data/app. Built-in copies are switched off. The audit shows which action applies.
Already uninstalled packages are skipped; Bench does not reinstall them for a test.

On any brand with com.mediatek.duraspeed, Background survival shows the package state and both
system and global setting.duraspeed.enabled values. Apply sets both to 0 and disables the app.
The TB-8505F's DuraSpeed app reads system and writes both keys. Its framework service watches
global and reads system on user switch. Writing only system leaves the running service unchecked.

Lenovo Battery protection mode stops charging at **60%, not 80%**. On HGT502R3, switching it off
and on in Settings changed only system battery_protected_charge between 0 and 1. The Samsung
global protect_battery value did not move. Apply uses the Lenovo key only on Lenovo tablets.
If that control is absent, the audit says it is not confirmed and asks the operator to check
Settings > Battery. Storing an unused key is not proof of a charging limit.

See [the HGT502R3 test record](validation/HGT502R3-2026-10-30.md) for device readbacks and screenshots.

### Aggressive tier

Off by default. It adds a second list: Photos, Drive, Maps, Gmail,
Galaxy Store, Samsung Cloud, Samsung Notes, and similar. Bigger speed win, but the tablet loses
real features. Fine for a tablet that only ever runs the order app. Think twice if the restaurant
uses it for anything else.

The same install-path rule applies: /data/app entries are deleted for good, built-in apps are
switched off, and protected apps stay untouched. Check the permanent-deletion list before Apply.

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

**Deleted apps and their data cannot be restored by Bench.** The audit and Apply plan list
them separately before deletion. Rollback points record these deletions as permanent, not as
apps that can be re-enabled. If needed later, reinstall and set up those apps separately.

Every Apply writes a rollback point **before it touches the device**, so even a crash mid-run
leaves a record of the run. Rollback & cleanup lists them per tablet. Reverting the reversible changes:

- puts every setting back to the exact value it held (or unsets it, if it was unset)
- re-enables every package that run disabled
- restores the doze exemption, standby bucket, and app-ops to what they were
- restores the previous media volume and screen brightness
- restores home and lock wallpapers saved by that run

Rollback points live in `state/` during development, and in the app's userData folder once
packaged. **Bench settings > Open rollback folder** takes you there.

Reverting also revokes the runtime permissions that run granted and turns a lock screen that run
switched off back on.

### Step 3, Check

Read-only, and meant for the moment after the reboot. Where the audit asks "does this tablet match
the profile", Verify asks "can it take an order right now", and it asks the tablet rather than the
PC:

| Check | How it is read |
| ----- | -------------- |
| Order app installed, and the **production** build | `pm list packages`, exact match. A `.staging` or `.dev` build beside it is a test tool and does not count |
| Order listener running as a foreground service | `dumpsys activity services`, split into exact-keyed records the same way the package dump is. The `.staging` build's service cannot stand in for prod's |
| Notifications and Bluetooth allowed | The `runtime permissions:` section of the exact package block. The install permissions above it print `granted=true` too, and always will |
| Survives in the background | Doze whitelist, standby bucket, app-ops - the same three reads the audit makes |
| On the build Play is serving | The production track, read through the Play Developer API with the order app's own publishing service account (`PANDA_BENCH_PLAY_KEY`, or the default path in `electron/play.js`). A tablet behind is a warning, not a block; without the key the row is skipped and says so |
| On Wi-Fi, with a usable signal | `cmd wifi status`: network name, address, RSSI. Below -70 dBm is flagged |
| Reaches Panda Eats | One `ping` **from the tablet** to `app.getpandaeats.com`. What this PC can reach says nothing about a tablet on the restaurant's Wi-Fi |
| Reaches the printer | Same, against the address you type in. Remembered per tablet. USB and Bluetooth printers have no address; leave it empty and the row is skipped |
| Clock set automatically | `auto_time`, `auto_time_zone`, and the tablet's epoch against this PC's. More than a minute out is red |
| No lock screen | `locksettings get-disabled` plus the credential type. Swipe-only is red and Apply fixes it; a PIN is red and only a human can |
| Battery healthy | Health and temperature from `dumpsys battery`. A warning, never a block |
| Google account signed in | So Play can update the app. A warning |
| Provisioned with the current profile | The record on the tablet (below) against a fingerprint of `profiles/` as it is now |

Only red rows make the tablet **Not ready**. Each one says where it gets fixed: step 2, step 1,
"Open order app on tablet", or the tablet's own screen.

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

To grow a list: run **Discover**, under Rollback & cleanup, against a real tablet. It shows every system package that
no profile mentions and that is not protected. Paste the junk you recognise into the OEM file and
re-audit. The Lenovo list in particular is thin and expects this.

Adding a new OEM is one file: `profiles/bloat/<manufacturer>.txt`, lowercased to match
`ro.product.manufacturer`. Unknown manufacturers fall back to `common.txt` alone, which is safe.

---

## Safety

The guard list applies to both switching apps off and deleting apps, so it is worth knowing
exactly what protects you.

**A package is never deleted or switched off if any of these is true:**

- it is in `profiles/protected.txt` (58 entries: framework, providers, WebView, GMS, Play, keyboards, launchers, Chrome)
- it is the device's **current keyboard**, resolved live from `default_input_method`
- it is the device's **current launcher**, resolved live from `resolve-activity HOME`
- it is one of Panda Eats' own packages
- it is not actually installed on this tablet

The last one is why an over-broad list is safe rather than dangerous: entries that do not exist are
skipped silently, and the audit shows you exactly which ones were found before anything is touched.

Protected packages that appear in a bloat list are shown in the audit with the reason they were
blocked, rather than being hidden.

### Permanent deletion or switching off

For every installed package named in the selected bloat profile, the audit reads pm path.
All split APK paths must agree. Paths under /data/app mean **Delete for good** with pm uninstall.
Paths under /system, /product, /vendor, /system_ext, /odm or /oem mean **Switch off** with
pm disable-user --user 0. Unknown, unreadable or mixed paths are skipped and reported.
An updated system app in /data/app may return Success after removing only its update. Bench
checks again, reports that the built-in copy remains, and does not claim deletion. Re-read the
tablet and Apply again to switch off that copy. The removed update and its data cannot be restored
by Bench.

The plan lists permanent deletions separately, including each package and its path. Check this
list before pressing Apply on a restaurant's tablet. Apply re-reads the profile, path, keyboard,
launcher and protected list before each deletion. Afterward, it checks the installed package list
to confirm the exact package is gone. A successful command alone is not proof. Disabled system
apps are also read back. Skip debloat skips both kinds of action. Discover still only switches
apps off; it cannot permanently delete packages that no bloat profile names.

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

2. **`dumpsys package <pkg>` prefix-matches.** Asking about the production package returns the
   `.staging` and `.dev` blocks too, and reading the first `versionName` you find gives a
   confidently wrong answer about which build is on the tablet. Panda Bench splits the dump into
   exact-keyed blocks so this cannot happen. This is a documented, repeatedly-rediscovered trap in
   the order-app repo.

---

## When another MDM already owns the tablet

The audit checks for an existing Device Owner or Profile Owner and puts a red notice at the
top of the page when it finds one. This matters more than anything else on that screen: a Device
Owner outranks adb completely. It can re-enable packages Panda Bench disables and re-impose
settings at its next sync, so everything this tool does to such a tablet is provisional.

**It cannot be removed with adb.** All three routes are refused - verified on an MDM-enrolled
Samsung tablet running Android 14:

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

- **Applying a firmware update.** Signed and vendor-driven. Panda Bench opens the update screen and
  tells you how stale the patch level is; the taps are yours.

- **Installing from Google Play.** Needs a Google account signed in on the device. Panda Bench
  opens the right listing so there is nothing to type.

- **Samsung "Sleeping apps"** is not a gap after all. The doze exemption Apply sets is what
  Settings > Apps > PE Orders > Battery shows as **Unrestricted**, Samsung's sleeper skips such
  apps, and its pickers do not even offer them. If a Samsung tablet goes quiet overnight, check that
  page reads Unrestricted (step 3's "Survives in the background" row is the same fact).
- **Battery optimization dialog.** The order app already fires this itself once per pairing
  (`MainActivity.maybeRequestBatteryExemption`), so accept it when it appears.
- **A screen lock with a code.** Swipe-only is handled: `locksettings set-disabled true` turns it
  off and Apply does that. A PIN, pattern or password needs the code itself, so it is reported on
  the audit and step 3 and left alone.
- **Wi-Fi credentials and Google sign-in.** Manual. `cmd wifi connect-network` exists but is
  refused to the shell user on One UI 6.1, so there is no adb path onto a network.
- **Play auto-update.** A per-app toggle inside the Play Store UI. Untouched by decision, and
  unreadable over adb - step 3 checks the outcome instead (is the tablet on the build Play
  is serving).

The ones that need a tap are on step 3's checklist, so they get ticked rather than
remembered.

---

## Limits

- Windows only in practice. The adb discovery paths are Windows paths, though nothing else is
  platform-specific.
- USB only. There is no `adb connect` path, so fixing a tablet in the field means being in front of
  it. Fleet *monitoring* is a different job and already has a home: the order app's heartbeat to the
  Panda Eats backend reports battery, OS version, app version, and printer status.
- One tablet at a time.
- The Lenovo list covers TB-X606F and TB-8505F. Other models may have extra packages; use Discover.
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
a protected package**. Add a sample to
`test/adb.test.js` whenever a new dump shape bites.

`.github/workflows/ci.yml` runs the suite on our self-hosted runners on every push and PR. It skips
the Electron binary download, because nothing in the suite launches Electron.

---

## Layout

```
electron/
  main.js        window + IPC handlers
  preload.js     the entire renderer surface (contextIsolation on, nodeIntegration off)
  adb.js         adb plumbing: run, normalise, parse. No policy.
  provision.js   the engine: audit, apply, revert, verify, test slip, ship, discover. All policy.
  profiles.js    loads the text profiles, fingerprints them
  wallpaper.js   USB helper, wallpaper backup and readback
  play.js        what Play is serving, via the Developer API and the order app's service account
renderer/
  index.html     four tabs: Setup, Provision, Verify, Tools
  styles.css     brand tokens mirroring the order app's Color.kt
  app.js         no framework
wallpaper-helper/ small Android helper source, no network or background service
profiles/        editable text, hot-loaded, no rebuild needed
  settings/      Samsung, Lenovo, and package-gated MediaTek controls
state/           rollback points, one JSON per Apply
  handover/      the per-tablet checklist and printer address
test/            node:test suites for the parsers, planner, checks and profiles
```
