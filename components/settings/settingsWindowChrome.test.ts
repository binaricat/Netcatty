import assert from "node:assert/strict";
import test from "node:test";
import { getSettingsWindowClassName } from "./settingsWindowChrome.ts";

test("frameless non-macOS settings windows have a themed outer border", () => {
  const classes = getSettingsWindowClassName(false).split(/\s+/);

  assert.ok(classes.includes("settings-window"));
  assert.ok(classes.includes("border"));
  assert.ok(classes.includes("border-border"));
});

test("macOS settings windows keep native chrome without a CSS outer border", () => {
  const classes = getSettingsWindowClassName(true).split(/\s+/);

  assert.ok(classes.includes("settings-window"));
  assert.ok(!classes.includes("border"));
  assert.ok(!classes.includes("border-border"));
});
