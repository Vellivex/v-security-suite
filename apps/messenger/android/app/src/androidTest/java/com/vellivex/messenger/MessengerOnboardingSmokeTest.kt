package com.vellivex.messenger

import android.graphics.Bitmap
import android.graphics.Rect
import android.view.WindowManager
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.net.SocketException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MessengerOnboardingSmokeTest {
    @get:Rule
    val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun freshInstallHasDefaultHttpsAndCanContinueWithTheKeyboardOpen() {
        field("Email address").assertExists()
        captureBlankOnboarding()
        val email = field("Email address").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Test server settings").performScrollTo().performClick()
        field("Server address").performScrollTo().assertTextContains("https://messenger.vellivex.com")
        compose.onNodeWithText("Test server settings").performScrollTo().performClick()

        email.performScrollTo().performClick().performTextReplacement("missing-domain@")
        email.performImeAction()
        compose.onNodeWithText("Enter a valid email address.").performScrollTo().assertIsDisplayed()
        email.performScrollTo().performTextReplacement("missing-at.example.test")
        compose.onNodeWithText("Continue with email").performScrollTo().performClick()
        compose.onNodeWithText("Enter a valid email address.").performScrollTo().assertIsDisplayed()

        email.performScrollTo().performClick().performTextReplacement("tester@example.test")
        email.assertTextContains("tester@example.test")
        compose.waitUntil(10_000) {
            var visible = false
            compose.activityRule.scenario.onActivity { activity ->
                visible = ViewCompat.getRootWindowInsets(activity.window.decorView)
                    ?.isVisible(WindowInsetsCompat.Type.ime()) == true
            }
            visible
        }
        val button = compose.onNodeWithText("Continue with email").performScrollTo().assertIsDisplayed().assertIsEnabled()
        val buttonBottom = button.fetchSemanticsNode().boundsInWindow.bottom
        compose.activityRule.scenario.onActivity { activity ->
            val window = activity.window.decorView
            val visibleScreen = Rect().also { window.getWindowVisibleDisplayFrame(it) }
            val origin = IntArray(2).also { window.getLocationOnScreen(it) }
            assertTrue("Continue is covered by the open keyboard", origin[1] + buttonBottom <= visibleScreen.bottom + 1)
        }
        // The valid default HTTPS form is intentionally never submitted.
    }

    @Test
    fun rapidImeAndButtonSubmitOnceAndWrongCodeRemainsRetryable() {
        CodeRequestProbe().use { probe ->
            compose.onNodeWithText("Test server settings").performScrollTo().performClick()
            field("Server address").performScrollTo().performTextReplacement(probe.baseUrl)
            val email = field("Email address").performScrollTo().performClick()
            email.performTextReplacement("tester@example.test")
            val button = compose.onNodeWithText("Continue with email").performScrollTo()
            val imeAction = checkNotNull(email.fetchSemanticsNode().config[SemanticsActions.OnImeAction].action)
            val click = checkNotNull(button.fetchSemanticsNode().config[SemanticsActions.OnClick].action)
            compose.runOnIdle {
                imeAction()
                click()
                imeAction()
            }
            assertTrue("Loopback server did not receive the code request", probe.started.await(10, TimeUnit.SECONDS))
            button.assertIsNotEnabled()
            probe.release.countDown()

            val code = field("Eight-digit email code")
            compose.waitUntil(10_000) { compose.onAllNodes(hasText("Eight-digit email code")).fetchSemanticsNodes().isNotEmpty() }
            code.performScrollTo().performClick().performTextReplacement("123a")
            code.assertTextContains("123")
            code.performImeAction()
            compose.onNodeWithText("Enter the eight-digit email code.").performScrollTo().assertIsDisplayed()
            code.performScrollTo().performTextReplacement("00000000")
            code.performImeAction()
            compose.waitUntil(10_000) {
                compose.onAllNodes(hasText("That code could not be verified.", substring = true)).fetchSemanticsNodes().isNotEmpty()
            }
            code.performScrollTo().assertIsEnabled()
            compose.onNodeWithText("Open Vellivex").performScrollTo().assertIsEnabled()
            assertEquals(listOf("request", "verify"), probe.requests.toList())

            code.performScrollTo().performTextReplacement("12345678")
            probe.requestError = """{"errcode":"M_LIMIT_EXCEEDED","vellivex_capacity_exhausted":true}"""
            compose.onNodeWithText("Send another code").performScrollTo().performClick()
            waitForText("Vellivex Messenger has reached its sign-in capacity. Try again later.")
            code.performScrollTo().assertTextContains("12345678")

            probe.requestError = """{"errcode":"M_LIMIT_EXCEEDED","retry_after_ms":60000}"""
            compose.onNodeWithText("Send another code").performScrollTo().assertIsEnabled().performClick()
            waitForText("Too many attempts. Try again in 1 minute.")
            code.performScrollTo().assertTextContains("12345678")

            compose.onNodeWithText("Change email").performScrollTo().performClick()
            field("Email address").performScrollTo().assertTextContains("tester@example.test")
            code.assertDoesNotExist()
            assertEquals(listOf("request", "verify", "request", "request"), probe.requests.toList())
        }
    }

    private fun field(label: String) = compose.onNode(hasSetTextAction() and hasText(label))

    private fun waitForText(value: String) {
        compose.waitUntil(10_000) { compose.onAllNodes(hasText(value)).fetchSemanticsNodes().isNotEmpty() }
    }

    private fun captureBlankOnboarding() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val scenario = compose.activityRule.scenario
        val flag = WindowManager.LayoutParams.FLAG_SECURE
        val firstFrame = CountDownLatch(1)
        scenario.onActivity { activity ->
            assertTrue("Messenger must start with FLAG_SECURE", activity.window.attributes.flags and flag != 0)
            activity.window.clearFlags(flag)
            activity.window.decorView.postOnAnimation {
                activity.window.decorView.postOnAnimation { firstFrame.countDown() }
            }
        }
        val screenshot = try {
            assertTrue("Onboarding surface did not render", firstFrame.await(10, TimeUnit.SECONDS))
            compose.waitForIdle()
            checkNotNull(instrumentation.uiAutomation.takeScreenshot())
        } finally {
            scenario.onActivity { it.window.addFlags(flag) }
        }
        val out = File(
            checkNotNull(instrumentation.targetContext.getExternalFilesDir(null)),
            "vellivex-alpha-onboarding.png",
        )
        try {
            out.outputStream().use { assertTrue(screenshot.compress(Bitmap.CompressFormat.PNG, 100, it)) }
        } finally {
            screenshot.recycle()
        }
    }
}

private class CodeRequestProbe : AutoCloseable {
    private val socket = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
    private val worker = Executors.newSingleThreadExecutor()
    val baseUrl = "http://127.0.0.1:${socket.localPort}"
    val requests = CopyOnWriteArrayList<String>()
    val started = CountDownLatch(1)
    val release = CountDownLatch(1)
    @Volatile var requestError: String? = null

    init {
        worker.submit {
            try {
                while (!socket.isClosed) socket.accept().use { connection ->
                    connection.soTimeout = 5_000
                    val input = connection.getInputStream().bufferedReader()
                    val method = input.readLine()?.split(' ')?.getOrNull(1)?.substringAfterLast('/')
                    while (!input.readLine().isNullOrEmpty()) { /* Read the request headers. */ }
                    if (method == null) return@use
                    requests += method
                    if (method == "request") {
                        started.countDown()
                        check(release.await(15, TimeUnit.SECONDS))
                    }
                    val requestFailure = requestError
                    val (status, body) = when {
                        method != "request" -> "403 Forbidden" to "{}"
                        requestFailure != null -> "429 Too Many Requests" to requestFailure
                        else -> "200 OK" to """{"challenge_id":"synthetic-challenge"}"""
                    }
                    connection.getOutputStream().write(
                        "HTTP/1.1 $status\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n$body"
                            .toByteArray(Charsets.US_ASCII),
                    )
                }
            } catch (error: SocketException) {
                if (!socket.isClosed) throw error
            }
        }
    }

    override fun close() {
        release.countDown()
        socket.close()
        worker.shutdownNow()
    }
}
