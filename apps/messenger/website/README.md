# Alpha09 guide for invited testers

The v44 patch updates the Messenger download button on the homepage and the Android setup guide in the deployed v44 `phone-shop.mjs` module. It explains how to request a test invitation and retains the recovery-history warning. The Alpha08 and Alpha09 download handlers stay in the existing module.

Two test accounts used the signed Alpha09 APK on two Android 15 emulators. Both completed production email sign-in, recovery setup and mutual verification. Both received messages before restarting, retained their contact verification and earlier messages, received new messages from the peer after restarting, and signed out. The physical Pixel 7 result covers launch to the sign-in screen. Messaging between physical phones, background delivery, upgrades preserving an active session, GrapheneOS behavior and independent security review require separate evidence. [Paired emulator run](https://github.com/Vellivex/v-security-suite/actions/runs/45835870947/attempts/2)

## Apply to the matching website module

The website is assembled from multiple modules. Select the patch for the exact serving copy of `phone-shop.mjs`.

| Starting module | SHA-256 | Patch |
| --- | --- | --- |
| Website v44, before linking Alpha09 | `6c4ce0cd22dbbe83c54613cc0f736e9bd38089e219b1d8218a6228f2e8e0d1cb` | `v44-invite-only-alpha09.patch` |
| Website v45, after linking Alpha09 | `b8aa1d4940f229750aff3800178d7505f2dfb8e74a7c556f178643768258d946` | `v45-alpha09-tester-wording.patch` |

Use one patch. From a private copy of the serving module set, set `SOURCE_SHA256` to the matching digest and `PATCH_PATH` to the absolute path of that patch.

```shell
printf '%s  %s\n' "$SOURCE_SHA256" phone-shop.mjs | sha256sum -c -
git apply --check "$PATCH_PATH"
git apply "$PATCH_PATH"
printf '%s  %s\n' f49ef3acf80a996d08f36db91ee819f8c3f439e2e7fabc875f7502d9a4203ec4 phone-shop.mjs | sha256sum -c -
```

If the source digest differs, compare the current deployment before applying the guide changes. Publish through the existing website deployment process, which preserves the other modules, bindings and runtime settings.

The candidate passed 562 repository host tests. The website wrapper served both complete signed APKs with the expected checksums and handled HEAD and byte-range requests. The offline comparison also covered the guide and homepage for invited testers, 18 responses from existing routes, and the unavailable-download fallback.
