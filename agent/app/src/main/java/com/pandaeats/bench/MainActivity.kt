package com.pandaeats.bench

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import com.pandaeats.bench.location.LocationAgentService
import com.pandaeats.bench.ui.PandaBenchTheme
import com.pandaeats.bench.ui.RootScreen

class MainActivity : ComponentActivity() {

    private val locationGranted = mutableStateOf(false)

    private val foregroundPermsLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { result ->
        locationGranted.value = hasLocationPermission()
        val granted = result[Manifest.permission.ACCESS_FINE_LOCATION] == true ||
            result[Manifest.permission.ACCESS_COARSE_LOCATION] == true
        if (granted) {
            startAgentIfEnrolled()
            requestBackgroundLocationIfNeeded()
        }
    }

    // Best-effort: on Android 11+ this routes to the system "Allow all the time" flow.
    private val backgroundPermLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { /* nothing to do — foreground reporting works without it, this just improves it */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        locationGranted.value = hasLocationPermission()
        val container = appContainer()
        setContent {
            PandaBenchTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background,
                ) {
                    RootScreen(
                        container = container,
                        locationPermissionGranted = locationGranted.value,
                        onEnrolled = { ensurePermissionsAndStart() },
                        onRequestPermission = { ensurePermissionsAndStart() },
                        onUnenroll = {
                            container.secureStore.clear()
                            LocationAgentService.stop(this)
                        },
                    )
                }
            }
        }
        // Already enrolled + permitted from a previous run → make sure the agent is up.
        startAgentIfEnrolled()
    }

    override fun onResume() {
        super.onResume()
        locationGranted.value = hasLocationPermission()
    }

    private fun ensurePermissionsAndStart() {
        if (hasLocationPermission()) {
            startAgentIfEnrolled()
            requestBackgroundLocationIfNeeded()
            return
        }
        val perms = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            perms.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        foregroundPermsLauncher.launch(perms.toTypedArray())
    }

    private fun requestBackgroundLocationIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
            hasLocationPermission() &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_BACKGROUND_LOCATION) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            backgroundPermLauncher.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
        }
    }

    private fun startAgentIfEnrolled() {
        if (appContainer().secureStore.current() != null && hasLocationPermission()) {
            LocationAgentService.start(this)
        }
    }

    private fun hasLocationPermission(): Boolean {
        val fine = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
        val coarse = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION)
        return fine == PackageManager.PERMISSION_GRANTED || coarse == PackageManager.PERMISSION_GRANTED
    }
}
