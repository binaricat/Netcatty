import type { TerminalProps } from './terminalHelpers';

const themeFingerprint = (theme: TerminalProps['terminalTheme'] | undefined): string => (
  theme?.colors ? `${theme.id}:${theme.colors.background}:${theme.colors.foreground}:${theme.colors.cursor}` : ''
);

export const terminalPropsAreEqual = (
  prev: TerminalProps,
  next: TerminalProps,
): boolean => (
  prev.host === next.host
  && prev.keys === next.keys
  && prev.identities === next.identities
  && prev.snippets === next.snippets
  && prev.snippetPackages === next.snippetPackages
  && prev.compactToolbar === next.compactToolbar
  && prev.lineTimestampsAvailable === next.lineTimestampsAvailable
  && prev.chainHosts === next.chainHosts
  && themeFingerprint(prev.appearanceTheme ?? prev.terminalTheme) === themeFingerprint(next.appearanceTheme ?? next.terminalTheme)
  && prev.knownHosts === next.knownHosts
  // Solo tab switches only flip isVisible. Skipping it leaves isVisibleRef
  // stale, so hidden panes keep the visible write path and tab-return recovery
  // in useTerminalEffects never runs (#1985).
  && prev.isVisible === next.isVisible
  && prev.paneLayoutKey === next.paneLayoutKey
  && prev.inWorkspace === next.inWorkspace
  && prev.isResizing === next.isResizing
  && prev.isFocusMode === next.isFocusMode
  && prev.isFocused === next.isFocused
  && prev.fontFamilyId === next.fontFamilyId
  && prev.fontSize === next.fontSize
  && prev.followAppTerminalTheme === next.followAppTerminalTheme
  && prev.accentMode === next.accentMode
  && prev.customAccent === next.customAccent
  && prev.terminalSettings === next.terminalSettings
  && prev.sessionId === next.sessionId
  && prev.restoreState === next.restoreState
  && prev.shellType === next.shellType
  && prev.lastCwd === next.lastCwd
  && prev.restoreTerminalCwd === next.restoreTerminalCwd
  && prev.sessionDisplayName === next.sessionDisplayName
  && prev.startupCommand === next.startupCommand
  && prev.noAutoRun === next.noAutoRun
  && prev.pendingScriptId === next.pendingScriptId
  && prev.pendingScript === next.pendingScript
  && prev.reuseConnectionFromSessionId === next.reuseConnectionFromSessionId
  && prev.attachExistingSession === next.attachExistingSession
  && prev.serialConfig === next.serialConfig
  && prev.hotkeyScheme === next.hotkeyScheme
  && prev.disableTerminalFontZoom === next.disableTerminalFontZoom
  && prev.keyBindings === next.keyBindings
  && prev.isBroadcastEnabled === next.isBroadcastEnabled
  && prev.isWorkspaceComposeBarOpen === next.isWorkspaceComposeBarOpen
  && prev.sessionLog === next.sessionLog
  && prev.sshDebugLogEnabled === next.sshDebugLogEnabled
  && prev.sudoAutofillPassword === next.sudoAutofillPassword
  && prev.sudoAutofillCandidates === next.sudoAutofillCandidates
  && prev.showSelectionAIAction === next.showSelectionAIAction
  && prev.onHotkeyAction === next.onHotkeyAction
  && prev.onTerminalFontSizeChange === next.onTerminalFontSizeChange
  && prev.onStatusChange === next.onStatusChange
  && prev.onSessionExit === next.onSessionExit
  && prev.onTerminalDataCapture === next.onTerminalDataCapture
  && prev.onOsDetected === next.onOsDetected
  && prev.onCloseSession === next.onCloseSession
  && prev.onUpdateHost === next.onUpdateHost
  && prev.onAddKnownHost === next.onAddKnownHost
  && prev.onExpandToFocus === next.onExpandToFocus
  && prev.onCommandExecuted === next.onCommandExecuted
  && prev.onCommandSubmitted === next.onCommandSubmitted
  && prev.onSplitHorizontal === next.onSplitHorizontal
  && prev.onSplitVertical === next.onSplitVertical
  && prev.onOpenSftp === next.onOpenSftp
  && prev.onTerminalCwdChange === next.onTerminalCwdChange
  && prev.onTerminalTitleChange === next.onTerminalTitleChange
  && prev.onTerminalBell === next.onTerminalBell
  && prev.onTerminalOutput === next.onTerminalOutput
  && prev.onTerminalContextReaderChange === next.onTerminalContextReaderChange
  && prev.onOpenScripts === next.onOpenScripts
  && prev.onOpenHistory === next.onOpenHistory
  && prev.onOpenTheme === next.onOpenTheme
  && prev.onOpenSystem === next.onOpenSystem
  && prev.onToggleBroadcast === next.onToggleBroadcast
  && prev.onToggleComposeBar === next.onToggleComposeBar
  && prev.onBroadcastInput === next.onBroadcastInput
  && prev.onBroadcastInterruptPriorityChange === next.onBroadcastInterruptPriorityChange
  && prev.onSnippetExecutorChange === next.onSnippetExecutorChange
  && prev.onProgrammaticCommandLogRewriteChange === next.onProgrammaticCommandLogRewriteChange
  && prev.onAddSelectionToAI === next.onAddSelectionToAI
  && prev.onRename === next.onRename
  && prev.onDetach === next.onDetach
  && prev.onStartSessionDrag === next.onStartSessionDrag
  && prev.onEndSessionDrag === next.onEndSessionDrag
  && prev.onDetachPointerDown === next.onDetachPointerDown
  && prev.onDetachDragStart === next.onDetachDragStart
  && prev.onDetachDragEnd === next.onDetachDragEnd
);
