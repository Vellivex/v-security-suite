# Live two-app acceptance

This is a separate production test. It does not change the existing isolated
two-app evidence or pretend that synthetic email delivery is production delivery.
Its default scenario operates two fresh installations of the selected exact signed
ARM64 APK on two dedicated Android emulators. The optional Alpha07 update scenario
preserves one failed-login session while updating that installation to Alpha08.
Both apps retain their default
`https://messenger.vellivex.com` server, use genuinely received email codes, compare
their displayed verification values, and exchange fictional messages in both
directions before and after an actual app-process cold restart.

The independent driver must also find **New conversation** by its accessible name.
It has no anonymous-button fallback. After the successful restart exchange, each
disposable installation signs out through the app's own interface. This ends those
test sessions; it does not delete the production accounts or conversations. On a
failed run, sign-out is unproven unless its checkpoint is present. Existing owner
or customer installations are never used, cleared, signed out or uninstalled.
Do not reuse aliases from an interrupted setup: the test deliberately does not
export their recovery keys, and a session on a destroyed emulator may remain
registered until explicitly resolved through the supported account flow.

The fresh driver confirms that the enabled editor accepted the privately supplied code
and records a separate checkpoint after tapping its enabled submit control. It then
observes only fixed, public screen labels for up to 60 seconds. A reported saved
session, encryption error, key check, existing recovery or other active phone is a
diagnostic observation. Only the actual fresh recovery setup screen advances this
test. The negative-control rejection banner is ignored until it disappears after
the previous submission. Reports never include entered values, their hashes, raw
screen text or network details.

## Explicit release profiles

The existing five-argument runner invocation remains the **Alpha06 test-build**
profile. Its exact manifest, version checks and visible default-server check are
unchanged. The workflow's explicit `release_profile` selection defaults to
`alpha08-release`; historical `alpha06-test` and `alpha07-release` remain selectable.
The default `installation_scenario` is `fresh`. A draft PR still does not run the
live job, and no profile may run with incomplete installer metadata.

The runner additionally accepts the explicit final arguments
`--profile alpha07-release` or `--profile alpha08-release`. Each closed profile
requires the same `com.vellivex.messenger.alpha` package and original signer,
and its exact normal-release version: code **7** / **`0.1.0-alpha07`**, or code
**8** / **`0.1.0-alpha08`**. It rejects a debuggable APK during preflight and
checks the installed application's `FLAG_DEBUGGABLE` is clear on each app and
phase. It asserts that **Test server settings** and **Server address** are absent
at sign-in and after successful sign-out, without attempting to open either.
The independent test driver itself may remain a debug build.

`apps/messenger/android/arm64-alpha07-live-acceptance.json` pins the inspected local
candidate's exact hash, length, original signer and build source. Its `app_url`
is deliberately null until a public download route is confirmed. The runner
rejects missing, null, malformed or mismatched fields. Fill only `app_url` with
that confirmed public HTTPS URL; do not relabel different APK bytes as this
profile. The fixed production origin was checked in the release build and APK
inspection, and `production_origin_verified_app_sha256` binds that review to the
same installer. This field records the completed artifact review; it does not
claim a completed live connection. A missing
settings button does not prove an endpoint, so the Alpha07 UI emits separate
normal-release checkpoints instead of claiming a visible server-address check.

`arm64-alpha08-live-acceptance.json` identifies the unchanged reviewed application
source `6e29154ce8f67da8828abb198cd4e74f00951730`. The reviewed original-signed
ARM64 candidate is **57,542,436 bytes**, SHA-256
`95661c6ea7f8b5d40e9fd6ba6797a5a2f6b276f681369420b4e55348784579e4`.
Its package, version, signer, non-debug policy, generated release production origin,
packaged origin, retained native SDK bytes and 16 KiB ZIP alignment were checked
before populating the manifest. The unchanged release build passed ten unit tests
and lint with no errors. These checks do not establish public availability or a
live acceptance pass. `live-release-profile.py` rejects incomplete metadata and
verifies the complete downloaded bytes before private input or device action.
The fixed Alpha08 route is
`https://www.vellivex.com/downloads/Vellivex-Messenger-0.1.0-alpha08-arm64.apk`.

A live run still needs a publicly retrievable exact installer, two fresh controlled
inboxes and genuinely received codes. All shared real-code, recovery-setup, full verification-code,
rejection, message, restart, sign-out and private-input checks remain required.
Preparing this profile or compiling it does not establish a live acceptance pass.

## Preserved Alpha07 session update scenario

`installation_scenario: upgrade-alpha07` is available only with `alpha08-release`.
Participant A starts from the unchanged original-signed Alpha07 installer and B
starts from Alpha08. Both use fresh disposable inboxes and the same encrypted code
handoff as the fresh scenario. Alpha07 receives its code through its own UI. After
its connection fails, the driver requires the visible local saved-session guard
when attempting to begin another sign-in; that guard prevents another email request.

Only after this checkpoint, `live-preserved-session-update.py` force-stops the
runner's own participant A and performs `adb install -r` with the pinned Alpha08
bytes. It requires unchanged application UID and first-install timestamp alongside
the version change from 7 to 8. It never uninstalls, clears data, signs out, reads
the private session store or uses a repository method. It refuses physical devices,
the other participant and baseline files outside this job's private runner directory.

The independent UI then requires the exact installed Alpha08 identity, restores
the saved session without requesting another email code, completes recovery setup,
and joins all the same verification, messaging, restart and sign-out assertions.
This scenario establishes preservation of a session saved after a failed Alpha07
connection. It does **not** establish preservation of pre-upgrade message history,
which this original Alpha07 installation could not create. Its evidence is separate
from two-fresh-Alpha08 acceptance and cannot be counted as that scenario's pass.

Both manifests must point to verified immutable downloads before this scenario
starts. A retired website alias redirecting to the guide is not an Alpha07 download.
Keep its original reviewed bytes; do not rebuild or replace the historical package.

## Production boundaries

The coordinator is private loopback test infrastructure, not a Matrix client.
It never sends or receives app messages and cannot substitute for either app.
The app's Matrix and email-authentication connections go directly to the production
HTTPS endpoint. There is no TLS interception, synthetic mailbox or network proxy.
This suite therefore makes no packet-level encrypted-send counter, plaintext-send
counter, simulated interruption, physical-phone or full-phone-reboot claim.

Only two fresh, owner-controlled test inboxes may be supplied. They must be distinct
and unused for existing Messenger sessions. Do not read a code from the production
database, substitute a development code, disable authentication, or work around a
withheld code or an access-control decision. If the connected mailbox will not
return a sign-in code, the owner must supply that newly received code directly.

## Workflow and the two handoffs

The workflow is `.github/workflows/messenger-live-app-to-app.yml`. It uses standard
GitHub-hosted Linux runners and requires no provider credential or repository
secret. It runs manually or on an eligible same-repository, non-draft pull request.
Draft pull requests keep the live job skipped; marking a reviewed pull request
ready enables its `ready_for_review` trigger. The selected exact release assets must
already be available before starting a live run.

1. The job verifies the pinned installer, builds the separately signed interface
   driver, checks sealed-input behavior, and generates a fresh 3072-bit RSA key.
   The private key remains in a mode-0700 temporary directory on that runner.
2. It uploads **only** `public-key.json` as
   `messenger-live-public-key-RUN_ID-ATTEMPT` before it waits for any private input.
3. The operator retrieves that artifact using the authenticated GitHub connector.
   **Authenticate its repository, workflow identity, run ID, run attempt, reviewed
   source head and artifact ID against the actual workflow response.** Then verify
   that the descriptor's run, attempt, head, session and key fingerprint agree.
   A descriptor that merely agrees with itself is not authentication.
4. The operator seals each test email separately and publishes only the resulting
   ciphertext envelope to the dedicated input branch. The apps start and request
   their codes through their own visible interfaces.
5. When both apps show **Eight-digit email code**, the coordinator produces
   `code-handoff.json`. The workflow uploads it as
   `messenger-live-code-ready-RUN_ID-ATTEMPT` while both apps are still waiting.
   The handoff includes only run/key binding, role labels, request timestamps and
   a conservative code deadline. It contains no email address or code.
6. Authenticate this artifact's run and attempt in the same way. Require its
   repository, source head, session and key to match the already authenticated
   public-key descriptor. Both `A` and `B` must be ready and the conservative
   deadline must still be in the future. Then ask the owner for the two newly
   received codes if automatic mailbox access is unavailable.
7. Seal each received code for the correct role. Each sealed code expires after
   **300 seconds**, and the coordinator also enforces the production request's
   conservative 600-second deadline. A stale input must fail; do not weaken this
   check or reuse an earlier run's code. The apps continue automatically after
   the valid envelopes arrive.
8. The job retains only the explicitly listed sanitized evidence files. It stops
   its own process group and destroys the ephemeral key, decoded inputs, raw logs,
   temporary Git objects and emulator state on completion or failure. Normal
   GitHub runner process tracking is preserved as an additional cleanup boundary.

The initial code-screen preparation window is bounded to 20 minutes; the final
execution wait is separately bounded to 20 minutes inside a 45-minute job. A run
with expired codes is a failure, not a reason to claim completion or automatically
increase production email quotas. Each run requests one code for each of two fresh
test addresses. The production rate limits still apply.

## Sealing inputs

Use the reviewed `apps/messenger/scripts/live-input-envelope.mjs` helper with Node.
Keep all plaintext input files outside the repository in a private directory and
set their permissions to 0600. Do not put private input in shell command arguments,
workflow inputs, source, commits, console output, screenshots or artifacts.

The helper takes a one-field JSON object on standard input. An email input has
the field `email`; a code input has the field `code`, represented as an eight-digit
string. The examples below use paths only and do not include real input values.

```sh
node apps/messenger/scripts/live-input-envelope.mjs seal \
  /private/public-key.json A email /private/sealed-A-email.json < /private/email-A.json
node apps/messenger/scripts/live-input-envelope.mjs seal \
  /private/public-key.json B email /private/sealed-B-email.json < /private/email-B.json

# Only after the authenticated ready artifact and actual email receipt:
node apps/messenger/scripts/live-input-envelope.mjs seal \
  /private/public-key.json A code /private/sealed-A-code.json < /private/code-A.json
node apps/messenger/scripts/live-input-envelope.mjs seal \
  /private/public-key.json B code /private/sealed-B-code.json < /private/code-B.json
```

Publish the four **sealed envelope files only**, as they become available, to
`test/messenger-live-inputs` in the same Vellivex repository:

```text
live-input/RUN_ID/SESSION_ID/A-email.json
live-input/RUN_ID/SESSION_ID/B-email.json
live-input/RUN_ID/SESSION_ID/A-code.json
live-input/RUN_ID/SESSION_ID/B-code.json
```

Take `RUN_ID` and `SESSION_ID` from the authenticated descriptor. The input branch
is a dedicated data branch, ideally created from a small independent tree. Use
normal Vellivex author/committer identity and expected-head fast-forward updates.
Do not force-update a shared branch. No plaintext input is staged in a code
checkout. The runner only reads exact data paths from a fetched commit; it never
checks out or executes any input-branch source.

Each envelope uses a fresh AES-256-GCM key and 96-bit nonce, with a 128-bit tag.
RSA-OAEP with SHA-256 wraps that AES key. Authenticated additional data binds the
repository, run, attempt, reviewed source head, ephemeral session, key fingerprint,
role, purpose, one-use nonce and lifetime. A consumed nonce or an already supplied
role/purpose cannot be replayed or overwritten. The public-key artifact is the
only key material uploaded. The private key never leaves the runner, and there is
no provider or owner credential in the workflow.

## Evidence and acceptance

The final artifact is `messenger-live-two-installed-apps-PROFILE-SCENARIO-RUN_ID-ATTEMPT`.
The workflow uses an explicit file allowlist: verified APK identity, installed-app
metadata, hashed device-separation evidence, cold-restart observations, the four
sanitized interface logs, `two-app-summary.json`, `code-handoff.json`,
`installation-scenario.json`, and, only for the update scenario, `upgrade-alpha07.json`.
Only those files are uploaded; the private supervisor log is not an artifact.

Pass requires all four actual interface executions (`A/B` × `fresh/restart`),
both full displayed-code comparisons, rejection that leaves sending blocked,
successful real-code sign-in, visible messages on the opposite app, persisted
trust and earlier messages after both app processes are stopped, new messages
in both directions after reopening, and successful sign-out of both disposable
test sessions. The same original-signed installer is checked by SHA-256,
certificate, package, version and ARM64 ABI. The separately signed instrumentation
targets its own harness package.

Build and protocol tests alone are not a production test pass. Publish a live-pass
claim only after inspecting that completed run and its exact retained evidence.
