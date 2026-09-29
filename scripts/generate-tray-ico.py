#!/usr/bin/env python3
"""Generate the Windows/Linux tray assets from the flat cat glyph.

Sources are the macOS template masks (public/tray-iconTemplate*.png):
a single-color cat glyph that fills its canvas with transparent corners.

The old assets were the rounded-square app icon (navy chip with a small cat
inside), which rendered as a tiny, low-contrast blob in the notification area
on dark taskbars. Tray apps are expected to ship a full-bleed single-color
glyph instead, so we recolor the template mask with the brand sky blue
(#0ea5e9 - the same color as the "bright" app-icon variant) which stays
readable on both dark and light taskbars.

Outputs (all in public/):
    tray-icon.png      22x22 colored glyph     (Linux base)
    tray-icon@2x.png   44x44 colored glyph     (Linux HiDPI representation)
    tray-icon.ico      16/20/24/32/40/48/64    (Windows picks one per DPI)

Sizes mirror what Explorer requests for the notification area on typical
DPI scale factors (100/125/150/175/200/250/300/400 %).

Run: python3 scripts/generate-tray-ico.py
Requires: Pillow (pip install Pillow)
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "public" / "tray-iconTemplate.png"
TEMPLATE_2X = ROOT / "public" / "tray-iconTemplate@2x.png"
OUT_PNG = ROOT / "public" / "tray-icon.png"
OUT_PNG_2X = ROOT / "public" / "tray-icon@2x.png"
OUT_ICO = ROOT / "public" / "tray-icon.ico"
SIZES = [(16, 16), (20, 20), (24, 24), (32, 32), (40, 40), (48, 48), (64, 64)]

# Brand sky blue, sampled from public/icons/variants/bright.png.
BRAND_RGB = (14, 165, 233)


def recolor_template(template_path: Path, out_path: Path) -> None:
    """Turn the black template glyph into a flat brand-colored glyph."""
    if not template_path.exists():
        raise SystemExit(f"template not found: {template_path}")
    glyph = Image.open(template_path).convert("RGBA")
    pixels = glyph.load()
    width, height = glyph.size
    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            if r == 0 and g == 0 and b == 0:
                pixels[x, y] = (*BRAND_RGB, a)
            elif a != 0:
                # Antialiased leftovers: keep the stored luminance so soft
                # edges stay soft instead of snapping to full saturation.
                gray = (r + g + b) // 3
                pixels[x, y] = (
                    (BRAND_RGB[0] * gray) // 255,
                    (BRAND_RGB[1] * gray) // 255,
                    (BRAND_RGB[2] * gray) // 255,
                    a,
                )
    glyph.save(out_path, format="PNG")
    print(f"wrote {out_path.relative_to(ROOT)} ({glyph.size[0]}x{glyph.size[1]})")


def main() -> None:
    recolor_template(TEMPLATE, OUT_PNG)
    recolor_template(TEMPLATE_2X, OUT_PNG_2X)

    source = Image.open(OUT_PNG_2X).convert("RGBA")
    # The 44px glyph can only produce entries <= 44px; Pillow drops anything
    # larger. Upscale to the biggest request first so the high-DPI entries
    # for 300/400 % scaling (48/64) are real resamples instead of silently
    # missing from the .ico directory.
    largest = max(SIZES)[0]
    if largest > source.size[0]:
        source = source.resize((largest, largest), Image.LANCZOS)
    source.save(OUT_ICO, format="ICO", sizes=SIZES)
    print(f"wrote {OUT_ICO.relative_to(ROOT)} ({', '.join(f'{w}x{h}' for w, h in SIZES)})")


if __name__ == "__main__":
    main()
