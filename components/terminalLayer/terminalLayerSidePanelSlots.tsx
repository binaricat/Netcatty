/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { memo, useCallback, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { activeTabStore } from '../../application/state/activeTabStore';
import { getSftpCurrentPathMemoryKey } from '../../application/state/sftp/sftpReopenLocation';
import {
  getSidePanelLiveSnapshot,
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
import { shouldKeepTerminalBackgroundWorkActive } from '../../domain/terminalHibernate';
import { resolveTerminalFontFamilyId } from '../../infrastructure/config/fonts';
import type { Host, TerminalSession, Workspace } from '../../types';
import { SystemManagerSidePanel } from '../systemManager/SystemManagerSidePanel';
import { resolveSftpFollowTerminalCwdTargetHost } from '../sftp/sftpFollowTerminalCwd';
import { AI_PANEL_FORCE_HIDE_SHELL } from '../ai/aiPanelDiagnostics';
import type { SidePanelTab } from './TerminalLayerSupport';
import {
  collectSidePanelPanes,
  sidePanelLayoutHasTool,
  type SidePanelLayout,
} from '../../domain/sidePanelLayout';
import { sidePanelHiddenNotesPanelClassName, sidePanelHiddenPanelClassName } from './terminalLayerSidePanelHiddenWrapper';

type SidePanelStableContext = Record<string, any>;
const navigatorPlatform = typeof navigator !== 'undefined' ? navigator.platform : '';
const EMPTY_VAULT_NOTES: never[] = [];
const EMPTY_VAULT_HOSTS: never[] = [];
const EMPTY_VAULT_SNIPPETS: never[] = [];
const EMPTY_SHELL_HISTORY = Object.freeze([]) as readonly never[];
const subscribeShellHistoryNoop = () => () => {};
const getEmptyShellHistorySnapshot = () => EMPTY_SHELL_HISTORY;

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
  isVisible,
}: {
  tabId: string;
  ctx: SidePanelStableContext;
  isVisible: boolean;
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
        focusedSessionId={isVisible ? live.focusedSessionId : null}
        initialLocation={isVisible ? (sftpInitialLocationForTab.get(tabId) ?? null) : null}
        onInitialLocationApplied={handleInitialLocationApplied}
        onCurrentPathChange={handleCurrentPathChange}
        onActiveTransfersChange={handleActiveTransfersChange}
        onActiveExternalEditsChange={handleActiveExternalEditsChange}
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
  const remoteHistory = useRemoteHistoryState();
  // Gate store subscription while History is hidden so command appends do not
  // re-render this retained mount (panel still mounts for fast reopen).
  const shellHistory = useSyncExternalStore(
    isVisible ? subscribeShellHistory : subscribeShellHistoryNoop,
    isVisible ? getShellHistorySnapshot : getEmptyShellHistorySnapshot,
    isVisible ? getShellHistorySnapshot : getEmptyShellHistorySnapshot,
  );

  const {
    HistorySidePanel,
    handleHistoryPaste,
    handleHistoryDelete,
    handleHistoryRun,
  } = ctx;

  if (!isVisible) return null;

  return (
    <div className="absolute inset-0 z-10">
      <HistorySidePanel
        focusedHost={live.focusedHost}
        focusedSessionId={live.historySessionId}
        state={remoteHistory.getState(live.focusedHost?.id, live.historySessionId)}
        globalEntries={shellHistory as import('../../domain/models').ShellHistoryEntry[]}
        onFetch={remoteHistory.fetch}
        onDeleteGlobalEntry={handleHistoryDelete}
        onPasteToTerminal={handleHistoryPaste}
        onRunInTerminal={handleHistoryRun}
        isVisible
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

  // Gate notes subscription while AI is hidden so note edits do not re-render
  // retained AI mounts (panel still mounts for fast reopen).
  const notesSnapshot = useSyncExternalStore(
    isVisible ? subscribeNotes : subscribeNotesNoop,
    isVisible ? getNotesSnapshot : getEmptyNotesSnapshot,
    isVisible ? getNotesSnapshot : getEmptyNotesSnapshot,
  );

  if (mountedAiTabIds.length === 0) return null;
  const activeLayout = activeTabId
    ? (ctx.sidePanelLayouts as Map<string, SidePanelLayout>).get(activeTabId)
    : null;
  if (
    AI_PANEL_FORCE_HIDE_SHELL
    && isVisible
    && (!activeLayout || collectSidePanelPanes(activeLayout.root).length <= 1)
  ) return null;

  // Only the visible AI panel needs vault catalogs for artifact navigation.
  // Hidden retained panels keep session state without re-binding huge hosts/notes.
  const injectVaultCatalog = isVisible;
  const notes = injectVaultCatalog
    ? (notesSnapshot.notes as import('../../domain/models').VaultNote[])
    : EMPTY_VAULT_NOTES;

  return (
    <AISidePanelStateRoot validAIScopeTargetIds={validAIScopeTargetIds}>
      <AIChatPanelsHost
        mountedTabIds={mountedAiTabIds}
        activeTabId={activeTabId}
        activeSidePanelTab={isVisible ? 'ai' : null}
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
      />
    </AISidePanelStateRoot>
  );
}

export const SidePanelAiSlot = memo(SidePanelAiSlotInner);
SidePanelAiSlot.displayName = 'SidePanelAiSlot';

function PersistentSidePanelPortal({
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

  // The React portal always targets the same detached node. Moving that node
  // between a pane host and the hidden parking host preserves the mounted
  // subtree (including active SFTP/AI state) instead of remounting it whenever
  // the focused pane changes.
  React.useLayoutEffect(() => {
    if (!target) return;
    target.appendChild(mountNode);
    return () => {
      if (mountNode.parentNode === target) mountNode.remove();
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
      {mountedSftpTabIds.map((tabId: string) => (
        <PersistentSidePanelPortal
          key={`sftp-${tabId}`}
          portalKey={`sftp-${tabId}`}
          target={portalTarget(tabId, 'sftp')}
        >
          <SidePanelSftpSlot tabId={tabId} ctx={ctx} isVisible={isToolVisible(tabId, 'sftp')} />
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
