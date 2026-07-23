import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  isTerminalCloseGenerationCurrent,
  resolveConnectionLogCapturePayload,
  resolveHibernateSnapshotCapturePayload,
  scheduleTerminalCloseTeardown,
} from "./terminalCloseCapture.ts";

test("resolveConnectionLogCapturePayload returns null when finalize produces empty data", () => {
  assert.equal(
    resolveConnectionLogCapturePayload(() => ""),
    null,
  );
});

test("resolveConnectionLogCapturePayload returns buffered connection log data", () => {
  assert.deepEqual(
    resolveConnectionLogCapturePayload(() => "line one\r\nline two"),
    { data: "line one\r\nline two", source: "connection-log" },
  );
});

test("resolveHibernateSnapshotCapturePayload prefers combined snapshot fields", () => {
  assert.deepEqual(
    resolveHibernateSnapshotCapturePayload({
      snapshot: "full snapshot",
      viewportSnapshot: "viewport",
      scrollbackSnapshot: "scrollback",
      alternateScreen: false,
    }),
    { data: "full snapshot", source: "hibernate-serialize" },
  );

  assert.deepEqual(
    resolveHibernateSnapshotCapturePayload({
      snapshot: "",
      viewportSnapshot: "viewport",
      scrollbackSnapshot: "scrollback",
      alternateScreen: false,
    }),
    { data: "scrollbackviewport", source: "hibernate-serialize" },
  );
});

test("scheduleTerminalCloseTeardown runs teardown asynchronously", async () => {
  let ran = false;
  scheduleTerminalCloseTeardown(() => {
    ran = true;
  });
  assert.equal(ran, false);
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  assert.equal(ran, true);
});

test("isTerminalCloseGenerationCurrent rejects stale close generations", () => {
  assert.equal(isTerminalCloseGenerationCurrent(1, 1), true);
  assert.equal(isTerminalCloseGenerationCurrent(1, 2), false);
});

test("terminal close fully drains pending output before finalizing capture", () => {
  const source = readFileSync(
    new URL("../useTerminalEffects.ts", import.meta.url),
    "utf8",
  );
  const cleanupStart = source.indexOf("return () => {", source.indexOf("boot();"));
  const flushIndex = source.indexOf("await flushPendingTerminalWritesBeforeHibernate(term)", cleanupStart);
  const incompleteIndex = source.indexOf("if (!flushed)", flushIndex);
  const finalizeIndex = source.indexOf("resolveConnectionLogCapturePayload(finalizeTerminalLogData)", cleanupStart);

  assert.ok(cleanupStart >= 0);
  assert.ok(flushIndex > cleanupStart);
  assert.ok(incompleteIndex > flushIndex);
  assert.ok(finalizeIndex > flushIndex);
});
