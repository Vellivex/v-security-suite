package com.vellivex.messenger

import android.graphics.Bitmap
import android.view.WindowManager
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MessengerOnboardingSmokeTest {
    @get:Rule
    val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun onboardingAcceptsFictionalEmailAndRequiresServer() {
        compose.onNodeWithText("A little more", substring = true).assertIsDisplayed()
        captureBlankOnboarding()
        compose.onNodeWithText("Test server settings").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Continue with email").performScrollTo().assertIsNotEnabled()

        val email = compose.onNode(hasSetTextAction()).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Email address").assertIsDisplayed()
        email.performTextInput("tester@example.test")
        email.assertTextContains("tester@example.test")
        compose.onNodeWithText("Continue with email").assertIsNotEnabled()
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
