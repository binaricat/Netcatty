import { fromEditorTabId, isEditorTabId } from "../state/activeTabStore";

export type ResolveActiveChromeThemeInput = {
  accentMode: "theme" | "custom";
  activeTabId: string;
  currentTerminalTheme: TerminalTheme;
  customAccent: string;
  editorTabs: readonly EditorTab[];
  followAppTerminalTheme: boolean;
  hostById: Map<string, Host>;
  logViews: readonly LogView[];
  sessionById: Map<string, TerminalSession>;
  themeById: Map<string, TerminalTheme>;
  workspaceById: Map<string, Workspace>;
};

export function isActiveChromeThemeResolvable({
  activeTabId,
  editorTabs,
  logViews,
  sessionById,
  workspaceById,
}: Pick<
  ResolveActiveChromeThemeInput,
  "activeTabId" | "editorTabs" | "logViews" | "sessionById" | "workspaceById"
>): boolean {
  if (activeTabId === "vault" || activeTabId === "sftp") return true;
  if (isEditorTabId(activeTabId)) {
    return editorTabs.some((tab) => tab.id === fromEditorTabId(activeTabId));
  }
  if (logViews.some((item) => item.id === activeTabId)) return true;
  if (workspaceById.has(activeTabId)) return true;
  if (sessionById.has(activeTabId)) return true;
  return false;
}
import { applyCustomAccentToTerminalTheme, resolveHostTerminalThemeId } from "../../domain/terminalAppearance";
import { collectSessionIds } from "../../domain/workspace";
import type { EditorTab } from "../state/editorTabStore";
import type { LogView } from "../state/logViewState";
import type { Host, TerminalSession, TerminalTheme, Workspace } from "../../types";

export function resolveActiveChromeTheme({
  accentMode,
  activeTabId,
  currentTerminalTheme,
  customAccent,
  editorTabs,
  followAppTerminalTheme,
  hostById,
  logViews,
  sessionById,
  themeById,
  workspaceById,
}: ResolveActiveChromeThemeInput): TerminalTheme | null {
  if (activeTabId === "vault" || activeTabId === "sftp") return null;

  const resolveHostTheme = (hostId: string): TerminalTheme => {
    if (followAppTerminalTheme) return currentTerminalTheme;
    const host = hostById.get(hostId) ?? null;
    const themeId = resolveHostTerminalThemeId(host, currentTerminalTheme.id);
    const baseTheme = themeById.get(themeId) ?? currentTerminalTheme;
    return applyCustomAccentToTerminalTheme(baseTheme, accentMode, customAccent);
  };

  const resolveSessionTheme = (session: TerminalSession): TerminalTheme => resolveHostTheme(session.hostId);

  if (isEditorTabId(activeTabId)) {
    const editorTabId = fromEditorTabId(activeTabId);
    const editorTab = editorTabs.find((tab) => tab.id === editorTabId);
    if (!editorTab) return null;
    return resolveHostTheme(editorTab.hostId);
  }

  const logView = logViews.find((item) => item.id === activeTabId);
  if (logView) {
    const explicitThemeId = logView.log.themeId;
    return explicitThemeId ? themeById.get(explicitThemeId) ?? currentTerminalTheme : currentTerminalTheme;
  }

  const workspace = workspaceById.get(activeTabId);
  if (workspace) {
    if (workspace.viewMode === "focus") {
      const workspaceSessionIds = collectSessionIds(workspace.root);
      const focusedSession = (workspace.focusedSessionId
        ? sessionById.get(workspace.focusedSessionId)
        : null)
        ?? workspaceSessionIds.map((id) => sessionById.get(id)).find(Boolean);
      return focusedSession ? resolveSessionTheme(focusedSession) : null;
    }

    const workspaceSessions = collectSessionIds(workspace.root)
      .map((id) => sessionById.get(id))
      .filter(Boolean) as TerminalSession[];
    if (workspaceSessions.length === 0) return null;

    const firstTheme = resolveSessionTheme(workspaceSessions[0]);
    const allSame = workspaceSessions.every((session) => resolveSessionTheme(session).id === firstTheme.id);
    return allSame ? firstTheme : null;
  }

  const session = sessionById.get(activeTabId);
  return session ? resolveSessionTheme(session) : null;
}
