import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  parseScriptsViewMode,
  SCRIPTS_VIEW_MODE_STORAGE_KEY,
} from "./useScriptsViewMode.ts";

test("scripts view mode parser only accepts 'stacked'", () => {
  assert.equal(parseScriptsViewMode("stacked"), "stacked");
  assert.equal(parseScriptsViewMode("list"), "list");
  assert.equal(parseScriptsViewMode("grid"), "list");
  assert.equal(parseScriptsViewMode(null), "list");
  assert.equal(parseScriptsViewMode(""), "list");
});

test("scripts view mode hook persists the chosen mode", () => {
  const source = readFileSync(new URL("./useScriptsViewMode.ts", import.meta.url), "utf8");
  assert.match(source, /useStoredString/);
  // The shared hook owns persistence and same-/cross-window subscriptions.
  assert.match(
    source,
    /useStoredString\(SCRIPTS_VIEW_MODE_STORAGE_KEY, "list", isScriptsViewMode\)/,
  );
  assert.equal(SCRIPTS_VIEW_MODE_STORAGE_KEY.startsWith("netcatty:"), true);
});