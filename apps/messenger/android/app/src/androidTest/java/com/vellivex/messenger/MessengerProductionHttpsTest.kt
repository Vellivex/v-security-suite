package com.vellivex.messenger

import android.util.Base64
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.matrix.rustcomponents.sdk.ClientBuilder
import org.matrix.rustcomponents.sdk.ClientException
import org.matrix.rustcomponents.sdk.RequestConfig
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.security.KeyStore
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLServerSocket
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManagerFactory

/** Real native HTTPS requests; no sign-in, email, account, token or message is used. */
@RunWith(AndroidJUnit4::class)
class MessengerProductionHttpsTest {
    @Test
    fun applicationBootstrapAllowsNativeProductionVersionsRequest() = runBlocking {
        sanitized("Native SDK production HTTPS versions request failed") {
            assertApplicationBootstrap()
            assertEquals(PRODUCTION_ORIGIN, BuildConfig.PRODUCTION_SERVER_URL)
            withTimeout(35_000) { fetchNativeVersions(PRODUCTION_ORIGIN) }
        }
    }

    @Test
    fun nativeClientRejectsAnUntrustedLoopbackCertificate() = runBlocking {
        sanitized("Native SDK untrusted-certificate regression failed") {
            assertApplicationBootstrap()
            SelfSignedTlsProbe().use { probe ->
                // This independent control trusts only this disposable certificate.
                // It proves the fixture can complete TLS and serve the versions route.
                probe.checkFixtureWithItsCertificate()
                val acceptedBefore = probe.acceptedConnections.get()
                val requestsBefore = probe.httpRequests.get()
                var certificateRejected = false
                try {
                    withTimeout(20_000) { fetchNativeVersions(probe.origin) }
                } catch (error: ClientException.Generic) {
                    // Inspect locally; never put raw native errors or response content
                    // into an assertion, test artifact, or public workflow log.
                    val detail = "${error.msg} ${error.details.orEmpty()}"
                    certificateRejected = Regex(
                        "certificate|certpath|unknown.?issuer|unknown.?ca|trust anchor",
                        RegexOption.IGNORE_CASE,
                    ).containsMatchIn(detail)
                }
                assertTrue("Native TLS did not reject the untrusted certificate", certificateRejected)
                assertTrue("Native client never reached the TLS fixture", probe.acceptedConnections.get() > acceptedBefore)
                assertEquals("Untrusted TLS received an HTTP request", requestsBefore, probe.httpRequests.get())
            }
        }
    }

    private fun assertApplicationBootstrap() {
        // AndroidJUnitRunner starts the real manifest Application before this test.
        // Do not call Android.init here: that would hide a missing app bootstrap.
        assertTrue(
            "Instrumentation did not start the Messenger application",
            InstrumentationRegistry.getInstrumentation().targetContext.applicationContext is MessengerApplication,
        )
    }

    private suspend fun fetchNativeVersions(origin: String) {
        ClientBuilder().use { root ->
            root.homeserverUrl(origin).use { remote ->
                remote.inMemoryStore().use { memory ->
                    memory.disableWellKnownLookup(true).use { discovery ->
                        discovery.requestConfig(
                            RequestConfig(retryLimit = 0uL, timeout = 10_000uL, maxConcurrentRequests = 1uL, maxRetryTime = 10_000uL),
                        ).use { configured ->
                            configured.build().use { client ->
                                assertEquals(origin, client.homeserver().trimEnd('/'))
                                client.resetSupportedVersions()
                                // In the pinned SDK, this awaits supported_versions() with
                                // error propagation. An empty in-memory cache forces GET
                                // /_matrix/client/versions. Either capability value is valid;
                                // successful native TLS + response parsing is the assertion.
                                // homeserverLoginDetails() would silently swallow failures.
                                client.isReportRoomApiSupported()
                            }
                        }
                    }
                }
            }
        }
    }

    private suspend fun sanitized(message: String, block: suspend () -> Unit) {
        try {
            block()
        } catch (error: Throwable) {
            // No cause: native exceptions may contain request/response details.
            throw AssertionError("$message (${error.javaClass.simpleName})")
        }
    }

    private class SelfSignedTlsProbe : AutoCloseable {
        val acceptedConnections = AtomicInteger()
        val httpRequests = AtomicInteger()
        private val executor = Executors.newSingleThreadExecutor()
        private val server: SSLServerSocket
        private val controlContext: SSLContext
        val origin: String get() = "https://127.0.0.1:${server.localPort}"

        init {
            // Intentionally public test key, confined to the instrumentation APK.
            // Its SAN covers 127.0.0.1 and localhost; trust is the only invalid part.
            val password = "public-test-fixture".toCharArray()
            val keyStore = KeyStore.getInstance("PKCS12").apply {
                InstrumentationRegistry.getInstrumentation().context.assets.open("untrusted-loopback-test-fixture.txt").use {
                    load(Base64.decode(it.readBytes(), Base64.DEFAULT).inputStream(), password)
                }
            }
            val managers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply {
                init(keyStore, password)
            }
            val tls = SSLContext.getInstance("TLSv1.2").apply { init(managers.keyManagers, null, null) }
            server = (tls.serverSocketFactory.createServerSocket(0, 8, InetAddress.getByName("127.0.0.1")) as SSLServerSocket).apply {
                soTimeout = 500
                enabledProtocols = arrayOf("TLSv1.2")
            }
            val fixtureTrust = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
                load(null)
                setCertificateEntry("fixture", keyStore.getCertificate("loopback-test-only"))
            }
            val trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(fixtureTrust) }
            controlContext = SSLContext.getInstance("TLSv1.2").apply { init(null, trust.trustManagers, null) }
            executor.submit {
                while (!server.isClosed) {
                    try {
                        (server.accept() as SSLSocket).use { socket ->
                            acceptedConnections.incrementAndGet()
                            socket.soTimeout = 5_000
                            socket.startHandshake()
                            val input = socket.inputStream.bufferedReader(Charsets.US_ASCII)
                            val request = input.readLine()
                            var headers = 0
                            while (!input.readLine().isNullOrEmpty()) {
                                check(++headers <= 32)
                            }
                            httpRequests.incrementAndGet()
                            val valid = request == "GET /_matrix/client/versions HTTP/1.1"
                            val status = if (valid) "200 OK" else "404 Not Found"
                            val body = if (valid) "{\"versions\":[\"v1.11\"],\"unstable_features\":{}}" else "{}"
                            socket.outputStream.write(
                                "HTTP/1.1 $status\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n$body".toByteArray(Charsets.US_ASCII),
                            )
                            socket.outputStream.flush()
                        }
                    } catch (_: SocketTimeoutException) {
                        // Short accept/read bounds also permit prompt cleanup.
                    } catch (_: Exception) {
                        // A client rejecting the untrusted certificate closes TLS.
                        // A fixture failure is caught by the independent control request.
                    }
                }
            }
        }

        fun checkFixtureWithItsCertificate() {
            (controlContext.socketFactory.createSocket("127.0.0.1", server.localPort) as SSLSocket).use { socket ->
                socket.soTimeout = 5_000
                socket.sslParameters = socket.sslParameters.apply { endpointIdentificationAlgorithm = "HTTPS" }
                socket.startHandshake()
                socket.outputStream.write("GET /_matrix/client/versions HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n".toByteArray(Charsets.US_ASCII))
                socket.outputStream.flush()
                assertEquals("HTTP/1.1 200 OK", socket.inputStream.bufferedReader(Charsets.US_ASCII).readLine())
            }
            assertEquals(1, httpRequests.get())
        }

        override fun close() {
            server.close()
            executor.shutdownNow()
            executor.awaitTermination(6, TimeUnit.SECONDS)
        }
    }

    private companion object {
        const val PRODUCTION_ORIGIN = "https://messenger.vellivex.com"
    }
}
