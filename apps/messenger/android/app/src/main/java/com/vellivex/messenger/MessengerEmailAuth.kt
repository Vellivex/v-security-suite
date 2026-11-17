package com.vellivex.messenger

import android.content.Context
import android.content.pm.ApplicationInfo
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URI
import java.time.Duration
import java.time.Instant
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import org.json.JSONObject
import org.matrix.rustcomponents.sdk.Session
import org.matrix.rustcomponents.sdk.SlidingSyncVersion

internal class MessengerFailure(message: String) : Exception(message)

private val messengerEmailPattern = Regex("[^@\\s]+@[^@\\s]+\\.[^@\\s]+")
private const val MAX_RETRY_DELAY_MS = 31 * 24 * 60 * 60 * 1_000L

internal fun isValidMessengerEmail(value: String): Boolean =
    value.length in 3..254 && messengerEmailPattern.matches(value)

internal fun isHardMatrixLogout(status: Int, body: JSONObject?): Boolean =
    status == HttpURLConnection.HTTP_UNAUTHORIZED && body?.opt("errcode") == "M_UNKNOWN_TOKEN" &&
        (!body.has("soft_logout") || body.opt("soft_logout") == false)

internal fun messengerRateLimitMessage(body: JSONObject?, retryAfter: String?, now: Instant = Instant.now()): String {
    if (body?.opt("vellivex_capacity_exhausted") == true) {
        return "Vellivex Messenger has reached its sign-in capacity. Try again later."
    }
    val matrixDelay = when (val value = body?.opt("retry_after_ms")) {
        is Int -> value.toLong()
        is Long -> value
        else -> 0L
    }
    val headerDelay = retryAfter?.takeIf { it.length <= 64 }?.trim()?.let { value ->
        if (value.all { it in '0'..'9' }) {
            value.toLongOrNull()?.takeIf { it <= MAX_RETRY_DELAY_MS / 1_000 }?.times(1_000)
        } else {
            runCatching {
                val until = ZonedDateTime.parse(value, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant()
                Duration.between(now, until).toMillis()
            }.getOrNull()
        }
    } ?: 0L
    val delay = maxOf(
        matrixDelay.takeIf { it in 1..MAX_RETRY_DELAY_MS } ?: 0L,
        headerDelay.takeIf { it in 1..MAX_RETRY_DELAY_MS } ?: 0L,
    )
    if (delay == 0L) return "Too many attempts. Wait before trying again."
    val (unitMillis, unitName) = when {
        delay >= 86_400_000 -> 86_400_000L to "day"
        delay >= 3_600_000 -> 3_600_000L to "hour"
        delay >= 60_000 -> 60_000L to "minute"
        else -> 1_000L to "second"
    }
    val count = (delay + unitMillis - 1) / unitMillis
    return "Too many attempts. Try again in $count $unitName${if (count == 1L) "" else "s"}."
}

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
        if (!isValidMessengerEmail(value)) {
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

    fun hasEndedSession(session: Session): Boolean {
        val connection = request(checkedBaseUrl(session.homeserverUrl), MATRIX_WHOAMI_PATH, "GET", session.accessToken)
        return try {
            val status = connection.responseCode
            status == HttpURLConnection.HTTP_UNAUTHORIZED && isHardMatrixLogout(status, readError(connection))
        } finally {
            connection.disconnect()
        }
    }

    private fun request(baseUrl: String, path: String, method: String, accessToken: String?): HttpURLConnection =
        (URI(baseUrl + path).toURL().openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 10_000
            readTimeout = 15_000
            instanceFollowRedirects = false
            useCaches = false
            setRequestProperty("Accept", "application/json")
            if (accessToken != null) setRequestProperty("Authorization", "Bearer $accessToken")
        }

    private fun post(baseUrl: String, path: String, body: JSONObject, accessToken: String? = null): JSONObject {
        val connection = request(baseUrl, path, "POST", accessToken).apply {
            doOutput = true
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
        }
        try {
            connection.outputStream.use { it.write(body.toString().encodeToByteArray()) }
            val status = connection.responseCode
            if (status !in 200..299) {
                if (path == MATRIX_LOGOUT_PATH && status == HttpURLConnection.HTTP_UNAUTHORIZED &&
                    isHardMatrixLogout(status, readError(connection))
                ) return JSONObject()
                throw MessengerFailure(
                    when {
                        status == 429 -> messengerRateLimitMessage(readError(connection), connection.getHeaderField("Retry-After"))
                        path == VERIFY_PATH && status in 400..499 -> "That code could not be verified. Check it or request a new one."
                        path == MATRIX_LOGIN_PATH && status in 400..499 -> "The sign-in token was rejected. Request a new code."
                        else -> "The messaging service could not complete that request."
                    },
                )
            }
            return connection.inputStream.use { readJson(it, 16_384) }
        } finally {
            connection.disconnect()
        }
    }

    private fun readError(connection: HttpURLConnection): JSONObject? =
        runCatching { connection.errorStream?.use { readJson(it, 4_096) } }.getOrNull()

    private fun readJson(stream: InputStream, limit: Int): JSONObject {
        val buffer = ByteArray(limit + 1)
        var length = 0
        while (length < buffer.size) {
            val count = stream.read(buffer, length, buffer.size - length)
            if (count < 0) break
            length += count
        }
        check(length <= limit)
        return JSONObject(buffer.decodeToString(endIndex = length))
    }

    private companion object {
        const val REQUEST_PATH = "/_synapse/client/vellivex/email/request"
        const val VERIFY_PATH = "/_synapse/client/vellivex/email/verify"
        const val MATRIX_LOGIN_PATH = "/_matrix/client/v3/login"
        const val MATRIX_LOGOUT_PATH = "/_matrix/client/v3/logout"
        const val MATRIX_WHOAMI_PATH = "/_matrix/client/v3/account/whoami"
        val CODE = Regex("[0-9]{8}")
        val LOOPBACK = setOf("127.0.0.1", "[::1]")
    }
}
