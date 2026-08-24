/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Download, Trash2 } from 'lucide-react';
import { activeTabStore, toEditorTabId, useIsEditorTabActive } from '../state/activeTabStore';
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
import { UnsavedChangesProvider, promptUnsavedChanges } from '../../components/editor/UnsavedChangesDialog';
import { SnippetExecutionProvider } from '../../components/SnippetExecutionProvider';
import { Button } from '../../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { LazyLoadBoundary } from '../../components/ui/lazy-load-boundary';
import { toast } from '../../components/ui/toast';
import { AppHostTreeLayer } from './AppHostTreeLayer';
import { AppHostEditorLayer } from './AppHostEditorLayer';
import { AppPluginKeybindingHost } from './AppPluginKeybindingHost';
import { shouldOpenHostEditOnWorkSurface } from './workTabSurface';
import { useConnectionLogsStore } from '../state/connectionLogsStore';
import {
  useSettingsChromeActions,
  useSettingsChromeStore,
} from '../state/settingsChromeStore';
import { getAppAppLockRuntime, useAppLockChrome } from '../state/appRuntimeBridge';
import { useAppThemeStyle } from './useAppThemeStyle';
import { useMainWindowInputFocusRecovery } from '../state/useMainWindowInputFocusRecovery';
import { useExternalMcpToggleState } from '../state/useExternalMcpToggleState';
import { selectPluginThemeTokens } from '../state/pluginContributionEnvironment';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
import { resolveEffectiveTerminalHost } from '../../domain/terminalHostResolution';
import { getAvailablePaneMagnificationController } from '../../domain/paneMagnification';
import { pluginViewTabStore, usePluginViewTabs } from '../state/pluginViewTabStore';
import { buildPluginSettingScopeCatalog } from '../state/usePluginSettingScopeCatalog';
import { useWorkSurfaceHostEditor } from '../state/useWorkSurfaceHostEditor';
import {
  appViewDomainsEqual,
  mergeAppViewDomains,
  type AppViewDomains,
} from './appViewDomains';

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

/** Local draft so keystrokes do not rebuild App chrome domain every character. */
function RenameDraftDialog({
  open,
  inputId,
  initialName,
  title,
  nameLabel,
  placeholder,
  cancelLabel,
  saveLabel,
  onCancel,
  onSave,
}: {
  open: boolean;
  inputId: string;
  initialName: string;
  title: string;
  nameLabel: string;
  placeholder: string;
  cancelLabel: string;
  saveLabel: string;
  onCancel: () => void;
  onSave: (name: string) => void;
}) {
  const [draft, setDraft] = useState(initialName);
  useEffect(() => {
    if (open) setDraft(initialName);
  }, [open, initialName]);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen) onCancel();
    }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2 py-2">
          <Label htmlFor={inputId}>{nameLabel}</Label>
          <Input
            id={inputId}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              if (!draft.trim()) return;
              onSave(draft);
            }}
            autoFocus
            placeholder={placeholder}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>{cancelLabel}</Button>
          <Button onClick={() => onSave(draft)} disabled={!draft.trim()}>{saveLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


/**
 * Applies app theme CSS vars to the vault surface. Subscribing here (instead of
 * in AppView) keeps accent-picker drags from rebuilding the whole shell; the
 * `children` element identity is unchanged so VaultView bails out.
 */
function AppVaultThemeSurface({
  VaultViewContainer,
  children,
}: {
  VaultViewContainer: React.ComponentType<any>;
  children: React.ReactNode;
}) {
  const appThemeStyle = useAppThemeStyle();
  return (
    <VaultViewContainer appThemeStyle={appThemeStyle}>
      {children}
    </VaultViewContainer>
  );
}

/** Plugin keybinding host with locally derived theme tokens and locale. */
function AppPluginKeybindingThemeHost({
  sessions,
  workspaces,
}: {
  sessions: any[];
  workspaces: any[];
}) {
  const appThemeStyle = useAppThemeStyle();
  const { resolvedTheme, uiLanguage } = useSettingsChromeStore();
  const pluginThemeTokens = useMemo(
    () => selectPluginThemeTokens(appThemeStyle as Record<string, unknown>),
    [appThemeStyle],
  );
  return (
    <AppPluginKeybindingHost
      locale={uiLanguage}
      theme={resolvedTheme}
      themeTokens={pluginThemeTokens}
      sessions={sessions}
      workspaces={workspaces}
    />
  );
}

/**
 * Log replay surface reads the latest log body from connectionLogsStore, so
 * terminal-data appends never touch the App domain bags.
 */
function AppLogViewSurface({
  LogViewWrapper,
  logView,
  defaultTerminalTheme,
  defaultFontSize,
  onClose,
}: {
  LogViewWrapper: React.ComponentType<any>;
  logView: any;
  defaultTerminalTheme: any;
  defaultFontSize: number;
  onClose: () => void;
}) {
  const { connectionLogs, updateConnectionLog } = useConnectionLogsStore();
  const latestLog =
    connectionLogs.find((log) => log.id === logView.connectionLogId) ?? logView.log;
  return (
    <LogViewWrapper
      logView={{ ...logView, log: latestLog }}
      defaultTerminalTheme={defaultTerminalTheme}
      defaultFontSize={defaultFontSize}
      onClose={onClose}
      onUpdateLog={updateConnectionLog}
    />
  );
}

export type AppViewProps = {
  domains: AppViewDomains;
};

function AppViewInner({ domains }: AppViewProps) {
  // Intentionally does NOT subscribe to activeTabId — leaf surfaces
  // (TopTabs items, mounts, host tree, chrome, plugin keybindings) own that
  // subscription so top-tab switches do not rebuild the App shell.
  const pluginViewTabs = usePluginViewTabs();
  // Merge domain slices once per AppView render. AppView only re-renders when a
  // domain slice identity changes (see appViewDomainsEqual). Depend on the
  // domain bag so the hook graph stays honest; bag identity only changes when
  // App rebuilds a domain slice.
  const ctx = useMemo(
    () => mergeAppViewDomains(domains),
    [domains],
  ) as Record<string, any>;
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
    addShellHistoryEntry, removeShellHistoryEntry, addSessionToWorkspace, addToWorkspaceDialog, appendHostToWorkspace, appendLocalTerminalToWorkspace,
    clearAndRemoveSource, clearAndRemoveSources, closeLogView, closeSession, closeTabsBatch, closeWorkspace, commitPluginImporterData, commitVaultImportTransaction, commitVaultGroupMutation, copySessionToNewWindowWithCurrentShell, copySessionWithCurrentShell, copyWorkspaceWithCurrentShell,
    convertKnownHostToHost, createWorkspaceFromSessions, createWorkspaceFromTargets, createWorkspaceWithHosts,
    customGroups, currentTerminalTheme, deepLinkHostDraft, draggingSessionId, effectiveKnownHosts, editorTabs, editorWordWrap, emptyVaultConflict,
    followAppTerminalTheme,
    groupConfigs, handleAddKnownHost, handleConnectSerial, handleConnectToHost, handleCreateLocalTerminal, handleDefaultTerminalThemeChange, handleDeleteHost,
    handleEndSessionDrag, handleFollowAppTerminalThemeChange, handleHostConnectWithProtocolCheck, handleHotkeyAction, handleKeyboardInteractiveCancel, handleKeyboardInteractiveSubmit,
    handleOpenHostFromVaultNote, handleOpenQuickSwitcher, handleOpenSettings, handleOpenVaultHostFromChat, handleOpenVaultNoteFromChat, handleOpenVaultSectionFromChat, handleOpenVaultSnippetFromChat, handleRootContextMenu, handlePassphraseCancel, handlePassphraseSkip, handlePassphraseSubmit, handleProtocolSelect,
    handleRequestCloseEditorTabRef, handleSessionStatusChange, handleSyncNowManual, handleTerminalDataCapture, handleUpdateHostFromTerminal,
    hostById, hosts, terminalHosts, updateTerminalHosts, hotkeyScheme, identities, importOrReuseKey, isBroadcastEnabled, isCreateWorkspaceOpen, isMacClient, isQuickSwitcherOpen,
    keyBindings, keyboardInteractiveQueue, keys, logViews, managedSources, navigateToSection, openLogView, openNoteRequest, orderedTabsWithEditors, orphanSessions,
    passphraseQueue, protocolSelectHost, proxyProfiles, portForwardingRules, quickResults, quickSearch, removeSessionFromWorkspace, reorderWorkTabs, reorderWorkspaceSessions,
    resolveEmptyVaultConflict, resolveSessionAppearance, runSnippet, sessionLogsDir, sessionLogsEnabled, sessionLogsFormat, sessionLogsTimestampsEnabled, sessionRenameTarget, sshDebugLogsEnabled,
    sessions, setActiveTabId, setDeepLinkHostDraft, setDraggingSessionId, setEditorWordWrap,
    setNavigateToSection, setTerminalFontFamilyId, setTerminalFontSize, setVaultFocusRequest, updateSessionFontSize, updateSessionRestoreCwd, updateSessionDynamicTitle, updateSessionCodingCliProvider, clearSessionFontSizeOverride,
    setWorkspaceFocusedSession, sftpAutoOpenSidebar, sftpFollowTerminalCwd, setSftpFollowTerminalCwd, sftpAutoSync, sftpDefaultViewMode, sftpDoubleClickBehavior,
    sftpShowHiddenFiles, sftpUseCompressedUpload, snippetPackages, snippets, splitSessionWithCurrentShell, startSessionRename,
    startWorkspaceRename, submitSessionRename, submitWorkspaceRename, t, terminalFontFamilyId, terminalFontSize, terminalSettings, terminalThemeId, themeById,
    toggleBroadcast, toggleScriptsSidePanelRef, toggleSidePanelRef, terminalPaneMagnificationRef, sftpPaneMagnificationRef, toggleWorkspaceViewMode, unmanageSource,
    readPersistedHosts, readPersistedManagedSources, updateCustomGroups, updateGroupConfigs, updateHostDistro, updateHosts, updateIdentities, updateKeys, updateKnownHosts, updateManagedSources,
    updateProxyProfiles, updateSnippetPackages, updateSnippets, updateSplitSizes, updateTerminalSetting, vaultFocusRequest, workspaceRenameTarget, workspaces,
    VaultViewContainer, SftpViewMount, TerminalLayerMount, LogViewWrapper,
  } = ctx;

  // Chrome-visible settings slice comes from settingsChromeStore, not from the
  // App chrome domain bag — the whole `settings` object changes identity on
  // every settings render and would rebuild the shell.
  const {
    theme: themePreference,
    resolvedTheme,
    windowOpacity,
    showSftpTab,
    showHostTreeSidebar,
    showRecentHosts,
    hostClickBehavior,
    showOnlyUngroupedHostsInRoot,
    dynamicTabTitleMode,
    disableTerminalFontZoom,
    restoreTerminalCwd,
    terminalSidePanelAutoOpen,
    terminalSidePanelAutoOpenTab,
  } = useSettingsChromeStore();
  const { setTheme, setWindowOpacity } = useSettingsChromeActions();

  const paneMagnificationController = getAvailablePaneMagnificationController([
    sftpPaneMagnificationRef?.current,
    terminalPaneMagnificationRef?.current,
  ]);
  const paneMagnificationState = paneMagnificationController?.getState() ?? 'unavailable';
  const handleMagnifyCurrentPane = () => {
    getAvailablePaneMagnificationController([
      sftpPaneMagnificationRef?.current,
      terminalPaneMagnificationRef?.current,
    ])?.focus();
  };
  const handleRestoreMagnifiedPane = () => {
    getAvailablePaneMagnificationController([
      sftpPaneMagnificationRef?.current,
      terminalPaneMagnificationRef?.current,
    ])?.restore();
  };

  // App Lock chrome: narrow slice published by AppLockRuntimePublisher; the
  // lock action reads the full runtime imperatively so the callback stays
  // stable across gate re-renders.
  const { appLockEnabled } = useAppLockChrome();
  const handleLockApp = useCallback(() => {
    getAppAppLockRuntime()?.lockNow('manual');
  }, []);

  const handleTerminalCommandExecuted = useCallback((
    command: string,
    hostId: string,
    hostLabel: string,
    sessionId: string,
  ) => {
    addShellHistoryEntry({ command, hostId, hostLabel, sessionId });
  }, [addShellHistoryEntry]);

  const handleUpdateTerminalFontWeight = useCallback((weight: number) => {
    updateTerminalSetting('fontWeight', weight);
  }, [updateTerminalSetting]);

  const handleRequestAddToWorkspace = useCallback((workspaceId: string) => {
    setAddToWorkspaceDialog({ mode: 'append', workspaceId });
  }, [setAddToWorkspaceDialog]);

  const validProxyProfileIds = useMemo(
    () => new Set(proxyProfiles.map((profile) => profile.id)),
    [proxyProfiles],
  );

  const resolveWorkspaceAppendHost = useCallback((host: typeof hosts[number]) => (
    resolveEffectiveTerminalHost({
      host,
      groupConfigs,
      proxyProfiles,
      validProxyProfileIds,
    })
  ), [groupConfigs, proxyProfiles, validProxyProfileIds]);

  const handleAppendHostToWorkspace = useCallback((workspaceId: string, hostId: string) => {
    const host = hosts.find((entry) => entry.id === hostId);
    if (!host) return;
    const ws = workspaces.find((entry) => entry.id === workspaceId);
    if (!ws) return;
    const rootDir = ws.root.type === 'split' ? ws.root.direction : 'vertical';
    appendHostToWorkspace(workspaceId, resolveWorkspaceAppendHost(host), rootDir);
  }, [appendHostToWorkspace, hosts, resolveWorkspaceAppendHost, workspaces]);

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
  const openWorkSurfaceHostEdit = workSurfaceHostEditor.openEdit;
  const handleEditHostFromOverlay = useCallback((host: (typeof hosts)[number]) => {
    if (shouldOpenHostEditOnWorkSurface(activeTabStore.getActiveTabId())) {
      openWorkSurfaceHostEdit(host);
      return;
    }
    setDeepLinkHostDraft(host);
    setNavigateToSection('hosts');
    setActiveTabId('vault');
  }, [
    openWorkSurfaceHostEdit,
    setActiveTabId,
    setDeepLinkHostDraft,
    setNavigateToSection,
  ]);
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

  const orderedTabsWithEditorsRef = useRef(orderedTabsWithEditors);
  orderedTabsWithEditorsRef.current = orderedTabsWithEditors;

  // Stable for TopTabs memo: read ordered tabs via ref; prompt via module singleton.
  const handleRequestCloseEditorTab = useCallback(async (id: string): Promise<boolean> => {
    const tab = editorTabStore.getTab(id);
    if (!tab) return false;

    const closeEditorAndActivateNeighbor = () => {
      const closingTabId = toEditorTabId(id);
      const list = orderedTabsWithEditorsRef.current;
      const idx = list.indexOf(closingTabId);
      releaseEditorTabSaveCoordinator(id);
      editorTabStore.close(id);
      if (activeTabStore.getActiveTabId() !== closingTabId) return;
      const next = list[idx - 1] ?? list[idx + 1] ?? 'vault';
      activeTabStore.setActiveTabId(next === closingTabId ? 'vault' : next);
    };

    const dirty = tab.content !== tab.baselineContent;
    if (!dirty) {
      closeEditorAndActivateNeighbor();
      return true;
    }
    const choice = await promptUnsavedChanges(tab.fileName);
    if (choice === 'cancel') return false;
    if (choice === 'discard') {
      closeEditorAndActivateNeighbor();
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
      closeEditorAndActivateNeighbor();
      return true;
    }

    return false;
  }, []);

  // Keep the hotkey ref current during render so Cmd/Ctrl+W never sees the
  // App.tsx stub `() => false` between commit and useEffect.
  handleRequestCloseEditorTabRef.current = handleRequestCloseEditorTab;

  const handleSaveSessionRename = useCallback((name: string) => {
    if (!sessionRenameTarget) return;
    if (!name.trim()) return;
    submitSessionRename(sessionRenameTarget.id, name);
    resetSessionRename();
  }, [resetSessionRename, sessionRenameTarget, submitSessionRename]);

  const handleSaveWorkspaceRename = useCallback((name: string) => {
    if (!workspaceRenameTarget) return;
    if (!name.trim()) return;
    submitWorkspaceRename(workspaceRenameTarget.id, name);
    resetWorkspaceRename();
  }, [resetWorkspaceRename, submitWorkspaceRename, workspaceRenameTarget]);

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
      {() => (
    <div className="flex flex-col h-screen text-foreground font-sans netcatty-shell" data-terminal-appearance-root onContextMenu={handleRootContextMenu}>
      <TopTabs
        theme={resolvedTheme}
        themePreference={themePreference}
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
        onEditHost={handleEditHostFromOverlay}
        onRenameWorkspace={startWorkspaceRename}
        onCopyWorkspace={copyWorkspaceWithCurrentShell}
        onCloseWorkspace={closeWorkspace}
        onCloseLogView={closeLogView}
        onCloseTabsBatch={closeTabsBatch}
        onOpenQuickSwitcher={handleOpenQuickSwitcher}
        onThemeChange={setTheme}
        onOpenSettings={handleOpenSettings}
        onLockApp={handleLockApp}
        appLockEnabled={appLockEnabled}
        externalMcpEnabled={externalMcpToggle.enabled}
        onToggleExternalMcp={externalMcpToggle.setEnabled}
        showExternalMcpToggle={!isPeerSessionWindow}
        windowOpacity={windowOpacity}
        setWindowOpacity={setWindowOpacity}
        onSyncNow={handleSyncNowManual}
        onStartSessionDrag={setDraggingSessionId}
        onEndSessionDrag={handleEndSessionDrag}
        onReorderTabs={reorderWorkTabs}
        onRemoveSessionFromWorkspace={removeSessionFromWorkspace}
        onAppendHostToWorkspace={handleAppendHostToWorkspace}
        showSftpTab={showSftpTab}
        showHostTreeSidebar={showHostTreeSidebar}
        switchTabKeyBinding={keyBindings.find((binding) => binding.action === 'switchToTab') ?? null}
        dynamicTabTitleMode={dynamicTabTitleMode}
        editorTabs={editorTabs}
        pluginViewTabs={pluginViewTabs}
        onClosePluginViewTab={closePluginViewTab}
        onRequestCloseEditorTab={handleRequestCloseEditorTab}
        hostById={hostById}
      />

      <div className="flex-1 relative min-h-0">
        <AppHostTreeLayer
          enabled={showHostTreeSidebar}
          hosts={hosts}
          customGroups={customGroups}
          groupConfigs={groupConfigs}
          sessions={sessions}
          workspaces={workspaces}
          editorTabs={editorTabs}
          logViews={logViews}
          orderedTabs={orderedTabsWithEditors}
          currentTerminalTheme={currentTerminalTheme}
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
          sessions={sessions}
          workspaces={workspaces}
          logViews={logViews}
          orderedTabs={orderedTabsWithEditors}
          onSave={workSurfaceHostEditor.save}
          onCancel={workSurfaceHostEditor.close}
          onCreateGroup={handleCreateWorkSurfaceHostGroup}
          onImportOrReuseKey={importOrReuseKey}
          onUpdateSnippets={updateSnippets}
          onUpdateHosts={updateHosts}
        />

        <AppVaultThemeSurface VaultViewContainer={VaultViewContainer}>
          <VaultView
            hosts={hosts}
            keys={keys}
            identities={identities}
            proxyProfiles={proxyProfiles}
            snippets={snippets}
            snippetPackages={snippetPackages}
            customGroups={customGroups}
            knownHosts={effectiveKnownHosts}
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
            onReadPersistedHosts={readPersistedHosts}
            onUpdateKeys={updateKeys}
            onImportOrReuseKey={importOrReuseKey}
            onUpdateIdentities={updateIdentities}
            onUpdateProxyProfiles={updateProxyProfiles}
            onUpdateSnippets={updateSnippets}
            onUpdateSnippetPackages={updateSnippetPackages}
            onUpdateCustomGroups={updateCustomGroups}
            onCommitPluginImporterData={commitPluginImporterData}
            onUpdateKnownHosts={updateKnownHosts}
            onUpdateManagedSources={updateManagedSources}
            onReadPersistedManagedSources={readPersistedManagedSources}
            onCommitVaultImportTransaction={commitVaultImportTransaction}
            onCommitVaultGroupMutation={commitVaultGroupMutation}
            onClearAndRemoveManagedSource={clearAndRemoveSource}
            onClearAndRemoveManagedSources={clearAndRemoveSources}
            onUnmanageSource={unmanageSource}
            onConvertKnownHost={convertKnownHostToHost}
            onRunSnippet={runSnippet}
            onOpenLogView={openLogView}
            showRecentHosts={showRecentHosts}
            hostClickBehavior={hostClickBehavior}
            showOnlyUngroupedHostsInRoot={showOnlyUngroupedHostsInRoot}
            navigateToSection={navigateToSection}
            onNavigateToSectionHandled={() => setNavigateToSection(null)}
            deepLinkHostDraft={deepLinkHostDraft}
            onDeepLinkHostDraftHandled={() => setDeepLinkHostDraft(null)}
            vaultFocusRequest={vaultFocusRequest}
            onVaultFocusRequestHandled={() => setVaultFocusRequest(null)}
            terminalSettings={terminalSettings}
          />
        </AppVaultThemeSurface>

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
          paneMagnificationRef={sftpPaneMagnificationRef}
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
          terminalSettings={terminalSettings}
          terminalFontFamilyId={terminalFontFamilyId}
          fontSize={terminalFontSize}
          hotkeyScheme={hotkeyScheme}
          disableTerminalFontZoom={disableTerminalFontZoom}
          restoreTerminalCwd={restoreTerminalCwd}
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
          onUpdateTerminalFontWeight={handleUpdateTerminalFontWeight}
          onCloseSession={closeSession}
          onUpdateSessionStatus={handleSessionStatusChange}
          onUpdateHostDistro={updateHostDistro}
          onUpdateHost={handleUpdateHostFromTerminal}
          onAddKnownHost={handleAddKnownHost}
          onCommandExecuted={handleTerminalCommandExecuted}
          onDeleteShellHistoryEntry={removeShellHistoryEntry}
          onTerminalDataCapture={handleTerminalDataCapture}
          onCreateWorkspaceFromSessions={createWorkspaceFromSessions}
          onAddSessionToWorkspace={addSessionToWorkspace}
          onRequestAddToWorkspace={handleRequestAddToWorkspace}
          onAppendHostToWorkspace={handleAppendHostToWorkspace}
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
          sftpDefaultViewMode={sftpDefaultViewMode}
          sftpDoubleClickBehavior={sftpDoubleClickBehavior}
          sftpAutoSync={sftpAutoSync}
          sftpShowHiddenFiles={sftpShowHiddenFiles}
          sftpUseCompressedUpload={sftpUseCompressedUpload}
          sftpAutoOpenSidebar={sftpAutoOpenSidebar}
          terminalSidePanelAutoOpen={terminalSidePanelAutoOpen}
          terminalSidePanelAutoOpenTab={terminalSidePanelAutoOpenTab}
          sftpFollowTerminalCwd={sftpFollowTerminalCwd}
          setSftpFollowTerminalCwd={setSftpFollowTerminalCwd}
          editorWordWrap={editorWordWrap}
          setEditorWordWrap={setEditorWordWrap}
          sessionLogsEnabled={sessionLogsEnabled}
          sessionLogsDir={sessionLogsDir}
          sessionLogsFormat={sessionLogsFormat}
          sessionLogsTimestampsEnabled={sessionLogsTimestampsEnabled}
          sshDebugLogsEnabled={sshDebugLogsEnabled}
          showHostTreeSidebar={showHostTreeSidebar}
          toggleScriptsSidePanelRef={toggleScriptsSidePanelRef}
          toggleSidePanelRef={toggleSidePanelRef}
          paneMagnificationRef={terminalPaneMagnificationRef}
          onStartSessionRename={startSessionRename}
          onSubmitSessionRename={submitSessionRename}
          onRemoveSessionFromWorkspace={removeSessionFromWorkspace}
        />

        {/* Log Views - readonly terminal replays. The latest log body comes
            from connectionLogsStore inside AppLogViewSurface. */}
        {logViews.map((logView: any) => (
          <AppLogViewSurface
            key={logView.id}
            LogViewWrapper={LogViewWrapper}
            logView={logView}
            defaultTerminalTheme={currentTerminalTheme}
            defaultFontSize={terminalFontSize}
            onClose={() => closeLogView(logView.id)}
          />
        ))}

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

        <AppPluginKeybindingThemeHost
          sessions={sessions}
          workspaces={workspaces}
        />
      </div>

      {/* Global "quick add / edit snippet" modal, triggered by the
          netcatty:snippets:add and :edit window events (from ScriptsSidePanel
          "+" button and right-click menu). Delete is handled by a sibling
          useEffect above — it does not need a dialog. */}
      <QuickAddSnippetDialog
        snippets={snippets}
        packages={snippetPackages}
        hotkeyScheme={hotkeyScheme}
        keyBindings={keyBindings}
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
          hosts={hosts}
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
                  appendHostToWorkspace(
                    addToWorkspaceDialog.workspaceId,
                    resolveWorkspaceAppendHost(target.host),
                    rootDir,
                  );
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
              showSftpTab={showSftpTab}
              onQueryChange={setQuickSearch}
              onSelect={handleHostConnectWithProtocolCheck}
              onEditHost={(host) => {
                setIsQuickSwitcherOpen(false);
                setQuickSearch('');
                handleEditHostFromOverlay(host);
              }}
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
              paneMagnificationState={paneMagnificationState}
              onMagnifyCurrentPane={handleMagnifyCurrentPane}
              onRestoreMagnifiedPane={handleRestoreMagnifiedPane}
            />
          </Suspense>
        </LazyLoadBoundary>
      )}

      <RenameDraftDialog
        open={!!sessionRenameTarget}
        inputId="session-name"
        initialName={sessionRenameTarget ? (sessionRenameTarget.customName || sessionRenameTarget.hostLabel) : ''}
        title={t('dialog.renameSession.title')}
        nameLabel={t('field.name')}
        placeholder={t('placeholder.sessionName')}
        cancelLabel={t('common.cancel')}
        saveLabel={t('common.save')}
        onCancel={resetSessionRename}
        onSave={handleSaveSessionRename}
      />

      <RenameDraftDialog
        open={!!workspaceRenameTarget}
        inputId="workspace-name"
        initialName={workspaceRenameTarget ? workspaceRenameTarget.title : ''}
        title={t('dialog.renameWorkspace.title')}
        nameLabel={t('field.name')}
        placeholder={t('placeholder.workspaceName')}
        cancelLabel={t('common.cancel')}
        saveLabel={t('common.save')}
        onCancel={resetWorkspaceRename}
        onSave={handleSaveWorkspaceRename}
      />


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
      )}
    </UnsavedChangesProvider>
    </SnippetExecutionProvider>
  );
}

export const AppView = memo(AppViewInner, (prev, next) => (
  appViewDomainsEqual(prev.domains, next.domains)
));
AppView.displayName = 'AppView';
