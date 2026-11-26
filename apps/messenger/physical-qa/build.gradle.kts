import groovy.json.JsonSlurper
import java.security.MessageDigest
plugins {
    id("com.android.application") version "8.13.2"
    id("org.jetbrains.kotlin.android") version "2.2.21"
}
android {
    namespace = "com.vellivex.qa.physical"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.vellivex.qa.physical"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "alpha08-native-diagnostic"
        ndk { abiFilters.add("arm64-v8a") }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildTypes { release { isMinifyEnabled = false; isDebuggable = false } }
    sourceSets.getByName("main").java.srcDir(layout.buildDirectory.dir("productionSources"))
    packaging.resources.excludes += setOf("META-INF/AL2.0", "META-INF/LGPL2.1")
}
val pins = JsonSlurper().parse(file("../sdk/android-platform.json")) as Map<*, *>
val tls = configurations.create("tlsSupport")
dependencies {
    implementation(files(providers.gradleProperty("matrixSdkAar").get()))
    implementation("${pins["android_support_artifact"]}@aar")
    add(tls.name, "${pins["android_support_artifact"]}@aar") { isTransitive = false }
    implementation("net.java.dev.jna:jna:5.18.1@aar")
    implementation("androidx.annotation:annotation:1.9.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
}
val prepareProductionSources = tasks.register<Copy>("prepareProductionSources") {
    from("../android/app/src/main/java") {
        include("org/matrix/rustsdk/Android.kt", "com/vellivex/messenger/MessengerPlatform.kt", "com/vellivex/messenger/MessengerSessionStore.kt")
    }
    into(layout.buildDirectory.dir("productionSources"))
    inputs.files(tls)
    doLast {
        check(MessageDigest.getInstance("SHA-256").digest(tls.singleFile.readBytes()).joinToString("") {
            "%02x".format(it)
        } == pins["android_support_aar_sha256"])
    }
}
tasks.named("preBuild") { dependsOn(prepareProductionSources) }
