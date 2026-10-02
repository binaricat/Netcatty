import assert from "node:assert/strict";
import test from "node:test";

import {
  isPlainCtrlVPasteChord,
  matchesPlainCtrlVChord,
} from "./win32ClipboardHistoryPaste";

const keyboardEvent = (
  overrides: Partial<KeyboardEvent> = {},
): KeyboardEvent => ({
  key: "v",
  code: "KeyV",
  ctrlKey: true,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  repeat: false,
  ...overrides,
}) as KeyboardEvent;

test("plain Ctrl+V from the Windows clipboard history picker is claimed", () => {
  assert.equal(isPlainCtrlVPasteChord(keyboardEvent()), true);
});

test("plain Ctrl+V follows the physical V key on non-Latin layouts", () => {
  assert.equal(isPlainCtrlVPasteChord(keyboardEvent({ key: "м" })), true);
});

test("Ctrl+Shift+V stays the configured paste binding", () => {
  assert.equal(isPlainCtrlVPasteChord(keyboardEvent({ key: "V", shiftKey: true })), false);
});

test("chords with extra modifiers are not clipboard history pastes", () => {
  assert.equal(isPlainCtrlVPasteChord(keyboardEvent({ altKey: true })), false);
  assert.equal(isPlainCtrlVPasteChord(keyboardEvent({ metaKey: true })), false);
  assert.equal(isPlainCtrlVPasteChord(keyboardEvent({ ctrlKey: false })), false);
});

test("auto-repeat keydowns are not claimed to avoid paste spam", () => {
  assert.equal(isPlainCtrlVPasteChord(keyboardEvent({ repeat: true })), false);
});

test("auto-repeat keydowns still match the chord so the keydown claim can consume them", () => {
  assert.equal(matchesPlainCtrlVChord(keyboardEvent({ repeat: true })), true);
  assert.equal(matchesPlainCtrlVChord(keyboardEvent({ shiftKey: true, repeat: true })), false);
});

test("other Ctrl chords are untouched", () => {
  assert.equal(isPlainCtrlVPasteChord(keyboardEvent({ key: "c", code: "KeyC" })), false);
});
