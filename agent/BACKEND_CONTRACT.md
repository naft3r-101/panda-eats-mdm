# Panda Bench agent — backend contract

The agent APK (this folder) talks to two **new** endpoints that must be added to
`panda-eats-project` (repo `panda-eats`, `apps/web`). They deliberately mirror the existing
`POST /api/devices/register` + heartbeat patterns, with one hard rule:

> **Enrollment must never touch `paired_devices`.** `POST /api/devices/register` revokes any
> previously-active tablet for the restaurant (single-active-tablet rule). If the agent
> enrolled through that, it would knock the order app offline. The agent gets its **own**
> table (`bench_devices`) and its **own** secret.

Reference implementation to copy from:
`apps/web/src/app/api/devices/register/route.ts` (scrypt verify, rate limit, lockout, tenant
tx, `device_secret` = 32 random bytes, store SHA-256 hash, return plaintext once).

---

## New table — `bench_devices` (Drizzle migration, next number after 0151)

```sql
CREATE TABLE bench_devices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id      uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  platform           text NOT NULL,               -- 'android' | 'ios'
  os_version         text,
  device_model       text,
  app_version        text,
  device_secret_hash text NOT NULL,               -- sha256(device_secret), hex
  last_seen_at       timestamptz,
  last_latitude      double precision,
  last_longitude     double precision,
  last_accuracy_m    real,
  last_location_at   timestamptz,
  battery_level      integer,                      -- 0..100
  is_charging        boolean,
  revoked_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bench_devices_secret_hash_idx ON bench_devices (device_secret_hash);
CREATE INDEX bench_devices_restaurant_idx  ON bench_devices (restaurant_id);
```

Unlike `paired_devices`, **allow multiple active `bench_devices` per restaurant** (a location
may run the agent on more than one tablet). Enroll does NOT revoke prior rows.

---

## `POST /api/bench/enroll`  (unauthenticated — creds are in the body)

Auth is the restaurant's **tablet username + password** (same credentials the order app pairs
with, shown once in the merchant dashboard). Reuse `verifyPassword` against
`restaurants.tablet_password_hash`, the same per-restaurant rate limit, and the **same lockout
counter** (`tablet_auth_failed_attempts` / `tablet_auth_locked_until`) — a password guess is the
same threat whichever endpoint it hits, so the two flows should share the lockout.

Request:
```json
{
  "username": "…",           // restaurants.tablet_username
  "password": "…",
  "platform": "android",
  "os_version": "14",
  "device_model": "SM-T510",
  "app_version": "0.1.0"
}
```

On success: mint `device_secret = randomBytes(32).base64`, insert a `bench_devices` row with
its SHA-256 hash, return the plaintext **once**:
```json
{
  "device_id": "uuid",
  "device_secret": "base64…",
  "restaurant_id": "uuid",
  "restaurant_name": "Restaurant Name"
}
```

Status codes: `200` success · `400` missing fields · `401` bad/locked creds (identical body +
timing to register, to avoid a username-existence oracle) · `429` rate limited.

---

## `POST /api/bench/heartbeat`  (bearer = device_secret)

`Authorization: Bearer <device_secret>`. Look the device up by `sha256(secret)` in
`bench_devices`. Update last-known location + liveness. Moshi omits null fields, so treat any
absent field as "leave unchanged".

Request:
```json
{
  "latitude": 29.76,
  "longitude": -95.37,
  "accuracy_m": 12.5,
  "location_at": "2026-08-16T22:14:03Z",
  "battery_level": 84,
  "is_charging": true,
  "app_version": "0.1.0",
  "os_version": "14"
}
```

Behavior:
- Update `last_latitude/last_longitude/last_accuracy_m/last_location_at`, set
  `last_seen_at = now()`, and the battery/version fields when present.
- `204 No Content` on success.
- `401` if the bearer is missing or matches no row.
- `410 Gone` if the matched row has `revoked_at` set — the agent treats 410 as "revoked",
  clears its stored credential, and stops the service. (This is the off-switch / uninstall
  surrogate for v1: revoke server-side to make the tablet stop reporting.)

---

## Where the operator sees it (out of scope for the APK, noted for completeness)

"Check on the tablet" = a read view over `bench_devices` (last_seen, last location on a map,
battery). Natural home: the admin operations page that already lists `paired_devices`
(`apps/web/src/app/(admin)/admin/operations/page.tsx`), or a small `/admin/bench` view.
