# Panda Bench Agent (`com.pandaeats.bench`)

The **on-device** companion to Panda Bench (the PC provisioning tool one folder up). Where the
PC tool reaches a tablet over USB, this agent is sideloaded onto the tablet so you can reach it
**remotely** while it sits on a restaurant counter.

## v1 scope (this build)

A plain, sideloaded app — **not** a Device Owner. It does exactly two things:

1. **Enroll under a customer.** Type the restaurant's tablet username + password (the same ones
   the order app pairs with, from the merchant dashboard). The agent registers itself under that
   restaurant via `POST /api/bench/enroll` and stores a device secret in
   `EncryptedSharedPreferences`. This uses a **separate** endpoint + table (`bench_devices`) from
   the order app's pairing, so enrolling the agent never revokes the order app.
2. **Report location + status.** A foreground service pulls a fused location on an interval
   (15 min) and posts it to `POST /api/bench/heartbeat` (battery, charging, app/OS version too),
   so you can see where each tablet is and whether it's alive.

Both endpoints are **not built yet** — see [`BACKEND_CONTRACT.md`](BACKEND_CONTRACT.md) for the
exact spec to add to `panda-eats-project`. Until they exist, enroll returns an error.

### Deliberately NOT in v1

These were scoped out on purpose, because a plain sideloaded app on Android genuinely cannot do
them (all require **Device Owner**, which the PC bench can set over USB on a factory-reset
tablet):

- **Uninstall-proofing** — a normal app can always be uninstalled from Settings.
- **See the screen** — needs MediaProjection (visible cast indicator) + a relay.
- **Remote control** — needs an AccessibilityService the OS won't silently enable.

The off-switch surrogate for now: **revoke the device server-side** (set `revoked_at`); the agent
gets `410` on its next heartbeat, clears its credential, and stops.

## Build

```bash
cd agent
./gradlew :app:assembleDevDebug     # points at http://10.0.2.2:3000 (local backend)
./gradlew :app:assembleProdDebug    # points at https://app.getpandaeats.com
./gradlew :app:copyApksToBench      # run AFTER an assemble — copies APKs into ../apk/
```

Flavors mirror the order app: **prod / staging / dev**, each a distinct `applicationId` suffix
so they coexist while testing. Toolchain is pinned to the order app (AGP 9.2.0, Kotlin 2.2.10,
compileSdk 36, minSdk 28). Debug builds are debug-signed and installable; wire a real release
keystore (mirror the order app's `signingConfigs`) before shipping a production build.

## Sideload + first run

1. `adb install -r -g apk/app-prod-debug.apk` (`-g` pre-grants runtime permissions; on Android
   11+ background location may still need "Allow all the time" chosen by hand).
2. Open **Panda Bench**, enter the restaurant's tablet username + password, tap **Enroll**.
3. Grant location ("Allow all the time" for reliable background reporting) and notifications.
4. A persistent "Panda Bench active" notification means it's reporting. Reboot re-arms it (with
   the Android 14 caveat noted in `BootReceiver`).

## Layout

```
app/src/main/java/com/pandaeats/bench/
  BenchApp.kt                 Application + tiny manual DI container
  MainActivity.kt             Compose host; enrollment -> permission -> service wiring
  ui/                         Theme + enroll/status screens (Compose)
  data/
    SecureStore.kt            EncryptedSharedPreferences credential (mirrors the order app)
    EnrollmentRepository.kt   enroll -> save credential
    net/                      Retrofit + Moshi, bearer marker interceptor, DTOs
  location/
    LocationAgentService.kt   foreground service: fused location -> heartbeat, 410 -> stop
  system/BootReceiver.kt      re-arm after reboot
```
