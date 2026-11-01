#!/usr/bin/env python3
"""Install the project's checks and identity in this repository only."""
from pathlib import Path
import json
import os
import subprocess
import sys


def git(root, *args, optional=False):
    result = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True)
    if result.returncode and not optional:
        raise RuntimeError("Cannot inspect repository configuration")
    return result.stdout.strip() if result.returncode == 0 else ""


def main():
    root = Path(__file__).resolve().parent.parent
    try:
        if Path(git(root, "rev-parse", "--show-toplevel")).resolve() != root:
            raise RuntimeError("Installer must be inside the target checkout")
        desired = "scripts/git-hooks"
        current = git(root, "config", "--get", "core.hooksPath", optional=True)
        if current and current != desired:
            raise RuntimeError("An existing hooks path needs review before replacement")
        git_dir = Path(git(root, "rev-parse", "--absolute-git-dir"))
        if not current:
            for name in ("pre-commit", "pre-push"):
                path = git_dir / "hooks" / name
                if path.exists() and os.access(path, os.X_OK):
                    raise RuntimeError("Existing active hooks need review before replacement")
        for name in ("pre-commit", "pre-push"):
            hook = root / desired / name
            if not hook.is_file() or hook.is_symlink():
                raise RuntimeError("Project hook is missing or linked")
            hook.chmod(0o755)
        git(root, "config", "--local", "user.name", "Vellivex")
        git(root, "config", "--local", "user.email", "v@vellivex.com")
        git(root, "config", "--local", "core.hooksPath", desired)
        print(json.dumps({"installed": True, "scope": "repository-local", "hooks": ["pre-commit", "pre-push"]}))
        return 0
    except (OSError, RuntimeError) as exc:
        print(json.dumps({"installed": False, "error": str(exc)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
