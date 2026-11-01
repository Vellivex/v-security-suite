#!/usr/bin/env python3
"""Block known unrelated identities in public source and Git metadata.

The rule digests avoid republishing the identifiers in this public checker.
They are matching fingerprints, not encryption or protection against guessing.
"""
from __future__ import annotations

import argparse
import fnmatch
import hashlib
import html
import json
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

RULES = (
    ("other-project", 6, "4fe516104958c2c46da0bf393cba204eba8bc190fa86f1376077a19943de47a7"),
    ("other-project", 10, "99c4a926daa827a5417a92afcbf7b22a26a61d3d20005aa88a37ef341639bf75"),
    ("other-project", 5, "fa407482099295e802a8775a1d3547cf0a11a86970722008a8613f937b344d8a"),
    ("personal-name", 14, "8086ecde4101c0108ac7f587650b334f77db7cb07711d6138f7fdc056ddf1e24"),
    ("personal-name", 10, "21c4519bb0abe0b878ddcd7b20d8f5c05873b75b035b60235d3c52134d787b38"),
    ("personal-name", 13, "5bb4e145e4ca09d84e033908f9816a12179f2662532bb5fa0d55a730b3bc50e1"),
    ("personal-name", 16, "4d619d844ef0470733300b379502f32c302158c07117ddf284968e72b5a8305b"),
    ("personal-name", 6, "7ee8118150e0ce023742beba6f10bf23aabbf0bc2c182f36fd1a6753cd21b4c6"),
    ("personal-name", 7, "e1fc45f7880e0505ff0b6a079b9af149f225e260f59b1d20225357a8cce8ffd8"),
    ("private-contact", 29, "49c790ecc68f2e4bf607964159b43ef7fff356387aab49d7b338cbcf3d6c6db4"),
    ("private-contact", 10, "bcd7b624b02f50e93bdf311fddffe5f20dbf788a1f2840a280f5d3a0b431d429"),
)
EXPECTED_NAME = "Vellivex"
EXPECTED_EMAIL = "v@vellivex.com"
RULE_INDEX: dict[int, dict[str, str]] = {}
for _kind, _length, _digest in RULES:
    RULE_INDEX.setdefault(_length, {})[_digest] = _kind


def normalize(text: str) -> str:
    """Normalize case, separators, HTML entities, and common Unicode escapes."""
    text = html.unescape(text)
    text = re.sub(r"\\u([0-9a-fA-F]{4})", lambda m: chr(int(m[1], 16)), text)
    text = unicodedata.normalize("NFKC", text).casefold()
    return re.sub(r"[^a-z0-9]", "", text)


def matched_categories(text: str) -> set[str]:
    compact = normalize(text)
    matches: set[str] = set()
    for length, digests in RULE_INDEX.items():
        for start in range(len(compact) - length + 1):
            digest = hashlib.sha256(compact[start : start + length].encode()).hexdigest()
            if digest in digests:
                matches.add(digests[digest])
    return matches


def display_path(path: str) -> str:
    if matched_categories(path):
        return "<redacted-path:" + hashlib.sha256(path.encode()).hexdigest()[:12] + ">"
    return path


def run_git(root: Path, *args: str) -> bytes:
    result = subprocess.run(
        ["git", "-C", str(root), *args], capture_output=True, check=False
    )
    if result.returncode:
        # Git errors can contain private remotes or paths; do not echo stderr.
        raise RuntimeError("Git inspection failed: " + args[0])
    return result.stdout


def tracked_paths(root: Path) -> list[str]:
    return [p.decode("utf-8", "surrogateescape") for p in run_git(root, "ls-files", "-z").split(b"\0") if p]


def find_text(text: str, location: str, source: str) -> list[dict]:
    findings = []
    # Scan short overlapping groups of lines as well: a name split over lines
    # must still be detected. An exact line is not claimed for those groups.
    lines = text.splitlines()
    seen: set[tuple[str, int]] = set()
    for index in range(len(lines)):
        for category in matched_categories("\n".join(lines[index : index + 4])):
            key = (category, index // 4)
            if key not in seen:
                seen.add(key)
                findings.append({"source": source, "location": location,
                                 "line_start": index + 1, "category": category})
    return findings


def inspect_history_content(root: Path, findings: list[dict], skipped: list[dict]) -> dict:
    """Check unique historical blob bytes, not only the current checkout."""
    commits = run_git(root, "rev-list", "--all").decode().splitlines()
    seen_blobs: set[str] = set()
    for commit in commits:
        for entry in run_git(root, "ls-tree", "-r", "-z", "--full-tree", commit).split(b"\0"):
            if not entry:
                continue
            metadata, raw_path = entry.split(b"\t", 1)
            mode, kind, oid = metadata.decode().split()
            path = raw_path.decode("utf-8", "surrogateescape")
            for category in matched_categories(path):
                findings.append({"source": "historical-path", "location": display_path(path), "category": category})
            if kind != "blob" or mode == "160000":
                raise RuntimeError("Historical submodule content requires separate review")
            if oid in seen_blobs:
                continue
            seen_blobs.add(oid)
            raw = run_git(root, "cat-file", "blob", oid)
            try:
                text = raw.decode("utf-8")
                if "\0" in text:
                    raise UnicodeError()
            except UnicodeError:
                skipped.append({"location": oid, "reason": "historical-binary-needs-artifact-review"})
                continue
            for category in matched_categories(text):
                findings.append({"source": "historical-content", "location": oid, "category": category})
    return {"historical_commits_checked": len(commits), "historical_blobs_checked": len(seen_blobs)}


def inspect(root: Path, *, history: str = "all", excludes: tuple[str, ...] = (),
            require_head_identity: bool = False, check_local_identity: bool = False,
            history_content: bool = False) -> dict:
    root = root.resolve()
    findings: list[dict] = []
    skipped: list[dict] = []
    errors: list[dict] = []
    scanned = 0
    for relative in tracked_paths(root):
        location = display_path(relative)
        if any(fnmatch.fnmatch(relative, pattern) for pattern in excludes):
            skipped.append({"location": location, "reason": "explicit-exclusion"})
            continue
        path = root / relative
        for category in matched_categories(relative):
            findings.append({"source": "tracked-path", "location": location, "category": category})
        if path.is_symlink():
            # Do not follow a tracked link outside the checkout.
            text = str(path.readlink())
        else:
            try:
                raw = path.read_bytes()
                if b"\0" in raw:
                    skipped.append({"location": location, "reason": "binary-needs-artifact-review"})
                    continue
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                skipped.append({"location": location, "reason": "non-utf8-needs-artifact-review"})
                continue
            except OSError:
                errors.append({"location": location, "reason": "unreadable-tracked-file"})
                continue
        findings.extend(find_text(text, location, "tracked-content"))
        scanned += 1
    commits_checked = 0
    if history != "none":
        git_args = ["log", "--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x00%x1e"]
        git_args += ["--all"] if history == "all" else ["-1", "HEAD"]
        for record in run_git(root, *git_args).decode("utf-8", "replace").split("\x1e"):
            fields = record.strip("\n").split("\0")
            if not fields[0]:
                continue
            if len(fields) < 6:
                raise RuntimeError("Unexpected Git metadata record")
            commit = fields[0]
            commits_checked += 1
            for field_name, value in zip(("author-name", "author-email", "committer-name", "committer-email", "message"), fields[1:6]):
                for category in matched_categories(value):
                    findings.append({"source": "git-" + field_name, "location": commit, "category": category})
    if require_head_identity:
        identity = run_git(root, "show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce", "HEAD").decode().strip().split("\0")
        expected = [EXPECTED_NAME, EXPECTED_EMAIL, EXPECTED_NAME, EXPECTED_EMAIL]
        # Platform-created commits are not silently exempted.
        if identity != expected:
            findings.append({"source": "head-identity", "location": "HEAD", "category": "unexpected-project-identity"})
    if check_local_identity:
        local = []
        for key in ("user.name", "user.email"):
            try:
                local.append(run_git(root, "config", "--get", key).decode().strip())
            except RuntimeError:
                local.append(None)
        if local != [EXPECTED_NAME, EXPECTED_EMAIL]:
            findings.append({"source": "local-git-identity", "location": "checkout", "category": "unexpected-project-identity"})
    historical = inspect_history_content(root, findings, skipped) if history_content else {}
    return {"passed": not findings and not errors, "files_scanned": scanned,
            "commits_checked": commits_checked, "findings": findings,
            "skipped": skipped, "errors": errors, **historical,
            "coverage": "Tracked UTF-8 files, paths, link targets, and requested reachable Git metadata; historical text blobs when enabled. Binary artifacts and external services require separate review."}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--history", choices=("all", "head", "none"), default="all")
    parser.add_argument("--exclude", action="append", default=[], metavar="GLOB",
                        help="Explicit exclusion, reported in the result. Never exclude public distributables.")
    parser.add_argument("--require-head-identity", action="store_true")
    parser.add_argument("--check-local-identity", action="store_true")
    parser.add_argument("--history-content", action="store_true",
                        help="Also inspect unique text blobs and paths throughout all reachable history.")
    args = parser.parse_args(argv)
    try:
        result = inspect(args.root, history=args.history, excludes=tuple(args.exclude),
                         require_head_identity=args.require_head_identity,
                         check_local_identity=args.check_local_identity,
                         history_content=args.history_content)
    except (OSError, RuntimeError) as exc:
        print(json.dumps({"passed": False, "error": str(exc)}))
        return 2
    print(json.dumps(result, indent=2))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
