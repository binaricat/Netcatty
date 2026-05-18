import test from "node:test";
import assert from "node:assert/strict";

import { resolveTerminalSessionExitIntent } from "./resolveTerminalSessionExitIntent.ts";

test("backend exited events keep the tab and mark it disconnected", () => {
  assert.deepEqual(
    resolveTerminalSessionExitIntent({ reason: "exited", exitCode: 0 }),
    { kind: "markDisconnected" },
  );
});

test("backend timeout events keep the tab and mark it disconnected", () => {
  assert.deepEqual(
    resolveTerminalSessionExitIntent({ reason: "timeout", error: "idle timeout" }),
    { kind: "markDisconnected" },
  );
});
