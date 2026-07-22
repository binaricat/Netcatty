import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  decodeTerminalTextEscapes,
  getShiftEnterSubmittedInput,
  isShiftEnterLineContinuationText,
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

test("shift enter continuation detection only matches backslash-newline endings", () => {
  assert.equal(isShiftEnterLineContinuationText(" \\\n"), true);
  assert.equal(isShiftEnterLineContinuationText(" \\\r\n"), true);
  assert.equal(isShiftEnterLineContinuationText(" \\\r"), true);
  assert.equal(isShiftEnterLineContinuationText("foo\n"), false);
  assert.equal(isShiftEnterLineContinuationText("\r\n"), false);
});

test("shift enter submitted input detects single command text with a line ending", () => {
  assert.deepEqual(getShiftEnterSubmittedInput("\n"), {
    text: "",
    lineEnding: "\n",
  });
  assert.deepEqual(getShiftEnterSubmittedInput("\r\n"), {
    text: "",
    lineEnding: "\r\n",
  });
  assert.deepEqual(getShiftEnterSubmittedInput("sudo whoami\n"), {
    text: "sudo whoami",
    lineEnding: "\n",
  });
  assert.equal(getShiftEnterSubmittedInput(" \\\n"), null);
  assert.equal(getShiftEnterSubmittedInput("foo\nbar\n"), null);
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

test("runtime routes Shift+Enter text through the shared input handler", () => {
  const source = readFileSync(
    new URL("./createXTermRuntime.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /const handleTerminalInputData = \(\s+data: string,\s+options\?: \{ source\?: "terminal" \| "shift-enter" \| "kitty" \},\s+\) => \{/s,
  );
  assert.match(
    source,
    /if \(textToSend\) \{\s+handleTerminalInputData\(textToSend, \{ source: "shift-enter" \}\);/s,
  );
  assert.match(
    source,
    /!isKittyKeyboardModeActive\(kittyKeyboardMode\) &&\s+shouldSendShiftEnterText/,
  );
  assert.match(source, /getShiftEnterSubmittedInput\(data\)/);
  assert.match(source, /inputSource !== "shift-enter"/);
  assert.match(
    source,
    /if \(shouldSendShiftEnterText\(e, ctx\.terminalSettingsRef\.current\)\) \{\s+sudoAutofill\.cancelHint\(\);/s,
  );
  assert.match(
    source,
    /term\.onData\(\(data\) => \{[\s\S]*handleTerminalInputData\(data\);\s+\}\);/,
  );
  assert.match(
    source,
    /const encoded = encodeKittyCompositionText\(kittyKeyboardMode, data\);[\s\S]*if \(encoded\) \{[\s\S]*handleTerminalInputData\(encoded, \{ source: "kitty" \}\);[\s\S]*\} else \{[\s\S]*handleTerminalInputData\(data\);[\s\S]*broadcastKittyInput\(\{ kind: "text", text: data \}\);/,
  );
  assert.match(source, /ctx\.container\.addEventListener\("input", markKittyTextInput, true\);/);
  assert.match(
    source,
    /if \(shouldMarkKittyTextInputEvent\(event\)\) markKittyCompositionPending\(true\);/,
  );
  assert.match(
    source,
    /flushKittyKeyboardBroadcastReleases\(\s+kittyForwardedKeys,[\s\S]*encodeKittyKeyEvent\(kittyKeyboardMode, input\.event\)[\s\S]*handleTerminalInputData\(sequence, \{ source: "kitty" \}\)/,
  );
  assert.doesNotMatch(source, /writeToSession\(id, textToSend\)/);
});
