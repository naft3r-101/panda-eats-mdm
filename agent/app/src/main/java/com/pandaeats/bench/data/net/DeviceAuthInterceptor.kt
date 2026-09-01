package com.pandaeats.bench.data.net

import com.pandaeats.bench.data.SecureStore
import okhttp3.Interceptor
import okhttp3.Response

/**
 * Attaches `Authorization: Bearer <device_secret>` to requests that opt in with the marker
 * header. Enroll carries no marker, so it goes out unauthenticated (its auth is the
 * username/password body).
 *
 * Intentionally simpler than the order app's interceptor of the same name: this app has one
 * bearer endpoint (heartbeat), so the 401/410 teardown policy lives in the caller
 * ([com.pandaeats.bench.location.LocationAgentService]) instead. A stray 401 must NOT
 * silently unenroll a counter tablet, so nothing here clears the credential.
 */
class DeviceAuthInterceptor(private val secureStore: SecureStore) : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        if (request.header(MARKER_NAME) == null) return chain.proceed(request)

        val secret = secureStore.current()?.deviceSecret
        val outgoing = request.newBuilder()
            .removeHeader(MARKER_NAME)
            .apply { secret?.let { header("Authorization", "Bearer $it") } }
            .build()
        return chain.proceed(outgoing)
    }

    companion object {
        /** Marker header name; stripped before the request leaves the device. */
        const val MARKER_NAME = "X-Panda-Device-Auth"

        /** Literal for Retrofit's `@Headers(...)` on bearer-authed endpoints. */
        const val MARKER = "$MARKER_NAME: 1"
    }
}
