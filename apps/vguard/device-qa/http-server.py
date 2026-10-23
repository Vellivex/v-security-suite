#!/usr/bin/env python3
"""Constant-response server for an isolated local Android emulator network."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import socket

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        body = b"VGUARD_QA_OK\n"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        print(self.headers.get("X-VGuard-Probe", "probe") + " " + (format % args), flush=True)

class DualStackServer(ThreadingHTTPServer):
    address_family = socket.AF_INET6

    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()

server = DualStackServer(("::", 18789), Handler)
print("VGuard QA server listening on local port 18789", flush=True)
server.serve_forever()
