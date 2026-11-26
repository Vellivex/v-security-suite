// SPDX-License-Identifier: GPL-3.0-or-later
package com.vellivex.messenger.a2a

import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.net.InetAddress
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import javax.net.ssl.HttpsURLConnection
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith

/** Checks the guest's Android resolver and platform TLS stack before any test account is used. */
@RunWith(AndroidJUnit4::class)
class MessengerPublicNetworkReadinessTest {
    @Test
    fun guestCanResolveAndReadPublicVersions() {
        val deadline = SystemClock.elapsedRealtime() + 75_000
        val worker = Executors.newSingleThreadExecutor { task ->
            Thread(task, "public-versions-probe").apply { isDaemon = true }
        }
        try {
            while (true) {
                val remaining = deadline - SystemClock.elapsedRealtime()
                if (remaining <= 0) break
                val attempt = worker.submit<Boolean> {
                    try {
                        canReadVersions()
                    } catch (_: Exception) {
                        false
                    }
                }
                try {
                    if (attempt.get(minOf(remaining, 12_000L), TimeUnit.MILLISECONDS)) return
                } catch (_: TimeoutException) {
                    attempt.cancel(true)
                }
                val pause = minOf(2_000L, deadline - SystemClock.elapsedRealtime())
                if (pause > 0) SystemClock.sleep(pause)
            }
        } finally {
            worker.shutdownNow()
        }
        throw AssertionError("Android could not resolve and read the public messaging service versions within 75 seconds")
    }

    private fun canReadVersions(): Boolean {
        val endpoint = URL("https://messenger.vellivex.com/_matrix/client/versions")
        if (InetAddress.getAllByName(endpoint.host).isEmpty()) return false
        val connection = endpoint.openConnection() as HttpsURLConnection
        try {
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            connection.connectTimeout = 5_000
            connection.readTimeout = 5_000
            if (connection.responseCode != 200) return false
            val body = connection.inputStream.bufferedReader(Charsets.UTF_8).use { reader ->
                val result = StringBuilder()
                val buffer = CharArray(1_024)
                while (true) {
                    val count = reader.read(buffer)
                    if (count < 0) break
                    if (result.length + count > 65_536) return false
                    result.append(buffer, 0, count)
                }
                result.toString()
            }
            return JSONObject(body).optJSONArray("versions")?.let { it.length() > 0 } == true
        } finally {
            connection.disconnect()
        }
    }
}
