import com.android.build.api.variant.BuildConfigField
import groovy.json.JsonSlurper
import java.net.URI
import java.net.URISyntaxException
import java.security.MessageDigest

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// The universal release carries both complete native stacks in one installable APK.
val universalApk = providers.gradleProperty("messengerUniversalApk")
    .map { it.toBooleanStrict() }
    .orElse(false)

android {
    namespace = "com.vellivex.messenger"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.vellivex.messenger"
        minSdk = 26
        targetSdk = 36
        versionCode = 9
        versionName = "0.1.0-alpha09"
        if (universalApk.get()) {
            ndk { abiFilters += setOf("arm64-v8a", "x86_64") }
        }
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    buildTypes {
        debug {
            applicationIdSuffix = ".alpha"
            versionNameSuffix = "-test"
            buildConfigField("String", "PRODUCTION_SERVER_URL", "\"https://messenger.vellivex.com\"")
        }
        release {
            applicationIdSuffix = ".alpha"
            isDebuggable = false
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true; buildConfig = true }
    splits {
        abi {
            isEnable = !universalApk.get()
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

// A local SDK AAR has no transitive POM. Its Android TLS verifier needs the
// matching, production-only JVM support component from the pinned Cargo.lock.
val androidPlatformPinsFile = rootProject.file("../sdk/android-platform.json")
val nativeSdkPinsFile = rootProject.file("../sdk/sources.json")
val androidPlatformPins = JsonSlurper().parse(androidPlatformPinsFile) as Map<*, *>
val androidPlatformArtifact = androidPlatformPins["android_support_artifact"] as String
val androidPlatformSupport = configurations.create("androidPlatformSupport") {
    isCanBeConsumed = false
    isCanBeResolved = true
    isTransitive = false
}
dependencies { add(androidPlatformSupport.name, "$androidPlatformArtifact@aar") }
val verifyAndroidPlatformSupport = tasks.register("verifyAndroidPlatformSupport") {
    inputs.file(androidPlatformPinsFile)
    inputs.file(nativeSdkPinsFile)
    inputs.files(androidPlatformSupport)
    doLast {
        val nativePins = JsonSlurper().parse(nativeSdkPinsFile) as Map<*, *>
        val nativeSource = nativePins["rust_sdk"] as Map<*, *>
        check(androidPlatformPins["rust_sdk_commit"] == nativeSource["commit"]) {
            "Review Android TLS support when changing the pinned native SDK."
        }
        val actual = androidPlatformSupport.singleFile.inputStream().use { input ->
            val hash = MessageDigest.getInstance("SHA-256")
            val buffer = ByteArray(16_384)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                hash.update(buffer, 0, count)
            }
            hash.digest().joinToString("") { "%02x".format(it) }
        }
        check(actual == androidPlatformPins["android_support_aar_sha256"]) {
            "The Android TLS support AAR differs from the reviewed pin."
        }
    }
}
tasks.named("preBuild").configure { dependsOn(verifyAndroidPlatformSupport) }

abstract class GenerateDebugNetworkSecurity : Exec() {
    @get:OutputDirectory
    abstract val outputDirectory: DirectoryProperty
}
val generateDebugNetworkSecurity = tasks.register<GenerateDebugNetworkSecurity>("generateDebugNetworkSecurity") {
    dependsOn(verifyAndroidPlatformSupport)
    val generator = rootProject.file("generate-debug-network-security.py")
    inputs.file(generator)
    inputs.file(androidPlatformPinsFile)
    inputs.files(androidPlatformSupport)
    outputDirectory.set(layout.buildDirectory.dir("generated/res/debugNetworkSecurity"))
    doFirst {
        commandLine(
            "python3", generator.absolutePath,
            "--aar", androidPlatformSupport.singleFile.absolutePath,
            "--pins", androidPlatformPinsFile.absolutePath,
            "--output-dir", outputDirectory.get().asFile.absolutePath,
        )
    }
}
androidComponents {
    onVariants(selector().withBuildType("debug")) { variant ->
        variant.sources.res?.addGeneratedSourceDirectory(
            generateDebugNetworkSecurity, GenerateDebugNetworkSecurity::outputDirectory,
        )
    }
}

dependencies {
    implementation(files(matrixSdkAar))
    implementation("$androidPlatformArtifact@aar")
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
