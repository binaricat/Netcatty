import assert from "node:assert/strict";
import test from "node:test";

import { toEditorTabId } from "../state/activeTabStore.ts";
import type { EditorTab } from "../state/editorTabStore.ts";
import type { LogView } from "../state/logViewState.ts";
import { isActiveChromeThemeResolvable, resolveActiveChromeTheme } from "./activeChromeTheme.ts";
import type { Host, TerminalSession, TerminalTheme, Workspace } from "../../types";

const theme = (id: string, type: "dark" | "light" = "dark"): TerminalTheme => ({
  id,
  name: id,
  type,
  colors: {
    background: type === "dark" ? "#111111" : "#eeeeee",
    foreground: type === "dark" ? "#eeeeee" : "#111111",
    cursor: "#22aaff",
  },
});

const currentTheme = theme("current");
const hostTheme = theme("host-theme");
const logTheme = theme("log-theme", "light");

const baseInput = {
  accentMode: "theme" as const,
  currentTerminalTheme: currentTheme,
  customAccent: "221.2 83.2% 53.3%",
  editorTabs: [],
  followAppTerminalTheme: false,
  hostById: new Map<string, Host>(),
  logViews: [],
  sessionById: new Map<string, TerminalSession>(),
  themeById: new Map([
    [currentTheme.id, currentTheme],
    [hostTheme.id, hostTheme],
    [logTheme.id, logTheme],
  ]),
  workspaceById: new Map<string, Workspace>(),
};

test("editor tabs use the owning host terminal theme when follow-app terminal theme is off", () => {
  const editorTab = {
    id: "editor-1",
    hostId: "host-1",
    sessionId: "sftp-1",
  };

  const resolved = resolveActiveChromeTheme({
    ...baseInput,
    activeTabId: toEditorTabId(editorTab.id),
    editorTabs: [editorTab as unknown as EditorTab],
    hostById: new Map([
      ["host-1", { id: "host-1", theme: hostTheme.id } as unknown as Host],
    ]),
  });

  assert.equal(resolved?.id, hostTheme.id);
});

test("editor tabs use the followed terminal theme when follow-app terminal theme is on", () => {
  const editorTab = {
    id: "editor-1",
    hostId: "host-1",
    sessionId: "sftp-1",
  };

  const resolved = resolveActiveChromeTheme({
    ...baseInput,
    activeTabId: toEditorTabId(editorTab.id),
    editorTabs: [editorTab as unknown as EditorTab],
    followAppTerminalTheme: true,
    hostById: new Map([
      ["host-1", { id: "host-1", theme: hostTheme.id } as unknown as Host],
    ]),
  });

  assert.equal(resolved?.id, currentTheme.id);
});

test("log tabs use the saved log theme when available", () => {
  const resolved = resolveActiveChromeTheme({
    ...baseInput,
    activeTabId: "log-1",
    logViews: [{
      id: "log-1",
      connectionLogId: "1",
      log: { id: "1", themeId: logTheme.id },
    } as unknown as LogView],
  });

  assert.equal(resolved?.id, logTheme.id);
});

test("root pages use the normal application theme", () => {
  const resolved = resolveActiveChromeTheme({
    ...baseInput,
    activeTabId: "vault",
  });

  assert.equal(resolved, null);
});

test("follow-app workspace split view always uses the global terminal theme", () => {
  const workspace: Workspace = {
    id: "ws-1",
    name: "Workspace",
    viewMode: "split",
    focusedSessionId: "session-1",
    root: {
      type: "split",
      direction: "horizontal",
      sizes: [50, 50],
      children: [
        { type: "session", sessionId: "session-1" },
        { type: "session", sessionId: "session-2" },
      ],
    },
  } as unknown as Workspace;

  const hostA = { id: "host-a", theme: hostTheme.id, themeOverride: true } as unknown as Host;
  const hostB = { id: "host-b", theme: logTheme.id, themeOverride: true } as unknown as Host;

  const resolved = resolveActiveChromeTheme({
    ...baseInput,
    activeTabId: "ws-1",
    followAppTerminalTheme: true,
    hostById: new Map([
      ["host-a", hostA],
      ["host-b", hostB],
    ]),
    sessionById: new Map([
      ["session-1", { id: "session-1", hostId: "host-a" } as TerminalSession],
      ["session-2", { id: "session-2", hostId: "host-b" } as TerminalSession],
    ]),
    workspaceById: new Map([["ws-1", workspace]]),
  });

  assert.equal(resolved?.id, currentTheme.id);
});

test("manual workspace split view uses the focused session theme when panes differ", () => {
  const workspace: Workspace = {
    id: "ws-1",
    name: "Workspace",
    viewMode: "split",
    focusedSessionId: "session-2",
    root: {
      type: "split",
      direction: "horizontal",
      sizes: [50, 50],
      children: [
        { type: "pane", sessionId: "session-1" },
        { type: "pane", sessionId: "session-2" },
      ],
    },
  } as unknown as Workspace;

  const hostA = { id: "host-a", theme: hostTheme.id, themeOverride: true } as unknown as Host;
  const hostB = { id: "host-b", theme: logTheme.id, themeOverride: true } as unknown as Host;
  const focusedTheme = theme("focused-intent");

  const resolved = resolveActiveChromeTheme({
    ...baseInput,
    activeTabId: "ws-1",
    hostById: new Map([
      ["host-a", hostA],
      ["host-b", hostB],
    ]),
    sessionById: new Map([
      ["session-1", { id: "session-1", hostId: "host-a" } as TerminalSession],
      ["session-2", { id: "session-2", hostId: "host-b" } as TerminalSession],
    ]),
    workspaceById: new Map([["ws-1", workspace]]),
    resolveSessionAppearance: ({ host }) => (
      host?.id === "host-b"
        ? { themeId: focusedTheme.id, theme: focusedTheme, source: "intent", appThemeUpdate: null }
        : { themeId: hostTheme.id, theme: hostTheme, source: "host-override", appThemeUpdate: null }
    ),
  });

  assert.equal(resolved?.id, focusedTheme.id);
});

test("manual split workspace falls back to the first tree session theme when focus is stale", () => {
  const workspace: Workspace = {
    id: "ws-1",
    name: "Workspace",
    viewMode: "split",
    focusedSessionId: "missing-session",
    root: {
      type: "split",
      direction: "horizontal",
      sizes: [50, 50],
      children: [
        { type: "pane", sessionId: "session-1" },
        { type: "pane", sessionId: "session-2" },
      ],
    },
  } as unknown as Workspace;

  const hostA = { id: "host-a", theme: hostTheme.id, themeOverride: true } as unknown as Host;
  const hostB = { id: "host-b", theme: logTheme.id, themeOverride: true } as unknown as Host;

  const resolved = resolveActiveChromeTheme({
    ...baseInput,
    activeTabId: "ws-1",
    hostById: new Map([
      ["host-a", hostA],
      ["host-b", hostB],
    ]),
    sessionById: new Map([
      ["session-1", { id: "session-1", hostId: "host-a" } as TerminalSession],
      ["session-2", { id: "session-2", hostId: "host-b" } as TerminalSession],
    ]),
    workspaceById: new Map([["ws-1", workspace]]),
  });

  assert.equal(resolved?.id, hostTheme.id);
});

test("manual mode prefers runtime session appearance over stale host theme ids", () => {
  const intentTheme = theme("intent-theme");
  const resolved = resolveActiveChromeTheme({
    ...baseInput,
    activeTabId: "session-1",
    hostById: new Map([
      ["host-1", { id: "host-1", theme: hostTheme.id, themeOverride: true } as unknown as Host],
    ]),
    sessionById: new Map([
      ["session-1", { id: "session-1", hostId: "host-1" } as TerminalSession],
    ]),
    resolveSessionAppearance: () => ({
      themeId: intentTheme.id,
      theme: intentTheme,
      source: "intent",
      appThemeUpdate: null,
    }),
  });

  assert.equal(resolved?.id, intentTheme.id);
});

test("chrome theme sync waits until a newly opened session is present in deps", () => {
  assert.equal(
    isActiveChromeThemeResolvable({
      activeTabId: "session-new",
      editorTabs: [],
      logViews: [],
      sessionById: new Map(),
      workspaceById: new Map(),
    }),
    false,
  );

  assert.equal(
    isActiveChromeThemeResolvable({
      activeTabId: "session-new",
      editorTabs: [],
      logViews: [],
      sessionById: new Map([["session-new", { id: "session-new" } as TerminalSession]]),
      workspaceById: new Map(),
    }),
    true,
  );
});
