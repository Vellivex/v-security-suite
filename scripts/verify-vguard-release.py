#!/usr/bin/env python3
"""Read-only VGuard source/release checks; SDK verification is explicit and optional."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import xml.etree.ElementTree as ET

ANDROID = '{http://schemas.android.com/apk/res/android}'
OFFICIAL_CERT = '7bdb5a95a45f735a175580a937eb5c7ec55a2c886ce038ed106c1dfa1f3ff049'
PERMISSIONS = {'android.permission.' + name for name in (
    'QUERY_ALL_PACKAGES', 'FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_SPECIAL_USE', 'POST_NOTIFICATIONS')}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'Duplicate JSON field: ' + key)
        result[key] = value
    return result


def read_json(path):
    require(path.is_file() and not path.is_symlink(), 'Missing or symbolic metadata: ' + str(path))
    return json.loads(path.read_text(encoding='utf-8'), object_pairs_hook=unique_object)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def manifest_policy(manifest, report):
    attr = lambda element, name: element.get(ANDROID + name)
    require(manifest.tag == 'manifest' and manifest.get('package') == report['package'], 'Manifest package mismatch')
    require(attr(manifest, 'versionName') == report['version'], 'Manifest version mismatch')
    sdk = manifest.find('uses-sdk')
    require(sdk is not None and attr(sdk, 'minSdkVersion') == str(report['min_sdk'])
            and attr(sdk, 'targetSdkVersion') == str(report['target_sdk']), 'Manifest SDK mismatch')
    permissions = [attr(item, 'name') for item in manifest if item.tag.startswith('uses-permission')]
    require(len(permissions) == len(PERMISSIONS) and set(permissions) == PERMISSIONS,
            'Unexpected or duplicate native permission')
    app = manifest.find('application')
    require(app is not None, 'Missing application')
    for name in ('allowBackup', 'fullBackupContent', 'usesCleartextTraffic'):
        require(attr(app, name) == 'false', 'Unsafe application flag: ' + name)
    for name in ('debuggable', 'testOnly'):
        require(attr(app, name) in (None, 'false'), 'Unsafe application flag: ' + name)
    require(attr(app, 'dataExtractionRules') is not None, 'Missing backup transfer exclusions')
    components = [item for item in app if item.tag in ('activity', 'activity-alias', 'service', 'receiver', 'provider')]
    require([(item.tag, attr(item, 'name')) for item in components] ==
            [('activity', '.MainActivity'), ('service', '.GuardService')], 'Unexpected native component')
    service = components[1]
    require(attr(service, 'exported') == 'true' and attr(service, 'permission') == 'android.permission.BIND_VPN_SERVICE',
            'VPN service permission protection changed')


def aapt_manifest(text):
    """Read the element/attribute subset emitted by official aapt2 dump xmltree."""
    stack, root = [], None
    for line in text.splitlines():
        element = re.match(r'^(\s*)E: ([\w-]+) \(line=\d+\)$', line)
        if element:
            indent, name = len(element[1]), element[2]
            while stack and stack[-1][0] >= indent:
                stack.pop()
            node = ET.Element(name)
            if stack:
                stack[-1][1].append(node)
            else:
                require(root is None, 'Multiple compiled manifest roots')
                root = node
            stack.append((indent, node))
            continue
        attribute = re.match(r'^\s*A: (http://schemas.android.com/apk/res/android:)?([\w]+)(?:\([^)]*\))?=(.*)$', line)
        if attribute and stack:
            namespace, name, value = attribute.groups()
            if value.startswith('"'):
                match = re.match(r'^"([^"\n]*)"', value)
                require(match is not None, 'Unreadable compiled manifest value')
                value = match[1]
            stack[-1][1].set((ANDROID if namespace else '') + name, value)
    require(root is not None, 'Unreadable compiled manifest')
    return root


def verify(root, apk_override=None, require_apk=False, sdk=None):
    native = root / 'apps/vguard'
    report = read_json(native / 'validation/Package-Build.json')
    pinned = read_json(native / 'validation/Candidate-Source-Fingerprints.json')
    require(isinstance(report, dict) and isinstance(pinned, dict), 'Release metadata must be JSON objects')
    require(report.get('package') == 'app.vguard.firewall', 'Release package changed')
    require(isinstance(report.get('version'), str) and re.fullmatch(r'\d+\.\d+\.\d+-candidate', report['version']), 'Invalid release version')
    require(report.get('artifact') == 'VGuard-' + report['version'] + '.apk', 'Release filename mismatch')
    for name in ('sha256', 'source_fingerprint_sha256'):
        require(isinstance(report.get(name), str) and re.fullmatch(r'[0-9a-f]{64}', report[name]), 'Invalid release digest: ' + name)
    for name in ('bytes', 'min_sdk', 'target_sdk', 'compile_sdk'):
        require(type(report.get(name)) is int and report[name] > 0, 'Invalid release integer: ' + name)
    require(report.get('signing_certificate_sha256') == OFFICIAL_CERT, 'Official signing identity changed')
    require(pinned.get('candidate') == report['artifact'] and pinned.get('apk_sha256') == report['sha256']
            and pinned.get('source_fingerprint_sha256') == report['source_fingerprint_sha256'], 'Release metadata disagree')
    actual, combined = {}, hashlib.sha256()
    require((native / 'app').is_dir() and not (native / 'app').is_symlink(), 'Missing or symbolic native input directory')
    for path in sorted((native / 'app').rglob('*')):
        require(not path.is_symlink(), 'Symbolic native input: ' + str(path))
        if path.is_file():
            name, data = path.relative_to(native).as_posix(), path.read_bytes()
            actual[name] = digest(data)
            combined.update(name.encode('utf-8') + b'\0' + data)
    require(actual and actual == pinned.get('source_sha256'), 'Changed, missing or unlisted native source input')
    require(combined.hexdigest() == report['source_fingerprint_sha256'], 'Combined native source fingerprint mismatch')
    source_manifest = ET.parse(native / 'app/src/main/AndroidManifest.xml').getroot()
    manifest_policy(source_manifest, report)
    published = root / 'releases' / ('VGuard-' + report['version'].removesuffix('-candidate') + '-Build-Report.json')
    if published.exists():
        require(read_json(published) == report, 'Published build report mismatch')
    apk = apk_override or root / 'releases' / report['artifact']
    require(not apk.is_symlink(), 'APK must not be symbolic')
    result = {'source_inputs': len(actual), 'source_fingerprint': combined.hexdigest(),
              'apk_hash_verified': False, 'fresh_sdk_verification': False,
              'scope': 'Source inputs and policy only; no APK available. No runtime or reproducible-build claim.'}
    if not apk.exists():
        require(not require_apk and sdk is None, 'Required APK missing: ' + str(apk))
        return result
    require(apk.is_file() and not apk.is_symlink(), 'APK must be a regular file')
    data = apk.read_bytes()
    require(len(data) == report['bytes'] and digest(data) == report['sha256'], 'APK bytes/hash mismatch')
    result.update(apk_hash_verified=True, apk_sha256=report['sha256'],
                  scope='Source inputs, policy and APK hash only; signature not freshly checked. No runtime or reproducible-build claim.')
    if sdk is not None:
        require(re.fullmatch(r'\d+\.\d+\.\d+', report.get('build_tools', '')) is not None, 'Invalid SDK tools version')
        tools = sdk / 'build-tools' / report['build_tools']

        def run(name, *arguments):
            tool = tools / name
            require(tool.is_file(), 'Missing SDK tool: ' + str(tool))
            output = subprocess.run([str(tool), *map(str, arguments)], check=True,
                                    capture_output=True, text=True, timeout=60)
            return output.stdout

        signature = run('apksigner', 'verify', '--verbose', '--print-certs', apk)
        certs = re.findall(r'Signer #\d+ certificate SHA-256 digest: ([0-9a-f]{64})', signature)
        require(certs == [OFFICIAL_CERT] and 'Verifies' in signature, 'APK signing identity mismatch')
        run('zipalign', '-c', '4', apk)
        compiled_manifest = aapt_manifest(run('aapt2', 'dump', 'xmltree', '--file', 'AndroidManifest.xml', apk))
        manifest_policy(compiled_manifest, report)
        require(compiled_manifest.get(ANDROID + 'versionCode') == source_manifest.get(ANDROID + 'versionCode'), 'Compiled version code mismatch')
        require(compiled_manifest.get(ANDROID + 'compileSdkVersion') == str(report['compile_sdk']), 'Compiled SDK mismatch')
        result.update(fresh_sdk_verification=True, signing_certificate_sha256=OFFICIAL_CERT,
                      scope='Fresh SDK signature, signing identity, alignment and compiled manifest checks; source inputs and APK hash agree. No runtime or reproducible-build claim.')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument('--apk', type=Path)
    parser.add_argument('--require-apk', action='store_true')
    parser.add_argument('--sdk', type=Path, help='Official Android SDK directory for fresh signature/alignment/manifest verification')
    args = parser.parse_args()
    try:
        print(json.dumps(verify(args.root, args.apk, args.require_apk, args.sdk), sort_keys=True))
    except (ValueError, OSError, KeyError, TypeError, ET.ParseError, subprocess.SubprocessError) as error:
        print('VGuard release verification failed: ' + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
