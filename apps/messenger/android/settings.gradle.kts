import groovy.json.JsonSlurper

pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        val platformPins = JsonSlurper().parse(file("../sdk/android-platform.json")) as Map<*, *>
        exclusiveContent {
            forRepository {
                maven { url = uri(platformPins["android_support_repository"] as String) }
            }
            filter { includeModule("org.rustls", "rustls-platform-verifier") }
        }
    }
}
rootProject.name = "VellivexMessenger"
include(":app")
