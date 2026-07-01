import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTerminalContextReadResult,
  buildTerminalContextSnapshotText,
  resolveTerminalContextLineWindow,
} from "./terminalContextRead.ts";

test("resolveTerminalContextLineWindow returns the visible viewport range", () => {
  assert.deepEqual(resolveTerminalContextLineWindow({
    range: "viewport",
    totalLines: 200,
    viewportStartLine: 150,
    viewportEndLine: 173,
  }), {
    startLine: 150,
    endLine: 173,
    maxLines: 80,
  });
});

test("resolveTerminalContextLineWindow clamps tail reads to the configured max lines", () => {
  assert.deepEqual(resolveTerminalContextLineWindow({
    range: "tail",
    totalLines: 500,
    maxLines: 120,
  }), {
    startLine: 380,
    endLine: 499,
    maxLines: 120,
  });
});

test("buildTerminalContextReadResult reports paging metadata for selected lines", () => {
  const text = Array.from({ length: 20 }, (_, index) => `line-${index}`).join("\n");
  const result = buildTerminalContextReadResult({
    sessionId: "session-1",
    label: "prod",
    fullText: text,
    range: "lines",
    startLine: 5,
    maxLines: 4,
    source: "snapshot",
  });

  assert.equal(result.ok, true);
  assert.equal(result.sessionId, "session-1");
  assert.equal(result.label, "prod");
  assert.equal(result.content, "line-5\nline-6\nline-7\nline-8");
  assert.equal(result.totalLines, 20);
  assert.equal(result.startLine, 5);
  assert.equal(result.endLine, 8);
  assert.equal(result.returnedLines, 4);
  assert.equal(result.hasMoreBefore, true);
  assert.equal(result.hasMoreAfter, true);
  assert.equal(result.source, "snapshot");
});

test("buildTerminalContextSnapshotText extends viewport to pending output", () => {
  const snapshot = buildTerminalContextSnapshotText({
    scrollbackText: "old-1\nold-2",
    viewportText: "visible-1\nvisible-2",
    pendingText: "pending-1",
  });
  const result = buildTerminalContextReadResult({
    sessionId: "session-1",
    fullText: snapshot.fullText,
    range: "viewport",
    source: "snapshot",
    viewportStartLine: snapshot.viewportStartLine,
    viewportEndLine: snapshot.viewportEndLine,
  });

  assert.equal(snapshot.fullText, "old-1\nold-2\nvisible-1\nvisible-2\npending-1");
  assert.equal(result.content, "visible-1\nvisible-2\npending-1");
  assert.equal(result.startLine, 2);
  assert.equal(result.endLine, 4);
  assert.equal(result.hasMoreBefore, true);
  assert.equal(result.hasMoreAfter, false);
});

test("viewport reads keep the newest lines when the snapshot viewport exceeds max lines", () => {
  const text = Array.from({ length: 10 }, (_, index) => `line-${index}`).join("\n");
  const result = buildTerminalContextReadResult({
    sessionId: "session-1",
    fullText: text,
    range: "viewport",
    source: "snapshot",
    maxLines: 4,
    viewportStartLine: 2,
    viewportEndLine: 9,
  });

  assert.equal(result.content, "line-6\nline-7\nline-8\nline-9");
  assert.equal(result.startLine, 6);
  assert.equal(result.endLine, 9);
});
