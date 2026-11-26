#!/usr/bin/env python3
"""配布するファイル (app/) の静的な安全検査。配布の前に必ず通す。

    python3 tools/check.py

調べること
  1. 危険な書き方をしていないか(文字列を HTML として解釈させる、外部と通信する、など)
  2. 外部の URL を含んでいないか
  3. 見えない文字(制御文字・文字の向きを変える文字)がソースに紛れ込んでいないか
  4. index.html と _headers のセキュリティ設定が抜けていないか
  5. sw.js のキャッシュ一覧が最新か

1 つでも問題があれば終了コード 1 で終わる。
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "app"

# (正規表現, 説明)。コメントを取り除いた JavaScript に対して調べる。
FORBIDDEN_JS = [
    (r"\binnerHTML\b", "innerHTML(文字列を HTML として解釈する)"),
    (r"\bouterHTML\b", "outerHTML"),
    (r"\binsertAdjacentHTML\b", "insertAdjacentHTML"),
    (r"\bcreateContextualFragment\b", "createContextualFragment"),
    (r"\bDOMParser\b", "DOMParser"),
    (r"\bdocument\s*\.\s*write", "document.write"),
    (r"\beval\s*\(", "eval"),
    (r"\bnew\s+Function\b", "new Function"),
    (r"\bset(?:Timeout|Interval)\s*\(\s*[\"'`]", "文字列を渡す setTimeout / setInterval"),
    (r"\blocalStorage\b", "localStorage(暗号化されない保存先)"),
    (r"\bsessionStorage\b", "sessionStorage(暗号化されない保存先)"),
    (r"\bdocument\s*\.\s*cookie\b", "document.cookie"),
    (r"\bXMLHttpRequest\b", "XMLHttpRequest(通信)"),
    (r"\bWebSocket\b", "WebSocket(通信)"),
    (r"\bEventSource\b", "EventSource(通信)"),
    (r"\bsendBeacon\b", "sendBeacon(通信)"),
    (r"\bRTCPeerConnection\b", "WebRTC(通信)"),
    (r"\bimportScripts\b", "importScripts"),
    (r"\bimport\s*\(", "動的 import"),
    (r"javascript:", "javascript: URL"),
    (r"\bconsole\s*\.\s*(?:log|info|debug|warn|error)\b", "console への出力(記録の内容を残すおそれ)"),
]
# 通信そのもの。Service Worker(自分のファイルを取りに行く)だけに許す。
FETCH = (r"\bfetch\s*\(", "fetch(通信)")
FETCH_ALLOWED_IN = {"sw.js"}

URL_PATTERN = re.compile(r"https?://[^\s\"'`<>)]+")
ALLOWED_URLS = {"http://www.w3.org/2000/svg"}

INVISIBLE = set(range(0x00, 0x20)) - {0x09, 0x0A}
INVISIBLE |= set(range(0x7F, 0xA0))
INVISIBLE |= {0x200B, 0x200C, 0x200D, 0x200E, 0x200F, 0x2028, 0x2029, 0x202A, 0x202B, 0x202C, 0x202D, 0x202E}
INVISIBLE |= {0x2066, 0x2067, 0x2068, 0x2069, 0xFEFF}

REQUIRED_META_CSP = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "require-trusted-types-for 'script'",
]
REQUIRED_HEADERS = {
    "content-security-policy": ["default-src 'none'", "frame-ancestors 'none'", "script-src 'self'"],
    "x-content-type-options": ["nosniff"],
    "x-frame-options": ["DENY"],
    "referrer-policy": ["no-referrer"],
    "cross-origin-opener-policy": ["same-origin"],
    "permissions-policy": ["camera=()", "microphone=()", "geolocation=()"],
}

problems: list[str] = []


def problem(path: Path, message: str) -> None:
    problems.append(f"{path.relative_to(ROOT)}: {message}")


def strip_js_comments(source: str) -> str:
    """コメントを取り除く(文字列中の // は残す。行頭か空白の直後の // だけをコメントとみなす)。"""
    source = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
    return re.sub(r"(^|\s)//[^\n]*", r"\1", source)


def check_text_file(path: Path, text: str) -> None:
    found = sorted({ord(char) for char in text if ord(char) in INVISIBLE})
    if found:
        problem(path, "見えない文字が入っています: " + ", ".join(f"U+{code:04X}" for code in found))
    for url in URL_PATTERN.findall(text):
        if url not in ALLOWED_URLS:
            problem(path, f"外部の URL があります: {url}")


def check_javascript(path: Path, text: str) -> None:
    code = strip_js_comments(text)
    rules = list(FORBIDDEN_JS)
    if path.name not in FETCH_ALLOWED_IN:
        rules.append(FETCH)
    for pattern, label in rules:
        if re.search(pattern, code):
            problem(path, f"使ってはいけない書き方: {label}")


def check_index_html(path: Path, text: str) -> None:
    match = re.search(r'<meta http-equiv="Content-Security-Policy" content="([^"]*)"', text)
    if not match:
        problem(path, "Content-Security-Policy の meta がありません")
    else:
        for directive in REQUIRED_META_CSP:
            if directive not in match.group(1):
                problem(path, f"CSP に {directive} がありません")
        if "unsafe-inline" in match.group(1) or "unsafe-eval" in match.group(1):
            problem(path, "CSP に unsafe-inline / unsafe-eval が含まれています")
    without_comments = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    for script in re.findall(r"<script\b[^>]*>", without_comments):
        if "src=" not in script:
            problem(path, "インラインの <script> があります")
    if re.search(r"<[^>]+\son[a-z]+\s*=", without_comments, flags=re.I):
        problem(path, "インラインのイベント属性 (onclick など) があります")
    if re.search(r"<[^>]+\sstyle\s*=", without_comments, flags=re.I) or re.search(r"<style\b", without_comments, flags=re.I):
        problem(path, "インラインのスタイルがあります")
    if 'name="referrer" content="no-referrer"' not in text:
        problem(path, "referrer の指定がありません")


def check_headers(path: Path, text: str) -> None:
    headers = {}
    for line in text.splitlines():
        if line[:1].isspace() and ":" in line:
            name, value = line.split(":", 1)
            headers[name.strip().lower()] = value.strip()
    for name, needles in REQUIRED_HEADERS.items():
        if name not in headers:
            problem(path, f"{name} ヘッダーがありません")
            continue
        for needle in needles:
            if needle not in headers[name]:
                problem(path, f"{name} に {needle} がありません")
    csp = headers.get("content-security-policy", "")
    if "unsafe-inline" in csp or "unsafe-eval" in csp:
        problem(path, "CSP に unsafe-inline / unsafe-eval が含まれています")


def check_manifest(path: Path, text: str) -> None:
    manifest = json.loads(text)
    for key in ("start_url", "scope"):
        if manifest.get(key) != "./":
            problem(path, f'{key} は "./" にしてください(置き場所が変わっても動くように)')
    if "id" in manifest:
        # id はサイトの先頭からの位置として解釈されるので、置き場所によって別のアプリと衝突しうる。省けば start_url が使われる。
        problem(path, "id は書かないでください(start_url がそのまま使われます)")
    for icon in manifest.get("icons", []):
        if not (APP / icon["src"]).is_file():
            problem(path, f"アイコンが見つかりません: {icon['src']}")


def main() -> int:
    text_suffixes = {".js", ".html", ".css", ".webmanifest", ".svg", ".json"}
    files = sorted(path for path in APP.rglob("*") if path.is_file())
    for path in files:
        if path.suffix not in text_suffixes and path.name != "_headers":
            continue
        text = path.read_text(encoding="utf-8")
        check_text_file(path, text)
        if path.suffix == ".js":
            check_javascript(path, text)
    check_index_html(APP / "index.html", (APP / "index.html").read_text(encoding="utf-8"))
    check_headers(APP / "_headers", (APP / "_headers").read_text(encoding="utf-8"))
    check_manifest(APP / "manifest.webmanifest", (APP / "manifest.webmanifest").read_text(encoding="utf-8"))

    # テストのソースにも、見えない文字は入れない
    for path in sorted((ROOT / "tests").rglob("*")):
        if path.is_file() and path.suffix in text_suffixes:
            found = sorted({ord(char) for char in path.read_text(encoding="utf-8") if ord(char) in INVISIBLE})
            if found:
                problem(path, "見えない文字が入っています: " + ", ".join(f"U+{code:04X}" for code in found))

    sw = subprocess.run([sys.executable, str(ROOT / "tools" / "update_sw.py"), "--check"], capture_output=True, text=True)
    if sw.returncode != 0:
        problems.append("app/sw.js: キャッシュ一覧が古くなっています(python3 tools/update_sw.py を実行)")

    if problems:
        print(f"問題が {len(problems)} 件あります:")
        for line in problems:
            print(f"  - {line}")
        return 1
    print(f"問題なし({len(files)} ファイルを検査)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
