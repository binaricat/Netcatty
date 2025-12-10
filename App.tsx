import React, { useEffect, useMemo, useState, useCallback } from 'react';
import SettingsDialog from './components/SettingsDialog';
import HostDetailsPanel from './components/HostDetailsPanel';
import { SftpView } from './components/SftpViewNew';
import { TopTabs } from './components/TopTabs';
import { QuickSwitcher } from './components/QuickSwitcher';
import { VaultView } from './components/VaultView';
import { TerminalLayer } from './components/TerminalLayer';
import { Host } from './types';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from './components/ui/dialog';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import { useSettingsState } from './application/state/useSettingsState';
import { useVaultState } from './application/state/useVaultState';
import { useSessionState } from './application/state/useSessionState';
import { useIsVaultActive } from './application/state/activeTabStore';
import { ToastProvider } from './components/ui/toast';
import { cn } from './lib/utils';

// Visibility container for VaultView - isolates isActive subscription
const VaultViewContainer: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const isActive = useIsVaultActive();
  const containerStyle: React.CSSProperties = isActive
    ? {}
    : { visibility: 'hidden', pointerEvents: 'none', position: 'absolute', zIndex: -1 };

  return (
    <div className={cn("absolute inset-0", isActive ? "z-20" : "")} style={containerStyle}>
      {children}
    </div>
  );
};

function App() {
  console.log('[App] render');

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isQuickSwitcherOpen, setIsQuickSwitcherOpen] = useState(false);
  const [quickSearch, setQuickSearch] = useState('');
  const [editingHost, setEditingHost] = useState<Host | null>(null);

  const {
    theme,
    setTheme,
    primaryColor,
    setPrimaryColor,
    syncConfig,
    updateSyncConfig,
    terminalThemeId,
    setTerminalThemeId,
    currentTerminalTheme,
  } = useSettingsState();

  const {
    hosts,
    keys,
    snippets,
    customGroups,
    snippetPackages,
    knownHosts,
    updateHosts,
    updateKeys,
    updateSnippets,
    updateSnippetPackages,
    updateCustomGroups,
    updateKnownHosts,
    updateHostDistro,
    convertKnownHostToHost,
    exportData,
    importDataFromString,
  } = useVaultState();

  const {
    sessions,
    workspaces,
    setActiveTabId,
    draggingSessionId,
    setDraggingSessionId,
    workspaceRenameTarget,
    workspaceRenameValue,
    setWorkspaceRenameValue,
    startWorkspaceRename,
    submitWorkspaceRename,
    resetWorkspaceRename,
    createLocalTerminal,
    connectToHost,
    closeSession,
    closeWorkspace,
    updateSessionStatus,
    createWorkspaceFromSessions,
    addSessionToWorkspace,
    updateSplitSizes,
    toggleWorkspaceViewMode,
    setWorkspaceFocusedSession,
    runSnippet,
    orphanSessions,
    orderedTabs,
    reorderTabs,
  } = useSessionState();

  // isMacClient is used for window controls styling
  const isMacClient = typeof navigator !== 'undefined' && /Mac|Macintosh/.test(navigator.userAgent);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isQuickSwitcherOpen) {
        setIsQuickSwitcherOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isQuickSwitcherOpen]);

  const quickResults = useMemo(() => {
    const term = quickSearch.trim().toLowerCase();
    const filtered = term
      ? hosts.filter(h =>
        h.label.toLowerCase().includes(term) ||
        h.hostname.toLowerCase().includes(term) ||
        (h.group || '').toLowerCase().includes(term)
      )
      : hosts;
    return filtered.slice(0, 8);
  }, [hosts, quickSearch]);

  const handleEditHost = useCallback((host: Host) => {
    setEditingHost(host);
    setIsFormOpen(true);
  }, []);

  const handleDeleteHost = useCallback((hostId: string) => {
    const target = hosts.find(h => h.id === hostId);
    const confirmed = window.confirm(`Delete host "${target?.label || hostId}"?`);
    if (!confirmed) return;
    updateHosts(hosts.filter(h => h.id !== hostId));
  }, [hosts, updateHosts]);

  const handleToggleTheme = useCallback(() => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark');
  }, [setTheme]);

  const handleOpenQuickSwitcher = useCallback(() => {
    setIsQuickSwitcherOpen(true);
  }, []);

  const handleOpenSettings = useCallback(() => {
    setIsSettingsOpen(true);
  }, []);

  const handleNewHost = useCallback(() => {
    setEditingHost(null);
    setIsFormOpen(true);
  }, []);

  const handleEndSessionDrag = useCallback(() => {
    setDraggingSessionId(null);
  }, [setDraggingSessionId]);

  return (
    <div className="flex flex-col h-screen text-foreground font-sans nebula-shell" onContextMenu={(e) => e.preventDefault()}>
      <TopTabs
        theme={theme}
        sessions={sessions}
        orphanSessions={orphanSessions}
        workspaces={workspaces}
        orderedTabs={orderedTabs}
        draggingSessionId={draggingSessionId}
        isMacClient={isMacClient}
        onCloseSession={closeSession}
        onRenameWorkspace={startWorkspaceRename}
        onCloseWorkspace={closeWorkspace}
        onOpenQuickSwitcher={handleOpenQuickSwitcher}
        onToggleTheme={handleToggleTheme}
        onStartSessionDrag={setDraggingSessionId}
        onEndSessionDrag={handleEndSessionDrag}
        onReorderTabs={reorderTabs}
      />

      <div className="flex-1 relative min-h-0">
        <VaultViewContainer>
          <VaultView
            hosts={hosts}
            keys={keys}
            snippets={snippets}
            snippetPackages={snippetPackages}
            customGroups={customGroups}
            knownHosts={knownHosts}
            sessions={sessions}
            onOpenSettings={handleOpenSettings}
            onOpenQuickSwitcher={handleOpenQuickSwitcher}
            onCreateLocalTerminal={createLocalTerminal}
            onNewHost={handleNewHost}
            onEditHost={handleEditHost}
            onDeleteHost={handleDeleteHost}
            onConnect={connectToHost}
            onUpdateHosts={updateHosts}
            onUpdateKeys={updateKeys}
            onUpdateSnippets={updateSnippets}
            onUpdateSnippetPackages={updateSnippetPackages}
            onUpdateCustomGroups={updateCustomGroups}
            onUpdateKnownHosts={updateKnownHosts}
            onConvertKnownHost={convertKnownHostToHost}
            onRunSnippet={runSnippet}
          />
        </VaultViewContainer>

        <SftpView hosts={hosts} keys={keys} />

        <TerminalLayer
          hosts={hosts}
          keys={keys}
          snippets={snippets}
          sessions={sessions}
          workspaces={workspaces}
          knownHosts={knownHosts}
          draggingSessionId={draggingSessionId}
          terminalTheme={currentTerminalTheme}
          onCloseSession={closeSession}
          onUpdateSessionStatus={updateSessionStatus}
          onUpdateHostDistro={updateHostDistro}
          onUpdateHost={(host) => updateHosts(hosts.map(h => h.id === host.id ? host : h))}
          onAddKnownHost={(kh) => updateKnownHosts([...knownHosts, kh])}
          onCreateWorkspaceFromSessions={createWorkspaceFromSessions}
          onAddSessionToWorkspace={addSessionToWorkspace}
          onUpdateSplitSizes={updateSplitSizes}
          onSetDraggingSessionId={setDraggingSessionId}
          onToggleWorkspaceViewMode={toggleWorkspaceViewMode}
          onSetWorkspaceFocusedSession={setWorkspaceFocusedSession}
        />
      </div>

      <QuickSwitcher
        isOpen={isQuickSwitcherOpen}
        query={quickSearch}
        results={quickResults}
        sessions={sessions}
        workspaces={workspaces}
        onQueryChange={setQuickSearch}
        onSelect={(host) => {
          connectToHost(host);
          setIsQuickSwitcherOpen(false);
          setQuickSearch('');
        }}
        onSelectTab={(tabId) => {
          setActiveTabId(tabId);
          setIsQuickSwitcherOpen(false);
          setQuickSearch('');
        }}
        onCreateLocalTerminal={() => {
          createLocalTerminal();
          setIsQuickSwitcherOpen(false);
          setQuickSearch('');
        }}
        onCreateWorkspace={() => {
          // TODO: Implement workspace creation
          setIsQuickSwitcherOpen(false);
        }}
        onClose={() => {
          setIsQuickSwitcherOpen(false);
          setQuickSearch('');
        }}
      />

      <Dialog open={!!workspaceRenameTarget} onOpenChange={(open) => {
        if (!open) {
          resetWorkspaceRename();
        }
      }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename workspace</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="workspace-name">Name</Label>
            <Input
              id="workspace-name"
              value={workspaceRenameValue}
              onChange={(e) => setWorkspaceRenameValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitWorkspaceRename(); }}
              autoFocus
              placeholder="Workspace name"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={resetWorkspaceRename}>Cancel</Button>
            <Button onClick={submitWorkspaceRename} disabled={!workspaceRenameValue.trim()}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {isFormOpen && (
        <HostDetailsPanel
          initialData={editingHost}
          availableKeys={keys}
          groups={Array.from(new Set([...customGroups, ...hosts.map(h => h.group || 'General')]))}
          allHosts={hosts}
          onSave={host => {
            updateHosts(editingHost ? hosts.map(h => h.id === host.id ? host : h) : [...hosts, host]);
            setIsFormOpen(false);
            setEditingHost(null);
          }}
          onCancel={() => { setIsFormOpen(false); setEditingHost(null); }}
          onCreateGroup={(groupPath) => {
            updateCustomGroups(Array.from(new Set([...customGroups, groupPath])));
          }}
        />
      )}

      <SettingsDialog
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onImport={importDataFromString}
        exportData={exportData}
        theme={theme}
        onThemeChange={setTheme}
        primaryColor={primaryColor}
        onPrimaryColorChange={setPrimaryColor}
        syncConfig={syncConfig}
        onSyncConfigChange={updateSyncConfig}
        terminalThemeId={terminalThemeId}
        onTerminalThemeChange={setTerminalThemeId}
      />
    </div>
  );
}

function AppWithProviders() {
  return (
    <ToastProvider>
      <App />
    </ToastProvider>
  );
}

export default AppWithProviders;
