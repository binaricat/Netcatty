import React, { useState, useEffect, useMemo } from 'react';
import SettingsDialog from './components/SettingsDialog';
import HostDetailsPanel from './components/HostDetailsPanel';
import { SftpView } from './components/SftpView';
import { TopTabs } from './components/TopTabs';
import { QuickSwitcher } from './components/QuickSwitcher';
import { VaultView } from './components/VaultView';
import { TerminalLayer } from './components/TerminalLayer';
import { normalizeDistroId } from './components/DistroAvatar';
import { INITIAL_HOSTS, INITIAL_SNIPPETS } from './lib/defaultData';
import {
  STORAGE_KEY_COLOR,
  STORAGE_KEY_GROUPS,
  STORAGE_KEY_HOSTS,
  STORAGE_KEY_KEYS,
  STORAGE_KEY_SNIPPET_PACKAGES,
  STORAGE_KEY_SNIPPETS,
  STORAGE_KEY_SYNC,
  STORAGE_KEY_TERM_THEME,
  STORAGE_KEY_THEME,
} from './lib/storageKeys';
import { Host, SSHKey, Snippet, SyncConfig, TerminalSession, Workspace, WorkspaceNode } from './types';
import { TERMINAL_THEMES } from './lib/terminalThemes';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from './components/ui/dialog';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';


function App() {
  const sanitizeHost = (host: Host): Host => {
    const cleanHostname = (host.hostname || '').split(/\s+/)[0];
    const cleanDistro = normalizeDistroId(host.distro);
    return { ...host, hostname: cleanHostname, distro: cleanDistro };
  };

  const [theme, setTheme] = useState<'dark' | 'light'>(() => (localStorage.getItem(STORAGE_KEY_THEME) as any) || 'light');
  const [primaryColor, setPrimaryColor] = useState<string>(() => localStorage.getItem(STORAGE_KEY_COLOR) || '221.2 83.2% 53.3%');
  const [syncConfig, setSyncConfig] = useState<SyncConfig | null>(() => {
      const saved = localStorage.getItem(STORAGE_KEY_SYNC);
      return saved ? JSON.parse(saved) : null;
  });
  const [terminalThemeId, setTerminalThemeId] = useState<string>(() => localStorage.getItem(STORAGE_KEY_TERM_THEME) || 'termius-dark');

  // Data
  const [hosts, setHosts] = useState<Host[]>([]);
  const [keys, setKeys] = useState<SSHKey[]>([]);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [customGroups, setCustomGroups] = useState<string[]>([]);
  const [workspaceRenameTarget, setWorkspaceRenameTarget] = useState<Workspace | null>(null);
  const [workspaceRenameValue, setWorkspaceRenameValue] = useState('');
  
  // Navigation & Sessions
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>('vault'); // 'vault', session.id, or workspace.id
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);

  // Modals
  const [editingHost, setEditingHost] = useState<Host | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isQuickSwitcherOpen, setIsQuickSwitcherOpen] = useState(false);
  const [quickSearch, setQuickSearch] = useState('');

  // Vault View State
  const [showAssistant, setShowAssistant] = useState(false);
  const [snippetPackages, setSnippetPackages] = useState<string[]>([]);

  const createLocalTerminal = () => {
    const sessionId = crypto.randomUUID();
    const localHostId = `local-${sessionId}`;
    const newSession: TerminalSession = {
      id: sessionId,
      hostId: localHostId,
      hostLabel: 'Local Terminal',
      hostname: 'localhost',
      username: 'local',
      status: 'connecting',
    };
    setSessions(prev => [...prev, newSession]);
    setActiveTabId(sessionId);
  };

  // --- Effects ---
  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(theme);
    root.style.setProperty('--primary', primaryColor);
    root.style.setProperty('--accent', primaryColor);
    root.style.setProperty('--ring', primaryColor);
    const lightness = parseFloat(primaryColor.split(/\s+/)[2]?.replace('%', '') || '');
    const accentForeground = theme === 'dark'
      ? '220 40% 96%'
      : (!Number.isNaN(lightness) && lightness < 55 ? '0 0% 98%' : '222 47% 12%');
    root.style.setProperty('--accent-foreground', accentForeground);
    localStorage.setItem(STORAGE_KEY_THEME, theme);
    localStorage.setItem(STORAGE_KEY_COLOR, primaryColor);
  }, [theme, primaryColor]);

  useEffect(() => {
      localStorage.setItem(STORAGE_KEY_TERM_THEME, terminalThemeId);
  }, [terminalThemeId]);

  useEffect(() => {
    const savedHosts = localStorage.getItem(STORAGE_KEY_HOSTS);
    const savedKeys = localStorage.getItem(STORAGE_KEY_KEYS);
    const savedGroups = localStorage.getItem(STORAGE_KEY_GROUPS);
    const savedSnippets = localStorage.getItem(STORAGE_KEY_SNIPPETS);
    const savedSnippetPackages = localStorage.getItem(STORAGE_KEY_SNIPPET_PACKAGES);
    
    if (savedHosts) {
      const sanitized = JSON.parse(savedHosts).map((h: Host) => sanitizeHost(h));
      setHosts(sanitized);
      localStorage.setItem(STORAGE_KEY_HOSTS, JSON.stringify(sanitized));
    } else updateHosts(INITIAL_HOSTS);

    if (savedKeys) setKeys(JSON.parse(savedKeys));
    if (savedSnippets) setSnippets(JSON.parse(savedSnippets));
    else updateSnippets(INITIAL_SNIPPETS);
    if (savedSnippetPackages) setSnippetPackages(JSON.parse(savedSnippetPackages));
    
    if (savedGroups) setCustomGroups(JSON.parse(savedGroups));
  }, []);

  const updateHosts = (d: Host[]) => {
    const cleaned = d.map(sanitizeHost);
    setHosts(cleaned);
    localStorage.setItem(STORAGE_KEY_HOSTS, JSON.stringify(cleaned));
  };
  const updateKeys = (d: SSHKey[]) => { setKeys(d); localStorage.setItem(STORAGE_KEY_KEYS, JSON.stringify(d)); };
  const updateSnippets = (d: Snippet[]) => { setSnippets(d); localStorage.setItem(STORAGE_KEY_SNIPPETS, JSON.stringify(d)); };
  const updateSnippetPackages = (d: string[]) => { setSnippetPackages(d); localStorage.setItem(STORAGE_KEY_SNIPPET_PACKAGES, JSON.stringify(d)); };
  const updateCustomGroups = (d: string[]) => { setCustomGroups(d); localStorage.setItem(STORAGE_KEY_GROUPS, JSON.stringify(d)); };
  const updateSyncConfig = (d: SyncConfig | null) => { setSyncConfig(d); localStorage.setItem(STORAGE_KEY_SYNC, JSON.stringify(d)); };

  // --- Session Management ---
  const handleConnect = (host: Host) => {
    const newSession: TerminalSession = {
        id: crypto.randomUUID(),
        hostId: host.id,
        hostLabel: host.label,
        hostname: host.hostname,
        username: host.username,
        status: 'connecting'
    };
    setSessions(prev => [...prev, newSession]);
    setActiveTabId(newSession.id);
  };

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

  const updateSessionStatus = (sessionId: string, status: TerminalSession['status']) => {
    setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, status } : s));
  };

  const updateHostDistro = (hostId: string, distro: string) => {
    const normalized = normalizeDistroId(distro);
    setHosts(prev => {
      const next = prev.map(h => h.id === hostId ? { ...h, distro: normalized } : h);
      localStorage.setItem(STORAGE_KEY_HOSTS, JSON.stringify(next));
      return next;
    });
  };

  const pruneWorkspaceNode = (node: WorkspaceNode, targetSessionId: string): WorkspaceNode | null => {
    if (node.type === 'pane') {
      return node.sessionId === targetSessionId ? null : node;
    }
    const nextChildren: WorkspaceNode[] = [];
    const nextSizes: number[] = [];
    const sizeList = node.sizes && node.sizes.length === node.children.length ? node.sizes : node.children.map(() => 1);

    node.children.forEach((child, idx) => {
      const pruned = pruneWorkspaceNode(child, targetSessionId);
      if (pruned) {
        nextChildren.push(pruned);
        nextSizes.push(sizeList[idx] ?? 1);
      }
    });

    if (nextChildren.length === 0) return null;
    if (nextChildren.length === 1) return nextChildren[0];

    const total = nextSizes.reduce((acc, n) => acc + n, 0) || 1;
    const normalized = nextSizes.map(n => n / total);
    return { ...node, children: nextChildren, sizes: normalized };
  };

  const closeSession = (sessionId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    const targetSession = sessions.find(s => s.id === sessionId);
    const workspaceId = targetSession?.workspaceId;
    let removedWorkspaceId: string | null = null;

    let nextWorkspaces = workspaces;
    if (workspaceId) {
      nextWorkspaces = workspaces
        .map(ws => {
          if (ws.id !== workspaceId) return ws;
          const pruned = pruneWorkspaceNode(ws.root, sessionId);
          if (!pruned) {
            removedWorkspaceId = ws.id;
            return null;
          }
          return { ...ws, root: pruned };
        })
        .filter((ws): ws is Workspace => Boolean(ws));
    }

    const remainingSessions = sessions.filter(s => s.id !== sessionId);
    setWorkspaces(nextWorkspaces);
    setSessions(remainingSessions);

    const fallbackWorkspace = nextWorkspaces[nextWorkspaces.length - 1];
    const fallbackSolo = remainingSessions.filter(s => !s.workspaceId).slice(-1)[0];

    const setFallback = () => {
      if (fallbackWorkspace) setActiveTabId(fallbackWorkspace.id);
      else if (fallbackSolo) setActiveTabId(fallbackSolo.id);
      else setActiveTabId('vault');
    };

    if (activeTabId === sessionId) {
      if (fallbackSolo) setActiveTabId(fallbackSolo.id);
      else setFallback();
    } else if (removedWorkspaceId && activeTabId === removedWorkspaceId) {
      setFallback();
    } else if (workspaceId && activeTabId === workspaceId && !nextWorkspaces.find(w => w.id === workspaceId)) {
      setFallback();
    }
  };

  const closeWorkspace = (workspaceId: string) => {
    const remainingWorkspaces = workspaces.filter(w => w.id !== workspaceId);
    const remainingSessions = sessions.filter(s => s.workspaceId !== workspaceId);
    setWorkspaces(remainingWorkspaces);
    setSessions(remainingSessions);

    if (activeTabId === workspaceId) {
      const remainingOrphans = remainingSessions.filter(s => !s.workspaceId);
      if (remainingWorkspaces.length > 0) {
        setActiveTabId(remainingWorkspaces[remainingWorkspaces.length - 1].id);
      } else if (remainingOrphans.length > 0) {
        setActiveTabId(remainingOrphans[remainingOrphans.length - 1].id);
      } else {
        setActiveTabId('vault');
      }
    }
  };

  const renameWorkspace = (workspaceId: string) => {
    const target = workspaces.find(w => w.id === workspaceId);
    if (!target) return;
    setWorkspaceRenameTarget(target);
    setWorkspaceRenameValue(target.title);
  };

  const submitWorkspaceRename = () => {
    const name = workspaceRenameValue.trim();
    if (!name || !workspaceRenameTarget) return;
    setWorkspaces(prev => prev.map(w => w.id === workspaceRenameTarget.id ? { ...w, title: name } : w));
    setWorkspaceRenameTarget(null);
    setWorkspaceRenameValue('');
  };

  const createWorkspaceFromSessions = (
    baseSessionId: string,
    joiningSessionId: string,
    hint: { direction: 'horizontal' | 'vertical'; position: 'left' | 'right' | 'top' | 'bottom'; targetSessionId?: string }
  ) => {
    if (!hint || baseSessionId === joiningSessionId) return;
    const base = sessions.find(s => s.id === baseSessionId);
    const joining = sessions.find(s => s.id === joiningSessionId);
    if (!base || !joining || base.workspaceId || joining.workspaceId) return;

    const basePane: WorkspaceNode = { id: crypto.randomUUID(), type: 'pane', sessionId: baseSessionId };
    const newPane: WorkspaceNode = { id: crypto.randomUUID(), type: 'pane', sessionId: joiningSessionId };
    const children = (hint.position === 'left' || hint.position === 'top') ? [newPane, basePane] : [basePane, newPane];

    const newWorkspace: Workspace = {
      id: `ws-${crypto.randomUUID()}`,
      title: 'Workspace',
      root: {
        id: crypto.randomUUID(),
        type: 'split',
        direction: hint.direction,
        children,
        sizes: [1, 1],
      },
    };

    setWorkspaces(prev => [...prev, newWorkspace]);
    setSessions(prev => prev.map(s => {
      if (s.id === baseSessionId || s.id === joiningSessionId) {
        return { ...s, workspaceId: newWorkspace.id };
      }
      return s;
    }));
    setActiveTabId(newWorkspace.id);
  };

  const addSessionToWorkspace = (
    workspaceId: string,
    sessionId: string,
    hint: { direction: 'horizontal' | 'vertical'; position: 'left' | 'right' | 'top' | 'bottom'; targetSessionId?: string } | null
  ) => {
    const targetWorkspace = workspaces.find(w => w.id === workspaceId);
    if (!targetWorkspace || !hint) return;
    const session = sessions.find(s => s.id === sessionId);
    if (!session || session.workspaceId) return;

    const targetSessionId = hint.targetSessionId;
    const insertPane = (node: WorkspaceNode): WorkspaceNode => {
      if (node.type === 'pane' && node.sessionId === targetSessionId) {
        const pane: WorkspaceNode = { id: crypto.randomUUID(), type: 'pane', sessionId };
        const children = (hint.position === 'left' || hint.position === 'top') ? [pane, node] : [node, pane];
        return {
          id: crypto.randomUUID(),
          type: 'split',
          direction: hint.direction,
          children,
          sizes: [1, 1],
        };
      }
      if (node.type === 'split') {
        return {
          ...node,
          children: node.children.map(child => insertPane(child)),
        };
      }
      return node;
    };

    setWorkspaces(prev => prev.map(ws => {
      if (ws.id !== workspaceId) return ws;
      let newRoot = ws.root;
      if (targetSessionId) {
        newRoot = insertPane(ws.root);
      } else {
        const pane: WorkspaceNode = { id: crypto.randomUUID(), type: 'pane', sessionId };
        newRoot = {
          id: crypto.randomUUID(),
          type: 'split',
          direction: hint.direction,
          children: (hint.position === 'left' || hint.position === 'top') ? [pane, ws.root] : [ws.root, pane],
          sizes: [1, 1],
        };
      }
      return { ...ws, root: newRoot };
    }));

    setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, workspaceId } : s));
    setActiveTabId(workspaceId);
  };

  // --- Data Logic ---
  const getExportData = () => ({ hosts, keys, snippets, customGroups });
  const handleImportData = (jsonString: string) => {
      const data = JSON.parse(jsonString);
      if(data.hosts) updateHosts(data.hosts);
      if(data.keys) updateKeys(data.keys);
      if(data.snippets) updateSnippets(data.snippets);
      if(data.customGroups) updateCustomGroups(data.customGroups);
  };

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
  
  const currentTerminalTheme = TERMINAL_THEMES.find(t => t.id === terminalThemeId) || TERMINAL_THEMES[0];
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

  const orphanSessions = useMemo(() => sessions.filter(s => !s.workspaceId), [sessions]);
  const updateSplitSizes = (workspaceId: string, splitId: string, sizes: number[]) => {
    setWorkspaces(prev => prev.map(ws => {
      if (ws.id !== workspaceId) return ws;
      const patch = (node: WorkspaceNode): WorkspaceNode => {
        if (node.type === 'split') {
          if (node.id === splitId) {
            return { ...node, sizes };
          }
          return { ...node, children: node.children.map(child => patch(child)) };
        }
        return node;
      };
      return { ...ws, root: patch(ws.root) };
    }));
  };

  const handleSessionDragStart = (sessionId: string) => setDraggingSessionId(sessionId);
  const handleSessionDragEnd = () => setDraggingSessionId(null);


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
        onRenameWorkspace={renameWorkspace}
        onCloseWorkspace={closeWorkspace}
        onOpenQuickSwitcher={() => setIsQuickSwitcherOpen(true)}
        onToggleTheme={() => setTheme(prev => prev === 'dark' ? 'light' : 'dark')}
        onStartSessionDrag={handleSessionDragStart}
        onEndSessionDrag={handleSessionDragEnd}
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
          onConnect={handleConnect}
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
          handleConnect(host);
          setIsQuickSwitcherOpen(false);
          setQuickSearch('');
        }}
        onCreateLocalTerminal={createLocalTerminal}
        onClose={() => setIsQuickSwitcherOpen(false)}
      />

      <Dialog open={!!workspaceRenameTarget} onOpenChange={(open) => {
        if (!open) {
          setWorkspaceRenameTarget(null);
          setWorkspaceRenameValue('');
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
            <Button variant="ghost" onClick={() => { setWorkspaceRenameTarget(null); setWorkspaceRenameValue(''); }}>Cancel</Button>
            <Button onClick={submitWorkspaceRename} disabled={!workspaceRenameValue.trim()}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Host Panel */}
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
        onImport={handleImportData}
        exportData={getExportData}
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
