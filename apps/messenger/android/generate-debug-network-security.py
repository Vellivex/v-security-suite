#!/usr/bin/env python3
"""Keep the pinned verifier's CRL policy and add the existing debug-only hosts."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET
from zipfile import ZipFile


RESOURCE = "res/xml/network_security_config.xml"
LOOPBACK_HOSTS = ("localhost", "127.0.0.1", "10.0.2.2")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def pinned_sha256(pins: dict, name: str) -> str:
    value = pins.get(name)
    require(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None,
            f"Missing or invalid SHA-256 pin: {name}")
    return value


def generate(aar: Path, pins_path: Path, output_dir: Path) -> Path:
    pins = json.loads(pins_path.read_text(encoding="utf-8"))
    expected_aar = pinned_sha256(pins, "android_support_aar_sha256")
    expected_policy = pinned_sha256(pins, "android_support_network_security_sha256")
    require(hashlib.sha256(aar.read_bytes()).hexdigest() == expected_aar,
            "Android verifier AAR does not match its reviewed SHA-256 pin")

    with ZipFile(aar) as archive:
        require(archive.namelist().count(RESOURCE) == 1,
                "Android verifier AAR must contain exactly one network policy")
        policy = archive.read(RESOURCE)
    require(hashlib.sha256(policy).hexdigest() == expected_policy,
            "Android verifier network policy does not match its reviewed SHA-256 pin")

    root = ET.fromstring(policy)
    require(root.tag == "network-security-config" and not root.attrib,
            "Unexpected Android verifier network policy root")
    require([child.tag for child in root] == ["base-config", "domain-config"],
            "Unexpected Android verifier network policy structure")
    base, revocation = root
    require(base.attrib == {"cleartextTrafficPermitted": "false"} and len(base) == 0,
            "Android verifier must deny cleartext traffic by default")
    require(revocation.attrib == {"cleartextTrafficPermitted": "true"} and len(revocation) > 0,
            "Android verifier must retain its reviewed revocation-host policy")
    require(all(domain.tag == "domain" and len(domain) == 0 and
                domain.attrib == {"includeSubdomains": "true"} and
                (domain.text or "").strip() and
                (domain.text or "").strip() not in LOOPBACK_HOSTS
                for domain in revocation),
            "Unexpected Android verifier revocation-host entry")

    # Keep every pinned upstream exception. Only debug builds receive this
    # generated resource; release uses the original resource inside the AAR.
    loopback = ET.SubElement(root, "domain-config", {"cleartextTrafficPermitted": "true"})
    for host in LOOPBACK_HOSTS:
        ET.SubElement(loopback, "domain", {"includeSubdomains": "false"}).text = host

    ET.indent(root, space="    ")
    destination = output_dir / "xml" / "debug_network_security.xml"
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".xml.tmp")
    ET.ElementTree(root).write(temporary, encoding="utf-8", xml_declaration=True)
    temporary.replace(destination)
    return destination


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--aar", type=Path, required=True)
    parser.add_argument("--pins", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    try:
        destination = generate(args.aar, args.pins, args.output_dir)
    except (OSError, ValueError, KeyError, ET.ParseError) as error:
        parser.exit(1, f"Cannot generate debug network policy: {error}\n")
    print(f"Generated {destination}")


if __name__ == "__main__":
    main()
