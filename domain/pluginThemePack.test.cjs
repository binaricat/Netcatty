const assert = require("node:assert/strict");
const test = require("node:test");
const {
  resolveThemePalette,
  securityThemeTokens,
  contrast,
} = require("./pluginThemePack.cjs");
test("opaque accessible palettes derive coupled accent tokens and fixed high contrast fallback", () => {
  for (const mode of ["light", "dark"]) {
    const tokens = resolveThemePalette({ base: mode, colors: {} });
    assert.equal(tokens.primary, tokens.accent);
    assert.equal(tokens.ring, tokens.accent);
    assert.equal(tokens.primaryForeground, tokens.accentForeground);
    assert.ok(securityThemeTokens(mode, true));
  }
  assert.ok(contrast("#000000", "#ffffff") > 20);
  assert.throws(
    () =>
      resolveThemePalette({ base: "light", colors: { foreground: "#ffffff" } }),
    /contrast/,
  );
});

test("generic and muted text stay readable on the neutral surfaces that use them", () => {
  for (const colors of [
    { muted: "#000000", mutedForeground: "#ffffff" },
    { card: "#000000", cardForeground: "#ffffff" },
    { popover: "#000000", popoverForeground: "#ffffff" },
    { secondary: "#000000", secondaryForeground: "#ffffff" },
  ]) {
    assert.throws(() => resolveThemePalette({ base: "light", colors }), /contrast/);
  }
});
