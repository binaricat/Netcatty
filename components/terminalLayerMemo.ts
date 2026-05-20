export const terminalLayerAreEqual = (
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): boolean => (
  prev.hosts === next.hosts &&
  prev.groupConfigs === next.groupConfigs &&
  prev.proxyProfiles === next.proxyProfiles &&
  prev.keys === next.keys &&
  prev.snippets === next.snippets &&
  prev.snippetPackages === next.snippetPackages &&
  prev.sessions === next.sessions &&
  prev.workspaces === next.workspaces &&
  prev.knownHosts === next.knownHosts &&
  prev.draggingSessionId === next.draggingSessionId &&
  prev.terminalTheme === next.terminalTheme &&
  prev.accentMode === next.accentMode &&
  prev.customAccent === next.customAccent &&
  prev.terminalSettings === next.terminalSettings &&
  prev.fontSize === next.fontSize &&
  prev.hotkeyScheme === next.hotkeyScheme &&
  prev.keyBindings === next.keyBindings &&
  prev.sftpDefaultViewMode === next.sftpDefaultViewMode &&
  prev.sftpDoubleClickBehavior === next.sftpDoubleClickBehavior &&
  prev.sftpAutoSync === next.sftpAutoSync &&
  prev.sftpShowHiddenFiles === next.sftpShowHiddenFiles &&
  prev.sftpUseCompressedUpload === next.sftpUseCompressedUpload &&
  prev.sftpAutoOpenSidebar === next.sftpAutoOpenSidebar &&
  prev.editorWordWrap === next.editorWordWrap &&
  prev.setEditorWordWrap === next.setEditorWordWrap &&
  prev.onHotkeyAction === next.onHotkeyAction &&
  prev.onUpdateHost === next.onUpdateHost &&
  prev.onAddKnownHost === next.onAddKnownHost &&
  prev.onToggleWorkspaceViewMode === next.onToggleWorkspaceViewMode &&
  prev.onSetWorkspaceFocusedSession === next.onSetWorkspaceFocusedSession &&
  prev.onReorderWorkspaceSessions === next.onReorderWorkspaceSessions &&
  prev.onSplitSession === next.onSplitSession &&
  prev.isBroadcastEnabled === next.isBroadcastEnabled &&
  prev.onToggleBroadcast === next.onToggleBroadcast &&
  prev.toggleScriptsSidePanelRef === next.toggleScriptsSidePanelRef &&
  prev.identities === next.identities
);
