package com.vellivex.messenger

import com.google.zxing.BarcodeFormat
import com.google.zxing.common.BitMatrix
import com.google.zxing.qrcode.QRCodeWriter

internal fun invitationQrCode(userId: String): BitMatrix =
    QRCodeWriter().encode(vellivexInvitation(userId), BarcodeFormat.QR_CODE, 360, 360)
