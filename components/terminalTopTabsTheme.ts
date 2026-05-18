import { collectSessionIds } from "../domain/workspace";
import type { Workspace } from "../types";

export type TopTabsSidePanelTab = "sftp" | "scripts" | "theme" | "ai" | null;

type ScopedTopTabsThemeInput = {
  activeSidePanelTab: TopTabsSidePanelTab;
  activeThemePreviewId: string | null;
  activeWorkspace: Workspace | null | undefined;
  followAppTerminalTheme: boolean;
  isVisible: boolean;
  previewTargetSessionId: string | null;
  previewedOrVisibleThemeId: string;
  resolveSessionThemeId: (sessionId: string) => string | null;
};

export function getScopedTopTabsThemeId({
  activeSidePanelTab,
  activeThemePreviewId,
  activeWorkspace,
  followAppTerminalTheme,
  isVisible,
  previewTargetSessionId,
  previewedOrVisibleThemeId,
  resolveSessionThemeId,
}: ScopedTopTabsThemeInput): string | null {
  if (activeSidePanelTab === "theme" && previewTargetSessionId && activeThemePreviewId) {
    return activeThemePreviewId;
  }

  if (!isVisible || followAppTerminalTheme || !activeWorkspace || activeWorkspace.viewMode === "focus") {
    return null;
  }

  const sessionIds = collectSessionIds(activeWorkspace.root);
  if (sessionIds.length < 2) return null;

  let firstThemeId: string | null = null;
  for (const sessionId of sessionIds) {
    const themeId = resolveSessionThemeId(sessionId);
    if (!themeId) continue;
    if (firstThemeId == null) {
      firstThemeId = themeId;
      continue;
    }
    if (themeId !== firstThemeId) {
      return previewedOrVisibleThemeId;
    }
  }

  return null;
}
