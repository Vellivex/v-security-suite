// SPDX-License-Identifier: GPL-3.0-or-later
package com.vellivex.messenger.a2a

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ReleaseProfileTest {
    @Test fun alpha09RequiresTheNormalReleaseVersion() {
        val profile = ReleaseProfile.from("alpha09-release")
        assertEquals(ReleaseProfile.Alpha09Release, profile)
        assertEquals(9, profile.versionCode)
        assertEquals("0.1.0-alpha09", profile.versionName)
        assertTrue(profile.normalRelease)
        assertTrue(profile.supportsScenario("fresh"))
        assertFalse(profile.supportsScenario("upgrade-alpha07"))
    }

    @Test fun earlierProfilesKeepTheirIdentitiesAndUpgradeRules() {
        assertEquals(ReleaseProfile.Alpha06Test, ReleaseProfile.from(null))
        assertFalse(ReleaseProfile.from("alpha06-test").normalRelease)
        assertFalse(ReleaseProfile.from("alpha07-release").supportsScenario("upgrade-alpha07"))
        assertTrue(ReleaseProfile.from("alpha08-release").supportsScenario("upgrade-alpha07"))
        assertThrows(IllegalArgumentException::class.java) { ReleaseProfile.from("alpha09-test") }
    }
}
