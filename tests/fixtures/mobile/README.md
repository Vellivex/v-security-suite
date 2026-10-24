# Public fictional mobile fixtures

Every value in this folder is deliberately public, including the test passphrase. These are reproducible test samples, not private messages, passwords or backups. Never use their passphrase, salt, IV or ciphertext as a template for protecting real information. Production encryption must generate fresh random values normally.

The valid fixture was generated once on 24 October 2026 with Python `cryptography` AES-GCM and PBKDF2, independently of the VVault implementation, then frozen. The tampered fixture differs by one ciphertext bit. No production route, prefill parameter or testing hook is introduced by these files.

## Fixture values

- Correct test passphrase: `synthetic orchard river 42`
- Incorrect test passphrase: `incorrect synthetic phrase 42`
- Exact plaintext: two lines, with no leading/trailing space or final newline:

```text
Café 🔐
<b>plain text</b>
```

The second line must appear literally, including angle brackets; it is not HTML markup. `expected.json` contains the exact string and its UTF-8 bytes in base64 for machine comparison. JSON fixture files end in a newline outside their JSON value; this is valid whitespace, not message content.

| File | VRelay format check | VVault unlock |
| --- | --- | --- |
| `valid.vvault.json` | Accept structure only | Correct passphrase recovers exact text; incorrect passphrase fails without plaintext |
| `tampered-ciphertext.vvault.json` | Accept structure only | Correct passphrase fails authentication without plaintext |
| `malformed.json` | Reject; no transfer output | Reject; no plaintext |

VRelay accepting the tampered fixture is expected: it does not authenticate ciphertext, decrypt it or establish sender identity.

## Verify locally

From the repository root, with the Node environment used by the project:

```sh
node tests/fixtures/mobile/verify.mjs
```

This verifies the seven reviewed file hashes against `SHA256SUMS.txt`, checks the exact UTF-8 representation and uses the actual VVault implementation to assert the table above. A standalone file-integrity check is also available:

```sh
cd tests/fixtures/mobile
sha256sum -c SHA256SUMS.txt
```

The manifest has no external trust signature. Comparing it with a separately obtained trusted source revision is necessary to detect coordinated changes to both files and manifest.

For an independent AES-GCM/PBKDF2 cross-check, if Python `cryptography` is already available:

```sh
python3 tests/fixtures/mobile/verify-independent.py
```

The Python check verifies the exact decrypted bytes and requires `InvalidTag` for wrong-passphrase and tampered ciphertext cases. It is not an independent audit of the whole product. It does not test the production JSON parser or device behaviour. Do not install dependencies merely to run an unapproved or paid service.

## Use on devices

Follow `docs/MOBILE-SESSION-PLAN.md`. Keep these fixtures on the operator's machine before starting the streaming timer. Pasting one compact encrypted JSON value is sufficient; there is no need to create new sample ciphertext during every negative test. Use file import only where the actual device/browser supports it, and record unavailable file handling as BLOCKED.

Keep actual test versions and observations separate from these expected results. This pack supplies no Android, iPhone, camera, physical isolation or firewall enforcement evidence. The physical-device checklist remains NOT RUN until its checks are actually conducted.
