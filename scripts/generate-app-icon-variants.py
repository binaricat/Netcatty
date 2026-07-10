#!/usr/bin/env python3
"""Generate runtime app icon variants from public/icon.svg.

Outputs desktop PNGs under public/icons/variants/ and HIG-sized macOS PNGs
under public/icons/variants/macos/ for Electron dock/taskbar switching.
Run: python3 scripts/generate-app-icon-variants.py
Requires: rsvg-convert (librsvg)
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_SVG = ROOT / "public" / "icon.svg"
OUT_DIR = ROOT / "public" / "icons" / "variants"
MACOS_OUT_DIR = OUT_DIR / "macos"
MACOS_RUNTIME_VIEWBOX = "0 0 1024 1024"

DETAIL_COLORS = [
    "#1f2657",
    "#18214c",
    "#0c1943",
    "#505c83",
    "#919ab0",
    "#022551",
    "#032551",
    "#0c1a4d",
    "#98a2bf",
    "#9ea6be",
    "#132152",
    "#6c7794",
    "#6f7b97",
    "#a8aec5",
    "#677393",
    "#01103f",
    "#7581a0",
    "#a7aec3",
    "#adb2c9",
    "#bec4d7",
    "#9ba0b8",
    "#9aa5bc",
    "#adb1c6",
    "#c9d0dc",
    "#b5bfcb",
    "#8193aa",
]

RAINBOW_GRADIENT = """
    <linearGradient id="netcatty-rainbow" x1="180" y1="1020" x2="1080" y2="260" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#EF4444"/>
      <stop offset="16%" stop-color="#F97316"/>
      <stop offset="33%" stop-color="#EAB308"/>
      <stop offset="50%" stop-color="#22C55E"/>
      <stop offset="66%" stop-color="#06B6D4"/>
      <stop offset="83%" stop-color="#3B82F6"/>
      <stop offset="100%" stop-color="#A855F7"/>
    </linearGradient>
"""

WHITE_BG = {
    "bg": "#FFFFFF",
    "border_color": "#CBD5E1",
    "border_opacity": "0.85",
}

WHITE_CAT_FACE = "#FFFFFF"

VARIANTS: dict[str, dict[str, str] | None] = {
    "original": None,
    "bright": {
        "bg": "#0EA5E9",
        "cat": "#FFFFFF",
        "cat_alt": "#F0F9FF",
        "detail": "#0369A1",
        "border_color": "#ffffff",
        "border_opacity": "0.55",
    },
    "dark": {
        "bg": "#0F172A",
        "cat": "#F8FAFC",
        "cat_alt": "#E2E8F0",
        "detail": "#334155",
        "border_color": "#ffffff",
        "border_opacity": "0.35",
    },
    "colorful": {
        "bg": "#EA580C",
        "cat": "#FFFFFF",
        "cat_alt": "#FFF7ED",
        "detail": "#C2410C",
        "border_color": "#ffffff",
        "border_opacity": "0.5",
    },
    "high-contrast": {
        "bg": "#000000",
        "cat": "#FACC15",
        "cat_alt": "#FDE047",
        "detail": "#A16207",
        "border_color": "#ffffff",
        "border_opacity": "0.9",
    },
    "white-navy": {
        **WHITE_BG,
        "cat": "#002551",
        "cat_alt": "#0B3D78",
        "detail": WHITE_CAT_FACE,
    },
    "white-sky": {
        **WHITE_BG,
        "cat": "#0284C7",
        "cat_alt": "#38BDF8",
        "detail": WHITE_CAT_FACE,
    },
    "white-rose": {
        **WHITE_BG,
        "cat": "#E11D48",
        "cat_alt": "#FB7185",
        "detail": WHITE_CAT_FACE,
    },
    "white-emerald": {
        **WHITE_BG,
        "cat": "#059669",
        "cat_alt": "#34D399",
        "detail": WHITE_CAT_FACE,
    },
    "white-amber": {
        **WHITE_BG,
        "cat": "#D97706",
        "cat_alt": "#FBBF24",
        "detail": WHITE_CAT_FACE,
    },
    "white-violet": {
        **WHITE_BG,
        "cat": "#7C3AED",
        "cat_alt": "#A78BFA",
        "detail": WHITE_CAT_FACE,
    },
    "rainbow": {
        **WHITE_BG,
        "mode": "rainbow",
        "detail": WHITE_CAT_FACE,
    },
}


def load_template() -> str:
    if not SOURCE_SVG.exists():
        raise SystemExit(f"source svg not found: {SOURCE_SVG}")
    return SOURCE_SVG.read_text(encoding="utf-8")


def set_viewbox(svg: str, viewbox: str) -> str:
    out, count = re.subn(r'viewBox="[^"]+"', f'viewBox="{viewbox}"', svg, count=1)
    if count != 1:
        raise SystemExit("source svg is missing a root viewBox")
    return out


def inject_rainbow_gradient(svg: str) -> str:
    if "id=\"netcatty-rainbow\"" in svg:
        return svg
    return svg.replace("<defs>", f"<defs>{RAINBOW_GRADIENT}", 1)


def apply_solid_variant(svg: str, spec: dict[str, str]) -> str:
    out = svg
    out = out.replace('fill="#002551"', f'fill="{spec["bg"]}"', 1)
    out = out.replace('fill="#f9f9f9"', f'fill="{spec["cat"]}"')
    out = out.replace('fill="#f8f8f9"', f'fill="{spec["cat_alt"]}"')
    for color in DETAIL_COLORS:
        out = out.replace(f'fill="{color}"', f'fill="{spec["detail"]}"')
    border_color = spec.get("border_color", "#ffffff")
    border_opacity = spec.get("border_opacity", "0.4")
    out = re.sub(
        r'stroke="#ffffff" stroke-opacity="[^"]+"',
        f'stroke="{border_color}" stroke-opacity="{border_opacity}"',
        out,
        count=1,
    )
    return out


def apply_rainbow_variant(svg: str, spec: dict[str, str]) -> str:
    out = inject_rainbow_gradient(svg)
    out = out.replace('fill="#002551"', f'fill="{spec["bg"]}"', 1)
    rainbow_fill = 'fill="url(#netcatty-rainbow)"'
    out = out.replace('fill="#f9f9f9"', rainbow_fill)
    out = out.replace('fill="#f8f8f9"', rainbow_fill)
    face_color = spec.get("detail", WHITE_CAT_FACE)
    for color in DETAIL_COLORS:
        out = out.replace(f'fill="{color}"', f'fill="{face_color}"')
    border_color = spec.get("border_color", "#CBD5E1")
    border_opacity = spec.get("border_opacity", "0.85")
    out = re.sub(
        r'stroke="#ffffff" stroke-opacity="[^"]+"',
        f'stroke="{border_color}" stroke-opacity="{border_opacity}"',
        out,
        count=1,
    )
    return out


def apply_variant(svg: str, spec: dict[str, str]) -> str:
    if spec.get("mode") == "rainbow":
        return apply_rainbow_variant(svg, spec)
    return apply_solid_variant(svg, spec)


def render_png(svg_content: str, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["rsvg-convert", "-w", "1024", "-h", "1024", "-o", str(target)],
        input=svg_content.encode("utf-8"),
        check=True,
    )


def main() -> None:
    desktop_template = load_template()
    macos_template = set_viewbox(desktop_template, MACOS_RUNTIME_VIEWBOX)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    MACOS_OUT_DIR.mkdir(parents=True, exist_ok=True)

    for variant_id, spec in VARIANTS.items():
        if spec is None:
            desktop_path = OUT_DIR / f"{variant_id}.png"
            render_png(desktop_template, desktop_path)
            print(f"wrote {desktop_path.relative_to(ROOT)}")

            macos_path = MACOS_OUT_DIR / f"{variant_id}.png"
            render_png(macos_template, macos_path)
            print(f"wrote {macos_path.relative_to(ROOT)}")
            continue
        desktop_path = OUT_DIR / f"{variant_id}.png"
        render_png(apply_variant(desktop_template, spec), desktop_path)
        print(f"wrote {desktop_path.relative_to(ROOT)}")

        macos_path = MACOS_OUT_DIR / f"{variant_id}.png"
        render_png(apply_variant(macos_template, spec), macos_path)
        print(f"wrote {macos_path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
