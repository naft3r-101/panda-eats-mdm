plugins {
    // No kotlin-android plugin: AGP 9 has built-in Kotlin and registers the `kotlin`
    // extension itself — applying org.jetbrains.kotlin.android on top collides with it.
    // Only the Compose compiler plugin is applied separately (mirrors the order app).
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "com.pandaeats.bench"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.pandaeats.bench"
        minSdk = 28
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            // R8 off for v1 — the app is tiny and the reflection-heavy bits (Moshi) would
            // need keep rules. Turn on with a proguard-rules.pro when the app grows.
            // No signingConfig here, so `assembleProdRelease` produces an UNSIGNED apk that
            // cannot be installed. For sideloading in v1, build a *debug* variant (below),
            // which is signed with the local debug keystore. Wire a real release keystore
            // (mirror the order app's signingConfigs) before shipping a production build.
            isMinifyEnabled = false
        }
    }

    // Per-environment flavors, mirroring the order app: each carries its own backend URL and
    // installs as a distinct app so prod/staging/dev can coexist on one tablet while testing.
    flavorDimensions += "env"
    productFlavors {
        create("prod") {
            dimension = "env"
            buildConfigField("String", "API_BASE_URL", "\"https://app.getpandaeats.com/\"")
            resValue("string", "app_name", "Panda Bench")
        }
        create("staging") {
            dimension = "env"
            isDefault = true
            applicationIdSuffix = ".staging"
            buildConfigField("String", "API_BASE_URL", "\"https://staging.getpandaeats.com/\"")
            resValue("string", "app_name", "Panda Bench (Staging)")
        }
        create("dev") {
            dimension = "env"
            applicationIdSuffix = ".dev"
            // 10.0.2.2 = emulator host alias; swap to your LAN IP for a physical tablet.
            buildConfigField("String", "API_BASE_URL", "\"http://10.0.2.2:3000/\"")
            resValue("string", "app_name", "Panda Bench (Dev)")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    buildFeatures {
        compose = true
        buildConfig = true
        resValues = true
    }
    packaging {
        resources {
            excludes += setOf("/META-INF/{AL2.0,LGPL2.1}")
        }
    }
}

dependencies {
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.security.crypto)

    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.coroutines.play.services)

    implementation(libs.retrofit)
    implementation(libs.retrofit.converter.moshi)
    implementation(libs.okhttp)
    implementation(libs.okhttp.logging)
    implementation(libs.moshi)
    implementation(libs.moshi.kotlin)

    implementation(libs.play.services.location)

    debugImplementation(libs.androidx.compose.ui.tooling)
}

// Convenience: copy freshly-built APKs into the repo's ../apk drop folder, which is what
// Panda Bench (the PC tool) sideloads from. Run after an assemble, e.g.:
//   ./gradlew :app:assembleDevDebug copyApksToBench
tasks.register<Copy>("copyApksToBench") {
    from(layout.buildDirectory.dir("outputs/apk"))
    include("**/*.apk")
    into(rootProject.layout.projectDirectory.dir("../apk"))
    // Flatten so every apk lands directly in apk/ (not under flavor/buildType subdirs).
    eachFile { path = name }
    includeEmptyDirs = false
}
