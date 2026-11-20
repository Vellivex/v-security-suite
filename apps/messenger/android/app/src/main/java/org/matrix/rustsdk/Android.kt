// SPDX-License-Identifier: Apache-2.0
// JNI contract documented by the pinned Matrix SDK's
// bindings/matrix-sdk-ffi/src/platform/android_platform.rs.
package org.matrix.rustsdk

import android.content.Context

/** Supplies the application JVM and context to the SDK's Android TLS verifier. */
internal object Android {
    init {
        System.loadLibrary("matrix_sdk_ffi")
    }

    @JvmStatic
    external fun init(context: Context)
}
