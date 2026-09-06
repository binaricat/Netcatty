import { terminalPaneSessionsEqual } from '../domain/terminalPaneSessionsEqual';

export const terminalLayerAreEqual = (
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): boolean => (
  prev.hosts === next.hosts &&
  prev.customGroups === next.customGroups &&
  prev.groupConfigs === next.groupConfigs &&
  prev.proxyProfiles === next.proxyProfiles &&
  prev.portForwardingRules === next.portForwardingRules &&
  prev.keys === next.keys &&
  prev.snippets === next.snippets &&
  prev.snippetPackages === next.snippetPackages &&
  // notes / noteGroups / updateNotes / updateNoteGroups intentionally omitted —
  // Notes + AI panels read notesStore.
  prev.openNoteRequest === next.openNoteRequest &&
  prev.onOpenVaultNoteFromChat === next.onOpenVaultNoteFromChat &&
  prev.onOpenVaultHostFromChat === next.onOpenVaultHostFromChat &&
  prev.onOpenVaultSectionFromChat === next.onOpenVaultSectionFromChat &&
  prev.onOpenVaultSnippetFromChat === next.onOpenVaultSnippetFromChat &&
  // Ignore TopTabs-only presentation fields (dynamicTitle / codingCliProviderId).
  terminalPaneSessionsEqual(
    prev.sessions as never,
    next.sessions as never,
  ) &&
  prev.workspaces === next.workspaces &&
  prev.knownHosts === next.knownHosts &&
  prev.draggingSessionId === next.draggingSessionId &&
  prev.terminalTheme === next.terminalTheme &&
  prev.terminalThemeId === next.terminalThemeId &&
  prev.followAppTerminalTheme === next.followAppTerminalTheme &&
  prev.pickTerminalTheme === next.pickTerminalTheme &&
  prev.resolveSessionAppearance === next.resolveSessionAppearance &&
  // accentMode / customAccent intentionally omitted — Terminal reads
  // appearanceChromeStore so accent drag does not rebuild TerminalLayer.
  prev.terminalSettings === next.terminalSettings &&
  prev.fontSize === next.fontSize &&
  prev.terminalFontFamilyId === next.terminalFontFamilyId &&
  prev.sessionLogsEnabled === next.sessionLogsEnabled &&
  prev.sessionLogsDir === next.sessionLogsDir &&
  prev.sessionLogsFormat === next.sessionLogsFormat &&
  prev.sessionLogsTimestampsEnabled === next.sessionLogsTimestampsEnabled &&
  prev.hotkeyScheme === next.hotkeyScheme &&
  prev.disableTerminalFontZoom === next.disableTerminalFontZoom &&
  prev.restoreTerminalCwd === next.restoreTerminalCwd &&
  prev.keyBindings === next.keyBindings &&
  prev.sftpDefaultViewMode === next.sftpDefaultViewMode &&
  prev.sftpDoubleClickBehavior === next.sftpDoubleClickBehavior &&
  prev.sftpAutoSync === next.sftpAutoSync &&
  prev.sftpShowHiddenFiles === next.sftpShowHiddenFiles &&
  prev.sftpUseCompressedUpload === next.sftpUseCompressedUpload &&
  prev.sftpAutoOpenSidebar === next.sftpAutoOpenSidebar &&
  prev.terminalSidePanelAutoOpen === next.terminalSidePanelAutoOpen &&
  prev.terminalSidePanelAutoOpenTab === next.terminalSidePanelAutoOpenTab &&
  prev.sftpFollowTerminalCwd === next.sftpFollowTerminalCwd &&
  prev.setSftpFollowTerminalCwd === next.setSftpFollowTerminalCwd &&
  prev.editorWordWrap === next.editorWordWrap &&
  prev.sshDebugLogsEnabled === next.sshDebugLogsEnabled &&
  prev.showHostTreeSidebar === next.showHostTreeSidebar &&
  prev.setEditorWordWrap === next.setEditorWordWrap &&
  prev.onHotkeyAction === next.onHotkeyAction &&
  prev.onUpdateSessionRestoreCwd === next.onUpdateSessionRestoreCwd &&
  prev.onUpdateHost === next.onUpdateHost &&
  prev.onAddKnownHost === next.onAddKnownHost &&
  prev.onDeleteShellHistoryEntry === next.onDeleteShellHistoryEntry &&
  prev.onToggleWorkspaceViewMode === next.onToggleWorkspaceViewMode &&
  prev.onSetWorkspaceFocusedSession === next.onSetWorkspaceFocusedSession &&
  prev.onReorderWorkspaceSessions === next.onReorderWorkspaceSessions &&
  prev.onReorderTabs === next.onReorderTabs &&
  prev.onSplitSession === next.onSplitSession &&
  prev.onConnectToHost === next.onConnectToHost &&
  prev.onCreateLocalTerminal === next.onCreateLocalTerminal &&
  prev.isBroadcastEnabled === next.isBroadcastEnabled &&
  prev.onToggleBroadcast === next.onToggleBroadcast &&
  prev.isGlobalBroadcastEnabled === next.isGlobalBroadcastEnabled &&
  prev.canUseGlobalBroadcast === next.canUseGlobalBroadcast &&
  prev.onToggleGlobalBroadcast === next.onToggleGlobalBroadcast &&
  prev.updateSnippets === next.updateSnippets &&
  prev.updateSnippetPackages === next.updateSnippetPackages &&
  prev.toggleScriptsSidePanelRef === next.toggleScriptsSidePanelRef &&
  prev.toggleSidePanelRef === next.toggleSidePanelRef &&
  prev.paneMagnificationRef === next.paneMagnificationRef &&
  prev.identities === next.identities
  // shellHistory intentionally omitted — History panel reads shellHistoryStore.
);
