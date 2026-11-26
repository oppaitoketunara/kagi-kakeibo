#!/usr/bin/env python3
"""アプリのアイコン (PNG) を作る。外部ライブラリは使わない。

    python3 tools/make_icons.py

app/icons/icon.svg と同じ図柄(青地に、¥ の入った錠前)を、図形の「距離」を計算して
1 ピクセルずつ塗っている。
"""

from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

ICONS = Path(__file__).resolve().parent.parent / "app" / "icons"

TOP = (0x2A, 0x78, 0xD6)
BOTTOM = (0x18, 0x4F, 0x95)
WHITE = (0xFF, 0xFF, 0xFF)
YEN = (0x1C, 0x5C, 0xAB)

# 512x512 の座標系で定義する
BODY = (256.0, 318.0, 104.0, 82.0, 30.0)  # 中心x, 中心y, 半幅, 半高, 角丸
SHACKLE_CENTER = (256.0, 200.0)
SHACKLE_RADIUS = 64.0
SHACKLE_HALF_WIDTH = 15.0
SHACKLE_BOTTOM = 250.0
YEN_HALF_WIDTH = 8.0
YEN_SEGMENTS = [
    (228.0, 276.0, 256.0, 318.0),
    (284.0, 276.0, 256.0, 318.0),
    (256.0, 318.0, 256.0, 366.0),
    (230.0, 326.0, 282.0, 326.0),
    (230.0, 348.0, 282.0, 348.0),
]
CORNER_RADIUS = 116.0


def round_rect(px: float, py: float, cx: float, cy: float, hx: float, hy: float, radius: float) -> float:
    qx = abs(px - cx) - hx + radius
    qy = abs(py - cy) - hy + radius
    return min(max(qx, qy), 0.0) + math.hypot(max(qx, 0.0), max(qy, 0.0)) - radius


def segment(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    pax, pay, bax, bay = px - ax, py - ay, bx - ax, by - ay
    t = max(0.0, min(1.0, (pax * bax + pay * bay) / (bax * bax + bay * bay)))
    return math.hypot(pax - bax * t, pay - bay * t)


def shackle(px: float, py: float) -> float:
    cx, cy = SHACKLE_CENTER
    if py <= cy:
        return abs(math.hypot(px - cx, py - cy) - SHACKLE_RADIUS) - SHACKLE_HALF_WIDTH
    return max(abs(abs(px - cx) - SHACKLE_RADIUS) - SHACKLE_HALF_WIDTH, py - SHACKLE_BOTTOM)


def mix(a: tuple[float, ...], b: tuple[float, ...], t: float) -> tuple[float, ...]:
    return tuple(x + (y - x) * t for x, y in zip(a, b))


def render(size: int, *, rounded: bool) -> bytes:
    scale = size / 512.0

    def coverage(distance: float) -> float:
        """図形までの距離(512 座標系)を、そのピクセルを塗る割合にする。"""
        return max(0.0, min(1.0, 0.5 - distance * scale))

    rows = []
    for y in range(size):
        v = (y + 0.5) / scale
        row = bytearray([0])  # PNG のフィルター種別 (なし)
        for x in range(size):
            u = (x + 0.5) / scale
            color = mix(TOP, BOTTOM, v / 512.0)
            body = coverage(round_rect(u, v, *BODY))
            lock = max(body, coverage(shackle(u, v)))
            if lock > 0.0:
                color = mix(color, WHITE, lock)
            if body > 0.0:
                yen = max(coverage(segment(u, v, *s) - YEN_HALF_WIDTH) for s in YEN_SEGMENTS)
                if yen > 0.0:
                    color = mix(color, YEN, yen * body)
            alpha = coverage(round_rect(u, v, 256.0, 256.0, 256.0, 256.0, CORNER_RADIUS)) if rounded else 1.0
            row.extend((round(color[0]), round(color[1]), round(color[2]), round(alpha * 255)))
        rows.append(bytes(row))
    return b"".join(rows)


def write_png(path: Path, size: int, raw: bytes) -> None:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8 ビット RGBA
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    )


def main() -> None:
    ICONS.mkdir(parents=True, exist_ok=True)
    targets = [
        ("icon-192.png", 192, True),
        ("icon-512.png", 512, True),
        # マスク用(Android が好きな形に切り抜く)と iOS 用は、角を丸めず全面を塗る
        ("icon-maskable-512.png", 512, False),
        ("apple-touch-icon.png", 180, False),
    ]
    for name, size, rounded in targets:
        write_png(ICONS / name, size, render(size, rounded=rounded))
        print(f"{name}: {size}x{size}")


if __name__ == "__main__":
    main()
