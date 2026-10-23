# V Cipher — recovered two-phone project, 0.1.1 research

This continues the original `private-line-prototype.zip` (11 October 2026), whose source is preserved as non-executable historical text in recovery/. The original had RSA-OAEP identity encryption, ECDSA signatures and password-encrypted backups, but no QR implementation. The continuation fixes backup binding, bounds parsing, adds a cryptographically required conversation-secret layer, numbered QR transfers and local camera scanning. It is not independently audited.

Routes: /apps/cipher (guide), /apps/cipher/vault (offline identity/reading/writing), /apps/cipher/relay (online encrypted/public transfer). All QR dependencies are vendored with licenses and SHA-256 provenance; there are no CDN calls.

Vault uses RSA-OAEP-3072/SHA256 to wrap a fresh AES256GCM key. ECDSA-P256/SHA256 signs the canonical VCMESSAGE2 envelope including sender, recipient and random message ID. AES-GCM AAD binds the outer header. An inner VVAULT1 message requires the independent conversation secret. No intermediate plaintext is shown on Relay. Password-encrypted VCVAULT2 backups authenticate the public card as AAD and check that the private keys match it using encryption/signature challenges.

Public PLCONTACT1 cards from the recovered design may be imported if they meet strict bounds/algorithms. Legacy PLMESSAGE1 and PLVAULT1 imports are intentionally not enabled; migration needs separate review. Existing VVault passphrase packages are a different workflow and are not V Cipher transfers.

QR uses VCQR1, a whole-transfer SHA256 checksum, explicit count/index and 360-character base64 chunks; up to 96 frames / 24 KiB. Only public cards and encrypted VCMESSAGE2 bundles are accepted. Frame checksums detect mixing/corruption, not sender authenticity. The recipient Vault verifies the signature. Messages are limited to 2,048 UTF8 bytes. Frame collection expires after five minutes; ordinary session lock clears sooner.

Replay detection is in-memory for one unlocked session, capped at 1,024 successful opens, and resets on lock/reload. It is not durable replay prevention. No key ratchet, forward secrecy, delivery backend or automatic messenger exists. Identity fingerprints must be compared through a trusted separate channel. Browser keys and passphrases may remain in OS/browser memory; clearing DOM/references cannot guarantee secure erasure.

Install offline files before disabling all networks and reloading. Vault operations require the browser reporting offline, a controlling installed worker and explicit isolation confirmation. These are usability gates, not proof of physical air-gapping. A compromised origin/device can defeat browser security. Do not use sensitive data.

Camera scanning is local, throttled and bounded to 960px frames; permission is requested only after clicking Start. Tracks are stopped on lock/hide/exit, including late permission results. Paste-frame fallback supports testing without a camera. Real two-phone/camera compatibility remains unverified.

Run `node --test tests/cipher.test.mjs tests/cipher-ui.test.mjs tests/server.test.mjs`. Tests include actual QR encoder pixels decoded by the independently implemented bundled decoder, identity/backup/tamper/secret/replay tests and simulated lifecycle races. These are not actual Android/iPhone tests.
