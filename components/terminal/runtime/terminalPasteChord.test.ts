import assert from "node:assert/strict";
import test from "node:test";

import { isPlainCtrlVPasteChord, shouldPastePlainCtrlV } from "./terminalPasteChord.ts";

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

test("Windows legacy input pastes, including SSH sessions", () => {
  assert.equal(shouldPastePlainCtrlV(keyboardEvent("v", "KeyV", { ctrlKey: true }), {
    platform: "win32",
    connected: true,
    kittySequenceForKeyDown: null,
    win32InputMode: false,
  }), true);
});

test("ConPTY Unix shells route Ctrl+V to paste while native Windows shells retain their key handling", () => {
  const event = keyboardEvent("v", "KeyV", { ctrlKey: true });
  const context = {
    platform: "win32" as const,
    connected: true,
    kittySequenceForKeyDown: null,
    win32InputMode: true,
  };
  for (const localShellType of ["posix", "fish"] as const) {
    assert.equal(shouldPastePlainCtrlV(event, { ...context, localShellType }), true, localShellType);
  }
  for (const localShellType of ["cmd", "powershell", "unknown"] as const) {
    assert.equal(shouldPastePlainCtrlV(event, { ...context, localShellType }), false, localShellType);
  }
  assert.equal(shouldPastePlainCtrlV(event, context), false);
});

test("other platforms, negotiated Kitty keys, composition and disconnected sessions keep their key path", () => {
  const event = keyboardEvent("v", "KeyV", { ctrlKey: true });
  const context = {
    platform: "win32" as const,
    connected: true,
    kittySequenceForKeyDown: null,
    win32InputMode: false,
  };
  assert.equal(shouldPastePlainCtrlV(event, { ...context, platform: "linux" }), false);
  assert.equal(shouldPastePlainCtrlV(event, { ...context, platform: "darwin" }), false);
  assert.equal(shouldPastePlainCtrlV(event, { ...context, kittySequenceForKeyDown: "sequence" }), false);
  assert.equal(shouldPastePlainCtrlV(event, { ...context, connected: false }), false);
  assert.equal(shouldPastePlainCtrlV(keyboardEvent("v", "KeyV", {
    ctrlKey: true,
    isComposing: true,
  }), context), false);
  assert.equal(shouldPastePlainCtrlV(keyboardEvent("Process", "KeyV", {
    ctrlKey: true,
    keyCode: 229,
  }), context), false);
});
