package com.vellivex.messenger

import android.content.Context
import android.content.pm.ApplicationInfo
import java.net.HttpURLConnection
import java.net.URI
import org.json.JSONObject
import org.matrix.rustcomponents.sdk.Session
import org.matrix.rustcomponents.sdk.SlidingSyncVersion

internal class MessengerFailure(message: String) : Exception(message)

internal class MessengerEmailAuth(context: Context) {
    private val debug = context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0

    fun checkedBaseUrl(value: String): String {
        val uri = try {
            URI(value.trim())
        } catch (_: Exception) {
            throw MessengerFailure("Enter a valid HTTPS service address.")
        }
        val localDebug = debug && uri.scheme == "http" && uri.host in LOOPBACK
        if ((uri.scheme != "https" && !localDebug) || uri.host == null ||
            uri.userInfo != null || uri.rawQuery != null || uri.rawFragment != null ||
            uri.rawPath !in listOf("", "/") || uri.port !in -1..65_535 || uri.port == 0
        ) {
            throw MessengerFailure("Enter the HTTPS address of the Vellivex messaging service.")
        }
        return URI(uri.scheme, null, uri.host, uri.port, null, null, null).toASCIIString()
    }

    fun requestCode(baseUrl: String, email: String): String {
        val value = email.trim()
        if (value.length !in 3..254 || !EMAIL.matches(value)) {
            throw MessengerFailure("Enter a valid email address.")
        }
        return post(baseUrl, REQUEST_PATH, JSONObject().put("email", value))
            .getString("challenge_id").also { check(it.length in 1..256) }
    }

    fun verifyCode(baseUrl: String, challenge: String, code: String): Session {
        if (!CODE.matches(code)) throw MessengerFailure("Enter the eight-digit email code.")
        val token = post(
            baseUrl, VERIFY_PATH, JSONObject().put("challenge_id", challenge).put("code", code),
        ).getString("login_token").also { check(it.length in 1..4096) }
        val login = post(
            baseUrl,
            MATRIX_LOGIN_PATH,
            JSONObject().put("type", "m.login.token").put("token", token)
                .put("initial_device_display_name", "Vellivex Messenger"),
        )
        return Session(
            accessToken = login.getString("access_token").also { check(it.length in 1..4096) },
            refreshToken = if (login.isNull("refresh_token")) null else login.getString("refresh_token"),
            userId = login.getString("user_id").also { check(it.startsWith('@') && ':' in it) },
            deviceId = login.getString("device_id").also { check(it.length in 1..256) },
            homeserverUrl = baseUrl,
            oauthData = null,
            slidingSyncVersion = SlidingSyncVersion.NATIVE,
        )
    }

    fun revoke(session: Session): Boolean {
        post(checkedBaseUrl(session.homeserverUrl), MATRIX_LOGOUT_PATH, JSONObject(), session.accessToken)
        return true
    }

    private fun post(baseUrl: String, path: String, body: JSONObject, accessToken: String? = null): JSONObject {
        val connection = (URI(baseUrl + path).toURL().openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 10_000
            readTimeout = 15_000
            instanceFollowRedirects = false
            useCaches = false
            doOutput = true
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
            setRequestProperty("Accept", "application/json")
            if (accessToken != null) setRequestProperty("Authorization", "Bearer $accessToken")
        }
        try {
            connection.outputStream.use { it.write(body.toString().encodeToByteArray()) }
            val status = connection.responseCode
            if (status !in 200..299) {
                throw MessengerFailure(
                    when {
                        status == 429 -> "Too many attempts. Wait before requesting another code."
                        path == VERIFY_PATH && status in 400..499 -> "That code could not be verified. Check it or request a new one."
                        path == MATRIX_LOGIN_PATH && status in 400..499 -> "The sign-in token was rejected. Request a new code."
                        else -> "The messaging service could not complete that request."
                    },
                )
            }
            val bytes = connection.inputStream.use { stream ->
                val buffer = ByteArray(16_385)
                var length = 0
                while (length < buffer.size) {
                    val count = stream.read(buffer, length, buffer.size - length)
                    if (count < 0) break
                    length += count
                }
                check(length < buffer.size)
                buffer.copyOf(length)
            }
            return JSONObject(bytes.decodeToString())
        } finally {
            connection.disconnect()
        }
    }

    private companion object {
        const val REQUEST_PATH = "/_synapse/client/vellivex/email/request"
        const val VERIFY_PATH = "/_synapse/client/vellivex/email/verify"
        const val MATRIX_LOGIN_PATH = "/_matrix/client/v3/login"
        const val MATRIX_LOGOUT_PATH = "/_matrix/client/v3/logout"
        val EMAIL = Regex("[^@\\s]+@[^@\\s]+\\.[^@\\s]+")
        val CODE = Regex("[0-9]{8}")
        val LOOPBACK = setOf("127.0.0.1", "[::1]")
    }
}
