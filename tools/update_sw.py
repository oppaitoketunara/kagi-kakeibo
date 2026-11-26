#!/usr/bin/env python3
"""app/sw.js の「キャッシュするファイルの一覧」と「版」を、app/ の実際の中身から作り直す。

    python3 tools/update_sw.py          # sw.js を書き換える
    python3 tools/update_sw.py --check  # 最新かどうかだけ調べる(ずれていたら終了コード 1)

app/ の中のファイルを 1 つでも変えたら、配布の前に必ず実行する。
版が変わると、利用者の端末は次回の起動時に新しいファイル一式を取り直す。
"""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

APP = Path(__file__).resolve().parent.parent / "app"
SW = APP / "sw.js"
EXCLUDED = {"sw.js", "_headers"}
BEGIN = "// --- BEGIN GENERATED (tools/update_sw.py) ---"
END = "// --- END GENERATED ---"


def asset_files() -> list[Path]:
    files = []
    for path in APP.rglob("*"):
        relative = path.relative_to(APP)
        if not path.is_file() or any(part.startswith(".") for part in relative.parts):
            continue
        if relative.as_posix() in EXCLUDED:
            continue
        files.append(path)
    return sorted(files, key=lambda item: item.relative_to(APP).as_posix())


def generated_block() -> str:
    digest = hashlib.sha256()
    urls = []
    for path in asset_files():
        relative = path.relative_to(APP).as_posix()
        digest.update(relative.encode("utf-8") + b"\0" + path.read_bytes() + b"\0")
        # index.html はフォルダーの URL として取得する(配信元が index.html を転送する場合に備える)
        urls.append("./" if relative == "index.html" else relative)
    lines = [BEGIN, f"const VERSION = '{digest.hexdigest()[:16]}';", "const ASSETS = ["]
    lines += [f"  '{url}'," for url in sorted(urls)]
    lines += ["];", END]
    return "\n".join(lines)


def main() -> int:
    source = SW.read_text(encoding="utf-8")
    start = source.index(BEGIN)
    end = source.index(END) + len(END)
    updated = source[:start] + generated_block() + source[end:]
    if "--check" in sys.argv[1:]:
        if updated != source:
            print("sw.js が古くなっています。python3 tools/update_sw.py を実行してください。")
            return 1
        print("sw.js は最新です。")
        return 0
    if updated != source:
        SW.write_text(updated, encoding="utf-8")
        print("sw.js を更新しました。")
    else:
        print("sw.js は最新です。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
