/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { memo, useCallback, useSyncExternalStore } from 'react';

import { activeTabStore, useIsTabActive } from '../../application/state/activeTabStore';
import { getSftpCurrentPathMemoryKey } from '../../application/state/sftp/sftpReopenLocation';
import {
  getSidePanelLiveSnapshot,
  subscribeSidePanelLiveSnapshot,
} from '../../application/state/sidePanelLiveStore';
import { resolveSystemSidebarSession } from '../../domain/systemManager/resolveSystemSession';
import { shouldKeepTerminalBackgroundWorkActive } from '../../domain/terminalHibernate';
import { resolveTerminalFontFamilyId } from '../../infrastructure/config/fonts';
import type { Host, TerminalSession, Workspace } from '../../types';
import { SystemManagerSidePanel } from '../systemManager/SystemManagerSidePanel';
import { resolveSftpFollowTerminalCwdTargetHost } from '../sftp/sftpFollowTerminalCwd';
import { AI_PANEL_FORCE_HIDE_SHELL } from '../ai/aiPanelDiagnostics';
import type { SidePanelTab } from './TerminalLayerSupport';
import { sidePanelHiddenNotesPanelClassName, sidePanelHiddenPanelClassName } from './terminalLayerSidePanelHiddenWrapper';

type SidePanelStableContext = Record<string, any>;
const navigatorPlatform = typeof navigator !== 'undefined' ? navigator.platform : '';

function useSidePanelTabType(tabId: string, sidePanelOpenTabs: Map<string, SidePanelTab>): SidePanelTab | null {
  return sidePanelOpenTabs.get(tabId) ?? null;
}

function useSidePanelLiveSnapshotForTab(tabId: string, subscribe: boolean) {
  const getSnapshot = useCallback(
    () => getSidePanelLiveSnapshot(subscribe),
    [subscribe],
  );
  return useSyncExternalStore(
    (listener) => subscribeSidePanelLiveSnapshot(subscribe, listener),
    getSnapshot,
    getSnapshot,
  );
}

function SidePanelSftpSlotInner({
  tabId,
  ctx,
}: {
  tabId: string;
  ctx: SidePanelStableContext;
}) {
  const isTabActive = useIsTabActive(tabId);
  const sidePanelOpenTabs = ctx.sidePanelOpenTabs as Map<string, SidePanelTab>;
  const sidePanelTab = useSidePanelTabType(tabId, sidePanelOpenTabs);
  const isVisible = isTabActive && sidePanelTab === 'sftp';
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
          activeTerminalSessionIdForSftp: live.activeTerminalSessionIdForSftp,
          focusedSessionId: live.focusedSessionId,
        }),
        location,
      );
    },
    [handleSftpCurrentPathChange, live.activeTerminalSessionIdForSftp, live.focusedSessionId, tabId],
  );

  const handleActiveTransfersChange = useCallback(
    (count: number) => {
      handleSftpActiveTransfersChange(tabId, count);
    },
    [handleSftpActiveTransfersChange, tabId],
  );

  return (
    <div className={sidePanelHiddenPanelClassName(!isVisible)}>
      <SftpSidePanel
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
        activeSessionId={isVisible ? live.activeTerminalSessionIdForSftp : null}
        initialLocation={isVisible ? (sftpInitialLocationForTab.get(tabId) ?? null) : null}
        onInitialLocationApplied={handleInitialLocationApplied}
        onCurrentPathChange={handleCurrentPathChange}
        onActiveTransfersChange={handleActiveTransfersChange}
        showWorkspaceHostHeader={isVisible && !!live.activeWorkspace}
        isVisible={isVisible}
        renderOverlays={isVisible}
        pendingUpload={sftpPendingUploadsForTab.get(tabId) ?? null}
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

function SidePanelSystemSlotInner({
  tabId,
  ctx,
}: {
  tabId: string;
  ctx: SidePanelStableContext;
}) {
  const isTabActive = useIsTabActive(tabId);
  const sidePanelOpenTabs = ctx.sidePanelOpenTabs as Map<string, SidePanelTab>;
  const sidePanelTab = useSidePanelTabType(tabId, sidePanelOpenTabs);
  const panelSelected = sidePanelTab === 'system';
  const isVisible = isTabActive && panelSelected;
  const sessions = ctx.sessions as TerminalSession[];
  const sessionHostsMap = ctx.sessionHostsMap as Map<string, Host>;
  const workspace = (ctx.workspaceById as Map<string, Workspace>).get(tabId);
  const standaloneSession = sessions.find((session) => session.id === tabId);
  const systemSession = resolveSystemSidebarSession(
    sessions,
    workspace,
    workspace?.focusedSessionId,
    standaloneSession,
  );
  const systemHost = systemSession ? sessionHostsMap.get(systemSession.id) ?? null : null;
  const keepSystemWorkActive = panelSelected
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
}: {
  tabId: string;
  ctx: SidePanelStableContext;
}) {
  const isTabActive = useIsTabActive(tabId);
  const sidePanelOpenTabs = ctx.sidePanelOpenTabs as Map<string, SidePanelTab>;
  const sidePanelTab = useSidePanelTabType(tabId, sidePanelOpenTabs);
  const isVisible = isTabActive && sidePanelTab === 'scripts';
  const live = useSidePanelLiveSnapshotForTab(tabId, isVisible);

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
    scriptRuns,
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
        runs={scriptRuns}
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
}: {
  tabId: string;
  ctx: SidePanelStableContext;
}) {
  const isTabActive = useIsTabActive(tabId);
  const sidePanelOpenTabs = ctx.sidePanelOpenTabs as Map<string, SidePanelTab>;
  const sidePanelTab = useSidePanelTabType(tabId, sidePanelOpenTabs);
  const isVisible = isTabActive && sidePanelTab === 'theme';
  const live = useSidePanelLiveSnapshotForTab(tabId, isTabActive);

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
}: {
  tabId: string;
  ctx: SidePanelStableContext;
}) {
  const isTabActive = useIsTabActive(tabId);
  const sidePanelOpenTabs = ctx.sidePanelOpenTabs as Map<string, SidePanelTab>;
  const sidePanelTab = useSidePanelTabType(tabId, sidePanelOpenTabs);
  const isVisible = isTabActive && sidePanelTab === 'notes';
  const openNoteRequest = (ctx.notesOpenNoteByTab as Map<string, { noteId: string; requestId: number }>).get(tabId) ?? null;

  const {
    NotesManager,
    notes,
    noteGroups,
    hosts,
    updateNotes,
    updateNoteGroups,
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
        openNoteId={openNoteRequest?.noteId ?? null}
        openNoteRequestId={openNoteRequest?.requestId ?? null}
      />
    </div>
  );
}

export const SidePanelNotesSlot = memo(SidePanelNotesSlotInner);
SidePanelNotesSlot.displayName = 'SidePanelNotesSlot';

function SidePanelHistorySlotInner({ ctx }: { ctx: SidePanelStableContext }) {
  const activeTabId = useSyncExternalStore(
    activeTabStore.subscribe,
    activeTabStore.getActiveTabId,
    activeTabStore.getActiveTabId,
  );
  const sidePanelOpenTabs = ctx.sidePanelOpenTabs as Map<string, SidePanelTab>;
  const sidePanelTab = activeTabId ? sidePanelOpenTabs.get(activeTabId) ?? null : null;
  const isVisible = sidePanelTab === 'history';
  const live = useSidePanelLiveSnapshotForTab(activeTabId ?? '', isVisible);

  const {
    HistorySidePanel,
    remoteHistory,
    shellHistory,
    handleHistoryPaste,
    handleHistoryRun,
  } = ctx;

  if (!isVisible) return null;

  return (
    <div className="absolute inset-0 z-10">
      <HistorySidePanel
        focusedHost={live.focusedHost}
        focusedSessionId={live.historySessionId}
        state={remoteHistory.getState(live.focusedHost?.id, live.historySessionId)}
        globalEntries={shellHistory}
        onFetch={remoteHistory.fetch}
        onPasteToTerminal={handleHistoryPaste}
        onRunInTerminal={handleHistoryRun}
        isVisible
      />
    </div>
  );
}

export const SidePanelHistorySlot = memo(SidePanelHistorySlotInner);
SidePanelHistorySlot.displayName = 'SidePanelHistorySlot';

function SidePanelAiSlotInner({ ctx }: { ctx: SidePanelStableContext }) {
  const activeTabId = useSyncExternalStore(
    activeTabStore.subscribe,
    activeTabStore.getActiveTabId,
    activeTabStore.getActiveTabId,
  );
  const sidePanelOpenTabs = ctx.sidePanelOpenTabs as Map<string, SidePanelTab>;
  const activeSidePanelTab = activeTabId ? sidePanelOpenTabs.get(activeTabId) ?? null : null;

  const {
    AIChatPanelsHost,
    AISidePanelStateRoot,
    mountedAiTabIds,
    aiContextsByTabId,
    resolveAIExecutorContext,
    pendingTerminalSelectionForAI,
    handlePendingTerminalSelectionConsumed,
    notes,
    hosts,
    snippets,
    onOpenVaultNoteFromChat,
    onOpenVaultHostFromChat,
    onOpenVaultSectionFromChat,
    onOpenVaultSnippetFromChat,
    validAIScopeTargetIds,
  } = ctx;

  if (mountedAiTabIds.length === 0) return null;
  if (AI_PANEL_FORCE_HIDE_SHELL && activeSidePanelTab === 'ai') return null;

  return (
    <AISidePanelStateRoot validAIScopeTargetIds={validAIScopeTargetIds}>
      <AIChatPanelsHost
        mountedTabIds={mountedAiTabIds}
        activeTabId={activeTabId}
        activeSidePanelTab={activeSidePanelTab}
        contextsByTabId={aiContextsByTabId}
        resolveExecutorContext={resolveAIExecutorContext}
        pendingTerminalSelection={pendingTerminalSelectionForAI}
        onPendingTerminalSelectionConsumed={handlePendingTerminalSelectionConsumed}
        notes={notes}
        hosts={hosts}
        snippets={snippets}
        onOpenVaultNoteFromChat={onOpenVaultNoteFromChat}
        onOpenVaultHostFromChat={onOpenVaultHostFromChat}
        onOpenVaultSectionFromChat={onOpenVaultSectionFromChat}
        onOpenVaultSnippetFromChat={onOpenVaultSnippetFromChat}
      />
    </AISidePanelStateRoot>
  );
}

export const SidePanelAiSlot = memo(SidePanelAiSlotInner);
SidePanelAiSlot.displayName = 'SidePanelAiSlot';

export function SidePanelMountedContent({ ctx }: { ctx: SidePanelStableContext }) {
  const {
    mountedSftpTabIds,
    systemMountedTabIds,
    scriptsMountedTabIds,
    themeMountedTabIds,
    notesMountedTabIds,
  } = ctx;

  return (
    <>
      {mountedSftpTabIds.map((tabId: string) => (
        <SidePanelSftpSlot key={tabId} tabId={tabId} ctx={ctx} />
      ))}
      {systemMountedTabIds.map((tabId: string) => (
        <SidePanelSystemSlot key={`system-${tabId}`} tabId={tabId} ctx={ctx} />
      ))}
      {scriptsMountedTabIds.map((tabId: string) => (
        <SidePanelScriptsSlot key={`scripts-${tabId}`} tabId={tabId} ctx={ctx} />
      ))}
      <SidePanelHistorySlot ctx={ctx} />
      {themeMountedTabIds.map((tabId: string) => (
        <SidePanelThemeSlot key={`theme-${tabId}`} tabId={tabId} ctx={ctx} />
      ))}
      {notesMountedTabIds.map((tabId: string) => (
        <SidePanelNotesSlot key={`notes-${tabId}`} tabId={tabId} ctx={ctx} />
      ))}
      <SidePanelAiSlot ctx={ctx} />
    </>
  );
}
