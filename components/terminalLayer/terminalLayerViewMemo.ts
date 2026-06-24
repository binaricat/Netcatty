/* eslint-disable @typescript-eslint/no-explicit-any */

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
  return prev[key] === next[key];
}

function sidePanelCtxKeyEqual(prev: Ctx, next: Ctx, key: string): boolean {
  if (key === 'activeWorkspace') {
    return activeWorkspaceEqual(prev.activeWorkspace, next.activeWorkspace);
  }
  return prev[key] === next[key];
}

const SIDE_PANEL_CTX_KEYS = [
  'mountedSftpTabIds',
  'mountedAiTabIds',
  'notesMountedTabIds',
  'notesOpenNoteByTab',
  'scriptsMountedTabIds',
  'systemMountedTabIds',
  'themeMountedTabIds',
  'activeTerminalSessionForSystem',
  'activeSystemSessionHost',
  'focusedHost',
  'historySessionId',
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
  'resolvedPreviewTheme',
  'sftpActiveHost',
  'sftpHostForTab',
  'activeTerminalSessionIdForSftp',
  'activeTerminalCwd',
  'activeWorkspace',
  'effectiveHosts',
  'hosts',
  'keys',
  'identities',
  'updateHosts',
  'updateSnippets',
  'updateSnippetPackages',
  'sftpDefaultViewMode',
  'sftpInitialLocationForTab',
  'sftpPendingUploadsForTab',
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
  'followAppTerminalTheme',
  'previewedOrVisibleThemeId',
  'terminalTheme',
  'terminalFontFamilyId',
  'focusedFontFamilyId',
  'focusedFontFamilyOverridden',
  'focusedFontSize',
  'focusedFontSizeOverridden',
  'focusedFontWeight',
  'focusedFontWeightOverridden',
  'focusedThemeOverridden',
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
  'workspaceById',
  'workspaceRectsById',
  'isTerminalLayerVisible',
  'workspaceFocusHandlersRef',
  'workspaceBroadcastHandlersRef',
  'splitHorizontalHandlersRef',
  'splitVerticalHandlersRef',
  'themePreview',
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

export function terminalLayerSidePanelCtxEqual(prev: Ctx, next: Ctx): boolean {
  for (const key of SIDE_PANEL_CTX_KEYS as unknown as string[]) {
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
