package com.pandaeats.bench.data

import android.content.Context
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Holds the enrollment credential issued by `POST /api/bench/enroll`, backed by
 * `EncryptedSharedPreferences` (Android Keystore-rooted master key) so the device_secret
 * survives reboots encrypted at rest.
 *
 * Deliberately mirrors the order app's `SecureCredentialStore`: `commit()` (not `apply()`)
 * plus a read-back, because this credential is the only copy of the plaintext secret — a
 * write that silently didn't land would leave the agent posting location on a RAM-only
 * secret that vanishes on the next restart. Kept in a SEPARATE prefs file ("panda_bench")
 * from the order app so the two never collide on one tablet.
 */
class SecureStore(context: Context) {

    private val prefs = EncryptedSharedPreferences.create(
        context,
        "panda_bench",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    private val _credential = MutableStateFlow(load())
    val credential: StateFlow<DeviceCredential?> = _credential.asStateFlow()

    fun current(): DeviceCredential? = _credential.value

    /** Persist the enrollment credential. Returns false if it did not reach disk. */
    fun save(credential: DeviceCredential): Boolean {
        val committed = prefs.edit()
            .putString(KEY_DEVICE_ID, credential.deviceId)
            .putString(KEY_DEVICE_SECRET, credential.deviceSecret)
            .putString(KEY_RESTAURANT_ID, credential.restaurantId)
            .putString(KEY_RESTAURANT_NAME, credential.restaurantName)
            .commit()
        if (!committed) {
            Log.e(TAG, "enrollment credential did not persist — not reporting enrolled")
            return false
        }
        // Prove the round trip by identity (never log/compare the secret itself).
        if (load()?.deviceId != credential.deviceId) {
            Log.e(TAG, "credential did not read back after commit — not reporting enrolled")
            return false
        }
        _credential.value = credential
        return true
    }

    fun clear() {
        prefs.edit().clear().commit()
        _credential.value = null
    }

    private fun load(): DeviceCredential? {
        val deviceId = prefs.getString(KEY_DEVICE_ID, null) ?: return null
        val deviceSecret = prefs.getString(KEY_DEVICE_SECRET, null) ?: return null
        val restaurantId = prefs.getString(KEY_RESTAURANT_ID, null) ?: return null
        val restaurantName = prefs.getString(KEY_RESTAURANT_NAME, null) ?: return null
        return DeviceCredential(deviceId, deviceSecret, restaurantId, restaurantName)
    }

    private companion object {
        const val TAG = "BenchSecureStore"
        const val KEY_DEVICE_ID = "device_id"
        const val KEY_DEVICE_SECRET = "device_secret"
        const val KEY_RESTAURANT_ID = "restaurant_id"
        const val KEY_RESTAURANT_NAME = "restaurant_name"
    }
}

data class DeviceCredential(
    val deviceId: String,
    val deviceSecret: String,
    val restaurantId: String,
    val restaurantName: String,
)
