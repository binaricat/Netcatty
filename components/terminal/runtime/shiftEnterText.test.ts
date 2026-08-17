import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  decodeTerminalTextEscapes,
  doesKittyEncodingPreserveShiftEnter,
  getShiftEnterSubmittedInput,
  isBareShiftEnterLineEnding,
  isShiftEnterLineContinuationText,
  resolveShiftEnterPayload,
  resolveShiftEnterText,
  SHIFT_ENTER_CSI_U_SEQUENCE,
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

test("bare line-ending Shift+Enter text is detected for TUI passthrough", () => {
  assert.equal(isBareShiftEnterLineEnding("\n"), true);
  assert.equal(isBareShiftEnterLineEnding("\r"), true);
  assert.equal(isBareShiftEnterLineEnding("\r\n"), true);
  assert.equal(isBareShiftEnterLineEnding(" \\\n"), false);
  assert.equal(isBareShiftEnterLineEnding("sudo whoami\n"), false);
  assert.equal(isBareShiftEnterLineEnding(""), false);
});

test("Kitty encodings that collapse Shift+Enter to CR/LF do not preserve the chord", () => {
  assert.equal(doesKittyEncodingPreserveShiftEnter(null), false);
  assert.equal(doesKittyEncodingPreserveShiftEnter(""), false);
  assert.equal(doesKittyEncodingPreserveShiftEnter("\r"), false);
  assert.equal(doesKittyEncodingPreserveShiftEnter("\n"), false);
  assert.equal(doesKittyEncodingPreserveShiftEnter(SHIFT_ENTER_CSI_U_SEQUENCE), true);
});

test("main-buffer Shift+Enter keeps configured send text", () => {
  assert.deepEqual(resolveShiftEnterPayload(), {
    kind: "text",
    data: "\n",
  });
  assert.deepEqual(
    resolveShiftEnterPayload(
      { shiftEnterNewlineText: " \\\\\\n" },
      { alternateScreen: false },
    ),
    { kind: "text", data: " \\\n" },
  );
});

test("alternate-screen Shift+Enter sends CSI-u when configured text is a bare line ending", () => {
  assert.deepEqual(
    resolveShiftEnterPayload(undefined, { alternateScreen: true }),
    { kind: "key", data: SHIFT_ENTER_CSI_U_SEQUENCE },
  );
  assert.deepEqual(
    resolveShiftEnterPayload(
      { shiftEnterNewlineText: "\\r\\n" },
      { alternateScreen: true },
    ),
    { kind: "key", data: SHIFT_ENTER_CSI_U_SEQUENCE },
  );
});

test("alternate-screen Shift+Enter keeps custom non-line-ending send text", () => {
  assert.deepEqual(
    resolveShiftEnterPayload(
      { shiftEnterNewlineText: " \\\\\\n" },
      { alternateScreen: true },
    ),
    { kind: "text", data: " \\\n" },
  );
});

test("runtime routes Shift+Enter text through the shared input handler", () => {
  const source = readFileSync(
    new URL("./createXTermRuntime.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /const handleTerminalInputData = \(\s+data: string,\s+options\?: \{\s+source\?: "terminal" \| "shift-enter" \| "kitty";\s+[\s\S]*?skipBroadcast\?: boolean;\s+\},\s+\) => \{/s,
  );
  // Remap when Kitty encoding does not preserve Shift+Enter (not merely flags===0).
  assert.match(
    source,
    /if \(\s*shouldSendShiftEnterText\([\s\S]*?\) &&\s*!doesKittyEncodingPreserveShiftEnter\(kittySequenceForKeyDown\)\s*\) \{[\s\S]*?const shiftEnterPayload = resolveShiftEnterPayload\([\s\S]*?\)[\s\S]*?\}\s*if \(kittySequenceForKeyDown\)/s,
  );
  assert.match(
    source,
    /if \(shiftEnterPayload\.kind === "key"\) \{[\s\S]*?handleTerminalInputData\(shiftEnterPayload\.data, \{ source: "kitty" \}\);[\s\S]*?\} else \{[\s\S]*?handleTerminalInputData\(shiftEnterPayload\.data, \{\s*source: "shift-enter",\s*skipBroadcast: true,\s*\}\);[\s\S]*?\}\s*const forwarded = broadcastKittyInput\(\{\s*kind: "key",\s*event: kittyEvent,\s*fallbackToLegacy: true,\s*\}\);/s,
  );
  assert.match(
    source,
    /const canBroadcastInput = !sensitive &&[\s\S]*?const willBroadcastInput = canBroadcastInput && options\?\.skipBroadcast !== true;[\s\S]*?if \(!canBroadcastInput && !handlingKittyBroadcast\) \{\s*prepareSudoAutofillInput/s,
  );
  assert.match(
    source,
    /alternateScreen: term\.buffer\.active\.type === "alternate",\s*shiftEnterSettings: ctx\.terminalSettingsRef\.current,/s,
  );
  assert.match(source, /getShiftEnterSubmittedInput\(data\)/);
  assert.match(source, /inputSource !== "shift-enter"/);
  assert.match(
    source,
    /if \(shouldSendShiftEnterText\(e, ctx\.terminalSettingsRef\.current\)\) \{\s+sudoAutofill\.cancelHint\(\);/s,
  );
  assert.match(
    source,
    /term\.onData\(\(rawData\) => \{[\s\S]*handleTerminalInputData\(data\);\s+\}\);/,
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
