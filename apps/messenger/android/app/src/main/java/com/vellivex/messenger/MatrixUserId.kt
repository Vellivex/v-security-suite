package com.vellivex.messenger

import java.net.URI

private const val INVITE_HOST = "www.vellivex.com"
private const val INVITE_PATH = "/invite"

internal fun vellivexInvitation(userId: String): String = "https://$INVITE_HOST$INVITE_PATH#/$userId"

internal fun vellivexInvitationContact(url: String): String? = invitationContact(url, allowMatrixLink = false)

internal fun matrixUserId(value: String): String? {
    val input = value.trim()
    return if (input.startsWith('@')) validContactId(input) else invitationContact(input, allowMatrixLink = true)
}

private fun invitationContact(input: String, allowMatrixLink: Boolean): String? {
    if (input.length > 1024) return null
    val uri = runCatching { URI(input) }.getOrNull() ?: return null
    if (uri.scheme != "https" || uri.port != -1 || uri.userInfo != null || uri.rawQuery != null) return null
    val firstParty = INVITE_HOST.equals(uri.rawAuthority, ignoreCase = true) && uri.rawPath == INVITE_PATH
    val legacy = allowMatrixLink && "matrix.to".equals(uri.rawAuthority, ignoreCase = true) && uri.rawPath == "/"
    if (!firstParty && !legacy) return null
    val fragment = uri.fragment?.takeIf { it.startsWith("/@") } ?: return null
    return validContactId(fragment.substring(1))
}

private fun validContactId(id: String): String? {
    val separator = id.indexOf(':')
    if (id.length !in 4..255 || separator < 2 || separator == id.lastIndex) return null
    val localpart = id.substring(1, separator)
    val server = id.substring(separator + 1)
    return id.takeIf {
        localpart.matches(Regex("[A-Za-z0-9_.=+/-]+")) && server.matches(Regex("[A-Za-z0-9.:\\[\\]-]+"))
    }
}
