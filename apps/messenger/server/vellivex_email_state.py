# SPDX-License-Identifier: GPL-3.0-or-later
"""Persistent one-use email challenges for the isolated Messenger alpha."""

from contextlib import closing
from dataclasses import dataclass
import hashlib
import hmac
import os
from pathlib import Path
import re
import secrets
import sqlite3
import stat
import time

CODE_TTL = 600
RESEND_DELAY = 60
MAX_ATTEMPTS = 5
CHALLENGE_PATTERN = re.compile(r"[A-Za-z0-9_-]{43}\Z")
CODE_PATTERN = re.compile(r"[0-9]{8}\Z")
LOCAL_PATTERN = re.compile(r"[a-z0-9.!#$%&'*+/=?^_{}|~-]{1,64}\Z")
DOMAIN_PATTERN = re.compile(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\Z")


class InvalidEmail(Exception):
    pass


class RateLimited(Exception):
    pass


class AddressBudget:
    """Admission before SQLite, scoped to the single Synapse process."""

    def __init__(self, *, per_address=20, total=120, now=time.monotonic):
        self.per_address = per_address
        self.total = total
        self.now = now
        self.ends_at = 0
        self.count = 0
        self.address_counts = {}

    def admit(self, address: str) -> None:
        now = self.now()
        if now >= self.ends_at:
            self.ends_at = now + 60
            self.count = 0
            self.address_counts.clear()
        address_count = self.address_counts.get(address, 0)
        if self.count >= self.total or address_count >= self.per_address:
            raise RateLimited
        self.count += 1
        self.address_counts[address] = address_count + 1


def normalize_email(value: object) -> str:
    if not isinstance(value, str):
        raise InvalidEmail
    email = value.strip().lower()
    if len(email) > 254 or email.count("@") != 1:
        raise InvalidEmail
    local, domain = email.split("@")
    if (
        not LOCAL_PATTERN.fullmatch(local)
        or local.startswith(".")
        or local.endswith(".")
        or ".." in local
        or not DOMAIN_PATTERN.fullmatch(domain)
    ):
        raise InvalidEmail
    return email


@dataclass(frozen=True)
class Challenge:
    id: str
    code: str
    expires_at: int


class EmailState:
    def __init__(self, database: Path, otp_secret: bytes, identity_secret: bytes, *, ip_hour_limit=6, day_limit=50, now=time.time):
        self.database = database
        self.otp_secret = otp_secret
        self.identity_secret = identity_secret
        self.ip_hour_limit = ip_hour_limit
        self.day_limit = day_limit
        self.now = now
        database.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        parent = database.parent.lstat()
        if not stat.S_ISDIR(parent.st_mode) or parent.st_mode & 0o077 or parent.st_uid != os.geteuid():
            raise PermissionError("Messenger database needs a private directory owned by the process")
        fd = os.open(database, os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        try:
            metadata = os.fstat(fd)
            if (not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077
                    or metadata.st_uid != os.geteuid() or metadata.st_nlink != 1):
                raise PermissionError("Messenger database needs a private, regular file")
        finally:
            os.close(fd)
        for suffix in ("-wal", "-shm", "-journal"):
            sidecar = Path(str(database) + suffix)
            try:
                metadata = sidecar.lstat()
            except FileNotFoundError:
                continue
            if (not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077
                    or metadata.st_uid != os.geteuid() or metadata.st_nlink != 1):
                raise PermissionError("Messenger database sidecars must be private, regular files")
        with closing(self._connect()) as db, db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS challenges (
                    id TEXT PRIMARY KEY,
                    email_hash BLOB NOT NULL,
                    ip_hash BLOB NOT NULL,
                    localpart TEXT NOT NULL,
                    code_hash BLOB NOT NULL,
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL,
                    state TEXT NOT NULL,
                    attempts INTEGER NOT NULL DEFAULT 0
                );
                CREATE INDEX IF NOT EXISTS challenge_email ON challenges(email_hash, created_at);
                CREATE INDEX IF NOT EXISTS challenge_ip ON challenges(ip_hash, created_at);
                CREATE INDEX IF NOT EXISTS challenge_time ON challenges(created_at);
            """)

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.database, timeout=3)

    def _digest(self, purpose: str, value: bytes) -> bytes:
        return hmac.digest(self.otp_secret, purpose.encode("ascii") + b"\0" + value, hashlib.sha256)

    def localpart_for(self, email: str) -> str:
        identity = hmac.digest(self.identity_secret, b"matrix-localpart-v1\0" + email.encode("ascii"), hashlib.sha256)
        return "vx_" + identity.hex()[:32]

    def _code_digest(self, challenge: str, code: str) -> bytes:
        return self._digest("email-code-v1", f"{challenge}:{code}".encode("ascii"))

    def issue(self, email: str, client_address: str) -> Challenge:
        now = int(self.now())
        email_bytes = email.encode("ascii")
        email_hash = self._digest("email-address-v1", email_bytes)
        ip_hash = self._digest("request-address-v1", client_address.encode("utf-8"))
        challenge = Challenge(secrets.token_urlsafe(32), f"{secrets.randbelow(100_000_000):08}", now + CODE_TTL)
        with closing(self._connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM challenges WHERE created_at <= ?", (now - 86400,))
            email_count, last_request = db.execute(
                "SELECT count(*), max(created_at) FROM challenges WHERE email_hash = ? AND created_at > ?",
                (email_hash, now - 3600),
            ).fetchone()
            ip_count = db.execute(
                "SELECT count(*) FROM challenges WHERE ip_hash = ? AND created_at > ?",
                (ip_hash, now - 3600),
            ).fetchone()[0]
            total = db.execute("SELECT count(*) FROM challenges").fetchone()[0]
            if (
                email_count >= 3
                or (last_request is not None and last_request > now - RESEND_DELAY)
                or ip_count >= self.ip_hour_limit
                or total >= self.day_limit
            ):
                raise RateLimited
            db.execute(
                """INSERT INTO challenges
                (id, email_hash, ip_hash, localpart, code_hash, created_at, expires_at, state)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')""",
                (challenge.id, email_hash, ip_hash, self.localpart_for(email),
                 self._code_digest(challenge.id, challenge.code), now, challenge.expires_at),
            )
        return challenge

    def set_delivery(self, challenge: str, sent: bool) -> None:
        with closing(self._connect()) as db, db:
            db.execute(
                "UPDATE challenges SET state = ? WHERE id = ? AND state = 'pending'",
                ("ready" if sent else "retired", challenge),
            )

    def consume(self, challenge: object, code: object) -> str | None:
        if not isinstance(challenge, str) or not CHALLENGE_PATTERN.fullmatch(challenge):
            return None
        if not isinstance(code, str) or not CODE_PATTERN.fullmatch(code):
            return None
        with closing(self._connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT localpart, code_hash, expires_at, state, attempts FROM challenges WHERE id = ?",
                (challenge,),
            ).fetchone()
            if not row:
                return None
            localpart, code_hash, expires_at, state, attempts = row
            if state != "ready" or expires_at <= int(self.now()) or attempts >= MAX_ATTEMPTS:
                return None
            accepted = hmac.compare_digest(code_hash, self._code_digest(challenge, code))
            db.execute(
                "UPDATE challenges SET state = ?, attempts = attempts + 1 WHERE id = ?",
                ("used" if accepted else "ready", challenge),
            )
            if accepted:
                return localpart
            return None
