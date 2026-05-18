import test from "node:test";
import assert from "node:assert/strict";

import { recordTerminalCommandExecution } from "./terminalCommandExecution";
import { createPromptLineBreakState } from "./promptLineBreak";

test("command execution arms prompt line break even without command history callback", () => {
  const promptState = createPromptLineBreakState();
  const commandBufferRef = { current: "echo ok" };

  recordTerminalCommandExecution("echo ok", {
    host: {
      id: "host-1",
      label: "Host",
      hostname: "example.test",
      username: "alice",
    },
    sessionId: "session-1",
    commandBufferRef,
    promptLineBreakStateRef: { current: promptState },
  });

  assert.equal(commandBufferRef.current, "");
  assert.equal(promptState.pendingCommand, true);
});
