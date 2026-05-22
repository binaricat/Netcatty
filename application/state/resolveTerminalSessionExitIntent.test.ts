import test from "node:test";
import assert from "node:assert/strict";

import { resolveTerminalSessionExitIntent } from "./resolveTerminalSessionExitIntent.ts";

test("normal backend exited events close the session tab", () => {
  assert.deepEqual(
    resolveTerminalSessionExitIntent({ reason: "exited", exitCode: 0 }),
    { kind: "closeSession" },
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
