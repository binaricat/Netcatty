import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { activeTabStore, useActiveTabId, useIsVaultActive } from './application/state/activeTabStore';
import { useSessionState } from './application/state/useSessionState';
import { useSettingsState } from './application/state/useSettingsState';
import { useVaultState } from './application/state/useVaultState';
import { useWindowControls } from './application/state/useWindowControls';
import { matchesKeyBinding } from './domain/models';
import { netcattyBridge } from './infrastructure/services/netcattyBridge';
import LogView from './components/LogView';
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
import { VaultView, VaultSection } from './components/VaultView';
import { cn } from './lib/utils';
import { Host, HostProtocol, TerminalTheme } from './types';
import { LogView as LogViewType } from './application/state/useSessionState';

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

// LogView wrapper - manages visibility based on active tab
interface LogViewWrapperProps {
  logView: LogViewType;
  terminalTheme: TerminalTheme;
  fontSize: number;
  onClose: () => void;
}

const LogViewWrapper: React.FC<LogViewWrapperProps> = ({ logView, terminalTheme, fontSize, onClose }) => {
  const activeTabId = useActiveTabId();
  const isVisible = activeTabId === logView.id;
  
  // Use same pattern as VaultViewContainer for visibility
  const containerStyle: React.CSSProperties = isVisible
    ? {}
    : { visibility: 'hidden', pointerEvents: 'none', position: 'absolute', zIndex: -1 };
  
  return (
    <div className={cn("absolute inset-0", isVisible ? "z-20" : "")} style={containerStyle}>
      <LogView
        log={logView.log}
        terminalTheme={terminalTheme}
        fontSize={fontSize}
        isVisible={isVisible}
        onClose={onClose}
      />
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
  // Navigation state for VaultView sections
  const [navigateToSection, setNavigateToSection] = useState<VaultSection | null>(null);

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
    customCSS,
    setCustomCSS,
  } = useSettingsState();

  // Debug: log hotkeyScheme and keyBindings on every render
  console.log('[App] hotkeyScheme:', hotkeyScheme, 'keyBindings length:', keyBindings.length);

  const {
    hosts,
    keys,
    snippets,
    customGroups,
    snippetPackages,
    knownHosts,
    shellHistory,
    connectionLogs,
    updateHosts,
    updateKeys,
    updateSnippets,
    updateSnippetPackages,
    updateCustomGroups,
    updateKnownHosts,
    addShellHistoryEntry,
    addConnectionLog,
    updateConnectionLog,
    toggleConnectionLogSaved,
    deleteConnectionLog,
    clearUnsavedConnectionLogs,
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
    splitSession,
    toggleWorkspaceViewMode,
    setWorkspaceFocusedSession,
    moveFocusInWorkspace,
    runSnippet,
    orphanSessions,
    orderedTabs,
    reorderTabs,
    toggleBroadcast,
    isBroadcastEnabled,
    logViews,
    openLogView,
    closeLogView,
  } = useSessionState();

  // isMacClient is used for window controls styling
  const isMacClient = typeof navigator !== 'undefined' && /Mac|Macintosh/.test(navigator.userAgent);

  // Debounce ref for moveFocus to prevent double-triggering when focus switches
  const lastMoveFocusTimeRef = useRef<number>(0);
  const MOVE_FOCUS_DEBOUNCE_MS = 200;

  // Use ref to store addConnectionLog to avoid circular dependencies with executeHotkeyAction
  const addConnectionLogRef = useRef(addConnectionLog);
  addConnectionLogRef.current = addConnectionLog;

  // Shared hotkey action handler - used by both global handler and terminal callback
  const executeHotkeyAction = useCallback((action: string, e: KeyboardEvent) => {
    switch (action) {
      case 'switchToTab': {
        // Get the number key pressed (1-9)
        const num = parseInt(e.key, 10);
        if (num >= 1 && num <= 9) {
          // Build complete tab list: vault + sftp + sessions/workspaces
          const allTabs = ['vault', 'sftp', ...orderedTabs];
          if (num <= allTabs.length) {
            setActiveTabId(allTabs[num - 1]);
          }
        }
        break;
      }
      case 'nextTab': {
        // Build complete tab list: vault + sftp + sessions/workspaces
        const allTabs = ['vault', 'sftp', ...orderedTabs];
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
        // Build complete tab list: vault + sftp + sessions/workspaces
        const allTabs = ['vault', 'sftp', ...orderedTabs];
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
        // Add connection log for local terminal
        addConnectionLogRef.current({
          hostId: '',
          hostLabel: 'Local Terminal',
          hostname: 'localhost',
          username: systemInfoRef.current.username,
          protocol: 'local',
          startTime: Date.now(),
          localUsername: systemInfoRef.current.username,
          localHostname: systemInfoRef.current.hostname,
          saved: false,
        });
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
        // Navigate to vault and open port forwarding section
        setActiveTabId('vault');
        setNavigateToSection('port');
        break;
      case 'snippets':
        // Navigate to vault and open snippets section
        setActiveTabId('vault');
        setNavigateToSection('snippets');
        break;
      case 'broadcast': {
        // Toggle broadcast mode for the active workspace
        const currentId = activeTabStore.getActiveTabId();
        const activeWs = workspaces.find(w => w.id === currentId);
        if (activeWs) {
          toggleBroadcast(activeWs.id);
        }
        break;
      }
      case 'splitHorizontal': {
        // Split current terminal horizontally (top/bottom)
        const currentId = activeTabStore.getActiveTabId();
        // Check if it's a standalone session or we're in a workspace
        const activeSession = sessions.find(s => s.id === currentId);
        const activeWs = workspaces.find(w => w.id === currentId);
        if (activeSession && !activeSession.workspaceId) {
          // Standalone session - split it
          splitSession(activeSession.id, 'horizontal');
        } else if (activeWs) {
          // In a workspace - need to determine focused session
          // For now, we'll need the terminal to handle this via context menu
          console.log('[Hotkey] Split horizontal in workspace - use context menu on specific terminal');
        }
        break;
      }
      case 'splitVertical': {
        // Split current terminal vertically (left/right)
        const currentId = activeTabStore.getActiveTabId();
        const activeSession = sessions.find(s => s.id === currentId);
        const activeWs = workspaces.find(w => w.id === currentId);
        if (activeSession && !activeSession.workspaceId) {
          // Standalone session - split it
          splitSession(activeSession.id, 'vertical');
        } else if (activeWs) {
          // In a workspace - need to determine focused session
          console.log('[Hotkey] Split vertical in workspace - use context menu on specific terminal');
        }
        break;
      }
      case 'moveFocus': {
        // Debounce to prevent double-triggering when focus switches between terminals
        const now = Date.now();
        if (now - lastMoveFocusTimeRef.current < MOVE_FOCUS_DEBOUNCE_MS) {
          console.log('[App] moveFocus debounced, ignoring');
          break;
        }
        lastMoveFocusTimeRef.current = now;

        // Move focus between split panes
        console.log('[App] moveFocus action triggered, key:', e.key);
        const direction = e.key === 'ArrowUp' ? 'up'
          : e.key === 'ArrowDown' ? 'down'
            : e.key === 'ArrowLeft' ? 'left'
              : e.key === 'ArrowRight' ? 'right'
                : null;
        console.log('[App] moveFocus direction:', direction);
        if (direction) {
          // Find the active workspace
          const currentId = activeTabStore.getActiveTabId();
          console.log('[App] Active tab ID:', currentId);
          const activeWs = workspaces.find(w => w.id === currentId);
          console.log('[App] Active workspace:', activeWs?.id, activeWs?.title);
          if (activeWs) {
            const result = moveFocusInWorkspace(activeWs.id, direction as 'up' | 'down' | 'left' | 'right');
            console.log('[App] moveFocusInWorkspace result:', result);
          } else {
            console.log('[App] No active workspace found');
          }
        }
        break;
      }
    }
  }, [orderedTabs, sessions, workspaces, setActiveTabId, closeSession, closeWorkspace, createLocalTerminal, splitSession, moveFocusInWorkspace, toggleBroadcast]);

  // Callback for terminal to invoke app-level hotkey actions
  const handleHotkeyAction = useCallback((action: string, e: KeyboardEvent) => {
    executeHotkeyAction(action, e);
  }, [executeHotkeyAction]);

  // Global hotkey handler
  useEffect(() => {
    if (hotkeyScheme === 'disabled') return;

    const isMac = hotkeyScheme === 'mac';
    console.log('[Hotkeys] Registering global hotkey handler, scheme:', hotkeyScheme, 'bindings count:', keyBindings.length);

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
          console.log('[Hotkeys] Matched binding:', binding.action, keyStr);
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

  // System info for connection logs
  const systemInfoRef = useRef<{ username: string; hostname: string }>({
    username: 'user',
    hostname: 'localhost',
  });

  // Fetch system info on mount
  useEffect(() => {
    void (async () => {
      try {
        const bridge = netcattyBridge.get();
        const info = await bridge?.getSystemInfo?.();
        if (info) {
          systemInfoRef.current = info;
        }
      } catch {
        // Fallback to defaults
      }
    })();
  }, []);

  // Wrapper to create local terminal with logging
  const handleCreateLocalTerminal = useCallback(() => {
    const { username, hostname } = systemInfoRef.current;
    addConnectionLog({
      hostId: '',
      hostLabel: 'Local Terminal',
      hostname: 'localhost',
      username: username,
      protocol: 'local',
      startTime: Date.now(),
      localUsername: username,
      localHostname: hostname,
      saved: false,
    });
    createLocalTerminal();
  }, [addConnectionLog, createLocalTerminal]);

  // Wrapper to connect to host with logging
  const handleConnectToHost = useCallback((host: Host) => {
    const { username, hostname: localHost } = systemInfoRef.current;
    const protocol = host.moshEnabled ? 'mosh' : (host.protocol || 'ssh');
    addConnectionLog({
      hostId: host.id,
      hostLabel: host.label,
      hostname: host.hostname,
      username: host.username || 'root',
      protocol: protocol as 'ssh' | 'telnet' | 'local' | 'mosh',
      startTime: Date.now(),
      localUsername: username,
      localHostname: localHost,
      saved: false,
    });
    connectToHost(host);
  }, [addConnectionLog, connectToHost]);

  // Handle terminal data capture when session exits
  const handleTerminalDataCapture = useCallback((sessionId: string, data: string) => {
    console.log('[handleTerminalDataCapture] Called', { sessionId, dataLength: data.length });
    // Find the connection log for this session
    const session = sessions.find(s => s.id === sessionId);
    console.log('[handleTerminalDataCapture] Session', session);
    if (!session) {
      console.log('[handleTerminalDataCapture] No session found');
      return;
    }
    
    console.log('[handleTerminalDataCapture] Looking for logs with hostname:', session.hostname);
    console.log('[handleTerminalDataCapture] All logs:', connectionLogs.map(l => ({ id: l.id, hostname: l.hostname, endTime: l.endTime, hasTerminalData: !!l.terminalData })));
    
    // Find the most recent log matching this session's hostname and doesn't have terminalData yet
    // For local terminal, hostname is 'localhost'
    // Sort by startTime descending to find the most recent matching log
    const matchingLog = connectionLogs
      .filter(log => 
        log.hostname === session.hostname && 
        !log.endTime && 
        !log.terminalData
      )
      .sort((a, b) => b.startTime - a.startTime)[0];
    
    console.log('[handleTerminalDataCapture] Matching log', matchingLog);
    
    if (matchingLog) {
      updateConnectionLog(matchingLog.id, {
        endTime: Date.now(),
        terminalData: data,
      });
      console.log('[handleTerminalDataCapture] Updated log with terminalData');
    } else {
      console.log('[handleTerminalDataCapture] No matching log found!');
    }
  }, [sessions, connectionLogs, updateConnectionLog]);

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
      handleConnectToHost(host);
      setIsQuickSwitcherOpen(false);
      setQuickSearch('');
    }
  }, [hasMultipleProtocols, handleConnectToHost]);

  // Handle protocol selection from dialog
  const handleProtocolSelect = useCallback((protocol: HostProtocol, port: number) => {
    if (protocolSelectHost) {
      const hostWithProtocol: Host = {
        ...protocolSelectHost,
        protocol: protocol === 'mosh' ? 'ssh' : protocol,
        port,
        moshEnabled: protocol === 'mosh',
      };
      handleConnectToHost(hostWithProtocol);
      setProtocolSelectHost(null);
    }
  }, [protocolSelectHost, handleConnectToHost]);

  const handleToggleTheme = useCallback(() => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark');
  }, [setTheme]);

  const handleOpenQuickSwitcher = useCallback(() => {
    setIsQuickSwitcherOpen(true);
  }, []);

  const { openSettingsWindow } = useWindowControls();

  const handleOpenSettings = useCallback(() => {
    // Try to open in a separate window, fallback to modal dialog
    void (async () => {
      const opened = await openSettingsWindow();
      if (!opened) setIsSettingsOpen(true);
    })();
  }, [openSettingsWindow]);

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
        logViews={logViews}
        orderedTabs={orderedTabs}
        draggingSessionId={draggingSessionId}
        isMacClient={isMacClient}
        onCloseSession={closeSession}
        onRenameWorkspace={startWorkspaceRename}
        onCloseWorkspace={closeWorkspace}
        onCloseLogView={closeLogView}
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
            connectionLogs={connectionLogs}
            sessions={sessions}
            onOpenSettings={handleOpenSettings}
            onOpenQuickSwitcher={handleOpenQuickSwitcher}
            onCreateLocalTerminal={handleCreateLocalTerminal}
            onDeleteHost={handleDeleteHost}
            onConnect={handleConnectToHost}
            onUpdateHosts={updateHosts}
            onUpdateKeys={updateKeys}
            onUpdateSnippets={updateSnippets}
            onUpdateSnippetPackages={updateSnippetPackages}
            onUpdateCustomGroups={updateCustomGroups}
            onUpdateKnownHosts={updateKnownHosts}
            onConvertKnownHost={convertKnownHostToHost}
            onToggleConnectionLogSaved={toggleConnectionLogSaved}
            onDeleteConnectionLog={deleteConnectionLog}
            onClearUnsavedConnectionLogs={clearUnsavedConnectionLogs}
            onRunSnippet={runSnippet}
            onOpenLogView={openLogView}
            navigateToSection={navigateToSection}
            onNavigateToSectionHandled={() => setNavigateToSection(null)}
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
          terminalSettings={terminalSettings}
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
          onTerminalDataCapture={handleTerminalDataCapture}
          onCreateWorkspaceFromSessions={createWorkspaceFromSessions}
          onAddSessionToWorkspace={addSessionToWorkspace}
          onUpdateSplitSizes={updateSplitSizes}
          onSetDraggingSessionId={setDraggingSessionId}
          onToggleWorkspaceViewMode={toggleWorkspaceViewMode}
          onSetWorkspaceFocusedSession={setWorkspaceFocusedSession}
          onSplitSession={splitSession}
          isBroadcastEnabled={isBroadcastEnabled}
          onToggleBroadcast={toggleBroadcast}
        />

        {/* Log Views - readonly terminal replays */}
        {logViews.map(logView => (
          <LogViewWrapper
            key={logView.id}
            logView={logView}
            terminalTheme={currentTerminalTheme}
            fontSize={terminalFontSize}
            onClose={() => closeLogView(logView.id)}
          />
        ))}
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
          handleCreateLocalTerminal();
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
        keyBindings={keyBindings}
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
        customCSS={customCSS}
        onCustomCSSChange={setCustomCSS}
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
