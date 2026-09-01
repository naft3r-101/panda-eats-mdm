package com.pandaeats.bench.location

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.os.BatteryManager
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import com.pandaeats.bench.BuildConfig
import com.pandaeats.bench.MainActivity
import com.pandaeats.bench.R
import com.pandaeats.bench.appContainer
import com.pandaeats.bench.data.net.HeartbeatRequest
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import java.time.Instant
import java.util.concurrent.TimeUnit

/**
 * Foreground service that reports this tablet's location + liveness to the backend on an
 * interval. Foreground (with a visible, ongoing notification) is mandatory for a plain,
 * non-Device-Owner app to keep receiving location while idle — and it's the honest shape:
 * the tablet shows it is being managed.
 *
 * Stops itself if enrollment is cleared or the server answers 410 (device revoked).
 */
class LocationAgentService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var loopStarted = false
    private val fused by lazy { LocationServices.getFusedLocationProviderClient(this) }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val credential = appContainer().secureStore.current()
        if (credential == null) {
            // Not enrolled — nothing to report. Don't sit as a foreground service.
            stopSelf()
            return START_NOT_STICKY
        }
        startForegroundNotification(credential.restaurantName)
        if (!loopStarted) {
            loopStarted = true
            scope.launch { reportLoop() }
        }
        return START_STICKY
    }

    private suspend fun reportLoop() {
        val store = appContainer().secureStore
        val api = appContainer().benchApi
        while (currentCoroutineContext().isActive) {
            if (store.current() == null) {
                stopForegroundAndSelf()
                return
            }
            if (hasLocationPermission()) {
                val location = runCatching { currentLocation() }.getOrNull()
                if (location != null) {
                    val (battery, charging) = batteryStatus()
                    val body = HeartbeatRequest(
                        latitude = location.latitude,
                        longitude = location.longitude,
                        accuracyMeters = if (location.hasAccuracy()) location.accuracy else null,
                        locationAt = Instant.ofEpochMilli(location.time).toString(),
                        batteryLevel = battery,
                        isCharging = charging,
                        appVersion = BuildConfig.VERSION_NAME,
                        osVersion = Build.VERSION.RELEASE,
                    )
                    val response = runCatching { api.heartbeat(body) }.getOrNull()
                    if (response?.code() == 410) {
                        // The backend revoked this device — forget the credential and shut down.
                        store.clear()
                        stopForegroundAndSelf()
                        return
                    }
                }
            }
            delay(REPORT_INTERVAL_MS)
        }
    }

    @SuppressLint("MissingPermission") // guarded by hasLocationPermission() before every call
    private suspend fun currentLocation(): Location? {
        val cts = CancellationTokenSource()
        return fused.getCurrentLocation(Priority.PRIORITY_BALANCED_POWER_ACCURACY, cts.token).await()
    }

    private fun hasLocationPermission(): Boolean {
        val fine = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
        val coarse = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION)
        return fine == PackageManager.PERMISSION_GRANTED || coarse == PackageManager.PERMISSION_GRANTED
    }

    private fun batteryStatus(): Pair<Int?, Boolean?> {
        val bm = getSystemService(BatteryManager::class.java) ?: return null to null
        val level = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY).takeIf { it in 0..100 }
        return level to bm.isCharging
    }

    private fun startForegroundNotification(restaurantName: String) {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Panda Bench",
                NotificationManager.IMPORTANCE_LOW,
            ).apply { description = "Reports this tablet's status and location to Panda Bench." }
            nm.createNotificationChannel(channel)
        }
        val tapIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_bench)
            .setContentTitle("Panda Bench active")
            .setContentText("Reporting status for $restaurantName")
            .setOngoing(true)
            .setContentIntent(tapIntent)
            .build()
        ServiceCompat.startForeground(
            this,
            NOTIF_ID,
            notification,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
            } else {
                0
            },
        )
    }

    private fun stopForegroundAndSelf() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL_ID = "bench_agent"
        private const val NOTIF_ID = 42
        private val REPORT_INTERVAL_MS = TimeUnit.MINUTES.toMillis(15)

        fun start(context: Context) {
            ContextCompat.startForegroundService(
                context,
                Intent(context, LocationAgentService::class.java),
            )
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, LocationAgentService::class.java))
        }
    }
}
