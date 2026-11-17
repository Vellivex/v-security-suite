# SPDX-License-Identifier: GPL-3.0-or-later
"""Synapse email-entry module. Matrix remains responsible for client/device sessions."""

from dataclasses import dataclass
from email.message import EmailMessage
import json
import logging
import os
from pathlib import Path
import secrets
import smtplib
import ssl
import stat
import threading
import time

from synapse.api.errors import Codes, SynapseError
from synapse.module_api import DirectServeJsonResource, ModuleApi
from synapse.module_api.errors import ConfigError
from twisted.internet.defer import DeferredSemaphore

from vellivex_email_state import (
    CODE_TTL, AddressBudget, CapacityExhausted, Challenge, EmailState, InvalidEmail, RateLimited,
    client_bucket, normalize_email, signup_limits,
)

TOKEN_LIFETIME_MS = 60_000
REQUEST_PATH = "/_synapse/client/vellivex/email/request"
VERIFY_PATH = "/_synapse/client/vellivex/email/verify"
logger = logging.getLogger(__name__)


class DevSpool:
    """A local mailbox for synthetic example.test requests exclusively."""

    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()
        self.path.mkdir(mode=0o700, parents=True, exist_ok=True)

    def send(self, email: str, challenge: Challenge) -> None:
        if not email.endswith("@example.test"):
            raise InvalidEmail
        with self.lock:
            expired = time.time() - CODE_TTL
            for previous in self.path.glob("*.json"):
                if previous.stat().st_mtime <= expired:
                    previous.unlink(missing_ok=True)
            if sum(1 for _ in self.path.glob("*.json")) >= 250:
                raise OSError("Dev mailbox limit reached")
            target = self.path / (challenge.id + ".json")
            temporary = target.with_suffix(".pending")
            fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as output:
                    json.dump({"code": challenge.code, "expires_at": challenge.expires_at}, output)
                os.replace(temporary, target)
            finally:
                temporary.unlink(missing_ok=True)


@dataclass
class SmtpMailer:
    host: str
    port: int
    sender: str
    username: str | None
    password: str | None

    def send(self, email: str, challenge: Challenge) -> None:
        message = EmailMessage()
        message["From"] = self.sender
        message["To"] = email
        message["Subject"] = "Your Vellivex Messenger sign-in code"
        message.set_content(
            f"Your Vellivex Messenger sign-in code is {challenge.code}.\n"
            f"It expires in {CODE_TTL // 60} minutes. Keep it private.\n"
            "If you did not request this code, you can ignore this message.\n"
        )
        with smtplib.SMTP_SSL(
            self.host, self.port, timeout=10, context=ssl.create_default_context()
        ) as connection:
            if self.username is not None:
                connection.login(self.username, self.password)
            connection.send_message(message, from_addr=self.sender, to_addrs=[email])


def require_fields(request, fields: set[str]) -> dict:
    request.setHeader(b"Cache-Control", b"no-store")
    if request.args or (request.getHeader("Content-Type") or "").split(";")[0].strip().lower() != "application/json":
        raise SynapseError(400, "Send an application/json request.", Codes.INVALID_PARAM)
    raw = request.content.read(4097)
    if len(raw) > 4096:
        raise SynapseError(413, "The request is too large.", Codes.TOO_LARGE)
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeError, RecursionError):
        raise SynapseError(400, "The request is invalid.", Codes.BAD_JSON) from None
    if not isinstance(value, dict) or set(value) != fields:
        raise SynapseError(400, "The request is invalid.", Codes.INVALID_PARAM)
    return value


def admit(request, budget: AddressBudget) -> str:
    address = client_bucket(getattr(request.getClientAddress(), "host", None))
    try:
        budget.admit(address)
    except RateLimited:
        request.setHeader(b"Cache-Control", b"no-store")
        raise SynapseError(429, "Try again later.", Codes.LIMIT_EXCEEDED) from None
    return address


class RequestCode(DirectServeJsonResource):
    def __init__(self, module):
        super().__init__()
        self.module = module

    async def _async_render_POST(self, request):
        body = require_fields(request, {"email"})
        try:
            email = normalize_email(body["email"])
            if self.module.dev and not email.endswith("@example.test"):
                raise InvalidEmail
        except InvalidEmail:
            raise SynapseError(400, "Enter a valid email address.", Codes.INVALID_PARAM) from None

        address = admit(request, self.module.requests)
        if self.module.invited_emails is not None and email not in self.module.invited_emails:
            # Keep the response shape consistent without touching SQL or SMTP.
            return 200, {"challenge_id": secrets.token_urlsafe(32)}
        run = self.module.api.defer_to_thread
        try:
            challenge = await run(self.module.state.issue, email, address)
        except CapacityExhausted as error:
            if self.module.invited_emails is not None or self.module.dev:
                raise SynapseError(429, "Try again later.", Codes.LIMIT_EXCEEDED) from None
            request.setHeader(b"Retry-After", str(error.retry_after).encode("ascii"))
            return 429, {
                "errcode": Codes.LIMIT_EXCEEDED,
                "error": "Messenger has reached its sign-in code limit. Try again later.",
                "retry_after_ms": error.retry_after * 1000,
                "vellivex_capacity_exhausted": True,
            }
        except RateLimited:
            raise SynapseError(429, "Try again later.", Codes.LIMIT_EXCEEDED) from None
        await self.module.mail_slots.acquire()
        try:
            await run(self.module.mailer.send, email, challenge)
        except Exception as error:
            await run(self.module.state.set_delivery, challenge.id, False)
            logger.warning("Vellivex code transport failed (%s)", type(error).__name__)
            raise SynapseError(503, "The code could not be delivered.") from None
        finally:
            self.module.mail_slots.release()
        await run(self.module.state.set_delivery, challenge.id, True)
        return 200, {"challenge_id": challenge.id}


class VerifyCode(DirectServeJsonResource):
    def __init__(self, module):
        super().__init__()
        self.module = module

    async def _async_render_POST(self, request):
        admit(request, self.module.verifications)
        values = require_fields(request, {"challenge_id", "code"})
        api = self.module.api
        localpart = await api.defer_to_thread(
            self.module.state.consume, values["challenge_id"], values["code"]
        )
        invited = self.module.invited_localparts
        if localpart is None or (invited is not None and localpart not in invited):
            raise SynapseError(403, "The code could not be verified. Request a fresh code.", Codes.FORBIDDEN)
        user_id = api.get_qualified_user_id(localpart)
        if not await api.check_user_exists(user_id):
            try:
                await api.register_user(localpart)
            except SynapseError as error:
                if error.errcode != Codes.USER_IN_USE or not await api.check_user_exists(user_id):
                    raise
        token = await api.create_login_token(user_id, duration_in_ms=TOKEN_LIFETIME_MS)
        return 200, {"login_token": token, "expires_in_ms": TOKEN_LIFETIME_MS}


def private_text(path: str) -> str:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "r", encoding="utf-8") as file:
        metadata = os.fstat(file.fileno())
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077
                or metadata.st_uid != os.geteuid() or metadata.st_nlink != 1):
            raise ConfigError("Messenger secret file must be private and regular")
        return file.read().strip()


def bounded_int(config, name, default, high):
    value = config.get(name, default)
    if type(value) is not int or not 1 <= value <= high:
        raise ConfigError(f"Messenger {name} must be between 1 and {high}")
    return value


class EmailCodeModule:
    @staticmethod
    def parse_config(config: dict) -> dict:
        mode = config.get("mode")
        if mode not in {"dev", "smtp"}:
            raise ConfigError("Messenger auth mode must be explicitly dev or smtp")
        try:
            signup_mode, limits = signup_limits(config, development=mode == "dev")
        except ValueError as error:
            raise ConfigError(str(error)) from None
        try:
            otp_secret = bytes.fromhex(private_text(config["otp_secret_file"]))
            identity_secret = bytes.fromhex(private_text(config["identity_secret_file"]))
            database = Path(config["database"])
            if len(otp_secret) != 32 or len(identity_secret) != 32 or otp_secret == identity_secret:
                raise ConfigError("Messenger needs distinct private 32-byte OTP and identity secrets")
            if mode == "dev":
                mailer = DevSpool(Path(config["mailbox"]))
                invited = None
            else:
                if "mailbox" in config:
                    raise ConfigError("Messenger SMTP configuration must not include a dev mailbox")
                invited = None
                if signup_mode == "invite":
                    invited = frozenset(normalize_email(line) for line in
                                        private_text(config["invited_emails_file"]).splitlines() if line.strip())
                    if not invited:
                        raise ConfigError("Messenger SMTP invite mode requires at least one invited address")
                username = config.get("smtp_username")
                password_path = config.get("smtp_password_file")
                if bool(username) != bool(password_path):
                    raise ConfigError("Messenger SMTP username and password file are paired")
                password = private_text(password_path) if password_path else None
                mailer = SmtpMailer(
                    config["smtp_host"], bounded_int(config, "smtp_port", 465, 65535),
                    normalize_email(config["smtp_sender"]), username, password,
                )
        except (KeyError, ValueError, OSError, InvalidEmail) as error:
            raise ConfigError("Messenger email configuration or current key file is invalid") from error
        return {
            "dev": mode == "dev",
            "mailer": mailer,
            "invited_emails": invited,
            "state": EmailState(database, otp_secret, identity_secret, **limits),
        }

    def __init__(self, config: dict, api: ModuleApi):
        self.api = api
        self.dev = config["dev"]
        self.mailer = config["mailer"]
        self.state = config["state"]
        self.invited_emails = config["invited_emails"]
        self.invited_localparts = (None if self.invited_emails is None else
                                   frozenset(self.state.localpart_for(email) for email in self.invited_emails))
        self.requests = AddressBudget(per_address=6, total=24)
        self.verifications = AddressBudget()
        self.mail_slots = DeferredSemaphore(2)
        api.register_web_resource(REQUEST_PATH, RequestCode(self))
        api.register_web_resource(VERIFY_PATH, VerifyCode(self))
        api.looping_background_call(api.defer_to_thread, 60_000, self.state.prune, desc="vellivex_email_expiry")
