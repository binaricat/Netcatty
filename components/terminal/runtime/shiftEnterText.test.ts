import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  decodeTerminalTextEscapes,
  doesKittyEncodingPreserveShiftEnter,
  getShiftEnterSubmittedInput,
  isBareShiftEnterLineEnding,
  isShiftEnterLineContinuationText,
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

test("runtime routes Shift+Enter text through the shared input handler", () => {
  const source = readFileSync(
    new URL("./createXTermRuntime.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /const handleTerminalInputData = \(\s+data: string,\s+options\?: \{\s+source\?: "terminal" \| "shift-enter" \| "kitty";\s+[\s\S]*?skipBroadcast\?: boolean;\s+[\s\S]*?perCharacterWrites\?: boolean;\s+\},\s+\) => \{/s,
  );
  // Remap when Kitty encoding does not preserve Shift+Enter (not merely flags===0).
  assert.match(
    source,
    /if \(\s*shouldSendShiftEnterText\([\s\S]*?\) &&\s*!term\.modes\.win32InputMode &&\s*!doesKittyEncodingPreserveShiftEnter\(kittySequenceForKeyDown\)\s*\) \{[\s\S]*?const shiftEnterText = resolveShiftEnterText\([\s\S]*?\)[\s\S]*?\}\s*if \(kittySequenceForKeyDown\)/s,
  );
  assert.match(
    source,
    /vtExtensions: \{\s*win32InputMode: windowsPty\?\.backend === "conpty",\s*\},/s,
  );
  assert.match(
    source,
    /const kittySequenceForKeyDown =\s*!term\.modes\.win32InputMode &&\s*kittyKeyboardProtocolEnabled/s,
  );
  assert.match(
    source,
    /const shiftEnterText = resolveShiftEnterText\([\s\S]*?if \(shiftEnterText\) \{[\s\S]*?handleTerminalInputData\(shiftEnterText, \{\s*source: "shift-enter",\s*skipBroadcast: true,\s*\}\);\s*const forwarded = broadcastKittyInput\(\{\s*kind: "key",\s*event: kittyEvent,\s*fallbackToLegacy: true,\s*\}\);/s,
  );
  assert.match(
    source,
    /const canBroadcastInput = !sensitive &&[\s\S]*?const willBroadcastInput = canBroadcastInput && options\?\.skipBroadcast !== true;[\s\S]*?if \(!canBroadcastInput && !handlingKittyBroadcast\) \{\s*prepareSudoAutofillInput/s,
  );
  assert.match(
    source,
    /resolveOptions: \(\) => \(\{[\s\S]*?shiftEnterSettings: ctx\.terminalSettingsRef\.current,[\s\S]*?\}\),/s,
  );
  assert.doesNotMatch(source, /resolveShiftEnterText\([\s\S]*?alternateScreen:/s);
  assert.match(source, /getShiftEnterSubmittedInput\(logicalData\)/);
  assert.match(source, /inputSource !== "shift-enter"/);
  assert.match(
    source,
    /if \(shouldSendShiftEnterText\(e, ctx\.terminalSettingsRef\.current\)\) \{\s+sudoAutofill\.cancelHint\(\);/s,
  );
  assert.match(
    source,
    /term\.onData\(\(data\) => \{[\s\S]*const sanitizedRawData = sanitizeTerminalInput\(data\);[\s\S]*handleTerminalInputData\(sanitizedRawData, \{\s*perCharacterWrites: shouldSplitRawPasteInputForWire\(sanitizedRawData\),?\s*\}\);\s+\}\);/,
  );
  assert.match(
    source,
    /const sanitizedData = sanitizeTerminalInput\(data\);[\s\S]*const encoded = term\.modes\.win32InputMode\s*\? null\s*:\s*encodeKittyCompositionText\(kittyKeyboardMode, sanitizedData\);[\s\S]*if \(encoded\) \{[\s\S]*handleTerminalInputData\(encoded, \{ source: "kitty" \}\);[\s\S]*\} else \{[\s\S]*handleTerminalInputData\(sanitizedData, \{\s*perCharacterWrites: shouldSplitImeTextInputForWire\(sanitizedData\),?\s*\}\);[\s\S]*broadcastKittyInput\(\{ kind: "text", text: sanitizedData \}\);/,
  );
  assert.match(
    source,
    /if \(term\.modes\.win32InputMode\) \{[\s\S]*win32InputModePendingEvent = \{\s*event: normalizedKittyEvent,\s*logicalData: resolveWin32InputLogicalData\(/s,
  );
  assert.match(
    source,
    /const broadcastInput: KittyKeyboardBroadcastInput = \{\s*kind: "win32",\s*data,\s*event: win32Input\.event,[\s\S]*handleTerminalInputData\(data, \{\s*logicalData: win32Input\.logicalData,\s*skipBroadcast: true,/s,
  );
  assert.match(
    source,
    /const hasForwardedWin32KeyDown = win32InputModeForwardedKeys\.delete\(identity\);[\s\S]*if \(term\.modes\.win32InputMode\) \{[\s\S]*releaseForwardedKittyPress\([\s\S]*if \(!hasForwardedWin32KeyDown\) \{[\s\S]*win32InputModePendingEvent = null;[\s\S]*return false;[\s\S]*logicalData: null,[\s\S]*return true;[\s\S]*releaseForwardedKittyPress/s,
  );
  assert.match(
    source,
    /if \(win32Input\.event\.type === "keydown"\) \{\s*upsertKittyKeyboardForwardedPress\(\s*win32InputModeForwardedKeys,\s*win32Input\.event\.code \|\| win32Input\.event\.key,\s*win32Input\.event,\s*\[\],/s,
  );
  assert.match(
    source,
    /if \(term\.modes\.win32InputMode\) \{[\s\S]*flushKittyKeyboardBroadcastReleases\(\s*win32InputModeForwardedKeys,[\s\S]*writeWin32InputModeEvent\(input\.event, null\);/s,
  );
  assert.match(source, /win32InputMode: term\.modes\.win32InputMode,/);
  assert.match(
    source,
    /const win32BroadcastForwardedKeys = new Map<string, KittyKeyboardForwardedPress>\(\);/,
  );
  assert.match(
    source,
    /const forwardedPress = win32BroadcastForwardedKeys\.get\(identity\);[\s\S]*broadcastKittyInput\(\s*broadcastInput,\s*true,\s*forwardedPress\.targetSessionIds,/s,
  );
  assert.match(
    source,
    /upsertKittyKeyboardForwardedPress\(\s*win32BroadcastForwardedKeys,[\s\S]*forwarded\.targetSessionIds,/s,
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
