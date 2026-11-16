# SPDX-License-Identifier: GPL-3.0-or-later
"""Manage an isolated Vellivex Messenger private beta on its owner’s Linux host."""

import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import secrets
import shutil
import stat
import subprocess
import sys
import tarfile
from tempfile import TemporaryDirectory

BUNDLE = Path(__file__).resolve().parent
sys.path.insert(0, str(BUNDLE.parent))

from vellivex_email_state import InvalidEmail, normalize_email

OWNER_EMAIL = "v@vellivex.com"
STABLE_FILES = ("identity-secret", "synapse-signing.key", "macaroon-secret", "invited-emails")
HOSTNAME = re.compile(r"(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\Z")
FORMAT = 1


def private_read(path: Path) -> str:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "r", encoding="utf-8") as handle:
        check_private(os.fstat(handle.fileno()), stat.S_ISREG, path)
        return handle.read().strip()


def check_private(info, is_kind, path):
    if not is_kind(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.geteuid():
        raise ValueError(f"Expected a private path owned by this user: {path}")


def atomic_write(path: Path, content: str) -> None:
    temporary = path.with_name("." + path.name + "." + secrets.token_hex(8))
    try:
        fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def write_config(path: Path, config: dict) -> None:
    # JSON is a subset of YAML and keeps generated secrets safely quoted.
    atomic_write(path, json.dumps(config, indent=2) + "\n")


def private_directory(path: Path) -> None:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    check_private(path.lstat(), stat.S_ISDIR, path)


def project_name(paths: Path) -> str:
    return "vellivex-messenger-" + hashlib.sha256(os.fsencode(paths)).hexdigest()[:10]


def parse_addresses(values: list[str]) -> set[str]:
    try:
        return {normalize_email(address) for address in values}
    except InvalidEmail:
        raise ValueError("Every invited address must be a valid email address") from None


def config_for(domain: str, postgres_password: str, smtp_host: str, smtp_sender: str,
               smtp_username: str, smtp_port: int, macaroon_secret: str) -> dict:
    return {
        "server_name": domain,
        "public_baseurl": f"https://{domain}/",
        "report_stats": False,
        "signing_key_path": "/data/synapse-signing.key",
        "macaroon_secret_key": macaroon_secret,
        "media_store_path": "/data/media",
        "max_upload_size": "5M",
        "log_config": "/data/logging.yaml",
        "database": {
            "name": "psycopg2",
            "args": {"database": "messenger", "user": "messenger", "password": postgres_password,
                     "host": "database", "cp_min": 2, "cp_max": 5},
        },
        "listeners": [{
            "port": 8008,
            "type": "http",
            "tls": False,
            "bind_addresses": ["0.0.0.0"],
            "x_forwarded": True,
            "resources": [{"names": ["client"], "compress": False}],
        }],
        "enable_registration": False,
        "allow_guest_access": False,
        "password_config": {"enabled": False},
        "federation_domain_whitelist": [],
        "trusted_key_servers": [],
        "allow_public_rooms_without_auth": False,
        "encryption_enabled_by_default_for_room_type": "all",
        "modules": [{
            "module": "vellivex_email_auth.EmailCodeModule",
            "config": {
                "mode": "smtp",
                "database": "/data/email.sqlite",
                "otp_secret_file": "/data/otp-secret",
                "identity_secret_file": "/data/identity-secret",
                "invited_emails_file": "/data/invited-emails",
                "smtp_host": smtp_host,
                "smtp_port": smtp_port,
                "smtp_sender": smtp_sender,
                "smtp_username": smtp_username,
                "smtp_password_file": "/data/smtp-password",
            },
        }],
    }


def proxy_config(domain: str, mode: str) -> str:
    if mode == "tunnel":
        address = "http://" + domain
        guard = ["        @unknownEdge not header CF-Connecting-IP *",
                 '        respond @unknownEdge "Forbidden" 403']
        client_ip = "{http.request.header.CF-Connecting-IP}"
    else:
        address = domain
        guard = []
        client_ip = "{http.request.remote.host}"
    return "\n".join([
        "{", "    admin off", "    email " + OWNER_EMAIL, "}", "",
        address + " {",
        '    header Strict-Transport-Security "max-age=31536000"',
        "    @matrix path /_matrix/client/* /_matrix/media/* /_synapse/client/vellivex/email/request /_synapse/client/vellivex/email/verify",
        "    handle @matrix {",
        *guard,
        "        reverse_proxy synapse:8008 {",
        "            header_up X-Forwarded-For " + client_ip,
        "            header_up X-Forwarded-Proto https",
        "            header_up -Forwarded",
        "        }", "    }",
        '    respond "Not found" 404', "}", "",
    ])


def logging_config() -> dict:
    return {
        "version": 1,
        "disable_existing_loggers": False,
        "formatters": {"standard": {"format": "%(levelname)s %(name)s %(message)s"}},
        "handlers": {"console": {"class": "logging.StreamHandler", "formatter": "standard"}},
        "loggers": {"synapse.access.http": {"level": "WARNING"}},
        "root": {"level": "WARNING", "handlers": ["console"]},
    }


def initialize(state: Path, options) -> None:
    if os.getuid() == 0:
        raise ValueError("Use an unprivileged deployment owner with Docker access")
    domain = options.domain.lower()
    if not HOSTNAME.fullmatch(domain):
        raise ValueError("Provide a dedicated fully qualified domain")
    if not HOSTNAME.fullmatch(options.smtp_host.lower()) or not 1 <= options.smtp_port <= 65535:
        raise ValueError("Provide a valid SMTPS hostname and port")
    smtp_password = private_read(options.smtp_password_file)
    if not smtp_password or "\n" in smtp_password or "\r" in smtp_password or not options.smtp_username:
        raise ValueError("Provide authenticated SMTP credentials in a private password file")
    smtp_sender = next(iter(parse_addresses([options.smtp_sender])))
    private_directory(state)
    if any(state.iterdir()):
        raise ValueError("Initialization requires an empty state directory")
    data = state / "synapse"
    private_directory(data)
    private_directory(data / "media")
    postgres_password = secrets.token_hex(32)
    macaroon_secret = secrets.token_hex(32)
    for filename, contents in {
        "otp-secret": secrets.token_hex(32),
        "identity-secret": secrets.token_hex(32),
        "macaroon-secret": macaroon_secret,
        "smtp-password": smtp_password,
        "invited-emails": OWNER_EMAIL,
    }.items():
        atomic_write(data / filename, contents + "\n")
    atomic_write(state / "postgres-password", secrets.token_hex(32) + "\n")
    atomic_write(state / "postgres-app-password", postgres_password + "\n")
    write_config(data / "homeserver.yaml", config_for(
        domain, postgres_password, options.smtp_host, smtp_sender, options.smtp_username,
        options.smtp_port, macaroon_secret,
    ))
    write_config(data / "logging.yaml", logging_config())
    atomic_write(state / "Caddyfile", proxy_config(domain, options.mode))
    write_config(state / "deployment.json", {"format": FORMAT, "domain": domain, "mode": options.mode,
                                             "uid": os.getuid(), "gid": os.getgid(),
                                             "project": project_name(state)})
    print(f"Initialized private beta configuration for {domain} in {state}")


class Stack:
    def __init__(self, state: Path):
        private_directory(state)
        self.state = state
        self.meta = json.loads(private_read(state / "deployment.json"))
        if (self.meta.get("format") != FORMAT or self.meta.get("project") != project_name(state)
                or self.meta.get("mode") not in ("direct", "tunnel")
                or self.meta.get("uid") != os.getuid() or self.meta.get("gid") != os.getgid()):
            raise ValueError("Deployment state does not match this path and owner")
        if not HOSTNAME.fullmatch(self.meta["domain"]):
            raise ValueError("The deployment's home server name is invalid")
        self.cmd = [
            "docker", "compose",
            "--project-name", self.meta["project"],
            "--file", str(BUNDLE / "compose.yaml"),
            "--file", str(BUNDLE / f"compose.{self.meta['mode']}.yaml"),
        ]
        self.env = dict(os.environ, MESSENGER_STATE=str(state),
                        MESSENGER_UID=str(self.meta["uid"]), MESSENGER_GID=str(self.meta["gid"]))

    def compose(self, *args, **kwargs):
        return subprocess.run([*self.cmd, *args], env=self.env, check=True, **kwargs)

    def database(self) -> None:
        self.compose("up", "-d", "--wait", "database")
        password = private_read(self.state / "postgres-app-password")
        if not re.fullmatch(r"[0-9a-f]{64}", password):
            raise ValueError("Invalid generated application database secret")
        # The platform default local Unix socket is restricted to the database container.
        settings = (
            "SELECT 'CREATE ROLE messenger LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE' "
            "WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'messenger') \\gexec\n"
            f"ALTER ROLE messenger PASSWORD '{password}';\n"
            "ALTER DATABASE messenger OWNER TO messenger;\n"
        )
        self.compose("exec", "-T", "database", "psql", "-U", "postgres", "-d", "messenger",
                     "-v", "ON_ERROR_STOP=1", input=settings.encode(), stdout=subprocess.DEVNULL,
                     stderr=subprocess.PIPE)

    def start(self) -> None:
        if (self.state / "restore-in-progress").exists():
            raise ValueError("Complete or recover the interrupted restore before starting")
        self.database()
        self.compose("up", "-d", "--wait")

    def stop(self) -> None:
        self.compose("stop", "-t", "30")

    def running(self, service: str) -> bool:
        return bool(self.compose("ps", "--status", "running", "--quiet", service,
                                 stdout=subprocess.PIPE).stdout.strip())

    def invite(self, addresses: list[str]) -> None:
        path = self.state / "synapse" / "invited-emails"
        old = parse_addresses(private_read(path).splitlines())
        updated = old | parse_addresses(addresses)
        if updated != old:
            atomic_write(path, "\n".join(sorted(updated)) + "\n")
            if self.running("synapse"):
                self.compose("restart", "synapse")
                self.compose("up", "-d", "--wait")
        print(f"Private beta invite list contains {len(updated)} address(es)")

    def unit(self) -> str:
        def argument(value):
            return json.dumps(str(value).replace("%", "%%").replace("$", "$$"))

        command = f"/usr/bin/python3 {argument(BUNDLE / 'manage.py')} --state-dir {argument(self.state)}"
        owner = pwd.getpwuid(self.meta["uid"]).pw_name
        return "\n".join([
            "[Unit]", "Description=Vellivex Messenger private beta", "Wants=network-online.target",
            "After=network-online.target docker.service", "Requires=docker.service", "",
            "[Service]", "Type=oneshot", "RemainAfterExit=yes", f"User={owner}", "UMask=0077",
            "TimeoutStartSec=240", f"ExecStart={command} start", f"ExecStop={command} stop", "",
            "[Install]", "WantedBy=multi-user.target", "",
        ])


@contextmanager
def locked(state: Path):
    fd = os.open(state / "deployment.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r+") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def pack(source: Path, path: Path) -> None:
    with tarfile.open(path, "w") as archive:
        archive.add(source / "metadata.json", arcname="metadata.json")
        archive.add(source / "messenger.dump", arcname="messenger.dump")
        for name in STABLE_FILES + ("media",):
            archive.add(source / "synapse" / name, arcname="synapse/" + name)


def unpack(path: Path, target: Path) -> None:
    with tarfile.open(path) as archive:
        files = set()
        for member in archive:
            p = PurePosixPath(member.name)
            allowed = member.name in {"metadata.json", "messenger.dump"}
            if p.parts[0:2] == ("synapse", "media"):
                allowed = True
            if len(p.parts) == 2 and p.parts[0] == "synapse" and p.parts[1] in STABLE_FILES:
                allowed = member.isfile()
            if (not allowed or p.is_absolute() or ".." in p.parts
                    or not (member.isfile() or member.isdir()) or p in files):
                raise ValueError("The backup contains an invalid path, duplicate or entry type")
            files.add(p)
        required = {PurePosixPath("metadata.json"), PurePosixPath("messenger.dump"),
                    *(PurePosixPath("synapse") / name for name in STABLE_FILES + ("media",))}
        if not required.issubset(files):
            raise ValueError("The backup is missing required entries")
        archive.extractall(target, filter="data")


def backup(stack: Stack, output: Path, recipient: str) -> None:
    if output.exists() or output.is_symlink():
        raise ValueError("Choose a new backup output path")
    if not recipient.startswith("age1"):
        raise ValueError("Provide an age public recipient")
    if not stack.running("database"):
        raise ValueError("Start the database before making a backup")
    was_running = stack.running("synapse")
    if was_running:
        stack.compose("stop", "-t", "30", "synapse")
    try:
        with TemporaryDirectory(dir=stack.state) as work:
            temporary = Path(work)
            write_config(temporary / "metadata.json", {"format": FORMAT, "domain": stack.meta["domain"]})
            (temporary / "synapse").symlink_to(stack.state / "synapse", target_is_directory=True)
            with (temporary / "messenger.dump").open("wb") as destination:
                stack.compose("exec", "-T", "database", "pg_dump", "-U", "postgres", "-d", "messenger",
                              "--format=custom", "--no-owner", stdout=destination)
            pack(temporary, temporary / "archive.tar")
            with TemporaryDirectory(dir=output.parent) as outgoing:
                encrypted = Path(outgoing) / "encrypted.age"
                subprocess.run(["age", "-r", recipient, "-o", str(encrypted), str(temporary / "archive.tar")],
                               check=True)
                os.link(encrypted, output, follow_symlinks=False)
    finally:
        if was_running:
            stack.compose("up", "-d", "--wait", "synapse")
    print(f"Encrypted Messenger backup saved to {output}")


def restore(stack: Stack, source: Path, identity: Path) -> None:
    if stack.running("synapse") or stack.running("proxy"):
        raise ValueError("Restore only into a freshly initialized and unpublished deployment")
    marker = stack.state / "restore-in-progress"
    if marker.exists():
        raise ValueError("Recover the interrupted restore before repeating it")
    prior_data = stack.state / "synapse"
    if any((prior_data / f"email.sqlite{suffix}").exists() for suffix in ("", "-wal", "-shm", "-journal")):
        raise ValueError("The target must never have issued a verification code")
    with TemporaryDirectory(dir=stack.state) as work:
        temporary = Path(work)
        subprocess.run(["age", "-d", "-i", str(identity), "-o", str(temporary / "archive.tar"), str(source)],
                       check=True)
        unpack(temporary / "archive.tar", temporary / "archive")
        payload = temporary / "archive"
        source_meta = json.loads((payload / "metadata.json").read_text(encoding="utf-8"))
        if source_meta != {"format": FORMAT, "domain": stack.meta["domain"]}:
            raise ValueError("Backup format or Matrix server name does not match this deployment")
        restored_data = temporary / "replacement"
        shutil.copytree(prior_data, restored_data)
        for name in STABLE_FILES:
            atomic_write(restored_data / name, (payload / "synapse" / name).read_text(encoding="utf-8"))
        shutil.rmtree(restored_data / "media")
        shutil.copytree(payload / "synapse" / "media", restored_data / "media")
        homeserver = json.loads(private_read(restored_data / "homeserver.yaml"))
        homeserver["macaroon_secret_key"] = private_read(restored_data / "macaroon-secret")
        write_config(restored_data / "homeserver.yaml", homeserver)
        stack.database()
        tables = stack.compose(
            "exec", "-T", "database", "psql", "-U", "postgres", "-d", "messenger", "-Atc",
            "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'",
            stdout=subprocess.PIPE,
        ).stdout.strip()
        if tables != b"0":
            raise ValueError("The target PostgreSQL database must be empty")
        atomic_write(marker, "Verify PostgreSQL and Synapse data before starting.\n")
        try:
            with (payload / "messenger.dump").open("rb") as dump:
                stack.compose("exec", "-T", "database", "pg_restore", "-U", "postgres", "-d", "messenger",
                              "--role=messenger", "--no-owner", "--no-privileges", "--single-transaction",
                              "--exit-on-error", stdin=dump)
            os.rename(prior_data, temporary / "previous")
            try:
                os.rename(restored_data, prior_data)
            except OSError:
                os.rename(temporary / "previous", prior_data)
                raise
        except BaseException:
            print("Restore interrupted. The public service remains stopped.", file=sys.stderr)
            raise
        marker.unlink()
    print("Restored PostgreSQL, server identity and media. Verify this private stack before publishing.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", required=True, type=Path)
    commands = parser.add_subparsers(dest="action", required=True)
    initial = commands.add_parser("init")
    initial.add_argument("--domain", default="messenger.vellivex.com")
    initial.add_argument("--mode", choices=["tunnel", "direct"], default="tunnel")
    initial.add_argument("--smtp-host", required=True)
    initial.add_argument("--smtp-port", default=465, type=int)
    initial.add_argument("--smtp-username", required=True)
    initial.add_argument("--smtp-sender", default=OWNER_EMAIL)
    initial.add_argument("--smtp-password-file", required=True, type=Path)
    for name in ("check", "start", "stop", "systemd-unit"):
        commands.add_parser(name)
    additions = commands.add_parser("invite")
    additions.add_argument("email", nargs="+")
    save = commands.add_parser("backup")
    save.add_argument("output", type=Path)
    save.add_argument("--recipient", required=True)
    load = commands.add_parser("restore")
    load.add_argument("source", type=Path)
    load.add_argument("--identity", required=True, type=Path)
    options = parser.parse_args()
    os.umask(0o077)
    state = options.state_dir.absolute()
    try:
        if options.action == "init":
            initialize(state, options)
            return 0
        stack = Stack(state)
        with locked(state):
            match options.action:
                case "check":
                    stack.compose("config", "--quiet")
                    print("Docker Compose configuration is valid.")
                case "start":
                    stack.start()
                case "stop":
                    stack.stop()
                case "systemd-unit":
                    print(stack.unit(), end="")
                case "invite":
                    stack.invite(options.email)
                case "backup":
                    backup(stack, options.output.absolute(), options.recipient)
                case "restore":
                    restore(stack, options.source.absolute(), options.identity.absolute())
    except (ValueError, OSError, tarfile.TarError, subprocess.CalledProcessError) as error:
        if isinstance(error, subprocess.CalledProcessError):
            print(f"Required deployment command failed with exit status {error.returncode}.", file=sys.stderr)
        else:
            print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
