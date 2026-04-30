import test from "node:test";
import assert from "node:assert/strict";

import { applyCustomAccentToTerminalTheme } from "./terminalAppearance";
import type { TerminalTheme } from "./models";

const baseTheme: TerminalTheme = {
  id: "ui-snow",
  name: "Snow",
  type: "light",
  colors: {
    background: "#f1f4f8",
    foreground: "#24292f",
    cursor: "#0969da",
    selection: "#add6ff",
    black: "#24292f",
    red: "#cf222e",
    green: "#116329",
    yellow: "#9a6700",
    blue: "#0969da",
    magenta: "#8250df",
    cyan: "#0e7574",
    white: "#6e7781",
    brightBlack: "#57606a",
    brightRed: "#a40e26",
    brightGreen: "#1a7f37",
    brightYellow: "#7d4e00",
    brightBlue: "#218bff",
    brightMagenta: "#a475f9",
    brightCyan: "#0c7875",
    brightWhite: "#8c959f",
  },
};

test("applies a custom accent to terminal cursor and selection colors", () => {
  const accented = applyCustomAccentToTerminalTheme(baseTheme, "custom", "160 70% 40%");

  assert.notEqual(accented, baseTheme);
  assert.equal(accented.colors.cursor, "#1fad7e");
  assert.equal(accented.colors.selection, "#b1f1dc");
  assert.equal(baseTheme.colors.cursor, "#0969da");
  assert.equal(baseTheme.colors.selection, "#add6ff");
});

test("keeps terminal theme unchanged without a valid custom accent", () => {
  assert.equal(applyCustomAccentToTerminalTheme(baseTheme, "theme", "160 70% 40%"), baseTheme);
  assert.equal(applyCustomAccentToTerminalTheme(baseTheme, "custom", "not-a-color"), baseTheme);
});
