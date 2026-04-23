#!/usr/bin/env python3
"""Generate public/tray-icon.ico from public/icon-win.png with multiple
sizes so Windows can pick the right pixel dimensions per DPI scale.

Sizes mirror what Explorer requests for the notification area on typical
DPI scale factors (100/125/150/175/200/250/300/400 %):
    16, 20, 24, 32, 40, 48, 64

Run: python3 scripts/generate-tray-ico.py
Requires: Pillow (pip install Pillow)
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "public" / "icon-win.png"
OUT = ROOT / "public" / "tray-icon.ico"
SIZES = [(16, 16), (20, 20), (24, 24), (32, 32), (40, 40), (48, 48), (64, 64)]


def main() -> None:
    if not SOURCE.exists():
        raise SystemExit(f"source icon not found: {SOURCE}")
    src = Image.open(SOURCE).convert("RGBA")
    src.save(OUT, format="ICO", sizes=SIZES)
    print(f"wrote {OUT.relative_to(ROOT)} ({', '.join(f'{w}x{h}' for w, h in SIZES)})")


if __name__ == "__main__":
    main()
