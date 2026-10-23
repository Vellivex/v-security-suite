package app.vguard.firewall;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.Collection;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import java.util.TreeSet;

/** Private, explicit app selections. A new installation blocks nothing. */
public final class RuleStore {
    public static final String MODE_NORMAL = "normal";
    public static final String MODE_JOURNEY = "journey";
    private static final String PREFERENCES = "vguard_rules_v1";

    private RuleStore() { }

    public static Set<String> getBlocked(Context context, String mode) {
        Set<String> stored;
        try {
            stored = preferences(context).getStringSet(key(mode), Collections.<String>emptySet());
        } catch (ClassCastException invalidPreference) {
            stored = Collections.emptySet();
        }
        return canonicalPackages(stored, context.getPackageName());
    }

    public static void setBlocked(Context context, String mode, Set<String> packages) {
        Set<String> clean = canonicalPackages(packages, context.getPackageName());
        preferences(context).edit().putStringSet(key(mode), new HashSet<String>(clean)).apply();
    }

    public static String getMode(Context context) {
        try {
            return normalizeMode(preferences(context).getString("mode", MODE_NORMAL));
        } catch (ClassCastException invalidPreference) {
            return MODE_NORMAL;
        }
    }

    public static void setMode(Context context, String mode) {
        preferences(context).edit().putString("mode", normalizeMode(mode)).apply();
    }

    public static String normalizeMode(String mode) {
        return MODE_JOURNEY.equals(mode) ? MODE_JOURNEY : MODE_NORMAL;
    }

    /** Shared by storage and the VPN's final validation, and independently testable. */
    public static Set<String> canonicalPackages(Collection<String> packages, String ownPackage) {
        TreeSet<String> clean = new TreeSet<String>();
        if (packages != null) {
            for (String candidate : packages) {
                if (candidate == null) continue;
                String name = candidate.trim();
                if (!name.equals(ownPackage) && isPackageName(name)) clean.add(name);
            }
        }
        return Collections.unmodifiableSet(clean);
    }

    public static boolean isPackageName(String name) {
        if (name == null || name.length() == 0 || name.length() > 255) return false;
        boolean atStart = true;
        for (int i = 0; i < name.length(); i++) {
            char c = name.charAt(i);
            if (c == '.') {
                if (atStart) return false;
                atStart = true;
            } else {
                boolean letter = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_';
                boolean digit = c >= '0' && c <= '9';
                if (!letter && !(digit && !atStart)) return false;
                atStart = false;
            }
        }
        return !atStart;
    }

    private static String key(String mode) { return "blocked_" + normalizeMode(mode); }
    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }
}
