import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { activeTabStore, useIsVaultActive } from './application/state/activeTabStore';
import { useSessionState } from './application/state/useSessionState';
import { useSettingsState } from './application/state/useSettingsState';
import { useVaultState } from './application/state/useVaultState';
import { matchesKeyBinding } from './domain/models';
import ProtocolSelectDialog from './components/ProtocolSelectDialog';
import { QuickSwitcher } from './components/QuickSwitcher';
import SettingsDialog from './components/SettingsDialog';
import { SftpView } from './components/SftpView';
import { TerminalLayer } from './components/TerminalLayer';
import { TopTabs } from './components/TopTabs';
import { Button } from './components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './components/ui/dialog';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import { ToastProvider } from './components/ui/toast';
import { VaultView } from './components/VaultView';
import { cn } from './lib/utils';
import { Host, HostProtocol } from './types';

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

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isQuickSwitcherOpen, setIsQuickSwitcherOpen] = useState(false);
  const [quickSearch, setQuickSearch] = useState('');
  // Protocol selection dialog state for QuickSwitcher
  const [protocolSelectHost, setProtocolSelectHost] = useState<Host | null>(null);

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
    terminalFontFamilyId,
    setTerminalFontFamilyId,
    terminalFontSize,
    setTerminalFontSize,
    terminalSettings,
    updateTerminalSetting,
    hotkeyScheme,
    setHotkeyScheme,
    keyBindings,
    updateKeyBinding,
    resetKeyBinding,
    resetAllKeyBindings,
  } = useSettingsState();

  const {
    hosts,
    keys,
    snippets,
    customGroups,
    snippetPackages,
    knownHosts,
    shellHistory,
    updateHosts,
    updateKeys,
    updateSnippets,
    updateSnippetPackages,
    updateCustomGroups,
    updateKnownHosts,
    addShellHistoryEntry,
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

  // Shared hotkey action handler - used by both global handler and terminal callback
  const executeHotkeyAction = useCallback((action: string, e: KeyboardEvent) => {
    switch (action) {
      case 'switchToTab': {
        // Get the number key pressed (1-9)
        const num = parseInt(e.key, 10);
        if (num >= 1 && num <= 9) {
          // Build complete tab list: vault + sessions/workspaces
          const allTabs = ['vault', ...orderedTabs];
          if (num <= allTabs.length) {
            setActiveTabId(allTabs[num - 1]);
          }
        }
        break;
      }
      case 'nextTab': {
        // Build complete tab list: vault + sessions/workspaces
        const allTabs = ['vault', ...orderedTabs];
        const currentId = activeTabStore.getActiveTabId();
        const currentIdx = allTabs.indexOf(currentId);
        if (currentIdx !== -1 && allTabs.length > 0) {
          const nextIdx = (currentIdx + 1) % allTabs.length;
          setActiveTabId(allTabs[nextIdx]);
        } else if (allTabs.length > 0) {
          setActiveTabId(allTabs[0]);
        }
        break;
      }
      case 'prevTab': {
        // Build complete tab list: vault + sessions/workspaces
        const allTabs = ['vault', ...orderedTabs];
        const currentId = activeTabStore.getActiveTabId();
        const currentIdx = allTabs.indexOf(currentId);
        if (currentIdx !== -1 && allTabs.length > 0) {
          const prevIdx = (currentIdx - 1 + allTabs.length) % allTabs.length;
          setActiveTabId(allTabs[prevIdx]);
        } else if (allTabs.length > 0) {
          setActiveTabId(allTabs[allTabs.length - 1]);
        }
        break;
      }
      case 'closeTab': {
        const currentId = activeTabStore.getActiveTabId();
        if (currentId !== 'vault' && currentId !== 'sftp') {
          // Find if it's a session or workspace
          const session = sessions.find(s => s.id === currentId);
          if (session) {
            closeSession(currentId);
          } else {
            const workspace = workspaces.find(w => w.id === currentId);
            if (workspace) {
              closeWorkspace(currentId);
            }
          }
        }
        break;
      }
      case 'newTab':
      case 'openLocal':
        createLocalTerminal();
        break;
      case 'openHosts':
        setActiveTabId('vault');
        break;
      case 'openSftp':
        setActiveTabId('sftp');
        break;
      case 'quickSwitch':
      case 'commandPalette':
        setIsQuickSwitcherOpen(true);
        break;
      case 'portForwarding':
        // Navigate to vault and could open port forwarding section
        setActiveTabId('vault');
        break;
      case 'snippets':
        // Navigate to vault 
        setActiveTabId('vault');
        break;
      case 'broadcast':
        // TODO: Implement broadcast mode toggle
        console.log('[Hotkey] Broadcast mode toggle requested');
        break;
      case 'sidePanel':
        // TODO: Implement side panel toggle
        console.log('[Hotkey] Side panel toggle requested');
        break;
      case 'splitHorizontal':
        // TODO: Implement horizontal split
        console.log('[Hotkey] Split horizontal requested');
        break;
      case 'splitVertical':
        // TODO: Implement vertical split
        console.log('[Hotkey] Split vertical requested');
        break;
      case 'moveFocus': {
        // Move focus between split panes
        const direction = e.key === 'ArrowUp' ? 'up'
          : e.key === 'ArrowDown' ? 'down'
            : e.key === 'ArrowLeft' ? 'left'
              : e.key === 'ArrowRight' ? 'right'
                : null;
        if (direction) {
          console.log(`[Hotkey] Move focus ${direction}`);
          // TODO: Implement focus movement in workspace
        }
        break;
      }
    }
  }, [orderedTabs, sessions, workspaces, setActiveTabId, closeSession, closeWorkspace, createLocalTerminal]);

  // Callback for terminal to invoke app-level hotkey actions
  const handleHotkeyAction = useCallback((action: string, e: KeyboardEvent) => {
    executeHotkeyAction(action, e);
  }, [executeHotkeyAction]);

  // Global hotkey handler
  useEffect(() => {
    if (hotkeyScheme === 'disabled') return;

    const isMac = hotkeyScheme === 'mac';

    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      // Don't handle if we're in an input or textarea (except for Escape)
      // Note: xterm terminal handles its own key interception via attachCustomKeyEventHandler
      const target = e.target as HTMLElement;
      const isFormElement = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      if (isFormElement && e.key !== 'Escape') {
        return;
      }

      // Check each key binding
      for (const binding of keyBindings) {
        const keyStr = isMac ? binding.mac : binding.pc;
        if (matchesKeyBinding(e, keyStr, isMac)) {
          // Terminal-specific actions should be handled by the terminal
          // Don't handle them at app level
          const terminalActions = ['copy', 'paste', 'selectAll', 'clearBuffer', 'searchTerminal'];
          if (terminalActions.includes(binding.action)) {
            return; // Let terminal handle it
          }

          e.preventDefault();
          e.stopPropagation();
          executeHotkeyAction(binding.action, e);
          return;
        }
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown, true);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown, true);
  }, [hotkeyScheme, keyBindings, executeHotkeyAction]);

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

  const handleDeleteHost = useCallback((hostId: string) => {
    const target = hosts.find(h => h.id === hostId);
    const confirmed = window.confirm(`Delete host "${target?.label || hostId}"?`);
    if (!confirmed) return;
    updateHosts(hosts.filter(h => h.id !== hostId));
  }, [hosts, updateHosts]);

  // Check if host has multiple protocols enabled
  const hasMultipleProtocols = useCallback((host: Host) => {
    let count = 0;
    // SSH is always available as base protocol (unless explicitly set to something else)
    if (host.protocol === 'ssh' || !host.protocol) count++;
    // Mosh adds another option
    if (host.moshEnabled) count++;
    // Telnet adds another option
    if (host.telnetEnabled) count++;
    // If protocol is explicitly telnet (not ssh), count it
    if (host.protocol === 'telnet' && !host.telnetEnabled) count++;
    return count > 1;
  }, []);

  // Handle host connect with protocol selection (used by QuickSwitcher)
  const handleHostConnectWithProtocolCheck = useCallback((host: Host) => {
    if (hasMultipleProtocols(host)) {
      setProtocolSelectHost(host);
      setIsQuickSwitcherOpen(false);
      setQuickSearch('');
    } else {
      connectToHost(host);
      setIsQuickSwitcherOpen(false);
      setQuickSearch('');
    }
  }, [hasMultipleProtocols, connectToHost]);

  // Handle protocol selection from dialog
  const handleProtocolSelect = useCallback((protocol: HostProtocol, port: number) => {
    if (protocolSelectHost) {
      const hostWithProtocol: Host = {
        ...protocolSelectHost,
        protocol: protocol === 'mosh' ? 'ssh' : protocol,
        port,
        moshEnabled: protocol === 'mosh',
      };
      connectToHost(hostWithProtocol);
      setProtocolSelectHost(null);
    }
  }, [protocolSelectHost, connectToHost]);

  const handleToggleTheme = useCallback(() => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark');
  }, [setTheme]);

  const handleOpenQuickSwitcher = useCallback(() => {
    setIsQuickSwitcherOpen(true);
  }, []);

  const handleOpenSettings = useCallback(() => {
    setIsSettingsOpen(true);
  }, []);

  const handleEndSessionDrag = useCallback(() => {
    setDraggingSessionId(null);
  }, [setDraggingSessionId]);

  return (
    <div className="flex flex-col h-screen text-foreground font-sans netcatty-shell" onContextMenu={(e) => e.preventDefault()}>
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
            shellHistory={shellHistory}
            sessions={sessions}
            onOpenSettings={handleOpenSettings}
            onOpenQuickSwitcher={handleOpenQuickSwitcher}
            onCreateLocalTerminal={createLocalTerminal}
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
          fontSize={terminalFontSize}
          hotkeyScheme={hotkeyScheme}
          keyBindings={keyBindings}
          onHotkeyAction={handleHotkeyAction}
          onCloseSession={closeSession}
          onUpdateSessionStatus={updateSessionStatus}
          onUpdateHostDistro={updateHostDistro}
          onUpdateHost={(host) => updateHosts(hosts.map(h => h.id === host.id ? host : h))}
          onAddKnownHost={(kh) => updateKnownHosts([...knownHosts, kh])}
          onCommandExecuted={(command, hostId, hostLabel, sessionId) => {
            addShellHistoryEntry({ command, hostId, hostLabel, sessionId });
          }}
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
        onSelect={handleHostConnectWithProtocolCheck}
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
        terminalFontFamilyId={terminalFontFamilyId}
        onTerminalFontFamilyChange={setTerminalFontFamilyId}
        terminalFontSize={terminalFontSize}
        onTerminalFontSizeChange={setTerminalFontSize}
        terminalSettings={terminalSettings}
        onTerminalSettingsChange={updateTerminalSetting}
        hotkeyScheme={hotkeyScheme}
        onHotkeySchemeChange={setHotkeyScheme}
        keyBindings={keyBindings}
        onUpdateKeyBinding={updateKeyBinding}
        onResetKeyBinding={resetKeyBinding}
        onResetAllKeyBindings={resetAllKeyBindings}
      />

      {/* Protocol Select Dialog for QuickSwitcher */}
      {protocolSelectHost && (
        <ProtocolSelectDialog
          host={protocolSelectHost}
          onSelect={handleProtocolSelect}
          onCancel={() => setProtocolSelectHost(null)}
        />
      )}
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
