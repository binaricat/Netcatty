"use strict";
// Pure color projection. Package/wire schema validation belongs to the host.
const LIGHT = Object.freeze({
  background: "#ffffff",
  foreground: "#161a1d",
  card: "#ffffff",
  cardForeground: "#161a1d",
  popover: "#ffffff",
  popoverForeground: "#161a1d",
  secondary: "#e5e7eb",
  secondaryForeground: "#161a1d",
  muted: "#f0f2f4",
  mutedForeground: "#374151",
  accent: "#1d4ed8",
  destructive: "#b91c1c",
  destructiveForeground: "#ffffff",
  border: "#6b7280",
  input: "#6b7280",
});
const DARK = Object.freeze({
  background: "#111827",
  foreground: "#f9fafb",
  card: "#1f2937",
  cardForeground: "#f9fafb",
  popover: "#1f2937",
  popoverForeground: "#f9fafb",
  secondary: "#374151",
  secondaryForeground: "#ffffff",
  muted: "#273244",
  mutedForeground: "#e5e7eb",
  accent: "#93c5fd",
  destructive: "#fca5a5",
  destructiveForeground: "#111827",
  border: "#9ca3af",
  input: "#9ca3af",
});
function rgb(hex) {
  return [1, 3, 5].map(
    (offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255,
  );
}
function luminance(hex) {
  return rgb(hex)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
}
function contrast(a, b) {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function toHsl(hex) {
  const [r, g, b] = rgb(hex),
    max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    delta = max - min,
    l = (max + min) / 2;
  let h = 0;
  if (delta)
    h =
      (max === r
        ? ((g - b) / delta + 6) % 6
        : max === g
          ? (b - r) / delta + 2
          : (r - g) / delta + 4) * 60;
  const s = delta ? delta / (1 - Math.abs(2 * l - 1)) : 0;
  return `${h.toFixed(3)} ${(s * 100).toFixed(3)}% ${(l * 100).toFixed(3)}%`;
}
// A small margin covers rounding when hex colors become HSL CSS components.
function resolveThemePalette(palette) {
  const colors = {
    ...(palette.base === "dark" ? DARK : LIGHT),
    ...palette.colors,
  };
  for (const value of Object.values(colors))
    if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error("Invalid theme color");
  const pairs = [
    ["foreground", "background"],
    ["cardForeground", "card"],
    ["popoverForeground", "popover"],
    ["secondaryForeground", "secondary"],
    ["mutedForeground", "muted"],
    ["destructiveForeground", "destructive"],
  ];
  for (const [a, b] of pairs)
    if (contrast(colors[a], colors[b]) < 4.51)
      throw new Error("Theme text contrast is below 4.5:1");
  // Host labels and descriptions reuse these text tokens across neutral
  // surfaces; they do not always sit on their namesake background token.
  for (const surface of ["background", "card", "popover", "secondary", "muted"])
    for (const key of ["foreground", "mutedForeground"])
      if (contrast(colors[key], colors[surface]) < 4.51)
        throw new Error("Theme neutral-surface text contrast is below 4.5:1");
  for (const surface of ["background", "card", "popover"]) {
    for (const key of ["accent", "destructive"])
      if (contrast(colors[key], colors[surface]) < 4.51)
        throw new Error("Theme state contrast is below 4.5:1");
    for (const key of ["border", "input"])
      if (contrast(colors[key], colors[surface]) < 3.01)
        throw new Error("Theme control contrast is below 3:1");
  }
  const foreground =
    contrast(colors.accent, "#000000") >= contrast(colors.accent, "#ffffff")
      ? "#000000"
      : "#ffffff";
  const tokens = Object.fromEntries(
    Object.entries(colors).map(([k, v]) => [k, toHsl(v)]),
  );
  return Object.freeze({
    ...tokens,
    primary: tokens.accent,
    primaryForeground: toHsl(foreground),
    accentForeground: toHsl(foreground),
    ring: tokens.accent,
  });
}
function securityThemeTokens(mode, highContrast = false) {
  const colors = highContrast
    ? mode === "dark"
      ? {
          background: "#000000",
          card: "#000000",
          popover: "#000000",
          foreground: "#ffffff",
          cardForeground: "#ffffff",
          popoverForeground: "#ffffff",
          accent: "#ffff00",
          border: "#ffffff",
          input: "#ffffff",
        }
      : {
          background: "#ffffff",
          card: "#ffffff",
          popover: "#ffffff",
          foreground: "#000000",
          cardForeground: "#000000",
          popoverForeground: "#000000",
          accent: "#000080",
          border: "#000000",
          input: "#000000",
        }
    : {};
  return resolveThemePalette({ base: mode, colors });
}
module.exports = { resolveThemePalette, securityThemeTokens, contrast, toHsl };
