import React, { useMemo, useState, memo, useCallback } from 'react';
import { AppLogo } from './AppLogo';
import {
  Activity,
  BookMarked,
  ChevronDown,
  FolderPlus,
  FolderTree,
  Edit2,
  FileCode,
  Key,
  LayoutGrid,
  List,
  Plug,
  Plus,
  Search,
  Settings,
  Trash2,
  TerminalSquare,
  Upload,
  Zap,
} from 'lucide-react';
import { Host, SSHKey, Snippet, GroupNode, TerminalSession, KnownHost, ShellHistoryEntry, HostProtocol } from '../types';
import { DistroAvatar } from './DistroAvatar';
import SnippetsManager from './SnippetsManager';
import KeychainManager from './KeychainManager';
import PortForwarding from './PortForwardingNew';
import KnownHostsManager from './KnownHostsManager';
import HostDetailsPanel from './HostDetailsPanel';
import QuickConnectWizard, { parseQuickConnectInput, isQuickConnectInput } from './QuickConnectWizard';
import ProtocolSelectDialog from './ProtocolSelectDialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Dropdown, DropdownTrigger, DropdownContent } from './ui/dropdown';
import { cn } from '../lib/utils';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from './ui/context-menu';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Label } from './ui/label';
import { SortDropdown, SortMode } from './ui/sort-dropdown';
import { TagFilterDropdown } from './ui/tag-filter-dropdown';
import { sanitizeHost } from '../domain/host';
import { useIsVaultActive } from '../application/state/activeTabStore';

type VaultSection = 'hosts' | 'keys' | 'snippets' | 'port' | 'knownhosts';

// Props without isActive - it's now subscribed internally
interface VaultViewProps {
  hosts: Host[];
  keys: SSHKey[];
  snippets: Snippet[];
  snippetPackages: string[];
  customGroups: string[];
  knownHosts: KnownHost[];
  shellHistory: ShellHistoryEntry[];
  sessions: TerminalSession[];
  onOpenSettings: () => void;
  onOpenQuickSwitcher: () => void;
  onCreateLocalTerminal: () => void;
  onDeleteHost: (id: string) => void;
  onConnect: (host: Host) => void;
  onUpdateHosts: (hosts: Host[]) => void;
  onUpdateKeys: (keys: SSHKey[]) => void;
  onUpdateSnippets: (snippets: Snippet[]) => void;
  onUpdateSnippetPackages: (pkgs: string[]) => void;
  onUpdateCustomGroups: (groups: string[]) => void;
  onUpdateKnownHosts: (knownHosts: KnownHost[]) => void;
  onConvertKnownHost: (knownHost: KnownHost) => void;
  onRunSnippet?: (snippet: Snippet, targetHosts: Host[]) => void;
}

const VaultViewInner: React.FC<VaultViewProps> = ({
  hosts,
  keys,
  snippets,
  snippetPackages,
  customGroups,
  knownHosts,
  shellHistory,
  sessions,
  onOpenSettings,
  onOpenQuickSwitcher,
  onCreateLocalTerminal,
  onDeleteHost,
  onConnect,
  onUpdateHosts,
  onUpdateKeys,
  onUpdateSnippets,
  onUpdateSnippetPackages,
  onUpdateCustomGroups,
  onUpdateKnownHosts,
  onConvertKnownHost,
  onRunSnippet,
}) => {
  const [currentSection, setCurrentSection] = useState<VaultSection>('hosts');
  const [search, setSearch] = useState('');
  const [selectedGroupPath, setSelectedGroupPath] = useState<string | null>(null);
  const [isNewFolderOpen, setIsNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [targetParentPath, setTargetParentPath] = useState<string | null>(null);

  // View mode, sorting, and tag filter state
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [sortMode, setSortMode] = useState<SortMode>('az');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  // Host panel state (local to hosts section)
  const [isHostPanelOpen, setIsHostPanelOpen] = useState(false);
  const [editingHost, setEditingHost] = useState<Host | null>(null);

  // Quick connect state
  const [quickConnectTarget, setQuickConnectTarget] = useState<{ hostname: string; username?: string; port?: number } | null>(null);
  const [isQuickConnectOpen, setIsQuickConnectOpen] = useState(false);

  // Protocol select state (for hosts with multiple protocols)
  const [protocolSelectHost, setProtocolSelectHost] = useState<Host | null>(null);

  // Check if search input is a quick connect address
  const isSearchQuickConnect = useMemo(() => {
    return isQuickConnectInput(search);
  }, [search]);

  // Handle connect button click - detect quick connect or regular search
  const handleConnectClick = useCallback(() => {
    if (isSearchQuickConnect) {
      const target = parseQuickConnectInput(search);
      if (target) {
        setQuickConnectTarget(target);
        setIsQuickConnectOpen(true);
      }
    } else {
      onOpenQuickSwitcher();
    }
  }, [isSearchQuickConnect, search, onOpenQuickSwitcher]);

  // Handle search input keydown for quick connect
  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && isSearchQuickConnect) {
      e.preventDefault();
      handleConnectClick();
    }
  }, [isSearchQuickConnect, handleConnectClick]);

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

  // Handle host connect with protocol selection
  const handleHostConnect = useCallback((host: Host) => {
    if (hasMultipleProtocols(host)) {
      setProtocolSelectHost(host);
    } else {
      onConnect(host);
    }
  }, [hasMultipleProtocols, onConnect]);

  // Handle protocol selection
  const handleProtocolSelect = useCallback((protocol: HostProtocol, port: number) => {
    if (protocolSelectHost) {
      const hostWithProtocol: Host = {
        ...protocolSelectHost,
        protocol: protocol === 'mosh' ? 'ssh' : protocol,
        port,
        moshEnabled: protocol === 'mosh',
      };
      onConnect(hostWithProtocol);
      setProtocolSelectHost(null);
    }
  }, [protocolSelectHost, onConnect]);

  // Handle quick connect
  const handleQuickConnect = useCallback((host: Host) => {
    onConnect(host);
    setIsQuickConnectOpen(false);
    setQuickConnectTarget(null);
    setSearch('');
  }, [onConnect]);

  // Handle quick connect save host
  const handleQuickConnectSaveHost = useCallback((host: Host) => {
    onUpdateHosts([...hosts, host]);
  }, [hosts, onUpdateHosts]);

  const handleNewHost = useCallback(() => {
    setEditingHost(null);
    setIsHostPanelOpen(true);
  }, []);

  const handleEditHost = useCallback((host: Host) => {
    setEditingHost(host);
    setIsHostPanelOpen(true);
  }, []);

  const buildGroupTree = useMemo<Record<string, GroupNode>>(() => {
    const root: Record<string, GroupNode> = {};
    const insertPath = (path: string, host?: Host) => {
      const parts = path.split('/').filter(Boolean);
      let currentLevel = root;
      let currentPath = '';
      parts.forEach((part, index) => {
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        if (!currentLevel[part]) {
          currentLevel[part] = { name: part, path: currentPath, children: {}, hosts: [] };
        }
        if (host && index === parts.length - 1) currentLevel[part].hosts.push(host);
        currentLevel = currentLevel[part].children;
      });
    };
    customGroups.forEach(path => insertPath(path));
    hosts.forEach(host => insertPath(host.group || 'General', host));
    return root;
  }, [hosts, customGroups]);

  const findGroupNode = (path: string | null): GroupNode | null => {
    if (!path) return { name: 'root', path: '', children: buildGroupTree, hosts: [] } as any;
    const parts = path.split('/').filter(Boolean);
    let current: any = { children: buildGroupTree };
    for (const p of parts) {
      current = current.children?.[p];
      if (!current) return null;
    }
    return current;
  };

  const displayedHosts = useMemo(() => {
    let filtered = hosts;
    if (selectedGroupPath) {
      filtered = filtered.filter(h => (h.group || '') === selectedGroupPath);
    }
    if (search.trim()) {
      const s = search.toLowerCase();
      filtered = filtered.filter(h =>
        h.label.toLowerCase().includes(s) ||
        h.hostname.toLowerCase().includes(s) ||
        h.tags.some(t => t.toLowerCase().includes(s))
      );
    }
    // Apply tag filter
    if (selectedTags.length > 0) {
      filtered = filtered.filter(h => selectedTags.some(t => h.tags?.includes(t)));
    }
    // Apply sorting
    filtered = [...filtered].sort((a, b) => {
      switch (sortMode) {
        case 'az':
          return a.label.localeCompare(b.label);
        case 'za':
          return b.label.localeCompare(a.label);
        case 'newest':
          return (b.createdAt || 0) - (a.createdAt || 0);
        case 'oldest':
          return (a.createdAt || 0) - (b.createdAt || 0);
        default:
          return 0;
      }
    });
    return filtered;
  }, [hosts, selectedGroupPath, search, selectedTags, sortMode]);

  // Compute all unique tags across all hosts
  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    hosts.forEach(h => h.tags?.forEach(t => tagSet.add(t)));
    return Array.from(tagSet).sort();
  }, [hosts]);

  // Handle tag edit - rename tag across all hosts
  const handleEditTag = useCallback((oldTag: string, newTag: string) => {
    if (oldTag === newTag) return;
    const updatedHosts = hosts.map(host => {
      if (host.tags?.includes(oldTag)) {
        const newTags = host.tags.map(t => t === oldTag ? newTag : t);
        // Remove duplicates in case newTag already exists
        return { ...host, tags: Array.from(new Set(newTags)) };
      }
      return host;
    });
    onUpdateHosts(updatedHosts);
  }, [hosts, onUpdateHosts]);

  // Handle tag delete - remove tag from all hosts
  const handleDeleteTag = useCallback((tag: string) => {
    const updatedHosts = hosts.map(host => {
      if (host.tags?.includes(tag)) {
        return { ...host, tags: host.tags.filter(t => t !== tag) };
      }
      return host;
    });
    onUpdateHosts(updatedHosts);
  }, [hosts, onUpdateHosts]);

  const displayedGroups = useMemo(() => {
    if (!selectedGroupPath) {
      return (Object.values(buildGroupTree) as GroupNode[]).sort((a, b) => a.name.localeCompare(b.name));
    }
    const node = findGroupNode(selectedGroupPath);
    if (!node || !node.children) return [];
    return (Object.values(node.children) as GroupNode[]).sort((a, b) => a.name.localeCompare(b.name));
  }, [buildGroupTree, selectedGroupPath]);

  // Known Hosts callbacks - use refs to keep stable references
  // Store latest values in refs so callbacks don't need to depend on them
  const knownHostsRef = React.useRef(knownHosts);
  const onUpdateKnownHostsRef = React.useRef(onUpdateKnownHosts);

  // Keep refs up to date
  React.useEffect(() => {
    knownHostsRef.current = knownHosts;
    onUpdateKnownHostsRef.current = onUpdateKnownHosts;
  });

  // Stable callbacks that read from refs
  const handleSaveKnownHost = useCallback((kh: KnownHost) => {
    onUpdateKnownHostsRef.current([...knownHostsRef.current, kh]);
  }, []);

  const handleUpdateKnownHost = useCallback((kh: KnownHost) => {
    onUpdateKnownHostsRef.current(knownHostsRef.current.map(existing => existing.id === kh.id ? kh : existing));
  }, []);

  const handleDeleteKnownHost = useCallback((id: string) => {
    onUpdateKnownHostsRef.current(knownHostsRef.current.filter(kh => kh.id !== id));
  }, []);

  const handleImportKnownHosts = useCallback((newHosts: KnownHost[]) => {
    onUpdateKnownHostsRef.current([...knownHostsRef.current, ...newHosts]);
  }, []);

  const handleRefreshKnownHosts = useCallback(() => {
    // Placeholder for system scan
  }, []);

  // Memoize the KnownHostsManager element to prevent re-renders when VaultViewInner re-renders
  const knownHostsManagerElement = useMemo(() => {
    return (
      <KnownHostsManager
        knownHosts={knownHosts}
        hosts={hosts}
        onSave={handleSaveKnownHost}
        onUpdate={handleUpdateKnownHost}
        onDelete={handleDeleteKnownHost}
        onConvertToHost={onConvertKnownHost}
        onImportFromFile={handleImportKnownHosts}
        onRefresh={handleRefreshKnownHosts}
      />
    );
  }, [knownHosts, hosts, onConvertKnownHost]);

  const submitNewFolder = () => {
    if (!newFolderName.trim()) return;
    const fullPath = targetParentPath ? `${targetParentPath}/${newFolderName.trim()}` : newFolderName.trim();
    onUpdateCustomGroups(Array.from(new Set([...customGroups, fullPath])));
    setIsNewFolderOpen(false);
  };

  const deleteGroupPath = (path: string) => {
    const keepGroups = customGroups.filter(g => !(g === path || g.startsWith(path + '/')));
    const keepHosts = hosts.map(h => {
      const g = h.group || '';
      if (g === path || g.startsWith(path + '/')) return { ...h, group: '' };
      return h;
    });
    onUpdateCustomGroups(keepGroups);
    onUpdateHosts(keepHosts);
    if (selectedGroupPath && (selectedGroupPath === path || selectedGroupPath.startsWith(path + '/'))) {
      setSelectedGroupPath(null);
    }
  };

  const moveGroup = (sourcePath: string, targetParent: string | null) => {
    const name = sourcePath.split('/').filter(Boolean).pop() || '';
    const newPath = targetParent ? `${targetParent}/${name}` : name;
    if (newPath === sourcePath || newPath.startsWith(sourcePath + '/')) return;
    const updatedGroups = customGroups.map(g => {
      if (g === sourcePath) return newPath;
      if (g.startsWith(sourcePath + '/')) return g.replace(sourcePath, newPath);
      return g;
    });
    const updatedHosts = hosts.map(h => {
      const g = h.group || '';
      if (g === sourcePath) return { ...h, group: newPath };
      if (g.startsWith(sourcePath + '/')) return { ...h, group: g.replace(sourcePath, newPath) };
      return h;
    });
    onUpdateCustomGroups(Array.from(new Set(updatedGroups)));
    onUpdateHosts(updatedHosts);
    if (selectedGroupPath && (selectedGroupPath === sourcePath || selectedGroupPath.startsWith(sourcePath + '/'))) {
      setSelectedGroupPath(newPath);
    }
  };

  const moveHostToGroup = (hostId: string, groupPath: string | null) => {
    onUpdateHosts(hosts.map(h => h.id === hostId ? { ...h, group: groupPath || '' } : h));
  };

  // Component no longer handles visibility - that's done by VaultViewWrapper
  return (
    <div
      className="absolute inset-0 min-h-0 flex"
    >
      {/* Sidebar */}
      <div className="w-52 bg-secondary/80 border-r border-border/60 flex flex-col">
        <div className="px-4 py-4 flex items-center gap-3">
          <AppLogo className="h-10 w-10 rounded-xl" />
          <div>
            <p className="text-sm font-bold text-foreground">Netcatty</p>
          </div>
        </div>

        <div className="px-3 space-y-1">
          <Button variant={currentSection === 'hosts' ? 'secondary' : 'ghost'} className={cn("w-full justify-start gap-3 h-10", currentSection === 'hosts' && "bg-black/5 dark:bg-white/10 text-foreground hover:bg-black/10 dark:hover:bg-white/15 dark:border-white/10")} onClick={() => { setCurrentSection('hosts'); setSelectedGroupPath(null); }}>
            <LayoutGrid size={16} /> Hosts
          </Button>
          <Button variant={currentSection === 'keys' ? 'secondary' : 'ghost'} className={cn("w-full justify-start gap-3 h-10", currentSection === 'keys' && "bg-black/5 dark:bg-white/10 text-foreground hover:bg-black/10 dark:hover:bg-white/15 dark:border-white/10")} onClick={() => { setCurrentSection('keys'); }}>
            <Key size={16} /> Keychain
          </Button>
          <Button variant={currentSection === 'port' ? 'secondary' : 'ghost'} className={cn("w-full justify-start gap-3 h-10", currentSection === 'port' && "bg-black/5 dark:bg-white/10 text-foreground hover:bg-black/10 dark:hover:bg-white/15 dark:border-white/10")} onClick={() => setCurrentSection('port')}>
            <Plug size={16} /> Port Forwarding
          </Button>
          <Button variant={currentSection === 'snippets' ? 'secondary' : 'ghost'} className={cn("w-full justify-start gap-3 h-10", currentSection === 'snippets' && "bg-black/5 dark:bg-white/10 text-foreground hover:bg-black/10 dark:hover:bg-white/15 dark:border-white/10")} onClick={() => { setCurrentSection('snippets'); }}>
            <FileCode size={16} /> Snippets
          </Button>
          <Button variant={currentSection === 'knownhosts' ? 'secondary' : 'ghost'} className={cn("w-full justify-start gap-3 h-10", currentSection === 'knownhosts' && "bg-black/5 dark:bg-white/10 text-foreground hover:bg-black/10 dark:hover:bg-white/15 dark:border-white/10")} onClick={() => setCurrentSection('knownhosts')}>
            <BookMarked size={16} /> Known Hosts
          </Button>
          <Button variant="ghost" className="w-full justify-start gap-3 h-10">
            <Activity size={16} /> Logs
          </Button>
        </div>

        <div className="mt-auto px-3 pb-4 space-y-2">
          <Button variant="ghost" className="w-full justify-start gap-3" onClick={onOpenSettings}>
            <Settings size={16} /> Settings
          </Button>
        </div>
      </div>

      {/* Main Area */}
      <div className="flex-1 flex flex-col min-h-0 relative">
        {currentSection === 'hosts' && (
          <header className="border-b border-border/50 bg-secondary/80 backdrop-blur">
            <div className="h-14 px-4 py-2 flex items-center gap-3">
              <div className="relative flex-1">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Find a host or ssh user@hostname..."
                  className={cn(
                    "pl-9 h-10 bg-secondary border-border/60 text-sm",
                    isSearchQuickConnect && "border-primary/50 ring-1 ring-primary/20"
                  )}
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  onKeyDown={handleSearchKeyDown}
                />
                {isSearchQuickConnect && (
                  <div className="absolute right-3 top-1/2 -translate-y-1/2">
                    <Zap size={14} className="text-primary" />
                  </div>
                )}
              </div>
              <Button
                variant={isSearchQuickConnect ? "default" : "secondary"}
                className="h-10 px-4"
                onClick={handleConnectClick}
              >
                Connect
              </Button>
              {/* View mode, tag filter, and sort controls */}
              <div className="flex items-center gap-1">
                <Dropdown>
                  <DropdownTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-10 w-10">
                      {viewMode === 'grid' ? <LayoutGrid size={16} /> : <List size={16} />}
                      <ChevronDown size={10} className="ml-0.5" />
                    </Button>
                  </DropdownTrigger>
                  <DropdownContent className="w-32" align="end">
                    <Button
                      variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
                      className="w-full justify-start gap-2 h-9"
                      onClick={() => setViewMode('grid')}
                    >
                      <LayoutGrid size={14} /> Grid
                    </Button>
                    <Button
                      variant={viewMode === 'list' ? 'secondary' : 'ghost'}
                      className="w-full justify-start gap-2 h-9"
                      onClick={() => setViewMode('list')}
                    >
                      <List size={14} /> List
                    </Button>
                  </DropdownContent>
                </Dropdown>
                <TagFilterDropdown
                  allTags={allTags}
                  selectedTags={selectedTags}
                  onChange={setSelectedTags}
                  onEditTag={handleEditTag}
                  onDeleteTag={handleDeleteTag}
                  className="h-10 w-10"
                />
                <SortDropdown
                  value={sortMode}
                  onChange={setSortMode}
                  className="h-10 w-10"
                />
              </div>
              {/* New Host split button */}
              <div className="flex items-center">
                <Dropdown>
                  <div className="flex items-center rounded-md bg-primary text-primary-foreground">
                    <Button
                      size="sm"
                      className="h-10 px-3 rounded-r-none bg-transparent hover:bg-white/10 shadow-none"
                      onClick={handleNewHost}
                    >
                      <Plus size={14} className="mr-2" /> New Host
                    </Button>
                    <DropdownTrigger asChild>
                      <Button
                        size="sm"
                        className="h-10 px-2 rounded-l-none bg-transparent hover:bg-white/10 border-l border-primary-foreground/20 shadow-none"
                      >
                        <ChevronDown size={14} />
                      </Button>
                    </DropdownTrigger>
                  </div>
                  <DropdownContent className="w-44" align="end" alignToParent>
                    <Button
                      variant="ghost"
                      className="w-full justify-start gap-2"
                      onClick={() => { setTargetParentPath(selectedGroupPath); setIsNewFolderOpen(true); }}
                    >
                      <FolderTree size={14} /> New Group
                    </Button>
                    <Button
                      variant="ghost"
                      className="w-full justify-start gap-2"
                      onClick={() => {
                        // TODO: Import hosts
                      }}
                    >
                      <Upload size={14} /> Import
                    </Button>
                  </DropdownContent>
                </Dropdown>
              </div>
              <Button size="sm" variant="secondary" className="h-10 px-3" onClick={onCreateLocalTerminal}>
                <TerminalSquare size={14} className="mr-2" /> Terminal
              </Button>
            </div>
          </header>
        )}

        {currentSection !== 'port' && currentSection !== 'keys' && currentSection !== 'knownhosts' && currentSection !== 'snippets' && (
          <div className="flex-1 overflow-auto px-4 py-4 space-y-6">
            {currentSection === 'hosts' && (
              <>
                <section className="space-y-2">
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <button className="text-primary hover:underline" onClick={() => setSelectedGroupPath(null)}>All hosts</button>
                    {selectedGroupPath && selectedGroupPath.split('/').filter(Boolean).map((part, idx, arr) => {
                      const crumbPath = arr.slice(0, idx + 1).join('/');
                      const isLast = idx === arr.length - 1;
                      return (
                        <span key={crumbPath} className="flex items-center gap-2">
                          <span className="text-muted-foreground">›</span>
                          <button className={cn(isLast ? "text-foreground font-semibold" : "text-primary hover:underline")} onClick={() => setSelectedGroupPath(crumbPath)}>
                            {part}
                          </button>
                        </span>
                      );
                    })}
                  </div>
                  {displayedGroups.length > 0 && (
                    <>
                      <div className="flex items-center justify-between">
                        <h3 className="text-sm font-semibold text-muted-foreground">Groups</h3>
                        <div className="text-xs text-muted-foreground">{displayedGroups.length} total</div>
                      </div>
                    </>
                  )}
                  <div className={cn(
                    displayedGroups.length === 0 ? "hidden" : "",
                    viewMode === 'grid'
                      ? "grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
                      : "flex flex-col gap-0"
                  )}
                    onDragOver={(e) => { e.preventDefault(); }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const hostId = e.dataTransfer.getData('host-id');
                      const groupPath = e.dataTransfer.getData('group-path');
                      if (hostId) moveHostToGroup(hostId, selectedGroupPath);
                      if (groupPath && selectedGroupPath !== null) moveGroup(groupPath, selectedGroupPath);
                    }}>
                    {displayedGroups.map(node => (
                      <ContextMenu key={node.path}>
                        <ContextMenuTrigger asChild>
                          <div
                            className={cn(
                              "group cursor-pointer",
                              viewMode === 'grid'
                                ? "soft-card elevate rounded-xl h-[68px] px-3 py-2"
                                : "h-14 px-3 py-2 hover:bg-secondary/60 rounded-lg transition-colors"
                            )}
                            draggable
                            onDragStart={(e) => e.dataTransfer.setData('group-path', node.path)}
                            onDoubleClick={() => setSelectedGroupPath(node.path)}
                            onClick={() => setSelectedGroupPath(node.path)}
                            onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                            onDrop={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              const hostId = e.dataTransfer.getData('host-id');
                              const groupPath = e.dataTransfer.getData('group-path');
                              if (hostId) moveHostToGroup(hostId, node.path);
                              if (groupPath) moveGroup(groupPath, node.path);
                            }}
                          >
                            <div className="flex items-center gap-3 h-full">
                              <div className="h-11 w-11 rounded-xl bg-primary/15 text-primary flex items-center justify-center">
                                <FolderTree size={20} />
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="text-sm font-semibold truncate">{node.name}</div>
                                <div className="text-[11px] text-muted-foreground">{node.hosts.length} Hosts</div>
                              </div>
                            </div>
                          </div>
                        </ContextMenuTrigger>
                        <ContextMenuContent>
                          <ContextMenuItem onClick={() => { setTargetParentPath(node.path); setIsNewFolderOpen(true); }}>
                            <FolderPlus className="mr-2 h-4 w-4" /> New Subgroup
                          </ContextMenuItem>
                          <ContextMenuItem className="text-destructive" onClick={() => deleteGroupPath(node.path)}>
                            <Trash2 className="mr-2 h-4 w-4" /> Delete Group
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                    ))}
                  </div>
                </section>

                <section className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-muted-foreground">Hosts</h3>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{displayedHosts.length} entries</span>
                      <div className="bg-secondary/80 border border-border/70 rounded-md px-2 py-1 text-[11px]">{sessions.length} live</div>
                    </div>
                  </div>
                  <div className={cn(
                    viewMode === 'grid'
                      ? "grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
                      : "flex flex-col gap-0"
                  )}>
                    {displayedHosts.map((host) => {
                      const safeHost = sanitizeHost(host);
                      const distroBadge = { text: (safeHost.os || 'L')[0].toUpperCase(), label: safeHost.distro || safeHost.os || 'Linux' };
                      return (
                        <ContextMenu key={host.id}>
                          <ContextMenuTrigger>
                            <div
                              className={cn(
                                "group cursor-pointer",
                                viewMode === 'grid'
                                  ? "soft-card elevate rounded-xl h-[68px] px-3 py-2"
                                  : "h-14 px-3 py-2 hover:bg-secondary/60 rounded-lg transition-colors"
                              )}
                              draggable
                              onDragStart={(e) => {
                                e.dataTransfer.effectAllowed = 'move';
                                e.dataTransfer.setData('host-id', host.id);
                              }}
                              onClick={() => handleHostConnect(safeHost)}
                            >
                              <div className="flex items-center gap-3 h-full">
                                <DistroAvatar host={safeHost} fallback={distroBadge.text} />
                                <div className="min-w-0 flex flex-col justify-center gap-0.5 flex-1">
                                  <div className="text-sm font-semibold truncate leading-5">{safeHost.label}</div>
                                  <div className="text-[11px] text-muted-foreground font-mono truncate leading-4">{safeHost.username}@{safeHost.hostname}</div>
                                </div>
                                {viewMode === 'list' && (
                                  <>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                                      onClick={(e) => { e.stopPropagation(); handleEditHost(host); }}
                                    >
                                      <Edit2 size={14} />
                                    </Button>
                                  </>
                                )}
                              </div>
                            </div>
                          </ContextMenuTrigger>
                          <ContextMenuContent>
                            <ContextMenuItem onClick={() => handleHostConnect(host)}>
                              <Plug className="mr-2 h-4 w-4" /> Connect
                            </ContextMenuItem>
                            <ContextMenuItem onClick={() => handleEditHost(host)}>
                              <Edit2 className="mr-2 h-4 w-4" /> Edit
                            </ContextMenuItem>
                            <ContextMenuItem className="text-destructive" onClick={() => onDeleteHost(host.id)}>
                              <Trash2 className="mr-2 h-4 w-4" /> Delete
                            </ContextMenuItem>
                          </ContextMenuContent>
                        </ContextMenu>
                      );
                    })}
                    {displayedHosts.length === 0 && (
                      <div className="col-span-full flex flex-col items-center justify-center py-24 text-muted-foreground">
                        <div className="h-16 w-16 rounded-2xl bg-secondary/80 flex items-center justify-center mb-4">
                          <LayoutGrid size={32} className="opacity-60" />
                        </div>
                        <h3 className="text-lg font-semibold text-foreground mb-2">Set up your hosts</h3>
                        <p className="text-sm text-center max-w-sm">
                          Save hosts to quickly connect to your servers, VMs, and containers.
                        </p>
                      </div>
                    )}
                  </div>
                </section>
              </>
            )}
          </div>
        )}

        {currentSection === 'snippets' && (
          <SnippetsManager
            snippets={snippets}
            packages={snippetPackages}
            hosts={hosts}
            customGroups={customGroups}
            shellHistory={shellHistory}
            onPackagesChange={onUpdateSnippetPackages}
            onSave={s => onUpdateSnippets(snippets.find(ex => ex.id === s.id) ? snippets.map(ex => ex.id === s.id ? s : ex) : [...snippets, s])}
            onDelete={id => onUpdateSnippets(snippets.filter(s => s.id !== id))}
            onRunSnippet={onRunSnippet}
            availableKeys={keys}
            onSaveHost={(host) => onUpdateHosts([...hosts, host])}
            onCreateGroup={(groupPath) => onUpdateCustomGroups(Array.from(new Set([...customGroups, groupPath])))}
          />
        )}
        {currentSection === 'keys' && (
          <KeychainManager
            keys={keys}
            hosts={hosts}
            customGroups={customGroups}
            onSave={k => onUpdateKeys([...keys, k])}
            onUpdate={k => onUpdateKeys(keys.map(existing => existing.id === k.id ? k : existing))}
            onDelete={id => onUpdateKeys(keys.filter(k => k.id !== id))}
            onSaveHost={(host) => {
              // Update existing host or add new one
              const existingIndex = hosts.findIndex(h => h.id === host.id);
              if (existingIndex >= 0) {
                onUpdateHosts(hosts.map(h => h.id === host.id ? host : h));
              } else {
                onUpdateHosts([...hosts, host]);
              }
            }}
            onCreateGroup={(groupPath) => onUpdateCustomGroups(Array.from(new Set([...customGroups, groupPath])))}
          />
        )}
        {currentSection === 'port' && (
          <PortForwarding
            hosts={hosts}
            keys={keys}
            customGroups={customGroups}
            onSaveHost={(host) => onUpdateHosts([...hosts, host])}
            onCreateGroup={(groupPath) => onUpdateCustomGroups(Array.from(new Set([...customGroups, groupPath])))}
          />
        )}
        {/* Always render KnownHostsManager but hide with CSS to prevent unmounting */}
        <div style={{ display: currentSection === 'knownhosts' ? 'contents' : 'none' }}>
          {knownHostsManagerElement}
        </div>
      </div>

      {/* Host Details Panel - positioned at VaultView root level for correct top alignment */}
      {currentSection === 'hosts' && isHostPanelOpen && (
        <HostDetailsPanel
          initialData={editingHost}
          availableKeys={keys}
          groups={Array.from(new Set([...customGroups, ...hosts.map(h => h.group || 'General')]))}
          allTags={allTags}
          allHosts={hosts}
          onSave={host => {
            onUpdateHosts(editingHost ? hosts.map(h => h.id === host.id ? host : h) : [...hosts, host]);
            setIsHostPanelOpen(false);
            setEditingHost(null);
          }}
          onCancel={() => { setIsHostPanelOpen(false); setEditingHost(null); }}
          onCreateGroup={(groupPath) => {
            onUpdateCustomGroups(Array.from(new Set([...customGroups, groupPath])));
          }}
        />
      )}

      <Dialog open={isNewFolderOpen} onOpenChange={setIsNewFolderOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{targetParentPath ? `Create Subfolder` : 'Create Root Group'}</DialogTitle>
            <DialogDescription className="sr-only">Create a new group for organizing hosts.</DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label>Group Name</Label>
            <Input value={newFolderName} onChange={e => setNewFolderName(e.target.value)} placeholder="e.g. Production" autoFocus onKeyDown={e => e.key === 'Enter' && submitNewFolder()} />
            {targetParentPath && <p className="text-xs text-muted-foreground mt-2">Parent: <span className="font-mono">{targetParentPath}</span></p>}
          </div>
          <DialogFooter><Button variant="ghost" onClick={() => setIsNewFolderOpen(false)}>Cancel</Button><Button onClick={submitNewFolder}>Create</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Quick Connect Wizard */}
      {isQuickConnectOpen && quickConnectTarget && (
        <QuickConnectWizard
          open={isQuickConnectOpen}
          target={quickConnectTarget}
          keys={keys}
          knownHosts={knownHosts}
          onConnect={handleQuickConnect}
          onSaveHost={handleQuickConnectSaveHost}
          onClose={() => {
            setIsQuickConnectOpen(false);
            setQuickConnectTarget(null);
          }}
        />
      )}

      {/* Protocol Select Dialog */}
      {protocolSelectHost && (
        <ProtocolSelectDialog
          host={protocolSelectHost}
          onSelect={handleProtocolSelect}
          onCancel={() => setProtocolSelectHost(null)}
        />
      )}
    </div>
  );
};

// Only re-render when data props change - isActive is now managed internally via store subscription
const vaultViewAreEqual = (prev: VaultViewProps, next: VaultViewProps): boolean => {
  const isEqual = (
    prev.hosts === next.hosts &&
    prev.keys === next.keys &&
    prev.snippets === next.snippets &&
    prev.snippetPackages === next.snippetPackages &&
    prev.customGroups === next.customGroups &&
    prev.knownHosts === next.knownHosts &&
    prev.shellHistory === next.shellHistory &&
    prev.sessions === next.sessions
  );

  return isEqual;
};

const MemoizedVaultViewInner = memo(VaultViewInner, vaultViewAreEqual);

// Just export the memoized component directly
// Visibility control is handled by parent (App.tsx)
export const VaultView = MemoizedVaultViewInner;
VaultView.displayName = 'VaultView';
