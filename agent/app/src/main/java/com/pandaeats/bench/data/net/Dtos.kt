package com.pandaeats.bench.data.net

import com.squareup.moshi.Json

/**
 * Body for `POST /api/bench/enroll` — the management-agent equivalent of the order app's
 * `POST /api/devices/register`. Auth is the restaurant's tablet username + password (the
 * same credentials shown once in the merchant dashboard). The server verifies them and
 * writes a row to `bench_devices` WITHOUT touching `paired_devices`, so enrolling the
 * agent never revokes the order app's pairing.
 */
data class EnrollRequest(
    val username: String,
    val password: String,
    val platform: String = "android",
    @Json(name = "os_version") val osVersion: String,
    @Json(name = "device_model") val deviceModel: String,
    @Json(name = "app_version") val appVersion: String,
)

/**
 * Response from enroll. Fields nullable so a malformed body surfaces as a handled error
 * rather than a Moshi parse crash. `device_secret` is the only chance to capture the
 * plaintext — store it and forget.
 */
data class EnrollResponse(
    @Json(name = "device_id") val deviceId: String? = null,
    @Json(name = "device_secret") val deviceSecret: String? = null,
    @Json(name = "restaurant_id") val restaurantId: String? = null,
    @Json(name = "restaurant_name") val restaurantName: String? = null,
)

/**
 * Body for `POST /api/bench/heartbeat` — bearer-authed with the device_secret. Reports the
 * agent's last-known location plus liveness. Null fields are omitted by Moshi (no
 * serializeNulls), so the server updates only what's present.
 */
data class HeartbeatRequest(
    val latitude: Double,
    val longitude: Double,
    @Json(name = "accuracy_m") val accuracyMeters: Float?,
    @Json(name = "location_at") val locationAt: String?,
    @Json(name = "battery_level") val batteryLevel: Int?,
    @Json(name = "is_charging") val isCharging: Boolean?,
    @Json(name = "app_version") val appVersion: String?,
    @Json(name = "os_version") val osVersion: String?,
)
