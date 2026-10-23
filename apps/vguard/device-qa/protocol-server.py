#!/usr/bin/env python3
"""Controlled TCP/UDP/DNS QA endpoints. No filesystem or Internet forwarding."""
import argparse
import ipaddress
import json
import socket
import socketserver
import struct
import threading
import time


def log(protocol, peer, **fields):
    print(json.dumps({"time": time.time(), "protocol": protocol, "peer": peer, **fields}), flush=True)


class DualStack:
    address_family = socket.AF_INET6
    allow_reuse_address = True
    daemon_threads = True

    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


class TCPServer(DualStack, socketserver.ThreadingTCPServer):
    pass


class UDPServer(DualStack, socketserver.ThreadingUDPServer):
    pass


class EchoTCP(socketserver.StreamRequestHandler):
    def handle(self):
        self.request.settimeout(300)
        try:
            for _ in range(200):
                data = self.rfile.readline(1024)
                if not data or not data.endswith(b"\n"):
                    return
                token = data[:-1]
                if not token or len(token) > 200:
                    return
                self.wfile.write(b"VGUARD_QA_OK " + token + b"\n")
                self.wfile.flush()
                log("tcp", self.client_address[0], token=token.decode("ascii", errors="replace"))
        except (OSError, TimeoutError):
            return


class EchoUDP(socketserver.BaseRequestHandler):
    def handle(self):
        data, sock = self.request
        if not data or len(data) > 200:
            return
        sock.sendto(b"VGUARD_QA_OK " + data, self.client_address)
        log("udp", self.client_address[0], token=data.decode("ascii", errors="replace"))


def dns_response(query, ipv4, ipv6):
    """Answer a single uncompressed IN question in the reserved .test zone."""
    if len(query) < 17 or len(query) > 4096:
        return None, None
    ident, flags, qd, _, _, _ = struct.unpack("!HHHHHH", query[:12])
    if qd != 1 or flags & 0xF800:
        return None, None
    labels = []
    offset = 12
    while True:
        if offset >= len(query):
            return None, None
        length = query[offset]
        offset += 1
        if length == 0:
            break
        if length > 63 or offset + length > len(query):
            return None, None
        labels.append(query[offset:offset + length].decode("ascii", errors="replace").lower())
        offset += length
        if offset > 267:
            return None, None
    if offset + 4 > len(query):
        return None, None
    qtype, qclass = struct.unpack("!HH", query[offset:offset + 4])
    question = query[12:offset + 4]
    name = ".".join(labels)
    allowed = name == "vguard.test" or name.endswith(".vguard.test")
    payload = None
    if allowed and qclass == 1:
        if qtype == 1:
            payload = ipaddress.IPv4Address(ipv4).packed
        elif qtype == 28 and ipv6:
            payload = ipaddress.IPv6Address(ipv6).packed
    response_flags = 0x8080 | (flags & 0x0100) | (0 if allowed else 3)
    header = struct.pack("!HHHHHH", ident, response_flags, 1, int(payload is not None), 0, 0)
    answer = b""
    if payload is not None:
        answer = b"\xc0\x0c" + struct.pack("!HHIH", qtype, 1, 0, len(payload)) + payload
    return header + question + answer, {"name": name, "type": qtype, "answered": payload is not None}


class DNSUDP(socketserver.BaseRequestHandler):
    def handle(self):
        data, sock = self.request
        response, detail = dns_response(data, self.server.ipv4, self.server.ipv6)
        if response is not None:
            sock.sendto(response, self.client_address)
            log("dns_udp", self.client_address[0], **detail)


class DNSTCP(socketserver.StreamRequestHandler):
    def handle(self):
        self.request.settimeout(30)
        try:
            for _ in range(20):
                prefix = self.rfile.read(2)
                if len(prefix) != 2:
                    return
                size = struct.unpack("!H", prefix)[0]
                if size > 4096:
                    return
                data = self.rfile.read(size)
                if len(data) != size:
                    return
                response, detail = dns_response(data, self.server.ipv4, self.server.ipv6)
                if response is None:
                    return
                self.wfile.write(struct.pack("!H", len(response)) + response)
                self.wfile.flush()
                log("dns_tcp", self.client_address[0], **detail)
        except (OSError, TimeoutError):
            return


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tcp-port", type=int, default=18790)
    parser.add_argument("--udp-port", type=int, default=18791)
    parser.add_argument("--dns-port", type=int, help="Optional controlled DNS port; emulator -dns-server uses 53")
    parser.add_argument("--ipv4-host", default="10.0.2.2")
    parser.add_argument("--ipv6-host")
    args = parser.parse_args()
    ipaddress.IPv4Address(args.ipv4_host)
    if args.ipv6_host:
        ipaddress.IPv6Address(args.ipv6_host)
    servers = [TCPServer(("::", args.tcp_port), EchoTCP), UDPServer(("::", args.udp_port), EchoUDP)]
    if args.dns_port is not None:
        for kind, handler in ((UDPServer, DNSUDP), (TCPServer, DNSTCP)):
            server = kind(("::", args.dns_port), handler)
            server.ipv4, server.ipv6 = args.ipv4_host, args.ipv6_host
            servers.append(server)
    for server in servers:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    log("ready", "local", tcp=args.tcp_port, udp=args.udp_port, dns=args.dns_port,
        ipv4=args.ipv4_host, ipv6=args.ipv6_host)
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        for server in servers:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    main()
