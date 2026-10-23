# V Security experimental suite

Open-source phone privacy tools, with an experimental small beta before a wider launch.

**Status: early evaluation software, not independently audited. Do not use sensitive data.**

| Tool | Build | What it does | Current limit |
| --- | --- | --- | --- |
| VGuard | Android 0.1.1 preview APK | Local VPN discards selected apps' packets | Live Android enforcement remains unverified; no always-on or lockdown |
| VVault | Browser 0.1.0 | Local passphrase-based message encryption using Web Crypto | No sender authentication, recovery or forward secrecy; independent crypto review outstanding |
| VRelay | Browser 0.1.0 | Validate envelope structure, copy/save/share ciphertext | No hosted relay, QR transport or delivery confirmation in this release |

`V Security` is a working umbrella brand. Custom domain and final brand are not yet registered by this project.

## Source and licence

Original code is GPL-3.0-or-later. See LICENSE and NOTICE. Android SDK/JDK tools are not bundled. Signing keys, operational data and customer records are excluded.

## Run the automated checks

Requirements: Node.js 22+, Python 3, JDK 17+ for VGuard's host tests.

```sh
node --test tests/*.test.mjs
bash apps/vguard/tests/adversarial/run-adversarial-tests.sh
python3 apps/vguard/validation/UI-Logic-Checks.py
```

VGuard's native build instructions are in `apps/vguard/README.md`. The original preview APK is available on the beta website alongside its matching source. Its earlier test report is in `releases/`.

The browser encryption core is `apps/vault/crypto.js`. The browser interfaces are rendered by `server/pages.js` and use `web/app.js`; VRelay deliberately never requests a passphrase.

## Build the website

The site runs as a self-contained Worker ESM. No application dependencies or third-party scripts are installed. A D1 binding named `DB` holds private feedback. `drizzle/` contains the schema migration.

```sh
bash scripts/build.sh
node scripts/validate-artifact.mjs
```

Build packaging expects the original `releases/VGuard-0.1.1-preview.apk`. To run host tests or inspect browser code, the APK is unnecessary. No private key is needed to inspect or test source; building a separately signed Android APK requires your own key.

The deployment identity lives in a checkout-local `.openai/hosting.json` and is excluded from the public source archive. To self-host, configure a Worker with its generated `dist/server/index.js`, D1 binding `DB`, and apply the migration. Future deployment tooling can replace the beta-specific packaging.

## Privacy and feedback

VVault/VRelay process message data in browser memory. Optional service-worker installation caches only public application assets, not message data. The feedback API is write-only for public visitors, validates input, binds SQL parameters and rate-limits by a daily hashed network identifier. Reports should contain no secrets or personal data. There is no user-account system, subscription billing, public report listing or guaranteed deletion schedule.

## Release gates

See `docs/ACCEPTANCE.md`, `docs/TEST-RESULTS.md` and SECURITY.md. Automated successes do not imply actual phone enforcement or an independent audit. No reproducible-build claim is made.
