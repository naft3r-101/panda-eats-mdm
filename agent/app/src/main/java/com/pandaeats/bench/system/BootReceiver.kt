package com.pandaeats.bench.system

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.pandaeats.bench.appContainer
import com.pandaeats.bench.location.LocationAgentService

/**
 * Re-arms the location agent after a reboot, if the tablet is enrolled.
 *
 * Caveat: Android 14+ restricts STARTING a `location`-type foreground service from the
 * background, and a boot broadcast may fall foul of that on some OEMs — hence the try/catch.
 * When it can't start on boot, opening the app once (routine on a counter tablet) re-arms it.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_LOCKED_BOOT_COMPLETED) {
            return
        }
        if (context.appContainer().secureStore.current() == null) return
        try {
            LocationAgentService.start(context)
        } catch (e: Exception) {
            Log.w("BenchBoot", "could not start location service on boot: ${e.message}")
        }
    }
}
