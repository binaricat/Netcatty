const path = require("node:path");
const fs = require("node:fs");

function hslToHex(h, s, l) {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.max(0, Math.min(100, s)) / 100;
  const light = Math.max(0, Math.min(100, l)) / 100;

  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;

  let r1 = 0;
  let g1 = 0;
  let b1 = 0;

  if (hue < 60) {
    r1 = c; g1 = x; b1 = 0;
  } else if (hue < 120) {
    r1 = x; g1 = c; b1 = 0;
  } else if (hue < 180) {
    r1 = 0; g1 = c; b1 = x;
  } else if (hue < 240) {
    r1 = 0; g1 = x; b1 = c;
  } else if (hue < 300) {
    r1 = x; g1 = 0; b1 = c;
  } else {
    r1 = c; g1 = 0; b1 = x;
  }

  const toHex = (n) => Math.round((n + m) * 255).toString(16).padStart(2, "0");
  return `#${toHex(r1)}${toHex(g1)}${toHex(b1)}`;
}

function normalizeBackgroundColor(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (raw.startsWith("#")) return raw;

  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length < 3) return null;
  const h = Number(parts[0]);
  const s = Number(String(parts[1]).replace("%", ""));
  const l = Number(String(parts[2]).replace("%", ""));
  if (!Number.isFinite(h) || !Number.isFinite(s) || !Number.isFinite(l)) return null;
  return hslToHex(h, s, l);
}

function parseBackgroundFromIndexHtml(indexHtml, theme) {
  if (!indexHtml) return null;

  const block =
    theme === "dark"
      ? indexHtml.match(/\.dark\s*\{[\s\S]*?\}/)
      : indexHtml.match(/:root\s*\{[\s\S]*?\}/);

  const within = block?.[0] || indexHtml;
  const m = within.match(/--background:\s*([^;]+);/);
  const raw = m?.[1]?.trim();
  if (!raw) return null;

  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length < 3) return null;

  const h = Number(parts[0]);
  const s = Number(String(parts[1]).replace("%", ""));
  const l = Number(String(parts[2]).replace("%", ""));

  if (!Number.isFinite(h) || !Number.isFinite(s) || !Number.isFinite(l)) return null;
  return hslToHex(h, s, l);
}

function resolveIndexHtmlPath(electronDir) {
  const dist = path.join(electronDir, "../dist/index.html");
  const root = path.join(electronDir, "../index.html");
  if (fs.existsSync(dist)) return dist;
  if (fs.existsSync(root)) return root;
  return dist;
}

function resolveFrontendBackgroundColor(electronDir, theme) {
  try {
    const htmlPath = resolveIndexHtmlPath(electronDir);
    if (!htmlPath || !fs.existsSync(htmlPath)) return null;
    const indexHtml = fs.readFileSync(htmlPath, "utf8");
    return parseBackgroundFromIndexHtml(indexHtml, theme);
  } catch {
    return null;
  }
}


module.exports = {
  hslToHex,
  normalizeBackgroundColor,
  parseBackgroundFromIndexHtml,
  resolveIndexHtmlPath,
  resolveFrontendBackgroundColor,
};
