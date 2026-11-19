package com.vellivex.messenger

import android.content.Context
import org.matrix.rustcomponents.sdk.LogLevel
import org.matrix.rustcomponents.sdk.TracingConfiguration
import org.matrix.rustcomponents.sdk.initPlatform

/** Runs once before any repository or native SDK client can be created. */
internal fun initializeMessengerPlatform(context: Context) {
    org.matrix.rustsdk.Android.init(context.applicationContext)
    initPlatform(
        TracingConfiguration(
            logLevel = LogLevel.ERROR,
            traceLogPacks = emptyList(),
            extraTargets = emptyList(),
            writeToStdoutOrSystem = false,
            writeToFiles = null,
            sentryConfig = null,
        ),
        useLightweightTokioRuntime = false,
    )
}
