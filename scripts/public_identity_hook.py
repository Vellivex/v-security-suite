#!/usr/bin/env python3
"""Repository-local checks that run before creating or publishing commits."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys

import public_identity_check as check


def add_text(findings: list[dict], text: str, source: str, location: str) -> None:
    for category in check.matched_categories(text):
        findings.append({"source": source, "location": location, "category": category})


def inspect_blob(root: Path, oid: str, path: str, source: str,
                 findings: list[dict], skipped: list[dict]) -> None:
    location = check.display_path(path)
    add_text(findings, path, source + "-path", location)
    raw = check.run_git(root, "cat-file", "blob", oid)
    try:
        text = raw.decode("utf-8")
        if "\0" in text:
            raise UnicodeError()
    except UnicodeError:
        skipped.append({"location": location, "reason": "binary-needs-artifact-review"})
        return
    add_text(findings, text, source + "-content", location)


def inspect_index(root: Path, findings: list[dict], skipped: list[dict]) -> int:
    count = 0
    for record in check.run_git(root, "ls-files", "--stage", "-z").split(b"\0"):
        if not record:
            continue
        meta, path = record.split(b"\t", 1)
        mode, oid, stage = meta.decode().split()
        if stage != "0" or mode == "160000":
            raise RuntimeError("Unmerged entries and submodules need explicit review")
        inspect_blob(root, oid, path.decode("utf-8", "surrogateescape"),
                     "staged", findings, skipped)
        count += 1
    return count


def check_proposed_identity(root: Path, findings: list[dict]) -> None:
    expected = (check.EXPECTED_NAME, check.EXPECTED_EMAIL)
    for role in ("AUTHOR", "COMMITTER"):
        raw = check.run_git(root, "var", "GIT_" + role + "_IDENT").decode().strip()
        match = re.fullmatch(r"(.+) <([^<>]+)> [0-9]+ [+-][0-9]{4}", raw)
        if not match:
            raise RuntimeError("Invalid proposed Git identity")
        name, email = match[1], match[2]
        source = "proposed-" + role.lower()
        add_text(findings, name + " " + email, source, "next-commit")
        if (name, email) != expected:
            findings.append({"source": source, "location": "next-commit",
                             "category": "unexpected-project-identity"})


def inspect_push(root: Path, updates: str, findings: list[dict],
                 skipped: list[dict]) -> dict:
    commits: set[str] = set()
    for record in updates.splitlines():
        fields = record.split()
        if len(fields) != 4:
            raise RuntimeError("Invalid pre-push update record")
        local_ref, local_oid, remote_ref, remote_oid = fields
        if not all(re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", oid)
                   for oid in (local_oid, remote_oid)):
            raise RuntimeError("Invalid pre-push object identifier")
        add_text(findings, local_ref + " " + remote_ref, "push-ref", "proposed-ref")
        if not local_oid.strip("0"):
            continue
        kind = check.run_git(root, "cat-file", "-t", local_oid).decode().strip()
        if kind != "commit":
            raise RuntimeError("Only reviewed commit references can be pushed by this hook")
        # Inspect each supplied source, including objects unreachable from the
        # currently checked-out branch. Do not trust a remote's claimed cutoff.
        commits.update(check.run_git(root, "rev-list", local_oid).decode().splitlines())
    seen_blobs: set[str] = set()
    for commit in sorted(commits):
        raw = check.run_git(root, "cat-file", "commit", commit)
        header, separator, message = raw.partition(b"\n\n")
        if not separator:
            raise RuntimeError("Invalid pending commit")
        for line in header.splitlines():
            if line.startswith((b"author ", b"committer ")):
                role, value = line.split(b" ", 1)
                add_text(findings, value.decode("utf-8", "replace"),
                         "push-" + role.decode(), commit)
        add_text(findings, message.decode("utf-8", "replace"), "push-message", commit)
        for entry in check.run_git(root, "ls-tree", "-r", "-z", "--full-tree", commit).split(b"\0"):
            if not entry:
                continue
            metadata, path = entry.split(b"\t", 1)
            mode, kind, oid = metadata.decode().split()
            decoded = path.decode("utf-8", "surrogateescape")
            add_text(findings, decoded, "push-path", check.display_path(decoded))
            if kind != "blob" or mode == "160000":
                raise RuntimeError("Pending submodule content requires separate review")
            if oid not in seen_blobs:
                inspect_blob(root, oid, decoded, "push", findings, skipped)
                seen_blobs.add(oid)
    return {"pending_commits_checked": len(commits), "pending_blobs_checked": len(seen_blobs)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("pre-commit", "pre-push"))
    args = parser.parse_args(argv)
    root = Path(__file__).resolve().parent.parent
    try:
        try:
            check.run_git(root, "rev-parse", "--verify", "HEAD")
            history = "all"
        except RuntimeError:
            history = "none"
        result = check.inspect(root, history=history, check_local_identity=True)
        if args.mode == "pre-commit":
            result["staged_files_checked"] = inspect_index(root, result["findings"], result["skipped"])
            check_proposed_identity(root, result["findings"])
        else:
            result.update(inspect_push(root, sys.stdin.read(), result["findings"], result["skipped"]))
        result["passed"] = not result["findings"] and not result["errors"]
    except (OSError, RuntimeError, ValueError) as exc:
        print(json.dumps({"passed": False, "hook": args.mode, "error": str(exc)}))
        return 2
    print(json.dumps(result, indent=2))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
