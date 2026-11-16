#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail
VX_SDK_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec python3 - "$VX_SDK_DIR" "$@" <<'PY'
"""Build a complete, matching Matrix JNI/Kotlin AAR from pinned upstream inputs."""
import argparse, hashlib, json, os, pathlib, platform, shutil, subprocess, sys, tarfile, zipfile

HERE = pathlib.Path(sys.argv.pop(1))
PINS = json.loads((HERE / 'sources.json').read_text())
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--native-only', action='store_true')
p.add_argument('--target', choices=list(PINS['targets']))
p.add_argument('--output-dir', type=pathlib.Path)
p.add_argument('--assemble-from', type=pathlib.Path)
p.add_argument('--output', type=pathlib.Path)
p.add_argument('--prepare-only', action='store_true', help='Verify/download inputs and patch; do not compile')
a = p.parse_args()
BUILD = pathlib.Path(os.environ.get('VELLIVEX_SDK_BUILD_DIR', str(HERE / 'build'))).resolve()
BUILD.mkdir(parents=True, exist_ok=True)
PATCH = HERE / 'peer-device-verification.patch'

def digest(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()

def run(args, cwd=None, env=None):
    print('+', ' '.join(map(str, args)), flush=True)
    subprocess.run(list(map(str, args)), cwd=cwd, env=env, check=True)

def download(key):
    pin = PINS[key]
    dest = BUILD / 'downloads' / (key + ('.zip' if key == 'protoc' else '.tar.gz'))
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not dest.is_file() or digest(dest) != pin['sha256']:
        temporary = dest.with_suffix(dest.suffix + '.partial')
        run(['curl', '--fail', '--location', '--retry', '3', '--max-time', '180', pin['url'], '--output', temporary])
        if digest(temporary) != pin['sha256']:
            raise SystemExit(f'{key}: downloaded SHA256 differs from sources.json')
        temporary.replace(dest)
    return dest

def extract(key, work):
    archive = download(key)
    dest = work / key
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    with tarfile.open(archive) as t:
        members = t.getmembers()
        top = pathlib.PurePosixPath(members[0].name).parts[0]
        if any(pathlib.PurePosixPath(m.name).parts[0] != top for m in members):
            raise SystemExit('Unexpected archive layout')
        t.extractall(dest, filter='data')
    return dest / top

def prepare_rust(target):
    work = BUILD / 'work' / target
    source = extract('rust_sdk', work)
    run(['git', 'apply', '--check', PATCH], cwd=source)
    run(['git', 'apply', PATCH], cwd=source)
    # Upstream xtask builds cargo-ndk without --locked. Require its unchanged
    # Cargo.lock for the delegated compilation too; no dependency is upgraded.
    xtask = source / 'xtask/src/kotlin.rs'
    content = xtask.read_text()
    before = 'rustc --lib --profile {profile}'
    if content.count(before) != 1:
        raise SystemExit('Pinned upstream xtask layout changed')
    xtask.write_text(content.replace(before, 'rustc --locked --lib --profile {profile}'))
    return source

def tree_hashes(root):
    return {str(f.relative_to(root)): digest(f) for f in sorted(root.rglob('*')) if f.is_file()}

def build_native(target, output):
    source = prepare_rust(target)
    if a.prepare_only:
        print(f'Prepared pinned source and patch for {target}: {source}')
        return
    if platform.system() != 'Linux' or platform.machine() not in ('x86_64', 'AMD64'):
        raise SystemExit('This pinned builder currently supports Linux x86_64 hosts')
    env = os.environ.copy()
    env['RUSTUP_TOOLCHAIN'] = PINS['rust_toolchain']
    ndk = pathlib.Path(env.get('ANDROID_NDK_HOME') or env.get('ANDROID_NDK_ROOT') or
                       str(pathlib.Path(env.get('ANDROID_HOME', '')) / 'ndk' / PINS['ndk']))
    prop = ndk / 'source.properties'
    if not prop.is_file() or ('Pkg.Revision = ' + PINS['ndk']) not in prop.read_text():
        raise SystemExit('Install Android NDK ' + PINS['ndk'] + ' and set ANDROID_NDK_HOME')
    env['ANDROID_NDK_HOME'] = str(ndk)
    env['ANDROID_NDK_ROOT'] = str(ndk)
    rust_version = subprocess.check_output(['rustc', '--version'], env=env, text=True)
    if not rust_version.startswith('rustc ' + PINS['rust_toolchain'] + ' '):
        raise SystemExit('Install Rust toolchain ' + PINS['rust_toolchain'])
    ndk_version = subprocess.check_output(['cargo', 'ndk', '--version'], env=env, text=True)
    if PINS['cargo_ndk'] not in ndk_version:
        raise SystemExit('Install cargo-ndk ' + PINS['cargo_ndk'] + ' using cargo install --locked')
    protoc = BUILD / 'protoc'
    with zipfile.ZipFile(download('protoc')) as z:
        z.extractall(protoc)
    (protoc / 'bin/protoc').chmod(0o755)
    env['PROTOC'] = str(protoc / 'bin/protoc')
    env['PROTOC_INCLUDE'] = str(protoc / 'include')
    env['PATH'] = str(protoc / 'bin') + os.pathsep + env.get('PATH', '')
    # Do not allow the enclosing application's Git identity to become SDK build
    # metadata when building a checksum-verified upstream source archive.
    env['GIT_CEILING_DIRECTORIES'] = str(source.parent)
    env['VERGEN_GIT_SHA'] = PINS['rust_sdk']['commit']
    env['VERGEN_GIT_DESCRIBE'] = PINS['version']
    env['VERGEN_IDEMPOTENT'] = '1'
    env.pop('RUSTFLAGS', None)
    env['CARGO_ENCODED_RUSTFLAGS'] = '\x1f'.join(['-C', 'link-arg=-Wl,--build-id=sha1', '-C', 'link-arg=-Wl,-z,max-page-size=16384', '--remap-path-prefix=' + str(source) + '=/src/matrix-rust-sdk'])
    env['CARGO_BUILD_JOBS'] = env.get('CARGO_BUILD_JOBS', '2')
    output = output.resolve()
    if output.exists() and any(output.iterdir()):
        raise SystemExit(f'Native output must be empty: {output}')
    output.mkdir(parents=True, exist_ok=True)
    lock_hash = digest(source / 'Cargo.lock')
    run(['cargo', 'run', '--locked', '--package', 'xtask', '--', 'kotlin', 'build-android-library',
         '--package', 'full-sdk', '--profile', PINS['profile'], '--only-target', target,
         '--src-dir', output], cwd=source, env=env)
    if digest(source / 'Cargo.lock') != lock_hash:
        raise SystemExit('Upstream Cargo.lock changed during build')
    abi = PINS['targets'][target]
    library = output / 'jniLibs' / abi / 'libmatrix_sdk_ffi.so'
    if not library.is_file():
        raise SystemExit('Native library missing after compilation')
    llvm = ndk / 'toolchains/llvm/prebuilt/linux-x86_64/bin'
    run([llvm / 'llvm-strip', '--strip-debug', '--strip-unneeded', library])
    bindings = output / 'kotlin/org/matrix/rustcomponents/sdk/matrix_sdk_ffi.kt'
    if not bindings.is_file() or 'requestPeerDeviceVerification' not in bindings.read_text():
        raise SystemExit('Regenerated bindings do not expose peer device verification')
    provenance = {'version': PINS['version'], 'target': target, 'abi': abi,
                  'sources_sha256': digest(HERE / 'sources.json'), 'patch_sha256': digest(PATCH),
                  'cargo_lock_sha256': lock_hash, 'rust_sdk_commit': PINS['rust_sdk']['commit'],
                  'distribution_commit': PINS['distribution']['commit'],
                  'kotlin_sha256': tree_hashes(output / 'kotlin'), 'library_sha256': digest(library),
                  'license_sha256': digest(source / 'LICENSE')}
    shutil.copy2(source / 'LICENSE', output / 'LICENSE')
    (output / 'provenance.json').write_text(json.dumps(provenance, indent=2, sort_keys=True) + '\n')

def assemble(inputs, output):
    distribution = extract('distribution', BUILD / 'work' / 'assembly')
    main = distribution / 'sdk/sdk-android/src/main'
    shutil.rmtree(main / 'kotlin', ignore_errors=True)
    shutil.rmtree(main / 'jniLibs', ignore_errors=True)
    common = None
    reports = []
    for target, abi in PINS['targets'].items():
        native = inputs.resolve() / target
        record = json.loads((native / 'provenance.json').read_text())
        if record['target'] != target or record['abi'] != abi or record['version'] != PINS['version']:
            raise SystemExit('Native target/version mismatch')
        if record['sources_sha256'] != digest(HERE / 'sources.json') or record['patch_sha256'] != digest(PATCH):
            raise SystemExit('Native artifact built from different pins/patch')
        actual = tree_hashes(native / 'kotlin')
        if actual != record['kotlin_sha256'] or (common is not None and common != actual):
            raise SystemExit('Kotlin bindings differ between targets or from recorded hashes')
        library = native / 'jniLibs' / abi / 'libmatrix_sdk_ffi.so'
        if digest(library) != record['library_sha256']:
            raise SystemExit('Native library hash mismatch')
        if digest(native / 'LICENSE') != record['license_sha256']:
            raise SystemExit('Native license hash mismatch')
        if common is None:
            shutil.copytree(native / 'kotlin', main / 'kotlin')
            common = actual
        (main / 'jniLibs' / abi).mkdir(parents=True)
        shutil.copy2(library, main / 'jniLibs' / abi / library.name)
        reports.append(record)
    # Mark the upstream-derived package as a distinct Vellivex build.
    versions = distribution / 'buildSrc/src/main/kotlin/BuildVersionsSDK.kt'
    versions.write_text(versions.read_text().replace('"05"', '"05-vellivex.1"'))
    notices = main / 'resources/META-INF'
    notices.mkdir(parents=True, exist_ok=True)
    shutil.copy2(inputs.resolve() / next(iter(PINS['targets'])) / 'LICENSE', notices / 'MATRIX-SDK-APACHE-2.0.txt')
    (notices / 'VELLIVEX-SDK-PROVENANCE.json').write_text(json.dumps(reports, indent=2, sort_keys=True) + '\n')
    gradle = distribution / 'gradlew'
    gradle.chmod(0o755)
    run([gradle, '--no-daemon', ':sdk:sdk-android:assembleRelease'], cwd=distribution)
    result = distribution / 'sdk/sdk-android/build/outputs/aar/sdk-android-release.aar'
    with zipfile.ZipFile(result) as z:
        required = {'classes.jar', 'AndroidManifest.xml', *('jni/' + abi + '/libmatrix_sdk_ffi.so' for abi in PINS['targets'].values())}
        if not required.issubset(z.namelist()):
            raise SystemExit('Complete AAR is missing bindings or a required ABI')
    output = output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(result, output)
    output.with_suffix(output.suffix + '.sha256').write_text(digest(output) + '  ' + output.name + '\n')
    output.with_suffix(output.suffix + '.provenance.json').write_text(json.dumps(reports, indent=2, sort_keys=True) + '\n')
    print('Built complete SDK AAR:', output, flush=True)

if a.native_only:
    if not a.target or not a.output_dir or a.assemble_from:
        p.error('--native-only requires --target and --output-dir')
    build_native(a.target, a.output_dir)
elif a.assemble_from:
    if not a.output or a.target or a.output_dir or a.prepare_only:
        p.error('--assemble-from requires --output and cannot be combined with native options')
    assemble(a.assemble_from, a.output)
else:
    if a.target or a.output_dir:
        p.error('--target/--output-dir require --native-only')
    inputs = BUILD / 'native'
    for target in PINS['targets']:
        build_native(target, inputs / target)
    if not a.prepare_only:
        assemble(inputs, a.output or BUILD / ('vellivex-matrix-sdk-' + PINS['version'] + '.aar'))
PY
