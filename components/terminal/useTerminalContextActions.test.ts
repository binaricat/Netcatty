import assert from "node:assert/strict";
import test from "node:test";

import { broadcastTerminalPasteData } from "./hooks/useTerminalContextActions";

test("terminal context paste reports whether it broadcast to peers", () => {
  const broadcasted: Array<{ data: string; sessionId: string }> = [];

  const didBroadcast = broadcastTerminalPasteData("line one", {
    sourceSessionId: "workspace-session-1",
    sessionRef: { current: "backend-session-1" },
    isBroadcastEnabledRef: { current: true },
    onBroadcastInputRef: {
      current: (data, sourceSessionId) => {
        broadcasted.push({ data, sessionId: sourceSessionId });
      },
    },
  });

  assert.equal(didBroadcast, true);
  assert.deepEqual(broadcasted, [{ data: "line one", sessionId: "workspace-session-1" }]);
});

test("terminal context paste reports false when broadcast is disabled", () => {
  const didBroadcast = broadcastTerminalPasteData("line one", {
    sourceSessionId: "workspace-session-1",
    sessionRef: { current: "session-1" },
    isBroadcastEnabledRef: { current: false },
    onBroadcastInputRef: {
      current: () => {
        throw new Error("broadcast should not run");
      },
    },
  });

  assert.equal(didBroadcast, false);
});

test("paste selection dismisses the history preview before sending text", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("./hooks/useTerminalContextActions.ts", import.meta.url), "utf8");
  assert.match(source, /requestHistoryPreviewHide\(term\.element\?\.parentElement\)/);
  assert.equal(source.split("requestHistoryPreviewHide(term.element?.parentElement)").length - 1, 2);
});

test("terminal context paste never broadcasts password-prompt input", () => {
  const didBroadcast = broadcastTerminalPasteData("secret", {
    sourceSessionId: "workspace-session-1",
    sessionRef: { current: "session-1" },
    isBroadcastEnabledRef: { current: true },
    passwordPromptActiveRef: { current: true },
    onBroadcastInputRef: {
      current: () => {
        throw new Error("sensitive paste must not broadcast");
      },
    },
  });

  assert.equal(didBroadcast, false);
});
