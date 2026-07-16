/* eslint-disable @typescript-eslint/no-explicit-any */

import { sftpPickerSessionsEqual } from '../../domain/sftpConnectedHosts';

type Ctx = Record<string, any>;

function eq(prev: Ctx, next: Ctx, key: string): boolean {
  return prev[key] === next[key];
}

function rectEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

function rectRecordEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!rectEqual(a[key], b[key])) return false;
  }
  return true;
}

function workspaceRectsByIdEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (!(a instanceof Map) || !(b instanceof Map)) return false;
  if (a.size !== b.size) return false;
  for (const [workspaceId, rects] of a) {
    if (!rectRecordEqual(rects, b.get(workspaceId))) return false;
  }
  return true;
}

function resizerHandleEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.id === b.id
    && a.splitId === b.splitId
    && a.index === b.index
    && a.direction === b.direction
    && rectEqual(a.rect, b.rect)
    && rectEqual(a.splitArea, b.splitArea);
}

function resizerHandlesEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!resizerHandleEqual(a[i], b[i])) return false;
  }
  return true;
}

function arrayEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function workspaceNodeEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.id !== b.id || a.type !== b.type) return false;
  if (a.type === 'pane') {
    return a.sessionId === b.sessionId;
  }
  if (a.direction !== b.direction) return false;
  if (!arrayEqual(a.sizes, b.sizes)) return false;
  if (!Array.isArray(a.children) || !Array.isArray(b.children)) return false;
  if (a.children.length !== b.children.length) return false;
  for (let i = 0; i < a.children.length; i += 1) {
    if (!workspaceNodeEqual(a.children[i], b.children[i])) return false;
  }
  return true;
}

function activeWorkspaceEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.id === b.id
    && a.title === b.title
    && a.viewMode === b.viewMode
    && a.focusedSessionId === b.focusedSessionId
    && a.snippetId === b.snippetId
    && arrayEqual(a.focusSessionOrder, b.focusSessionOrder)
    && workspaceNodeEqual(a.root, b.root);
}

function terminalThemeEqual(prev: Ctx, next: Ctx, key: string): boolean {
  if (key !== 'terminalTheme') return prev[key] === next[key];
  const a = prev.terminalTheme;
  const b = next.terminalTheme;
  if (a === b) return true;
  if (!a || !b) return false;
  return a.id === b.id
    && a.colors.background === b.colors.background
    && a.colors.foreground === b.colors.foreground
    && a.colors.cursor === b.colors.cursor;
}

function workspaceCtxKeyEqual(prev: Ctx, next: Ctx, key: string): boolean {
  if (key === 'computeSplitHint' || key === 'handleWorkspaceDrop') {
    if (!prev.draggingSessionId && !next.draggingSessionId) return true;
  }
  if (key === 'activeWorkspace') {
    return activeWorkspaceEqual(prev.activeWorkspace, next.activeWorkspace);
  }
  if (key === 'workspaceRectsById') {
    return workspaceRectsByIdEqual(prev.workspaceRectsById, next.workspaceRectsById);
  }
  if (key === 'activeResizers') {
    return resizerHandlesEqual(prev.activeResizers, next.activeResizers);
  }
  if (key === 'terminalTheme') {
    return terminalThemeEqual(prev, next, key);
  }
  return prev[key] === next[key];
}

function scriptRunsEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const prevRun = a[i];
    const nextRun = b[i];
    if (prevRun === nextRun) continue;
    if (!prevRun || !nextRun) return false;
    if (
      prevRun.runId !== nextRun.runId
      || prevRun.status !== nextRun.status
      || prevRun.stepIndex !== nextRun.stepIndex
      || prevRun.waitingFor !== nextRun.waitingFor
      || prevRun.error !== nextRun.error
      || prevRun.logs?.length !== nextRun.logs?.length
    ) {
      return false;
    }
  }
  return true;
}

function sidePanelCtxKeyEqual(prev: Ctx, next: Ctx, key: string): boolean {
  if (key === 'scriptRuns') {
    return scriptRunsEqual(prev.scriptRuns, next.scriptRuns);
  }
  if (key === 'activeWorkspace') {
    return activeWorkspaceEqual(prev.activeWorkspace, next.activeWorkspace);
  }
  if (key === 'terminalTheme') {
    return terminalThemeEqual(prev, next, key);
  }
  if (key === 'sessions') {
    // Connected picker and retained system panels need transport and tab ownership,
    // while title/cwd churn can still be ignored.
    if (prev.sessions === next.sessions) return true;
    if (!sftpPickerSessionsEqual(prev.sessions, next.sessions)) return false;
    if (!Array.isArray(prev.sessions) || !Array.isArray(next.sessions)) return false;
    return prev.sessions.every((session: any, index: number) => (
      session.workspaceId === next.sessions[index]?.workspaceId
    ));
  }
  return prev[key] === next[key];
}

const SIDE_PANEL_LIVE_CTX_KEYS = [
  'activeTerminalSessionForSystem',
  'activeSystemSessionHost',
  'focusedHost',
  'focusedSessionId',
  'historySessionId',
  'scriptRuns',
  'resolvedPreviewTheme',
  'previewedOrVisibleThemeId',
  'sftpActiveHost',
  'activeTerminalSessionIdForSftp',
  'activeTerminalCwd',
  'activeWorkspace',
  'focusedFontFamilyId',
  'focusedFontFamilyOverridden',
  'focusedFontSize',
  'focusedFontSizeOverridden',
  'focusedFontWeight',
  'focusedFontWeightOverridden',
  'focusedThemeOverridden',
] as const;

const SIDE_PANEL_STABLE_CTX_KEYS = [
  'mountedSftpTabIds',
  'mountedAiTabIds',
  'notesMountedTabIds',
  'notesOpenNoteByTab',
  'scriptsMountedTabIds',
  'systemMountedTabIds',
  'themeMountedTabIds',
  'remoteHistory',
  'shellHistory',
  'handleHistoryPaste',
  'handleHistoryRun',
  'handleOpenHistory',
  'HistorySidePanel',
  'History',
  'sidePanelWidth',
  'sidePanelPosition',
  'sidePanelOpenTabs',
  'sftpHostForTab',
  'effectiveHosts',
  'hosts',
  // SFTP Connected picker reads live terminal sessions from stable ctx.
  'sessions',
  'sessionHostsMap',
  'workspaceById',
  'keys',
  'identities',
  'updateHosts',
  'updateSnippets',
  'updateSnippetPackages',
  'sftpDefaultViewMode',
  'sftpInitialLocationForTab',
  'sftpPendingUploadsForTab',
  'handleSftpCurrentPathChange',
  'sftpDoubleClickBehavior',
  'sftpAutoSync',
  'sftpShowHiddenFiles',
  'sftpUseCompressedUpload',
  'sftpFollowTerminalCwd',
  'setSftpFollowTerminalCwd',
  'hotkeyScheme',
  'keyBindings',
  'editorWordWrap',
  'setEditorWordWrap',
  'getTerminalCwd',
  'refocusActiveTerminalSession',
  'terminalSettings',
  'snippets',
  'snippetPackages',
  'handleSnippetFromPanel',
  'handleRunScriptFromPanel',
  'handleRunScriptOnWorkspace',
  'handleStartRecordingFromPanel',
  'handleStopScriptRun',
  'handlePauseScriptRun',
  'handleResumeScriptRun',
  'followAppTerminalTheme',
  'terminalTheme',
  'terminalThemeId',
  'terminalFontFamilyId',
  'handleThemeChangeForFocusedSession',
  'handleThemeResetForFocusedSession',
  'handleFontFamilyChangeForFocusedSession',
  'handleFontFamilyResetForFocusedSession',
  'handleFontSizeChangeForFocusedSession',
  'handleFontSizeResetForFocusedSession',
  'handleFontWeightChangeForFocusedSession',
  'handleFontWeightResetForFocusedSession',
  'aiContextsByTabId',
  'resolveAIExecutorContext',
  'pendingTerminalSelectionForAI',
  'handlePendingTerminalSelectionConsumed',
  'setSidePanelWidth',
  'persistSidePanelWidth',
  'handleToggleSftpFromBar',
  'handleOpenScripts',
  'handleOpenTheme',
  'handleOpenAI',
  'handleOpenNotes',
  'handleBackFromNotes',
  'handleOpenHostFromNotes',
  'handleOpenSystem',
  'handleCloseSidePanel',
  'setSidePanelPosition',
  'handleSftpInitialLocationApplied',
  'handlePendingUploadHandled',
  'validAIScopeTargetIds',
  'AISidePanelStateRoot',
  'NotesManager',
  'notes',
  'noteGroups',
  'updateNotes',
  'updateNoteGroups',
  'onOpenVaultNoteFromChat',
  'onOpenVaultHostFromChat',
  'onOpenVaultSectionFromChat',
  'onOpenVaultSnippetFromChat',
  't',
] as const;

const WORKSPACE_CTX_KEYS = [
  'workspaceInnerRef',
  'workspaceOverlayRef',
  'draggingSessionId',
  'isFocusMode',
  'dropHint',
  'setDropHint',
  'computeSplitHint',
  'handleWorkspaceDrop',
  'sessions',
  'sessionHostsMap',
  'sessionChainHostsMap',
  'sessionSudoAutofillPasswordsMap',
  'sessionSudoAutofillCandidatesMap',
  'workspaceById',
  'workspaceRectsById',
  'isTerminalLayerVisible',
  'workspaceFocusHandlersRef',
  'workspaceBroadcastHandlersRef',
  'splitHorizontalHandlersRef',
  'splitVerticalHandlersRef',
  'resolveSessionAppearance',
  'hostMap',
  'keys',
  'identities',
  'snippets',
  'knownHosts',
  'terminalFontFamilyId',
  'fontSize',
  'terminalTheme',
  'followAppTerminalTheme',
  'accentMode',
  'customAccent',
  'terminalSettings',
  'hotkeyScheme',
  'disableTerminalFontZoom',
  'restoreTerminalCwd',
  'keyBindings',
  'resizing',
  'isComposeBarOpen',
  'sessionLogConfig',
  'sshDebugLogsEnabled',
  'onHotkeyAction',
  'handleTerminalFontSizeChange',
  'handleOpenSftp',
  'handleTerminalCwdChange',
  'handleTerminalTitleChange',
  'handleTerminalBell',
  'handleTerminalOutput',
  'handleTerminalContextReaderChange',
  'handleOpenScripts',
  'handleOpenHistory',
  'handleOpenSystem',
  'handleOpenTheme',
  'handleCloseSession',
  'handleStatusChange',
  'handleSessionExit',
  'handleTerminalDataCapture',
  'handleOsDetected',
  'handleUpdateHost',
  'handleAddKnownHost',
  'handleCommandExecuted',
  'handleCommandSubmitted',
  'onSetWorkspaceFocusedSession',
  'onSplitSession',
  'isBroadcastEnabled',
  'handleBroadcastInput',
  'handleBroadcastInterruptPriorityChange',
  'handleToggleWorkspaceComposeBar',
  'handleSnippetExecutorChange',
  'handleProgrammaticCommandLogRewriteChange',
  'handleAddSelectionToAI',
  'activeResizers',
  'activeWorkspace',
  'composeBarThemeColors',
  'findSplitNode',
  'focusedSessionId',
  'handleComposeSend',
  'handleSnippetFromPanel',
  'refocusTerminalSession',
  'setIsComposeBarOpen',
  'TerminalComposeBar',
  'setResizing',
  'Array',
  'cn',
  'onStartSessionRename',
  'onRemoveSessionFromWorkspace',
  'onReorderTabs',
  'onStartSessionDrag',
  'onEndSessionDrag',
] as const;

export function terminalLayerSidePanelStableCtxEqual(prev: Ctx, next: Ctx): boolean {
  for (const key of SIDE_PANEL_STABLE_CTX_KEYS as unknown as string[]) {
    if (!sidePanelCtxKeyEqual(prev, next, key)) return false;
  }
  return true;
}

export function terminalLayerSidePanelCtxEqual(prev: Ctx, next: Ctx): boolean {
  if (!terminalLayerSidePanelStableCtxEqual(prev, next)) return false;
  for (const key of SIDE_PANEL_LIVE_CTX_KEYS as unknown as string[]) {
    if (!sidePanelCtxKeyEqual(prev, next, key)) return false;
  }
  return true;
}

export function terminalLayerWorkspaceCtxEqual(prev: Ctx, next: Ctx): boolean {
  for (const key of WORKSPACE_CTX_KEYS as unknown as string[]) {
    if (!workspaceCtxKeyEqual(prev, next, key)) return false;
  }
  return true;
}

export function terminalLayerViewCtxEqual(prev: Ctx, next: Ctx): boolean {
  if (prev.isTerminalLayerVisible !== next.isTerminalLayerVisible) return false;
  if (prev.hibernateHiddenTabs !== next.hibernateHiddenTabs) return false;
  if (prev.isComposeBarOpen !== next.isComposeBarOpen) return false;
  if (!activeWorkspaceEqual(prev.activeWorkspace, next.activeWorkspace)) return false;
  if (prev.focusedSessionId !== next.focusedSessionId) return false;
  if (prev.handleComposeSend !== next.handleComposeSend) return false;
  if (prev.refocusTerminalSession !== next.refocusTerminalSession) return false;
  if (prev.setIsComposeBarOpen !== next.setIsComposeBarOpen) return false;
  if (prev.isBroadcastEnabled !== next.isBroadcastEnabled) return false;
  if (prev.composeBarThemeColors !== next.composeBarThemeColors) return false;
  if (prev.workspaceOuterRef !== next.workspaceOuterRef) return false;
  return terminalLayerSidePanelCtxEqual(prev, next)
    && terminalLayerFocusSidebarPropsEqual(prev, next)
    && terminalLayerWorkspaceCtxEqual(prev, next);
}

export function terminalLayerFocusSidebarPropsEqual(prev: Ctx, next: Ctx): boolean {
  if (prev.isFocusMode !== next.isFocusMode) return false;
  if (!prev.isFocusMode) return true;

  const prevWs = prev.activeWorkspace;
  const nextWs = next.activeWorkspace;
  if (Boolean(prevWs) !== Boolean(nextWs)) return false;
  if (prevWs && nextWs) {
    if (prevWs.id !== nextWs.id) return false;
    if (prevWs.viewMode !== nextWs.viewMode) return false;
    if (prevWs.root !== nextWs.root) return false;
    if (prevWs.focusSessionOrder !== nextWs.focusSessionOrder) return false;
  }

  return eq(prev, next, 'focusedSessionId')
    && eq(prev, next, 'resolvedPreviewTheme')
    && eq(prev, next, 'sessionHostsMap')
    && eq(prev, next, 'sessions')
    && prev.terminalSettings?.dynamicTabTitleMode === next.terminalSettings?.dynamicTabTitleMode
    && eq(prev, next, 't')
    && eq(prev, next, 'onReorderWorkspaceSessions')
    && eq(prev, next, 'onRequestAddToWorkspace')
    && eq(prev, next, 'handleCloseSession')
    && eq(prev, next, 'onCopySession')
    && eq(prev, next, 'onCopySessionToNewWindow')
    && eq(prev, next, 'onRemoveSessionFromWorkspace')
    && eq(prev, next, 'onSetWorkspaceFocusedSession')
    && eq(prev, next, 'onToggleWorkspaceViewMode')
    && eq(prev, next, 'onSubmitSessionRename');
}
