import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isModifierOnlyKeyDownEvent,
  keepImeCommittedTextThroughModifierKeyDowns,
} from "./imeModifierKeyDownSeenGuard";

const runtimeSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "createXTermRuntime.ts"),
  "utf8",
);

test("isModifierOnlyKeyDownEvent accepts both DOM key and classic keyCode shapes", () => {
  assert.equal(isModifierOnlyKeyDownEvent({ key: "Shift", keyCode: 16 }), true);
  assert.equal(isModifierOnlyKeyDownEvent({ key: "Shift" }), true);
  assert.equal(isModifierOnlyKeyDownEvent({ key: "Control", keyCode: 17 }), true);
  assert.equal(isModifierOnlyKeyDownEvent({ key: "Alt", keyCode: 18 }), true);
  assert.equal(isModifierOnlyKeyDownEvent({ key: "Meta", keyCode: 91 }), true);
  assert.equal(isModifierOnlyKeyDownEvent({ key: "CapsLock" }), true);
});

test("isModifierOnlyKeyDownEvent rejects real keys and IME process events", () => {
  assert.equal(isModifierOnlyKeyDownEvent({ key: "a", keyCode: 65 }), false);
  assert.equal(isModifierOnlyKeyDownEvent({ key: "Process", keyCode: 229 }), false);
  assert.equal(isModifierOnlyKeyDownEvent({ key: "Enter", keyCode: 13 }), false);
  assert.equal(isModifierOnlyKeyDownEvent({ key: "Dead", keyCode: 221 }), false);
});

type FakeCore = {
  _keyDown: (event: Pick<KeyboardEvent, "key" | "keyCode">) => boolean;
  _keyDownSeen: boolean;
  _keyUp: () => void;
};

function createFakeCore(initialSeen = false): {
  core: FakeCore;
  term: { _core: FakeCore };
} {
  const core: FakeCore = {
    _keyDownSeen: initialSeen,
    _keyDown(_event) {
      // Mirrors xterm: every keydown arms the insertText dedupe guard.
      this._keyDownSeen = true;
      return true;
    },
    _keyUp() {
      this._keyDownSeen = false;
    },
  };
  return { core, term: { _core: core } };
}

test("keepImeCommittedTextThroughModifierKeyDowns preserves seen state across Shift keydown", () => {
  // Sogou Shift commit: a previous real keydown armed the guard, and the
  // Shift keydown must not re-arm (or clear) it before the composed input.
  const { core, term } = createFakeCore(false);
  keepImeCommittedTextThroughModifierKeyDowns(term as never);
  core._keyDown({ key: "Shift", keyCode: 16 } as KeyboardEvent);
  assert.equal(core._keyDownSeen, false);
});

test("keepImeCommittedTextThroughModifierKeyDowns keeps guard armed for real keydowns", () => {
  const { core, term } = createFakeCore(false);
  keepImeCommittedTextThroughModifierKeyDowns(term as never);
  core._keyDown({ key: "a", keyCode: 65 } as KeyboardEvent);
  assert.equal(core._keyDownSeen, true);
});

test("keepImeCommittedTextThroughModifierKeyDowns preserves an already-armed guard", () => {
  const { core, term } = createFakeCore(true);
  keepImeCommittedTextThroughModifierKeyDowns(term as never);
  core._keyDown({ key: "Shift" } as KeyboardEvent);
  assert.equal(core._keyDownSeen, true);
});

test("keepImeCommittedTextThroughModifierKeyDowns leaves non-modifier behavior intact", () => {
  const { core, term } = createFakeCore(false);
  keepImeCommittedTextThroughModifierKeyDowns(term as never);
  core._keyDown({ key: "Process", keyCode: 229 } as KeyboardEvent);
  assert.equal(core._keyDownSeen, true);
  core._keyDown({ key: "Control", keyCode: 17 } as KeyboardEvent);
  assert.equal(core._keyDownSeen, true, "Control still restored to true (was true)");
});

test("guard tolerates a terminal without an introspectable core", () => {
  assert.doesNotThrow(() => {
    keepImeCommittedTextThroughModifierKeyDowns({} as never);
  });
});

test("runtime installs the guard when the terminal is created", () => {
  assert.match(
    runtimeSource,
    /keepImeCommittedTextThroughModifierKeyDowns\(term\)/,
  );
});
