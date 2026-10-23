# VGuard public-source payload rebuild — 23 October 2026

**Result: all eight uncompressed APK payload entries reproduced exactly.**

A clean unsigned compilation of the reviewed public native source produced the same compiled manifest, Android bytecode, resources and resource table as the official VGuard 0.1.3 candidate. The official APK's signature, pinned signing identity, alignment and compiled manifest also passed fresh SDK verification before comparison. No signing material was accessed, no signing was performed, and neither the official APK nor native application source was changed.

## Reproduce

Use the full public suite checkout. Download the published candidate APK from https://www.vellivex.com/apps/guard into `releases/`, or pass its location with `--apk`. Install the documented official Android SDK platform 36/build-tools 36.0.0 and JDK 17, then run:

```sh
python3 scripts/verify-vguard-payload.py --sdk /absolute/path/to/android-sdk
```

The script copies only the reviewed `apps/vguard/app/` files into a clean temporary directory and checks their fingerprint after copying. It independently runs `aapt2`, `javac` and `d8`, then compares every uncompressed archive entry with the signature-verified release. It never invokes the signing-capable `build.py`. Temporary compilation files are deleted on completion. Nothing is downloaded.

The comparator rejects changed, missing, additional, duplicate, noncanonical, encrypted, symbolic and excessively large entries. Arbitrary `META-INF` additions are rejected. No payload entries are ignored; this candidate's APK v3 signing block sits outside its ZIP entries. Twelve fixture regression tests exercise successful reordered comparison and changed, missing, injected, duplicate, traversal, empty, oversized and directory-entry archives without requiring an SDK in CI.

## Verification receipt

- Official APK SHA-256: `6977d17d356f76a181a4979bf4fefa4f486167b90e2df612e5c93aed4977df58`.
- Native source fingerprint: `9108459581d9a5fefe88ee3b151dece9dcd61374cd6eeb79d225295a0ec8e1e3` (14 inputs).
- Fresh signature verification: passed; pinned certificate SHA-256 `7bdb5a95a45f735a175580a937eb5c7ec55a2c886ce038ed106c1dfa1f3ff049`.
- Compile SDK: 36; build-tools: 36.0.0.
- JDK: OpenJDK 17.0.20, build `17.0.20+8-1-24.04-Ubuntu`.
- AAPT2: `2.20-13193326`.
- D8: `8.10.9-dev`, build `a7ad18a70460b799d0482e497c109a75bf7f91de`.

Each SHA-256 below is identical in the clean unsigned compilation and official signed APK.

| Entry | Uncompressed bytes | SHA-256 |
| --- | ---: | --- |
| `AndroidManifest.xml` | 4,332 | `8f4c848fa0a7e157dbd11c7ee77390a66b55e0aa6ca655cd9d05c62ec41bc25e` |
| `classes.dex` | 78,692 | `70393467b03140347a21d3ae13713ce205e8ed7fa1cdb0f0a156e7cf8d70250f` |
| `res/drawable/ic_launcher_foreground.xml` | 896 | `c620695246ac4d7afcade2f3daacb3617f28c318f8f4e5f393dea9074a17a4f5` |
| `res/drawable/ic_shield.xml` | 888 | `6cdc48343b5d65172008b7eadab6a67f1a273ed0e7cd3bb2db47018c7cb2097a` |
| `res/mipmap-anydpi-v26/ic_launcher.xml` | 448 | `54856b6237e50ef1e74df7736658f86a6f1f56fbb5a5ccd0977b7775b10ae1a4` |
| `res/mipmap-anydpi-v33/ic_launcher.xml` | 548 | `7349a5e0d61eac723b566e2d46d62ac49a05f645236520dc91848502eed29322` |
| `res/xml/data_extraction_rules.xml` | 2,292 | `757f2049fb0d70af338a3e505fca6fa81f3f5bf62bf313ca34d75a64b7a3cd1e` |
| `resources.arsc` | 2,104 | `254c9d4ae95fea9a37507ef3d4c76b91b3cd33a64372dccf8d753d038606a76b` |

## Scope

This is concrete source-to-APK **payload reproduction** evidence for the listed toolchain and candidate. It does not establish byte-identical signed APK containers, reproducibility across arbitrary toolchains, an independent audit, or actual Android network/lifecycle enforcement. ZIP metadata and the signing block are outside the payload comparison; the complete official APK is separately pinned by hash and freshly signature-verified. Real-device testing remains required.
