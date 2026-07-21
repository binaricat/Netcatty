import { FolderTree, History, MessageSquare, PanelLeft, PanelRight, Palette, X, Zap } from 'lucide-react';
import React, { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { activeTabStore } from '../application/state/activeTabStore';
import { getScriptRecordingSnapshot } from '../application/state/scriptRecordingStore.ts';
import { canReuseTerminalConnection } from '../application/state/terminalConnectionReuse';
import { resolveTerminalSessionExitIntent, type TerminalSessionExitEvent } from '../application/state/resolveTerminalSessionExitIntent';
import { prewarmAIStateStorageSnapshots } from '../application/state/aiStateSnapshots';
import {
  getSessionActivityIdsToClear,
  getValidSessionActivityIds,
  shouldMarkSessionActivity,
} from '../application/state/sessionActivity';
import { sessionActivityStore } from '../application/state/sessionActivityStore';
import { matchCodingCliProviderFromCommand } from '../domain/codingCliProviderMatch';
import { createCodingCliOutputScanner, type CodingCliOutputScanner } from '../domain/codingCliOutputDetect';
import type { CodingCliProviderId } from '../domain/codingCliProviders';
import { inferCodingCliProviderFromTitleSignals, shouldClearCodingCliProviderForTitle } from '../domain/codingCliTitleParse';
import { sessionCapabilitiesStore } from '../application/state/sessionCapabilitiesStore';
import { useTerminalBackend } from '../application/state/useTerminalBackend';
import { collectSessionIds } from '../domain/workspace';

import { cn, normalizeLineEndings } from '../lib/utils';
import { detectLocalOs } from '../lib/localShell';
import { useStoredString } from '../application/state/useStoredString';
import { useStoredNumber } from '../application/state/useStoredNumber';
import { useStoredBoolean } from '../application/state/useStoredBoolean';
import {
  STORAGE_KEY_SIDE_PANEL_WIDTH,
  STORAGE_KEY_TERMINAL_COMPOSE_BAR_OPEN,
} from '../infrastructure/config/storageKeys';
import { buildCacheKey } from '../application/state/sftp/sharedRemoteHostCache';
import {
  getSftpReopenMemoryKey,
  resolveSftpOpenLocation,
  type SftpRememberedLocation,
} from '../application/state/sftp/sftpReopenLocation';
import type { DropEntry } from '../lib/sftpFileUtils';
import { Host, KnownHost, TerminalSession, Workspace } from '../types';
import { applySessionFontSizeToHost } from '../domain/terminalAppearance';
import { resolveHostAutofillPassword } from '../domain/sshAuth';
import { listPasswordPromptFillCandidates } from '../domain/passwordPromptAssist';
import {
  resolveEffectiveTerminalHost,
  resolveTerminalChainHosts,
  resolveTerminalSessionHost,
} from '../domain/terminalHostResolution';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { toast } from './ui/toast';
import { useI18n } from '../application/i18n/I18nProvider';
import { SftpSidePanel } from './SftpSidePanel';
import { ScriptsSidePanel } from './ScriptsSidePanel';
import { HistorySidePanel } from './HistorySidePanel';
import { NotesManager } from './notes/NotesManager';
import { useRemoteHistoryState } from '../application/state/useRemoteHistoryState';
import { resolveSnippetCommand } from './SnippetExecutionProvider';
import type { Snippet } from '../types';
import { isScriptSnippet } from '../domain/snippetScript.ts';
import { useScriptExecution } from '../application/state/useScriptExecution';
import {
  pauseScriptRun,
  resumeScriptRun,
  runAutomationScript,
  stopScriptRun,
  waitForScriptRun,
} from '../application/state/scriptAutomationCoordinator';
import { ThemeSidePanel } from './terminal/ThemeSidePanel';
import { focusTerminalSessionInput } from './terminal/focusTerminalSession';
import { TerminalComposeBar } from './terminal/TerminalComposeBar';
import { resolveTerminalFontSizeUpdateTarget } from './terminalLayer/terminalFontSizeUpdate';
import {
  AUTO_RUN_SNIPPET_LINE_DELAY_MS,
  shouldDelayAutoRunSnippetInput,
  type TerminalBroadcastInputOptions,
} from './terminal/terminalHelpers';
import { Button } from './ui/button';
import { resolveScriptsSidePanelShortcutIntent } from '../application/state/resolveSnippetsShortcutIntent';
import { resolveSidePanelToggleIntent } from '../application/state/resolveSidePanelToggleIntent';
import { resolveAiSidePanelToggleIntent } from '../application/state/resolveAiSidePanelToggleIntent';
import { terminalLayerAreEqual } from './terminalLayerMemo';
import { TerminalLayerTabBridge } from './terminalLayer/TerminalLayerTabBridge';
import {
  SFTP_TRANSFER_HISTORY_RETENTION_MS,
  listInvalidSftpPanelTabIds,
  shouldClearSftpPanelAfterTransferChange,
  shouldKeepSftpMountedAfterClose,
  shouldScheduleSftpRetainedPanelCleanup,
} from './terminalLayer/sftpPanelLifecycle';
import { resolveAiNoteArtifactPanelIntent } from './terminalLayer/aiNoteArtifactPanelIntent';
import {
  canUseDirectSessionWriteFallback,
} from './terminalLayer/terminalLayerSessionRouting';
import {
  DEFAULT_TERMINAL_SIDE_PANEL_AUTO_OPEN_TAB,
  resolveTerminalSidePanelAutoOpen,
} from '../domain/terminalSidePanelAutoOpen';
import { shouldProbeCommandCwd } from './terminalLayer/commandCwdProbe';
import { resolvePreferredTerminalCwd, scheduleBackendCwdProbeAfterCommand } from './terminal/sftpCwd';
import { classifyDistroId, shouldProbeSessionCwd } from '../domain/host';

import {
  AIChatPanelsHost,
  AISidePanelStateRoot,
  AIStateMaintenanceHost,
  AIStateProvider,
  ChunkedEscapeFilter,
  clearHostTreePreviewVars,
  TerminalPanesHost,
  clearTerminalPreviewVars,
  clearTopTabsPreviewVars,
  filterTabsMap,
  hasNotifiableTerminalOutput,
  type PendingSftpUpload,
  type PendingTerminalSelectionForAI,
  type SidePanelTab,
  type SnippetExecutor,
  type TerminalLayerProps,
} from './terminalLayer/TerminalLayerSupport';

const addMountedSidePanelTabId = (
  tabIds: string[],
  tabId: string,
): string[] => (tabIds.includes(tabId) ? tabIds : [...tabIds, tabId]);

const removeMountedSidePanelTabId = (
  tabIds: string[],
  tabId: string,
): string[] => tabIds.filter((id) => id !== tabId);

function buildScriptSessionMeta(
  sessionId: string,
  sessions: TerminalSession[],
  hosts: Host[],
) {
  const session = sessions.find((entry) => entry.id === sessionId);
  if (!session) return undefined;
  const host = hosts.find((entry) => entry.id === session.hostId);
  return {
    connected: session.status === 'connected',
    hostname: host?.hostname ?? session.hostname,
    username: host?.username ?? session.username,
  };
}

const TerminalLayerInner: React.FC<TerminalLayerProps> = ({
  hosts,
  portForwardingRules = [],
  customGroups,
  groupConfigs,
  proxyProfiles,
  keys,
  identities,
  snippets,
  snippetPackages,
  notes,
  noteGroups,
  openNoteRequest,
  onOpenVaultNoteFromChat,
  onOpenVaultHostFromChat,
  onOpenVaultSectionFromChat,
  onOpenVaultSnippetFromChat,
  sessions,
  workspaces,
  knownHosts = [],
  draggingSessionId,
  terminalTheme,
  terminalThemeId = terminalTheme.id,
  followAppTerminalTheme = false,
  pickTerminalTheme,
  clearThemeIntent,
  settleManualThemeIntent,
  resolveSessionAppearance,
  accentMode = 'theme',
  customAccent = '',
  terminalSettings,
  terminalFontFamilyId,
  fontSize = 14,
  hotkeyScheme = 'disabled',
  disableTerminalFontZoom = false,
  restoreTerminalCwd = false,
  keyBindings = [],
  onHotkeyAction,
  onUpdateTerminalThemeId,
  onUpdateTerminalFontFamilyId,
  onUpdateTerminalFontSize,
  onUpdateTerminalFontWeight,
  onUpdateSessionFontSize,
  onUpdateSessionRestoreCwd,
  onUpdateSessionDynamicTitle,
  onUpdateSessionCodingCliProvider,
  onClearSessionFontSizeOverride,
  onCloseSession,
  onUpdateSessionStatus,
  onUpdateHostDistro,
  onUpdateHost,
  onAddKnownHost,
  onCommandExecuted,
  shellHistory = [],
  onTerminalDataCapture,
  onCreateWorkspaceFromSessions,
  onAddSessionToWorkspace,
  onRequestAddToWorkspace,
  onUpdateSplitSizes,
  onSetDraggingSessionId,
  onToggleWorkspaceViewMode,
  onSetWorkspaceFocusedSession,
  onReorderWorkspaceSessions,
  onReorderTabs,
  onCopySession,
  onCopySessionToNewWindow,
  onSplitSession,
  onConnectToHost,
  onCreateLocalTerminal,
  isBroadcastEnabled,
  onToggleBroadcast,
  updateHosts,
  updateSnippets,
  updateSnippetPackages,
  updateNotes,
  updateNoteGroups,
  sftpDefaultViewMode,
  sftpDoubleClickBehavior,
  sftpAutoSync,
  sftpShowHiddenFiles,
  sftpUseCompressedUpload,
  sftpAutoOpenSidebar,
  terminalSidePanelAutoOpen = false,
  terminalSidePanelAutoOpenTab = DEFAULT_TERMINAL_SIDE_PANEL_AUTO_OPEN_TAB,
  sftpFollowTerminalCwd,
  setSftpFollowTerminalCwd,
  editorWordWrap,
  setEditorWordWrap,
  sessionLogsEnabled,
  sessionLogsDir,
  sessionLogsFormat,
  sessionLogsTimestampsEnabled,
  sshDebugLogsEnabled,
  showHostTreeSidebar = true,
  toggleScriptsSidePanelRef,
  toggleSidePanelRef,
  // Session rename props
  onStartSessionRename,
  onSubmitSessionRename,
  onRemoveSessionFromWorkspace,
}) => {
  const { t } = useI18n();
  const { runs } = useScriptExecution();
  const terminalRendererCwdBySessionRef = useRef<Map<string, string>>(new Map());
  const stableRef = useRef<Record<string, unknown>>({});
  const activeTabIdRef = useRef(activeTabStore.getActiveTabId());
  const activeWorkspaceRef = useRef<Workspace | undefined>(undefined);
  const activeSessionRef = useRef<TerminalSession | undefined>(undefined);
  const focusedSessionIdRef = useRef<string | undefined>(undefined);
  const terminalCwdRevisionRef = useRef(0);
  const [terminalCwdRevision, setTerminalCwdRevision] = useState(0);
  const terminalOsc7SignalBySessionRef = useRef<Map<string, number>>(new Map());
  const cwdProbeCancelersRef = useRef<Map<string, () => void>>(new Map());
  const cwdProbeGenerationRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const runPrewarm = () => prewarmAIStateStorageSnapshots();
    if (typeof window.requestIdleCallback === 'function') {
      const idleId = window.requestIdleCallback(runPrewarm, { timeout: 2500 });
      return () => window.cancelIdleCallback(idleId);
    }
    const timeoutId = window.setTimeout(runPrewarm, 500);
    return () => window.clearTimeout(timeoutId);
  }, []);

  const handleTerminalCwdChange = useCallback((
    sessionId: string,
    cwd: string | null,
    meta?: { source?: 'osc7' },
  ) => {
    if (meta?.source === 'osc7') {
      // Bump on every OSC 7 report, even when the decoded path is unchanged.
      // PROMPT_COMMAND/precmd emits OSC 7 after each command; skipping the
      // backend pwd probe in that case prevents SFTP follow from toggling
      // between OSC 7 cwd and login-shell fallback pwd (notably after sudo).
      const nextSignal = (terminalOsc7SignalBySessionRef.current.get(sessionId) ?? 0) + 1;
      terminalOsc7SignalBySessionRef.current.set(sessionId, nextSignal);
    }

    const currentCwd = terminalRendererCwdBySessionRef.current.get(sessionId) ?? null;
    const nextCwd = cwd && cwd.trim().length > 0 ? cwd : null;
    if (currentCwd === nextCwd) return;

    if (nextCwd) {
      terminalRendererCwdBySessionRef.current.set(sessionId, nextCwd);
    } else {
      terminalRendererCwdBySessionRef.current.delete(sessionId);
    }
    onUpdateSessionRestoreCwd?.(sessionId, nextCwd);
    terminalCwdRevisionRef.current += 1;
    setTerminalCwdRevision(terminalCwdRevisionRef.current);
  }, [onUpdateSessionRestoreCwd]);

  const codingCliOutputScannersRef = useRef<Map<string, CodingCliOutputScanner>>(new Map());
  const codingCliOutputScanDisabledRef = useRef<Set<string>>(new Set());

  const applySessionCodingCliProvider = useCallback((
    sessionId: string,
    providerId: CodingCliProviderId,
  ) => {
    const session = sessionsRef.current.find((candidate) => candidate.id === sessionId);
    if (!session || session.codingCliProviderId === providerId) return;
    onUpdateSessionCodingCliProvider?.(sessionId, providerId);
  }, [onUpdateSessionCodingCliProvider]);

  const applySessionCodingCliProviderFromCommand = useCallback((
    sessionId: string,
    commandLine: string,
  ) => {
    const provider = matchCodingCliProviderFromCommand(commandLine);
    if (provider) {
      codingCliOutputScannersRef.current.delete(sessionId);
      codingCliOutputScanDisabledRef.current.delete(sessionId);
      applySessionCodingCliProvider(sessionId, provider.id);
    }
  }, [applySessionCodingCliProvider]);

  const handleTerminalTitleChange = useCallback((sessionId: string, title: string | null) => {
    const session = sessionsRef.current.find((candidate) => candidate.id === sessionId);
    if (!session) return;
    const dynamicTabTitleMode = terminalSettings?.dynamicTabTitleMode ?? 'agent';

    const trimmedTitle = title?.trim();
    const providerId = trimmedTitle
      ? inferCodingCliProviderFromTitleSignals(trimmedTitle)
      : undefined;
    const shouldStoreDynamicTitle =
      dynamicTabTitleMode === 'all' ||
      (
        dynamicTabTitleMode === 'agent' &&
        Boolean(session.codingCliProviderId || providerId)
      );
    onUpdateSessionDynamicTitle?.(sessionId, shouldStoreDynamicTitle ? title : null);

    if (!trimmedTitle) {
      if (session.codingCliProviderId) {
        codingCliOutputScannersRef.current.delete(sessionId);
        codingCliOutputScanDisabledRef.current.delete(sessionId);
        onUpdateSessionCodingCliProvider?.(sessionId, null);
      }
      return;
    }

    if (providerId && dynamicTabTitleMode !== 'off') {
      if (!session.codingCliProviderId || session.codingCliProviderId !== providerId) {
        codingCliOutputScannersRef.current.delete(sessionId);
        codingCliOutputScanDisabledRef.current.delete(sessionId);
        applySessionCodingCliProvider(sessionId, providerId);
      }
      return;
    }

    if (
      session.codingCliProviderId
      && shouldClearCodingCliProviderForTitle(trimmedTitle, session.codingCliProviderId)
    ) {
      codingCliOutputScannersRef.current.delete(sessionId);
      codingCliOutputScanDisabledRef.current.delete(sessionId);
      onUpdateSessionCodingCliProvider?.(sessionId, null);
    }
  }, [applySessionCodingCliProvider, onUpdateSessionCodingCliProvider, onUpdateSessionDynamicTitle, terminalSettings?.dynamicTabTitleMode]);

  const handleTerminalOutput = useCallback((sessionId: string, chunk: string) => {
    if (!chunk || codingCliOutputScanDisabledRef.current.has(sessionId)) return;

    const session = sessionsRef.current.find((candidate) => candidate.id === sessionId);
    if (session?.codingCliProviderId) return;

    let scanner = codingCliOutputScannersRef.current.get(sessionId);
    if (!scanner) {
      scanner = createCodingCliOutputScanner();
      codingCliOutputScannersRef.current.set(sessionId, scanner);
    }

    const providerId = scanner.feed(chunk);
    if (providerId) {
      applySessionCodingCliProvider(sessionId, providerId);
      return;
    }

    if (scanner.isExhausted()) {
      codingCliOutputScannersRef.current.delete(sessionId);
      codingCliOutputScanDisabledRef.current.delete(sessionId);
      codingCliOutputScanDisabledRef.current.add(sessionId);
    }
  }, [applySessionCodingCliProvider]);

  const handleTerminalBell = useCallback((sessionId: string) => {
    const session = sessionsRef.current.find((candidate) => candidate.id === sessionId);
    if (!session) return;
    if (!shouldMarkSessionActivity(activeTabStore.getActiveTabId(), session)) return;
    sessionActivityStore.setTabActive(sessionId, true);
  }, []);

  // Stable callback references for Terminal components
  const handleCloseSession = useCallback((sessionId: string) => {
    codingCliOutputScannersRef.current.delete(sessionId);
    codingCliOutputScanDisabledRef.current.delete(sessionId);
    sessionCapabilitiesStore.delete(sessionId);
    onCloseSession(sessionId);
  }, [onCloseSession]);

  const sftpAutoOpenSidebarRef = useRef(sftpAutoOpenSidebar);
  sftpAutoOpenSidebarRef.current = sftpAutoOpenSidebar;
  const terminalSidePanelAutoOpenRef = useRef(terminalSidePanelAutoOpen);
  terminalSidePanelAutoOpenRef.current = terminalSidePanelAutoOpen;
  const terminalSidePanelAutoOpenTabRef = useRef(terminalSidePanelAutoOpenTab);
  terminalSidePanelAutoOpenTabRef.current = terminalSidePanelAutoOpenTab;
  const sftpFollowTerminalCwdRef = useRef(sftpFollowTerminalCwd);
  sftpFollowTerminalCwdRef.current = sftpFollowTerminalCwd;

  const handleStatusChange = useCallback((sessionId: string, status: TerminalSession['status']) => {
    onUpdateSessionStatus(sessionId, status);

    if (status !== 'connected') return;

    const session = sessionsRef.current.find(s => s.id === sessionId);
    if (!session) return;
    const proto = session.protocol;
    const sftpAvailable = proto === 'ssh' || proto === 'mosh';
    const tabId = session.workspaceId || sessionId;

    if (sidePanelOpenTabsRef.current.has(tabId)) return;

    const sessionAutoOpenTarget = session.autoOpenSidePanel === 'sftp' && sftpAvailable ? 'sftp' : null;
    const autoOpenTarget = sessionAutoOpenTarget ?? resolveTerminalSidePanelAutoOpen({
      enabled: terminalSidePanelAutoOpenRef.current,
      selectedTab: terminalSidePanelAutoOpenTabRef.current,
      sftpAvailable,
    });
    const targetPanel = autoOpenTarget ?? (sftpAutoOpenSidebarRef.current && sftpAvailable ? 'sftp' : null);
    if (!targetPanel) return;

    lastSidePanelTabRef.current.set(tabId, targetPanel);

    if (targetPanel === 'sftp') {
      const host = hostsRef.current.find(h => h.id === session.hostId);
      const hostWithOverrides: Host = host
        ? {
          ...host,
          protocol: session.protocol ?? host.protocol,
          port: session.port ?? host.port,
          moshEnabled: session.moshEnabled ?? host.moshEnabled,
          etEnabled: session.etEnabled ?? host.etEnabled,
        }
        : {
          id: session.hostId || sessionId,
          hostname: session.hostname,
          username: session.username,
          port: session.port ?? 22,
          protocol: proto,
          label: session.label || session.hostname,
        } as Host;

      setSftpHostForTab(prev => {
        const next = new Map(prev);
        next.set(tabId, hostWithOverrides);
        return next;
      });
    } else if (targetPanel === 'ai') {
      setAiMountedTabIds((prev) => addMountedSidePanelTabId(prev, tabId));
    } else if (targetPanel === 'scripts') {
      setScriptsMountedTabIds((prev) => addMountedSidePanelTabId(prev, tabId));
    } else if (targetPanel === 'theme') {
      setThemeMountedTabIds((prev) => addMountedSidePanelTabId(prev, tabId));
    } else if (targetPanel === 'system') {
      setSystemMountedTabIds((prev) => addMountedSidePanelTabId(prev, tabId));
    } else if (targetPanel === 'notes') {
      setNotesMountedTabIds((prev) => addMountedSidePanelTabId(prev, tabId));
    }

    setSidePanelOpenTabs(prev => {
      const next = new Map(prev);
      next.set(tabId, targetPanel);
      return next;
    });
  }, [onUpdateSessionStatus]);

  const handleSessionExit = useCallback((sessionId: string, evt: TerminalSessionExitEvent) => {
    const intent = resolveTerminalSessionExitIntent(evt);
    if (intent.kind === "closeSession") {
      onCloseSession(sessionId);
    } else {
      onUpdateSessionStatus(sessionId, 'disconnected');
    }
  }, [onCloseSession, onUpdateSessionStatus]);

  const handleOsDetected = useCallback((hostId: string, distro: string) => {
    onUpdateHostDistro(hostId, distro);
  }, [onUpdateHostDistro]);

  const handleUpdateHost = useCallback((host: Host) => {
    onUpdateHost(host);
  }, [onUpdateHost]);

  const handleAddKnownHost = useCallback((knownHost: KnownHost) => {
    onAddKnownHost?.(knownHost);
  }, [onAddKnownHost]);

  const handleTerminalDataCapture = useCallback((sessionId: string, data: string) => {
    onTerminalDataCapture?.(sessionId, data);
  }, [onTerminalDataCapture]);

  // Terminal backend for broadcast writes
  const terminalBackend = useTerminalBackend();
  const snippetExecutorsRef = useRef<Map<string, SnippetExecutor>>(new Map());
  const broadcastInterruptPrioritizersRef = useRef<Map<string, () => void>>(new Map());
  const programmaticCommandLogRewriteHandlersRef = useRef<Map<string, (rewrite: ProgrammaticCommandLogRewrite) => void>>(new Map());

  const handleSnippetExecutorChange = useCallback((sessionId: string, executor: SnippetExecutor | null) => {
    if (executor) {
      snippetExecutorsRef.current.set(sessionId, executor);
      return;
    }
    snippetExecutorsRef.current.delete(sessionId);
  }, []);

  const handleBroadcastInterruptPriorityChange = useCallback((
    sessionId: string,
    prioritize: (() => void) | null,
  ) => {
    if (prioritize) {
      broadcastInterruptPrioritizersRef.current.set(sessionId, prioritize);
      return;
    }
    broadcastInterruptPrioritizersRef.current.delete(sessionId);
  }, []);

  const handleProgrammaticCommandLogRewriteChange = useCallback((
    sessionId: string,
    queueRewrite: ((rewrite: ProgrammaticCommandLogRewrite) => void) | null,
  ) => {
    if (queueRewrite) {
      programmaticCommandLogRewriteHandlersRef.current.set(sessionId, queueRewrite);
      return;
    }
    programmaticCommandLogRewriteHandlersRef.current.delete(sessionId);
  }, []);

  const onSessionData = terminalBackend.onSessionData;

  const workspaceById = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace])),
    [workspaces],
  );

  // Workspace-level compose bar state
  const [isComposeBarOpen, setIsComposeBarOpen] = useStoredBoolean(
    STORAGE_KEY_TERMINAL_COMPOSE_BAR_OPEN,
    false,
  );
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;
  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;
  const portForwardingRulesRef = useRef(portForwardingRules);
  portForwardingRulesRef.current = portForwardingRules;
  const onSetWorkspaceFocusedSessionRef = useRef(onSetWorkspaceFocusedSession);
  onSetWorkspaceFocusedSessionRef.current = onSetWorkspaceFocusedSession;

  // Side panel state - per-tab tracking of which sub-panel is active
  // Maps tab IDs to the active sub-panel type (sftp/scripts/theme), absent = closed
  const [sidePanelOpenTabs, setSidePanelOpenTabs] = useState<Map<string, SidePanelTab>>(new Map());
  // Keep AI/scripts/theme panels mounted while switching sub-tabs (like SFTP).
  const [aiMountedTabIds, setAiMountedTabIds] = useState<string[]>([]);
  const [scriptsMountedTabIds, setScriptsMountedTabIds] = useState<string[]>([]);
  const [systemMountedTabIds, setSystemMountedTabIds] = useState<string[]>([]);
  const [themeMountedTabIds, setThemeMountedTabIds] = useState<string[]>([]);
  const [notesMountedTabIds, setNotesMountedTabIds] = useState<string[]>([]);
  const [sidePanelWidth, setSidePanelWidth, persistSidePanelWidth] = useStoredNumber(
    STORAGE_KEY_SIDE_PANEL_WIDTH, 420, { min: 280, max: 800 },
  );
  const [sidePanelPosition, setSidePanelPosition] = useStoredString<'left' | 'right'>(
    'netcatty_side_panel_position',
    'left',
    (v): v is 'left' | 'right' => v === 'left' || v === 'right',
  );
  const sidePanelOpenTabsRef = useRef(sidePanelOpenTabs);
  sidePanelOpenTabsRef.current = sidePanelOpenTabs;

  // Remember the last sub-panel shown per tab so the toggle shortcut can
  // restore it after a close. Overwritten on open, never cleared on close.
  const lastSidePanelTabRef = useRef<Map<string, SidePanelTab>>(new Map());
  const notesReturnTabRef = useRef<Map<string, SidePanelTab>>(new Map());

  // The host to pass to the SFTP panel - stored when the user opens SFTP
  const [sftpHostForTab, setSftpHostForTab] = useState<Map<string, Host>>(new Map());
  const [sftpInitialLocationForTab, setSftpInitialLocationForTab] = useState<
    Map<string, { hostId: string; path: string }>
  >(new Map());
  const [sftpPendingUploadsForTab, setSftpPendingUploadsForTab] = useState<
    Map<string, PendingSftpUpload>
  >(new Map());
  const [pendingTerminalSelectionForAI, setPendingTerminalSelectionForAI] =
    useState<PendingTerminalSelectionForAI | null>(null);
  const [notesOpenNoteByTab, setNotesOpenNoteByTab] = useState<Map<string, { noteId: string; requestId: number }>>(new Map());
  const notesOpenRequestIdRef = useRef(0);
  const sftpHostForTabRef = useRef(sftpHostForTab);
  sftpHostForTabRef.current = sftpHostForTab;
  const sftpActiveTransfersByTabRef = useRef<Map<string, number>>(new Map());
  const sftpRetainedAfterCloseTabIdsRef = useRef<Set<string>>(new Set());
  const sftpOpeningTabIdsRef = useRef<Set<string>>(new Set());
  const sftpRetainedCleanupTimersRef = useRef<Map<string, number>>(new Map());
  const sftpLastPathForSourceRef = useRef<Map<string, SftpRememberedLocation>>(new Map());

  const resolveSftpOpenTarget = useCallback((params: {
    tabId: string;
    host: Host;
    initialPath?: string;
    pendingUploadEntries?: DropEntry[];
    sourceSessionId?: string | null;
  }) => {
    const { tabId, host, initialPath, pendingUploadEntries, sourceSessionId } = params;
    const connectionKey = buildCacheKey(host.id, host.hostname, host.port, host.protocol, host.sftpSudo, host.username, host.sftpFileProtocol);
    const memoryKey = getSftpReopenMemoryKey({ tabId, sourceSessionId });
    const effectiveInitialPath = resolveSftpOpenLocation({
      hostId: host.id,
      connectionKey,
      terminalCwd: initialPath,
      explicitTargetPath: pendingUploadEntries?.length ? initialPath : undefined,
      hasPendingUpload: !!pendingUploadEntries?.length,
      remembered: sftpLastPathForSourceRef.current.get(memoryKey),
    });

    return { connectionKey, effectiveInitialPath };
  }, []);

  const clearSftpPanelState = useCallback((tabId: string) => {
    const cleanupTimer = sftpRetainedCleanupTimersRef.current.get(tabId);
    if (cleanupTimer !== undefined) {
      window.clearTimeout(cleanupTimer);
      sftpRetainedCleanupTimersRef.current.delete(tabId);
    }
    sftpActiveTransfersByTabRef.current.delete(tabId);
    sftpRetainedAfterCloseTabIdsRef.current.delete(tabId);
    sftpOpeningTabIdsRef.current.delete(tabId);
    setSftpHostForTab(prev => {
      if (!prev.has(tabId)) return prev;
      const next = new Map(prev);
      next.delete(tabId);
      return next;
    });
    setSftpPendingUploadsForTab(prev => {
      if (!prev.has(tabId)) return prev;
      const next = new Map(prev);
      next.delete(tabId);
      return next;
    });
    setSftpInitialLocationForTab(prev => {
      if (!prev.has(tabId)) return prev;
      const next = new Map(prev);
      next.delete(tabId);
      return next;
    });
  }, []);

  const handleSftpActiveTransfersChange = useCallback((tabId: string, count: number) => {
    const activeTransfersCount = Math.max(0, count);
    if (activeTransfersCount > 0) {
      const cleanupTimer = sftpRetainedCleanupTimersRef.current.get(tabId);
      if (cleanupTimer !== undefined) {
        window.clearTimeout(cleanupTimer);
        sftpRetainedCleanupTimersRef.current.delete(tabId);
      }
      sftpActiveTransfersByTabRef.current.set(tabId, activeTransfersCount);
      return;
    }
    sftpActiveTransfersByTabRef.current.delete(tabId);
    const lifecycle = {
      activeTransfersCount,
      panelOpen: sidePanelOpenTabsRef.current.has(tabId) || sftpOpeningTabIdsRef.current.has(tabId),
      retainedAfterClose: sftpRetainedAfterCloseTabIdsRef.current.has(tabId),
    };
    if (shouldClearSftpPanelAfterTransferChange(lifecycle)) {
      clearSftpPanelState(tabId);
      return;
    }
    if (
      shouldScheduleSftpRetainedPanelCleanup({
        activeTransfersCount: lifecycle.activeTransfersCount,
        retainedAfterClose: lifecycle.retainedAfterClose,
      })
      && !sftpRetainedCleanupTimersRef.current.has(tabId)
    ) {
      const cleanupTimer = window.setTimeout(() => {
        sftpRetainedCleanupTimersRef.current.delete(tabId);
        const currentCount = sftpActiveTransfersByTabRef.current.get(tabId) ?? 0;
        if (
          currentCount <= 0
          && !sidePanelOpenTabsRef.current.has(tabId)
          && !sftpOpeningTabIdsRef.current.has(tabId)
          && sftpRetainedAfterCloseTabIdsRef.current.has(tabId)
        ) {
          clearSftpPanelState(tabId);
        }
      }, SFTP_TRANSFER_HISTORY_RETENTION_MS);
      sftpRetainedCleanupTimersRef.current.set(tabId, cleanupTimer);
    }
  }, [clearSftpPanelState]);

  const handleToggleWorkspaceComposeBar = useCallback(() => {
    setIsComposeBarOpen(prev => !prev);
  }, [setIsComposeBarOpen]);

  const handleOpenSftp = useCallback((host: Host, initialPath?: string, pendingUploadEntries?: DropEntry[], sourceSessionId?: string) => {
    const tabId = activeTabIdRef.current;
    if (!tabId) return;

    // When SFTP is opened from a non-focused workspace pane (toolbar click
    // or drag-drop), switch focus first so the SFTP panel binds to the
    // correct host.
    if (sourceSessionId) {
      const ws = activeWorkspaceRef.current;
      if (ws && ws.focusedSessionId !== sourceSessionId) {
        onSetWorkspaceFocusedSessionRef.current?.(ws.id, sourceSessionId);
      }
    }

    const currentPanel = sidePanelOpenTabsRef.current.get(tabId);
    const isOpen = currentPanel === 'sftp';
    const currentHost = sftpHostForTabRef.current.get(tabId);
    const shouldKeepOpen = !!pendingUploadEntries?.length;
    // Compare full endpoint identity so that session-time overrides
    // (different port/protocol for the same host ID) trigger a switch
    // instead of toggling the panel closed.
    const isSameEndpoint = currentHost
      && currentHost.id === host.id
      && currentHost.hostname === host.hostname
      && currentHost.port === host.port
      && currentHost.protocol === host.protocol
      && currentHost.username === host.username
      && currentHost.sftpSudo === host.sftpSudo
      && (currentHost.sftpFileProtocol || "auto") === (host.sftpFileProtocol || "auto");

    const isClosing = !shouldKeepOpen && isOpen && isSameEndpoint;
    const activeTransfersCount = sftpActiveTransfersByTabRef.current.get(tabId) ?? 0;
    const keepSftpMounted = isClosing
      && shouldKeepSftpMountedAfterClose(activeTransfersCount);
    if (isClosing) {
      sftpOpeningTabIdsRef.current.delete(tabId);
    }
    if (keepSftpMounted) {
      sftpRetainedAfterCloseTabIdsRef.current.add(tabId);
    } else if (!isClosing) {
      sftpOpeningTabIdsRef.current.add(tabId);
      const cleanupTimer = sftpRetainedCleanupTimersRef.current.get(tabId);
      if (cleanupTimer !== undefined) {
        window.clearTimeout(cleanupTimer);
        sftpRetainedCleanupTimersRef.current.delete(tabId);
      }
      sftpRetainedAfterCloseTabIdsRef.current.delete(tabId);
    }

    setSidePanelOpenTabs(prev => {
      const next = new Map(prev);
      if (isClosing) {
        next.delete(tabId);
      } else {
        next.set(tabId, 'sftp');
      }
      return next;
    });

    // Store or remove the host for this tab.
    // Removing on close unmounts the panel so SFTP sessions are cleaned up.
    setSftpHostForTab(prev => {
      const next = new Map(prev);
      if (isClosing && !keepSftpMounted) {
        next.delete(tabId);
      } else {
        next.set(tabId, host);
      }
      return next;
    });

    const { connectionKey, effectiveInitialPath } = resolveSftpOpenTarget({
      tabId,
      host,
      initialPath,
      pendingUploadEntries,
      sourceSessionId,
    });

    setSftpInitialLocationForTab(prev => {
      const next = new Map(prev);
      if (effectiveInitialPath) {
        next.set(tabId, { hostId: host.id, path: effectiveInitialPath });
      } else {
        next.delete(tabId);
      }
      return next;
    });

    setSftpPendingUploadsForTab(prev => {
      const next = new Map(prev);
      if (isClosing || !pendingUploadEntries?.length) {
        // Clear any stale pending upload on close or when opening without new files
        next.delete(tabId);
      } else {
        next.set(tabId, {
          requestId: crypto.randomUUID(),
          hostId: host.id,
          connectionKey,
          targetPath: initialPath,
          entries: pendingUploadEntries,
        });
      }
      return next;
    });
  }, [resolveSftpOpenTarget]);

  const handlePendingUploadHandled = useCallback((tabId: string, requestId: string) => {
    setSftpPendingUploadsForTab(prev => {
      const current = prev.get(tabId);
      if (!current || current.requestId !== requestId) {
        return prev;
      }
      const next = new Map(prev);
      next.delete(tabId);
      return next;
    });
  }, []);

  const handleSftpInitialLocationApplied = useCallback((tabId: string, location: { hostId: string; path: string }) => {
    setSftpInitialLocationForTab(prev => {
      const current = prev.get(tabId);
      if (!current || current.hostId !== location.hostId || current.path !== location.path) {
        return prev;
      }
      const next = new Map(prev);
      next.delete(tabId);
      return next;
    });
  }, []);

  const handleSftpCurrentPathChange = useCallback((memoryKey: string, location: SftpRememberedLocation) => {
    if (!memoryKey || !location.path) return;
    sftpLastPathForSourceRef.current.set(memoryKey, location);
  }, []);

  // Pre-compute host lookup map for O(1) access
  const hostMap = useMemo(() => {
    const map = new Map<string, Host>();
    for (const h of hosts) map.set(h.id, h);
    return map;
  }, [hosts]);
  const hostMapRef = useRef(hostMap);
  hostMapRef.current = hostMap;
  const proxyProfileIdSet = useMemo(
    () => new Set(proxyProfiles.map((profile) => profile.id)),
    [proxyProfiles],
  );
  const effectiveHosts = useMemo(
    () => hosts.map((host) => resolveEffectiveTerminalHost({
      host,
      groupConfigs,
      proxyProfiles,
      validProxyProfileIds: proxyProfileIdSet,
    })),
    [groupConfigs, hosts, proxyProfileIdSet, proxyProfiles],
  );

  // Pre-compute fallback hosts to avoid creating new objects on every render
  const sessionHostsMap = useMemo(() => {
    const map = new Map<string, Host>();
    for (const session of sessions) {
      const hostForSession = resolveTerminalSessionHost({
        session,
        hosts,
        groupConfigs,
        proxyProfiles,
        localOs: detectLocalOs(navigator.userAgent || navigator.platform),
      });
      map.set(session.id, applySessionFontSizeToHost(hostForSession, session));
    }
    return map;
  }, [sessions, hosts, groupConfigs, proxyProfiles]);
  const resolvedSessionHostIds = useMemo(() => {
    const ids = new Set<string>();
    for (const session of sessions) {
      if (hostMap.has(session.hostId) || session.protocol === 'local') ids.add(session.id);
    }
    return ids;
  }, [hostMap, sessions]);
  const sessionChainHostsMap = useMemo(() => {
    const map = new Map<string, Host[]>();
    for (const session of sessions) {
      const host = sessionHostsMap.get(session.id);
      const chainHosts = resolveTerminalChainHosts({
        host,
        hosts,
        groupConfigs,
        proxyProfiles,
        validProxyProfileIds: proxyProfileIdSet,
      });
      if (chainHosts.length > 0) map.set(session.id, chainHosts);
    }
    return map;
  }, [sessions, sessionHostsMap, hosts, groupConfigs, proxyProfileIdSet, proxyProfiles]);
  const sessionHostsMapRef = useRef(sessionHostsMap);
  sessionHostsMapRef.current = sessionHostsMap;

  // Handle broadcast input - write to all other sessions in the source workspace.
  const handleBroadcastInput = useCallback((
    data: string,
    sourceSessionId: string,
    options?: TerminalBroadcastInputOptions,
  ) => {
    const sourceSession = sessionsRef.current.find((session) => session.id === sourceSessionId);
    const workspaceId = sourceSession?.workspaceId;
    if (!workspaceId) return;

    for (const session of sessionsRef.current) {
      if (session.workspaceId !== workspaceId || session.id === sourceSessionId) continue;
      if (!canUseDirectSessionWriteFallback(session)) continue;

      const lineDelayMs = options?.lineDelayMs;
      if (data === "\x03" && terminalBackend.interruptSession) {
        broadcastInterruptPrioritizersRef.current.get(session.id)?.();
        terminalBackend.interruptSession(session.id);
        continue;
      }
      terminalBackend.writeToSession(session.id, data, {
        automated: true,
        ...(lineDelayMs ? { lineDelayMs } : {}),
      });
    }
  }, [terminalBackend]);

  const handleCommandSubmitted = useCallback((command: string, _hostId: string, _hostLabel: string, sessionId: string) => {
    applySessionCodingCliProviderFromCommand(sessionId, command);

    const tabId = activeTabIdRef.current;
    const session = sessionsRef.current.find((candidate) => candidate.id === sessionId);
    if (!session || !canReuseTerminalConnection(session)) return;
    const sessionHost = sessionHostsMapRef.current.get(sessionId);
    const visibleSftpHost = tabId && sidePanelOpenTabsRef.current.get(tabId) === 'sftp'
      ? sftpHostForTabRef.current.get(tabId) ?? null
      : null;
    if (!shouldProbeCommandCwd({
      restoreTerminalCwd,
      visibleSftpHost,
      sessionHost,
      globalSftpFollowTerminalCwd: sftpFollowTerminalCwdRef.current,
    })) return;

    const osc7SignalAtCommand = terminalOsc7SignalBySessionRef.current.get(sessionId) ?? 0;
    const probeGeneration = (cwdProbeGenerationRef.current.get(sessionId) ?? 0) + 1;
    cwdProbeGenerationRef.current.set(sessionId, probeGeneration);
    cwdProbeCancelersRef.current.get(sessionId)?.();
    const cancelProbe = scheduleBackendCwdProbeAfterCommand({
      sessionId,
      osc7SignalAtCommand,
      getOsc7Signal: () => terminalOsc7SignalBySessionRef.current.get(sessionId) ?? 0,
      getSessionPwd: (id, options) => terminalBackend.getSessionPwd(id, options),
      canProbe: async () => {
        if (cwdProbeGenerationRef.current.get(sessionId) !== probeGeneration) return false;
        const host = sessionHostsMapRef.current.get(sessionId);
        if (!host) return false;
        const detectedDeviceClass = classifyDistroId(host.distro);
        const isNetworkDevice =
          host.deviceType === 'network' || detectedDeviceClass === 'network-device';
        const info = await terminalBackend.getSessionRemoteInfo?.(sessionId);
        return shouldProbeSessionCwd({
          isNetworkDevice,
          remoteSshVersion: info?.remoteSshVersion,
        });
      },
      onProbedCwd: (cwd) => {
        if (cwdProbeGenerationRef.current.get(sessionId) !== probeGeneration) return;
        const existing = terminalRendererCwdBySessionRef.current.get(sessionId);
        if (existing === cwd) return;
        handleTerminalCwdChange(sessionId, cwd);
      },
    });
    cwdProbeCancelersRef.current.set(sessionId, cancelProbe);
  }, [applySessionCodingCliProviderFromCommand, handleTerminalCwdChange, restoreTerminalCwd, terminalBackend]);

  const handleCommandExecuted = useCallback((command: string, hostId: string, hostLabel: string, sessionId: string) => {
    onCommandExecuted?.(command, hostId, hostLabel, sessionId);
  }, [onCommandExecuted]);

  useEffect(() => () => {
    for (const cancel of cwdProbeCancelersRef.current.values()) {
      cancel();
    }
    cwdProbeCancelersRef.current.clear();
  }, []);
  const sessionSudoAutofillPasswordsMap = useMemo(() => {
    const map = new Map<string, string | undefined>();
    for (const session of sessions) {
      // Use the effective session host (group defaults / proxy materialization
      // applied) so a password inherited from group settings is available.
      const sessionHost = sessionHostsMap.get(session.id);
      if (sessionHost) {
        // Resolve through identity references too (host.identityId), not just
        // host.password, so a password stored in a Keychain identity is filled
        // (issue #1284) — same resolution SSH login uses.
        map.set(session.id, resolveHostAutofillPassword({ host: sessionHost, keys, identities }));
      }
    }
    return map;
  }, [sessionHostsMap, sessions, keys, identities]);

  const sessionSudoAutofillCandidatesMap = useMemo(() => {
    const map = new Map<
      string,
      ReturnType<typeof listPasswordPromptFillCandidates> | undefined
    >();
    for (const session of sessions) {
      const sessionHost = sessionHostsMap.get(session.id);
      if (sessionHost) {
        map.set(
          session.id,
          listPasswordPromptFillCandidates({ host: sessionHost, keys, identities }),
        );
      }
    }
    return map;
  }, [sessionHostsMap, sessions, keys, identities]);

  const handleTerminalFontSizeChange = useCallback((sessionId: string, nextFontSize: number) => {
    const session = sessionsRef.current.find((candidate) => candidate.id === sessionId);
    const sessionHost = sessionHostsMapRef.current.get(sessionId);
    const rawHost = sessionHost ? hostMapRef.current.get(sessionHost.id) : null;
    const target = resolveTerminalFontSizeUpdateTarget({ session, sessionHost, rawHost });
    if (target.kind === 'none') return;
    if (target.kind === 'session') {
      onUpdateSessionFontSize?.(sessionId, nextFontSize);
    } else if (target.kind === 'global') {
      onUpdateTerminalFontSize?.(nextFontSize);
    } else {
      onUpdateHost({ ...target.host, fontSize: nextFontSize, fontSizeOverride: true });
    }
  }, [onUpdateHost, onUpdateSessionFontSize, onUpdateTerminalFontSize]);

  const validAIScopeTargetIds = useMemo(() => {
    const ids = new Set<string>();
    for (const session of sessions) ids.add(session.id);
    for (const workspace of workspaces) ids.add(workspace.id);
    return ids;
  }, [sessions, workspaces]);

  useEffect(() => {
    const invalidTabIds = listInvalidSftpPanelTabIds({
      mountedTabIds: sftpHostForTab.keys(),
      activeTransferTabIds: sftpActiveTransfersByTabRef.current.keys(),
      retainedTabIds: sftpRetainedAfterCloseTabIdsRef.current,
      openingTabIds: sftpOpeningTabIdsRef.current,
      cleanupTimerTabIds: sftpRetainedCleanupTimersRef.current.keys(),
      validTabIds: validAIScopeTargetIds,
    });
    for (const tabId of invalidTabIds) {
      clearSftpPanelState(tabId);
    }
  }, [clearSftpPanelState, sftpHostForTab, validAIScopeTargetIds]);

  useEffect(() => {
    for (const tabId of sftpOpeningTabIdsRef.current) {
      if (sidePanelOpenTabs.get(tabId) === 'sftp') {
        sftpOpeningTabIdsRef.current.delete(tabId);
      }
    }
  }, [sidePanelOpenTabs]);

  useEffect(() => () => {
    for (const cleanupTimer of sftpRetainedCleanupTimersRef.current.values()) {
      window.clearTimeout(cleanupTimer);
    }
    sftpRetainedCleanupTimersRef.current.clear();
  }, []);

  const validSessionActivityIds = useMemo(() => {
    return getValidSessionActivityIds(sessions);
  }, [sessions]);
  const activityTrackedSessions = useMemo(
    () =>
      sessions.filter(
        (session) => session.status !== 'disconnected',
      ),
    [sessions],
  );

  const onSplitSessionRef = useRef(onSplitSession);
  onSplitSessionRef.current = onSplitSession;
  const splitHorizontalHandlersRef = useRef<Map<string, () => void>>(new Map());
  const splitVerticalHandlersRef = useRef<Map<string, () => void>>(new Map());

  const onToggleWorkspaceViewModeRef = useRef(onToggleWorkspaceViewMode);
  onToggleWorkspaceViewModeRef.current = onToggleWorkspaceViewMode;
  const workspaceFocusHandlersRef = useRef<Map<string, () => void>>(new Map());

  const onToggleBroadcastRef = useRef(onToggleBroadcast);
  onToggleBroadcastRef.current = onToggleBroadcast;
  const workspaceBroadcastHandlersRef = useRef<Map<string, () => void>>(new Map());

  const mountedSftpTabIds = useMemo(
    () => Array.from(sftpHostForTab.keys()),
    [sftpHostForTab],
  );
  const markSidePanelSubTabOpened = useCallback((tabId: string, panel: SidePanelTab) => {
    if (panel === 'ai') {
      setAiMountedTabIds((prev) => addMountedSidePanelTabId(prev, tabId));
      return;
    }
    if (panel === 'scripts') {
      setScriptsMountedTabIds((prev) => addMountedSidePanelTabId(prev, tabId));
      return;
    }
    if (panel === 'theme') {
      setThemeMountedTabIds((prev) => addMountedSidePanelTabId(prev, tabId));
      return;
    }
    if (panel === 'system') {
      setSystemMountedTabIds((prev) => addMountedSidePanelTabId(prev, tabId));
      return;
    }
    if (panel === 'notes') {
      setNotesMountedTabIds((prev) => addMountedSidePanelTabId(prev, tabId));
    }
  }, []);

  const getActiveTerminalSessionId = useCallback((): string | null => {
    const activeWorkspace = activeWorkspaceRef.current;
    const activeSession = activeSessionRef.current;
    if (!activeWorkspace) return activeSession?.id ?? null;

    const workspaceSessionIdSet = new Set(collectSessionIds(activeWorkspace.root));
    const focusedId = activeWorkspace.focusedSessionId;
    if (focusedId && workspaceSessionIdSet.has(focusedId) && sessionsRef.current.some((session) => session.id === focusedId)) {
      return focusedId;
    }

    return sessionsRef.current.find((session) => workspaceSessionIdSet.has(session.id))?.id ?? null;
  }, []);

  const syncWorkspaceFocusIfNeeded = useCallback((sessionId: string | null) => {
    const activeWorkspace = activeWorkspaceRef.current;
    if (!activeWorkspace || !sessionId || activeWorkspace.focusedSessionId === sessionId) return;
    onSetWorkspaceFocusedSession?.(activeWorkspace.id, sessionId);
  }, [onSetWorkspaceFocusedSession]);

  // Get the focused terminal's current working directory
  const getTerminalCwd = useCallback(async (options?: { preferFreshBackend?: boolean }): Promise<string | null> => {
    const sessionId = getActiveTerminalSessionId();
    return resolvePreferredTerminalCwd({
      rendererCwd: sessionId ? terminalRendererCwdBySessionRef.current.get(sessionId) : undefined,
      sessionId,
      getSessionPwd: (id, options) => terminalBackend.getSessionPwd(id, options),
      preferFreshBackend: options?.preferFreshBackend,
    });
  }, [getActiveTerminalSessionId, terminalBackend]);

  const refocusTerminalSession = useCallback((sessionId?: string | null) => {
    focusTerminalSessionInput(sessionId);
  }, []);

  const refocusActiveTerminalSession = useCallback(() => {
    const sessionId = getActiveTerminalSessionId();
    syncWorkspaceFocusIfNeeded(sessionId);
    refocusTerminalSession(sessionId);
  }, [getActiveTerminalSessionId, refocusTerminalSession, syncWorkspaceFocusIfNeeded]);

  // Close the entire side panel for the current tab
  const handleCloseSidePanel = useCallback(() => {
    const activeTabId = activeTabIdRef.current;
    if (!activeTabId) return;
    const sessionIdToRefocus = getActiveTerminalSessionId();
    syncWorkspaceFocusIfNeeded(sessionIdToRefocus);
    setSidePanelOpenTabs(prev => {
      const next = new Map(prev);
      next.delete(activeTabId);
      return next;
    });
    sftpOpeningTabIdsRef.current.delete(activeTabId);
    const activeTransfersCount = sftpActiveTransfersByTabRef.current.get(activeTabId) ?? 0;
    if (shouldKeepSftpMountedAfterClose(activeTransfersCount)) {
      sftpRetainedAfterCloseTabIdsRef.current.add(activeTabId);
    } else {
      clearSftpPanelState(activeTabId);
    }
    setAiMountedTabIds((prev) => removeMountedSidePanelTabId(prev, activeTabId));
    setScriptsMountedTabIds((prev) => removeMountedSidePanelTabId(prev, activeTabId));
    setThemeMountedTabIds((prev) => removeMountedSidePanelTabId(prev, activeTabId));
    setSystemMountedTabIds((prev) => removeMountedSidePanelTabId(prev, activeTabId));
    setNotesMountedTabIds((prev) => removeMountedSidePanelTabId(prev, activeTabId));
    setNotesOpenNoteByTab((prev) => {
      const next = new Map(prev);
      next.delete(activeTabId);
      return next;
    });
    notesReturnTabRef.current.delete(activeTabId);
    refocusTerminalSession(sessionIdToRefocus);
  }, [clearSftpPanelState, getActiveTerminalSessionId, refocusTerminalSession, syncWorkspaceFocusIfNeeded]);

  // Resolve the SFTP host for a tab: a previously-stored host, otherwise the
  // host of the workspace's focused session or the active session. null = none.
  const resolveSftpHostForTab = useCallback((tabId: string): Host | null => {
    const stored = sftpHostForTabRef.current.get(tabId);
    if (stored) return stored;
    const currentWorkspace = activeWorkspaceRef.current;
    const currentFocusedSessionId = focusedSessionIdRef.current;
    const currentActiveSession = activeSessionRef.current;
    const currentSessionHosts = sessionHostsMapRef.current;
    if (currentWorkspace && currentFocusedSessionId) {
      return currentSessionHosts.get(currentFocusedSessionId) ?? null;
    }
    if (currentActiveSession) {
      return currentSessionHosts.get(currentActiveSession.id) ?? null;
    }
    return null;
  }, []);

  // Switch side panel to a specific tab (or toggle if already on that tab)
  const handleSwitchSidePanelTab = useCallback((tab: SidePanelTab) => {
    const tabId = activeTabIdRef.current;
    if (!tabId) return;
    const currentPanel = sidePanelOpenTabsRef.current.get(tabId);

    // If already on this tab, do nothing — user must click X to close
    if (currentPanel === tab) return;

    if (tab === 'sftp') {
      sftpOpeningTabIdsRef.current.add(tabId);
      const cleanupTimer = sftpRetainedCleanupTimersRef.current.get(tabId);
      if (cleanupTimer !== undefined) {
        window.clearTimeout(cleanupTimer);
        sftpRetainedCleanupTimersRef.current.delete(tabId);
      }
      sftpRetainedAfterCloseTabIdsRef.current.delete(tabId);
    }

    // If switching to SFTP and no host is stored yet, resolve it
    if (tab === 'sftp' && !sftpHostForTabRef.current.has(tabId)) {
      const host = resolveSftpHostForTab(tabId);
      if (!host) return;
      setSftpHostForTab(prev => {
        const next = new Map(prev);
        next.set(tabId, host);
        return next;
      });
      const sourceSessionId = getActiveTerminalSessionId();
      const { effectiveInitialPath } = resolveSftpOpenTarget({
        tabId,
        host,
        sourceSessionId,
      });
      setSftpInitialLocationForTab(prev => {
        const next = new Map(prev);
        if (effectiveInitialPath) {
          next.set(tabId, { hostId: host.id, path: effectiveInitialPath });
        } else {
          next.delete(tabId);
        }
        return next;
      });
    }

    // Keep the hidden SFTP panel mounted while switching sub-panels. A panel
    // closed during a transfer is also retained until the user reopens it and
    // explicitly closes the now-idle panel, preserving the completed history.

    markSidePanelSubTabOpened(tabId, tab);
    startTransition(() => {
      setSidePanelOpenTabs(prev => {
        const next = new Map(prev);
        next.set(tabId, tab);
        return next;
      });
    });
  }, [getActiveTerminalSessionId, markSidePanelSubTabOpened, resolveSftpHostForTab, resolveSftpOpenTarget]);

  // Toggle SFTP from activity bar header
  const handleToggleSftpFromBar = useCallback(() => {
    handleSwitchSidePanelTab('sftp');
  }, [handleSwitchSidePanelTab]);

  // Open scripts side panel (called from Terminal toolbar)
  const handleOpenScripts = useCallback(() => {
    handleSwitchSidePanelTab('scripts');
  }, [handleSwitchSidePanelTab]);

  const handleToggleScriptsSidePanel = useCallback(() => {
    const tabId = activeTabIdRef.current;
    if (!tabId) return;

    const intent = resolveScriptsSidePanelShortcutIntent(
      sidePanelOpenTabsRef.current.get(tabId) ?? null,
    );

    if (intent.kind === 'closeTerminalSidePanel') {
      handleCloseSidePanel();
      return;
    }

    markSidePanelSubTabOpened(tabId, 'scripts');
    startTransition(() => {
      setSidePanelOpenTabs(prev => {
        const next = new Map(prev);
        next.set(tabId, 'scripts');
        return next;
      });
    });
  }, [handleCloseSidePanel, markSidePanelSubTabOpened]);

  // Toggle the whole side panel (new ⌘/Ctrl+\ shortcut). Close if open; if
  // closed, reopen the tab's last sub-panel, defaulting to SFTP (when a host is
  // available) or scripts.
  const handleToggleSidePanel = useCallback(() => {
    const tabId = activeTabIdRef.current;
    if (!tabId) return;
    const isOpen = sidePanelOpenTabsRef.current.has(tabId);
    const sftpAvailable = !!resolveSftpHostForTab(tabId);
    const fallbackTab: SidePanelTab = sftpAvailable ? 'sftp' : 'scripts';
    const lastTab = lastSidePanelTabRef.current.get(tabId) ?? null;
    const intent = resolveSidePanelToggleIntent<SidePanelTab>({ isOpen, lastTab, fallbackTab });
    if (intent.kind === 'close') {
      handleCloseSidePanel();
      return;
    }
    // If the remembered panel is SFTP but no host is resolvable, use scripts.
    const target: SidePanelTab = intent.tab === 'sftp' && !sftpAvailable ? 'scripts' : intent.tab;
    handleSwitchSidePanelTab(target);
  }, [handleCloseSidePanel, handleSwitchSidePanelTab, resolveSftpHostForTab]);

  // Open theme side panel (called from Terminal toolbar)
  const handleOpenTheme = useCallback(() => {
    handleSwitchSidePanelTab('theme');
  }, [handleSwitchSidePanelTab]);

  const handleOpenHistory = useCallback(() => {
    handleSwitchSidePanelTab('history');
  }, [handleSwitchSidePanelTab]);

  // Open AI chat side panel (side-panel rail button: a plain switch that is a
  // no-op when AI is already the active sub-panel, matching the other rail tabs)
  const handleOpenAI = useCallback(() => {
    handleSwitchSidePanelTab('ai');
  }, [handleSwitchSidePanelTab]);

  const handleOpenSystem = useCallback(() => {
    handleSwitchSidePanelTab('system');
  }, [handleSwitchSidePanelTab]);

  const handleOpenNotes = useCallback(() => {
    const tabId = activeTabIdRef.current;
    if (!tabId) return;
    const currentPanel = sidePanelOpenTabsRef.current.get(tabId) ?? null;
    if (currentPanel && currentPanel !== 'notes') {
      notesReturnTabRef.current.set(tabId, currentPanel);
    }
    handleSwitchSidePanelTab('notes');
  }, [handleSwitchSidePanelTab]);

  const handleBackFromNotes = useCallback(() => {
    const tabId = activeTabIdRef.current;
    if (!tabId) return;
    const fallback: SidePanelTab = resolveSftpHostForTab(tabId) ? 'sftp' : 'scripts';
    const remembered = notesReturnTabRef.current.get(tabId) ?? fallback;
    const target = remembered === 'notes'
      ? fallback
      : (remembered === 'sftp' && !resolveSftpHostForTab(tabId) ? 'scripts' : remembered);
    handleSwitchSidePanelTab(target);
  }, [handleSwitchSidePanelTab, resolveSftpHostForTab]);

  const openNotesPanelForSourceNote = useCallback((tabId: string, noteId: string) => {
    notesOpenRequestIdRef.current += 1;
    const requestId = notesOpenRequestIdRef.current;
    setNotesOpenNoteByTab((prev) => {
      const next = new Map(prev);
      next.set(tabId, { noteId, requestId });
      return next;
    });
    setNotesMountedTabIds((prev) => addMountedSidePanelTabId(prev, tabId));
    setSidePanelOpenTabs((prev) => {
      const next = new Map(prev);
      next.set(tabId, 'notes');
      return next;
    });
  }, []);

  const handleOpenHostFromNotes = useCallback((host: Host, source?: { noteId?: string }) => {
    const sourceNoteId = source?.noteId;
    const previousTabId = activeTabStore.getActiveTabId();
    const connectedTabId = onConnectToHost(host);
    if (!sourceNoteId) return;

    if (typeof connectedTabId === 'string' && connectedTabId) {
      openNotesPanelForSourceNote(connectedTabId, sourceNoteId);
      return;
    }

    const openWhenTabIsReady = (attempt = 0) => {
      const tabId = activeTabStore.getActiveTabId();
      if (tabId && tabId !== previousTabId) {
        openNotesPanelForSourceNote(tabId, sourceNoteId);
        return;
      }
      if (attempt >= 8) {
        if (tabId) openNotesPanelForSourceNote(tabId, sourceNoteId);
        return;
      }
      window.setTimeout(() => openWhenTabIsReady(attempt + 1), 16);
    };

    openWhenTabIsReady();
  }, [onConnectToHost, openNotesPanelForSourceNote]);

  useEffect(() => {
    if (!openNoteRequest) return;
    openNotesPanelForSourceNote(openNoteRequest.tabId, openNoteRequest.noteId);
  }, [openNoteRequest, openNotesPanelForSourceNote]);

  const handleOpenVaultNoteFromAiPanel = useCallback((noteId: string) => {
    const intent = resolveAiNoteArtifactPanelIntent({
      activeTabId: activeTabIdRef.current,
      currentPanel: activeTabIdRef.current
        ? sidePanelOpenTabsRef.current.get(activeTabIdRef.current) ?? null
        : null,
      noteId,
    });

    if (intent.kind === 'fallback') {
      onOpenVaultNoteFromChat?.(intent.noteId);
      return;
    }

    if (intent.returnPanel) {
      notesReturnTabRef.current.set(intent.tabId, intent.returnPanel);
    }
    openNotesPanelForSourceNote(intent.tabId, intent.noteId);
  }, [onOpenVaultNoteFromChat, openNotesPanelForSourceNote]);

  const handleAddSelectionToAI = useCallback((sourceSessionId: string, selection: string) => {
    const text = selection.trim();
    if (!text) return;

    const tabId = activeTabIdRef.current;
    if (!tabId) return;

    const ws = activeWorkspaceRef.current;
    if (ws && ws.focusedSessionId !== sourceSessionId) {
      onSetWorkspaceFocusedSessionRef.current?.(ws.id, sourceSessionId);
    }

    setPendingTerminalSelectionForAI({
      requestId: crypto.randomUUID(),
      tabId,
      text,
    });
    handleSwitchSidePanelTab('ai');
  }, [handleSwitchSidePanelTab]);

  const handlePendingTerminalSelectionConsumed = useCallback((requestId: string) => {
    setPendingTerminalSelectionForAI((current) => (
      current?.requestId === requestId ? null : current
    ));
  }, []);

  // Toggle the AI chat side panel from the top-bar button: open it (or switch
  // to it from another sub-panel), and close the side panel when AI is already
  // the open sub-panel. Unlike handleOpenAI (the rail switch), a second click
  // here dismisses the panel.
  const handleToggleAiFromTopBar = useCallback(() => {
    const tabId = activeTabIdRef.current;
    if (!tabId) return;

    const intent = resolveAiSidePanelToggleIntent(
      sidePanelOpenTabsRef.current.get(tabId) ?? null,
    );

    if (intent.kind === 'closeTerminalSidePanel') {
      handleCloseSidePanel();
      return;
    }

    handleSwitchSidePanelTab('ai');
  }, [handleCloseSidePanel, handleSwitchSidePanelTab]);

  // Execute snippet on the focused terminal session
  const handleSnippetClickForFocusedSession = useCallback((
    command: string,
    noAutoRun?: boolean,
    options?: { multiLineRunMode?: Snippet["multiLineRunMode"] },
  ) => {
    const sessionId = activeWorkspaceRef.current?.focusedSessionId ?? activeSessionRef.current?.id;
    if (!sessionId) return;
    const executor = snippetExecutorsRef.current.get(sessionId);
    if (executor) {
      executor(command, noAutoRun, options);
      return;
    }

    const session = sessionsRef.current.find((candidate) => candidate.id === sessionId);
    if (!session || !canUseDirectSessionWriteFallback(session)) return;

    let data = normalizeLineEndings(command);
    if (!noAutoRun) data = `${data}\r`;
    const lineDelayMs = shouldDelayAutoRunSnippetInput(data, {
      noAutoRun,
      multiLineRunMode: options?.multiLineRunMode,
    })
      ? AUTO_RUN_SNIPPET_LINE_DELAY_MS
      : undefined;
    terminalBackend.writeToSession(sessionId, data, {
      automated: true,
      ...(lineDelayMs ? { lineDelayMs } : {}),
    });
    // Re-focus the terminal so the user can interact immediately
    const pane = document.querySelector(`[data-session-id="${sessionId}"]`);
    const textarea = pane?.querySelector('textarea.xterm-helper-textarea') as HTMLTextAreaElement | null;
    textarea?.focus();
  }, [terminalBackend]);

  const remoteHistory = useRemoteHistoryState();
  const handleHistoryPaste = useCallback(
    (command: string) => handleSnippetClickForFocusedSession(command, true),
    [handleSnippetClickForFocusedSession],
  );
  const handleHistoryRun = useCallback(
    (command: string) => handleSnippetClickForFocusedSession(command, false),
    [handleSnippetClickForFocusedSession],
  );

  const handleSnippetFromPanel = useCallback(async (snippet: Snippet) => {
    const sessionId = getActiveTerminalSessionId();
    if (!sessionId) return;
    if (isScriptSnippet(snippet)) {
      try {
        await runAutomationScript({
          snippet,
          sessionId,
          sessionMeta: buildScriptSessionMeta(sessionId, sessionsRef.current, hosts),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast.error(message.includes('Observer mode') ? t('scripts.observer.blocked') : message);
      }
      return;
    }
    const command = await resolveSnippetCommand(snippet);
    if (command === null) return;
    handleSnippetClickForFocusedSession(command, snippet.noAutoRun, {
      multiLineRunMode: snippet.multiLineRunMode,
    });
  }, [getActiveTerminalSessionId, handleSnippetClickForFocusedSession, hosts, t]);

  const handleRunScriptFromPanel = useCallback(async (snippet: Snippet) => {
    const sessionId = getActiveTerminalSessionId();
    if (!sessionId) return;
    try {
      await runAutomationScript({
        snippet,
        sessionId,
        sessionMeta: buildScriptSessionMeta(sessionId, sessionsRef.current, hosts),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(message.includes('Observer mode') ? t('scripts.observer.blocked') : message);
    }
  }, [getActiveTerminalSessionId, hosts, t]);

  const handleRunScriptOnWorkspace = useCallback(async (
    snippet: Snippet,
    mode: 'sequential' | 'parallel' = 'parallel',
  ) => {
    const workspace = activeWorkspaceRef.current;
    if (!workspace) {
      const sessionId = getActiveTerminalSessionId();
      if (!sessionId) {
        toast.error(t('scripts.recording.noSession'));
        return;
      }
      try {
        await runAutomationScript({
          snippet,
          sessionId,
          sessionMeta: buildScriptSessionMeta(sessionId, sessionsRef.current, hosts),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast.error(message.includes('Observer mode') ? t('scripts.observer.blocked') : message);
      }
      return;
    }
    const workspaceSessions = sessionsRef.current.filter((session) => session.workspaceId === workspace.id);
    const sessionIds = workspaceSessions
      .filter((session) => session.status === 'connected')
      .map((session) => session.id);
    const skippedConnecting = workspaceSessions.filter((session) => session.status === 'connecting').length;
    if (sessionIds.length === 0) {
      if (skippedConnecting > 0) {
        toast.info(t('scripts.actions.skippedConnectingSessions', { count: skippedConnecting }));
      } else {
        toast.error(t('scripts.recording.noSession'));
      }
      return;
    }
    if (skippedConnecting > 0) {
      toast.info(t('scripts.actions.skippedConnectingSessions', { count: skippedConnecting }));
    }
    try {
      const runOnSession = (sid: string) => runAutomationScript({
        snippet,
        sessionId: sid,
        sessionMeta: buildScriptSessionMeta(sid, sessionsRef.current, hosts),
      });
      if (mode === 'sequential') {
        for (const sid of sessionIds) {
          const { runId } = await runOnSession(sid);
          await waitForScriptRun(runId);
        }
      } else {
        await Promise.all(sessionIds.map((sid) => runOnSession(sid)));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(message.includes('Observer mode') ? t('scripts.observer.blocked') : message);
    }
  }, [getActiveTerminalSessionId, hosts, t]);

  useEffect(() => {
    const handler = (event: Event) => {
      const snippet = (event as CustomEvent<{ snippet: Snippet }>).detail?.snippet;
      if (!snippet) return;
      void handleRunScriptFromPanel(snippet);
    };
    window.addEventListener('netcatty:scripts:run-on-focused', handler);
    return () => window.removeEventListener('netcatty:scripts:run-on-focused', handler);
  }, [handleRunScriptFromPanel]);

  const handleStartRecordingFromPanel = useCallback(() => {
    const sessionId = getActiveTerminalSessionId();
    if (!sessionId) {
      toast.error(t('scripts.recording.noSession'));
      return;
    }
    const recording = getScriptRecordingSnapshot();
    if (recording.sessionId === sessionId) {
      window.dispatchEvent(new CustomEvent('netcatty:script:recording:stop', { detail: { sessionId } }));
      return;
    }
    if (recording.sessionId) {
      toast.error(t('scripts.recording.alreadyActive'));
      return;
    }
    window.dispatchEvent(new CustomEvent('netcatty:script:recording:start', { detail: { sessionId } }));
    toast.info(t('scripts.recording.started'));
  }, [getActiveTerminalSessionId, t]);

  const handleComposeSend = useCallback((text: string) => {
    const activeWorkspace = activeWorkspaceRef.current;
    if (!activeWorkspace) return;
    const payload = text + '\r';
    const broadcastEnabled = isBroadcastEnabled?.(activeWorkspace.id);
    const focusedSessionId = activeWorkspace.focusedSessionId;

    if (broadcastEnabled) {
      const allSessionIds = sessionsRef.current
        .filter((session) => session.workspaceId === activeWorkspace.id)
        .map((session) => session.id);
      for (const sid of allSessionIds) {
        const executor = snippetExecutorsRef.current.get(sid);
        if (executor) {
          executor(text, false, { broadcast: false });
        } else {
          const session = sessionsRef.current.find((candidate) => candidate.id === sid);
          if (!session || !canUseDirectSessionWriteFallback(session)) continue;
          terminalBackend.writeToSession(sid, payload);
        }
      }
    } else {
      const workspaceSessions = sessionsRef.current.filter((session) => session.workspaceId === activeWorkspace.id);
      const validFocusedId = focusedSessionId && workspaceSessions.some((session) => session.id === focusedSessionId)
        ? focusedSessionId
        : undefined;
      const targetId = validFocusedId ?? workspaceSessions[0]?.id;
      if (targetId) {
        const executor = snippetExecutorsRef.current.get(targetId);
        if (executor) {
          executor(text, false);
        } else {
          const session = sessionsRef.current.find((candidate) => candidate.id === targetId);
          if (!session || !canUseDirectSessionWriteFallback(session)) return;
          terminalBackend.writeToSession(targetId, payload);
        }
      }
    }
  }, [isBroadcastEnabled, terminalBackend]);

  const sessionLogConfig = useMemo(
    () => ({
      enabled: Boolean(sessionLogsEnabled && sessionLogsDir),
      directory: sessionLogsDir,
      format: sessionLogsFormat || 'txt',
      timestampsEnabled: sessionLogsTimestampsEnabled,
    }),
    [sessionLogsDir, sessionLogsEnabled, sessionLogsFormat, sessionLogsTimestampsEnabled],
  );

  stableRef.current = {
    accentMode,
    activityTrackedSessions,
    AIChatPanelsHost,
    AISidePanelStateRoot,
    AIStateMaintenanceHost,
    AIStateProvider,
    Array,
    Button,
    ChunkedEscapeFilter,
    clearHostTreePreviewVars,
    clearTerminalPreviewVars,
    clearTopTabsPreviewVars,
    FolderTree,
    History,
    HistorySidePanel,
    MessageSquare,
    NotesManager,
    Palette,
    PanelLeft,
    PanelRight,
    cn,
    collectSessionIds,
    customAccent,
    customGroups,
    draggingSessionId,
    editorWordWrap,
    effectiveHosts,
    filterTabsMap,
    followAppTerminalTheme,
    pickTerminalTheme,
    clearThemeIntent,
    settleManualThemeIntent,
    resolveSessionAppearance,
    fontSize,
    getSessionActivityIdsToClear,
    getTerminalCwd,
    handleAddKnownHost,
    handleAddSelectionToAI,
    handleBroadcastInput,
    handleBroadcastInterruptPriorityChange,
    handleCloseSession,
    handleCloseSidePanel,
    handleCommandExecuted,
    handleCommandSubmitted,
    handleComposeSend,
    handleHistoryPaste,
    handleHistoryRun,
    handleOpenHistory,
    handleOpenSftp,
    handleOpenScripts,
    handleOpenTheme,
    handleOpenAI,
    handleOpenSystem,
    handleOpenNotes,
    handleBackFromNotes,
    handleOpenHostFromNotes,
    handleOsDetected,
    handlePendingTerminalSelectionConsumed,
    handlePendingUploadHandled,
    handleSessionExit,
    handleSftpCurrentPathChange,
    handleSftpActiveTransfersChange,
    handleSftpInitialLocationApplied,
    persistSidePanelWidth,
    handleSnippetClickForFocusedSession,
    handleSnippetFromPanel,
    handleRunScriptFromPanel,
    handleRunScriptOnWorkspace,
    handleStartRecordingFromPanel,
    scriptRuns: runs,
    handleStopScriptRun: stopScriptRun,
    handlePauseScriptRun: pauseScriptRun,
    handleResumeScriptRun: resumeScriptRun,
    handleSnippetExecutorChange,
    handleProgrammaticCommandLogRewriteChange,
    handleStatusChange,
    handleTerminalCwdChange,
    handleTerminalTitleChange,
    handleTerminalBell,
    handleTerminalOutput,
    handleTerminalDataCapture,
    handleTerminalFontSizeChange,
    handleToggleAiFromTopBar,
    handleToggleScriptsSidePanel,
    handleToggleSidePanel,
    handleToggleSftpFromBar,
    handleToggleWorkspaceComposeBar,
    handleUpdateHost,
    hasNotifiableTerminalOutput,
    hostMap,
    hosts,
    hostsRef,
    portForwardingRules,
    portForwardingRulesRef,
    hotkeyScheme,
    disableTerminalFontZoom,
    restoreTerminalCwd,
    identities,
    isBroadcastEnabled,
    isComposeBarOpen,
    keyBindings,
    keys,
    knownHosts,
    lastSidePanelTabRef,
    mountedAiTabIds: aiMountedTabIds,
    mountedSftpTabIds,
    notesMountedTabIds,
    notesOpenNoteByTab,
    scriptsMountedTabIds,
    systemMountedTabIds,
    themeMountedTabIds,
    onAddSessionToWorkspace,
    onConnectToHost,
    onCreateLocalTerminal,
    onCreateWorkspaceFromSessions,
    onHotkeyAction,
    onReorderWorkspaceSessions,
    onReorderTabs,
    onCopySession,
    onCopySessionToNewWindow,
    onRequestAddToWorkspace,
    onSessionData,
    onSetDraggingSessionId,
    onSetWorkspaceFocusedSession,
    onStartSessionRename,
    onSubmitSessionRename,
    onRemoveSessionFromWorkspace,
    onStartSessionDrag: onSetDraggingSessionId,
    onEndSessionDrag: () => onSetDraggingSessionId(null),
    onSplitSession,
    onSplitSessionRef,
    onToggleBroadcastRef,
    onToggleWorkspaceViewMode,
    onToggleWorkspaceViewModeRef,
    onUpdateHost,
    onUpdateSplitSizes,
    onUpdateTerminalFontFamilyId,
    onUpdateTerminalFontSize,
    onUpdateTerminalFontWeight,
    onUpdateSessionFontSize,
    onUpdateSessionRestoreCwd,
    onUpdateSessionDynamicTitle,
    onUpdateSessionCodingCliProvider,
    onClearSessionFontSizeOverride,
    onUpdateTerminalThemeId,
    pendingTerminalSelectionForAI,
    refocusActiveTerminalSession,
    refocusTerminalSession,
    remoteHistory,
    shellHistory,
    resolveSftpHostForTab,
    ScriptsSidePanel,
    sessionActivityStore,
    sessionChainHostsMap,
    sessionHostsMap,
    resolvedSessionHostIds,
    sessionLogConfig,
    sessionSudoAutofillPasswordsMap,
    sessionSudoAutofillCandidatesMap,
    sessions,
    sessionsRef,
    setEditorWordWrap,
    setIsComposeBarOpen,
    setPendingTerminalSelectionForAI,
    setAiMountedTabIds,
    setNotesMountedTabIds,
    setNotesOpenNoteByTab,
    setScriptsMountedTabIds,
    setSystemMountedTabIds,
    setThemeMountedTabIds,
    setSidePanelOpenTabs,
    setSidePanelWidth,
    setSftpFollowTerminalCwd,
    setSftpHostForTab,
    setSftpInitialLocationForTab,
    setSftpPendingUploadsForTab,
    showHostTreeSidebar,
    sidePanelOpenTabs,
    sidePanelPosition,
    sidePanelWidth,
    sftpAutoSync,
    sftpDefaultViewMode,
    sftpDoubleClickBehavior,
    sftpFollowTerminalCwd,
    sftpHostForTab,
    sftpInitialLocationForTab,
    sftpPendingUploadsForTab,
    sftpShowHiddenFiles,
    SftpSidePanel,
    sftpUseCompressedUpload,
    shouldMarkSessionActivity,
    snippetExecutorsRef,
    programmaticCommandLogRewriteHandlersRef,
    snippetPackages,
    snippets,
    noteGroups,
    notes,
    onOpenVaultHostFromChat,
    onOpenVaultNoteFromChat: handleOpenVaultNoteFromAiPanel,
    onOpenVaultSectionFromChat,
    onOpenVaultSnippetFromChat,
    splitHorizontalHandlersRef,
    splitVerticalHandlersRef,
    sshDebugLogsEnabled,
    t,
    TerminalComposeBar,
    TerminalPanesHost,
    terminalCwdRevision,
    terminalFontFamilyId,
    terminalRendererCwdBySessionRef,
    terminalSettings,
    terminalTheme,
    terminalThemeId,
    ThemeSidePanel,
    toggleScriptsSidePanelRef,
    toggleSidePanelRef,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    updateHosts,
    updateNoteGroups,
    updateNotes,
    updateSnippetPackages,
    updateSnippets,
    X,
    Zap,
    validAIScopeTargetIds,
    validSessionActivityIds,
    workspaceBroadcastHandlersRef,
    workspaceById,
    workspaceFocusHandlersRef,
    workspaces,
    workspacesRef,
    activeTabIdRef,
    activeWorkspaceRef,
    activeSessionRef,
    focusedSessionIdRef,
    setSidePanelPosition,
  };

  return <TerminalLayerTabBridge stableRef={stableRef} />;
};

export const TerminalLayer = memo(TerminalLayerInner, terminalLayerAreEqual);
TerminalLayer.displayName = 'TerminalLayer';
