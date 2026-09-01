package com.pandaeats.bench.data

import android.os.Build
import com.pandaeats.bench.BuildConfig
import com.pandaeats.bench.data.net.BenchApi
import com.pandaeats.bench.data.net.EnrollRequest
import retrofit2.HttpException
import java.io.IOException

sealed interface EnrollResult {
    data class Success(val credential: DeviceCredential) : EnrollResult
    data class Failure(val message: String) : EnrollResult
}

/**
 * Enrolls this device under a restaurant using its tablet username/password, then persists
 * the returned credential. Enrollment is a one-time action; after it the location service
 * carries the device_secret as bearer.
 */
class EnrollmentRepository(
    private val api: BenchApi,
    private val secureStore: SecureStore,
) {
    suspend fun enroll(username: String, password: String): EnrollResult {
        return try {
            val resp = api.enroll(
                EnrollRequest(
                    username = username.trim(),
                    password = password,
                    osVersion = Build.VERSION.RELEASE ?: "unknown",
                    deviceModel = Build.MODEL ?: "unknown",
                    appVersion = BuildConfig.VERSION_NAME,
                ),
            )
            val id = resp.deviceId
            val secret = resp.deviceSecret
            val restaurantId = resp.restaurantId
            val restaurantName = resp.restaurantName
            if (id.isNullOrBlank() || secret.isNullOrBlank() ||
                restaurantId.isNullOrBlank() || restaurantName.isNullOrBlank()
            ) {
                return EnrollResult.Failure("Unexpected response from the server.")
            }
            val credential = DeviceCredential(id, secret, restaurantId, restaurantName)
            if (secureStore.save(credential)) {
                EnrollResult.Success(credential)
            } else {
                EnrollResult.Failure("Could not save the credential on this device.")
            }
        } catch (e: HttpException) {
            when (e.code()) {
                400 -> EnrollResult.Failure("Enter both a username and password.")
                401 -> EnrollResult.Failure("Invalid tablet username or password.")
                429 -> EnrollResult.Failure("Too many attempts. Wait a bit and try again.")
                else -> EnrollResult.Failure("Server error (${e.code()}). Try again.")
            }
        } catch (e: IOException) {
            EnrollResult.Failure("Network error. Check the tablet's connection.")
        } catch (e: Exception) {
            EnrollResult.Failure("Enrollment failed: ${e.message ?: "unknown error"}")
        }
    }
}
