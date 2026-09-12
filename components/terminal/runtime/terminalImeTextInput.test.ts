import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isAsciiPunctuationKey,
  isUnchangedDeferredImeTextInput,
  shouldBlockKeyPressForImeTextInput,
  shouldCommitDeferredImeTextInput,
  shouldDeferKeyDownForImeTextInput,
  resolveDeferredKeyupRelease,
  shouldDiscardStaleDeferredImeTextInput,
  shouldFlushDeferredImeTextInputOnKeyUp,
  shouldFlushStaleDeferredImeTextInput,
} from "./terminalImeTextInput";

const runtimeSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "createXTermRuntime.ts"),
  "utf8",
);

test("isAsciiPunctuationKey accepts common remappable punctuation", () => {
  for (const key of [",", ".", "/", ";", "'", "[", "]", "\\", "-", "=", "`", "?", "!", ":", '"', "<", ">", "{", "}", "|", "_", "+", "~", "@", "#", "$", "%", "^", "&", "*", "(", ")"]) {
    assert.equal(isAsciiPunctuationKey(key), true, key);
  }
});

test("isAsciiPunctuationKey rejects letters, digits, space, and CJK", () => {
  for (const key of ["a", "Z", "0", " ", "，", "、", "？", "Enter", "ArrowLeft"]) {
    assert.equal(isAsciiPunctuationKey(key), false, key);
  }
});

test("shouldDeferKeyDownForImeTextInput defers bare ASCII punctuation keydowns", () => {
  assert.equal(
    shouldDeferKeyDownForImeTextInput({ type: "keydown", key: ",", keyCode: 188 }),
    true,
  );
  assert.equal(
    shouldDeferKeyDownForImeTextInput({ type: "keydown", key: "?", keyCode: 191 }),
    true,
  );
});

test("shouldDeferKeyDownForImeTextInput leaves composition and modified keys alone", () => {
  assert.equal(
    shouldDeferKeyDownForImeTextInput({ type: "keydown", key: ",", keyCode: 229 }),
    false,
  );
  assert.equal(
    shouldDeferKeyDownForImeTextInput({ type: "keydown", key: ",", isComposing: true }),
    false,
  );
  assert.equal(
    shouldDeferKeyDownForImeTextInput({ type: "keydown", key: ",", ctrlKey: true }),
    false,
  );
  assert.equal(
    shouldDeferKeyDownForImeTextInput({ type: "keydown", key: "a", keyCode: 65 }),
    false,
  );
  assert.equal(
    shouldDeferKeyDownForImeTextInput({ type: "keypress", key: "," }),
    false,
  );
});

test("shouldBlockKeyPressForImeTextInput only while a deferral is armed", () => {
  assert.equal(
    shouldBlockKeyPressForImeTextInput(",", { type: "keypress", key: "," }),
    true,
  );
  assert.equal(
    shouldBlockKeyPressForImeTextInput(null, { type: "keypress", key: "," }),
    false,
  );
  assert.equal(
    shouldBlockKeyPressForImeTextInput(",", { type: "keydown", key: "," }),
    false,
  );
});

test("shouldBlockKeyPressForImeTextInput still blocks the deferred keystroke itself", () => {
  assert.equal(
    shouldBlockKeyPressForImeTextInput(
      "/",
      { type: "keypress", key: "/", keyCode: 191 },
      191,
    ),
    true,
  );
  // Shift+/ reports "?" on keydown, so the deferral arms with "?".
  assert.equal(
    shouldBlockKeyPressForImeTextInput(
      "?",
      { type: "keypress", key: "?", keyCode: 191 },
      191,
    ),
    true,
  );
  assert.equal(
    shouldBlockKeyPressForImeTextInput(
      "/",
      { type: "keypress", key: "/", isComposing: true },
      191,
    ),
    true,
  );
});

test("a stale deferral must not swallow unrelated keypresses (#3103)", () => {
  // Uppercase letters are routed through keypress by xterm, so a blanket
  // keypress block turned one stale deferral into a terminal that ignored
  // everything typed afterwards.
  assert.equal(
    shouldBlockKeyPressForImeTextInput(
      "/",
      { type: "keypress", key: "X", keyCode: 88 },
      191,
    ),
    false,
  );
  assert.equal(
    shouldBlockKeyPressForImeTextInput(
      "/",
      { type: "keypress", key: "a", keyCode: 65 },
      191,
    ),
    false,
  );
  // A matching keyCode keeps the block when an IME rewrites the key label.
  assert.equal(
    shouldBlockKeyPressForImeTextInput(
      "/",
      { type: "keypress", key: "1", keyCode: 191 },
      191,
    ),
    true,
  );
});

test("a Windows IME release reporting Process must flush the deferred slash (#3103)", () => {
  // Windows + CJK IME in vi: keydown still reports the physical key while the
  // IME consumes it, then reports Process/229 on the release and never sends
  // an insertText the runtime would treat as a remap.
  let deferredKey: string | null = null;
  const keydown = { type: "keydown", key: "/", keyCode: 191 };
  if (shouldDeferKeyDownForImeTextInput(keydown)) deferredKey = keydown.key;
  assert.equal(deferredKey, "/");

  const release = { type: "keyup", key: "Process", keyCode: 229 };
  if (shouldFlushDeferredImeTextInputOnKeyUp(deferredKey, release)) deferredKey = null;
  assert.equal(deferredKey, null, "the deferral must not outlive its keystroke");

  // Input keeps flowing afterwards.
  assert.equal(
    shouldBlockKeyPressForImeTextInput(deferredKey, { type: "keypress", key: "x", keyCode: 88 }),
    false,
  );
});

test("a held key released while the deferral is armed keeps its own keyup identity", () => {
  // "/" is deferred (its own release was swallowed) and the user still holds
  // "a" with the other hand, so the "a" keyup lands first. The stale deferral
  // still ends, but that release is a real keyup, not an IME sentinel: it
  // keeps its own identity, and the deferred press is released separately.
  const deferredKey = "/";
  const heldKeyUp = { type: "keyup", key: "a", keyCode: 65, code: "KeyA" };
  assert.equal(
    shouldFlushDeferredImeTextInputOnKeyUp(deferredKey, heldKeyUp),
    true,
    "the stale deferral still ends on a real release",
  );
  assert.equal(
    resolveDeferredKeyupRelease(deferredKey, "Slash", heldKeyUp),
    "unrelated",
    "an unrelated release must not be rewritten to the deferred key",
  );
});

test("only IME sentinel releases take over the deferred key's release identity", () => {
  // Windows IMEs report Process/229 (occasionally Unidentified) as the release
  // of a key they consumed — those are the only releases that stand in for the
  // deferred punctuation key.
  assert.equal(
    resolveDeferredKeyupRelease("/", "Slash", { type: "keyup", key: "Process", keyCode: 229 }),
    "deferred",
  );
  assert.equal(
    resolveDeferredKeyupRelease("/", "Slash", { type: "keyup", key: "Unidentified" }),
    "deferred",
  );
  assert.equal(
    resolveDeferredKeyupRelease("/", "Slash", { type: "keyup", key: "/", keyCode: 191 }),
    "own",
    "a matched release already encodes from the real event",
  );
  assert.equal(
    resolveDeferredKeyupRelease("/", "Slash", {
      type: "keyup",
      key: "1",
      keyCode: 191,
      code: "Slash",
    }),
    "own",
    "a release of the same physical key already pairs the flushed press",
  );
  assert.equal(
    resolveDeferredKeyupRelease("/", "Slash", { type: "keyup", key: "Shift", keyCode: 16 }),
    "own",
  );
  assert.equal(
    resolveDeferredKeyupRelease("/", "Slash", {
      type: "keyup",
      key: "a",
      keyCode: 65,
      code: "KeyA",
      ctrlKey: true,
    }),
    "own",
  );
  assert.equal(
    resolveDeferredKeyupRelease(null, null, { type: "keyup", key: "Process", keyCode: 229 }),
    "own",
  );
});

test("a deferral left without release or insertText recovers on the next keystroke (#3103)", () => {
  let deferredKey: string | null = null;
  const keydown = { type: "keydown", key: "/", keyCode: 191 };
  if (shouldDeferKeyDownForImeTextInput(keydown)) deferredKey = keydown.key;
  assert.equal(deferredKey, "/");

  // No insertText and no keyup at all; the user then types a plain letter.
  const nextKeyDown = { type: "keydown", key: "a", keyCode: 65 };
  if (shouldFlushStaleDeferredImeTextInput(deferredKey, nextKeyDown)) deferredKey = null;
  assert.equal(deferredKey, null, "the stale deferral must flush before the new keystroke");
  assert.equal(
    shouldBlockKeyPressForImeTextInput(deferredKey, { type: "keypress", key: "a", keyCode: 65 }),
    false,
  );
});

test("a modified keydown discards the stale deferral instead of flushing it", () => {
  // The IME swallowed the "/" release and the user then interrupts with
  // Ctrl+C. Flushing there would inject "/" in front of the interrupt, and
  // keeping the deferral armed would inject it before the next character, so
  // the lost keystroke is dropped instead.
  assert.equal(
    shouldFlushStaleDeferredImeTextInput("/", {
      type: "keydown",
      key: "c",
      keyCode: 67,
      ctrlKey: true,
    }),
    false,
  );
  assert.equal(
    shouldDiscardStaleDeferredImeTextInput("/", {
      type: "keydown",
      key: "c",
      keyCode: 67,
      ctrlKey: true,
    }),
    true,
  );
  assert.equal(
    shouldDiscardStaleDeferredImeTextInput("/", {
      type: "keydown",
      key: "Tab",
      keyCode: 9,
      altKey: true,
    }),
    true,
  );
  assert.equal(
    shouldDiscardStaleDeferredImeTextInput("/", {
      type: "keydown",
      key: "d",
      keyCode: 229,
      ctrlKey: true,
      isComposing: true,
    }),
    false,
    "a composition still owns the keystroke and resolves via insertText",
  );
  assert.equal(
    shouldDiscardStaleDeferredImeTextInput("/", { type: "keydown", key: "a", keyCode: 65 }),
    false,
  );
  assert.equal(
    shouldDiscardStaleDeferredImeTextInput(null, {
      type: "keydown",
      key: "c",
      keyCode: 67,
      ctrlKey: true,
    }),
    false,
  );
});

test("auto-repeat and modifier keystrokes keep the deferral armed", () => {
  // Same-key keydown is auto-repeat: re-arm instead of flushing, so a held key
  // does not emit an extra character per repeat.
  assert.equal(
    shouldFlushStaleDeferredImeTextInput("/", { type: "keydown", key: "/", keyCode: 191 }),
    false,
  );
  assert.equal(
    shouldFlushStaleDeferredImeTextInput("/", { type: "keydown", key: "Shift", keyCode: 16 }),
    false,
  );
  assert.equal(
    shouldFlushStaleDeferredImeTextInput("/", {
      type: "keydown",
      key: "d",
      keyCode: 229,
      isComposing: true,
    }),
    false,
  );
  assert.equal(
    shouldFlushDeferredImeTextInputOnKeyUp("/", { type: "keyup", key: "Shift", keyCode: 16 }),
    false,
  );
  assert.equal(
    shouldFlushDeferredImeTextInputOnKeyUp("/", {
      type: "keyup",
      key: "c",
      keyCode: 67,
      ctrlKey: true,
    }),
    false,
  );
});

test("an active composition still resolves the deferred keystroke via insertText", () => {
  // The IME absorbed the punctuation into a composition: the composing release
  // must not flush the ASCII key ahead of the committed glyph.
  assert.equal(
    shouldFlushDeferredImeTextInputOnKeyUp("/", {
      type: "keyup",
      key: "/",
      keyCode: 191,
      isComposing: true,
    }),
    false,
  );
  assert.equal(
    shouldCommitDeferredImeTextInput("/", { inputType: "insertText", data: "、" }),
    true,
  );
});

test("a matched keyup still flushes the English punctuation fallback (#2833)", () => {
  assert.equal(
    shouldFlushDeferredImeTextInputOnKeyUp("/", { type: "keyup", key: "/", keyCode: 191 }),
    true,
  );
  assert.equal(
    shouldFlushDeferredImeTextInputOnKeyUp(null, { type: "keyup", key: "/", keyCode: 191 }),
    false,
  );
  assert.equal(
    shouldFlushDeferredImeTextInputOnKeyUp("/", { type: "keydown", key: "/", keyCode: 191 }),
    false,
  );
});

test("shouldCommitDeferredImeTextInput accepts insertText payloads while deferred", () => {
  assert.equal(
    shouldCommitDeferredImeTextInput(",", { inputType: "insertText", data: "，" }),
    true,
  );
  assert.equal(
    shouldCommitDeferredImeTextInput(",", { inputType: "insertText", data: "," }),
    true,
  );
  assert.equal(
    shouldCommitDeferredImeTextInput(null, { inputType: "insertText", data: "，" }),
    false,
  );
  assert.equal(
    shouldCommitDeferredImeTextInput(",", { inputType: "insertFromPaste", data: "，" }),
    false,
  );
  assert.equal(
    shouldCommitDeferredImeTextInput(",", { inputType: "insertText", data: null }),
    false,
  );
});

test("isUnchangedDeferredImeTextInput detects English punctuation flush", () => {
  assert.equal(isUnchangedDeferredImeTextInput(",", ","), true);
  assert.equal(isUnchangedDeferredImeTextInput(",", "，"), false);
  assert.equal(isUnchangedDeferredImeTextInput(null, ","), false);
});

test("createXTermRuntime defers ASCII punctuation keydowns to insertText", () => {
  assert.match(runtimeSource, /shouldDeferKeyDownForImeTextInput\(e\)/);
  assert.match(runtimeSource, /armImeTextInputDeferral\(e\)/);
  assert.match(
    runtimeSource,
    /shouldBlockKeyPressForImeTextInput\(\s*imeTextInputDeferredKey,\s*e,\s*imeTextInputDeferredKittyEvent\?\.keyCode \?\? null,\s*\)/,
  );
  assert.match(
    runtimeSource,
    /shouldCommitDeferredImeTextInput\(imeTextInputDeferredKey, event\)/,
  );
  assert.match(runtimeSource, /commitImeTextInput\(event\.data\)/);
  assert.match(runtimeSource, /isUnchangedDeferredImeTextInput\(deferredKey, text\)/);
  assert.match(runtimeSource, /imeTextInputDeferredKittyEvent/);
  // Manual commit bypasses xterm onUserInput; clear selection unless preserved.
  assert.match(
    runtimeSource,
    /!ctx\.terminalSettingsRef\.current\?\.preserveSelectionOnInput/,
  );
  assert.match(runtimeSource, /term\.clearSelection\(\)/);
  const clearSelIdx = runtimeSource.indexOf("term.clearSelection()");
  const commitIdx = runtimeSource.indexOf("const commitImeTextInput = (text: string)");
  const firstHandleIdx = runtimeSource.indexOf(
    "handleTerminalInputData",
    commitIdx,
  );
  assert.ok(
    commitIdx >= 0 &&
      clearSelIdx > commitIdx &&
      firstHandleIdx > clearSelIdx,
  );
  // Must run before Kitty/xterm send the half-width key from keydown.
  const deferIdx = runtimeSource.indexOf("shouldDeferKeyDownForImeTextInput(e)");
  const kittySendIdx = runtimeSource.indexOf("if (kittySequenceForKeyDown)");
  assert.ok(deferIdx >= 0 && kittySendIdx > deferIdx);
  // Unchanged ASCII must encode via Kitty key events, not composition text.
  const unchangedIdx = runtimeSource.indexOf("isUnchangedDeferredImeTextInput(deferredKey, text)");
  const compositionIdx = runtimeSource.indexOf(
    "encodeKittyCompositionText(kittyKeyboardMode, sanitizedText)",
  );
  assert.ok(unchangedIdx >= 0 && compositionIdx > unchangedIdx);
  // Even when the source writes the literal glyph, broadcast peers still get
  // the deferred physical key (with legacy fallback), not composition text.
  const armIdx = runtimeSource.indexOf("const armImeTextInputDeferral");
  assert.ok(armIdx >= 0);
  const armSlice = runtimeSource.slice(armIdx, armIdx + 700);
  assert.match(
    armSlice,
    /imeTextInputDeferredKittyEvent = toKittyKeyboardEvent\(event\)/,
  );
  assert.doesNotMatch(
    armSlice,
    /imeTextInputDeferredKittyEvent = kittyKeyboardProtocolEnabled/,
  );
  const unchangedFallbackIdx = runtimeSource.indexOf(
    "isUnchangedDeferredImeTextInput(deferredKey, text))",
    unchangedIdx + 1,
  );
  assert.ok(unchangedFallbackIdx > unchangedIdx);
  assert.match(
    runtimeSource.slice(unchangedFallbackIdx, unchangedFallbackIdx + 1800),
    /handleTerminalInputData\(text, \{ perCharacterWrites: shouldSplitImeTextInputForWire\(text\) \}\);[\s\S]*shouldTrackKittyKeyRelease\(kittyKeyboardMode, pressEvent\)[\s\S]*upsertKittyKeyboardForwardedPress\(\s*kittyForwardedKeys,[\s\S]*broadcastKittyInput\(\{[\s\S]*kind: "key",[\s\S]*fallbackToLegacy: true,/,
  );
  // Remap path must fall back to literal text when composition encoding is null
  // (report-all without associated text).
  assert.match(
    runtimeSource.slice(compositionIdx, compositionIdx + 560),
    /if \(encoded\) \{[\s\S]*handleTerminalInputData\(encoded, \{ source: "kitty" \}\);[\s\S]*\} else \{[\s\S]*handleTerminalInputData\(sanitizedText, \{\s*perCharacterWrites: shouldSplitImeTextInputForWire\(sanitizedText\),?\s*\}\);/,
  );
});

test("createXTermRuntime recovers a stuck IME punctuation deferral (#3103)", () => {
  // Any real key release ends the deferral, not just an exact key match.
  const keyupIdx = runtimeSource.indexOf('if (e.type === "keyup")');
  assert.ok(keyupIdx >= 0);
  const keyupSlice = runtimeSource.slice(keyupIdx, keyupIdx + 2800);
  assert.match(
    keyupSlice,
    /shouldFlushDeferredImeTextInputOnKeyUp\(imeTextInputDeferredKey, e\)/,
  );
  assert.match(keyupSlice, /flushImeTextInputDeferral\(\);/);
  // Only an IME sentinel release (Process/229/Unidentified) takes over the
  // deferred key's release identity; an unrelated keyup keeps its own identity
  // and the flushed press is released separately.
  assert.match(
    keyupSlice,
    /resolveDeferredKeyupRelease\(\s*imeTextInputDeferredKey,\s*deferredKittyEvent\?\.code \?\? null,\s*e,?\s*\)/,
  );
  assert.match(keyupSlice, /releaseMode === "deferred"/);
  assert.match(keyupSlice, /releaseMode === "unrelated"/);
  assert.match(
    keyupSlice,
    /\.\.\.deferredKittyEvent,\s*type: "keyup",/,
  );
  const kittyReleaseIdx = keyupSlice.indexOf("toKittyKeyboardEvent(releaseEvent)");
  assert.ok(kittyReleaseIdx > keyupSlice.indexOf("flushImeTextInputDeferral();"));

  // The stale flush runs on keydown, after the broadcast guard and before the
  // composition handling, so a wedged deferral cannot survive a new keystroke.
  const staleIdx = runtimeSource.indexOf(
    "shouldFlushStaleDeferredImeTextInput(imeTextInputDeferredKey, e)",
  );
  assert.ok(staleIdx > keyupIdx);
  const keydownGuardIdx = runtimeSource.indexOf("if (handlingKittyBroadcast) return true;", keyupIdx);
  const keyCode229Idx = runtimeSource.indexOf("if (e.keyCode === 229) {", keyupIdx);
  assert.ok(
    keydownGuardIdx > keyupIdx &&
      staleIdx > keydownGuardIdx &&
      keyCode229Idx > staleIdx,
  );
  assert.match(
    runtimeSource.slice(staleIdx - 400, staleIdx + 200),
    /flushImeTextInputDeferral\(\);/,
  );
  // The recovery runs because the deferred key's release will never arrive, so
  // the press emitted by the flush must be paired with a synthesized release
  // instead of staying forwarded until focus loss.
  const recoverySlice = runtimeSource.slice(staleIdx, staleIdx + 500);
  assert.match(recoverySlice, /deferredKittyEvent = imeTextInputDeferredKittyEvent/);
  assert.match(recoverySlice, /releaseForwardedKittyPress\(\s*\{\s*\.\.\.deferredKittyEvent,\s*type: "keyup",?\s*\}\s*\)/);
  // A modified keydown (Ctrl+C, Alt+…) drops the lost keystroke instead of
  // injecting it in front of the interrupt or shortcut.
  assert.match(
    runtimeSource.slice(staleIdx, staleIdx + 700),
    /shouldDiscardStaleDeferredImeTextInput\(imeTextInputDeferredKey, e\)/,
  );
});
