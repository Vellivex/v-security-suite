# VGuard verification boundaries

The installer URL requires normal email sign-in. Anonymous automation must
receive the private, uncached HTML sign-in gate; it must not receive APK bytes.
Earlier APK checks downloaded that HTML and failed the pinned APK checksum.
That failure did not show a corrupt APK.

The ordinary `vguard-apk-smoke.yml` workflow now reports two separate results:

1. `vguard-download-access.mjs` checks the exact installer URL, required access
   marker, status, HTML type, no-store and no-referrer policy. Unexpected public
   APK bytes, redirects, server errors and missing gate headers fail the check.
2. `vguard-source-regressions.sh` independently downloads the public GPL source
   archive, checks its existing pinned hash, and runs the production-source
   parser, rule-store, engine, lifecycle and UI checks using host test tools.

Neither result proves the APK checksum, Android signature, installation or
device/network behavior. Those results are explicitly **NOT RUN**. No recurring
schedule, auth secret, session bypass or alternative public APK URL is added.

## Verify actual APK bytes

Obtain the APK through the normal website email-verification flow. Then run the
existing binary verifier on that local file in an appropriate isolated SDK
environment:

```sh
bash scripts/vguard-apk-install-smoke.sh /absolute/path/VGuard-0.1.4-candidate.apk
```

It retains the fixed published candidate SHA-256, archive, Android signature,
package and permission checks. It copies the input into a unique temporary
directory and removes only that temporary copy; the supplied download is never
deleted or modified. A wrong file, saved HTML gate or changed APK fails before
Android tools run. No online authentication occurs in this mode.

Optional isolated emulator and network-probe commands remain available:

```sh
VGUARD_RUN_EMULATOR=true bash scripts/vguard-apk-install-smoke.sh /absolute/path/candidate.apk
VGUARD_RUN_EMULATOR=true VGUARD_PROBE_BASELINES=true bash scripts/vguard-apk-install-smoke.sh /absolute/path/candidate.apk
```

Missing SDK/emulator prerequisites remain explicitly untested as reported by
the existing verifier. Requesting emulator/network checks without supplying an
APK is **BLOCKED** and returns a nonzero exit; it cannot become a successful
network test. The separate network-baseline workflow currently has no
authenticated artifact source and therefore remains blocked at this boundary.
Do not weaken access controls or add an unreviewed credential to unblock it.

The ordinary public workflow no longer offers an emulator input that its
unauthenticated runner cannot fulfill. Device testing uses the supplied-file
commands above until an approved authenticated artifact pipeline is available.
