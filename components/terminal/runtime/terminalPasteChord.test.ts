import assert from "node:assert/strict";
import test from "node:test";

import { isPlainCtrlVPasteChord } from "./terminalPasteChord.ts";

const keyboardEvent = (
  key: string,
  code: string,
  modifiers: Partial<KeyboardEvent> = {},
): KeyboardEvent => ({
  key,
  code,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...modifiers,
}) as KeyboardEvent;

test("plain Ctrl+V is the dictation paste chord", () => {
  assert.equal(isPlainCtrlVPasteChord(keyboardEvent("v", "KeyV", { ctrlKey: true })), true);
  assert.equal(isPlainCtrlVPasteChord(keyboardEvent("V", "KeyV", { ctrlKey: true })), true);
});

test("plain Ctrl+V follows the physical V key on non-Latin layouts", () => {
  const event = keyboardEvent("м", "KeyV", { ctrlKey: true });

  assert.equal(isPlainCtrlVPasteChord(event), true);
});

test("Ctrl+V with extra modifiers or other keys is not the paste chord", () => {
  assert.equal(
    isPlainCtrlVPasteChord(keyboardEvent("v", "KeyV", { ctrlKey: true, shiftKey: true })),
    false,
  );
  assert.equal(
    isPlainCtrlVPasteChord(keyboardEvent("v", "KeyV", { ctrlKey: true, altKey: true })),
    false,
  );
  assert.equal(
    isPlainCtrlVPasteChord(keyboardEvent("v", "KeyV", { ctrlKey: true, metaKey: true })),
    false,
  );
  assert.equal(isPlainCtrlVPasteChord(keyboardEvent("c", "KeyC", { ctrlKey: true })), false);
  assert.equal(isPlainCtrlVPasteChord(keyboardEvent("v", "KeyV")), false);
  assert.equal(isPlainCtrlVPasteChord(keyboardEvent("v", "KeyV", { metaKey: true })), false);
});
