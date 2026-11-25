import assert from "node:assert/strict";
import test from "node:test";

import { findActiveSystemShortcutConflict } from "./activeKeyBindings.ts";
import { DEFAULT_KEY_BINDINGS, matchesKeyBinding } from "./models/keyBindings.ts";
import { getAppLevelActions } from "../application/state/useGlobalHotkeys.ts";

test("reopen-closed-tab defaults to Cmd+Shift+T on macOS and Ctrl+Shift+T on PC without conflicts", () => {
  const binding = DEFAULT_KEY_BINDINGS.find((entry) => entry.id === "reopen-closed-tab");
  assert.ok(binding, "reopen-closed-tab must exist in DEFAULT_KEY_BINDINGS");
  assert.equal(binding.action, "reopenClosedTab");
  assert.equal(binding.category, "tabs");
  assert.equal(binding.mac, "⌘ + Shift + T");
  assert.equal(binding.pc, "Ctrl + Shift + T");

  assert.deepEqual(
    DEFAULT_KEY_BINDINGS.filter((entry) => entry.mac === binding.mac).map((entry) => entry.id),
    ["reopen-closed-tab"],
  );
  assert.deepEqual(
    DEFAULT_KEY_BINDINGS.filter((entry) => entry.pc === binding.pc).map((entry) => entry.id),
    ["reopen-closed-tab"],
  );

  assert.equal(
    findActiveSystemShortcutConflict("⌘ + Shift + T", "mac", DEFAULT_KEY_BINDINGS)?.id,
    "reopen-closed-tab",
  );
  assert.equal(
    findActiveSystemShortcutConflict("Ctrl + Shift + T", "pc", DEFAULT_KEY_BINDINGS)?.id,
    "reopen-closed-tab",
  );

  assert.equal(
    matchesKeyBinding(
      { key: "T", code: "KeyT", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true } as KeyboardEvent,
      binding.mac,
      true,
    ),
    true,
  );
  assert.equal(
    matchesKeyBinding(
      { key: "T", code: "KeyT", metaKey: false, ctrlKey: true, altKey: false, shiftKey: true } as KeyboardEvent,
      binding.pc,
      false,
    ),
    true,
  );
  assert.equal(
    matchesKeyBinding(
      { key: "t", code: "KeyT", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false } as KeyboardEvent,
      binding.mac,
      true,
    ),
    false,
  );
});

test("reopenClosedTab is registered as an app-level action", () => {
  assert.equal(getAppLevelActions().has("reopenClosedTab"), true);
});
