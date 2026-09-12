import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { commandArrowLineJumpSequence } from "./commandArrowLineJump";

const event = {
  key: "ArrowLeft", metaKey: true, altKey: false, ctrlKey: false,
  shiftKey: false, isComposing: false, keyCode: 37,
};

test("macOS Command arrows send beginning/end-of-line controls", () => {
  assert.equal(commandArrowLineJumpSequence(event, true), "\x01");
  assert.equal(commandArrowLineJumpSequence({ ...event, key: "ArrowRight" }, true), "\x05");
});

test("other platforms, keys, modifiers and composition are untouched", () => {
  assert.equal(commandArrowLineJumpSequence(event, false), null);
  for (const override of [
    { metaKey: false }, { altKey: true }, { ctrlKey: true }, { shiftKey: true },
    { isComposing: true }, { keyCode: 229 }, { key: "ArrowUp" }, { key: "ArrowDown" },
    { key: "Home" }, { key: "a" },
  ]) {
    assert.equal(commandArrowLineJumpSequence({ ...event, ...override }, true), null);
  }
});

// Exercise the runtime fallback itself, including its protocol/screen guards.
// This avoids constructing the renderer's WebGL/addon stack in Node.
const runtime = readFileSync(new URL("./createXTermRuntime.ts", import.meta.url), "utf8");
const start = runtime.indexOf("    const lineJumpSequence =");
const end = runtime.indexOf("    // macOS Option+", start);
assert.ok(start > 0 && end > start);
const fallback = `(function () { ${runtime.slice(start, end)} return true; })()`;

for (const mode of ["shell", "alternate", "kitty", "win32", "disconnected", "non-mac"]) {
  test(`runtime Command arrow fallback: ${mode}`, () => {
    const writes: string[] = [];
    let prevented = 0;
    let stopped = 0;
    const result = runInNewContext(fallback, {
      e: { ...event, preventDefault: () => prevented++, stopPropagation: () => stopped++ },
      term: { buffer: { active: { type: mode === "alternate" ? "alternate" : "normal" } }, modes: { win32InputMode: mode === "win32" } },
      ctx: { sessionRef: { current: mode === "disconnected" ? null : "session" } },
      kittyKeyboardMode: {},
      isKittyKeyboardModeActive: () => mode === "kitty",
      isMacPlatform: () => mode !== "non-mac",
      commandArrowLineJumpSequence,
      handleTerminalInputData: (data: string) => writes.push(data),
      scrollToBottomAfterInput: () => {},
    });
    assert.equal(result, mode !== "shell");
    assert.deepEqual(writes, mode === "shell" ? ["\x01"] : []);
    assert.equal(prevented, mode === "shell" ? 1 : 0);
    assert.equal(stopped, prevented);
  });
}
