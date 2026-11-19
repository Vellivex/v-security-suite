# SPDX-License-Identifier: GPL-3.0-or-later
"""Package only reviewed source; never dereference links or include runtime data."""
from pathlib import Path
import hashlib
import json
import os
import re
import stat
import tempfile
import zipfile

root = Path(__file__).resolve().parent.parent
source_dirs = ['apps', 'web', 'server', 'tests', 'scripts', 'docs', '.github', 'drizzle']
top_files = ['AGENTS.md', 'LICENSE', 'NOTICE', 'README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'package.json']
release_files = ['VGuard-Setup.txt', 'VGuard-Test-Report.txt', 'RELEASE-NOTES.txt', 'VGuard-0.1.3-Build-Report.json', 'VGuard-0.1.3-Package-Verification.txt', 'VGuard-0.1.3-Security-Notes.txt']
ignored_dirs = {'build', 'out', '.classes', '.local-signing', '__pycache__', '.git', '.gradle', '.kotlin', '.venv', '.runtime'}
source_suffixes = {'.md', '.txt', '.json', '.js', '.mjs', '.cjs', '.ts', '.java', '.xml', '.py', '.sh', '.css', '.svg', '.sql', '.yml', '.yaml'}
public_hooks = {'scripts/git-hooks/pre-commit', 'scripts/git-hooks/pre-push'}
messenger_root = 'apps/messenger/'
messenger_android = messenger_root + 'android/'
messenger_ui_driver = messenger_root + 'android-app-to-app/'
gradle_launcher = messenger_android + 'gradlew'
gradle_wrapper = messenger_android + 'gradle/wrapper/gradle-wrapper.jar'
# Embedded gradle-wrapper.jar from the verified Gradle 8.14.3 binary distribution.
gradle_wrapper_sha256 = '7d3a4ac4de1c32b59bc6a4eb8ecb8e612ccd0cf1ae1e99f66902da64df296172'
messenger_text_files = {
    messenger_root + 'NOTICE',
    messenger_android + '.gitattributes',
    messenger_android + 'gradle.properties',
    messenger_ui_driver + 'gradle.properties',
    messenger_android + 'gradle/wrapper/gradle-wrapper.properties',
    gradle_launcher,
    gradle_launcher + '.bat',
    messenger_root + 'sdk/peer-device-verification.patch',
}
public_executables = public_hooks | {gradle_launcher}
private_suffixes = {'.pem', '.key', '.der', '.pfx', '.p12', '.jks', '.keystore', '.pass', '.sqlite', '.sqlite3', '.db', '.db3'}
private_name = re.compile(r'(^|[._-])(credentials?|secrets?|passwords?|private[._-]?key|signing[._-]?key|access[._-]?token)([._-]|$)', re.I)


def checked_path(path):
    relative = path.relative_to(root)
    for part in [path, *path.parents]:
        if part == root:
            break
        if part.is_symlink():
            raise RuntimeError(f'Refusing symlink in public inputs: {relative}')
    if not path.resolve().is_relative_to(root):
        raise RuntimeError(f'Public input escapes project: {relative}')
    return relative.as_posix()


def read_regular(path):
    name = checked_path(path)
    # O_NOFOLLOW prevents a final-component link swap between validation/open.
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    with os.fdopen(descriptor, 'rb') as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > 8 * 1024 * 1024:
            raise RuntimeError(f'Not a bounded regular public input: {name}')
        data = handle.read(8 * 1024 * 1024 + 1)
        if len(data) > 8 * 1024 * 1024:
            raise RuntimeError(f'Public input grew beyond its bound: {name}')
        return data


def source_candidate(path):
    name = checked_path(path)
    if not path.is_file():
        raise RuntimeError(f'Not a regular source file: {name}')
    lower = path.name.lower()
    suffix = path.suffix.lower()
    if lower.startswith('.env') or lower == 'local.properties' or suffix in private_suffixes or private_name.search(lower):
        raise RuntimeError(f'Private/runtime input is forbidden: {name}')
    kotlin = name.startswith((messenger_android, messenger_ui_driver)) and suffix in {'.kt', '.kts'}
    if not (
        suffix in source_suffixes or kotlin or name in messenger_text_files or name == gradle_wrapper
        or name in top_files or name in public_hooks or path.name == '.gitignore'
    ):
        raise RuntimeError(f'Unapproved source file type: {name}')
    return name


# The manifest is reviewed with source changes. A new text/JSON file must not
# silently become public just because it was placed beside application code.
manifest_path = root / 'scripts/source-manifest.json'
manifest = json.loads(read_regular(manifest_path))
if not isinstance(manifest, list) or not all(isinstance(p, str) and p and not p.startswith('/') and '..' not in Path(p).parts for p in manifest) or len(set(manifest)) != len(manifest):
    raise RuntimeError('Invalid public source manifest')
paths = []
for directory in source_dirs:
    base = root / directory
    checked_path(base)
    for parent, dirs, files in os.walk(base, followlinks=False):
        dirs[:] = [d for d in dirs if d.lower() not in ignored_dirs]
        for d in dirs:
            checked_path(Path(parent) / d)
        for name in files:
            if Path(name).suffix.lower() in {'.class', '.pyc'}:
                continue
            paths.append(Path(parent) / name)
paths += [root / name for name in top_files]
paths += [root / 'releases' / name for name in release_files]
actual = {source_candidate(path): path for path in paths}
if set(actual) != set(manifest):
    raise RuntimeError('Public source manifest mismatch; review new/missing paths: ' + ', '.join(sorted(set(actual) ^ set(manifest))))
# Validate and snapshot every included byte before writing either archive.
public = {name: read_regular(path) for name, path in actual.items()}
if gradle_wrapper in public and hashlib.sha256(public[gradle_wrapper]).hexdigest() != gradle_wrapper_sha256:
    raise RuntimeError(f'Gradle wrapper SHA-256 mismatch: {gradle_wrapper}')
for name, data in public.items():
    if name.startswith(messenger_root) and name != gradle_wrapper:
        try:
            data.decode('utf-8')
        except UnicodeDecodeError:
            raise RuntimeError(f'Expected UTF-8 Messenger source: {name}') from None
        if b'\0' in data:
            raise RuntimeError(f'Unexpected binary Messenger input: {name}')
if sum(map(len, public.values())) > 16 * 1024 * 1024:
    raise RuntimeError('Public source exceeds the reviewed 16 MiB bound')
checked_path(root / 'releases')


def write(archive, entries):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=archive.parent, delete=False) as handle:
            temporary = Path(handle.name)
        with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_DEFLATED) as bundle:
            for name, data in sorted(entries):
                info = zipfile.ZipInfo(name, date_time=(2026, 10, 23, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                executable = name.endswith('.sh') or name.partition('/')[2] in public_executables
                info.external_attr = (0o755 if executable else 0o644) << 16
                bundle.writestr(info, data)
        os.replace(temporary, archive)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


native = [('VGuard/' + name.removeprefix('apps/vguard/'), data) for name, data in public.items() if name.startswith('apps/vguard/')]
native += [('VGuard/' + name, public[name]) for name in ['LICENSE', 'NOTICE']]
native += [('VGuard/SETUP.txt', public['releases/VGuard-Setup.txt']), ('VGuard/TEST-REPORT.txt', public['releases/VGuard-Test-Report.txt'])]
write(root / 'releases/VGuard-Source-GPL.zip', native)
write(root / 'releases/V-Security-Source.zip', [('v-security-suite/' + name, data) for name, data in public.items()])
names = ['VGuard-0.1.3-candidate.apk', 'VGuard-Source-GPL.zip', 'VGuard-0.1.1-Source-GPL.zip', 'VGuard-0.1.2-Source-GPL.zip', 'V-Security-Source.zip', 'VGuard-0.1.3-Build-Report.json', 'VGuard-0.1.3-Package-Verification.txt', 'VGuard-0.1.3-Security-Notes.txt', 'RELEASE-NOTES.txt']
checksums = ''.join(hashlib.sha256(read_regular(root / 'releases' / name)).hexdigest() + '  ' + name + '\n' for name in names)
(root / 'releases/SHA256SUMS.txt').write_text(checksums)
print(f'Created GPL source archives from {len(public)} reviewed regular files; no links or forbidden input types allowed.')
