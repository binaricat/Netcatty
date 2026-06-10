/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useMemo, useRef } from 'react';

import { useActiveTabId } from '../../application/state/activeTabStore';
import { canReuseTerminalConnection } from '../../application/state/terminalConnectionReuse';
import { cn } from '../../lib/utils';
import type { Host, TerminalSession, Workspace } from '../../types';
import { TerminalLayerView } from './TerminalLayerView';
import { useTerminalAiContexts } from './useTerminalAiContexts';
import { useTerminalLayerEffects } from './useTerminalLayerEffects';
import { useTerminalThemePanelState } from './useTerminalThemePanelState';
import { useTerminalWorkspaceLayout } from './useTerminalWorkspaceLayout';
import type { SidePanelTab } from './TerminalLayerSupport';

type StableRef = React.MutableRefObject<Record<string, any>>;

export function TerminalLayerTabBridge({ stableRef }: { stableRef: StableRef }) {
  const s = stableRef.current;
  const activeTabId = useActiveTabId();

  s.activeTabIdRef.current = activeTabId;

  const workspaceById = s.workspaceById as Map<string, Workspace>;
  const sessions = s.sessions as TerminalSession[];
  const sessionHostsMap = s.sessionHostsMap as Map<string, Host>;
  const sftpHostForTab = s.sftpHostForTab as Map<string, Host>;
  const sidePanelOpenTabs = s.sidePanelOpenTabs as Map<string, SidePanelTab>;
  const showHostTreeSidebar = s.showHostTreeSidebar as boolean | undefined;

  const activeWorkspace = useMemo(
    () => (activeTabId ? workspaceById.get(activeTabId) : undefined),
    [activeTabId, workspaceById],
  );
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeTabId),
    [activeTabId, sessions],
  );
  const isFocusMode = activeWorkspace?.viewMode === 'focus';
  const focusedSessionId = activeWorkspace?.focusedSessionId;

  s.activeWorkspaceRef.current = activeWorkspace;
  s.activeSessionRef.current = activeSession;
  s.focusedSessionIdRef.current = focusedSessionId;

  const isVisible = Boolean(activeSession || activeWorkspace || s.draggingSessionId);
  const isTerminalLayerVisible = isVisible || !!s.draggingSessionId;

  const {
    activeResizers,
    computeSplitHint,
    dropHint,
    findSplitNode,
    handleWorkspaceDrop,
    resizing,
    setDropHint,
    setResizing,
    setWorkspaceArea,
    workspaceInnerRef,
    workspaceOuterRef,
    workspaceOverlayRef,
    workspaceRectsById,
  } = useTerminalWorkspaceLayout({
    activeSession,
    activeWorkspace,
    isFocusMode,
    onAddSessionToWorkspace: s.onAddSessionToWorkspace,
    onCreateWorkspaceFromSessions: s.onCreateWorkspaceFromSessions,
    onSetDraggingSessionId: s.onSetDraggingSessionId,
    onUpdateSplitSizes: s.onUpdateSplitSizes,
    sessions,
    workspaces: s.workspaces,
  });

  const isSidePanelOpenForCurrentTab = activeTabId ? sidePanelOpenTabs.has(activeTabId) : false;
  const activeSidePanelTab = activeTabId ? sidePanelOpenTabs.get(activeTabId) ?? null : null;
  const isSftpOpenForCurrentTab = activeSidePanelTab === 'sftp';

  const activeHostIdForSidebar = useMemo(() => {
    const sessionId = activeWorkspace ? focusedSessionId : activeSession?.id;
    if (!sessionId) return null;
    return sessionHostsMap.get(sessionId)?.id
      ?? sessions.find((session) => session.id === sessionId)?.hostId
      ?? null;
  }, [activeWorkspace, focusedSessionId, activeSession, sessionHostsMap, sessions]);

  const sftpActiveHost = useMemo((): Host | null => {
    if (!isSftpOpenForCurrentTab || !activeTabId) return null;
    if (activeWorkspace && focusedSessionId) {
      return sessionHostsMap.get(focusedSessionId) ?? sftpHostForTab.get(activeTabId) ?? null;
    }
    if (activeSession) {
      return sessionHostsMap.get(activeSession.id) ?? sftpHostForTab.get(activeTabId) ?? null;
    }
    return sftpHostForTab.get(activeTabId) ?? null;
  }, [activeSession, activeTabId, activeWorkspace, focusedSessionId, isSftpOpenForCurrentTab, sessionHostsMap, sftpHostForTab]);

  const activeTerminalSessionIdForSftp = useMemo((): string | null => {
    if (!isSftpOpenForCurrentTab || !sftpActiveHost) return null;
    const sessionId = activeWorkspace ? focusedSessionId : activeSession?.id;
    if (!sessionId) return null;
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (!session || !canReuseTerminalConnection(session)) return null;
    const sessionHost = sessionHostsMap.get(session.id);
    if (!sessionHost) return null;
    const sameEndpoint =
      sessionHost.hostname === sftpActiveHost.hostname
      && (sessionHost.port || 22) === (sftpActiveHost.port || 22)
      && (sessionHost.username || 'root') === (sftpActiveHost.username || 'root');
    return sameEndpoint ? session.id : null;
  }, [activeSession?.id, activeWorkspace, focusedSessionId, isSftpOpenForCurrentTab, sessions, sessionHostsMap, sftpActiveHost]);

  const linkedTerminalSessionIdForSftp = useMemo((): string | null => {
    if (!isSftpOpenForCurrentTab) return null;
    if (activeTerminalSessionIdForSftp) return activeTerminalSessionIdForSftp;
    return activeWorkspace ? (focusedSessionId ?? null) : (activeSession?.id ?? null);
  }, [
    activeSession?.id,
    activeTerminalSessionIdForSftp,
    activeWorkspace,
    focusedSessionId,
    isSftpOpenForCurrentTab,
  ]);

  const activeTerminalCwd = useMemo(() => {
    if (!linkedTerminalSessionIdForSftp) return null;
    return s.terminalRendererCwdBySessionRef.current.get(linkedTerminalSessionIdForSftp) ?? null;
    // terminalCwdRevision bumps when any session cwd changes so linked SFTP can react.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedTerminalSessionIdForSftp, s.terminalCwdRevision]);

  const themeState = useTerminalThemePanelState({
    accentMode: s.accentMode,
    activeSession,
    activeSidePanelTab,
    activeWorkspace,
    customAccent: s.customAccent,
    followAppTerminalTheme: s.followAppTerminalTheme,
    focusedSessionId,
    fontSize: s.fontSize,
    hostMap: s.hostMap,
    isVisible,
    onUpdateHost: s.onUpdateHost,
    onUpdateTerminalFontFamilyId: s.onUpdateTerminalFontFamilyId,
    onUpdateTerminalFontSize: s.onUpdateTerminalFontSize,
    onUpdateTerminalFontWeight: s.onUpdateTerminalFontWeight,
    onUpdateTerminalThemeId: s.onUpdateTerminalThemeId,
    sessionHostsMap,
    terminalFontFamilyId: s.terminalFontFamilyId,
    terminalSettings: s.terminalSettings,
    terminalTheme: s.terminalTheme,
  });

  const { aiContextsByTabId, resolveAIExecutorContext } = useTerminalAiContexts({
    hostsRef: s.hostsRef,
    mountedAiTabIds: s.mountedAiTabIds,
    sessionHostsMap,
    sessions,
    sessionsRef: s.sessionsRef,
    workspaces: s.workspaces,
    workspacesRef: s.workspacesRef,
  });

  const prevFocusedSessionIdRef = useRef<string | undefined>(undefined);

  useTerminalLayerEffects({
    activeSidePanelTab,
    activeTabId,
    activeTabIdRef: s.activeTabIdRef,
    activeTopTabsThemeId: themeState.activeTopTabsThemeId,
    activeWorkspace,
    activityTrackedSessions: s.activityTrackedSessions,
    appliedPreviewSessionRef: themeState.appliedPreviewSessionRef,
    applyTerminalPreviewVars: themeState.applyTerminalPreviewVars,
    applyTopTabsPreviewVars: themeState.applyTopTabsPreviewVars,
    cancelAnimationFrame,
    ChunkedEscapeFilter: s.ChunkedEscapeFilter,
    clearTerminalPreviewVars: s.clearTerminalPreviewVars,
    clearTimeout,
    clearTopTabsPreviewVars: s.clearTopTabsPreviewVars,
    document,
    dropHint,
    filterTabsMap: s.filterTabsMap,
    focusedSessionId,
    followAppTerminalTheme: s.followAppTerminalTheme,
    getSessionActivityIdsToClear: s.getSessionActivityIdsToClear,
    handleToggleAiFromTopBar: s.handleToggleAiFromTopBar,
    handleToggleScriptsSidePanel: s.handleToggleScriptsSidePanel,
    handleToggleSidePanel: s.handleToggleSidePanel,
    hasNotifiableTerminalOutput: s.hasNotifiableTerminalOutput,
    isComposeBarOpen: s.isComposeBarOpen,
    isFocusMode,
    isTerminalLayerVisible,
    lastSidePanelTabRef: s.lastSidePanelTabRef,
    Map,
    Math,
    onSessionData: s.onSessionData,
    onSplitSessionRef: s.onSplitSessionRef,
    onToggleBroadcastRef: s.onToggleBroadcastRef,
    onToggleWorkspaceViewModeRef: s.onToggleWorkspaceViewModeRef,
    prevFocusedSessionIdRef,
    previewTargetSessionId: themeState.previewTargetSessionId,
    refocusActiveTerminalSession: s.refocusActiveTerminalSession,
    requestAnimationFrame,
    ResizeObserver,
    sessionActivityStore: s.sessionActivityStore,
    sessions,
    Set,
    setDropHint,
    setSftpHostForTab: s.setSftpHostForTab,
    setSftpInitialLocationForTab: s.setSftpInitialLocationForTab,
    setSftpPendingUploadsForTab: s.setSftpPendingUploadsForTab,
    setAiMountedTabIds: s.setAiMountedTabIds,
    setScriptsMountedTabIds: s.setScriptsMountedTabIds,
    setThemeMountedTabIds: s.setThemeMountedTabIds,
    setSidePanelOpenTabs: s.setSidePanelOpenTabs,
    setThemePreview: themeState.setThemePreview,
    setTimeout,
    setupMcpApprovalBridge: s.setupMcpApprovalBridge,
    setWorkspaceArea,
    sidePanelPosition: s.sidePanelPosition,
    sidePanelWidth: s.sidePanelWidth,
    sftpActiveHost,
    sftpHostForTab,
    shouldMarkSessionActivity: s.shouldMarkSessionActivity,
    sidePanelOpenTabs,
    splitHorizontalHandlersRef: s.splitHorizontalHandlersRef,
    splitVerticalHandlersRef: s.splitVerticalHandlersRef,
    terminalRendererCwdBySessionRef: s.terminalRendererCwdBySessionRef,
    themeCommitTimerRef: themeState.themeCommitTimerRef,
    themePreview: themeState.themePreview,
    toggleScriptsSidePanelRef: s.toggleScriptsSidePanelRef,
    toggleSidePanelRef: s.toggleSidePanelRef,
    validAIScopeTargetIds: s.validAIScopeTargetIds,
    validSessionActivityIds: s.validSessionActivityIds,
    visibleFocusedThemeId: themeState.visibleFocusedThemeId,
    window,
    workspaceBroadcastHandlersRef: s.workspaceBroadcastHandlersRef,
    workspaceFocusHandlersRef: s.workspaceFocusHandlersRef,
    workspaceInnerRef,
    workspaces: s.workspaces,
  });

  const ctx = useMemo(() => ({
    accentMode: s.accentMode,
    activeHostIdForSidebar,
    activeResizers,
    activeSidePanelTab,
    activeTabId,
    activeTerminalCwd,
    activeTerminalSessionIdForSftp,
    activeWorkspace,
    AIChatPanelsHost: s.AIChatPanelsHost,
    AISidePanelStateRoot: s.AISidePanelStateRoot,
    aiContextsByTabId,
    Array: s.Array,
    Button: s.Button,
    cn,
    composeBarThemeColors: themeState.composeBarThemeColors,
    computeSplitHint,
    customAccent: s.customAccent,
    customGroups: s.customGroups,
    draggingSessionId: s.draggingSessionId,
    dropHint,
    editorWordWrap: s.editorWordWrap,
    effectiveHosts: s.effectiveHosts,
    findSplitNode,
    focusedFontFamilyId: themeState.focusedFontFamilyId,
    focusedFontFamilyOverridden: themeState.focusedFontFamilyOverridden,
    focusedFontSize: themeState.focusedFontSize,
    focusedFontSizeOverridden: themeState.focusedFontSizeOverridden,
    focusedFontWeight: themeState.focusedFontWeight,
    focusedFontWeightOverridden: themeState.focusedFontWeightOverridden,
    focusedSessionId,
    focusedThemeOverridden: themeState.focusedThemeOverridden,
    FolderTree: s.FolderTree,
    followAppTerminalTheme: s.followAppTerminalTheme,
    fontSize: s.fontSize,
    getTerminalCwd: s.getTerminalCwd,
    handleAddKnownHost: s.handleAddKnownHost,
    handleAddSelectionToAI: s.handleAddSelectionToAI,
    handleBroadcastInput: s.handleBroadcastInput,
    handleCloseSession: s.handleCloseSession,
    handleCloseSidePanel: s.handleCloseSidePanel,
    handleCommandExecuted: s.handleCommandExecuted,
    handleCommandSubmitted: s.handleCommandSubmitted,
    handleComposeSend: s.handleComposeSend,
    handleFontFamilyChangeForFocusedSession: themeState.handleFontFamilyChangeForFocusedSession,
    handleFontFamilyResetForFocusedSession: themeState.handleFontFamilyResetForFocusedSession,
    handleFontSizeChangeForFocusedSession: themeState.handleFontSizeChangeForFocusedSession,
    handleFontSizeResetForFocusedSession: themeState.handleFontSizeResetForFocusedSession,
    handleFontWeightChangeForFocusedSession: themeState.handleFontWeightChangeForFocusedSession,
    handleFontWeightResetForFocusedSession: themeState.handleFontWeightResetForFocusedSession,
    handleOpenAI: s.handleOpenAI,
    handleOpenScripts: s.handleOpenScripts,
    handleOpenSftp: s.handleOpenSftp,
    handleOpenTheme: s.handleOpenTheme,
    handleOsDetected: s.handleOsDetected,
    handlePendingTerminalSelectionConsumed: s.handlePendingTerminalSelectionConsumed,
    handlePendingUploadHandled: s.handlePendingUploadHandled,
    handleSessionExit: s.handleSessionExit,
    handleSftpInitialLocationApplied: s.handleSftpInitialLocationApplied,
    persistSidePanelWidth: s.persistSidePanelWidth,
    setSidePanelWidth: s.setSidePanelWidth,
    handleSnippetClickForFocusedSession: s.handleSnippetClickForFocusedSession,
    handleSnippetFromPanel: s.handleSnippetFromPanel,
    handleSnippetExecutorChange: s.handleSnippetExecutorChange,
    handleStatusChange: s.handleStatusChange,
    handleTerminalCwdChange: s.handleTerminalCwdChange,
    handleTerminalDataCapture: s.handleTerminalDataCapture,
    handleTerminalFontSizeChange: s.handleTerminalFontSizeChange,
    handleThemeChangeForFocusedSession: themeState.handleThemeChangeForFocusedSession,
    handleThemeResetForFocusedSession: themeState.handleThemeResetForFocusedSession,
    handleToggleSftpFromBar: s.handleToggleSftpFromBar,
    handleToggleWorkspaceComposeBar: s.handleToggleWorkspaceComposeBar,
    handleUpdateHost: s.handleUpdateHost,
    handleWorkspaceDrop,
    hosts: s.hosts,
    hotkeyScheme: s.hotkeyScheme,
    identities: s.identities,
    isBroadcastEnabled: s.isBroadcastEnabled,
    isComposeBarOpen: s.isComposeBarOpen,
    isFocusMode,
    isSidePanelOpenForCurrentTab,
    isTerminalLayerVisible,
    keyBindings: s.keyBindings,
    keys: s.keys,
    knownHosts: s.knownHosts,
    MessageSquare: s.MessageSquare,
    mountedAiTabIds: s.mountedAiTabIds,
    mountedSftpTabIds: s.mountedSftpTabIds,
    scriptsMountedTabIds: s.scriptsMountedTabIds,
    themeMountedTabIds: s.themeMountedTabIds,
    onConnectToHost: s.onConnectToHost,
    onCreateLocalTerminal: s.onCreateLocalTerminal,
    onHotkeyAction: s.onHotkeyAction,
    onReorderWorkspaceSessions: s.onReorderWorkspaceSessions,
    onRequestAddToWorkspace: s.onRequestAddToWorkspace,
    onSetWorkspaceFocusedSession: s.onSetWorkspaceFocusedSession,
    onSplitSession: s.onSplitSession,
    onToggleWorkspaceViewMode: s.onToggleWorkspaceViewMode,
    Palette: s.Palette,
    PanelLeft: s.PanelLeft,
    PanelRight: s.PanelRight,
    pendingTerminalSelectionForAI: s.pendingTerminalSelectionForAI,
    previewedOrVisibleThemeId: themeState.previewedOrVisibleThemeId,
    refocusActiveTerminalSession: s.refocusActiveTerminalSession,
    refocusTerminalSession: s.refocusTerminalSession,
    resizing,
    resolveAIExecutorContext,
    resolvedPreviewTheme: themeState.resolvedPreviewTheme,
    ScriptsSidePanel: s.ScriptsSidePanel,
    sessionChainHostsMap: s.sessionChainHostsMap,
    sessionHostsMap,
    sessionLogConfig: s.sessionLogConfig,
    sessionSudoAutofillPasswordsMap: s.sessionSudoAutofillPasswordsMap,
    sessions,
    setDropHint,
    setEditorWordWrap: s.setEditorWordWrap,
    setIsComposeBarOpen: s.setIsComposeBarOpen,
    setResizing,
    showHostTreeSidebar,
    setSidePanelPosition: s.setSidePanelPosition,
    setSftpFollowTerminalCwd: s.setSftpFollowTerminalCwd,
    sftpActiveHost,
    sftpHostForTab,
    sftpAutoSync: s.sftpAutoSync,
    sftpDefaultViewMode: s.sftpDefaultViewMode,
    sftpDoubleClickBehavior: s.sftpDoubleClickBehavior,
    sftpFollowTerminalCwd: s.sftpFollowTerminalCwd,
    sftpInitialLocationForTab: s.sftpInitialLocationForTab,
    sftpPendingUploadsForTab: s.sftpPendingUploadsForTab,
    sftpShowHiddenFiles: s.sftpShowHiddenFiles,
    SftpSidePanel: s.SftpSidePanel,
    sftpUseCompressedUpload: s.sftpUseCompressedUpload,
    sidePanelPosition: s.sidePanelPosition,
    sidePanelWidth: s.sidePanelWidth,
    sidePanelOpenTabs,
    snippetPackages: s.snippetPackages,
    snippets: s.snippets,
    splitHorizontalHandlersRef: s.splitHorizontalHandlersRef,
    splitVerticalHandlersRef: s.splitVerticalHandlersRef,
    sshDebugLogsEnabled: s.sshDebugLogsEnabled,
    t: s.t,
    TerminalComposeBar: s.TerminalComposeBar,
    terminalFontFamilyId: s.terminalFontFamilyId,
    TerminalPanesHost: s.TerminalPanesHost,
    terminalSettings: s.terminalSettings,
    terminalTheme: s.terminalTheme,
    themePreview: themeState.themePreview,
    ThemeSidePanel: s.ThemeSidePanel,
    Tooltip: s.Tooltip,
    TooltipContent: s.TooltipContent,
    TooltipTrigger: s.TooltipTrigger,
    updateHosts: s.updateHosts,
    validAIScopeTargetIds: s.validAIScopeTargetIds,
    workspaceBroadcastHandlersRef: s.workspaceBroadcastHandlersRef,
    workspaceById,
    workspaceFocusHandlersRef: s.workspaceFocusHandlersRef,
    workspaceInnerRef,
    workspaceOuterRef,
    workspaceOverlayRef,
    workspaceRectsById,
    X: s.X,
    Zap: s.Zap,
    // stableRef fields are intentionally omitted from deps — they update every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [
    activeHostIdForSidebar,
    activeResizers,
    activeSidePanelTab,
    activeTabId,
    activeTerminalCwd,
    activeTerminalSessionIdForSftp,
    activeWorkspace,
    aiContextsByTabId,
    computeSplitHint,
    dropHint,
    focusedSessionId,
    handleWorkspaceDrop,
    isFocusMode,
    isSidePanelOpenForCurrentTab,
    isTerminalLayerVisible,
    resizing,
    resolveAIExecutorContext,
    sessionHostsMap,
    sessions,
    showHostTreeSidebar,
    sftpActiveHost,
    themeState,
    workspaceById,
    workspaceInnerRef,
    workspaceOuterRef,
    workspaceOverlayRef,
    workspaceRectsById,
  ]);

  return <TerminalLayerView ctx={ctx} />;
}
