package com.vellivex.messenger

import java.net.URI

internal fun matrixUserId(value: String): String? {
    val input = value.trim()
    if (input.length > 535) return null
    val id = if (input.startsWith('@')) input else {
        val uri = runCatching { URI(input) }.getOrNull() ?: return null
        if (uri.scheme != "https" || !"matrix.to".equals(uri.host, ignoreCase = true) ||
            uri.port != -1 || uri.userInfo != null || uri.rawPath != "/" || uri.rawQuery != null
        ) return null
        uri.fragment?.takeIf { it.startsWith("/@") }?.removePrefix("/") ?: return null
    }
    val separator = id.indexOf(':')
    if (id.length !in 4..255 || separator < 2 || separator == id.lastIndex) return null
    val localpart = id.substring(1, separator)
    val server = id.substring(separator + 1)
    return id.takeIf {
        localpart.matches(Regex("[A-Za-z0-9_.=+/-]+")) && server.matches(Regex("[A-Za-z0-9.:\\[\\]-]+"))
    }
}
