import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { optionYankLastArgSequence } from "./optionYankLastArg";

// Issue #2364: Esc+. / Alt+. is readline yank-last-arg (zsh insert-last-word).
// Traditional terminals just pass Meta-. through. On macOS, Option+. types "≥"
// unless Option is Meta, so map the physical period / underscore keys to ESC+.
// / ESC+_ — same idea as Option+←/→ word-jump, but always-on because ≥ is
// almost never wanted in a terminal.

const ev = (over: Partial<Parameters<typeof optionYankLastArgSequence>[0]> = {}) => ({
  key: ".",
  code: "Period",
  altKey: true,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...over,
});

test("Option+. → ESC+. (yank-last-arg) on macOS", () => {
  assert.equal(optionYankLastArgSequence(ev(), true), "\x1b.");
});

test("Option+. with composed ≥ (US layout) still maps to ESC+.", () => {
  assert.equal(
    optionYankLastArgSequence(ev({ key: "≥", code: "Period" }), true),
    "\x1b.",
  );
});

test("Option+_ → ESC+_ (yank-last-arg synonym) on macOS", () => {
  assert.equal(
    optionYankLastArgSequence(ev({ key: "_", code: "Minus", shiftKey: true }), true),
    "\x1b_",
  );
});

test("not macOS → null (Linux/Windows Alt+. already sends Meta via xterm)", () => {
  assert.equal(optionYankLastArgSequence(ev(), false), null);
  assert.equal(
    optionYankLastArgSequence(ev({ key: "_", code: "Minus", shiftKey: true }), false),
    null,
  );
});

test("no Option held → null", () => {
  assert.equal(optionYankLastArgSequence(ev({ altKey: false }), true), null);
});

test("Ctrl/Cmd with Option → null (don't hijack other chords)", () => {
  assert.equal(optionYankLastArgSequence(ev({ ctrlKey: true }), true), null);
  assert.equal(optionYankLastArgSequence(ev({ metaKey: true }), true), null);
});

test("Option+Shift+. (>) → null", () => {
  assert.equal(optionYankLastArgSequence(ev({ shiftKey: true }), true), null);
});

test("other Option keys → null", () => {
  assert.equal(optionYankLastArgSequence(ev({ key: "f", code: "KeyF" }), true), null);
  assert.equal(optionYankLastArgSequence(ev({ key: "ArrowLeft", code: "ArrowLeft" }), true), null);
});

test("runtime sends Option+. after kitty mode, same as word-jump", () => {
  const source = readFileSync(new URL("./createXTermRuntime.ts", import.meta.url), "utf8");
  assert.match(source, /from "\.\/optionYankLastArg"/);
  assert.match(
    source,
    /optionArrowWordJumpSequence\([\s\S]*?const yankLastArgSequence = isKittyKeyboardModeActive\(kittyKeyboardMode\)\s*\? null\s*: optionYankLastArgSequence\(/s,
  );
});
