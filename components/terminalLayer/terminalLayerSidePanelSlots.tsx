/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { memo, useCallback, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { activeTabStore } from '../../application/state/activeTabStore';
import { getSftpCurrentPathMemoryKey } from '../../application/state/sftp/sftpReopenLocation';
import {
  getSidePanelLiveSnapshot,
  SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT,
  subscribeSidePanelLiveSnapshot,
} from '../../application/state/sidePanelLiveStore';
import {
  getEmptyNotesSnapshot,
  getNotesSnapshot,
  subscribeNotes,
  subscribeNotesNoop,
  useNotesStore,
} from '../../application/state/notesStore';
import {
  getShellHistorySnapshot,
  subscribeShellHistory,
} from '../../application/state/shellHistoryStore';
import { useScriptExecution } from '../../application/state/useScriptExecution';
import { useRemoteHistoryState } from '../../application/state/useRemoteHistoryState';
import { resolveSystemSidebarSession } from '../../domain/systemManager/resolveSystemSession';
import { collectSessionIds } from '../../domain/workspace';
import { shouldKeepTerminalBackgroundWorkActive } from '../../domain/terminalHibernate';
import { resolveTerminalFontFamilyId } from '../../infrastructure/config/fonts';
import type { Host, TerminalSession, Workspace } from '../../types';
import { HostBrowserSidePanel } from '../HostBrowserSidePanel';
import { SystemManagerSidePanel } from '../systemManager/SystemManagerSidePanel';
import { resolveSftpFollowTerminalCwdTargetHost } from '../../domain/sftpFollowTerminalCwd';
import { AI_PANEL_FORCE_HIDE_SHELL } from '../ai/aiPanelDiagnostics';
import type { SidePanelTab } from './TerminalLayerSupport';
import {
  collectSidePanelPanes,
  sidePanelLayoutHasTool,
  type SidePanelLayout,
} from '../../domain/sidePanelLayout';
import { sidePanelHiddenNotesPanelClassName, sidePanelHiddenPanelClassName } from './terminalLayerSidePanelHiddenWrapper';
import { shouldKeepSftpBrowseSessionInteractive } from './sftpPanelLifecycle';

type SidePanelStableContext = Record<string, any> & {
  sftpPaneClosedTabIdsRef: React.MutableRefObject<Set<string>>;
};
const navigatorPlatform = typeof navigator !== 'undefined' ? navigator.platform : '';
const EMPTY_VAULT_NOTES: never[] = [];
const EMPTY_VAULT_HOSTS: never[] = [];
const EMPTY_VAULT_SNIPPETS: never[] = [];
const subscribeShellHistoryNoop = () => () => {};

function useSidePanelLiveSnapshotForTab(tabId: string, subscribe: boolean) {
  const retainedSnapshot = useRef({ tabId, snapshot: SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT });
  const getSnapshot = useCallback(() => {
    if (!subscribe) return SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT;
    const snapshot = getSidePanelLiveSnapshot(true);
    const snapshotTabId = snapshot.activeWorkspace?.id ?? snapshot.focusedSessionId;
    // Tab visibility changes before the live publisher commits its next snapshot.
    // Keep this panel's last context until its own terminal/workspace catches up.
    if (snapshotTabId === tabId) retainedSnapshot.current = { tabId, snapshot };
    return retainedSnapshot.current.tabId === tabId
      ? retainedSnapshot.current.snapshot
      : SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT;
  }, [subscribe, tabId]);
  return useSyncExternalStore(
    (listener) => subscribeSidePanelLiveSnapshot(subscribe, listener),
    getSnapshot,
    getSnapshot,
  );
}

function SidePanelSftpSlotInner({
  tabId,
  ctx,
  isVisible,
  ownerPanelOpen,
}: {
  tabId: string;
  ctx: SidePanelStableContext;
  isVisible: boolean;
  /** Side panel still open for this tab (may be showing another tool). */
  ownerPanelOpen: boolean;
}) {
  const live = useSidePanelLiveSnapshotForTab(tabId, isVisible);

  const {
    SftpSidePanel,
    effectiveHosts,
    hosts,
    sessions,
    keys,
    identities,
    knownHosts,
    updateHosts,
    handleAddKnownHost,
    sftpDefaultViewMode,
    sftpHostForTab,
    sftpInitialLocationForTab,
    sftpPendingUploadsForTab,
    handleSftpInitialLocationApplied,
    handleSftpCurrentPathChange,
    handleSftpActiveTransfersChange,
    handleSftpActiveExternalEditsChange,
    handlePendingUploadHandled,
    sftpDoubleClickBehavior,
    sftpAutoSync,
    sftpShowHiddenFiles,
    sftpUseCompressedUpload,
    hotkeyScheme,
    keyBindings,
    editorWordWrap,
    setEditorWordWrap,
    getTerminalCwd,
    sftpFollowTerminalCwd,
    setSftpFollowTerminalCwd,
    refocusActiveTerminalSession,
    terminalSettings,
  } = ctx;

  const storedSftpHost = sftpHostForTab.get(tabId) ?? null;
  const panelActiveHost = isVisible
    ? (live.sftpActiveHost ?? storedSftpHost)
    : storedSftpHost;
  const panelActiveSessionId = isVisible ? live.activeTerminalSessionIdForSftp : null;
  const panelFocusedSessionId = isVisible ? live.focusedSessionId : null;
  // Only the head of the per-tab pending upload queue is surfaced at a time;
  // the panel advances the queue by reporting each request as handled.
  const pendingUpload = sftpPendingUploadsForTab.get(tabId)?.[0] ?? null;

  const handleFollowTerminalCwdChange = useCallback((enabled: boolean, visibleHost?: Host | null) => {
    const isActive = activeTabStore.getActiveTabId() === tabId;
    const stored = (sftpHostForTab as Map<string, Host>).get(tabId) ?? null;
    const snapshot = getSidePanelLiveSnapshot(isActive);
    const activeHost = isActive ? (snapshot.sftpActiveHost ?? stored) : stored;
    const targetHost = resolveSftpFollowTerminalCwdTargetHost(visibleHost, activeHost);
    if (!targetHost?.id) {
      setSftpFollowTerminalCwd(enabled);
      return;
    }
    let updated = false;
    const nextHosts = (hosts as Host[]).map((host) => {
      if (host.id !== targetHost.id) return host;
      updated = true;
      return { ...host, sftpFollowTerminalCwd: enabled };
    });
    if (updated) {
      updateHosts(nextHosts);
    } else {
      setSftpFollowTerminalCwd(enabled);
    }
  }, [hosts, sftpHostForTab, setSftpFollowTerminalCwd, tabId, updateHosts]);

  const handleInitialLocationApplied = useCallback(
    (location: { hostId: string; path: string }) => {
      handleSftpInitialLocationApplied(tabId, location);
    },
    [handleSftpInitialLocationApplied, tabId],
  );

  const handlePendingUploadHandledForTab = useCallback(
    (requestId: string) => {
      handlePendingUploadHandled(tabId, requestId);
    },
    [handlePendingUploadHandled, tabId],
  );

  const handleCurrentPathChange = useCallback(
    (location: { hostId: string; connectionKey: string; path: string }) => {
      handleSftpCurrentPathChange(
        getSftpCurrentPathMemoryKey({
          tabId,
          activeTerminalSessionIdForSftp: panelActiveSessionId,
          focusedSessionId: panelFocusedSessionId,
        }),
        location,
      );
    },
    [handleSftpCurrentPathChange, panelActiveSessionId, panelFocusedSessionId, tabId],
  );

  const handleActiveTransfersChange = useCallback(
    (count: number) => {
      handleSftpActiveTransfersChange(tabId, count);
    },
    [handleSftpActiveTransfersChange, tabId],
  );

  const handleActiveExternalEditsChange = useCallback(
    (count: number) => {
      handleSftpActiveExternalEditsChange(tabId, count);
    },
    [handleSftpActiveExternalEditsChange, tabId],
  );

  return (
    <div className={sidePanelHiddenPanelClassName(!isVisible)}>
      <SftpSidePanel
        transferOwnerId={`terminal:${tabId}`}
        ownerTabId={tabId}
        hosts={effectiveHosts}
        writableHosts={hosts}
        sessions={sessions}
        keys={keys}
        identities={identities}
        knownHosts={knownHosts}
        updateHosts={updateHosts}
        onAddKnownHost={handleAddKnownHost}
        sftpDefaultViewMode={sftpDefaultViewMode}
        activeHost={panelActiveHost}
        activeSessionId={panelActiveSessionId}
        focusedSessionId={panelFocusedSessionId}
        initialLocation={isVisible ? (sftpInitialLocationForTab.get(tabId) ?? null) : null}
        onInitialLocationApplied={handleInitialLocationApplied}
        onCurrentPathChange={handleCurrentPathChange}
        onActiveTransfersChange={handleActiveTransfersChange}
        onActiveExternalEditsChange={handleActiveExternalEditsChange}
        showWorkspaceHostHeader={isVisible && !!live.activeWorkspace}
        isVisible={isVisible}
        ownerPanelOpen={ownerPanelOpen}
        renderOverlays={isVisible}
        pendingUpload={pendingUpload}
        onPendingUploadHandled={handlePendingUploadHandledForTab}
        sftpDoubleClickBehavior={sftpDoubleClickBehavior}
        sftpAutoSync={isVisible ? sftpAutoSync : false}
        sftpShowHiddenFiles={sftpShowHiddenFiles}
        sftpUseCompressedUpload={sftpUseCompressedUpload}
        hotkeyScheme={hotkeyScheme}
        keyBindings={keyBindings}
        editorWordWrap={editorWordWrap}
        setEditorWordWrap={setEditorWordWrap}
        onGetTerminalCwd={getTerminalCwd}
        activeTerminalCwd={isVisible ? live.activeTerminalCwd : null}
        activeTerminalCwdTrusted={isVisible ? live.activeTerminalCwdTrusted : false}
        sftpFollowTerminalCwd={sftpFollowTerminalCwd}
        onSftpFollowTerminalCwdChange={handleFollowTerminalCwdChange}
        onRequestTerminalFocus={refocusActiveTerminalSession}
        terminalSettings={terminalSettings}
      />
    </div>
  );
}

export const SidePanelSftpSlot = memo(SidePanelSftpSlotInner);
SidePanelSftpSlot.displayName = 'SidePanelSftpSlot';

function SidePanelBrowserSlot({ tabId, ctx, isVisible }: {
  tabId: string;
  ctx: SidePanelStableContext;
  isVisible: boolean;
}) {
  const live = useSidePanelLiveSnapshotForTab(tabId, isVisible);
  const sessions = ctx.sessions as TerminalSession[];
  const workspace = (ctx.workspaceById as Map<string, Workspace>).get(tabId);
  const current = (isVisible ? live.activeTerminalSessionForSystem : null)
    ?? resolveSystemSidebarSession(sessions, workspace, workspace?.focusedSessionId,
      sessions.find((session) => session.id === tabId));
  const retainedSessionIds = useRef(new Set<string>());
  if (isVisible && current) retainedSessionIds.current.add(current.id);
  const workspaceSessionIds = workspace ? new Set(collectSessionIds(workspace.root)) : null;
  for (const id of retainedSessionIds.current) {
    if (!sessions.some((session) => session.id === id && (workspaceSessionIds
      ? workspaceSessionIds.has(id) : session.id === tabId && !session.workspaceId))) retainedSessionIds.current.delete(id);
  }
  const sessionHosts = ctx.sessionHostsMap as Map<string, Host>;
  const authHosts = ctx.sftpAuthHostBySessionId as Map<string, Host>;
  const currentHost = current ? authHosts.get(current.id) ?? sessionHosts.get(current.id) : null;
  const supportsBrowser = currentHost && ['ssh', 'mosh', 'local'].includes(currentHost.protocol ?? 'ssh');
  return (
    <div className={sidePanelHiddenPanelClassName(!isVisible)} data-section="terminal-browser-panel">
      {workspace && supportsBrowser && <div className="h-8 shrink-0 border-b border-border/50 px-3 flex items-center text-xs text-muted-foreground truncate">
        {currentHost.label || currentHost.hostname}
      </div>}
      <div className={workspace && supportsBrowser ? 'relative h-[calc(100%-2rem)] min-h-0 overflow-hidden' : 'relative h-full min-h-0 overflow-hidden'}>
        {!supportsBrowser && <p className="p-4 text-sm text-muted-foreground">{ctx.t('terminal.browser.sshOnly')}</p>}
        {[...retainedSessionIds.current].map((sessionId) => {
          const host = authHosts.get(sessionId) ?? sessionHosts.get(sessionId);
          if (!host || !['ssh', 'mosh', 'local'].includes(host.protocol ?? 'ssh')) return null;
          const visible = isVisible && current?.id === sessionId;
          return <div key={sessionId} className={visible ? 'absolute inset-0 overflow-hidden' : 'hidden'}>
            <HostBrowserSidePanel
              browserId={`${tabId}:${sessionId}`}
              host={host}
              hosts={ctx.effectiveHosts}
              keys={ctx.keys}
              identities={ctx.identities}
              knownHosts={ctx.knownHosts}
              terminalSettings={ctx.terminalSettings}
              isVisible={visible}
            />
          </div>;
        })}
      </div>
    </div>
  );
}

function SidePanelSystemSlotInner({
  tabId,
  ctx,
  isTabActive,
  isVisible,
  isSelected,
}: {
  tabId: string;
  ctx: SidePanelStableContext;
  isTabActive: boolean;
  isVisible: boolean;
  isSelected: boolean;
}) {
  // When this tab is active, prefer live store so focus changes do not require
  // workspaceById identity churn through the stable side-panel ctx.
  const live = useSidePanelLiveSnapshotForTab(tabId, isVisible);
  const sessions = ctx.sessions as TerminalSession[];
  const sessionHostsMap = ctx.sessionHostsMap as Map<string, Host>;
  const workspace = (ctx.workspaceById as Map<string, Workspace>).get(tabId);
  const standaloneSession = sessions.find((session) => session.id === tabId);
  const resolvedSession = resolveSystemSidebarSession(
    sessions,
    workspace,
    workspace?.focusedSessionId,
    standaloneSession,
  );
  const systemSession = (isVisible
    ? (live.activeTerminalSessionForSystem ?? resolvedSession)
    : resolvedSession) ?? null;
  const systemHost = (isVisible && live.activeSystemSessionHost)
    ? live.activeSystemSessionHost
    : (systemSession ? sessionHostsMap.get(systemSession.id) ?? null : null);
  const keepSystemWorkActive = isSelected
    && shouldKeepTerminalBackgroundWorkActive(
      ctx.terminalSettings,
      systemHost?.protocol,
      isTabActive,
    );

  const {
    refocusActiveTerminalSession,
    snippets,
    terminalSettings,
  } = ctx;

  return (
    <div className={sidePanelHiddenPanelClassName(!isVisible)}>
      <SystemManagerSidePanel
        key={systemSession?.id ?? 'system-none'}
        session={systemSession ?? null}
        sessionHost={systemHost}
        showWorkspaceHostHeader={isVisible && !!workspace}
        isVisible={keepSystemWorkActive}
        terminalSettings={terminalSettings}
        snippets={snippets}
        onRequestTerminalFocus={refocusActiveTerminalSession}
      />
    </div>
  );
}

export const SidePanelSystemSlot = memo(SidePanelSystemSlotInner);
SidePanelSystemSlot.displayName = 'SidePanelSystemSlot';

function SidePanelScriptsSlotInner({
  tabId,
  ctx,
  isVisible,
}: {
  tabId: string;
  ctx: SidePanelStableContext;
  isVisible: boolean;
}) {
  const live = useSidePanelLiveSnapshotForTab(tabId, isVisible);
  // Subscribe only while visible so retained scripts slots skip log thrash.
  const { runs: scriptRuns } = useScriptExecution({ enabled: isVisible });

  const {
    ScriptsSidePanel,
    snippets,
    snippetPackages,
    updateSnippets,
    updateSnippetPackages,
    handleSnippetFromPanel,
    handleRunScriptFromPanel,
    handleRunScriptOnWorkspace,
    handleStartRecordingFromPanel,
    handleStopScriptRun,
    handlePauseScriptRun,
    handleResumeScriptRun,
  } = ctx;

  return (
    <div className={sidePanelHiddenPanelClassName(!isVisible)}>
      <ScriptsSidePanel
        snippets={snippets}
        packages={snippetPackages}
        onSnippetsChange={updateSnippets}
        onPackagesChange={updateSnippetPackages}
        onSnippetClick={handleSnippetFromPanel}
        onRunScript={handleRunScriptFromPanel}
        onRunScriptOnWorkspace={handleRunScriptOnWorkspace}
        onStartRecording={handleStartRecordingFromPanel}
        runs={scriptRuns as import('@/types/global/netcatty-bridge-script.d.ts').ScriptRun[]}
        onStopRun={handleStopScriptRun}
        onPauseRun={handlePauseScriptRun}
        onResumeRun={handleResumeScriptRun}
        focusedSessionId={live.focusedSessionId ?? undefined}
        isVisible={isVisible}
      />
    </div>
  );
}

export const SidePanelScriptsSlot = memo(SidePanelScriptsSlotInner);
SidePanelScriptsSlot.displayName = 'SidePanelScriptsSlot';

function SidePanelThemeSlotInner({
  tabId,
  ctx,
  isVisible,
}: {
  tabId: string;
  ctx: SidePanelStableContext;
  isVisible: boolean;
}) {
  // Only subscribe while the theme panel is visible — not merely tab-active —
  // so cwd/focus live ticks do not thrash a retained ThemeSidePanel.
  const live = useSidePanelLiveSnapshotForTab(tabId, isVisible);

  const {
    ThemeSidePanel,
    followAppTerminalTheme,
    terminalTheme,
    terminalThemeId,
    terminalFontFamilyId,
    handleThemeChangeForFocusedSession,
    handleThemeResetForFocusedSession,
    handleFontFamilyChangeForFocusedSession,
    handleFontFamilyResetForFocusedSession,
    handleFontSizeChangeForFocusedSession,
    handleFontSizeResetForFocusedSession,
    handleFontWeightChangeForFocusedSession,
    handleFontWeightResetForFocusedSession,
  } = ctx;

  return (
    <div className={sidePanelHiddenPanelClassName(!isVisible)}>
      <ThemeSidePanel
        followAppTerminalTheme={followAppTerminalTheme}
        currentThemeId={live.previewedOrVisibleThemeId}
        globalThemeId={terminalThemeId ?? terminalTheme.id}
        currentFontFamilyId={resolveTerminalFontFamilyId(live.focusedFontFamilyId, navigatorPlatform)}
        globalFontFamilyId={resolveTerminalFontFamilyId(terminalFontFamilyId, navigatorPlatform)}
        currentFontSize={live.focusedFontSize}
        currentFontWeight={live.focusedFontWeight}
        canResetTheme={followAppTerminalTheme ? false : live.focusedThemeOverridden}
        canResetFontFamily={live.focusedFontFamilyOverridden}
        canResetFontSize={live.focusedFontSizeOverridden}
        canResetFontWeight={live.focusedFontWeightOverridden}
        onThemeChange={handleThemeChangeForFocusedSession}
        onThemeReset={handleThemeResetForFocusedSession}
        onFontFamilyChange={handleFontFamilyChangeForFocusedSession}
        onFontFamilyReset={handleFontFamilyResetForFocusedSession}
        onFontSizeChange={handleFontSizeChangeForFocusedSession}
        onFontSizeReset={handleFontSizeResetForFocusedSession}
        onFontWeightChange={handleFontWeightChangeForFocusedSession}
        onFontWeightReset={handleFontWeightResetForFocusedSession}
        isVisible={isVisible}
      />
    </div>
  );
}

export const SidePanelThemeSlot = memo(SidePanelThemeSlotInner);
SidePanelThemeSlot.displayName = 'SidePanelThemeSlot';

function SidePanelNotesSlotInner({
  tabId,
  ctx,
  isVisible,
}: {
  tabId: string;
  ctx: SidePanelStableContext;
  isVisible: boolean;
}) {
  const openNoteRequest = (ctx.notesOpenNoteByTab as Map<string, { noteId: string; requestId: number }>).get(tabId) ?? null;
  // Gate subscription while Notes is hidden so vault edits (and the full-page
  // notebook) do not re-render this retained side-panel mount.
  const {
    notes,
    noteGroups,
    updateNotes,
    updateNoteGroups,
  } = useNotesStore({ enabled: isVisible });

  const {
    NotesManager,
    hosts,
    handleOpenHostFromNotes,
  } = ctx;

  return (
    <div
      className={sidePanelHiddenNotesPanelClassName(!isVisible)}
      data-section={isVisible ? 'terminal-notes-panel' : undefined}
    >
      <NotesManager
        notes={notes}
        noteGroups={noteGroups}
        hosts={hosts}
        onUpdateNotes={updateNotes}
        onUpdateNoteGroups={updateNoteGroups}
        onOpenHost={handleOpenHostFromNotes}
        displayMode="sidebar"
        isActive={isVisible}
        openNoteId={openNoteRequest?.noteId ?? null}
        openNoteRequestId={openNoteRequest?.requestId ?? null}
      />
    </div>
  );
}

export const SidePanelNotesSlot = memo(SidePanelNotesSlotInner);
SidePanelNotesSlot.displayName = 'SidePanelNotesSlot';

function SidePanelHistorySlotInner({
  activeTabId,
  ctx,
  isVisible,
}: {
  activeTabId: string | null;
  ctx: SidePanelStableContext;
  isVisible: boolean;
}) {
  const live = useSidePanelLiveSnapshotForTab(activeTabId ?? '', isVisible);
  // Own remote-history state here so fetch/loading does not re-render TerminalLayer.
  // One instance for the life of the slot; HistorySidePanel fetches only when
  // visible and the host cache is still empty.
  const remoteHistory = useRemoteHistoryState();
  // Subscribe only while visible so command appends do not re-render the parked
  // list. Keep reading the live snapshot (same idea as notes) so the hide
  // render does not swap in an empty list and unmount rows.
  const shellHistory = useSyncExternalStore(
    isVisible ? subscribeShellHistory : subscribeShellHistoryNoop,
    getShellHistorySnapshot,
    getShellHistorySnapshot,
  );
  // While hidden the live-store read is the inactive snapshot. Keep the last
  // real host/session so search, scroll, and the remote-history cache lookup
  // survive parking. Never retain the inactive sentinel itself: a visible
  // panel must show `live` (possibly empty) rather than the previous tab.
  const retainedLiveRef = useRef(live);
  if (isVisible && live !== SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT) {
    retainedLiveRef.current = live;
  }
  const panelLive = isVisible ? live : retainedLiveRef.current;

  const {
    HistorySidePanel,
    handleHistoryPaste,
    handleHistoryDelete,
    handleHistoryClear,
    handleHistoryRun,
  } = ctx;

  return (
    <div className={sidePanelHiddenPanelClassName(!isVisible)}>
      <HistorySidePanel
        focusedHost={panelLive.focusedHost}
        focusedSessionId={panelLive.historySessionId}
        state={remoteHistory.getState(panelLive.focusedHost?.id, panelLive.historySessionId)}
        globalEntries={shellHistory as import('../../domain/models').ShellHistoryEntry[]}
        onFetch={remoteHistory.fetch}
        onDeleteGlobalEntry={handleHistoryDelete}
        onClearGlobalHistory={handleHistoryClear}
        onPasteToTerminal={handleHistoryPaste}
        onRunInTerminal={handleHistoryRun}
        isVisible={isVisible}
      />
    </div>
  );
}

export const SidePanelHistorySlot = memo(SidePanelHistorySlotInner);
SidePanelHistorySlot.displayName = 'SidePanelHistorySlot';

function SidePanelAiSlotInner({
  activeTabId,
  ctx,
  isVisible,
}: {
  activeTabId: string | null;
  ctx: SidePanelStableContext;
  isVisible: boolean;
}) {
  const {
    AIChatPanelsHost,
    AISidePanelStateRoot,
    mountedAiTabIds,
    aiContextsByTabId,
    resolveAIExecutorContext,
    pendingTerminalSelectionForAI,
    handlePendingTerminalSelectionConsumed,
    hosts,
    snippets,
    onOpenVaultNoteFromChat,
    onOpenVaultHostFromChat,
    onOpenVaultSectionFromChat,
    onOpenVaultSnippetFromChat,
    validAIScopeTargetIds,
  } = ctx;
  const workspaces = ctx.workspaces as Workspace[];

  // Gate notes subscription while AI is hidden so note edits do not re-render
  // retained AI mounts (panel still mounts for fast reopen).
  const notesSnapshot = useSyncExternalStore(
    isVisible ? subscribeNotes : subscribeNotesNoop,
    isVisible ? getNotesSnapshot : getEmptyNotesSnapshot,
    isVisible ? getNotesSnapshot : getEmptyNotesSnapshot,
  );

  const activeLayout = activeTabId
    ? (ctx.sidePanelLayouts as Map<string, SidePanelLayout>).get(activeTabId)
    : null;
  const hideVisibleShell = (
    AI_PANEL_FORCE_HIDE_SHELL
    && isVisible
    && (!activeLayout || collectSidePanelPanes(activeLayout.root).length <= 1)
  );

  // Keep the AI state root mounted even with zero panel hosts so workspace
  // merge/detach can seed and hand off scoped chats before orphan cleanup.
  if (mountedAiTabIds.length === 0 || hideVisibleShell) {
    return (
      <AISidePanelStateRoot
        validAIScopeTargetIds={validAIScopeTargetIds}
        workspaces={workspaces}
      >
        {null}
      </AISidePanelStateRoot>
    );
  }

  // Only the visible AI panel needs vault catalogs for artifact navigation.
  // Hidden retained panels keep session state without re-binding huge hosts/notes.
  const injectVaultCatalog = isVisible;
  const notes = injectVaultCatalog
    ? (notesSnapshot.notes as import('../../domain/models').VaultNote[])
    : EMPTY_VAULT_NOTES;

  return (
    <AISidePanelStateRoot
      validAIScopeTargetIds={validAIScopeTargetIds}
      workspaces={workspaces}
    >
      <AIChatPanelsHost
        mountedTabIds={mountedAiTabIds}
        activeTabId={activeTabId}
        activeSidePanelTab={isVisible ? 'ai' : null}
        liveScopeTargetIds={validAIScopeTargetIds}
        contextsByTabId={aiContextsByTabId}
        resolveExecutorContext={resolveAIExecutorContext}
        pendingTerminalSelection={pendingTerminalSelectionForAI}
        onPendingTerminalSelectionConsumed={handlePendingTerminalSelectionConsumed}
        notes={notes}
        hosts={injectVaultCatalog ? hosts : EMPTY_VAULT_HOSTS}
        snippets={injectVaultCatalog ? snippets : EMPTY_VAULT_SNIPPETS}
        onOpenVaultNoteFromChat={onOpenVaultNoteFromChat}
        onOpenVaultHostFromChat={onOpenVaultHostFromChat}
        onOpenVaultSectionFromChat={onOpenVaultSectionFromChat}
        onOpenVaultSnippetFromChat={onOpenVaultSnippetFromChat}
        workspaces={workspaces}
      />
    </AISidePanelStateRoot>
  );
}

export const SidePanelAiSlot = memo(SidePanelAiSlotInner);
SidePanelAiSlot.displayName = 'SidePanelAiSlot';

export function getFocusedPortalDescendant(
  mountNode: HTMLElement,
  activeElement: Element | null,
): HTMLElement | null {
  return activeElement instanceof HTMLElement && mountNode.contains(activeElement)
    ? activeElement
    : null;
}

export function movePersistentPortalNode(
  mountNode: HTMLElement,
  target: HTMLElement,
  focusToRestore: HTMLElement | null,
) {
  target.appendChild(mountNode);
  if (focusToRestore && document.activeElement !== focusToRestore) {
    focusToRestore.focus({ preventScroll: true });
  }
}

export function PersistentSidePanelPortal({
  portalKey,
  target,
  children,
}: {
  portalKey: string;
  target: HTMLElement | null;
  children: React.ReactNode;
}) {
  const [mountNode] = React.useState(() => {
    const node = document.createElement('div');
    node.className = 'absolute inset-0 overflow-hidden';
    node.dataset.sidePanelPortal = portalKey;
    return node;
  });
  const focusRestoreRef = React.useRef<HTMLElement | null>(null);

  // The React portal always targets the same detached node. Moving that node
  // between a pane host and the hidden parking host preserves the mounted
  // subtree (including active SFTP/AI state) instead of remounting it whenever
  // the focused pane changes.
  React.useLayoutEffect(() => {
    if (!target) return;
    const activeElement = document.activeElement;
    const focusedDescendant = focusRestoreRef.current
      ?? getFocusedPortalDescendant(mountNode, activeElement);
    movePersistentPortalNode(mountNode, target, focusedDescendant);
    focusRestoreRef.current = null;
    return () => {
      if (mountNode.parentNode !== target) return;
      const currentActiveElement = document.activeElement;
      focusRestoreRef.current = getFocusedPortalDescendant(mountNode, currentActiveElement);
      mountNode.remove();
    };
  }, [mountNode, target]);

  return createPortal(children, mountNode, portalKey);
}

export function resolveSidePanelPortalTarget<T>(
  isVisible: boolean,
  paneHost: T | null | undefined,
  parkingHost: T | null,
): T | null {
  return isVisible ? (paneHost ?? parkingHost) : parkingHost;
}

export function SidePanelMountedContent({
  ctx,
  paneHosts,
  parkingHost,
}: {
  ctx: SidePanelStableContext;
  paneHosts: ReadonlyMap<SidePanelTab, HTMLElement>;
  parkingHost: HTMLElement | null;
}) {
  const {
    mountedSftpTabIds,
    browserMountedTabIds = [],
    systemMountedTabIds,
    scriptsMountedTabIds,
    themeMountedTabIds,
    notesMountedTabIds,
  } = ctx;
  const activeTabId = useSyncExternalStore(
    activeTabStore.subscribe,
    activeTabStore.getActiveTabId,
    activeTabStore.getActiveTabId,
  );
  const layouts = ctx.sidePanelLayouts as Map<string, SidePanelLayout>;
  const openTabs = ctx.sidePanelOpenTabs as Map<string, SidePanelTab>;
  const retainedAfterCloseTabIdsRef = ctx.sftpRetainedAfterCloseTabIdsRef as
    | React.MutableRefObject<ReadonlySet<string>>
    | undefined;
  const sftpPaneClosedTabIdsRef = ctx.sftpPaneClosedTabIdsRef;
  const isSftpOwnerPanelOpen = (tabId: string) => shouldKeepSftpBrowseSessionInteractive({
    sidePanelOpen: openTabs.has(tabId),
    retainedAfterClose: retainedAfterCloseTabIdsRef?.current.has(tabId) ?? false,
    sftpPaneClosed: sftpPaneClosedTabIdsRef.current.has(tabId),
  });
  const isToolVisible = (tabId: string, tool: SidePanelTab) => (
    activeTabId === tabId && sidePanelLayoutHasTool(layouts.get(tabId), tool)
  );
  const portalTarget = (tabId: string, tool: SidePanelTab) => (
    resolveSidePanelPortalTarget(isToolVisible(tabId, tool), paneHosts.get(tool), parkingHost)
  );
  const activeLayout = activeTabId ? layouts.get(activeTabId) : undefined;
  const historyVisible = !!activeTabId && sidePanelLayoutHasTool(activeLayout, 'history');
  const aiVisible = !!activeTabId && sidePanelLayoutHasTool(activeLayout, 'ai');

  return (
    <>
      {browserMountedTabIds.map((tabId: string) => (
        <PersistentSidePanelPortal key={`browser-${tabId}`} portalKey={`browser-${tabId}`} target={portalTarget(tabId, 'browser')}>
          <SidePanelBrowserSlot tabId={tabId} ctx={ctx} isVisible={isToolVisible(tabId, 'browser')} />
        </PersistentSidePanelPortal>
      ))}
      {mountedSftpTabIds.map((tabId: string) => (
        <PersistentSidePanelPortal
          key={`sftp-${tabId}`}
          portalKey={`sftp-${tabId}`}
          target={portalTarget(tabId, 'sftp')}
        >
          <SidePanelSftpSlot
            tabId={tabId}
            ctx={ctx}
            isVisible={isToolVisible(tabId, 'sftp')}
            ownerPanelOpen={isSftpOwnerPanelOpen(tabId)}
          />
        </PersistentSidePanelPortal>
      ))}
      {systemMountedTabIds.map((tabId: string) => {
        const isSelected = sidePanelLayoutHasTool(layouts.get(tabId), 'system');
        const isVisible = activeTabId === tabId && isSelected;
        return (
          <PersistentSidePanelPortal
            key={`system-${tabId}`}
            portalKey={`system-${tabId}`}
            target={resolveSidePanelPortalTarget(isVisible, paneHosts.get('system'), parkingHost)}
          >
            <SidePanelSystemSlot
              tabId={tabId}
              ctx={ctx}
              isTabActive={activeTabId === tabId}
              isVisible={isVisible}
              isSelected={isSelected}
            />
          </PersistentSidePanelPortal>
        );
      })}
      {scriptsMountedTabIds.map((tabId: string) => (
        <PersistentSidePanelPortal
          key={`scripts-${tabId}`}
          portalKey={`scripts-${tabId}`}
          target={portalTarget(tabId, 'scripts')}
        >
          <SidePanelScriptsSlot tabId={tabId} ctx={ctx} isVisible={isToolVisible(tabId, 'scripts')} />
        </PersistentSidePanelPortal>
      ))}
      <PersistentSidePanelPortal
        portalKey="history-active"
        target={resolveSidePanelPortalTarget(historyVisible, paneHosts.get('history'), parkingHost)}
      >
        <SidePanelHistorySlot activeTabId={activeTabId} ctx={ctx} isVisible={historyVisible} />
      </PersistentSidePanelPortal>
      {themeMountedTabIds.map((tabId: string) => (
        <PersistentSidePanelPortal
          key={`theme-${tabId}`}
          portalKey={`theme-${tabId}`}
          target={portalTarget(tabId, 'theme')}
        >
          <SidePanelThemeSlot tabId={tabId} ctx={ctx} isVisible={isToolVisible(tabId, 'theme')} />
        </PersistentSidePanelPortal>
      ))}
      {notesMountedTabIds.map((tabId: string) => (
        <PersistentSidePanelPortal
          key={`notes-${tabId}`}
          portalKey={`notes-${tabId}`}
          target={portalTarget(tabId, 'notes')}
        >
          <SidePanelNotesSlot tabId={tabId} ctx={ctx} isVisible={isToolVisible(tabId, 'notes')} />
        </PersistentSidePanelPortal>
      ))}
      <PersistentSidePanelPortal
        portalKey="ai-host"
        target={resolveSidePanelPortalTarget(aiVisible, paneHosts.get('ai'), parkingHost)}
      >
        <SidePanelAiSlot activeTabId={activeTabId} ctx={ctx} isVisible={aiVisible} />
      </PersistentSidePanelPortal>
    </>
  );
}
