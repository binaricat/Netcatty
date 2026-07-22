/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { Suspense, lazy, useCallback, useEffect, useMemo } from 'react';
import { AlertTriangle, Download, Trash2 } from 'lucide-react';
import { activeTabStore, toEditorTabId, useActiveTabId, useIsEditorTabActive } from '../state/activeTabStore';
import { editorTabStore } from '../state/editorTabStore';
import { releaseEditorTabSaveCoordinator, saveEditorTab } from '../state/editorTabSave';
import { useTerminalHostTreeLayoutWidth } from '../state/terminalHostTreeStore';
import { TopTabs } from '../../components/TopTabs';
import { VaultView } from '../../components/VaultView';
import { QuickAddSnippetDialog } from '../../components/QuickAddSnippetDialog';
import { QuickScriptEditorDialog } from '../../components/scripts/QuickScriptEditorDialog';
import { AddToWorkspaceDialog } from '../../components/workspace/AddToWorkspaceDialog';
import { KeyboardInteractiveModal } from '../../components/KeyboardInteractiveModal';
import { PassphraseModal } from '../../components/PassphraseModal';
import { UnsavedChangesProvider } from '../../components/editor/UnsavedChangesDialog';
import { SnippetExecutionProvider } from '../../components/SnippetExecutionProvider';
import { Button } from '../../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { LazyLoadBoundary } from '../../components/ui/lazy-load-boundary';
import { toast } from '../../components/ui/toast';
import { AppHostTreeLayer } from './AppHostTreeLayer';
import { AppHostEditorLayer } from './AppHostEditorLayer';
import { getUiThemeById } from '../../infrastructure/config/uiThemes';
import { buildAppThemeCssVars } from '../state/settingsStateDefaults';
import { useMainWindowInputFocusRecovery } from '../state/useMainWindowInputFocusRecovery';
import { useExternalMcpToggleState } from '../state/useExternalMcpToggleState';
import { PluginContributionHost } from '../../components/plugins/PluginContributionHost';
import { resolveActivePluginKeybindingContext } from '../state/pluginContributionContexts';
import { selectPluginThemeTokens } from '../state/pluginContributionEnvironment';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
import { pluginViewTabStore, usePluginViewTabs } from '../state/pluginViewTabStore';
import { buildPluginSettingScopeCatalog } from '../state/usePluginSettingScopeCatalog';
import { useWorkSurfaceHostEditor } from '../state/useWorkSurfaceHostEditor';
import { isHostTreeWorkTabSurface } from './workTabSurface';

const LazyProtocolSelectDialog = lazy(() => import('../../components/ProtocolSelectDialog'));
const LazyQuickSwitcher = lazy(() =>
  import('../../components/QuickSwitcher').then((m) => ({ default: m.QuickSwitcher })),
);
const LazyCreateWorkspaceDialog = lazy(() =>
  import('../../components/CreateWorkspaceDialog').then((m) => ({ default: m.CreateWorkspaceDialog })),
);
const LazyTextEditorTabView = lazy(() =>
  import('../../components/editor/TextEditorTabView').then((m) => ({ default: m.TextEditorTabView })),
);

const TextEditorTabFallback = ({ tabId }: { tabId: string }) => {
  const isVisible = useIsEditorTabActive(tabId);
  const hostTreeLayoutWidth = useTerminalHostTreeLayoutWidth();
  return (
    <div
      style={{
        ...(isVisible ? null : { pointerEvents: 'none', visibility: 'hidden' }),
        zIndex: 20,
        left: hostTreeLayoutWidth,
      }}
      className="netcatty-lazy-fade-in absolute top-0 right-0 bottom-0 min-h-0 flex flex-col bg-background"
      aria-hidden="true"
    />
  );
};

type AppViewContext = Record<string, any>;

export function AppView({ ctx }: { ctx: AppViewContext }) {
  const activeTabId = useActiveTabId();
  const pluginViewTabs = usePluginViewTabs();
  const {
    resetSessionRename,
    resetWorkspaceRename,
    setAddToWorkspaceDialog,
    setIsCreateWorkspaceOpen,
    setIsQuickSwitcherOpen,
    setProtocolSelectHost,
    setQuickSearch,
  } = ctx;

  const dismissTransientOverlays = useCallback(() => {
    setIsQuickSwitcherOpen(false);
    setQuickSearch('');
    setIsCreateWorkspaceOpen(false);
    setProtocolSelectHost(null);
    setAddToWorkspaceDialog(null);
    resetSessionRename();
    resetWorkspaceRename();
  }, [
    resetSessionRename,
    resetWorkspaceRename,
    setAddToWorkspaceDialog,
    setIsCreateWorkspaceOpen,
    setIsQuickSwitcherOpen,
    setProtocolSelectHost,
    setQuickSearch,
  ]);

  useMainWindowInputFocusRecovery({ onPageHidden: dismissTransientOverlays });

  const {
    accentMode, addShellHistoryEntry, addSessionToWorkspace, addToWorkspaceDialog, appendHostToWorkspace, appendLocalTerminalToWorkspace,
    clearAndRemoveSource, clearAndRemoveSources, clearUnsavedConnectionLogs, closeLogView, closeSession, closeTabsBatch, closeWorkspace, copySessionToNewWindowWithCurrentShell, copySessionWithCurrentShell,
    connectionLogs, convertKnownHostToHost, createWorkspaceFromSessions, createWorkspaceFromTargets, createWorkspaceWithHosts, customAccent,
    customGroups, currentTerminalTheme, deepLinkHostDraft, deleteConnectionLog, draggingSessionId, effectiveKnownHosts, editorTabs, editorWordWrap, emptyVaultConflict,
    followAppTerminalTheme,
    groupConfigs, handleAddKnownHost, handleConnectSerial, handleConnectToHost, handleCreateLocalTerminal, handleDefaultTerminalThemeChange, handleDeleteHost,
    handleEndSessionDrag, handleFollowAppTerminalThemeChange, handleHostConnectWithProtocolCheck, handleHotkeyAction, handleKeyboardInteractiveCancel, handleKeyboardInteractiveSubmit,
    handleOpenHostFromVaultNote, handleOpenQuickSwitcher, handleOpenSettings, handleOpenVaultHostFromChat, handleOpenVaultNoteFromChat, handleOpenVaultSectionFromChat, handleOpenVaultSnippetFromChat, handleRootContextMenu, handlePassphraseCancel, handlePassphraseSkip, handlePassphraseSubmit, handleProtocolSelect,
    handleRequestCloseEditorTabRef, handleSessionStatusChange, handleSyncNowManual, handleTerminalDataCapture, handleToggleTheme, handleUpdateHostFromTerminal,
    hostById, hosts, terminalHosts, updateTerminalHosts, hotkeyScheme, identities, importOrReuseKey, isBroadcastEnabled, isCreateWorkspaceOpen, isMacClient, isQuickSwitcherOpen,
    keyBindings, keyboardInteractiveQueue, keys, logViews, managedSources, navigateToSection, noteGroups, notes, openLogView, openNoteRequest, orderedTabsWithEditors, orphanSessions,
    passphraseQueue, protocolSelectHost, proxyProfiles, portForwardingRules, quickResults, quickSearch, removeSessionFromWorkspace, reorderWorkTabs, reorderWorkspaceSessions,
    resolveEmptyVaultConflict, resolvedTheme, resolveSessionAppearance, runSnippet, sessionLogsDir, sessionLogsEnabled, sessionLogsFormat, sessionLogsTimestampsEnabled, sessionRenameTarget, sshDebugLogsEnabled,
    sessionRenameValue, sessions, setActiveTabId, setDeepLinkHostDraft, setDraggingSessionId, setEditorWordWrap,
    setNavigateToSection, setSessionRenameValue, setTerminalFontFamilyId, setTerminalFontSize, setVaultFocusRequest, updateSessionFontSize, updateSessionRestoreCwd, updateSessionDynamicTitle, updateSessionCodingCliProvider, clearSessionFontSizeOverride,
    setWorkspaceFocusedSession, setWorkspaceRenameValue, settings, sftpAutoOpenSidebar, sftpFollowTerminalCwd, setSftpFollowTerminalCwd, sftpAutoSync, sftpDefaultViewMode, sftpDoubleClickBehavior,
    sftpShowHiddenFiles, sftpUseCompressedUpload, shellHistory, snippetPackages, snippets, splitSessionWithCurrentShell, startSessionRename,
    startWorkspaceRename, submitSessionRename, submitWorkspaceRename, t, terminalFontFamilyId, terminalFontSize, terminalSettings, terminalThemeId, themeById,
    toggleBroadcast, toggleConnectionLogSaved, toggleScriptsSidePanelRef, toggleSidePanelRef, toggleWorkspaceViewMode, unmanageSource, updateConnectionLog,
    updateCustomGroups, updateGroupConfigs, updateHostDistro, updateHosts, updateIdentities, updateKeys, updateKnownHosts, updateManagedSources,
    updateNoteGroups, updateNotes, updateProxyProfiles, updateSnippetPackages, updateSnippets, updateSplitSizes, updateTerminalSetting, vaultFocusRequest, workspaceRenameTarget, workspaceRenameValue, workspaces,
    VaultViewContainer, SftpViewMount, TerminalLayerMount, LogViewWrapper,
  } = ctx;

  const appThemeStyle = useMemo(() => {
    const tokens = getUiThemeById(
      resolvedTheme,
      resolvedTheme === 'dark' ? settings.darkUiThemeId : settings.lightUiThemeId,
    ).tokens;
    return {
      ...buildAppThemeCssVars(tokens, accentMode, customAccent),
      colorScheme: resolvedTheme,
    } as React.CSSProperties;
  }, [accentMode, customAccent, resolvedTheme, settings.darkUiThemeId, settings.lightUiThemeId]);

  const pluginKeybindingContext = useMemo(() => resolveActivePluginKeybindingContext({
    activeTabId,
    sessions,
    workspaces,
  }), [activeTabId, sessions, workspaces]);
  const pluginThemeTokens = useMemo(
    () => selectPluginThemeTokens(appThemeStyle as Record<string, unknown>),
    [appThemeStyle],
  );
  const isPeerSessionWindow = typeof window !== 'undefined'
    && window.location.hash.startsWith('#/session-window');
  const externalMcpToggle = useExternalMcpToggleState();
  const handleWorkSurfaceHostSaved = useCallback((mode: 'new' | 'edit') => {
    if (mode === 'edit') {
      toast.success(t('terminal.layer.hostTree.hostSavedNextConnection'));
    }
  }, [t]);
  const workSurfaceHostEditor = useWorkSurfaceHostEditor({
    hosts,
    onUpdateHosts: updateHosts,
    onSaved: handleWorkSurfaceHostSaved,
  });
  const workSurfaceVisible = useMemo(() => isHostTreeWorkTabSurface({
    enabled: true,
    activeTabId,
    logViewIds: new Set(logViews.map((logView: { id: string }) => logView.id)),
    orderedTabs: orderedTabsWithEditors,
    sessionIds: new Set(sessions.map((session: { id: string }) => session.id)),
    workspaceIds: new Set(workspaces.map((workspace: { id: string }) => workspace.id)),
  }), [activeTabId, logViews, orderedTabsWithEditors, sessions, workspaces]);
  const handleCreateWorkSurfaceHostGroup = useCallback((groupPath: string) => {
    updateCustomGroups(Array.from(new Set([...customGroups, groupPath])));
  }, [customGroups, updateCustomGroups]);

  const closePluginViewTab = useCallback((tabId: string) => {
    const index = orderedTabsWithEditors.indexOf(tabId);
    if (activeTabStore.getActiveTabId() === tabId) {
      const next = orderedTabsWithEditors[index - 1] ?? orderedTabsWithEditors[index + 1] ?? 'vault';
      activeTabStore.setActiveTabId(next === tabId ? 'vault' : next);
    }
    pluginViewTabStore.close(tabId);
  }, [orderedTabsWithEditors]);

  useEffect(() => {
    const catalog = buildPluginSettingScopeCatalog({
      hosts,
      workspaces,
      sessions,
      deviceLabel: t('settings.plugins.thisDevice'),
    });
    void netcattyBridge.get()?.setPluginScopeCatalog?.(catalog).catch(() => {});
  }, [hosts, sessions, t, workspaces]);

  return (
    <SnippetExecutionProvider>
    <UnsavedChangesProvider>
      {({ prompt }) => {
        // Helper: close an editor tab and activate the neighbor (left-preference), or vault.
        const closeEditorAndActivateNeighbor = (id: string) => {
          const closingTabId = toEditorTabId(id);
          const list = orderedTabsWithEditors;
          const idx = list.indexOf(closingTabId);
          releaseEditorTabSaveCoordinator(id);
          editorTabStore.close(id);
          if (activeTabStore.getActiveTabId() !== closingTabId) return;
          const next = list[idx - 1] ?? list[idx + 1] ?? 'vault';
          activeTabStore.setActiveTabId(next === closingTabId ? 'vault' : next);
        };

        // Real dirty-confirm close handler.
        const handleRequestCloseEditorTab = async (id: string): Promise<boolean> => {
          const tab = editorTabStore.getTab(id);
          if (!tab) return false;
          const dirty = tab.content !== tab.baselineContent;
          if (!dirty) {
            closeEditorAndActivateNeighbor(id);
            return true;
          }
          const choice = await prompt(tab.fileName);
          if (choice === 'cancel') return false;
          if (choice === 'discard') {
            closeEditorAndActivateNeighbor(id);
            return true;
          }
          if (choice === 'save') {
            const ok = await saveEditorTab(id);
            if (!ok) {
              const msg = editorTabStore.getTab(id)?.saveError ?? 'Save failed';
              toast.error(msg, 'SFTP');
              return false;
            }
            const latest = editorTabStore.getTab(id);
            if (!latest || latest.content !== latest.baselineContent) return false;
            closeEditorAndActivateNeighbor(id);
            return true;
          }

          return false;
        };

        // Expose to the hotkey dispatcher (Cmd/Ctrl+W).
        handleRequestCloseEditorTabRef.current = handleRequestCloseEditorTab;

        return (
    <div className="flex flex-col h-screen text-foreground font-sans netcatty-shell" data-terminal-appearance-root onContextMenu={handleRootContextMenu}>
      <TopTabs
        theme={resolvedTheme}
        hosts={hosts}
        sessions={sessions}
        orphanSessions={orphanSessions}
        workspaces={workspaces}
        logViews={logViews}
        orderedTabs={orderedTabsWithEditors}
        draggingSessionId={draggingSessionId}
        isMacClient={isMacClient}
        onCloseSession={closeSession}
        onRenameSession={startSessionRename}
        onCopySession={copySessionWithCurrentShell}
        onCopySessionToNewWindow={copySessionToNewWindowWithCurrentShell}
        onRenameWorkspace={startWorkspaceRename}
        onCloseWorkspace={closeWorkspace}
        onCloseLogView={closeLogView}
        onCloseTabsBatch={closeTabsBatch}
        onOpenQuickSwitcher={handleOpenQuickSwitcher}
        onToggleTheme={handleToggleTheme}
        onOpenSettings={handleOpenSettings}
        externalMcpEnabled={externalMcpToggle.enabled}
        onToggleExternalMcp={externalMcpToggle.setEnabled}
        showExternalMcpToggle={!isPeerSessionWindow}
        windowOpacity={settings.windowOpacity}
        setWindowOpacity={settings.setWindowOpacity}
        onSyncNow={handleSyncNowManual}
        onStartSessionDrag={setDraggingSessionId}
        onEndSessionDrag={handleEndSessionDrag}
        onReorderTabs={reorderWorkTabs}
        onRemoveSessionFromWorkspace={removeSessionFromWorkspace}
        showSftpTab={settings.showSftpTab}
        showHostTreeSidebar={settings.showHostTreeSidebar}
        dynamicTabTitleMode={settings.terminalSettings.dynamicTabTitleMode}
        editorTabs={editorTabs}
        pluginViewTabs={pluginViewTabs}
        onClosePluginViewTab={closePluginViewTab}
        onRequestCloseEditorTab={handleRequestCloseEditorTab}
        hostById={hostById}
      />

      <div className="flex-1 relative min-h-0">
        <AppHostTreeLayer
          enabled={settings.showHostTreeSidebar}
          hosts={hosts}
          customGroups={customGroups}
          groupConfigs={groupConfigs}
          sessions={sessions}
          workspaces={workspaces}
          editorTabs={editorTabs}
          logViews={logViews}
          orderedTabs={orderedTabsWithEditors}
          accentMode={accentMode}
          currentTerminalTheme={currentTerminalTheme}
          customAccent={customAccent}
          followAppTerminalTheme={followAppTerminalTheme}
          hostById={hostById}
          themeById={themeById}
          resolveSessionAppearance={resolveSessionAppearance}
          onConnect={handleConnectToHost}
          onNewHost={workSurfaceHostEditor.openNew}
          onEditHost={workSurfaceHostEditor.openEdit}
          onCreateLocalTerminal={handleCreateLocalTerminal}
        />
        <AppHostEditorLayer
          surfaceVisible={workSurfaceVisible}
          target={workSurfaceHostEditor.target}
          editorKey={workSurfaceHostEditor.editorKey}
          hosts={hosts}
          customGroups={customGroups}
          groupConfigs={groupConfigs}
          keys={keys}
          identities={identities}
          proxyProfiles={proxyProfiles}
          managedSources={managedSources}
          snippets={snippets}
          terminalThemeId={terminalThemeId}
          terminalFontSize={terminalFontSize}
          onSave={workSurfaceHostEditor.save}
          onCancel={workSurfaceHostEditor.close}
          onCreateGroup={handleCreateWorkSurfaceHostGroup}
          onImportOrReuseKey={importOrReuseKey}
          onUpdateSnippets={updateSnippets}
        />

        <VaultViewContainer appThemeStyle={appThemeStyle}>
          <VaultView
            hosts={hosts}
            keys={keys}
            identities={identities}
            proxyProfiles={proxyProfiles}
            snippets={snippets}
            snippetPackages={snippetPackages}
            notes={notes}
            noteGroups={noteGroups}
            customGroups={customGroups}
            knownHosts={effectiveKnownHosts}
            shellHistory={shellHistory}
            connectionLogs={connectionLogs}
            managedSources={managedSources}
            sessionCount={sessions.filter((s) => !s.hiddenFromTabs).length}
            hotkeyScheme={hotkeyScheme}
            keyBindings={keyBindings}
            terminalThemeId={terminalThemeId}
            terminalFontSize={terminalFontSize}
            onOpenSettings={handleOpenSettings}
            onOpenQuickSwitcher={handleOpenQuickSwitcher}
            onCreateLocalTerminal={handleCreateLocalTerminal}
            onConnectSerial={handleConnectSerial}
            onDeleteHost={handleDeleteHost}
            onConnect={handleConnectToHost}
            onOpenHostFromNote={handleOpenHostFromVaultNote}
            groupConfigs={groupConfigs}
            onUpdateGroupConfigs={updateGroupConfigs}
            onUpdateHosts={updateHosts}
            onUpdateKeys={updateKeys}
            onImportOrReuseKey={importOrReuseKey}
            onUpdateIdentities={updateIdentities}
            onUpdateProxyProfiles={updateProxyProfiles}
            onUpdateSnippets={updateSnippets}
            onUpdateSnippetPackages={updateSnippetPackages}
            onUpdateNotes={updateNotes}
            onUpdateNoteGroups={updateNoteGroups}
            onUpdateCustomGroups={updateCustomGroups}
            onUpdateKnownHosts={updateKnownHosts}
            onUpdateManagedSources={updateManagedSources}
            onClearAndRemoveManagedSource={clearAndRemoveSource}
            onClearAndRemoveManagedSources={clearAndRemoveSources}
            onUnmanageSource={unmanageSource}
            onConvertKnownHost={convertKnownHostToHost}
            onToggleConnectionLogSaved={toggleConnectionLogSaved}
            onDeleteConnectionLog={deleteConnectionLog}
            onClearUnsavedConnectionLogs={clearUnsavedConnectionLogs}
            onRunSnippet={runSnippet}
            onOpenLogView={openLogView}
            showRecentHosts={settings.showRecentHosts}
            hostClickBehavior={settings.hostClickBehavior}
            showOnlyUngroupedHostsInRoot={settings.showOnlyUngroupedHostsInRoot}
            navigateToSection={navigateToSection}
            onNavigateToSectionHandled={() => setNavigateToSection(null)}
            deepLinkHostDraft={deepLinkHostDraft}
            onDeepLinkHostDraftHandled={() => setDeepLinkHostDraft(null)}
            vaultFocusRequest={vaultFocusRequest}
            onVaultFocusRequestHandled={() => setVaultFocusRequest(null)}
            terminalSettings={terminalSettings}
          />
        </VaultViewContainer>

        <SftpViewMount
          hosts={terminalHosts}
          writableHosts={hosts}
          sessions={sessions}
          keys={keys}
          identities={identities}
          knownHosts={effectiveKnownHosts}
          proxyProfiles={proxyProfiles}
          groupConfigs={groupConfigs}
          updateHosts={updateTerminalHosts}
          onAddKnownHost={handleAddKnownHost}
          sftpDefaultViewMode={sftpDefaultViewMode}
          sftpDoubleClickBehavior={sftpDoubleClickBehavior}
          sftpAutoSync={sftpAutoSync}
          sftpShowHiddenFiles={sftpShowHiddenFiles}
          sftpUseCompressedUpload={sftpUseCompressedUpload}
          hotkeyScheme={hotkeyScheme}
          keyBindings={keyBindings}
          editorWordWrap={editorWordWrap}
          setEditorWordWrap={setEditorWordWrap}
          terminalSettings={terminalSettings}
        />

        <TerminalLayerMount
          hosts={terminalHosts}
          portForwardingRules={portForwardingRules}
          customGroups={customGroups}
          groupConfigs={groupConfigs}
          proxyProfiles={proxyProfiles}
          keys={keys}
          identities={identities}
          snippets={snippets}
          snippetPackages={snippetPackages}
          notes={notes}
          noteGroups={noteGroups}
          sessions={sessions}
          workspaces={workspaces}
          knownHosts={effectiveKnownHosts}
          draggingSessionId={draggingSessionId}
          terminalTheme={currentTerminalTheme}
          terminalThemeId={terminalThemeId}
          followAppTerminalTheme={followAppTerminalTheme}
          pickTerminalTheme={ctx.pickTerminalTheme}
          clearThemeIntent={ctx.clearThemeIntent}
          settleManualThemeIntent={ctx.settleManualThemeIntent}
          resolveSessionAppearance={ctx.resolveSessionAppearance}
          accentMode={accentMode}
          customAccent={customAccent}
          terminalSettings={terminalSettings}
          terminalFontFamilyId={terminalFontFamilyId}
          fontSize={terminalFontSize}
          hotkeyScheme={hotkeyScheme}
          disableTerminalFontZoom={settings.disableTerminalFontZoom}
          restoreTerminalCwd={settings.restoreTerminalCwd}
          keyBindings={keyBindings}
          onHotkeyAction={handleHotkeyAction}
          onUpdateTerminalThemeId={handleDefaultTerminalThemeChange}
          onUpdateFollowAppTerminalThemeId={handleFollowAppTerminalThemeChange}
          onUpdateTerminalFontFamilyId={setTerminalFontFamilyId}
          onUpdateTerminalFontSize={setTerminalFontSize}
          onUpdateSessionFontSize={updateSessionFontSize}
          onUpdateSessionRestoreCwd={updateSessionRestoreCwd}
          onUpdateSessionDynamicTitle={updateSessionDynamicTitle}
          onUpdateSessionCodingCliProvider={updateSessionCodingCliProvider}
          onClearSessionFontSizeOverride={clearSessionFontSizeOverride}
          onUpdateTerminalFontWeight={(w) => updateTerminalSetting('fontWeight', w)}
          onCloseSession={closeSession}
          onUpdateSessionStatus={handleSessionStatusChange}
          onUpdateHostDistro={updateHostDistro}
          onUpdateHost={handleUpdateHostFromTerminal}
          onAddKnownHost={handleAddKnownHost}
          onCommandExecuted={(command, hostId, hostLabel, sessionId) => {
            addShellHistoryEntry({ command, hostId, hostLabel, sessionId });
          }}
          shellHistory={shellHistory}
          onTerminalDataCapture={handleTerminalDataCapture}
          onCreateWorkspaceFromSessions={createWorkspaceFromSessions}
          onAddSessionToWorkspace={addSessionToWorkspace}
          onRequestAddToWorkspace={(workspaceId) =>
            setAddToWorkspaceDialog({ mode: 'append', workspaceId })
          }
          onUpdateSplitSizes={updateSplitSizes}
          onSetDraggingSessionId={setDraggingSessionId}
          onToggleWorkspaceViewMode={toggleWorkspaceViewMode}
          onSetWorkspaceFocusedSession={setWorkspaceFocusedSession}
          onReorderWorkspaceSessions={reorderWorkspaceSessions}
          onReorderTabs={reorderWorkTabs}
          onCopySession={copySessionWithCurrentShell}
          onCopySessionToNewWindow={copySessionToNewWindowWithCurrentShell}
          onSplitSession={splitSessionWithCurrentShell}
          onConnectToHost={handleConnectToHost}
          openNoteRequest={openNoteRequest}
          onOpenVaultNoteFromChat={handleOpenVaultNoteFromChat}
          onOpenVaultHostFromChat={handleOpenVaultHostFromChat}
          onOpenVaultSectionFromChat={handleOpenVaultSectionFromChat}
          onOpenVaultSnippetFromChat={handleOpenVaultSnippetFromChat}
          onCreateLocalTerminal={handleCreateLocalTerminal}
          isBroadcastEnabled={isBroadcastEnabled}
          onToggleBroadcast={toggleBroadcast}
          updateHosts={updateTerminalHosts}
          updateSnippets={updateSnippets}
          updateSnippetPackages={updateSnippetPackages}
          updateNotes={updateNotes}
          updateNoteGroups={updateNoteGroups}
          sftpDefaultViewMode={sftpDefaultViewMode}
          sftpDoubleClickBehavior={sftpDoubleClickBehavior}
          sftpAutoSync={sftpAutoSync}
          sftpShowHiddenFiles={sftpShowHiddenFiles}
          sftpUseCompressedUpload={sftpUseCompressedUpload}
          sftpAutoOpenSidebar={sftpAutoOpenSidebar}
          terminalSidePanelAutoOpen={settings.terminalSidePanelAutoOpen}
          terminalSidePanelAutoOpenTab={settings.terminalSidePanelAutoOpenTab}
          sftpFollowTerminalCwd={sftpFollowTerminalCwd}
          setSftpFollowTerminalCwd={setSftpFollowTerminalCwd}
          editorWordWrap={editorWordWrap}
          setEditorWordWrap={setEditorWordWrap}
          sessionLogsEnabled={sessionLogsEnabled}
          sessionLogsDir={sessionLogsDir}
          sessionLogsFormat={sessionLogsFormat}
          sessionLogsTimestampsEnabled={sessionLogsTimestampsEnabled}
          sshDebugLogsEnabled={sshDebugLogsEnabled}
          showHostTreeSidebar={settings.showHostTreeSidebar}
          toggleScriptsSidePanelRef={toggleScriptsSidePanelRef}
          toggleSidePanelRef={toggleSidePanelRef}
          onStartSessionRename={startSessionRename}
          onSubmitSessionRename={submitSessionRename}
          onRemoveSessionFromWorkspace={removeSessionFromWorkspace}
        />

        {/* Log Views - readonly terminal replays */}
        {logViews.map(logView => {
          // Get the latest log data from connectionLogs to reflect updates
          const latestLog = connectionLogs.find(l => l.id === logView.connectionLogId) || logView.log;
          return (
            <LogViewWrapper
              key={logView.id}
              logView={{ ...logView, log: latestLog }}
              defaultTerminalTheme={currentTerminalTheme}
              defaultFontSize={terminalFontSize}
              onClose={() => closeLogView(logView.id)}
              onUpdateLog={updateConnectionLog}
            />
          );
        })}

        {/* Editor Tabs — kept mounted for Monaco instance persistence; visibility toggled via CSS */}
        {editorTabs.map((tab) => (
          <LazyLoadBoundary key={tab.id} name="Editor" resetKey={tab.id}>
            <Suspense fallback={<TextEditorTabFallback tabId={tab.id} />}>
              <LazyTextEditorTabView
                tabId={tab.id}
                hotkeyScheme={hotkeyScheme}
                keyBindings={keyBindings}
                hostById={hostById}
                onRequestClose={(id) => handleRequestCloseEditorTabRef.current(id)}
              />
            </Suspense>
          </LazyLoadBoundary>
        ))}

        <PluginContributionHost
          locale={settings.uiLanguage}
          theme={resolvedTheme}
          themeTokens={pluginThemeTokens}
          keybindingContext={pluginKeybindingContext}
        />
      </div>

      {/* Global "quick add / edit snippet" dialog, triggered by the
          netcatty:snippets:add and :edit window events (from ScriptsSidePanel
          "+" button and right-click menu). Delete is handled by a sibling
          useEffect above — it does not need a dialog. */}
      <QuickAddSnippetDialog
        snippets={snippets}
        packages={snippetPackages}
        onCreateSnippet={(snippet) => updateSnippets([...snippets, snippet])}
        onUpdateSnippet={(snippet) =>
          updateSnippets(snippets.map((s) => (s.id === snippet.id ? snippet : s)))
        }
        onCreatePackage={(pkg) =>
          updateSnippetPackages(Array.from(new Set([...snippetPackages, pkg])))
        }
      />
      <QuickScriptEditorDialog
        snippets={snippets}
        packages={snippetPackages}
        hosts={hosts}
        customGroups={customGroups}
        onCreateSnippet={(snippet) => updateSnippets([...snippets, snippet])}
        onUpdateSnippet={(snippet) =>
          updateSnippets(snippets.map((s) => (s.id === snippet.id ? snippet : s)))
        }
        onCreatePackage={(pkg) =>
          updateSnippetPackages(Array.from(new Set([...snippetPackages, pkg])))
        }
        onUpdateHosts={updateHosts}
        onRunSnippet={runSnippet}
      />

      {/* Root-mounted AddToWorkspaceDialog — triggered by the focus-mode
          "+" button (mode='append') or QuickSwitcher's "New Workspace"
          button (mode='create'). Single instance so dialog state and
          styling stay consistent across entry points. */}
      {addToWorkspaceDialog && (
        <AddToWorkspaceDialog
          open
          onOpenChange={(open) => { if (!open) setAddToWorkspaceDialog(null); }}
          // Filter serial hosts only in append mode — appendHostToWorkspace
          // has no serial code path. Create mode goes through
          // createWorkspaceFromTargets, which builds a SerialConfig-backed
          // session for serial hosts, so those should remain pickable.
          hosts={addToWorkspaceDialog.mode === 'append'
            ? hosts.filter((h) => h.protocol !== 'serial')
            : hosts}
          workspaceTitle={
            addToWorkspaceDialog.mode === 'append'
              ? workspaces.find((w) => w.id === addToWorkspaceDialog.workspaceId)?.title
              : 'New Workspace'
          }
          onAdd={(targets) => {
            if (addToWorkspaceDialog.mode === 'append') {
              // Match the workspace root's current split direction so
              // the new panes peer the existing siblings instead of
              // wrapping the whole tree into one side of a fresh split
              // (which would happen if we always passed the helper's
              // default 'vertical').
              const ws = workspaces.find((w) => w.id === addToWorkspaceDialog.workspaceId);
              const rootDir = ws && ws.root.type === 'split' ? ws.root.direction : 'vertical';
              for (const target of targets) {
                if (target.kind === 'local') {
                  appendLocalTerminalToWorkspace(addToWorkspaceDialog.workspaceId, undefined, rootDir);
                } else {
                  appendHostToWorkspace(addToWorkspaceDialog.workspaceId, target.host, rootDir);
                }
              }
            } else {
              createWorkspaceFromTargets(targets);
            }
          }}
        />
      )}

      {isQuickSwitcherOpen && (
        <LazyLoadBoundary name="Quick switcher" resetKey={quickSearch}>
          <Suspense fallback={null}>
            <LazyQuickSwitcher
              isOpen={isQuickSwitcherOpen}
              query={quickSearch}
              results={quickResults}
              sessions={sessions}
              workspaces={workspaces}
              showSftpTab={settings.showSftpTab}
              onQueryChange={setQuickSearch}
              onSelect={handleHostConnectWithProtocolCheck}
              onSelectTab={(tabId) => {
                setActiveTabId(tabId);
                setIsQuickSwitcherOpen(false);
                setQuickSearch('');
              }}
              onCreateLocalTerminal={(shell) => {
                handleCreateLocalTerminal(shell);
                setIsQuickSwitcherOpen(false);
                setQuickSearch('');
              }}
              onCreateWorkspace={() => {
                setIsQuickSwitcherOpen(false);
                setQuickSearch('');
                setAddToWorkspaceDialog({ mode: 'create' });
              }}
              onClose={() => {
                setIsQuickSwitcherOpen(false);
                setQuickSearch('');
              }}
              keyBindings={keyBindings}
              terminalSettings={terminalSettings}
            />
          </Suspense>
        </LazyLoadBoundary>
      )}

      <Dialog open={!!sessionRenameTarget} onOpenChange={(open) => {
        if (!open) {
          resetSessionRename();
        }
      }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('dialog.renameSession.title')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="session-name">{t('field.name')}</Label>
            <Input
              id="session-name"
              value={sessionRenameValue}
              onChange={(e) => setSessionRenameValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitSessionRename(); }}
              autoFocus
              placeholder={t('placeholder.sessionName')}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={resetSessionRename}>{t('common.cancel')}</Button>
            <Button onClick={submitSessionRename} disabled={!sessionRenameValue.trim()}>{t('common.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!workspaceRenameTarget} onOpenChange={(open) => {
        if (!open) {
          resetWorkspaceRename();
        }
      }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('dialog.renameWorkspace.title')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="workspace-name">{t('field.name')}</Label>
            <Input
              id="workspace-name"
              value={workspaceRenameValue}
              onChange={(e) => setWorkspaceRenameValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitWorkspaceRename(); }}
              autoFocus
              placeholder={t('placeholder.workspaceName')}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={resetWorkspaceRename}>{t('common.cancel')}</Button>
            <Button onClick={submitWorkspaceRename} disabled={!workspaceRenameValue.trim()}>{t('common.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {isCreateWorkspaceOpen && (
        <LazyLoadBoundary name="Create workspace" resetKey="create-workspace">
          <Suspense fallback={null}>
            <LazyCreateWorkspaceDialog
              isOpen={isCreateWorkspaceOpen}
              onClose={() => setIsCreateWorkspaceOpen(false)}
              hosts={hosts}
              onCreate={createWorkspaceWithHosts}
            />
          </Suspense>
        </LazyLoadBoundary>
      )}

      {/* Protocol Select Dialog for QuickSwitcher */}
      {protocolSelectHost && (
        <LazyLoadBoundary name="Protocol selector" resetKey={protocolSelectHost.id}>
          <Suspense fallback={null}>
            <LazyProtocolSelectDialog
              host={protocolSelectHost}
              onSelect={handleProtocolSelect}
              onCancel={() => setProtocolSelectHost(null)}
            />
          </Suspense>
        </LazyLoadBoundary>
      )}

      {/* Global Keyboard-Interactive Authentication Modal (2FA/MFA) - processes queue */}
      <KeyboardInteractiveModal
        request={keyboardInteractiveQueue[0] || null}
        onSubmit={handleKeyboardInteractiveSubmit}
        onCancel={handleKeyboardInteractiveCancel}
      />
      {/* Indicator when more 2FA requests are pending */}
      {keyboardInteractiveQueue.length > 1 && (
        <div className="fixed bottom-4 right-4 z-50 bg-muted/90 backdrop-blur-sm text-sm px-3 py-1.5 rounded-full border shadow-sm">
          {keyboardInteractiveQueue.length - 1} more pending
        </div>
      )}

      {/* Global Passphrase Modal for encrypted SSH keys */}
      <PassphraseModal
        request={passphraseQueue[0] || null}
        onSubmit={handlePassphraseSubmit}
        onCancel={handlePassphraseCancel}
        onSkip={handlePassphraseSkip}
      />

      {/* Empty vault vs cloud data confirmation dialog (#679).
          This dialog intentionally cannot be dismissed — the user MUST
          choose "Restore" or "Keep Empty" before the sync flow can
          proceed. hideCloseButton removes the X button, onOpenChange
          is a no-op so ESC also does nothing, and onInteractOutside
          prevents click-away. */}
      <Dialog open={!!emptyVaultConflict} onOpenChange={() => { /* intentionally non-dismissable */ }}>
        <DialogContent className="max-w-md" hideCloseButton onInteractOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-500" />
              {t('sync.autoSync.emptyVaultConflict.title')}
            </DialogTitle>
            <DialogDescription>
              {t('sync.autoSync.emptyVaultConflict.description')}
            </DialogDescription>
          </DialogHeader>
          {emptyVaultConflict && (
            <div className="bg-muted/30 rounded-lg p-3 text-sm">
              <div className="font-medium text-muted-foreground mb-1">{t('sync.autoSync.emptyVaultConflict.cloudLabel')}</div>
              <div>{t('sync.autoSync.emptyVaultConflict.cloudSummary', {
                hosts: emptyVaultConflict.hostCount,
                keys: emptyVaultConflict.keyCount,
                snippets: emptyVaultConflict.snippetCount,
                notes: emptyVaultConflict.noteCount,
                proxyProfiles: emptyVaultConflict.proxyProfileCount,
              })}</div>
            </div>
          )}
          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <Button
              onClick={() => resolveEmptyVaultConflict('restore')}
              className="w-full justify-start gap-2"
            >
              <Download className="w-4 h-4" />
              <span>
                {t('sync.autoSync.emptyVaultConflict.restore')}
                <span className="text-xs opacity-70 ml-1">— {t('sync.autoSync.emptyVaultConflict.restoreDesc')}</span>
              </span>
            </Button>
            <Button
              variant="outline"
              onClick={() => resolveEmptyVaultConflict('keep-empty')}
              className="w-full justify-start gap-2"
            >
              <Trash2 className="w-4 h-4" />
              <span>
                {t('sync.autoSync.emptyVaultConflict.keepEmpty')}
                <span className="text-xs opacity-70 ml-1">— {t('sync.autoSync.emptyVaultConflict.keepEmptyDesc')}</span>
              </span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
        );
      }}
    </UnsavedChangesProvider>
    </SnippetExecutionProvider>
  );
}
