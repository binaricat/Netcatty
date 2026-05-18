import test from "node:test";
import assert from "node:assert/strict";

import type { Workspace } from "../types";
import { getScopedTopTabsThemeId } from "./terminalTopTabsTheme.ts";

const workspace = (sessionIds: string[], viewMode?: Workspace["viewMode"]): Workspace => ({
  id: "workspace-1",
  title: "Workspace",
  viewMode,
  focusedSessionId: sessionIds[0],
  root: {
    id: "split-1",
    type: "split",
    direction: "vertical",
    children: sessionIds.map((sessionId) => ({
      id: `pane-${sessionId}`,
      type: "pane",
      sessionId,
    })),
  },
});

const resolveThemeFrom = (themes: Record<string, string>) => (sessionId: string) => themes[sessionId] ?? null;

test("top tabs use root immersive theme for normal single-session tab switching", () => {
  assert.equal(
    getScopedTopTabsThemeId({
      activeSidePanelTab: null,
      activeThemePreviewId: null,
      activeWorkspace: undefined,
      followAppTerminalTheme: false,
      isVisible: true,
      previewTargetSessionId: "s1",
      previewedOrVisibleThemeId: "tokyo-night",
      resolveSessionThemeId: resolveThemeFrom({ s1: "tokyo-night" }),
    }),
    null,
  );
});

test("top tabs are scoped while previewing a terminal theme", () => {
  assert.equal(
    getScopedTopTabsThemeId({
      activeSidePanelTab: "theme",
      activeThemePreviewId: "catppuccin",
      activeWorkspace: undefined,
      followAppTerminalTheme: false,
      isVisible: true,
      previewTargetSessionId: "s1",
      previewedOrVisibleThemeId: "catppuccin",
      resolveSessionThemeId: resolveThemeFrom({ s1: "tokyo-night" }),
    }),
    "catppuccin",
  );
});

test("top tabs use root immersive theme for same-theme workspace splits", () => {
  assert.equal(
    getScopedTopTabsThemeId({
      activeSidePanelTab: null,
      activeThemePreviewId: null,
      activeWorkspace: workspace(["s1", "s2"]),
      followAppTerminalTheme: false,
      isVisible: true,
      previewTargetSessionId: "s1",
      previewedOrVisibleThemeId: "tokyo-night",
      resolveSessionThemeId: resolveThemeFrom({ s1: "tokyo-night", s2: "tokyo-night" }),
    }),
    null,
  );
});

test("top tabs are scoped for mixed-theme workspace splits", () => {
  assert.equal(
    getScopedTopTabsThemeId({
      activeSidePanelTab: null,
      activeThemePreviewId: null,
      activeWorkspace: workspace(["s1", "s2"]),
      followAppTerminalTheme: false,
      isVisible: true,
      previewTargetSessionId: "s1",
      previewedOrVisibleThemeId: "tokyo-night",
      resolveSessionThemeId: resolveThemeFrom({ s1: "tokyo-night", s2: "solarized-light" }),
    }),
    "tokyo-night",
  );
});

test("top tabs avoid scoped theme when following the application theme", () => {
  assert.equal(
    getScopedTopTabsThemeId({
      activeSidePanelTab: null,
      activeThemePreviewId: null,
      activeWorkspace: workspace(["s1", "s2"]),
      followAppTerminalTheme: true,
      isVisible: true,
      previewTargetSessionId: "s1",
      previewedOrVisibleThemeId: "app-theme",
      resolveSessionThemeId: resolveThemeFrom({ s1: "tokyo-night", s2: "solarized-light" }),
    }),
    null,
  );
});
