package com.pandaeats.bench.data.net

import android.os.Build
import com.pandaeats.bench.BuildConfig
import com.pandaeats.bench.data.SecureStore
import com.squareup.moshi.Moshi
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.moshi.MoshiConverterFactory
import java.util.concurrent.TimeUnit

/**
 * Builds the Moshi + OkHttp + Retrofit stack against `API_BASE_URL`, mirroring the order
 * app's NetworkModule. Moshi omits nulls by default (the heartbeat wants that — the server
 * updates only the fields present). Bearer auth is attached by [DeviceAuthInterceptor].
 */
class NetworkModule(secureStore: SecureStore) {

    private val moshi: Moshi = Moshi.Builder()
        .add(KotlinJsonAdapterFactory())
        .build()

    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .addInterceptor(userAgentInterceptor())
        .addInterceptor(DeviceAuthInterceptor(secureStore))
        .apply {
            if (BuildConfig.DEBUG) {
                // HEADERS not BODY: the enroll body carries the tablet password. Redact the
                // bearer so logcat never shows the long-lived device_secret.
                addInterceptor(
                    HttpLoggingInterceptor().apply {
                        level = HttpLoggingInterceptor.Level.HEADERS
                        redactHeader("Authorization")
                    },
                )
            }
        }
        .build()

    val benchApi: BenchApi = Retrofit.Builder()
        .baseUrl(BuildConfig.API_BASE_URL)
        .client(client)
        .addConverterFactory(MoshiConverterFactory.create(moshi))
        .build()
        .create(BenchApi::class.java)

    private fun userAgentInterceptor(): Interceptor = Interceptor { chain ->
        val ua = "PandaBenchAgent/${BuildConfig.VERSION_NAME} (Android ${Build.VERSION.RELEASE}; " +
            "${Build.MODEL}; ${Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown"})"
        chain.proceed(chain.request().newBuilder().header("User-Agent", ua).build())
    }
}
