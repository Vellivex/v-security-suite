# Launch-confidence review — 23 October 2026

Site 0.3.9; VVault/VRelay 0.2.5; V Cipher 0.1.5 research. VGuard APK 0.1.3-candidate is unchanged.

This is another internal review by the development process, not an independent audit. A public testing beta is available; a wider production launch remains blocked by the acceptance gates.

## Findings and fixes

| Area | Evidence before the fix | Result |
| --- | --- | --- |
| Browser text assistance | Four tool-page policy tests failed: sensitive fields lacked explicit assistance opt-outs / page translation opt-out. No actual message disclosure was demonstrated. | Sensitive text requests disabled spelling, correction, capitalisation, autocomplete, writing suggestions and translation. These are hints; keyboard/browser overrides and extensions remain outside the site's control. |
| V Cipher backup creation | Synchronous object-URL or download-click failure left the identity usable without the backup request succeeding. A lock inside that request could also be followed by a misleading success status. Two of three new regression cases failed. | Request the encrypted backup before activating the identity; recheck session after requesting it. Failure leaves no active new identity. A successful request still cannot prove that the user saved a file. |
| Website feedback availability | A never-completing fetch or JSON response left Send disabled indefinitely. Two new regression cases failed. | A 30-second whole-exchange deadline aborts the request, preserves the draft/reference and permits an idempotent retry. Late completion cannot clear a newer draft or unlock another pending submission. |

No new encryption, signature, origin, SQL or public-feedback-read bypass was reproduced in this pass. That does not establish their absence.

Browser-assistance rationale: [Chrome's spelling documentation](https://support.google.com/chrome/answer/12027911) distinguishes local/basic spelling from Enhanced spelling, which sends text to Google. [HTML's spelling specification](https://html.spec.whatwg.org/multipage/interaction.html#spelling-and-grammar-checking) defines the page hint and permits browser/user overrides. A page's network CSP is not a security boundary for the keyboard or browser itself.

## What still blocks a wider launch

- VGuard: actual Android enforcement and leak/lifecycle evidence. The current selected-app, drop-only VPN stops blocking when its service stops. Always-on and lockdown are not implemented. Enabling system lockdown by itself would change the selective-firewall behavior; a separate design and device validation are required.
- VVault/VRelay: physical Android/iPhone browser, offline, import/download/share, history restoration and cloud-keyboard behavior. Current DOM tests use mocks.
- V Cipher: physical two-phone cameras, interrupted frame transfer, backup save/restore and actual offline isolation. The protocol has no forward secrecy; replay records last one unlocked session.
- All apps: independent review and remediation/retest evidence. More internal tests do not meet this gate.
- Website/operations: feedback handling, hosting/account access and abuse/cost controls. The existing per-network quota does not establish distributed-abuse or DDoS resistance.

No attached Android device or emulator executable was available in this environment. No phone result, physical isolation result, fresh APK signature check or production load test is claimed.

Use `docs/ACCEPTANCE.md` and `docs/DEVICE-ACCEPTANCE.md` to record exact builds, devices, observed outcomes and evidence. A passing host check cannot replace a missing device result.

## Verification of this release

All 134 Node tests passed after the final app changes. The assembled Worker validator passed its route/header checks, embedded APK/download checksums, Cipher dependency routes and every offline manifest digest. `git diff --check` passed. The separate Python/Web Crypto interoperability check passed in the preceding sequential pass; the cryptographic protocol is unchanged here. VGuard source/APK are unchanged; its preceding host result remains 3,000,400 parser calls, 300 lifecycle cycles, 20,132 core assertions, 18 service scenarios / 2,192 assertions and 321 CSV cases.

Browser preview was attempted but unavailable: this Worker project has no dev script or static preview directory. No browser, camera or physical-device result is claimed for this pass. Native publication and GitHub CI results are tracked separately from these local checks.
