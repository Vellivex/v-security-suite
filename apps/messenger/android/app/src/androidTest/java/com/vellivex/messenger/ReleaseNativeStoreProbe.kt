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
        assertEquals(0, ctx.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE)
        val origin = "https://messenger.vellivex.com"
        val store = MessengerSessionStore(ctx, "probe-" + UUID.randomUUID().toString())
        val template = Session(accessToken = "local-fixture-never-submitted",
            refreshToken = null, userId = "@fixture:probe.invalid", deviceId = "FIXTURE",
            homeserverUrl = origin, oauthData = null, slidingSyncVersion = SlidingSyncVersion.NATIVE)
        val original = store.newSession(template)
        try {
            store.write(original)
            val restored = requireNotNull(store.read())
            try {
                assertEquals(template, restored.session)
                assertEquals(original.storeId, restored.storeId)
                assertArrayEquals(original.storeKey, restored.storeKey)
                val directory = store.sdkDirectory(restored)
                val client = SqliteStoreBuilder(directory.absolutePath, directory.absolutePath).use { plain ->
                    plain.key(restored.storeKey).use { sqlite ->
                        ClientBuilder().use { root ->
                            root.homeserverUrl(origin).disableWellKnownLookup(true)
                                .sqliteStore(sqlite)
                                .slidingSyncVersionBuilder(SlidingSyncVersionBuilder.NATIVE)
                                .autoEnableCrossSigning(true)
                                .autoEnableBackups(false)
                                .backupDownloadStrategy(BackupDownloadStrategy.AFTER_DECRYPTION_FAILURE)
                                .enableShareHistoryOnInvite(false)
                                .roomKeyRecipientStrategy(CollectStrategy.ONLY_TRUSTED_DEVICES)
                                .decryptionSettings(DecryptionSettings(TrustRequirement.CROSS_SIGNED))
                                .use { it.build() }
                        }
                    }
                }
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
            throw AssertionError("Anonymous encrypted store diagnostic failed (" + failure.javaClass.simpleName + ")")
        } finally {
            original.storeKey.fill(0)
            store.clear()
        }
    }
}
