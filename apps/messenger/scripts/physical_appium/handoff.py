"""One-run, memory-only confidential input for the two enrolled Messenger QA phones."""
import base64
import hashlib
import json
import os
import re
import secrets
import tempfile
import threading
import time
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


REPOSITORY = "Vellivex/v-security-suite"
SUITE = "vellivex-live-two-app"
INPUT_BRANCH = "test/messenger-live-inputs"
APK_SHA256 = "95661c6ea7f8b5d40e9fd6ba6797a5a2f6b276f681369420b4e55348784579e4"
ROLES = ("A", "B")
BOUND_FIELDS = ("run_id", "run_attempt", "head_sha", "session_id", "key_id")
META_FIELDS = ("role", "purpose", "nonce", "issued_at", "expires_at")
ENVELOPE_FIELDS = {"schema", *BOUND_FIELDS, "metadata", "encrypted_key", "iv", "ciphertext", "tag"}


class HandoffError(ValueError):
    """May be surfaced in sanitized logs. Never includes user-supplied values."""


class PrivatePair(dict):
    """Treat as ephemeral private data. Representation is safe in incidental diagnostics."""
    def __repr__(self):
        return "<private two-phone input>"

    __str__ = __repr__


def _require(condition):
    if not condition:
        raise HandoffError("Private two-phone input was rejected")


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _hex(value, length):
    return isinstance(value, str) and re.fullmatch(f"[0-9a-f]{{{length}}}", value) is not None


def _canonical(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode("ascii")


def _decode(value, byte_length=None):
    _require(isinstance(value, str) and len(value) <= 8192)
    result = base64.b64decode(value, validate=True)
    _require(base64.b64encode(result).decode("ascii") == value)
    if byte_length is not None:
        _require(len(result) == byte_length)
    return result


class PrivateHandoff:
    """One instance per run. Only the three explicitly named public artifacts are written."""
    def __init__(self, private_dir, artifacts_dir, run_id, attempt, head_sha):
        _require(isinstance(run_id, str) and re.fullmatch(r"[0-9]{1,20}", run_id))
        _require(type(attempt) is int and 1 <= attempt <= 2**53 - 1 and _hex(head_sha, 40))
        self.private_dir = Path(private_dir).resolve()
        self.artifacts_dir = Path(artifacts_dir).resolve()
        _require(self.private_dir != self.artifacts_dir)
        _require(self.private_dir not in self.artifacts_dir.parents and self.artifacts_dir not in self.private_dir.parents)
        self.private_dir.mkdir(mode=0o700, exist_ok=True, parents=True)
        self.artifacts_dir.mkdir(mode=0o700, exist_ok=True, parents=True)
        self._email_digests = {r: os.environ.get("VELLIVEX_QA_EMAIL_SHA256_" + r) for r in ROLES}
        _require(all(_hex(digest, 64) for digest in self._email_digests.values()))
        _require(self._email_digests["A"] != self._email_digests["B"])
        self._run = (run_id, attempt, head_sha)
        self._key = None
        self._descriptor = None
        self._pair_bound = False
        self._roles_bound = False
        self._ready = None
        self._used_nonces = set()
        self._codes_consumed = False
        self._lock = threading.RLock()

    def _artifact(self, name, value):
        # link is atomic and fails if an older artifact exists (even a symlink).
        with tempfile.NamedTemporaryFile(dir=self.artifacts_dir, delete=False) as fp:
            temp = Path(fp.name)
            try:
                fp.write(json.dumps(value, indent=2).encode("utf-8") + b"\n")
                fp.flush()
                os.fsync(fp.fileno())
                os.link(temp, self.artifacts_dir / name)
            finally:
                temp.unlink(missing_ok=True)

    def prepare(self):
        with self._lock:
            _require(self._descriptor is None)
            key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
            pub = key.public_key()
            now = int(time.time())
            d = {"schema": 1, "suite": SUITE, "repository": REPOSITORY,
                 "run_id": self._run[0], "run_attempt": self._run[1], "head_sha": self._run[2],
                 "session_id": secrets.token_hex(12), "created_at": now, "expires_at": now + 3600,
                 "input_branch": INPUT_BRANCH,
                 "key_id": _sha(pub.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)),
                 "public_key": pub.public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode("ascii")}
            self._artifact("public-key.json", d)
            self._key, self._descriptor = key, d
            return d.copy()

    def bind_physical(self, driver_sha256, privacy_preflight_sha256, session_ids_by_role):
        with self._lock:
            d = self._descriptor
            _require(d and self._key and not self._pair_bound and int(time.time()) < d["expires_at"])
            _require(_hex(driver_sha256, 64) and _hex(privacy_preflight_sha256, 64))
            _require(type(session_ids_by_role) is dict and set(session_ids_by_role) == set(ROLES))
            ids = [session_ids_by_role[r] for r in ROLES]
            _require(all(isinstance(v, str) and 8 <= len(v) <= 256 and v.isascii() for v in ids))
            _require(ids[0] != ids[1])
            identity = {"kind": "browserstack-paired-appium", "run_id": d["run_id"], "run_attempt": d["run_attempt"],
                        "session_id": d["session_id"], "reviewed_commit": d["head_sha"], "runner_key_sha256": d["key_id"],
                        "apk_sha256": APK_SHA256, "driver_sha256": driver_sha256, "privacy_preflight_sha256": privacy_preflight_sha256,
                        "sessions": [_sha(s.encode("ascii")) for s in ids]}
            self._artifact("physical-attestation.json", identity)
            self._pair_bound = True
            return identity.copy()

    def publish_ready(self, request_started_at_by_role):
        with self._lock:
            d = self._descriptor
            now = int(time.time())
            _require(self._roles_bound and self._ready is None and self._key and now < d["expires_at"])
            _require(type(request_started_at_by_role) is dict and set(request_started_at_by_role) == set(ROLES))
            starts = {r: request_started_at_by_role[r] for r in ROLES}
            _require(all(type(v) is int and d["created_at"] - 30 <= v <= now + 30 for v in starts.values()))
            deadline = min(starts.values()) + 600
            _require(now < deadline)
            ready = {k: d[k] for k in ("schema", "suite", "repository", *BOUND_FIELDS)}
            ready.update({"code_screens_ready": list(ROLES), "request_started_at": starts,
                          "conservative_code_deadline": deadline, "private_values_included": False})
            self._artifact("code-handoff.json", ready)
            self._ready = ready
            return json.loads(json.dumps(ready))

    def _open(self, envelope, role, purpose, now):
        d = self._descriptor
        _require(type(envelope) is dict and set(envelope) == ENVELOPE_FIELDS)
        _require(type(envelope["schema"]) is int and envelope["schema"] == 1)
        _require(type(envelope["run_attempt"]) is int)
        _require(all(envelope[k] == d[k] for k in BOUND_FIELDS))
        m = envelope["metadata"]
        _require(type(m) is dict and set(m) == set(META_FIELDS))
        _require(m["role"] == role and m["purpose"] == purpose and _hex(m["nonce"], 32))
        issued, expires = m["issued_at"], m["expires_at"]
        _require(type(issued) is int and type(expires) is int and d["created_at"] - 30 <= issued <= now + 30)
        _require(issued < expires <= d["expires_at"] and now < expires)
        _require(expires - issued <= (300 if purpose == "code" else 1200))
        if purpose == "code":
            _require(issued >= self._ready["request_started_at"][role] - 2)
            _require(now < self._ready["conservative_code_deadline"])
        _require(m["nonce"] not in self._used_nonces)
        aad = {"schema": 1, "suite": SUITE, "repository": REPOSITORY}
        aad.update({k: d[k] for k in BOUND_FIELDS})
        aad.update({k: m[k] for k in META_FIELDS})
        ciphertext = _decode(envelope["ciphertext"])
        _require(0 < len(ciphertext) <= 4096)
        secret = self._key.decrypt(_decode(envelope["encrypted_key"], 384),
                                   padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(),
                                                label=b"vellivex-live-input-v1"))
        _require(len(secret) == 32)
        plain = AESGCM(secret).decrypt(_decode(envelope["iv"], 12), ciphertext + _decode(envelope["tag"], 16), _canonical(aad))
        payload = json.loads(plain)
        _require(type(payload) is dict and set(payload) == {purpose} and isinstance(payload[purpose], str))
        value = payload[purpose]
        if purpose == "code":
            _require(re.fullmatch(r"[0-9]{8}", value))
        else:
            _require(value.isascii() and len(value) <= 254)
            _require(_sha(value.encode("ascii")) == self._email_digests[role])
        return m["nonce"], value

    def _read(self, envelopes, purpose):
        try:
            now = int(time.time())
            _require(self._pair_bound and self._key and now < self._descriptor["expires_at"])
            _require(type(envelopes) is dict and set(envelopes) == set(ROLES))
            if purpose == "email":
                _require(not self._roles_bound and self._ready is None)
            else:
                _require(self._roles_bound and self._ready and not self._codes_consumed)
            opened = [self._open(envelopes[r], r, purpose, now) for r in ROLES]
            _require(opened[0][0] != opened[1][0])
            values = PrivatePair({r: v[1] for r, v in zip(ROLES, opened)})
            self._used_nonces.update(v[0] for v in opened)
            if purpose == "code":
                self._codes_consumed = True
            else:
                self._roles_bound = True
            return values
        except Exception:
            raise HandoffError("Private two-phone input was rejected") from None

    def read_emails(self, envelopes_by_role):
        with self._lock:
            return self._read(envelopes_by_role, "email")

    def read_pair(self, envelopes_by_role):
        with self._lock:
            return self._read(envelopes_by_role, "code")

    def close(self):
        with self._lock:
            self._key = None
            self._used_nonces.clear()
