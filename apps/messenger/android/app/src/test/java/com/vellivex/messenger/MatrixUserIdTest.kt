package com.vellivex.messenger

import com.google.zxing.BinaryBitmap
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MatrixUserIdTest {
    @Test
    fun acceptsRawIdAndCanonicalMatrixShareLink() {
        val id = "@vellivex_0123:alpha.example"
        assertEquals(id, matrixUserId("  $id  "))
        assertEquals(id, matrixUserId("https://matrix.to/#/$id"))
        assertEquals(id, matrixUserId("https://matrix.to/#/%40vellivex_0123%3Aalpha.example"))
    }

    @Test
    fun generatedInvitationOpensInVellivexAndKeepsContactInTheFragment() {
        val id = "@vellivex_0123:alpha.example"
        val invitation = vellivexInvitation(id)
        assertEquals("https://www.vellivex.com/invite#/$id", invitation)
        assertEquals(id, vellivexInvitationContact(invitation))
        assertEquals(id, matrixUserId(invitation))
        assertEquals(id, vellivexInvitationContact("https://www.vellivex.com/invite#/%40vellivex_0123%3Aalpha.example"))
        val withPunctuation = "@item+one/two:[::1]:8448"
        assertEquals(withPunctuation, vellivexInvitationContact(vellivexInvitation(withPunctuation)))
    }

    @Test
    fun scanningTheProfileCodeReturnsTheSameVellivexInvitationThatIsShared() {
        val id = "@vellivex_0123:alpha.example"
        val code = invitationQrCode(id)
        val pixels = IntArray(code.width * code.height) { i ->
            if (code[i % code.width, i / code.width]) 0xff000000.toInt() else 0xffffffff.toInt()
        }
        val image = BinaryBitmap(HybridBinarizer(RGBLuminanceSource(code.width, code.height, pixels)))
        val scanned = QRCodeReader().decode(image).text
        assertEquals("https://www.vellivex.com/invite#/$id", scanned)
        assertEquals(vellivexInvitation(id), scanned)
        assertEquals(id, vellivexInvitationContact(scanned))
    }

    @Test
    fun onlyFirstPartyLinksCanOpenAnInvitationFromOutsideTheApp() {
        val id = "@vellivex_0123:alpha.example"
        assertNull(vellivexInvitationContact(id))
        assertNull(vellivexInvitationContact("https://matrix.to/#/$id"))
        listOf(
            "https://www.vellivex.com/invite",
            "https://www.vellivex.com/invite#/",
            "https://www.vellivex.com/invite/#/$id",
            "http://www.vellivex.com/invite#/$id",
            "https://vellivex.com/invite#/$id",
            "https://www.vellivex.com.attacker.example/invite#/$id",
            "https://www.vellivex.com@attacker.example/invite#/$id",
            "https://www.vellivex.com:443/invite#/$id",
            "https://www.vellivex.com/invite?contact=test#/$id",
            "https://www.vellivex.com/invite/$id",
            "https://www.vellivex.com/invite#/$id%0A",
            "https://www.vellivex.com/invite#/%2540vellivex_0123%253Aalpha.example",
            "https://www.vellivex.com/invite#/!room:alpha.example",
        ).forEach { url ->
            assertNull(url, vellivexInvitationContact(url))
            assertNull(url, matrixUserId(url))
        }
    }

    @Test
    fun rejectsLinksOutsideTheExactShareShape() {
        val id = "@vellivex_0123:alpha.example"
        listOf(
            "http://matrix.to/#/$id",
            "https://matrix.to.attacker.example/#/$id",
            "https://matrix.to@attacker.example/#/$id",
            "https://matrix.to:443/#/$id",
            "https://matrix.to/other/#/$id",
            "https://matrix.to/?x=y#/$id",
            "https://matrix.to/#/$id?via=alpha.example",
            "https://matrix.to/#/!room:alpha.example",
            "https://matrix.to/#/%40vellivex_0123%3Aalpha.example%0A",
        ).forEach { assertNull(matrixUserId(it)) }
    }
}
