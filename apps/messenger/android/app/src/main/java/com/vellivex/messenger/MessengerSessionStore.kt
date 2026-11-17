package com.vellivex.messenger

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Base64
import java.io.File
import java.security.KeyStore
import java.security.SecureRandom
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject
import org.matrix.rustcomponents.sdk.Session
import org.matrix.rustcomponents.sdk.SlidingSyncVersion

internal data class StoredMessengerSession(
    val session: Session,
    val storeId: String,
    val storeKey: ByteArray,
    val recoveryConfirmed: Boolean = false,
    val recoveredWithKey: Boolean = false,
)

internal class MessengerSessionStore(context: Context, namespace: String) {
    private val directory = File(context.noBackupFilesDir, "messenger/$namespace")
    private val record = AtomicFile(File(directory, "session.gcm"))
    private val keyAlias = "com.vellivex.messenger.session.$namespace"
    private val keyStore: KeyStore get() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    init {
        require(NAMESPACE.matches(namespace))
    }

    fun exists(): Boolean = record.baseFile.exists() || File(record.baseFile.path + ".bak").exists()

    fun newSession(session: Session): StoredMessengerSession = StoredMessengerSession(
        session = session,
        storeId = UUID.randomUUID().toString(),
        storeKey = ByteArray(32).also(SecureRandom()::nextBytes),
    )

    fun sdkDirectory(value: StoredMessengerSession): File =
        File(directory, value.storeId).apply { check(isDirectory || mkdirs()) }

    fun hasSdkStore(value: StoredMessengerSession): Boolean =
        File(File(directory, value.storeId), "matrix-sdk-crypto.sqlite3").let { it.isFile && it.length() > 0L }

    fun read(): StoredMessengerSession? {
        if (!exists()) return null
        val encoded = record.readFully()
        check(encoded.size in 30..16_384)
        check(encoded[0] == FORMAT_VERSION)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(
            Cipher.DECRYPT_MODE,
            requireNotNull(keyStore.getKey(keyAlias, null) as? SecretKey),
            GCMParameterSpec(128, encoded.copyOfRange(1, 13)),
        )
        cipher.updateAAD(keyAlias.encodeToByteArray())
        val clear = cipher.doFinal(encoded, 13, encoded.size - 13)
        try {
            val json = JSONObject(clear.decodeToString())
            val storeId = json.getString("storeId")
            check(UUID.fromString(storeId).toString() == storeId)
            val session = Session(
                accessToken = json.getString("accessToken"),
                refreshToken = json.nullableString("refreshToken"),
                userId = json.getString("userId"),
                deviceId = json.getString("deviceId"),
                homeserverUrl = json.getString("homeserverUrl"),
                oauthData = null,
                slidingSyncVersion = SlidingSyncVersion.NATIVE,
            )
            val storeKey = Base64.decode(json.getString("sdkKey"), Base64.NO_WRAP)
            check(storeKey.size == 32)
            return StoredMessengerSession(session, storeId, storeKey,
                recoveryConfirmed = json.optBoolean("recoveryConfirmed", false),
                recoveredWithKey = json.optBoolean("recoveredWithKey", false))
        } finally {
            clear.fill(0)
        }
    }

    fun write(value: StoredMessengerSession) {
        check(directory.isDirectory || directory.mkdirs())
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, existingOrNewKey())
        check(cipher.iv.size == 12)
        cipher.updateAAD(keyAlias.encodeToByteArray())
        val session = value.session
        val clear = JSONObject()
            .put("accessToken", session.accessToken)
            .put("refreshToken", session.refreshToken ?: JSONObject.NULL)
            .put("userId", session.userId)
            .put("deviceId", session.deviceId)
            .put("homeserverUrl", session.homeserverUrl)
            .put("storeId", value.storeId)
            .put("sdkKey", Base64.encodeToString(value.storeKey, Base64.NO_WRAP))
            .put("recoveryConfirmed", value.recoveryConfirmed)
            .put("recoveredWithKey", value.recoveredWithKey)
            .toString().encodeToByteArray()
        val encoded = try {
            byteArrayOf(FORMAT_VERSION) + cipher.iv + cipher.doFinal(clear)
        } finally {
            clear.fill(0)
        }
        val output = record.startWrite()
        try {
            output.write(encoded)
            record.finishWrite(output)
        } catch (error: Exception) {
            record.failWrite(output)
            throw error
        }
    }

    fun updateRecoveryConfirmation(storeId: String, confirmed: Boolean, recoveredWithKey: Boolean = false) {
        val saved = requireNotNull(read())
        try {
            check(saved.storeId == storeId)
            val recovered = confirmed && (saved.recoveredWithKey || recoveredWithKey)
            if (saved.recoveryConfirmed != confirmed || saved.recoveredWithKey != recovered) {
                write(saved.copy(recoveryConfirmed = confirmed, recoveredWithKey = recovered))
            }
        } finally {
            saved.storeKey.fill(0)
        }
    }

    fun clear() {
        record.delete()
        keyStore.deleteEntry(keyAlias)
        check(!directory.exists() || directory.deleteRecursively())
    }

    private fun existingOrNewKey(): SecretKey {
        (keyStore.getKey(keyAlias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(
                KeyGenParameterSpec.Builder(
                    keyAlias,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                ).setKeySize(256)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true)
                    .build(),
            )
        }.generateKey()
    }

    private fun JSONObject.nullableString(name: String): String? =
        if (isNull(name)) null else getString(name)

    private companion object {
        const val FORMAT_VERSION: Byte = 1
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        val NAMESPACE = Regex("[A-Za-z0-9_-]{1,48}")
    }
}
