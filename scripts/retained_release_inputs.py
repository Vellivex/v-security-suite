# SPDX-License-Identifier: GPL-3.0-or-later
"""Fail early unless release packaging has the exact retained original inputs."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import sys

# Existing release pins, recovered against SHA256SUMS and the 0.1.3 build report.
# These are retained inputs, not newly produced source archives or current APKs.
RETAINED_INPUTS = (
    {"name": "VGuard-0.1.3-candidate.apk", "bytes": 90718,
     "sha256": "6977d17d356f76a181a4979bf4fefa4f486167b90e2df612e5c93aed4977df58"},
    {"name": "VGuard-0.1.1-Source-GPL.zip", "bytes": 93927,
     "sha256": "1c38e2caddf946fff669e769f04b2f8ed69a92ec49c1ee41fe86b3992859588b"},
    {"name": "VGuard-0.1.2-Source-GPL.zip", "bytes": 97882,
     "sha256": "dd8a7d0ee2a66d9cd926067daf969dae7466599c45b5546a88676390185ec41e"},
)


def verify(root, inputs=RETAINED_INPUTS):
    root = Path(root).resolve()
    release = root / 'releases'
    if release.is_symlink():
        raise ValueError('Refusing symbolic releases directory.')
    checked = []
    for item in inputs:
        path = release / item['name']
        try:
            if path.is_symlink():
                raise ValueError('Refusing symbolic retained input: ' + item['name'])
            descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
                                 | getattr(os, 'O_NONBLOCK', 0))
        except FileNotFoundError:
            raise ValueError('Missing retained release input: releases/' + item['name']
                             + '. Restore the exact original from the verified retained-input bundle; '
                             + 'see docs/RETAINED-RELEASE-INPUTS.md. No output was built.') from None
        with os.fdopen(descriptor, 'rb') as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size != item['bytes']:
                raise ValueError('Retained input is not a regular file of the pinned size: ' + item['name'])
            data = handle.read(item['bytes'] + 1)
        actual = hashlib.sha256(data).hexdigest()
        if len(data) != item['bytes'] or actual != item['sha256']:
            raise ValueError('Retained input hash mismatch: ' + item['name']
                             + '. Restore the original; do not change the pin.')
        checked.append(dict(item))
    return {'passed': True, 'retained_inputs': checked,
            'scope': 'Original input bytes only; no fresh APK signature or device test.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args()
    try:
        print(json.dumps(verify(args.root), sort_keys=True))
    except (OSError, ValueError) as error:
        print('Retained release input check failed: ' + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
