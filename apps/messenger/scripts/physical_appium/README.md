# Two stock Android phones

The independent Appium test installs the reviewed, signed Alpha08 ARM64 APK on two BrowserStack App Automate devices. It checks the normal production sign-in UI, recovery setup, matching verification displays, bidirectional delivery, persistence after restarting both apps, and sign-out. It records fixed checkpoints for each phone. GrapheneOS and the other release checks have separate acceptance records.

## Operator setup

Create the GitHub environment `vellivex-physical-qa` under repository settings. Restrict deployment to the protected branches `test/messenger-physical-canary` and `test/messenger-physical-acceptance`, allow only reviewed release-operator changes to those refs, and require an authorized reviewer where supported. Store the following in this environment.

| Environment secret | Source |
| --- | --- |
| `BROWSERSTACK_USERNAME` | BrowserStack Account settings, Automate credentials |
| `BROWSERSTACK_ACCESS_KEY` | BrowserStack Account settings, Automate credentials |
| `VELLIVEX_QA_EMAIL_SHA256_A` | Private QA enrollment record for phone A |
| `VELLIVEX_QA_EMAIL_SHA256_B` | Private QA enrollment record for phone B |

Before promoting a reviewed commit, verify the account's remaining free device minutes and the production sign-in quota. Each privacy run uses two stock devices. An acceptance run first audits the completed privacy sessions and then opens two fresh sessions. The App Automate plan API must report two available device slots. The runner never signs up for or purchases service.

## Execution

1. A feature pull request runs synthetic tests. The two protected execution refs activate the provider workflow on an explicit operator push. Point the canary ref at the exact reviewed commit first.
2. The canary checks an original, checksum- and certificate-verified APK. It enters and reads a random synthetic string on each phone, clears it, and closes both sessions. It checks the provider's effective capture settings, mandatory text-log redaction and completed-session evidence. A privacy check with missing evidence stops the run.
3. After sufficient free capacity, receiver readiness and both devices are confirmed, promote the same reviewed commit to the acceptance ref. The driver repeats the privacy test on the two actual execution sessions before publishing their attestation. The accounts are two private, explicitly enrolled test identities.
4. Authenticate the GitHub run, commit, public-key artifact, physical attestation and privacy receipt. The private receiver operator installs the waiting-state commitment before publishing the two role-bound encrypted email grants through the existing input branch. The runner then starts both app sign-ins. Authenticate the fresh two-screen artifact for this same run before enabling the sealed code pair.

Only the allowlisted metadata artifacts are retained. Input values stay in the private operator path and runner memory. The entire managed device session belongs to the chosen testing provider. The submitted Appium commands use supported text masking and the runner never requests screenshots, page source, traffic logs or screen recording.
