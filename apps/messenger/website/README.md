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

## Vellivex contact invitations

Apply `v46-first-party-invites.patch` to the v46 website module with SHA-256 `f49ef3acf80a996d08f36db91ee819f8c3f439e2e7fabc875f7502d9a4203ec4`. The resulting module SHA-256 is `eff9e0c3844ca5672f4657bcf9ef59c0caf567ce8d86d1da3195fd7ab9ff70a7`. Reverse the same patch to recover the original bytes.

On `www.vellivex.com`, the website serves Android's app association at `/.well-known/assetlinks.json`. The fingerprint is the SHA-256 of the retained alpha signing certificate verified on the signed universal Alpha09 APK. New clients claim the exact `/invite` path. The browser fallback reads the public contact ID from the URL fragment and lets the recipient copy it into Vellivex. The setup guide also covers existing Alpha09 QR codes and shared links.

## Android browser invitation fallback

| Starting module | Patch | Resulting SHA-256 |
| --- | --- | --- |
| v47 invitation page, SHA-256 `eff9e0c3844ca5672f4657bcf9ef59c0caf567ce8d86d1da3195fd7ab9ff70a7` | `v47-pinned-alpha10-download.patch` | `a6eaf8bffd6a03cdf9fe322246b7369b7794c2d04516750e17bdaef30733cf57` |
| v48 pinned Alpha10 download, SHA-256 `a6eaf8bffd6a03cdf9fe322246b7369b7794c2d04516750e17bdaef30733cf57` | `v48-open-in-vellivex.patch` | `f32d4242afb97710d99d99f5c7d99e682be7e44c5d805d0f879c984eca829484` |

The download patch adds the signed Alpha10 object at `/downloads/Vellivex-Messenger-0.1.0-alpha10-universal.apk`. Its full-file SHA-256 is `c994d9243e2c9b9e4ffaade600096682991e16ce27f9e9648e5181f96ad52c65` and its size is 111,798,288 bytes.

On Android, the invitation page offers **Open in Vellivex** for a valid contact. Its intent names the alpha app package and the canonical Vellivex HTTPS invitation. When Chrome falls back to the browser, `/invite/manual` lets the recipient copy the contact ID or open the Vellivex setup guide. Both pages keep the contact in the URL fragment. The manual page contains no further app-launch action. [Android intents in Chrome](https://developer.chrome.com/docs/android/intents)

To roll back, run `git apply --reverse --check` and `git apply --reverse` with the same patch path, then check the resulting module against its starting digest in the table.

## Alpha10 tester guide

`v50-alpha10-guide.patch` switches the homepage and setup guide from Alpha09 to Alpha10. Applying it to the v50 module above produces SHA-256 `74c0ff6b43bf665ed10adeb8754913699901fdfdc0618e0e91fecd67e0f308dd`. Applying it in reverse restores the v50 module.

On Android 15, a touchscreen tap on **Open in Vellivex** in Chrome launched the original-signed Alpha10 app at sign-in both after a fresh install and after updating from Alpha09. The browser page showed the contact ID and Vellivex setup link with the app absent. The guide explains how to use the browser fallback and how to handle older QR codes. Earlier Alpha09 two-emulator messaging results are identified separately. [Android acceptance](https://github.com/Vellivex/v-security-suite/actions/runs/45876515251/job/140104846704)

The offline check below requires both website modules, the directory of production modules containing `app-access-entry.mjs`, and the signed Alpha10 APK. It verifies the complete signed bytes and a byte range against both website wrappers, checks 24 other responses, and checks the new download and release instructions.

```shell
node apps/messenger/website/verify-alpha10-release.mjs "$V50_MODULE" "$V51_MODULE" "$MODULES_DIR" "$SIGNED_ALPHA10_APK"
```
