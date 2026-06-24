import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");

test("follow-app terminal theme selection reads the latest custom theme store", () => {
  assert.match(source, /customThemeStore\.getThemeById\(themeId\)/);
  assert.doesNotMatch(source, /const selectedTheme = themeById\.get\(themeId\)/);
});
