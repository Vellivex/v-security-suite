# Alpha09 invite-only tester guide

The patch updates the Messenger download button on the homepage and the Android setup guide in the deployed v44 `phone-shop.mjs` module. It retains the invitation instructions and recovery-history warning. The Alpha08 and Alpha09 download handlers stay in the existing module.

Two Android 15 emulators installed the signed Alpha09 APK and completed production email sign-in, recovery setup and mutual verification. Both received messages before restarting, retained their contact verification and earlier messages, received new messages from the peer after restarting, and signed out. The physical Pixel 7 result covers launch to the sign-in screen. Messaging between physical phones, background delivery, upgrades preserving an active session, GrapheneOS behavior and independent security review require separate evidence. [Paired emulator run](https://github.com/Vellivex/v-security-suite/actions/runs/45835870947/attempts/2)

## Apply to the matching website module

The website is assembled from multiple modules. From a private copy of the current serving module set, verify the source file, apply the patch and verify the result.

```shell
printf '%s  %s\n' 6c4ce0cd22dbbe83c54613cc0f736e9bd38089e219b1d8218a6228f2e8e0d1cb phone-shop.mjs | sha256sum -c -
git apply --check "$PATCH_PATH"
git apply "$PATCH_PATH"
printf '%s  %s\n' b8aa1d4940f229750aff3800178d7505f2dfb8e74a7c556f178643768258d946 phone-shop.mjs | sha256sum -c -
```

Set `PATCH_PATH` to the absolute path of `v44-invite-only-alpha09.patch`. If the source digest differs, compare the current deployment before applying the guide changes. Publish through the existing website deployment process, which preserves the other modules, bindings and runtime settings.

The candidate passed 562 repository host tests. The website wrapper served both complete signed APKs with the expected checksums and handled HEAD and byte-range requests. The offline comparison also covered the invite-only guide and homepage, 18 responses from existing routes, and the unavailable-download fallback.
