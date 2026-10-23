# VGuard release verification — 23 October 2026

The unchanged VGuard 0.1.3 candidate was freshly checked using the installed official Android SDK build-tools 36.0.0. No native application source, APK, signing material or build report was changed.

## Fresh evidence

- `apksigner verify --verbose --print-certs`: **Verifies**, APK Signature Scheme v3, one RSA 3072-bit signer. Certificate SHA-256: `7bdb5a95a45f735a175580a937eb5c7ec55a2c886ce038ed106c1dfa1f3ff049`.
- `zipalign -c -v 4`: **Verification successful**.
- `aapt2 dump badging`, `permissions` and `xmltree`: package `app.vguard.firewall`, version code 4, version `0.1.3-candidate`, minimum SDK 29, target SDK 35, compile SDK 36. The four expected permissions are QUERY_ALL_PACKAGES, FOREGROUND_SERVICE, FOREGROUND_SERVICE_SPECIAL_USE and POST_NOTIFICATIONS. There is no INTERNET permission. The compiled manifest retains disabled backup/cleartext, the extraction-rule reference and permission-protected VPN service.
- APK: **90,718 bytes**, SHA-256 `6977d17d356f76a181a4979bf4fefa4f486167b90e2df612e5c93aed4977df58`.
- All **14 native application inputs** exactly match the committed fingerprint map. Combined fingerprint: `9108459581d9a5fefe88ee3b151dece9dcd61374cd6eeb79d225295a0ec8e1e3`.

## Added release guard

`scripts/verify-vguard-release.py` is read-only. It rejects changed, missing, additional or symbolic native application inputs; inconsistent or duplicate JSON metadata; unexpected permissions/components; lost VPN-service protection; changed official signing identity; unsafe application flags; and mismatched APK bytes. When an SDK is explicitly supplied, it freshly verifies the signature, signing identity, alignment and compiled manifest with official tools.

```sh
# Public-source CI: verifies inputs/policy, clearly reports absent binary if absent.
python3 scripts/verify-vguard-release.py

# Local release packaging: refuse an absent candidate binary.
python3 scripts/verify-vguard-release.py --require-apk

# Fresh official SDK verification; no signing credentials are needed.
python3 scripts/verify-vguard-release.py --require-apk --sdk /absolute/path/to/android-sdk
```

Twelve automated regression tests cover normal source-only verification, changed/additional/missing/symbolic inputs, inconsistent metadata, signing-identity changes, duplicate metadata fields, coherently repinned unsafe manifests, altered APK bytes and refusal to downgrade a required binary check to a source-only pass. CI runs these through the ordinary Node suite and explicitly runs the source verifier. A source-only or hash-only receipt does not claim a fresh APK signature check.

A separate local negative check flipped a byte in a temporary APK copy and coherently updated its temporary hash metadata. Fresh SDK verification still rejected it at `apksigner`. The original signed APK then passed fresh verification again. The temporary files were deleted.

These checks detect release inconsistency; they do not prove that the source produced the signed APK. Reproducible-build provenance, actual Android networking/lifecycle enforcement and independent expert review remain open release gates.
