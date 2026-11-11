#!/usr/bin/env python3
"""Loopback-only DNS fixture for an isolated VGuard Android emulator.

Reuse the published protocol fixture's bounded DNS handlers. No forwarding,
host resolver changes, or production application changes are performed.
"""
from __future__ import annotations

import argparse
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import signal
import socket
import socketserver
import struct
import sys
import threading
import uuid


HOST = "127.0.0.1"
ANSWER = "10.0.2.2"


def synthetic_name(name):
    return isinstance(name, str) and (
        name == "vguard.test" or name.endswith(".vguard.test")
    )


def fixture_log(protocol, _peer=None, **fields):
    """Retain only reserved test-zone names, never incidental Android queries."""
    name = fields.get("name")
    if synthetic_name(name):
        print(json.dumps({
            "protocol": protocol,
            "name": name,
            "type": fields.get("type"),
            "answered": fields.get("answered"),
        }), flush=True)


def load_handlers(source):
    if not source.is_file():
        raise ValueError("DNS protocol fixture source is not a regular file")
    spec = importlib.util.spec_from_file_location("vguard_protocol_fixture", source)
    if spec is None or spec.loader is None:
        raise ValueError("DNS protocol fixture could not be loaded")
    fixture = importlib.util.module_from_spec(spec)
    # Import before the privilege drop without creating root-owned bytecode.
    sys.dont_write_bytecode = True
    spec.loader.exec_module(fixture)
    fixture.log = fixture_log
    return fixture.DNSUDP, fixture.DNSTCP


class LocalUDP(socketserver.ThreadingUDPServer):
    address_family = socket.AF_INET
    allow_reuse_address = False
    daemon_threads = True


class LocalTCP(socketserver.ThreadingTCPServer):
    address_family = socket.AF_INET
    allow_reuse_address = True
    daemon_threads = True


def drop_privileges(uid, gid):
    if os.geteuid() == 0:
        if uid is None or gid is None or uid <= 0 or gid <= 0:
            raise ValueError("Root startup requires non-root --uid and --gid")
        os.setgroups([])
        os.setgid(gid)
        os.setuid(uid)
        if os.geteuid() == 0 or os.getegid() == 0:
            raise RuntimeError("DNS fixture failed to drop privileges")
    elif ((uid is not None and uid != os.geteuid()) or
          (gid is not None and gid != os.getegid())):
        raise ValueError("Non-root startup cannot change the fixture user or group")


def write_pid(path):
    if path is None:
        return
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, "w", encoding="ascii") as output:
        output.write(str(os.getpid()) + "\n")


def serve(args):
    # Validate privilege intent before binding sockets. Actual privilege dropping
    # happens after both port-53 sockets exist and before worker threads start.
    if os.geteuid() == 0 and (
            args.uid is None or args.gid is None or args.uid <= 0 or args.gid <= 0):
        raise ValueError("Root startup requires non-root --uid and --gid")
    udp_handler, tcp_handler = load_handlers(args.source)
    servers = []
    threads = []
    pid_written = False
    stopped = threading.Event()
    previous_handlers = {}
    try:
        for kind, handler in ((LocalUDP, udp_handler), (LocalTCP, tcp_handler)):
            server = kind((HOST, args.port), handler)
            server.ipv4, server.ipv6 = ANSWER, None
            servers.append(server)
        drop_privileges(args.uid, args.gid)
        write_pid(args.pid_file)
        pid_written = args.pid_file is not None
        for signum in (signal.SIGTERM, signal.SIGINT):
            previous_handlers[signum] = signal.signal(
                signum, lambda _signum, _frame: stopped.set())
        for server in servers:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            threads.append(thread)
        print(json.dumps({"protocol": "ready", "bind": HOST, "port": args.port,
                          "uid": os.geteuid(), "gid": os.getegid()}), flush=True)
        stopped.wait()
    finally:
        for server, thread in zip(servers, threads):
            if thread.is_alive():
                server.shutdown()
        for server in servers:
            server.server_close()
        for thread in threads:
            thread.join(timeout=2)
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)
        if pid_written:
            try:
                if args.pid_file.read_text(encoding="ascii").strip() == str(os.getpid()):
                    args.pid_file.unlink()
            except FileNotFoundError:
                pass


def make_query():
    name = "host-check-" + uuid.uuid4().hex + ".vguard.test"
    ident = int.from_bytes(os.urandom(2), "big")
    encoded_name = b"".join(bytes([len(label)]) + label.encode("ascii")
                            for label in name.split(".")) + b"\x00"
    question = encoded_name + struct.pack("!HH", 1, 1)
    query = struct.pack("!HHHHHH", ident, 0x0100, 1, 0, 0, 0) + question
    return query, ident, question


def validate_answer(response, ident, question):
    if len(response) < 12:
        raise ValueError("DNS fixture returned a short header")
    reply_id, flags, questions, answers, authority, extra = struct.unpack(
        "!HHHHHH", response[:12])
    if reply_id != ident or flags != 0x8180 or (questions, answers, authority, extra) != (1, 1, 0, 0):
        raise ValueError("DNS fixture returned unexpected response metadata")
    expected_answer = (b"\xc0\x0c" + struct.pack("!HHIH", 1, 1, 0, 4)
                       + ipaddress.IPv4Address(ANSWER).packed)
    if response[12:] != question + expected_answer:
        raise ValueError("DNS fixture must return exactly A 10.0.2.2 with TTL zero")


def read_exact(connection, size):
    chunks = []
    remaining = size
    while remaining:
        data = connection.recv(remaining)
        if not data:
            raise EOFError("DNS fixture closed a partial TCP frame")
        chunks.append(data)
        remaining -= len(data)
    return b"".join(chunks)


def check(port):
    query, ident, question = make_query()
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as connection:
        connection.settimeout(3)
        connection.sendto(query, (HOST, port))
        response, peer = connection.recvfrom(4096)
        if peer != (HOST, port):
            raise ValueError("Unexpected UDP DNS response sender")
    validate_answer(response, ident, question)
    query, ident, question = make_query()
    with socket.create_connection((HOST, port), timeout=3) as connection:
        connection.sendall(struct.pack("!H", len(query)) + query)
        size = struct.unpack("!H", read_exact(connection, 2))[0]
        if not 12 <= size <= 4096:
            raise ValueError("DNS fixture returned an invalid TCP frame length")
        response = read_exact(connection, size)
    validate_answer(response, ident, question)
    print("PASS VGuard: controlled loopback UDP and TCP DNS return exact A 10.0.2.2 with TTL zero.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=(
        Path(__file__).resolve().parent.parent / "apps/vguard/device-qa/protocol-server.py"))
    parser.add_argument("--port", type=int, default=53)
    parser.add_argument("--uid", type=int)
    parser.add_argument("--gid", type=int)
    parser.add_argument("--pid-file", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    if args.check:
        check(args.port)
    else:
        serve(args)


if __name__ == "__main__":
    main()
