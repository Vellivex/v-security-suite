package com.vellivex.messenger

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.ComposeTimeoutException
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Layout regressions use the real chat UI and fictional data, without server or key access. */
@RunWith(AndroidJUnit4::class)
class MessengerChatLayoutTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun latestReplyRemainsVisibleWhenTheViewportShrinks() {
        var heightFraction by mutableFloatStateOf(1f)
        val state = conversation((0 until 8).map(::message))
        val latest = state.messages.last().text
        compose.setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                Box(Modifier.fillMaxSize()) {
                    Box(Modifier.fillMaxWidth().fillMaxHeight(heightFraction)) {
                        Chat(state, {}, { _, _ -> }, {}, {}, {})
                    }
                }
            }
        }
        requireDisplayed(latest)
        val before = compose.onNodeWithTag("conversation_messages").fetchSemanticsNode().boundsInRoot
        val replyHeight = compose.onNodeWithText(latest).fetchSemanticsNode().boundsInRoot.height
        compose.runOnIdle { heightFraction = 0.65f }
        compose.waitForIdle()
        val after = compose.onNodeWithTag("conversation_messages").fetchSemanticsNode().boundsInRoot
        assertTrue("The test must leave a usable message viewport", after.height > 0)
        assertTrue("The latest reply must still fit in the smaller viewport", after.height >= replyHeight)
        assertTrue("The test must materially shrink the real message viewport", after.height < before.height * 0.7f)
        requireDisplayed(latest)
    }

    @Test
    fun newReplyBecomesVisibleAtTheVisibleMessageLimit() {
        var state by mutableStateOf(conversation((0 until 200).map(::message)))
        compose.setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                Chat(state, {}, { _, _ -> }, {}, {}, {})
            }
        }
        requireDisplayed(state.messages.last().text)
        val reply = message(200)
        compose.runOnIdle { state = state.copy(messages = state.messages.drop(1) + reply) }
        assertEquals("Exercise replacement at the repository's 200-message limit", 200, state.messages.size)
        requireDisplayed(reply.text)
    }

    @Test
    fun recoveredChatKeepsRepliesVisibleInTheSpaceAboveTheKeyboard() {
        var state by mutableStateOf(conversation(emptyList()))
        compose.setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                // Match a compact phone's available chat space while the software keyboard is open.
                Box(Modifier.fillMaxWidth().height(260.dp)) {
                    Chat(state, {}, { _, _ -> }, {}, {}, {})
                }
            }
        }
        compose.onNodeWithText("Your recovery key restores your account’s encryption keys. In this alpha, it may not restore any earlier messages.")
            .assertIsDisplayed()
        val reply = message(1).copy(text = "Fictional encrypted reply to the recovered device.")
        compose.runOnIdle {
            state = state.copy(messages = listOf(
                message(0).copy(text = "Fictional encrypted message from the recovered device.", own = true),
                reply,
            ))
        }
        requireDisplayed(reply.text)
        compose.onNodeWithText("Write a message").assertIsDisplayed()
        compose.onNodeWithContentDescription("Send message").assertIsDisplayed()
    }

    private fun requireDisplayed(text: String) {
        try {
            compose.waitUntil(5_000) {
                try {
                    compose.onNodeWithText(text).assertIsDisplayed()
                    true
                } catch (_: AssertionError) {
                    false
                }
            }
        } catch (error: ComposeTimeoutException) {
            val viewport = compose.onNodeWithTag("conversation_messages").fetchSemanticsNode().boundsInRoot
            throw AssertionError("The latest fixture reply was not displayed; viewport=$viewport", error)
        }
        compose.onNodeWithText(text).assertIsDisplayed()
    }

    private fun message(number: Int) = MessengerMessage(
        id = "fixture-message-$number",
        sender = "@layout-peer:example.test",
        text = "Fictional received reply $number.",
        timestampMillis = 1_700_000_000_000L + number,
        own = false,
        delivery = MessengerDelivery.Received,
    )

    private fun conversation(messages: List<MessengerMessage>): MessengerState {
        val room = MessengerRoom(
            id = "!layout-room:example.test",
            title = "Fictional layout conversation",
            peerId = "@layout-peer:example.test",
            membership = MessengerMembership.Joined,
            encrypted = true,
            peerVerified = true,
        )
        return MessengerState(
            userId = "@layout-user:example.test",
            connection = MessengerConnection.Synced,
            recovery = MessengerRecovery.Ready,
            recoveredWithKey = true,
            rooms = listOf(room),
            selectedRoomId = room.id,
            messages = messages,
        )
    }
}
