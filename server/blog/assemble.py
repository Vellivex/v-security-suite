"""Build a version-specific Cloudflare connector operation from reviewed source files."""

import argparse
import base64
import hashlib
import json
from pathlib import Path
from uuid import UUID


HERE = Path(__file__).resolve().parent
BASE_VERSION = "7144a063-dc68-4816-8ae3-a3736c503a40"
RENDERER = "blog-publisher.mjs"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("test", "stage", "verify", "deploy", "rollback"))
    parser.add_argument("--database", type=UUID, required=True, help="Dedicated blog D1 UUID")
    parser.add_argument("--base-deployment", type=UUID, required=True, help="Original v54 deployment ID")
    parser.add_argument("--staged", type=UUID, help="Photo-enabled Worker version ID")
    parser.add_argument("--deployed", type=UUID, help="Photo-enabled traffic deployment ID")
    args = parser.parse_args()
    if args.action in ("verify", "deploy", "rollback") and args.staged is None:
        parser.error("--staged is required for this operation")
    if args.action == "rollback" and args.deployed is None:
        parser.error("--deployed is required for rollback")

    baseline = json.loads((HERE / "base-inventory.json").read_text())
    proposed = [item for item in baseline if item["name"] != RENDERER]
    renderer = (HERE / RENDERER).read_bytes()
    proposed.append({
        "name": RENDERER,
        "type": "application/javascript+module",
        "size": len(renderer),
        "sha256": hashlib.sha256(renderer).hexdigest(),
    })

    configuration = {
        "action": args.action,
        "baseVersion": BASE_VERSION,
        "baseDeployment": str(args.base_deployment),
        "database": str(args.database),
        "baseline": baseline,
        "proposed": sorted(proposed, key=lambda item: item["name"]),
        "staged": str(args.staged) if args.staged else None,
        "deployed": str(args.deployed) if args.deployed else None,
    }
    if args.action in ("stage", "test"):
        configuration["renderer"] = base64.b64encode(renderer).decode("ascii")

    template = (HERE / "worker-version-template.js").read_text()
    placeholder = "__BLOG_RELEASE_CONFIGURATION__"
    if template.count(placeholder) != 1:
        raise ValueError("Expected a single configuration placeholder in the Worker operation")
    print(template.replace(placeholder, json.dumps(configuration, separators=(",", ":"))), end="")


if __name__ == "__main__":
    main()
