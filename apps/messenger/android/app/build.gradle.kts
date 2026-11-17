import com.android.build.api.variant.BuildConfigField
import java.net.URI
import java.net.URISyntaxException

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.vellivex.messenger"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.vellivex.messenger"
        minSdk = 26
        targetSdk = 36
        versionCode = 5
        versionName = "0.1.0-alpha05"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    buildTypes {
        debug {
            applicationIdSuffix = ".alpha"
            versionNameSuffix = "-test"
            buildConfigField("String", "PRODUCTION_SERVER_URL", "\"https://messenger.vellivex.com\"")
        }
        release { isMinifyEnabled = false }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true; buildConfig = true }
    splits {
        abi {
            isEnable = true
            reset()
            include("arm64-v8a", "x86_64")
            isUniversalApk = false
        }
    }
    packaging { resources.excludes += setOf("META-INF/AL2.0", "META-INF/LGPL2.1") }
    testOptions { unitTests.isReturnDefaultValues = true }
}

val releaseServerUrl = providers.gradleProperty("messengerProductionServerUrl").orElse("").map { value ->
    val message = "Set -PmessengerProductionServerUrl to the HTTPS origin of the Vellivex messaging service for release builds."
    val uri = try {
        URI(value.trim())
    } catch (_: URISyntaxException) {
        throw GradleException(message)
    }
    val host = uri.host
    require(
        uri.scheme == "https" && host != null && uri.userInfo == null &&
            uri.rawPath in listOf("", "/") && uri.rawQuery == null && uri.rawFragment == null &&
            (uri.port == -1 || uri.port in 1..65_535),
    ) { message }
    URI("https", null, host, uri.port, null, null, null).toASCIIString()
}

androidComponents {
    onVariants(selector().withBuildType("release")) { variant ->
        checkNotNull(variant.buildConfigFields).put("PRODUCTION_SERVER_URL", releaseServerUrl.map { url ->
            BuildConfigField("String", "\"$url\"", "HTTPS origin for the Vellivex messaging service")
        })
    }
}

// The custom SDK is a complete AAR with matching generated Kotlin and native code.
// Falling back to upstream's unextended AAR would omit peer-device verification.
val matrixSdkAar = providers.gradleProperty("matrixSdkAar")
    .map { rootProject.file(it) }
    .getOrElse(rootProject.file("../sdk/build/vellivex-matrix-sdk-26.11.05-vellivex.1.aar"))
require(matrixSdkAar.isFile) {
    "Build ../sdk/build.sh first, or supply -PmatrixSdkAar=/absolute/path/vellivex-matrix-sdk.aar"
}

dependencies {
    implementation(files(matrixSdkAar))
    // File-based AARs do not carry Maven transitive dependency resolution.
    implementation("net.java.dev.jna:jna:5.18.1@aar")
    implementation("androidx.annotation:annotation:1.9.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.4")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.4")
    implementation(platform("androidx.compose:compose-bom:2025.10.01"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-core")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("com.google.zxing:core:3.5.3")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250517")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test:rules:1.7.0")
    androidTestImplementation(platform("androidx.compose:compose-bom:2025.10.01"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
