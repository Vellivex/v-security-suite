# Matrix SDK extension for Vellivex Messenger

The alpha uses Matrix Rust SDK 0.19.1, from the source behind Android package
26.11.05, with two additional FFI entry points. `requestPeerDeviceVerification`
starts the upstream SAS verification flow over to-device events. This permits
contact verification before the app shares an encrypted room key. Encryption,
SAS comparison, cross-signing and message delivery remain upstream SDK operations.
`activeRequestIsCancelled` lets the app ignore cancellation callbacks from an
earlier attempt.

`peer-device-verification.patch` rejects self-verification, incomplete local
cross-signing, already verified peers and peers without exactly one eligible
cross-signed device. The app must still compare SAS values and require the SDK's
verified identity result before sending messages. This alpha intentionally does
not select silently among multiple peer devices.

## Pinned inputs

`sources.json` pins both upstream commits and source archive SHA256 hashes,
Rust 1.96.0, cargo-ndk 4.1.2, Android NDK 29.0.14206865 and protoc 29.3. The
builder regenerates all Kotlin bindings from the newly compiled native library.
Do not combine its native libraries with the Maven release's generated bindings.

The upstream Cargo.lock is retained. Both the host xtask build and the delegated
cargo-ndk build run with `--locked`. The builder only changes xtask's command to
add that flag. Per-target provenance records source pins, the FFI patch hash,
Cargo.lock, binding hashes and native library hashes. The assembly step requires
identical generated Kotlin across both targets and validates the artifact hashes.
These are pinned build inputs; bit-for-bit reproducibility has not been established.

Upstream is Apache-2.0. Its license is retained inside the generated AAR. The
extension and builder are part of the GPL-3.0 Vellivex repository. No Maven
publication, remote release, credentials or paid service is required to build.

## Build

Use a Linux x86_64 host with Python 3.12+, curl, Git, a full JDK 21, Android SDK
platform 34 and NDK 29.0.14206865. Set `JAVA_HOME`, `ANDROID_HOME` and
`ANDROID_NDK_HOME`. Native builds need Rust and cargo-ndk installed:

```sh
rustup toolchain install 1.96.0 --profile minimal
rustup target add --toolchain 1.96.0 aarch64-linux-android x86_64-linux-android
cargo +1.96.0 install cargo-ndk --version 4.1.2 --locked
bash apps/messenger/sdk/build.sh
```

The script downloads and checksum-verifies the two upstream archives and protoc.
All generated files stay under `apps/messenger/sdk/build/` by default. This
includes native build trees, generated bindings and the final file
`vellivex-matrix-sdk-26.11.05-vellivex.1.aar`. Do not commit that directory.
`VELLIVEX_SDK_BUILD_DIR` changes the intermediate build location. A completed
native output directory must be empty before rebuilding, preventing accidental
mixing of artifacts from different patches.

Build the app with the generated default AAR, or select a complete AAR explicitly:

```sh
cd apps/messenger/android
./gradlew -PmatrixSdkAar=/absolute/path/vellivex-matrix-sdk.aar assembleDebug
```

The app declares JNA and the other required runtime dependencies explicitly,
because a local AAR does not resolve a Maven POM's transitive dependencies.
It fails configuration if the custom AAR is absent instead of using an SDK that
lacks the required verification operation.

## Android HTTPS support

The native SDK uses `rustls-platform-verifier` 0.7.1 on Android. Its pinned
Cargo.lock requires the matching JVM component 0.2.0. `android-platform.json`
records the source commit, immutable Maven archive commit and SHA256 of that
official release AAR. The app resolves only this component from that repository
and checks the AAR before building. The component is the upstream production
build, with its test-only trust roots removed; its MIT licence is included in
the app. These Java and resource inputs are separate from the unchanged native
source pins and native-library provenance.

Before creating a repository or SDK client, `MessengerApplication.onCreate`
loads the existing native library, calls its documented JNI entry point
`org.matrix.rustsdk.Android.init(applicationContext)`, then calls `initPlatform`.
This supplies the Java VM and application class loader needed for Android's
certificate verifier. SDK file, system and remote tracing outputs are disabled.
No certificate check or hostname check is bypassed.

The official support AAR supplies a strict-default Android network policy with
an enumerated list of certificate-authority HTTP revocation endpoints. Release
uses that policy unchanged. Debug builds generate the same policy plus only
the existing three local test hosts. The app still rejects HTTP messaging
origins in release. The native HTTPS regression must pass against the production
service without signing in; passing loopback HTTP tests alone does not exercise
the Android TLS integration.

Upstream integration contracts:

- https://github.com/matrix-org/matrix-rust-sdk/blob/3ff03638028fd9abf58203153722b94b4293a87a/bindings/matrix-sdk-ffi/src/platform/android_platform.rs
- https://github.com/rustls/rustls-platform-verifier/tree/252e25161a91af476cbea620e29d277592d27ec7

## Parallel CI build

Run these in separate standard Linux jobs. Each job needs only its own Rust target:

```sh
bash apps/messenger/sdk/build.sh --native-only \
  --target aarch64-linux-android --output-dir /tmp/native
bash apps/messenger/sdk/build.sh --native-only \
  --target x86_64-linux-android --output-dir /tmp/native
```

Upload each `/tmp/native/` directory as its own artifact. Download them into
`/tmp/sdk-inputs/aarch64-linux-android/` and
`/tmp/sdk-inputs/x86_64-linux-android/`. Each contains `jniLibs/`, `kotlin/`,
`LICENSE` and `provenance.json`. Then assemble in a JDK/Android SDK job:

```sh
bash apps/messenger/sdk/build.sh --assemble-from /tmp/sdk-inputs \
  --output /tmp/vellivex-matrix-sdk.aar
```

Assembly also writes `.sha256` and `.provenance.json` beside the AAR. Retain only
needed outputs for a bounded period. Standard public-repository Actions compute
is free, while artifact storage still has account allowances.

`--prepare-only` verifies inputs and applies the patch without compiling. It
cannot establish native build or messaging correctness. The Android integration
test must independently exercise verification on two accounts, trusted encrypted
message exchange, offline delivery and retry behaviour.

Upstream build instructions:
https://github.com/matrix-org/matrix-rust-components-kotlin/tree/c1664f712bed33488b10f33232fb424faf257d49
