import test from "node:test";
import assert from "node:assert/strict";

import type { ConnectionLog } from "./models.ts";
import { selectConnectionLogForTerminalDataCapture } from "./connectionLog.ts";
import {
  MAX_PERSISTED_UNSAVED_TERMINAL_DATA_ENTRIES,
  mergeConnectionLogsFromStorage,
  mergeTerminalDataIntoLogs,
  mergeTerminalDataMapsForStorage,
  pruneTerminalDataMapForStorage,
} from "./connectionLogTerminalData.ts";

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

test("selectConnectionLogForTerminalDataCapture does not cross-match localhost logs without sessionId", () => {
  const openLocalWithoutSession = {
    ...baseLog,
    id: "open-local",
    sessionId: undefined,
    hostname: "localhost",
    protocol: "local",
    startTime: 3000,
  };
  const targetLocal = {
    ...baseLog,
    id: "target-local",
    sessionId: "session-local-a",
    hostname: "localhost",
    protocol: "local",
    startTime: 2000,
  };

  assert.equal(
    selectConnectionLogForTerminalDataCapture(
      [openLocalWithoutSession, targetLocal],
      { sessionId: "session-local-b", hostname: "localhost" },
    ),
    undefined,
  );
});

test("mergeConnectionLogsFromStorage keeps in-memory terminal replay data", () => {
  const memoryLog = {
    ...baseLog,
    id: "memory",
    terminalData: "captured output",
  };
  const storedLog = {
    ...baseLog,
    id: "memory",
    endTime: 2000,
  };

  const merged = mergeConnectionLogsFromStorage(
    [memoryLog],
    [storedLog],
    {},
  );

  assert.equal(merged[0]?.terminalData, "captured output");
});

test("mergeTerminalDataIntoLogs hydrates unsaved logs from side storage", () => {
  const storedLog = { ...baseLog, id: "hydrate" };
  const hydrated = mergeTerminalDataIntoLogs([storedLog], {
    hydrate: "side-store output",
  });

  assert.equal(hydrated[0]?.terminalData, "side-store output");
});

test("pruneTerminalDataMapForStorage caps unsaved replay buffers", () => {
  const logs: ConnectionLog[] = Array.from({ length: 60 }, (_, index) => ({
    ...baseLog,
    id: `log-${index}`,
    startTime: index,
    saved: false,
  }));

  const map = Object.fromEntries(
    logs.map((log) => [log.id, `data-${log.id}`]),
  );

  const pruned = pruneTerminalDataMapForStorage(logs, map);
  assert.equal(Object.keys(pruned).length, MAX_PERSISTED_UNSAVED_TERMINAL_DATA_ENTRIES);
  assert.equal(pruned["log-59"], "data-log-59");
  assert.equal(pruned["log-0"], undefined);
});

test("mergeTerminalDataMapsForStorage keeps replay data from other windows", () => {
  const logs: ConnectionLog[] = [
    { ...baseLog, id: "local", startTime: 2000 },
    { ...baseLog, id: "remote", startTime: 1000 },
  ];

  const merged = mergeTerminalDataMapsForStorage(
    logs,
    { remote: "remote-window output", other: "other-window only" },
    [{ local: "local-window output" }],
    new Set(["local", "remote", "other"]),
  );

  assert.equal(merged.remote, "remote-window output");
  assert.equal(merged.local, "local-window output");
  assert.equal(merged.other, "other-window only");
});

test("mergeTerminalDataMapsForStorage prefers fresher local replay data for orphans", () => {
  const logs: ConnectionLog[] = [{ ...baseLog, id: "local", startTime: 2000 }];

  const merged = mergeTerminalDataMapsForStorage(
    logs,
    { other: "stale snapshot" },
    [{ other: "fresh local" }],
    new Set(["local", "other"]),
  );

  assert.equal(merged.other, "fresh local");
});

test("mergeTerminalDataMapsForStorage drops deleted log replay buffers", () => {
  const logs: ConnectionLog[] = [{ ...baseLog, id: "local", startTime: 2000 }];

  const merged = mergeTerminalDataMapsForStorage(
    logs,
    { local: "keep", deleted: "drop me" },
    [],
    new Set(["local"]),
  );

  assert.equal(merged.local, "keep");
  assert.equal(merged.deleted, undefined);
});
