import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { resolveKittyKeyboardBroadcastInput, type KittyKeyboardBroadcastInput } from "./kittyKeyboardBroadcast";
import { createKittyKeyboardModeState, setKittyKeyboardModeFlags, shouldEncodeKittyCompositionText, shouldMarkKittyTextInputEvent, encodeKittyCompositionText } from "./kittyKeyboardProtocol";
import { shouldBlockKeyPressForImeTextInput, shouldCommitDeferredImeTextInput } from "./terminalImeTextInput";
import { sanitizeTerminalInput } from "./terminalInputSanitize";

// Execute the actual registered key/data callbacks, without constructing the
// renderer and its WebGL/addon stack. In particular, retain their real timer
// cleanup and raw-broadcast suppression rather than reproducing that logic here.
const source = readFileSync(new URL("./createXTermRuntime.ts", import.meta.url), "utf8");
function section(start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `runtime section missing: ${start}`);
  return source.slice(from, to);
}
const declarations = section("  let suppressNextTerminalDataBroadcast =", "  const broadcastKittyInput =");
const keyboardCallback = section("  term.attachCustomKeyEventHandler((e: KeyboardEvent) => {", "  const handleMiddleClick =");
const dataCallback = section("  term.onData((data) => {", "  const handleKittyKeyboardBroadcast =");
const compositionMarker = section("  const markKittyCompositionPending =", "  const finishKittyComposition =");
const textInputMarker = section("  const markKittyTextInput =", '  textarea?.addEventListener("compositionstart"');
const suppression = section("    const suppressTerminalBroadcast =", "    // skipBroadcast");
const callbackCode = ts.transpileModule(`
  ${declarations}
  let win32InputModePendingEvent = null;
  let kittyCompositionPending = false;
  let kittyCompositionClearTimer;
  const handleTerminalInputData = (data) => {
    const inputSource = "terminal";
    ${suppression}
    if (!suppressTerminalBroadcast) raw(data);
  };
  const textarea = null;
  ${compositionMarker}
  ${textInputMarker}
  ${keyboardCallback}
  ${dataCallback}
  globalThis.controls = { mark: markBroadcastLegacyDataPending, clear: clearBroadcastLegacyDataPending, input: markKittyTextInput };
`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function setup(flags = 0) {
  const writes: string[] = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;
  let receive!: (data: string) => void;
  let keyboard!: (event: Partial<KeyboardEvent>) => boolean;
  const forwarded = new Map<string, { targetSessionIds: string[] }>();
  const mode = createKittyKeyboardModeState();
  setKittyKeyboardModeFlags(mode, flags);
  const options = {
    kittyProtocolEnabled: flags !== 0, kittyMode: mode, applicationCursorMode: false,
    encodedKeys: new Set<string>(), legacySuppressedKeys: new Set<string>(),
  };
  const normalized = (input: KittyKeyboardBroadcastInput) => {
    const result = resolveKittyKeyboardBroadcastInput(input, options);
    if (result) writes.push(result.data);
  };
  const context = {
    controls: undefined as unknown as { mark: (identity: string) => void; clear: () => void; input: (event: { data: string; inputType: string }) => void },
    window: {
      setTimeout(fn: () => void) { const id = ++timerId; timers.set(id, fn); return id; },
      clearTimeout(id: number) { timers.delete(id); },
    },
    term: {
      modes: { win32InputMode: false },
      onData(fn: typeof receive) { receive = fn; },
      attachCustomKeyEventHandler(fn: typeof keyboard) { keyboard = fn; },
    },
    ctx: { terminalSettingsRef: { current: {} }, isBroadcastEnabledRef: { current: true }, onBroadcastInputRef: { current: () => undefined } },
    imeTextInputDeferredKey: null, imeTextInputDeferredKittyEvent: null,
    shouldBlockKeyPressForImeTextInput, shouldCommitDeferredImeTextInput, shouldMarkKittyTextInputEvent, shouldEncodeKittyCompositionText, encodeKittyCompositionText,
    kittyKeyboardMode: createKittyKeyboardModeState(), shouldSplitImeTextInputForWire: () => false,
    kittyKeyIdentity: (event: Partial<KeyboardEvent>) => event.code || event.key,
    broadcastForwardedKeys: forwarded,
    broadcastKittyInput: normalized,
    sanitizeTerminalInput,
    shouldSplitRawPasteInputForWire: () => false,
    raw: (data: string) => writes.push(data),
  };
  runInNewContext(callbackCode, context);
  return {
    writes, receive: (data: string) => receive(data), controls: context.controls,
    keypress: (key: string, code: string) => keyboard({ type: "keypress", key, code }),
    press(key: string, code: string) {
      normalized({ kind: "key", event: { type: "keydown", key, code }, fallbackToLegacy: true });
      forwarded.set(code, { targetSessionIds: ["target"] });
      context.controls.mark(code);
    },
    flushTimers() { for (const [id, fn] of timers) { timers.delete(id); fn(); } },
    release(key: string, code: string) {
      normalized({ kind: "key", event: { type: "keyup", key, code }, fallbackToLegacy: true });
      forwarded.delete(code);
      context.controls.clear();
    },
  };
}

for (const flags of [0, 8]) {
  for (const [key, code] of [["A", "KeyA"], [" ", "Space"]]) {
    test(`broadcast pairs delayed ${code} keypress once with target flags ${flags}`, () => {
      const runtime = setup(flags);
      runtime.press(key, code);
      const firstWrite = runtime.writes.join("");
      assert.ok(firstWrite);
      runtime.flushTimers();
      assert.equal(runtime.keypress(key, code), true);
      runtime.receive(key);
      assert.equal(runtime.writes.join(""), firstWrite, "the source's later text must not duplicate its physical key broadcast");
    });
  }
}

test("repeated physical presses each reach the broadcast target once", () => {
  const runtime = setup();
  for (let i = 0; i < 3; i++) {
    runtime.press("A", "KeyA");
    runtime.flushTimers();
    runtime.keypress("A", "KeyA");
    runtime.receive("A");
  }
  assert.equal(runtime.writes.join(""), "AAA");
});

test("keypress without an earlier broadcast and text after release are not swallowed", () => {
  const runtime = setup();
  runtime.keypress("B", "KeyB");
  runtime.receive("B");
  runtime.press("A", "KeyA");
  runtime.flushTimers();
  runtime.keypress("A", "KeyA");
  runtime.receive("A");
  runtime.release("A", "KeyA");
  runtime.receive("paste");
  assert.equal(runtime.writes.join(""), "BApaste");
});

test("unmatched keypress cleanup still permits a later paste", () => {
  const runtime = setup();
  runtime.press("A", "KeyA");
  runtime.flushTimers();
  runtime.keypress("A", "KeyA");
  runtime.flushTimers();
  runtime.receive("paste");
  assert.equal(runtime.writes.join(""), "Apaste");
});

test("trailing insertText for Space does not turn the next physical key into duplicate composition text", () => {
  const runtime = setup();
  for (const [key, code] of [[" ", "Space"], ["A", "KeyA"], ["B", "KeyB"], ["C", "KeyC"]]) {
    runtime.press(key, code);
    runtime.keypress(key, code);
    runtime.receive(key);
    runtime.controls.input({ data: key, inputType: "insertText" });
    runtime.release(key, code);
    // Real trace: the next key can arrive before insertText's zero-delay timer.
  }
  assert.equal(runtime.writes.join(""), " ABC");
});

test("keyless insertText is still broadcast as actual text", () => {
  const runtime = setup();
  runtime.controls.input({ data: "中文", inputType: "insertText" });
  runtime.receive("中文");
  assert.equal(runtime.writes.join(""), "中文");
});
