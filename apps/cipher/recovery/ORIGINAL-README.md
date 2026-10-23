# Private Line — two-phone proof of concept (NOT production-secure)

## What works
- An offline-first browser Vault with local identity generation.
- RSA-OAEP-3072 encrypted message-key transport, AES-256-GCM message encryption, ECDSA P-256 signatures.
- Password-protected vault export and import (PBKDF2-SHA256, 600,000 iterations, AES-256-GCM).
- Exchange of public contact cards and fingerprints, signed message envelopes, sender authentication on decrypt.
- A separate online Courier page that handles only opaque ciphertext and has no secret keys.

## How to try it
1. Extract the ZIP. Open `vault.html` on a modern browser on each of TWO devices (for an actual offline trial, disconnected devices). Some embedded Android file viewers block WebCrypto; use a supported modern browser running from a secure local origin, or package as a native app later.
2. Generate an identity on each offline device, supply a long passphrase, and DOWNLOAD the encrypted key backup.
3. Transfer **public** contact cards only and verify their fingerprints through a trusted independent channel.
4. On the sender's Vault paste recipient card, type, click Encrypt and sign.
5. Transfer the encrypted message envelope to the sender's online phone, open `courier.html` and send the ciphertext through a separate channel. The Courier is NOT a delivery backend.
6. On the recipient's Vault, paste the sender's public card and received ciphertext, then Verify and decrypt.

## Not yet implemented
Camera QR encode/decode, message chunking, server delivery, native Android app, robust contact management, replay protection, forward secrecy, key ratchet, audited secure storage, rooted-device detection, installation verification, accessibility hardening, device compromise protection, formal security review. Do not trust with sensitive information.

## Important security caveats
- Airplane mode alone is not a sufficient isolation boundary; Wi-Fi/Bluetooth may be independently enabled. A phone remains a large software/hardware attack surface.
- Browser-based keys exist in browser memory when unlocked; the page is a demonstrator not a hardened trusted execution environment.
- Exported private keys are password-encrypted but weak passphrases are susceptible to offline cracking.
- RSA ciphertext and static keys do not provide forward secrecy; if an offline device's private key is compromised, recorded ciphertext may be decryptable.
- Physical access, malicious software installed before isolation, malicious QR/message parsing, side channels and device exploits all remain risks.
- The signer's fingerprint only authenticates a key; verify that key really belongs to your correspondent.

## Automated developer checks
Run `node test-crypto.cjs`. Confirmed passing in the build environment: encrypt/sign/decrypt roundtrip and rejection of tampered ciphertext. Full browser and Android testing still required; browser automation was blocked by the test environment's administrator policy.
