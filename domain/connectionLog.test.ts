import test from "node:test";
import assert from "node:assert/strict";

import type { ConnectionLog } from "./models.ts";
import { selectConnectionLogForTerminalDataCapture } from "./connectionLog.ts";

const baseLog: ConnectionLog = {
  id: "log-base",
  sessionId: "session-1",
  hostId: "host-1",
  hostLabel: "Example",
  hostname: "example.com",
  username: "user",
  protocol: "ssh",
  startTime: 1000,
  localUsername: "local",
  localHostname: "machine",
  saved: false,
};

test("selectConnectionLogForTerminalDataCapture picks the active log for a normal session exit", () => {
  const matchingLog = { ...baseLog, id: "active", startTime: 2000 };
  const staleLog = {
    ...baseLog,
    id: "stale",
    sessionId: "session-2",
    startTime: 3000,
  };

  assert.equal(
    selectConnectionLogForTerminalDataCapture(
      [staleLog, matchingLog],
      { sessionId: "session-1", hostname: "example.com" },
    )?.id,
    "active",
  );
});

test("selectConnectionLogForTerminalDataCapture reuses the latest log for repeated captures after reconnect", () => {
  const firstCapture = {
    ...baseLog,
    id: "first-capture",
    startTime: 2000,
    endTime: 2500,
    terminalData: "first disconnect",
  };
  const olderSameSession = {
    ...baseLog,
    id: "older-same-session",
    startTime: 1500,
    endTime: 1800,
    terminalData: "older data",
  };
  const otherSession = {
    ...baseLog,
    id: "other-session",
    sessionId: "session-2",
    startTime: 3000,
  };

  assert.equal(
    selectConnectionLogForTerminalDataCapture(
      [otherSession, olderSameSession, firstCapture],
      { sessionId: "session-1", hostname: "example.com" },
    )?.id,
    "first-capture",
  );
});
