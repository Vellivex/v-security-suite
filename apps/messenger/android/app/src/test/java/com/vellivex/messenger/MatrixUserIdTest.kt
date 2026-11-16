package com.vellivex.messenger

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
