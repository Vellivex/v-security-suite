package com.vellivex.qa

import android.app.Activity
import android.os.Bundle
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.vellivex.messenger.MessengerSessionStore
import com.vellivex.messenger.initializeMessengerPlatform
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.matrix.rustcomponents.sdk.*
import uniffi.matrix_sdk.BackupDownloadStrategy
import uniffi.matrix_sdk_crypto.*
import java.net.URL
import javax.net.ssl.HttpsURLConnection

/** These checks use only a public GET and a locally generated encrypted database. */
class ProbeActivity : Activity() {
    private val record by lazy { getSharedPreferences("qa", MODE_PRIVATE) }
    private val output by lazy { TextView(this).apply { textSize = 18f } }
    private var lines = ""
    private var stage = "Ready"
    private val origin = "https://messenger.vellivex.com"

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        lines = record.getString("lines", "").orEmpty()
        if (lines.isEmpty()) lines = "Ready\n"
        output.text = lines
        val button = Button(this).apply { text = "Run diagnostics" }
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 80, 32, 32)
            addView(button)
            addView(output)
        }
        setContentView(ScrollView(this).apply { addView(column) })
        button.setOnClickListener {
            button.isEnabled = false
            lines = ""
            Thread {
                fun section(name: String, check: () -> Unit) {
                    try { check(); line("$name PASS") }
                    catch (failure: Throwable) {
                        val causes = generateSequence(failure) { it.cause }.take(5).toList()
                        val detail = causes.joinToString(" ") { it.message.orEmpty() }.lowercase()
                        val terms = listOf("checksum mismatch", "contract version", "panic", "certificate", "sqlite", "already initialized", "uniffi", "jni", "timeout", "linker", "dns", "network", "tls", "mapping", "thread", "java vm")
                        val found = terms.filter { it in detail }.joinToString(",")
                        val types = causes.joinToString("/") { it.javaClass.simpleName.take(40) }
                        val frames = causes.flatMap { it.stackTrace.asList() }.filter { it.className.startsWith("org.matrix.") || it.className.startsWith("uniffi.") }.take(2).joinToString(",") {
                            it.className.substringAfterLast('.') + "." + it.methodName
                        }
                        line("$name FAIL at $stage ($types $found $frames)")
                    }
                }
                section("Android HTTPS") {
                    begin("Android public versions")
                    val connection = URL("$origin/_matrix/client/versions").openConnection() as HttpsURLConnection
                    try {
                        connection.instanceFollowRedirects = false
                        connection.connectTimeout = 10000
                        connection.readTimeout = 10000
                        check(connection.responseCode == 200)
                        check(JSONObject(connection.inputStream.bufferedReader().use { it.readText() }).getJSONArray("versions").length() > 0)
                    } finally { connection.disconnect() }
                }
                section("Native bootstrap") {
                    begin("Native initialize")
                    initializeMessengerPlatform(applicationContext)
                }
                section("Native memory") { runBlocking { withTimeout(35000) { memoryVersions() } } }
                section("Encrypted store") { runBlocking { withTimeout(35000) { storeVersions() } } }
                line("Diagnostics complete")
            }.start()
        }
    }

    private fun begin(label: String) { stage = label; line("Checking $label") }

    private fun line(value: String) {
        lines += value + "\n"
        val snapshot = lines
        check(record.edit().putString("lines", snapshot).commit())
        runOnUiThread { output.text = snapshot }
    }

    private suspend fun memoryVersions() {
        begin("Memory builder")
        ClientBuilder().use { root ->
            root.homeserverUrl(origin).disableWellKnownLookup(true).inMemoryStore().use { spec ->
                begin("Memory build")
                spec.build().use { client -> versions(client, "Memory versions") }
            }
        }
    }

    private suspend fun versions(client: Client, label: String) {
        begin(label)
        check(client.homeserver().trimEnd('/') == origin)
        client.resetSupportedVersions()
        client.isReportRoomApiSupported()
    }

    private suspend fun storeVersions() {
        val recordStore = MessengerSessionStore(this, "physical-qa")
        val template = Session(accessToken = "local-only", refreshToken = null, userId = "@fixture:probe.invalid", deviceId = "FIXTURE",
            homeserverUrl = origin, oauthData = null, slidingSyncVersion = SlidingSyncVersion.NATIVE)
        val original = recordStore.newSession(template)
        try {
            begin("Keystore write")
            recordStore.write(original)
            begin("Keystore read")
            val restored = requireNotNull(recordStore.read())
            try {
                check(restored.session == template && restored.storeKey.contentEquals(original.storeKey))
                val dir = recordStore.sdkDirectory(restored)
                begin("SQLite builder")
                SqliteStoreBuilder(dir.absolutePath, dir.absolutePath).use { plain ->
                    begin("SQLite key")
                    plain.key(restored.storeKey).use { encrypted ->
                        begin("Persistent client builder")
                        ClientBuilder().use { root ->
                            begin("Persistent configuration")
                            root.homeserverUrl(origin).disableWellKnownLookup(true).sqliteStore(encrypted)
                                .slidingSyncVersionBuilder(SlidingSyncVersionBuilder.NATIVE)
                                .autoEnableCrossSigning(true).autoEnableBackups(false)
                                .backupDownloadStrategy(BackupDownloadStrategy.AFTER_DECRYPTION_FAILURE)
                                .enableShareHistoryOnInvite(false).roomKeyRecipientStrategy(CollectStrategy.ONLY_TRUSTED_DEVICES)
                                .decryptionSettings(DecryptionSettings(TrustRequirement.CROSS_SIGNED)).use { configured ->
                                    begin("Persistent build")
                                    configured.build().use { versions(it, "Persistent versions") }
                                }
                        }
                    }
                }
                check(dir.listFiles().orEmpty().any { it.isFile && it.length() > 0 })
            } finally { restored.storeKey.fill(0) }
        } finally {
            original.storeKey.fill(0)
            recordStore.clear()
        }
    }
}
