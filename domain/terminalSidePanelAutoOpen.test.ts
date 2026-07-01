import assert from "node:assert/strict";
import test from "node:test";

import {
  TERMINAL_SIDE_PANEL_AUTO_OPEN_TABS,
  resolveTerminalSidePanelAutoOpen,
  type TerminalSidePanelAutoOpenTab,
} from "./terminalSidePanelAutoOpen.ts";
import { TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER } from "../application/state/terminalSidePanelTabs.ts";

test("terminal side panel auto-open stays off by default", () => {
  assert.equal(
    resolveTerminalSidePanelAutoOpen({
      enabled: false,
      selectedTab: "scripts",
      sftpAvailable: true,
    }),
    null,
  );
});

test("terminal side panel auto-open returns the selected non-SFTP pane", () => {
  assert.equal(
    resolveTerminalSidePanelAutoOpen({
      enabled: true,
      selectedTab: "scripts",
      sftpAvailable: false,
    }),
    "scripts",
  );
});

test("terminal side panel auto-open skips SFTP when the session cannot use it", () => {
  assert.equal(
    resolveTerminalSidePanelAutoOpen({
      enabled: true,
      selectedTab: "sftp",
      sftpAvailable: false,
    }),
    null,
  );
});

test("terminal side panel auto-open accepts every selectable side pane", () => {
  const tabs: TerminalSidePanelAutoOpenTab[] = [...TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER];

  assert.deepEqual(TERMINAL_SIDE_PANEL_AUTO_OPEN_TABS, TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER);

  assert.deepEqual(
    tabs.map((selectedTab) =>
      resolveTerminalSidePanelAutoOpen({
        enabled: true,
        selectedTab,
        sftpAvailable: true,
      }),
    ),
    tabs,
  );
});
