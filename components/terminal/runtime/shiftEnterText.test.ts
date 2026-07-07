import test from "node:test";
import assert from "node:assert/strict";

import {
  decodeTerminalTextEscapes,
  resolveShiftEnterText,
  shouldSendShiftEnterText,
} from "./shiftEnterText";

const keyEvent = (overrides: Partial<KeyboardEvent> = {}) => ({
  type: "keydown",
  key: "Enter",
  shiftKey: true,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  isComposing: false,
  ...overrides,
}) as KeyboardEvent;

test("shift enter text defaults to newline", () => {
  assert.equal(resolveShiftEnterText(), "\n");
});

test("shift enter text decodes newline, tab, carriage return, and backslash escapes", () => {
  assert.equal(
    decodeTerminalTextEscapes("line\\nnext\\tindent\\rreturn\\\\slash"),
    "line\nnext\tindent\rreturn\\slash",
  );
});

test("shift enter text can represent Tabby-style shell continuation", () => {
  assert.equal(decodeTerminalTextEscapes(" \\\\\\n"), " \\\n");
});

test("shift enter handler only matches plain Shift+Enter keydown", () => {
  assert.equal(shouldSendShiftEnterText(keyEvent()), true);
  assert.equal(shouldSendShiftEnterText(keyEvent({ type: "keyup" })), false);
  assert.equal(shouldSendShiftEnterText(keyEvent({ key: "NumpadEnter" })), false);
  assert.equal(shouldSendShiftEnterText(keyEvent({ ctrlKey: true })), false);
  assert.equal(shouldSendShiftEnterText(keyEvent({ metaKey: true })), false);
  assert.equal(shouldSendShiftEnterText(keyEvent({ altKey: true })), false);
  assert.equal(shouldSendShiftEnterText(keyEvent({ shiftKey: false })), false);
  assert.equal(shouldSendShiftEnterText(keyEvent({ isComposing: true })), false);
});

test("shift enter handler respects the terminal setting toggle", () => {
  assert.equal(
    shouldSendShiftEnterText(keyEvent(), { shiftEnterNewlineEnabled: false }),
    false,
  );
});
