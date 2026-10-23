# Vellivex experimental suite

Open-source phone privacy tools, with an experimental small beta before a wider launch.

**Status: early evaluation software, not independently audited. Do not use sensitive data.**

| Tool | Build | What it does | Current limit |
| --- | --- | --- | --- |
| VGuard | Android 0.1.3 candidate APK | Local VPN discards selected apps' packets | Live Android enforcement remains unverified; no always-on or lockdown |
| VVault | Browser 0.2.6 | Local passphrase-based message encryption using Web Crypto | No sender authentication, recovery or forward secrecy; independent crypto review outstanding |
| V Cipher | Browser 0.1.6 research | Offline identity, signed double-layer messages and numbered QR transfer | Two-phone camera/OS validation and independent review outstanding |
| VRelay | Browser 0.2.6 | Validate envelope structure, copy/save/share ciphertext | No hosted relay, QR transport or delivery confirmation in this release |

Vellivex is the main brand, with `vellivex.com` selected by the owner. VGuard, VVault, VRelay and V Cipher retain their product names. The website is live at https://www.vellivex.com. Domain and HTTPS status are tracked separately from app security evidence.

## Source and licence

Original code is GPL-3.0-or-later. See LICENSE and NOTICE. Android SDK/JDK tools are not bundled. Signing keys, operational data and customer records are excluded.

## Run the automated checks

Requirements: Node.js 24+, Python 3, JDK 17+ for VGuard's host tests.

```sh
node --test tests/*.test.mjs
bash apps/vguard/tests/adversarial/run-adversarial-tests.sh
python3 apps/vguard/validation/UI-Logic-Checks.py
```

VGuard's native build instructions are in `apps/vguard/README.md`. The rebuilt candidate APK is available on the beta website alongside its matching source. Its earlier test report is in `releases/`.

The browser encryption core is `apps/vault/crypto.js`. The browser interfaces are rendered by `server/pages.js` and use `web/app.js`; VRelay deliberately never requests a passphrase.

## Build the website

The site runs as a self-contained Worker ESM. No application dependencies or third-party scripts are installed. A D1 binding named `DB` holds private feedback. A secret runtime `FEEDBACK_RATE_SECRET` (at least 32 random characters) is required; never put it in source. `drizzle/` contains the schema migration.

```sh
bash scripts/build.sh
node scripts/validate-artifact.mjs
```

Build packaging expects the original `releases/VGuard-0.1.3-candidate.apk`. To run host tests or inspect browser code, the APK is unnecessary. No private key is needed to inspect or test source; building a separately signed Android APK requires your own key.

The deployment identity lives in a checkout-local `.openai/hosting.json` and is excluded from the public source archive. To self-host, configure a Worker with its generated `dist/server/index.js`, D1 binding `DB`, and apply the migration. Future deployment tooling can replace the beta-specific packaging.

## Privacy and feedback

VVault/VRelay process message data in browser memory. Optional service-worker installation caches only public application assets, not message data. The feedback API is write-only for public visitors, validates input, binds SQL parameters and rate-limits by a daily HMAC-based network pseudonym using a secret runtime key. Reports should contain no secrets or personal data. There is no user-account system, subscription billing, public report listing or guaranteed deletion schedule.

## Release gates

See `docs/ACCEPTANCE.md`, `docs/TEST-RESULTS.md` and SECURITY.md. Automated successes do not imply actual phone enforcement or an independent audit. No reproducible-build claim is made.

## Security hardening 0.2.3 / VGuard 0.1.3

See `docs/ADVERSARIAL-REVIEW-2026-10-23.md`. The native candidate was rebuilt and signature-verified with the existing update identity; device runtime remains unverified. Browser sessions now clear on hide/exit/history restoration and idle expiry. Pending operations cannot repopulate a cleared/edited session. Crypto pages block app-initiated network connections; installed offline assets use release hashes and no network fallback. Signing files, native build output, feedback and runtime secrets are excluded from public source bundles.

## Recovered two-phone QR project

V Cipher resumes the recovered Private Line prototype. Open `/apps/cipher` for its guide, `/apps/cipher/vault` for the offline role and `/apps/cipher/relay` for ciphertext/public-card transport. See `apps/cipher/README.md` and `docs/CIPHER-CONTINUATION-2026-10-23.md`. It is separate from the ordinary VVault/VRelay passphrase tools.

## Reviewed source packaging and native release checks

`source-archives.py` packages the exact paths in `scripts/source-manifest.json`. New source files need explicit manifest review; links, private/runtime file types and missing/unlisted paths stop the build. Keep signing/runtime data outside source directories. This policy prevents accidental inclusion; a reviewed text file can still contain sensitive content and must be inspected before adding it.

`python3 scripts/verify-vguard-release.py` verifies native source fingerprints and policy. Use `--require-apk` when validating a release checkout; SDK-backed signature checks remain a separate, explicit result. Matching source hashes are not a reproducible-build proof.
