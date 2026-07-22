import assert from "node:assert/strict";
import test from "node:test";

import { shouldUseUrgentTerminalInterrupt } from "./terminalInterruptShortcut";

function key(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: "c",
    code: "KeyC",
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  } as KeyboardEvent;
}

test("urgent interrupt handles plain Ctrl+C with no selection", () => {
  assert.equal(shouldUseUrgentTerminalInterrupt(key(), { hasSelection: false }), true);
});

test("urgent interrupt follows the physical C key on non-Latin layouts", () => {
  assert.equal(shouldUseUrgentTerminalInterrupt(key({ key: "с" }), { hasSelection: false }), true);
});

test("urgent interrupt prefers an active ASCII layout character over its physical key", () => {
  assert.equal(
    shouldUseUrgentTerminalInterrupt(key({ key: "c", code: "KeyJ" }), { hasSelection: false }),
    true,
  );
  assert.equal(
    shouldUseUrgentTerminalInterrupt(key({ key: "j", code: "KeyC" }), { hasSelection: false }),
    false,
  );
});

test("urgent interrupt leaves copy shortcuts and modified chords alone", () => {
  assert.equal(shouldUseUrgentTerminalInterrupt(key(), { hasSelection: true }), false);
  assert.equal(shouldUseUrgentTerminalInterrupt(key({ shiftKey: true }), { hasSelection: false }), false);
  assert.equal(shouldUseUrgentTerminalInterrupt(key({ metaKey: true }), { hasSelection: false }), false);
  assert.equal(shouldUseUrgentTerminalInterrupt(key({ altKey: true }), { hasSelection: false }), false);
});
