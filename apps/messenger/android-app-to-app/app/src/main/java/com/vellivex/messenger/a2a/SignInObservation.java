// SPDX-License-Identifier: GPL-3.0-or-later
package com.vellivex.messenger.a2a;

import java.util.ArrayList;
import java.util.EnumSet;
import java.util.Set;
import java.util.List;
import java.util.regex.Pattern;

/** Only these fixed UI labels and tokens can be observed by the post-submit diagnostic. */
public enum SignInObservation {
    CODE_ENTRY("code-entry", "Eight-digit email code"),
    EMAIL_ENTRY("email-entry", "Continue with email"),
    INVALID_FORMAT("incomplete-code", "Enter the eight-digit email code."),
    REJECTED("code-rejected", "That code could not be verified. Check it or request a new one."),
    TOKEN_REJECTED("token-rejected", "The sign-in token was rejected. Request a new code."),
    SERVICE_ERROR("service-error", "The messaging service could not complete that request."),
    SIGN_IN_ERROR("sign-in-error", "Could not complete sign-in. If a session was saved, restore it."),
    SAVED_SESSION("saved-session", "Resume your session."),
    ENCRYPTION_SETUP_ERROR("encryption-setup-error", "Could not finish encryption setup. Your session is saved. Reconnect and restore it."),
    CHECKING_KEYS("checking-keys", "Checking your keys"),
    CREATE_RECOVERY("create-recovery", "Secure your account"),
    RECOVER_ACCOUNT("recover-account", "Recover your account"),
    NO_RECOVERY("no-recovery", "Recovery isn’t set up"),
    OTHER_DEVICE("other-device", "Sign out on your other phone"),
    MESSAGES("messages", "Messages"),
    RATE_LIMITED("rate-limited", Pattern.compile("Too many attempts\\. (?:Wait before trying again\\.|Try again in [0-9]{1,9} (?:seconds?|minutes?|hours?|days?)\\.)")),
    CAPACITY("capacity", "Vellivex Messenger has reached its sign-in capacity. Try again later.");

    public final String token;
    final Pattern label;
    public static final Pattern VISIBLE_LABELS;

    static {
        List<String> alternatives = new ArrayList<>();
        for (SignInObservation state : values()) alternatives.add(state.label.pattern());
        VISIBLE_LABELS = Pattern.compile("^(?:" + String.join("|", alternatives) + ")$");
    }

    SignInObservation(String token, String literal) {
        this(token, Pattern.compile(Pattern.quote(literal)));
    }

    SignInObservation(String token, Pattern label) {
        this.token = token;
        this.label = label;
    }

    /** Separate observations following the real submission from the negative control still on screen. */
    public static final class Tracker {
        private final Set<SignInObservation> reported = EnumSet.noneOf(SignInObservation.class);
        private boolean previousRejectionVisible;

        public Tracker(boolean previousRejectionVisible) {
            this.previousRejectionVisible = previousRejectionVisible;
        }

        public Set<SignInObservation> newlyVisible(Set<SignInObservation> visible) {
            if (!visible.contains(REJECTED)) previousRejectionVisible = false;
            Set<SignInObservation> fresh = EnumSet.noneOf(SignInObservation.class);
            for (SignInObservation state : visible) {
                if (state == REJECTED && previousRejectionVisible) continue;
                if (reported.add(state)) fresh.add(state);
            }
            return fresh;
        }
    }

    public static SignInObservation classify(String text) {
        if (text == null) return null;
        for (SignInObservation state : values()) {
            if (state.label.matcher(text).matches()) return state;
        }
        return null;
    }
}
