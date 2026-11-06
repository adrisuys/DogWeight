"""Generate the PWA icons — stdlib only, no image library.

Draws a rounded-square tile with a dog's head on it, supersampled 3x3 for
smooth edges, and writes real PNGs by hand.

    ./venv/bin/python scripts/make_icons.py
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / "static" / "icons"

# The tile is dark in both themes, so these follow the *dark* end of the
# palette in styles.css: the light-mode blue (#2a78d6) goes muddy against a
# near-black tile at 180px, where the brighter dark-mode step does not.
BACKGROUND = (0x10, 0x15, 0x1A)   # --text-primary, the app's cool near-black
HEAD = (0x39, 0x87, 0xE5)         # --series-1 (dark)
LIGHT = (0x6A, 0xAE, 0xF5)        # a step lighter: ears and muzzle read separately
SAMPLES = 3  # per axis


def _rounded_rect(px: float, py: float, x0: float, y0: float,
                  x1: float, y1: float, radius: float) -> bool:
    if px < x0 or px > x1 or py < y0 or py > y1:
        return False
    cx = min(max(px, x0 + radius), x1 - radius)
    cy = min(max(py, y0 + radius), y1 - radius)
    dx, dy = px - cx, py - cy
    return dx * dx + dy * dy <= radius * radius


def _circle(px: float, py: float, cx: float, cy: float, radius: float) -> bool:
    dx, dy = px - cx, py - cy
    return dx * dx + dy * dy <= radius * radius


def _triangle(px: float, py: float, a, b, c) -> bool:
    """Point-in-triangle by consistent cross-product sign.

    The third primitive, and the one that makes the glyph a dog: with only
    rects and circles the ears come out as round side-flaps and the result
    reads as a monkey.
    """
    def side(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    d1, d2, d3 = side(a, b, (px, py)), side(b, c, (px, py)), side(c, a, (px, py))
    return not ((d1 < 0 or d2 < 0 or d3 < 0) and (d1 > 0 or d2 > 0 or d3 > 0))


def _shade(px: float, py: float, size: int, inset: float) -> tuple[int, int, int] | None:
    """Colour at a sample point, or None outside the tile."""
    if not _rounded_rect(px, py, 0, 0, size, size, size * 0.22):
        return None

    # The glyph lives inside the content box; `inset` shrinks it for maskable
    # icons, which Android may crop to a circle.
    box = size * inset
    left = top = (size - box) / 2

    def bx(v: float) -> float:
        return left + box * v

    def by(v: float) -> float:
        return top + box * v

    def rr(x0, y0, x1, y1, r):
        return _rounded_rect(px, py, bx(x0), by(y0), bx(x1), by(y1), box * r)

    def ci(cx, cy, r):
        return _circle(px, py, bx(cx), by(cy), box * r)

    def tri(a, b, c):
        return _triangle(px, py, (bx(a[0]), by(a[1])),
                         (bx(b[0]), by(b[1])), (bx(c[0]), by(c[1])))

    # Painted front-to-back: the first hit wins, so the nose is tested before
    # the muzzle that carries it and the head before the ears behind it.
    if rr(0.440, 0.630, 0.560, 0.700, 0.030):      # nose — wider than tall
        return BACKGROUND
    if ci(0.355, 0.430, 0.052) or ci(0.645, 0.430, 0.052):
        return BACKGROUND                           # eyes
    if rr(0.330, 0.575, 0.670, 0.825, 0.120):      # muzzle
        return LIGHT
    if rr(0.175, 0.185, 0.825, 0.745, 0.260):      # head
        return HEAD
    # Ears. Deliberately stubby: a long narrow triangle reads as a fox, and
    # thin ones silt up below about 60px — which is the notification badge
    # and the browser tab, not just the home screen.
    if tri((0.115, 0.420), (0.285, 0.055), (0.480, 0.290)):
        return LIGHT
    if tri((0.885, 0.420), (0.715, 0.055), (0.520, 0.290)):
        return LIGHT
    return BACKGROUND


def render(size: int, inset: float) -> bytes:
    rows = []
    step = 1.0 / SAMPLES
    weight = 1.0 / (SAMPLES * SAMPLES)
    for y in range(size):
        row = bytearray()
        for x in range(size):
            r = g = b = 0.0
            for sy in range(SAMPLES):
                py = y + (sy + 0.5) * step
                for sx in range(SAMPLES):
                    px = x + (sx + 0.5) * step
                    colour = _shade(px, py, size, inset) or BACKGROUND
                    r += colour[0] * weight
                    g += colour[1] * weight
                    b += colour[2] * weight
            row += bytes((round(r), round(g), round(b)))
        rows.append(bytes(row))
    return b"".join(b"\x00" + row for row in rows)


def write_png(path: Path, size: int, raw: bytes) -> None:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    header = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)  # 8-bit RGB
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", header)
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    path.write_bytes(png)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    targets = [
        ("icon-180.png", 180, 0.62),
        ("icon-192.png", 192, 0.62),
        ("icon-512.png", 512, 0.62),
        # Maskable: keep the glyph inside the 80% safe zone Android may crop to.
        ("icon-maskable-512.png", 512, 0.48),
    ]
    for name, size, inset in targets:
        write_png(OUT_DIR / name, size, render(size, inset))
        print(f"  {name}  {size}x{size}")
    print(f"Icons written to {OUT_DIR}")


if __name__ == "__main__":
    main()
