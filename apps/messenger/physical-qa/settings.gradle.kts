import groovy.json.JsonSlurper
pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        val pins = JsonSlurper().parse(file("../sdk/android-platform.json")) as Map<*, *>
        exclusiveContent {
            forRepository { maven { url = uri(pins["android_support_repository"] as String) } }
            filter { includeModule("org.rustls", "rustls-platform-verifier") }
        }
    }
}
rootProject.name = "VellivexPhysicalQA"
