#!/usr/bin/env python3
"""Recompile public VGuard sources unsigned and compare every APK payload entry.

Uses an existing official Android SDK and JDK. Never signs, generates keys, reads
signing material, invokes build.py, or changes the official APK/native checkout.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile

MAX_ENTRY_BYTES = 4 * 1024 * 1024
MAX_PAYLOAD_BYTES = 16 * 1024 * 1024


def require(condition, message):
    if not condition:
        raise ValueError(message)


def payload_entries(path):
    """Hash bounded uncompressed entry bytes; do not extract files or skip META entries."""
    entries, total = {}, 0
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        require(0 < len(infos) <= 128, 'Unexpected APK entry count')
        for info in infos:
            name = info.filename
            require(name and not name.startswith('/') and '\\' not in name
                    and all(part not in ('', '.', '..') for part in name.split('/'))
                    and all(ord(char) >= 32 and ord(char) != 127 for char in name),
                    'Noncanonical APK entry name')
            require(name not in entries, 'Duplicate APK payload entry: ' + name)
            require(not info.is_dir() and not stat.S_ISLNK(info.external_attr >> 16), 'Non-file APK payload entry: ' + name)
            require(not info.flag_bits & 1, 'Encrypted APK payload entry: ' + name)
            require(info.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), 'Unsupported APK compression: ' + name)
            require(0 <= info.file_size <= MAX_ENTRY_BYTES, 'Oversized APK payload entry: ' + name)
            total += info.file_size
            require(total <= MAX_PAYLOAD_BYTES, 'Oversized total APK payload')
            with archive.open(info) as stream:
                data = stream.read(MAX_ENTRY_BYTES + 1)
            require(len(data) == info.file_size, 'APK payload entry size mismatch: ' + name)
            entries[name] = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
    return entries


def compare_payloads(unsigned, official):
    generated, released = payload_entries(unsigned), payload_entries(official)
    require(set(generated) == set(released), 'Missing or unexpected APK payload entries')
    require(generated == released, 'Recompiled APK payload bytes differ')
    return dict(sorted(generated.items()))


def release_module():
    specification = importlib.util.spec_from_file_location('vguard_release', Path(__file__).with_name('verify-vguard-release.py'))
    module = importlib.util.module_from_spec(specification)
    previous = sys.dont_write_bytecode
    try:
        sys.dont_write_bytecode = True
        specification.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = previous
    return module


def verify(root, sdk, apk_override=None):
    release = release_module()
    # Verify the official signed artifact, source fingerprint and manifest first.
    receipt = release.verify(root, apk_override, require_apk=True, sdk=sdk)
    native = root / 'apps/vguard'
    report = release.read_json(native / 'validation/Package-Build.json')
    apk = (apk_override or root / 'releases' / report['artifact']).resolve()
    require(re.fullmatch(r'\d+\.\d+\.\d+', report['build_tools']) is not None, 'Invalid build tools version')
    tools = (sdk / 'build-tools' / report['build_tools']).resolve()
    android_jar = (sdk / 'platforms' / ('android-' + str(report['compile_sdk'])) / 'android.jar').resolve()
    require(android_jar.is_file(), 'Missing Android SDK platform')
    java = shutil.which('java')
    require(java is not None, 'JDK is required')
    tool_paths = {name: tools / name for name in ('aapt2', 'd8')}
    require(all(path.is_file() for path in tool_paths.values()), 'Missing unsigned compilation tool')

    with tempfile.TemporaryDirectory(prefix='vguard-public-payload-') as directory:
        work = Path(directory)
        # Copy only reviewed public application files. No signing directories,
        # previous build intermediates or build.py execution are involved.
        shutil.copytree(native / 'app', work / 'app', symlinks=True)
        copied = sorted((work / 'app').rglob('*'))
        combined = hashlib.sha256()
        for path in copied:
            require(not path.is_symlink(), 'Symbolic native input during copy')
            if path.is_file():
                combined.update(path.relative_to(work).as_posix().encode('utf-8') + b'\0' + path.read_bytes())
        require(combined.hexdigest() == receipt['source_fingerprint'], 'Native source changed while copying')
        output = work / 'output'
        for name in ('gen', 'classes', 'dex'):
            (output / name).mkdir(parents=True)

        def run(command):
            completed = subprocess.run(list(map(str, command)), cwd=work, text=True,
                                       capture_output=True, timeout=60)
            require(completed.returncode == 0, 'Unsigned compile command failed: ' + str(command[0])
                    + '\n' + completed.stdout + completed.stderr)
            return (completed.stdout + completed.stderr).strip()

        versions = {'java': run([java, '-version']),
                    'aapt2': run([tool_paths['aapt2'], 'version']),
                    'd8': run([tool_paths['d8'], '--version'])}
        manifest = work / 'app/src/main/AndroidManifest.xml'
        run([tool_paths['aapt2'], 'compile', '--dir', manifest.parent / 'res', '-o', output / 'resources.zip'])
        run([tool_paths['aapt2'], 'link', '-o', output / 'resources.ap_', '-I', android_jar,
             '--manifest', manifest, '--min-sdk-version', str(report['min_sdk']),
             '--target-sdk-version', str(report['target_sdk']), '--java', output / 'gen', output / 'resources.zip'])
        sources = sorted((manifest.parent / 'java').rglob('*.java')) + sorted((output / 'gen').rglob('*.java'))
        require(len(sources) >= 4, 'Incomplete Java source inputs')
        run([java, '-m', 'jdk.compiler/com.sun.tools.javac.Main', '-encoding', 'UTF-8',
             '-source', '8', '-target', '8', '-bootclasspath', str(tools / 'core-lambda-stubs.jar') + os.pathsep + str(android_jar),
             '-d', output / 'classes', *sources])
        with zipfile.ZipFile(output / 'classes.jar', 'w', zipfile.ZIP_DEFLATED) as archive:
            for path in sorted((output / 'classes').rglob('*.class')):
                archive.write(path, path.relative_to(output / 'classes').as_posix())
        run([tool_paths['d8'], '--release', '--min-api', str(report['min_sdk']), '--lib', android_jar,
             '--output', output / 'dex', output / 'classes.jar'])
        shutil.copyfile(output / 'resources.ap_', output / 'unsigned.apk')
        with zipfile.ZipFile(output / 'unsigned.apk', 'a', zipfile.ZIP_STORED) as archive:
            for path in sorted((output / 'dex').glob('*.dex')):
                archive.write(path, path.name)
        entries = compare_payloads(output / 'unsigned.apk', apk)
        require(hashlib.sha256(apk.read_bytes()).hexdigest() == receipt['apk_sha256'], 'Official APK changed during verification')
    return {'matching_payload': True, 'entries': entries, 'entry_count': len(entries),
            'official_apk_sha256': receipt['apk_sha256'], 'source_fingerprint': receipt['source_fingerprint'],
            'fresh_sdk_signature_verified': receipt['fresh_sdk_verification'],
            'compile_sdk': report['compile_sdk'], 'build_tools': report['build_tools'], 'tool_versions': versions,
            'scope': 'Clean unsigned compilation of copied public native sources reproduces every uncompressed entry of the signature-verified official APK. No signing key accessed; no signed-container byte-identity, independent-audit or Android-runtime claim.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument('--sdk', type=Path, required=True, help='Existing official Android SDK; no downloads are performed')
    parser.add_argument('--apk', type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(verify(args.root.resolve(), args.sdk.resolve(), args.apk), sort_keys=True))
    except (ValueError, OSError, KeyError, TypeError, RuntimeError, zipfile.BadZipFile, subprocess.SubprocessError) as error:
        print('VGuard payload verification failed: ' + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
