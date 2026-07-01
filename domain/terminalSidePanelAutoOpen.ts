export const TERMINAL_SIDE_PANEL_AUTO_OPEN_TABS = [
  "sftp",
  "scripts",
  "history",
  "theme",
  "system",
  "notes",
  "ai",
] as const;

export type TerminalSidePanelAutoOpenTab = typeof TERMINAL_SIDE_PANEL_AUTO_OPEN_TABS[number];

export const DEFAULT_TERMINAL_SIDE_PANEL_AUTO_OPEN_ENABLED = false;
export const DEFAULT_TERMINAL_SIDE_PANEL_AUTO_OPEN_TAB: TerminalSidePanelAutoOpenTab = "scripts";

export function isTerminalSidePanelAutoOpenTab(
  value: unknown,
): value is TerminalSidePanelAutoOpenTab {
  return typeof value === "string"
    && TERMINAL_SIDE_PANEL_AUTO_OPEN_TABS.includes(value as TerminalSidePanelAutoOpenTab);
}

export function resolveTerminalSidePanelAutoOpen({
  enabled,
  selectedTab,
  sftpAvailable,
}: {
  enabled: boolean;
  selectedTab: TerminalSidePanelAutoOpenTab;
  sftpAvailable: boolean;
}): TerminalSidePanelAutoOpenTab | null {
  if (!enabled) return null;
  if (selectedTab === "sftp" && !sftpAvailable) return null;
  return selectedTab;
}
