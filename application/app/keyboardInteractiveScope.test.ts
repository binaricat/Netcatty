import test from "node:test";
import assert from "node:assert/strict";

import { shouldQueueKeyboardInteractiveRequest } from "./useAppStartupEffects.ts";

const sessions = [{ id: "terminal-1" }, { id: "terminal-2" }];

test("terminal-scoped keyboard-interactive requests are limited to owned sessions", () => {
  assert.equal(
    shouldQueueKeyboardInteractiveRequest({ scope: "terminal", sessionId: "terminal-1" }, sessions),
    true,
  );
  assert.equal(
    shouldQueueKeyboardInteractiveRequest({ scope: "terminal", sessionId: "foreign-terminal" }, sessions),
    false,
  );
});

test("external keyboard-interactive requests are not filtered by terminal session ids", () => {
  assert.equal(
    shouldQueueKeyboardInteractiveRequest({ scope: "external", sessionId: "sftp-conn-1" }, sessions),
    true,
  );
  assert.equal(
    shouldQueueKeyboardInteractiveRequest({ scope: "external", sessionId: "tunnel-1" }, sessions),
    true,
  );
});

test("disabled peer windows still queue sender-targeted external keyboard-interactive requests", () => {
  assert.equal(
    shouldQueueKeyboardInteractiveRequest({ scope: "external", sessionId: "sftp-conn-1" }, sessions),
    true,
  );
});

test("disabled peer windows can still queue owned terminal keyboard-interactive requests", () => {
  assert.equal(
    shouldQueueKeyboardInteractiveRequest({ scope: "terminal", sessionId: "terminal-1" }, sessions),
    true,
  );
});

test("legacy unscoped keyboard-interactive requests remain visible", () => {
  assert.equal(
    shouldQueueKeyboardInteractiveRequest({ sessionId: "legacy-conn" }, sessions),
    true,
  );
});
