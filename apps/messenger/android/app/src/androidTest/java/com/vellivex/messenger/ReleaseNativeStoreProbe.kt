package com.vellivex.messenger

import android.content.pm.ApplicationInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.matrix.rustcomponents.sdk.*
import uniffi.matrix_sdk.BackupDownloadStrategy
import uniffi.matrix_sdk_crypto.CollectStrategy
import uniffi.matrix_sdk_crypto.DecryptionSettings
import uniffi.matrix_sdk_crypto.TrustRequirement
import java.util.UUID

/** Exercises the release process without sending any identity or token to a server. */
@RunWith(AndroidJUnit4::class)
class ReleaseNativeStoreProbe {
    @Test fun releaseKeystoreAndEncryptedSqliteCanServePublicVersions() = runBlocking {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        assertTrue(ctx.applicationContext is MessengerApplication)
        val target = InstrumentationRegistry.getArguments().getString("probeTarget")
        assertEquals(target == "debug", ctx.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
        val origin = "https://messenger.vellivex.com"
        val store = MessengerSessionStore(ctx, "probe-" + UUID.randomUUID().toString())
        val template = Session(accessToken = "local-fixture-never-submitted",
            refreshToken = null, userId = "@fixture:probe.invalid", deviceId = "FIXTURE",
            homeserverUrl = origin, oauthData = null, slidingSyncVersion = SlidingSyncVersion.NATIVE)
        val original = store.newSession(template)
        var stage = "keystore-write"
        try {
            store.write(original)
            stage = "keystore-read"
            val restored = requireNotNull(store.read())
            try {
                assertEquals(template, restored.session)
                assertEquals(original.storeId, restored.storeId)
                assertArrayEquals(original.storeKey, restored.storeKey)
                stage = "create-native-directory"
                val directory = store.sdkDirectory(restored)
                stage = "sqlite-builder"
                val client = SqliteStoreBuilder(directory.absolutePath, directory.absolutePath).use { plain ->
                    stage = "sqlite-key"
                    plain.key(restored.storeKey).use { sqlite ->
                        stage = "client-builder"
                        ClientBuilder().use { root ->
                            stage = "client-configuration"
                            root.homeserverUrl(origin).disableWellKnownLookup(true)
                                .sqliteStore(sqlite)
                                .slidingSyncVersionBuilder(SlidingSyncVersionBuilder.NATIVE)
                                .autoEnableCrossSigning(true)
                                .autoEnableBackups(false)
                                .backupDownloadStrategy(BackupDownloadStrategy.AFTER_DECRYPTION_FAILURE)
                                .enableShareHistoryOnInvite(false)
                                .roomKeyRecipientStrategy(CollectStrategy.ONLY_TRUSTED_DEVICES)
                                .decryptionSettings(DecryptionSettings(TrustRequirement.CROSS_SIGNED))
                                .use { stage = "client-build"; it.build() }
                        }
                    }
                }
                stage = "native-versions"
                client.use {
                    assertEquals(origin, it.homeserver().trimEnd('/'))
                    it.resetSupportedVersions()
                    withTimeout(35000) { it.isReportRoomApiSupported() }
                }
                assertTrue(directory.listFiles().orEmpty().any { it.isFile && it.length() > 0 })
            } finally {
                restored.storeKey.fill(0)
            }
        } catch (failure: Exception) {
            throw diagnosticFailure(stage, failure)
        } finally {
            original.storeKey.fill(0)
            store.clear()
        }
    }
}

// Emit only named categories and static source frames from known libraries.
internal fun diagnosticFailure(stage: String, error: Throwable): AssertionError {
    val chain = generateSequence(error) { it.cause }.take(6).toList()
    val details = chain.joinToString(" ") { it.message.orEmpty() }.lowercase()
    val categories = listOf("checksum mismatch", "contract version mismatch", "unexpected rust panic", "unexpected call status",
        "panic", "jna", "database", "sqlite", "key store", "provider", "certificate", "already", "network", "hostname",
        "linker", "dlopen", "cannot locate symbol", "android", "initialized", "thread", "java vm", "classloader",
        "class not found", "classnotfound", "null pointer", "java exception", "tls", "not found", "ffi", "incompatible",
        "unsupported", "already borrowed", "jni", "bindings", "mapping", "pointer", "alignment",
        "hardware", "dns", "tokio", "runtime", "reqwest", "trust anchor", "builder", "resource", "store key",
        "null", "backtrace", "uninitialized", "returned empty", "uniffi", "join error", "read-only").filter { it in details }
    val frames = chain.flatMap { it.stackTrace.asList() }.filter {
        it.className.startsWith("org.matrix.") || it.className.startsWith("uniffi.") || it.className.startsWith("com.sun.jna.")
    }.take(6).map { it.className.substringAfterLast('.') + "." + it.methodName }
    return AssertionError("NATIVE-DIAG stage=$stage type=" + chain.joinToString("/") { it.javaClass.simpleName } +
        " categories=" + categories.joinToString(",") + " frames=" + frames.joinToString(","))
}
