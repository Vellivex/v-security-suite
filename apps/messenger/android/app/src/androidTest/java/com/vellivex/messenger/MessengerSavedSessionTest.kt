package com.vellivex.messenger

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.net.SocketException
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors

/** Saved-session regressions use only a unique disposable namespace and loopback. */
@RunWith(AndroidJUnit4::class)
class MessengerSavedSessionTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun unreadableSavedRecordRemainsRestoreRequiredAndCannotStartAnotherSignIn() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val namespace = "saved-${UUID.randomUUID()}"
        val directory = File(context.noBackupFilesDir, "messenger/$namespace")
        check(directory.mkdirs())
        val record = File(directory, "session.gcm")
        val fixture = byteArrayOf(0, 1, 2)
        record.writeBytes(fixture)
        val repository = MatrixRepository(context, namespace)
        try {
            assertTrue(repository.state.value.needsSessionRestore)
            assertFalse(repository.restore())
            val originalError = repository.state.value.savedSessionError
            assertNotNull(originalError)
            repository.clearError()
            assertNull(repository.state.value.error)
            assertNull(repository.requestCode("https://example.invalid", "fixture@example.test"))
            assertFalse(repository.verifyCode("00000000"))
            assertEquals(originalError, repository.state.value.savedSessionError)
            assertNull(repository.state.value.error)
            assertTrue(repository.state.value.needsSessionRestore)
            assertFalse(repository.state.value.codeRequested)
            assertArrayEquals(fixture, record.readBytes())
            assertFalse(repository.restore())
            assertEquals(originalError, repository.state.value.savedSessionError)
            assertArrayEquals(fixture, record.readBytes())
        } finally {
            repository.close()
            directory.deleteRecursively()
        }
    }

    @Test
    fun completedEmailLoginWhoseConnectionFailsKeepsTheNewSavedSession() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val namespace = "saved-${UUID.randomUUID()}"
        val directory = File(context.noBackupFilesDir, "messenger/$namespace")
        val repository = MatrixRepository(context, namespace)
        try {
            LoginThenFailProbe().use { probe ->
                assertNotNull(repository.requestCode(probe.baseUrl, "fixture@example.test"))
                assertTrue(repository.state.value.codeRequested)
                assertFalse(repository.verifyCode("12345678"))
                assertEquals(3, probe.authRequests.size)
                val failed = repository.state.value
                assertTrue(failed.hasSavedSession)
                assertTrue(failed.needsSessionRestore)
                assertFalse(failed.codeRequested)
                assertNotNull(failed.savedSessionError)
                val record = File(directory, "session.gcm")
                assertTrue(record.isFile)
                val savedDigest = MessageDigest.getInstance("SHA-256").digest(record.readBytes())
                repository.clearError()
                assertNull(repository.requestCode(probe.baseUrl, "another@example.test"))
                assertFalse(repository.verifyCode("87654321"))
                assertEquals(3, probe.authRequests.size)
                assertEquals(failed.savedSessionError, repository.state.value.savedSessionError)
                assertArrayEquals(savedDigest, MessageDigest.getInstance("SHA-256").digest(record.readBytes()))
            }
        } finally {
            repository.close()
            // Only this test's synthetic keystore entry and namespace are removed.
            MessengerSessionStore(context, namespace).clear()
        }
    }

    @Test
    fun savedSessionScreenHasProminentRetryPersistentErrorAndVisibleVersion() {
        val firstError = "The fixture connection could not restore its saved session."
        var state by mutableStateOf(MessengerState(hasSavedSession = true, savedSessionError = firstError))
        var attempts = 0
        var resetRequests = 0
        compose.setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                SavedSessionScreen(state, state.busy,
                    restore = { attempts += 1; state = state.copy(busy = true, error = null) },
                    reset = { resetRequests += 1 })
            }
        }
        compose.onNodeWithText("Version ${BuildConfig.VERSION_NAME}").assertIsDisplayed()
        compose.onNodeWithText(firstError).assertIsDisplayed()
        compose.onNodeWithText("Email address").assertDoesNotExist()
        compose.onNodeWithText("Eight-digit email code").assertDoesNotExist()
        compose.onNodeWithText("Continue with email").assertDoesNotExist()
        compose.onNodeWithText("Sign out of this phone").assertDoesNotExist()
        compose.onNodeWithText("Restore session").assertIsDisplayed().assertIsEnabled().performClick()
        assertEquals(1, attempts)
        assertEquals(0, resetRequests)
        compose.onNodeWithText("Restore session").assertIsNotEnabled()
        compose.onNodeWithText(firstError).assertIsDisplayed()
        compose.runOnIdle { state = state.copy(busy = false) }
        compose.onNodeWithText("Restore session").assertIsEnabled()
        compose.onNodeWithText("Trouble restoring?").performScrollTo().performClick()
        compose.onNodeWithText("Sign out of this phone").performScrollTo().performClick()
        assertEquals(1, resetRequests)
    }
}

/** Accepts a fictional email login, then rejects all Matrix connection requests. */
private class LoginThenFailProbe : AutoCloseable {
    private val socket = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
    private val executor = Executors.newSingleThreadExecutor()
    val baseUrl = "http://127.0.0.1:${socket.localPort}"
    val authRequests = CopyOnWriteArrayList<String>()

    init {
        executor.submit {
            try {
                while (!socket.isClosed) socket.accept().use { connection ->
                    connection.soTimeout = 5_000
                    val input = connection.getInputStream().bufferedReader()
                    val request = input.readLine()?.split(' ') ?: return@use
                    val method = request.getOrNull(0)
                    val path = request.getOrNull(1) ?: return@use
                    while (!input.readLine().isNullOrEmpty()) { /* Request payloads are never retained. */ }
                    val (status, body) = when {
                        method == "POST" && path.endsWith("/request") -> {
                            authRequests += "request"
                            "200 OK" to """{"challenge_id":"synthetic-saved-session-challenge"}"""
                        }
                        method == "POST" && path.endsWith("/verify") -> {
                            authRequests += "verify"
                            "200 OK" to """{"login_token":"synthetic-login-token"}"""
                        }
                        method == "POST" && path == "/_matrix/client/v3/login" -> {
                            authRequests += "login"
                            "200 OK" to """{"access_token":"synthetic-access-token","user_id":"@fixture:example.test","device_id":"SYNTHETIC","refresh_token":null}"""
                        }
                        else -> "503 Service Unavailable" to "{}"
                    }
                    val bytes = body.toByteArray(Charsets.US_ASCII)
                    connection.getOutputStream().write(
                        "HTTP/1.1 $status\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n"
                            .toByteArray(Charsets.US_ASCII) + bytes,
                    )
                }
            } catch (error: SocketException) {
                if (!socket.isClosed) throw error
            }
        }
    }

    override fun close() {
        socket.close()
        executor.shutdownNow()
    }
}
