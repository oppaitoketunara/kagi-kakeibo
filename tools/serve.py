#!/usr/bin/env python3
"""かぎ家計簿のローカル開発サーバー。

    python3 tools/serve.py            # http://localhost:8765/app/
    python3 tools/serve.py --port 9000

- このパソコンの中 (127.0.0.1 / ::1) だけで待ち受ける。同じネットワークの他の端末からは見えない。
- app/ には本番と同じセキュリティヘッダー (app/_headers) を付けて配信する。
- 配信するのは app/ と tests/ だけ。
"""

from __future__ import annotations

import argparse
import http.server
import socket
import sys
import threading
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent.parent
SERVED_DIRS = ("app", "tests")
HIDDEN_NAMES = {"_headers"}
# 開発サーバーは http なので付けない / 開発中はキャッシュさせない
SKIPPED_HEADERS = {"strict-transport-security", "cache-control"}
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".txt": "text/plain; charset=utf-8",
}


def load_app_headers() -> list[tuple[str, str]]:
    """app/_headers の `/*` ブロックにあるヘッダーを読む。"""
    headers: list[tuple[str, str]] = []
    in_block = False
    for line in (ROOT / "app" / "_headers").read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if not line[0].isspace():
            in_block = line.strip() == "/*"
            continue
        if in_block and ":" in line:
            name, value = line.split(":", 1)
            headers.append((name.strip(), value.strip()))
    return headers


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "kagi-kakeibo-dev"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:  # noqa: N802 (http.server の決まり)
        self.respond(send_body=True)

    def do_HEAD(self) -> None:  # noqa: N802
        self.respond(send_body=False)

    def respond(self, *, send_body: bool) -> None:
        path = unquote(urlsplit(self.path).path)
        if path == "/":
            self.redirect("/app/")
            return
        parts = [part for part in path.split("/") if part]
        if (
            not parts
            or parts[0] not in SERVED_DIRS
            or any(part.startswith(".") or part in HIDDEN_NAMES for part in parts)
            # 別の区切り文字やドライブ指定、NUL を含む名前は受け付けない
            or any(char in part for part in parts for char in ("\\", ":", "\x00"))
        ):
            self.fail(404)
            return
        try:
            target = ROOT.joinpath(*parts)
            if target.is_dir():
                if not path.endswith("/"):
                    self.redirect(path + "/")
                    return
                target = target / "index.html"
            resolved = target.resolve(strict=True)
        except (OSError, ValueError):
            self.fail(404)
            return
        if ROOT not in resolved.parents or not resolved.is_file():
            self.fail(404)
            return

        body = resolved.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPES.get(resolved.suffix.lower(), "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if parts[0] == "app":
            for name, value in load_app_headers():
                if name.lower() not in SKIPPED_HEADERS:
                    self.send_header(name, value)
        else:
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        if send_body:
            self.wfile.write(body)

    def redirect(self, location: str) -> None:
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def fail(self, status: int) -> None:
        body = f"{status}\n".encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)


def make_server(family: socket.AddressFamily, host: str, port: int) -> http.server.ThreadingHTTPServer:
    server_class = type(
        "LoopbackServer",
        (http.server.ThreadingHTTPServer,),
        {"address_family": family, "daemon_threads": True},
    )
    return server_class((host, port), Handler)


def main() -> None:
    parser = argparse.ArgumentParser(description="かぎ家計簿のローカル開発サーバー")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    servers = []
    for family, host in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")):
        try:
            servers.append(make_server(family, host, args.port))
        except OSError as error:
            print(f"{host} のポート {args.port} では待ち受けできません: {error}", file=sys.stderr)
    if not servers:
        sys.exit(1)

    for server in servers[1:]:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f"アプリ:  http://localhost:{args.port}/app/", flush=True)
    print(f"テスト:  http://localhost:{args.port}/tests/", flush=True)
    try:
        servers[0].serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
