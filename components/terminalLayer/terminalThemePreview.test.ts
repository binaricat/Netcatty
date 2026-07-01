import assert from "node:assert/strict";
import test from "node:test";

import {
  emptyTerminalThemePreview,
  listThemePreviewSessionIds,
  resolvePaneThemePreviewId,
} from "./terminalThemePreview";

const preview = {
  targetSessionId: "session-a",
  targetHostId: "host-1",
  globalPreview: false,
  themeId: "dracula",
};

test("follow-app mode never applies per-pane theme preview ids", () => {
  assert.equal(
    resolvePaneThemePreviewId(true, preview, "session-a", "host-1"),
    undefined,
  );
});

test("host-scoped preview applies to every session on the same host", () => {
  assert.equal(
    resolvePaneThemePreviewId(false, preview, "session-b", "host-1"),
    "dracula",
  );
  assert.equal(
    resolvePaneThemePreviewId(false, preview, "session-c", "host-2"),
    undefined,
  );
});

test("global preview applies to all sessions", () => {
  const globalPreview = { ...preview, globalPreview: true, targetHostId: null };
  assert.equal(
    resolvePaneThemePreviewId(false, globalPreview, "session-z", "host-9"),
    "dracula",
  );
});

test("listThemePreviewSessionIds skips follow-app previews", () => {
  const sessions = [{ id: "session-a" }, { id: "session-b" }];
  const sessionHostsMap = new Map([
    ["session-a", { id: "host-1" }],
    ["session-b", { id: "host-1" }],
  ]);

  assert.deepEqual(
    listThemePreviewSessionIds(sessions, sessionHostsMap, preview, true),
    [],
  );
  assert.deepEqual(
    listThemePreviewSessionIds(sessions, sessionHostsMap, preview, false),
    ["session-a", "session-b"],
  );
});

test("emptyTerminalThemePreview returns a cleared preview state", () => {
  assert.deepEqual(emptyTerminalThemePreview(), {
    targetSessionId: null,
    targetHostId: null,
    globalPreview: false,
    themeId: null,
  });
});
