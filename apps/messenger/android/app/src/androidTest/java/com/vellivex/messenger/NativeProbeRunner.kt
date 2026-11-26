package com.vellivex.messenger

import android.app.Application
import android.os.Bundle
import androidx.test.runner.AndroidJUnitRunner
import com.sun.jna.Function
import com.sun.jna.JNIEnv
import com.sun.jna.Library
import com.sun.jna.NativeLibrary
import dalvik.system.BaseDexClassLoader

class NativeProbeRunner : AndroidJUnitRunner() {
    private var strategy = "baseline"

    override fun onCreate(arguments: Bundle?) {
        strategy = arguments?.getString("loaderStrategy") ?: "baseline"
        super.onCreate(arguments)
    }

    override fun callApplicationOnCreate(app: Application) {
        val loader = org.matrix.rustsdk.Android::class.java.classLoader as BaseDexClassLoader
        val path = requireNotNull(loader.findLibrary("matrix_sdk_ffi"))
        require(path.startsWith("/"))
        if (strategy == "canonical-path") {
            listOf("matrix_sdk_ffi", "matrix_sdk", "matrix_sdk_base", "matrix_sdk_common", "matrix_sdk_contentscanner",
                "matrix_sdk_crypto", "matrix_sdk_sqlite", "matrix_sdk_ui", "ruma_events").forEach { module ->
                System.setProperty("uniffi.component.$module.libraryOverride", path)
            }
        }
        super.callApplicationOnCreate(app)
        if (strategy == "same-handle-init") {
            // QA-only diagnostic: same exact native symbol as the reviewed bootstrap,
            // using this process's JNA handle after application initialization.
            val options = mapOf<String, Any>(Library.OPTION_ALLOW_OBJECTS to true)
            val lib = NativeLibrary.getInstance("matrix_sdk_ffi", options)
            val init = lib.getFunction("Java_org_matrix_rustsdk_Android_init")
            init.invoke(Void.TYPE, arrayOf(JNIEnv.CURRENT, null, app.applicationContext), options)
        }
    }
}
