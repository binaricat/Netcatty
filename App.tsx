import React, { useEffect, useMemo, useState } from 'react';
import SettingsDialog from './components/SettingsDialog';
import HostDetailsPanel from './components/HostDetailsPanel';
import { SftpView } from './components/SftpView';
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

function App() {
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isQuickSwitcherOpen, setIsQuickSwitcherOpen] = useState(false);
  const [quickSearch, setQuickSearch] = useState('');
  const [editingHost, setEditingHost] = useState<Host | null>(null);
  const [showAssistant, setShowAssistant] = useState(false);

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
    updateHosts,
    updateKeys,
    updateSnippets,
    updateSnippetPackages,
    updateCustomGroups,
    updateHostDistro,
    exportData,
    importDataFromString,
  } = useVaultState();

  const {
    sessions,
    workspaces,
    activeTabId,
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
    orphanSessions,
  } = useSessionState();

  const isVaultActive = activeTabId === 'vault';
  const isSftpActive = activeTabId === 'sftp';
  const isTerminalLayerActive = !isVaultActive && !isSftpActive;
  const isTerminalLayerVisible = isTerminalLayerActive || !!draggingSessionId;
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

  const handleEditHost = (host: Host) => {
    setEditingHost(host);
    setIsFormOpen(true);
  };

  const handleDeleteHost = (hostId: string) => {
    const target = hosts.find(h => h.id === hostId);
    const confirmed = window.confirm(`Delete host "${target?.label || hostId}"?`);
    if (!confirmed) return;
    updateHosts(hosts.filter(h => h.id !== hostId));
  };

  return (
    <div className="flex flex-col h-screen text-foreground font-sans nebula-shell" onContextMenu={(e) => e.preventDefault()}>
      <TopTabs
        theme={theme}
        isVaultActive={isVaultActive}
        isSftpActive={isSftpActive}
        activeTabId={activeTabId}
        sessions={sessions}
        orphanSessions={orphanSessions}
        workspaces={workspaces}
        draggingSessionId={draggingSessionId}
        isMacClient={isMacClient}
        onSelectTab={setActiveTabId}
        onCloseSession={closeSession}
        onRenameWorkspace={startWorkspaceRename}
        onCloseWorkspace={closeWorkspace}
        onOpenQuickSwitcher={() => setIsQuickSwitcherOpen(true)}
        onToggleTheme={() => setTheme(prev => prev === 'dark' ? 'light' : 'dark')}
        onStartSessionDrag={setDraggingSessionId}
        onEndSessionDrag={() => setDraggingSessionId(null)}
      />

      <div className="flex-1 relative min-h-0">
        <VaultView
          isActive={isVaultActive}
          hosts={hosts}
          keys={keys}
          snippets={snippets}
          snippetPackages={snippetPackages}
          customGroups={customGroups}
          sessions={sessions}
          showAssistant={showAssistant}
          onToggleAssistant={() => setShowAssistant(prev => !prev)}
          onOpenSettings={() => setIsSettingsOpen(true)}
          onOpenQuickSwitcher={() => setIsQuickSwitcherOpen(true)}
          onCreateLocalTerminal={createLocalTerminal}
          onNewHost={() => { setEditingHost(null); setIsFormOpen(true); }}
          onEditHost={handleEditHost}
          onDeleteHost={handleDeleteHost}
          onConnect={connectToHost}
          onUpdateHosts={updateHosts}
          onUpdateKeys={updateKeys}
          onUpdateSnippets={updateSnippets}
          onUpdateSnippetPackages={updateSnippetPackages}
          onUpdateCustomGroups={updateCustomGroups}
        />

        <SftpView hosts={hosts} isActive={isSftpActive && !draggingSessionId} />

        <TerminalLayer
          hosts={hosts}
          keys={keys}
          snippets={snippets}
          sessions={sessions}
          workspaces={workspaces}
          activeTabId={activeTabId}
          draggingSessionId={draggingSessionId}
          isVisible={isTerminalLayerVisible}
          terminalTheme={currentTerminalTheme}
          showAssistant={showAssistant}
          onCloseSession={closeSession}
          onUpdateSessionStatus={updateSessionStatus}
          onUpdateHostDistro={updateHostDistro}
          onCreateWorkspaceFromSessions={createWorkspaceFromSessions}
          onAddSessionToWorkspace={addSessionToWorkspace}
          onUpdateSplitSizes={updateSplitSizes}
          onSetDraggingSessionId={setDraggingSessionId}
        />
      </div>

      <QuickSwitcher
        isOpen={isQuickSwitcherOpen}
        query={quickSearch}
        results={quickResults}
        onQueryChange={setQuickSearch}
        onSelect={(host) => {
          connectToHost(host);
          setIsQuickSwitcherOpen(false);
          setQuickSearch('');
        }}
        onCreateLocalTerminal={createLocalTerminal}
        onClose={() => setIsQuickSwitcherOpen(false)}
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
          onSave={host => {
            updateHosts(editingHost ? hosts.map(h => h.id === host.id ? host : h) : [...hosts, host]);
            setIsFormOpen(false);
            setEditingHost(null);
          }}
          onCancel={() => { setIsFormOpen(false); setEditingHost(null); }}
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

export default App;
