// SPDX-License-Identifier: GPL-3.0-or-later
package com.vellivex.messenger.a2a;

import java.util.EnumSet;
import org.junit.Test;
import static org.junit.Assert.*;

public class SignInObservationTest {
    @Test public void separatesAuthenticationAndEncryptionFromRecovery() {
        assertEquals(SignInObservation.REJECTED, SignInObservation.classify("That code could not be verified. Check it or request a new one."));
        assertEquals(SignInObservation.TOKEN_REJECTED, SignInObservation.classify("The sign-in token was rejected. Request a new code."));
        assertEquals(SignInObservation.SAVED_SESSION, SignInObservation.classify("Resume your session."));
        assertEquals(SignInObservation.ENCRYPTION_SETUP_ERROR, SignInObservation.classify("Could not finish encryption setup. Your session is saved. Reconnect and restore it."));
        assertEquals(SignInObservation.CHECKING_KEYS, SignInObservation.classify("Checking your keys"));
        assertEquals(SignInObservation.CREATE_RECOVERY, SignInObservation.classify("Secure your account"));
        assertEquals(SignInObservation.NO_RECOVERY, SignInObservation.classify("Recovery isn’t set up"));
        assertEquals(SignInObservation.OTHER_DEVICE, SignInObservation.classify("Sign out on your other phone"));
        assertNull(SignInObservation.classify("Restore session")); // Also present in generic help.
    }

    @Test public void collapsesRetryDurationWithoutExportingIt() {
        assertEquals(SignInObservation.RATE_LIMITED, SignInObservation.classify("Too many attempts. Try again in 1 hour."));
        assertEquals(SignInObservation.RATE_LIMITED, SignInObservation.classify("Too many attempts. Wait before trying again."));
        assertEquals("rate-limited", SignInObservation.RATE_LIMITED.token);
    }

    @Test public void onlyReportsRejectionAfterTheNegativeControlHasDisappeared() {
        SignInObservation.Tracker tracker = new SignInObservation.Tracker(true);
        assertTrue(tracker.newlyVisible(EnumSet.of(SignInObservation.REJECTED)).isEmpty());
        assertEquals(EnumSet.of(SignInObservation.CODE_ENTRY),
            tracker.newlyVisible(EnumSet.of(SignInObservation.REJECTED, SignInObservation.CODE_ENTRY)));
        assertTrue(tracker.newlyVisible(EnumSet.of(SignInObservation.CODE_ENTRY)).isEmpty());
        assertEquals(EnumSet.of(SignInObservation.REJECTED),
            tracker.newlyVisible(EnumSet.of(SignInObservation.REJECTED, SignInObservation.CODE_ENTRY)));
        assertEquals(EnumSet.of(SignInObservation.SAVED_SESSION, SignInObservation.ENCRYPTION_SETUP_ERROR),
            tracker.newlyVisible(EnumSet.of(SignInObservation.SAVED_SESSION, SignInObservation.ENCRYPTION_SETUP_ERROR)));
        assertTrue(tracker.newlyVisible(EnumSet.of(SignInObservation.SAVED_SESSION)).isEmpty());
    }

    @Test public void rejectsDynamicAndPrivateFieldContent() {
        for (String raw : new String[]{"", "23456789", "qa@example.test", "@qa:example.test",
                "Enter the one-time code sent to qa@example.test.", "Secure your account: private",
                "Unknown internal error 23456789", "Too many attempts. Try again in 3 hours. private"}) {
            assertFalse(SignInObservation.VISIBLE_LABELS.matcher(raw).matches());
            assertNull(SignInObservation.classify(raw));
        }
        assertTrue(SignInObservation.VISIBLE_LABELS.matcher("Checking your keys").matches());
    }
}
