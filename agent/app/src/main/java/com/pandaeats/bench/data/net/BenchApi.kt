package com.pandaeats.bench.data.net

import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.Headers
import retrofit2.http.POST

interface BenchApi {

    /**
     * `POST /api/bench/enroll` — enroll this device under a restaurant using its tablet
     * credentials. Unauthenticated (no bearer): the username + password ARE the auth, in
     * the body. Returns the enrollment credential (device_secret) once.
     */
    @POST("api/bench/enroll")
    suspend fun enroll(@Body body: EnrollRequest): EnrollResponse

    /**
     * `POST /api/bench/heartbeat` — bearer-authed liveness + location report. Returns the
     * raw [Response] so the caller can act on 410 (device revoked) without an exception.
     */
    @Headers(DeviceAuthInterceptor.MARKER)
    @POST("api/bench/heartbeat")
    suspend fun heartbeat(@Body body: HeartbeatRequest): Response<Unit>
}
