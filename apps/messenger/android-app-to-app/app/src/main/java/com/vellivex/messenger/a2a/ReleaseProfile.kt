// SPDX-License-Identifier: GPL-3.0-or-later
package com.vellivex.messenger.a2a

internal enum class ReleaseProfile(
    val argument: String,
    val versionCode: Int,
    val versionName: String,
    val normalRelease: Boolean,
) {
    Alpha06Test("alpha06-test", 6, "0.1.0-alpha06-test", false),
    Alpha07Release("alpha07-release", 7, "0.1.0-alpha07", true),
    Alpha08Release("alpha08-release", 8, "0.1.0-alpha08", true),
    Alpha09Release("alpha09-release", 9, "0.1.0-alpha09", true);

    fun supportsScenario(scenario: String): Boolean =
        scenario == "fresh" || (scenario == "upgrade-alpha07" && this == Alpha08Release)

    companion object {
        fun from(argument: String?): ReleaseProfile {
            if (argument == null) return Alpha06Test
            return entries.singleOrNull { it.argument == argument }
                ?: throw IllegalArgumentException("Unsupported live release profile")
        }
    }
}
