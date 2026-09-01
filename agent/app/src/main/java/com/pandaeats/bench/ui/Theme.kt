package com.pandaeats.bench.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Brand-ish green to echo the order app; a single light scheme is plenty for an internal tool.
private val PandaColors = lightColorScheme(
    primary = Color(0xFF0E7C5A),
    onPrimary = Color(0xFFFFFFFF),
    secondary = Color(0xFF2E7D32),
    background = Color(0xFFF7F8F7),
    surface = Color(0xFFFFFFFF),
    error = Color(0xFFB3261E),
)

@Composable
fun PandaBenchTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = PandaColors, content = content)
}
