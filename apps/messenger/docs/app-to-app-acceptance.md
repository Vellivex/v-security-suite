# Two installed Android apps

This acceptance test operates two separately installed copies of a pinned,
signed Android release. Alpha06 is selected by default; Alpha05 remains available
for replay of its original release inputs. Each participant has its own emulator, application
process, account, device keys and application storage. A separately signed
UiAutomator package drives the controls exposed by the installed application's
interface. It does not import Messenger classes, read its session database, or
use a Matrix SDK helper as the other participant.

The original `MessengerOnboardingFlowTest` remains useful, but its second
participant is a repository fixture in the same application process. That test
does not establish that two complete installed application interfaces work
together. Keep the two kinds of evidence distinct.

## Application identity

The default release inputs are in
[`arm64-alpha06-acceptance.json`](../android/arm64-alpha06-acceptance.json).
They identify version `0.1.0-alpha06-test`, code `6`, package
`com.vellivex.messenger.alpha`, the ARM64 installer, the synthetic instrumentation
APK, both exact SHA-256 values and the unchanged signing identity. Changing the
selected manifest never relaxes the package, signer, ABI or version checks.

The unchanged historical Alpha05 inputs are:

| Item | Value |
| --- | --- |
| Application | `Vellivex-Messenger-0.1.0-alpha05-arm64.apk` |
| Application ID | `com.vellivex.messenger.alpha` |
| Version | `0.1.0-alpha05-test`, code `5` |
| ABI | `arm64-v8a` |
| SHA-256 | `6a4a72c3ad0c08ac74afa17af145a80f40fd4287ff7dabe77ef114c401366fef` |
| Signing certificate SHA-256 | `3aac05cadcd0cb90dff2474118586d537ce45cf177f237aa90a84a6ed3400df2` |

The test driver uses its own ordinary debug signing identity. The application
signing key is not needed by this workflow. The released application must never
be patched, re-signed, or replaced with a source build to make this acceptance
test pass. The driver must not clear `FLAG_SECURE` or alter the application's
authentication, recovery, encryption or contact-verification checks.

## Running the test

Use JDK 21 and an Android SDK containing platform 36, build tools 35.0.0 and
36.0.0, platform tools, the emulator, and the Android 35 Google APIs x86-64 image.
That image provides ARM64 translation. An emulator run is not a physical ARM64
or GrapheneOS test.

Build the separate driver from its own project directory:

```sh
cd apps/messenger/android-app-to-app
../android/gradlew --no-daemon --console=plain --max-workers=2 \
  :app:assembleDebug :app:assembleDebugAndroidTest
```

From the repository root, pass the exact selected release application and both
driver APKs to the runner:

```sh
bash apps/messenger/scripts/run-android-app-to-app.sh \
  /absolute/path/to/evidence \
  /absolute/path/to/Vellivex-Messenger-0.1.0-alpha06-arm64.apk \
  apps/messenger/android-app-to-app/app/build/outputs/apk/debug/app-debug.apk \
  apps/messenger/android-app-to-app/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
```

Use an empty evidence directory so a failed attempt cannot inherit an older
passing report. The runner creates two disposable virtual phones by default. Its optional final
two arguments select two existing, freshly created test emulators. Never point
it at an owner's or customer's installed application. The acceptance workflow
uses standard public GitHub-hosted runners and does not require a paid testing
provider.

The workflow's `acceptance_alpha` choice selects `alpha06` or `alpha05`.
For a local Alpha05 replay, set `MESSENGER_ACCEPTANCE_ALPHA=alpha05` when invoking
the runner and supply the original Alpha05 APK. Alpha05's manifest and checksum
remain unchanged. Evidence records the selected release; historical passes do
not transfer to a new installer.

Draft pull requests do not run the release-download acceptance jobs. They become
eligible when marked ready for review, once the exact assets are available.
Manual dispatch remains available for either reviewed release. A skipped draft
job is not a passing release check.

## What the evidence means

Both participants must complete the real interface flow: email-code sign-in,
recovery-key setup, public contact-ID sharing, conversation invitation and
acceptance, contact verification, and messages displayed in the other app.
Rejecting verification must keep the send controls unavailable. The comparison
uses complete values read from both verification dialogs, rather than a success
status supplied by the coordinator.

Each participant's application-to-server path can be interrupted separately.
Messages are checked again after that path is restored. The runner then stops
both application processes without uninstalling, clearing data or signing out,
and starts a separate test phase to check retained sessions, verification and
message history, followed by another exchange through both interfaces.

The coordinator supplies only synthetic `example.test` mailbox delivery,
barriers, comparisons of UI-read verification values, and network interruption.
It must not become a third messaging participant or perform an application
action on either participant's behalf. Public evidence contains safe checkpoint
names, booleans, package identity, completion status and interruption counts.
It excludes email codes, recovery keys, session tokens, public contact IDs,
verification values, raw message traffic and full interface dumps.

Read the actual workflow outcome and retained evidence before claiming a pass.
A successful build, a started emulator, a local message echo or an HTTP response
does not by itself establish successful app-to-app messaging.

## Known Alpha05 accessibility defect

The released inbox's **New conversation** floating action button has no
accessibility name. The icon-and-text overload of Material3's
`ExtendedFloatingActionButton` takes its default accessibility description from
the icon and clears the text slot's semantics. Alpha05 supplies a null icon
description. The first two installed-app runs therefore could not find this
control by its displayed text, although both apps had reached the empty inbox.

This defect must remain visible in the acceptance result. For the unchanged
Alpha05 installer, the driver may identify the unique visible, enabled,
clickable inbox button from its observed UI structure, click it once, and require
the real **Start a conversation** dialog to appear. It must fail if the target
is missing or ambiguous. This permits the remaining functional checks without
claiming that the button is accessible or modifying the released application.
Compose UI 1.9.4 can export a clickable control as a generic view with a separate,
non-clickable Button-role child. The driver must establish that relationship
from the actual UI nodes instead of assuming that the clickable node itself has
the Button class. The third run's strict Button-class selector found no matching
control; it did not tap a control or establish message delivery.
Alpha06 gives the icon the explicit accessibility description **New conversation**.
When testing Alpha06, the driver requires a unique visible, enabled, clickable
control with that exact description and records the description-based selection.
The anonymous-control fallback is allowed only for historical Alpha05. Thus an
Alpha06 pass must exercise the actual accessible control; it cannot inherit the
old workaround. This does not replace a physical TalkBack review.

Primary references: [Android component documentation](https://developer.android.com/reference/kotlin/androidx/compose/material3/ExtendedFloatingActionButton.composable),
the [Material3 1.4.0 source archive](https://dl.google.com/dl/android/maven2/androidx/compose/material3/material3-android/1.4.0/material3-android-1.4.0-sources.jar),
and the [Compose UI 1.9.4 source archive](https://dl.google.com/dl/android/maven2/androidx/compose/ui/ui-android/1.9.4/ui-android-1.9.4-sources.jar).

## Limits

The automated workflow uses a disposable local Synapse service and synthetic
email delivery. It does not prove production SMTP delivery, a correct live
email-code exchange, current invitation configuration, or the live service's
network path. Those require a separate live-service test with controlled
accounts. Do not expose production credentials or personal email addresses in
this public workflow.

Incorrect recovery-key setup acknowledgement and actual account recovery are
different tests. Only claim recovery on another installation after actually
completing that distinct flow. Existing installations must continue to update
in place while signed in; the alpha's saved recovery key may not restore any
earlier messages.

This is functional acceptance testing. It is not an independent professional
security audit, physical-device certification, background-notification guarantee
or unrestricted public-launch approval.
