# SPDX-License-Identifier: GPL-3.0-or-later
"""Persistent one-use email challenges for the isolated Messenger alpha."""

from contextlib import closing
from dataclasses import dataclass
import hashlib
import hmac
from ipaddress import IPv6Address, ip_address, ip_network
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
HOUR_SECONDS = 60 * 60
DAY_SECONDS = 24 * HOUR_SECONDS
MONTH_SECONDS = 31 * DAY_SECONDS
CHALLENGE_PATTERN = re.compile(r"[A-Za-z0-9_-]{43}\Z")
CODE_PATTERN = re.compile(r"[0-9]{8}\Z")
LOCAL_PATTERN = re.compile(r"[a-z0-9.!#$%&'*+/=?^_{}|~-]{1,64}\Z")
DOMAIN_PATTERN = re.compile(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\Z")


class InvalidEmail(Exception):
    pass


class RateLimited(Exception):
    def __init__(self, retry_after: int = RESEND_DELAY):
        super().__init__()
        self.retry_after = retry_after


class CapacityExhausted(RateLimited):
    pass


def signup_limits(config: dict, *, development=False) -> tuple[str, dict]:
    mode = config.get("signup_mode", "invite")
    if mode not in ("invite", "public") or (development and mode != "invite"):
        raise ValueError("Public email signup is available only with explicitly configured SMTP mode")
    public = mode == "public"
    bounds = {
        "day_limit": (5, 80) if public else (50, 200 if development else 100),
        "month_limit": (2400 if public else None, 2400),
        "ip_hour_limit": (4, 6) if public else (6, 200 if development else 40),
        "email_hour_limit": (2 if public else 3, 3),
    }
    limits = {}
    for name, (default, maximum) in bounds.items():
        value = config.get(name, default)
        if (name not in config and value is None) or (type(value) is int and 1 <= value <= maximum):
            limits[name] = value
        else:
            raise ValueError(f"Messenger {name} must be between 1 and {maximum}")
    return mode, limits


def client_bucket(value: object) -> str:
    try:
        address = ip_address(value) if isinstance(value, str) and "%" not in value else None
    except ValueError:
        address = None
    if isinstance(address, IPv6Address):
        if address.ipv4_mapped:
            return str(address.ipv4_mapped)
        return str(ip_network((address, 64), strict=False))
    return str(address) if address is not None else "unknown"


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
    def __init__(self, database: Path, otp_secret: bytes, identity_secret: bytes, *,
                 ip_hour_limit=6, email_hour_limit=3, day_limit=50, month_limit=None, now=time.time):
        self.database = database
        self.otp_secret = otp_secret
        self.identity_secret = identity_secret
        self.ip_hour_limit = ip_hour_limit
        self.email_hour_limit = email_hour_limit
        self.day_limit = day_limit
        self.month_limit = month_limit
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
            db.execute("BEGIN IMMEDIATE")
            if not db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mail_attempts'").fetchone():
                db.execute("CREATE TABLE mail_attempts (created_at INTEGER NOT NULL)")
                db.execute("CREATE INDEX mail_attempt_times ON mail_attempts(created_at)")
                # Account for still-present requests on upgrade without copying address or challenge data.
                db.execute("INSERT INTO mail_attempts SELECT created_at FROM challenges WHERE created_at > ?",
                           (int(self.now()) - MONTH_SECONDS,))
            self._prune(db, int(self.now()))

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.database, timeout=3)

    def _digest(self, purpose: str, value: bytes) -> bytes:
        return hmac.digest(self.otp_secret, purpose.encode("ascii") + b"\0" + value, hashlib.sha256)

    def localpart_for(self, email: str) -> str:
        identity = hmac.digest(self.identity_secret, b"matrix-localpart-v1\0" + email.encode("ascii"), hashlib.sha256)
        return "vx_" + identity.hex()[:32]

    def _code_digest(self, challenge: str, code: str) -> bytes:
        return self._digest("email-code-v1", f"{challenge}:{code}".encode("ascii"))

    @staticmethod
    def _prune(db, now: int) -> None:
        db.execute("DELETE FROM challenges WHERE created_at <= ?", (now - DAY_SECONDS,))
        db.execute("DELETE FROM mail_attempts WHERE created_at <= ?", (now - MONTH_SECONDS,))

    def prune(self) -> None:
        with closing(self._connect()) as db, db:
            self._prune(db, int(self.now()))

    @staticmethod
    def _capacity_wait(db, now: int, period: int, limit: int) -> int:
        cutoff = now - period
        count = db.execute("SELECT count(*) FROM mail_attempts WHERE created_at > ?", (cutoff,)).fetchone()[0]
        if count < limit:
            return 0
        next_expiry = db.execute(
            "SELECT created_at FROM mail_attempts WHERE created_at > ? ORDER BY created_at LIMIT 1 OFFSET ?",
            (cutoff, count - limit),
        ).fetchone()[0]
        return next_expiry + period - now

    def issue(self, email: str, client_address: str) -> Challenge:
        now = int(self.now())
        email_bytes = email.encode("ascii")
        email_hash = self._digest("email-address-v1", email_bytes)
        ip_hash = self._digest("request-address-v1", client_address.encode("utf-8"))
        challenge = Challenge(secrets.token_urlsafe(32), f"{secrets.randbelow(100_000_000):08}", now + CODE_TTL)
        with closing(self._connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            self._prune(db, now)
            retry_after = self._capacity_wait(db, now, DAY_SECONDS, self.day_limit)
            if self.month_limit is not None:
                retry_after = max(retry_after, self._capacity_wait(db, now, MONTH_SECONDS, self.month_limit))
            if retry_after:
                db.commit()
                raise CapacityExhausted(retry_after)
            email_count, last_request, caller_count, last_caller_request = db.execute(
                """SELECT count(*), max(created_at), count(*) FILTER (WHERE ip_hash = ?),
                          max(created_at) FILTER (WHERE ip_hash = ?)
                   FROM challenges WHERE email_hash = ? AND created_at > ?""",
                (ip_hash, ip_hash, email_hash, now - HOUR_SECONDS),
            ).fetchone()
            ip_count = db.execute(
                "SELECT count(*) FROM challenges WHERE ip_hash = ? AND created_at > ?",
                (ip_hash, now - HOUR_SECONDS),
            ).fetchone()[0]
            if (
                email_count >= self.email_hour_limit
                or (last_request is not None and last_request > now - RESEND_DELAY)
                or ip_count >= self.ip_hour_limit
            ):
                db.commit()
                # Recommend a short retry only for a recent request from this
                # same network and email. Ignore activity on other networks
                # when choosing the hint; never expose their request times.
                recent_resend = last_caller_request is not None and last_caller_request > now - RESEND_DELAY
                if recent_resend and caller_count < self.email_hour_limit and ip_count < self.ip_hour_limit:
                    raise RateLimited(RESEND_DELAY)
                raise RateLimited(HOUR_SECONDS)
            db.execute(
                """INSERT INTO challenges
                (id, email_hash, ip_hash, localpart, code_hash, created_at, expires_at, state)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')""",
                (challenge.id, email_hash, ip_hash, self.localpart_for(email),
                 self._code_digest(challenge.id, challenge.code), now, challenge.expires_at),
            )
            db.execute("INSERT INTO mail_attempts VALUES (?)", (now,))
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
