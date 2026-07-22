import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveTerminalSessionExitIntent,
  shouldCloseTerminalPopupOnExit,
  shouldRevealTerminalPopupOnExit,
} from "./resolveTerminalSessionExitIntent.ts";

test("normal backend exited events close the session tab", () => {
  assert.deepEqual(
    resolveTerminalSessionExitIntent({ reason: "exited", exitCode: 0 }),
    { kind: "closeSession" },
  );
});

test("disabled auto-close keeps the session tab after a clean exit", () => {
  assert.deepEqual(
    resolveTerminalSessionExitIntent({ reason: "exited", exitCode: 0 }, false),
    { kind: "markDisconnected" },
  );
});

test("non-zero backend exits keep the tab and mark it disconnected", () => {
  assert.deepEqual(
    resolveTerminalSessionExitIntent({ reason: "exited", exitCode: 1 }),
    { kind: "markDisconnected" },
  );
});

test("backend exits without a confirmed clean exit code keep the tab", () => {
  assert.deepEqual(
    resolveTerminalSessionExitIntent({ reason: "exited" }),
    { kind: "markDisconnected" },
  );
});

test("backend timeout events keep the tab and mark it disconnected", () => {
  assert.deepEqual(
    resolveTerminalSessionExitIntent({ reason: "timeout", error: "idle timeout" }),
    { kind: "markDisconnected" },
  );
});

test("backend error events keep the tab and mark it disconnected", () => {
  assert.deepEqual(
    resolveTerminalSessionExitIntent({ reason: "error", error: "connection reset" }),
    { kind: "markDisconnected" },
  );
});

test("backend closed events keep the tab and mark it disconnected", () => {
  assert.deepEqual(
    resolveTerminalSessionExitIntent({ reason: "closed", exitCode: 0 }),
    { kind: "markDisconnected" },
  );
});

test("terminal popup only auto-closes after clean command exit", () => {
  assert.equal(shouldCloseTerminalPopupOnExit({ reason: "exited", exitCode: 0 }), true);
  assert.equal(shouldCloseTerminalPopupOnExit({ reason: "exited", exitCode: 1 }), false);
  assert.equal(shouldCloseTerminalPopupOnExit({ reason: "error", error: "connection reset" }), false);
  assert.equal(shouldCloseTerminalPopupOnExit({ reason: "closed", exitCode: 0 }), false);
});

test("disabled auto-close keeps command and attached terminal popups open", () => {
  assert.equal(
    shouldCloseTerminalPopupOnExit(
      { reason: "exited", exitCode: 0 },
      { autoCloseOnExit: false },
    ),
    false,
  );
  assert.equal(
    shouldCloseTerminalPopupOnExit(
      { reason: "closed", exitCode: 0 },
      { autoCloseOnExit: false, isAttachMode: true },
    ),
    false,
  );
});

test("disabled auto-close reveals every command popup exit instead of reporting startup failure", () => {
  assert.equal(
    shouldRevealTerminalPopupOnExit(
      { reason: "exited", exitCode: 0 },
      { autoCloseOnExit: false },
    ),
    true,
  );
  assert.equal(
    shouldRevealTerminalPopupOnExit(
      { reason: "exited", exitCode: 1 },
      { autoCloseOnExit: false },
    ),
    true,
  );
  assert.equal(
    shouldRevealTerminalPopupOnExit(
      { reason: "exited" },
      { autoCloseOnExit: false },
    ),
    true,
  );
  assert.equal(
    shouldRevealTerminalPopupOnExit(
      { reason: "exited", exitCode: 0 },
      { autoCloseOnExit: false, isAttachMode: true },
    ),
    false,
  );
});

test("attached terminal popups keep their existing auto-close behavior by default", () => {
  assert.equal(
    shouldCloseTerminalPopupOnExit(
      { reason: "closed", exitCode: 0 },
      { isAttachMode: true },
    ),
    true,
  );
});
