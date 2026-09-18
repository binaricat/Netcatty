import assert from "node:assert/strict";
import test from "node:test";

import {
  isMacCommandPeriodInterruptChord,
  shouldUseUrgentTerminalInterrupt,
} from "./terminalInterruptShortcut";

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

test("mac Command+Period chord is recognized as an interrupt", () => {
  assert.equal(
    isMacCommandPeriodInterruptChord(key({ key: ".", code: "Period", ctrlKey: false, metaKey: true })),
    true,
  );
  // Non-Latin layouts may report the physical Period code with a mapped key.
  assert.equal(
    isMacCommandPeriodInterruptChord(key({ key: "\u3002", code: "Period", ctrlKey: false, metaKey: true })),
    true,
  );
});

test("mac Command+Period chord requires Meta and rejects Ctrl or Alt", () => {
  const chord = { key: ".", code: "Period", ctrlKey: false, metaKey: true };
  assert.equal(isMacCommandPeriodInterruptChord(key({ ...chord, shiftKey: true })), true);
  assert.equal(isMacCommandPeriodInterruptChord(key({ ...chord, altKey: true })), false);
  assert.equal(isMacCommandPeriodInterruptChord(key({ ...chord, ctrlKey: true })), false);
  assert.equal(isMacCommandPeriodInterruptChord(key({ key: ".", code: "Period", metaKey: false })), false);
});

test("mac Command+Period chord prefers the layout character over the physical key", () => {
  assert.equal(
    isMacCommandPeriodInterruptChord(key({ key: ",", code: "Period", ctrlKey: false, metaKey: true })),
    false,
  );
  assert.equal(
    isMacCommandPeriodInterruptChord(key({ key: ".", code: "KeyJ", ctrlKey: false, metaKey: true })),
    true,
  );
  assert.equal(
    isMacCommandPeriodInterruptChord(key({ key: "\u044e", code: "Period", ctrlKey: false, metaKey: true })),
    true,
  );
});

test("mac Command+Period accepts Shift when it produces the logical period", () => {
  assert.equal(isMacCommandPeriodInterruptChord(key({
    key: ".", code: "Semicolon", ctrlKey: false, metaKey: true, shiftKey: true,
  })), true);
  assert.equal(isMacCommandPeriodInterruptChord(key({
    key: ">", code: "Period", ctrlKey: false, metaKey: true, shiftKey: true,
  })), false);
  assert.equal(isMacCommandPeriodInterruptChord(key({
    key: "\u3002", code: "Period", ctrlKey: false, metaKey: true, shiftKey: true,
  })), false);
});
