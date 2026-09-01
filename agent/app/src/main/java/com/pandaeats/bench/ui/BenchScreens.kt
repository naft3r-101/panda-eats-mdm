package com.pandaeats.bench.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.pandaeats.bench.AppContainer
import com.pandaeats.bench.data.DeviceCredential
import com.pandaeats.bench.data.EnrollResult
import kotlinx.coroutines.launch

@Composable
fun RootScreen(
    container: AppContainer,
    locationPermissionGranted: Boolean,
    onEnrolled: () -> Unit,
    onRequestPermission: () -> Unit,
    onUnenroll: () -> Unit,
) {
    val credential by container.secureStore.credential.collectAsStateWithLifecycle()
    val current = credential
    if (current == null) {
        EnrollScreen(
            onEnroll = { username, password ->
                container.enrollmentRepository.enroll(username, password)
            },
            onEnrolled = onEnrolled,
        )
    } else {
        StatusScreen(
            credential = current,
            locationPermissionGranted = locationPermissionGranted,
            onRequestPermission = onRequestPermission,
            onUnenroll = onUnenroll,
        )
    }
}

@Composable
private fun EnrollScreen(
    onEnroll: suspend (String, String) -> EnrollResult,
    onEnrolled: () -> Unit,
) {
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Panda Bench", style = MaterialTheme.typography.headlineMedium)
        Text(
            "Enroll this tablet under a restaurant using its tablet username and password " +
                "(from the merchant dashboard).",
            style = MaterialTheme.typography.bodyMedium,
        )
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(
            value = username,
            onValueChange = { username = it },
            label = { Text("Tablet username") },
            singleLine = true,
            enabled = !loading,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            label = { Text("Tablet password") },
            singleLine = true,
            enabled = !loading,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth(),
        )
        error?.let {
            Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
        }
        Button(
            onClick = {
                loading = true
                error = null
                scope.launch {
                    when (val result = onEnroll(username, password)) {
                        is EnrollResult.Success -> onEnrolled()
                        is EnrollResult.Failure -> error = result.message
                    }
                    loading = false
                }
            },
            enabled = !loading && username.isNotBlank() && password.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
        ) {
            if (loading) {
                CircularProgressIndicator(modifier = Modifier.height(20.dp))
            } else {
                Text("Enroll")
            }
        }
    }
}

@Composable
private fun StatusScreen(
    credential: DeviceCredential,
    locationPermissionGranted: Boolean,
    onRequestPermission: () -> Unit,
    onUnenroll: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Panda Bench", style = MaterialTheme.typography.headlineMedium)
        Card(modifier = Modifier.fillMaxWidth()) {
            Column(
                modifier = Modifier.padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Text("Enrolled under", style = MaterialTheme.typography.labelMedium)
                Text(credential.restaurantName, style = MaterialTheme.typography.titleMedium)
                Text(
                    "Device ${credential.deviceId.take(8)}",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }

        if (locationPermissionGranted) {
            Text(
                "Reporting location and status.",
                style = MaterialTheme.typography.bodyMedium,
            )
        } else {
            Text(
                "Location permission is needed so this tablet can report where it is. " +
                    "Grant it, and choose \"Allow all the time\" for reliable reporting.",
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodyMedium,
            )
            Button(onClick = onRequestPermission, modifier = Modifier.fillMaxWidth()) {
                Text("Grant location access")
            }
        }

        Spacer(Modifier.weight(1f))
        TextButton(
            onClick = onUnenroll,
            modifier = Modifier.align(Alignment.CenterHorizontally),
        ) {
            Text("Unenroll this tablet", color = MaterialTheme.colorScheme.error)
        }
    }
}
