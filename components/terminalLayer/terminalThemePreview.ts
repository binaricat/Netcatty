export type TerminalThemePreviewState = {
  targetSessionId: string | null;
  targetHostId: string | null;
  globalPreview: boolean;
  themeId: string | null;
};

export const emptyTerminalThemePreview = (): TerminalThemePreviewState => ({
  targetSessionId: null,
  targetHostId: null,
  globalPreview: false,
  themeId: null,
});

/** Which terminal panes should render a theme preview (sidebar list uses themeId separately). */
export function resolvePaneThemePreviewId(
  followAppTerminalTheme: boolean,
  themePreview: TerminalThemePreviewState,
  sessionId: string,
  hostId: string,
): string | undefined {
  if (followAppTerminalTheme || !themePreview.themeId) return undefined;
  if (themePreview.globalPreview) return themePreview.themeId;
  if (sessionId === themePreview.targetSessionId) return themePreview.themeId;
  if (themePreview.targetHostId && hostId === themePreview.targetHostId) return themePreview.themeId;
  return undefined;
}

export function listThemePreviewSessionIds(
  sessions: ReadonlyArray<{ id: string }>,
  sessionHostsMap: Map<string, { id: string }>,
  themePreview: TerminalThemePreviewState,
  followAppTerminalTheme: boolean,
): string[] {
  if (followAppTerminalTheme || !themePreview.themeId) return [];
  return sessions.flatMap((session) => {
    const hostId = sessionHostsMap.get(session.id)?.id ?? '';
    return resolvePaneThemePreviewId(followAppTerminalTheme, themePreview, session.id, hostId)
      ? [session.id]
      : [];
  });
}
