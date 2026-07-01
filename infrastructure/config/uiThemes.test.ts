import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DARK_UI_THEMES,
  EXTENDED_DARK_UI_THEMES,
  EXTENDED_LIGHT_UI_THEMES,
  LIGHT_UI_THEMES,
  getUiThemeById,
} from "./uiThemes";
import { TERMINAL_THEMES } from "./terminalThemes";

const SYSTEM_PRESET_THEME_IDS = [
  "a-cup-of-coffee",
  "abolkog",
  "aurora",
  "ayu",
  "base16-flat",
  "base16-mocha",
  "blue-dolphin",
  "calm-days-sober-nights-sky",
  "catppuccin",
  "chai",
  "chinolor",
  "cyberdyne",
  "desert",
  "django-reborn-again",
  "espresso",
  "eyehealth",
  "flexoki",
  "fox",
  "garbage-oracle",
  "github",
  "gruvbox-material",
  "homebrew",
  "ic-orange-ppl",
  "ikki",
  "kanso-ink",
  "kary-pro-colors",
  "light-purple",
  "mondrian",
  "monochrome",
  "monochrome-stone",
  "monokai-pro-spectrum",
  "monospace",
  "noctis-azureus",
  "noctis-hibernus",
  "noir-essence",
  "nord-midnight",
  "notionish",
  "phonebook",
  "polychrome",
  "purplepeter",
  "rainglow-codecourse",
  "rainglow-crisp",
  "rainglow-lavender",
  "remedy-tilted",
  "rose-pine",
  "selene-selenized",
  "soft-color",
  "tearout",
  "tokyo-night",
  "tomorrow-night-eighties",
  "vaporizer-turquoise",
  "xotopio",
  "yuttari",
  "zenbones-rosebones",
  "zhxo-red",
];

describe("system preset UI themes", () => {
  it("adds every imported preset at the same level as the existing UI themes", () => {
    assert.deepEqual(EXTENDED_LIGHT_UI_THEMES.map((theme) => theme.id), SYSTEM_PRESET_THEME_IDS);
    assert.deepEqual(EXTENDED_DARK_UI_THEMES.map((theme) => theme.id), SYSTEM_PRESET_THEME_IDS);

    for (const id of SYSTEM_PRESET_THEME_IDS) {
      assert.equal(getUiThemeById("light", id).id, id);
      assert.equal(getUiThemeById("dark", id).id, id);
    }

    assert.equal(EXTENDED_LIGHT_UI_THEMES.length, 55);
    assert.equal(EXTENDED_DARK_UI_THEMES.length, 55);
    assert.equal(LIGHT_UI_THEMES.length, 7 + 55);
    assert.equal(DARK_UI_THEMES.length, 7 + 55);
    assert.equal([...LIGHT_UI_THEMES, ...DARK_UI_THEMES].filter((theme) => theme.collection !== undefined && theme.collection !== "core").length, 0);
  });

  it("keeps theme accents distinct from the original default blue", () => {
    const originalDefaultBlue = "221.2 83.2% 53.3%";
    const accents = new Set([
      ...EXTENDED_LIGHT_UI_THEMES.map((theme) => theme.tokens.accent),
      ...EXTENDED_DARK_UI_THEMES.map((theme) => theme.tokens.accent),
    ]);

    assert.ok(accents.size > 20);
    assert.ok(!accents.has(originalDefaultBlue));
  });

  it("adds matching terminal themes for every imported light and dark UI preset", () => {
    const terminalThemeIds = new Set(TERMINAL_THEMES.map((theme) => theme.id));
    assert.equal(terminalThemeIds.size, TERMINAL_THEMES.length);

    for (const id of SYSTEM_PRESET_THEME_IDS) {
      const lightTerminalTheme = TERMINAL_THEMES.find((theme) => theme.id === `system-${id}-light`);
      const darkTerminalTheme = TERMINAL_THEMES.find((theme) => theme.id === `system-${id}-dark`);

      assert.equal(lightTerminalTheme?.type, "light", id);
      assert.equal(darkTerminalTheme?.type, "dark", id);
    }
  });
});
