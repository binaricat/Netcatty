import test from "node:test";
import assert from "node:assert/strict";

import { recordTerminalCommandExecution } from "./terminalCommandExecution";
import { createPromptLineBreakState } from "./promptLineBreak";

function createFakeTerm(lineText = "$ echo ok", cursorX = lineText.length) {
  return {
    buffer: {
      active: {
        cursorX,
        cursorY: 0,
        baseY: 0,
        getLine(line: number) {
          if (line !== 0) return undefined;
          return {
            isWrapped: false,
            translateToString() {
              return lineText;
            },
          };
        },
      },
    },
  };
}

test("command execution arms prompt line break even without command history callback", () => {
  const promptState = createPromptLineBreakState();
  const commandBufferRef = { current: "echo ok" };

  recordTerminalCommandExecution("echo ok", {
    host: {
      id: "host-1",
      label: "Host",
    },
    sessionId: "session-1",
    commandBufferRef,
    promptLineBreakStateRef: { current: promptState },
  });

  assert.equal(commandBufferRef.current, "");
  assert.equal(promptState.pendingCommand, true);
});

test("command execution caches the current prompt instead of prompt-like command text", () => {
  const promptState = createPromptLineBreakState();
  const commandBufferRef = { current: "echo > out" };

  recordTerminalCommandExecution("echo > out", {
    host: {
      id: "host-1",
      label: "Host",
    },
    sessionId: "session-1",
    commandBufferRef,
    promptLineBreakStateRef: { current: promptState },
  }, createFakeTerm("$ echo > out") as never);

  assert.equal(promptState.lastPromptText, "$ ");
  assert.equal(promptState.pendingCommand, true);
});
