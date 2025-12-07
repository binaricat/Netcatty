import React, { useState, useEffect, useMemo, useRef } from 'react';
import Terminal from './components/Terminal';
import AssistantPanel from './components/AssistantPanel';
import KeyManager from './components/KeyManager';
import SnippetsManager from './components/SnippetsManager';
import SettingsDialog from './components/SettingsDialog';
import PortForwarding from './components/PortForwarding';
import HostDetailsPanel from './components/HostDetailsPanel';
import { Host, SSHKey, GroupNode, Snippet, SyncConfig, TerminalSession } from './types';
import { TERMINAL_THEMES } from './lib/terminalThemes';
import { 
  Plus, Search, Settings, LayoutGrid, List as ListIcon, Monitor, Command, 
  Trash2, Edit2, Key, Folder, FolderOpen, ChevronRight, FolderPlus, FileCode,
  X, TerminalSquare, Shield, Grid, Heart, Star, Bell, User, Plug, BookMarked, Activity, Sun, Moon
} from 'lucide-react';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Card, CardContent } from './components/ui/card';
import { Badge } from './components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from './components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from './components/ui/popover';
import { Label } from './components/ui/label';
import { cn } from './lib/utils';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from './components/ui/context-menu';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './components/ui/collapsible';
import { ScrollArea } from './components/ui/scroll-area';

const STORAGE_KEY_HOSTS = 'nebula_hosts_v1';
const STORAGE_KEY_KEYS = 'nebula_keys_v1';
const STORAGE_KEY_GROUPS = 'nebula_groups_v1';
const STORAGE_KEY_SNIPPETS = 'nebula_snippets_v1';
const STORAGE_KEY_SNIPPET_PACKAGES = 'nebula_snippet_packages_v1';
const STORAGE_KEY_THEME = 'nebula_theme_v1';
const STORAGE_KEY_COLOR = 'nebula_color_v1';
const STORAGE_KEY_SYNC = 'nebula_sync_v1';
const STORAGE_KEY_TERM_THEME = 'nebula_term_theme_v1';

const normalizeDistroId = (value?: string) => {
  const v = (value || '').toLowerCase().trim();
  if (!v) return '';
  if (v.includes('ubuntu')) return 'ubuntu';
  if (v.includes('debian')) return 'debian';
  if (v.includes('centos')) return 'centos';
  if (v.includes('rocky')) return 'rocky';
  if (v.includes('fedora')) return 'fedora';
  if (v.includes('arch') || v.includes('manjaro')) return 'arch';
  if (v.includes('alpine')) return 'alpine';
  if (v.includes('amzn') || v.includes('amazon') || v.includes('aws')) return 'amazon';
  if (v.includes('opensuse') || v.includes('suse') || v.includes('sles')) return 'opensuse';
  if (v.includes('red hat') || v.includes('rhel')) return 'redhat';
  if (v.includes('oracle')) return 'oracle';
  if (v.includes('kali')) return 'kali';
  return '';
};

const INITIAL_HOSTS: Host[] = [
  { id: '1', label: 'Production Web', hostname: '10.0.0.12', port: 22, username: 'ubuntu', group: 'AWS/Production', tags: ['prod', 'web'], os: 'linux' },
  { id: '2', label: 'DB Master', hostname: 'db-01.internal', port: 22, username: 'admin', group: 'AWS/Production', tags: ['prod', 'db'], os: 'linux' },
];

const INITIAL_SNIPPETS: Snippet[] = [
    { id: '1', label: 'Check Disk Space', command: 'df -h', tags: [] },
    { id: '2', label: 'Tail System Log', command: 'tail -f /var/log/syslog', tags: [] },
    { id: '3', label: 'Update Ubuntu', command: 'sudo apt update && sudo apt upgrade -y', tags: [] },
];

const DISTRO_LOGOS: Record<string, string> = {
  ubuntu: "/distro/ubuntu.svg",
  debian: "/distro/debian.svg",
  centos: "/distro/centos.svg",
  rocky: "/distro/rocky.svg",
  fedora: "/distro/fedora.svg",
  arch: "/distro/arch.svg",
  alpine: "/distro/alpine.svg",
  amazon: "/distro/amazon.svg",
  opensuse: "/distro/opensuse.svg",
  redhat: "/distro/redhat.svg",
  oracle: "/distro/oracle.svg",
  kali: "/distro/kali.svg",
};

const DISTRO_COLORS: Record<string, string> = {
  ubuntu: "bg-[#E95420]",
  debian: "bg-[#A81D33]",
  centos: "bg-[#9C27B0]",
  rocky: "bg-[#0B9B69]",
  fedora: "bg-[#3C6EB4]",
  arch: "bg-[#1793D1]",
  alpine: "bg-[#0D597F]",
  amazon: "bg-[#FF9900]",
  opensuse: "bg-[#73BA25]",
  redhat: "bg-[#EE0000]",
  oracle: "bg-[#C74634]",
  kali: "bg-[#0F6DB3]",
  default: "bg-slate-600",
};

const DistroAvatar: React.FC<{ host: Host; fallback: string; className?: string }> = ({ host, fallback, className }) => {
  const distro = (host.distro || '').toLowerCase();
  const logo = DISTRO_LOGOS[distro];
  const [errored, setErrored] = React.useState(false);
  const bg = DISTRO_COLORS[distro] || DISTRO_COLORS.default;

  if (logo && !errored) {
    return (
      <div className={cn("h-12 w-12 rounded-lg flex items-center justify-center border border-border/40 overflow-hidden", bg, className)}>
        <img
          src={logo}
          alt={host.distro || host.os}
          className="h-7 w-7 object-contain invert brightness-0"
          onError={() => setErrored(true)}
        />
      </div>
    );
  }

  return (
    <div className={cn("h-10 w-10 rounded-lg flex items-center justify-center bg-slate-600/20", className)}>
      <span className="text-xs font-semibold">{fallback}</span>
    </div>
  );
};

// --- Group Tree Item ---
interface GroupTreeItemProps {
  node: GroupNode;
  depth: number;
  expandedPaths: Set<string>;
  onToggle: (path: string) => void;
  onSelectGroup: (path: string) => void;
  selectedGroup: string | null;
  onEditGroup: (path: string) => void;
  onNewHost: (path: string) => void;
  onNewSubfolder: (path: string) => void;
}

const GroupTreeItem: React.FC<GroupTreeItemProps> = ({ 
    node, depth, expandedPaths, onToggle, onSelectGroup, selectedGroup,
    onEditGroup, onNewHost, onNewSubfolder
}) => {
  const isExpanded = expandedPaths.has(node.path);
  const hasChildren = node.children && Object.keys(node.children).length > 0;
  const paddingLeft = `${depth * 12 + 12}px`;
  const isSelected = selectedGroup === node.path;

  // Convert children map to sorted array
  const childNodes = useMemo(() => {
    return node.children 
      ? (Object.values(node.children) as unknown as GroupNode[]).sort((a, b) => a.name.localeCompare(b.name)) 
      : [];
  }, [node.children]);

  return (
    <Collapsible open={isExpanded} onOpenChange={() => onToggle(node.path)}>
      <ContextMenu>
          <ContextMenuTrigger>
              <CollapsibleTrigger asChild>
                  <div 
                    className={cn(
                        "flex items-center py-1.5 pr-2 text-sm font-medium cursor-pointer transition-colors select-none group relative rounded-r-md",
                        isSelected ? "bg-primary/10 text-primary border-l-2 border-primary" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                    )}
                    style={{ paddingLeft }}
                    onClick={(e) => {
                        onSelectGroup(node.path);
                    }}
                  >
                    <div className="mr-1.5 flex-shrink-0 w-4 h-4 flex items-center justify-center">
                        {hasChildren && (
                            <div className={cn("transition-transform duration-200", isExpanded ? "rotate-90" : "")}>
                               <ChevronRight size={12} />
                            </div>
                        )}
                    </div>

                    <div className="mr-2 text-primary/80 group-hover:text-primary transition-colors">
                        {isExpanded ? <FolderOpen size={16} /> : <Folder size={16} />}
                    </div>
                    
                    <span className="truncate flex-1">{node.name}</span>
                    
                    {node.hosts.length > 0 && (
                        <span className="text-[10px] opacity-70 bg-background/50 px-1.5 rounded-full border border-border">
                            {node.hosts.length}
                        </span>
                    )}
                  </div>
              </CollapsibleTrigger>
          </ContextMenuTrigger>
          <ContextMenuContent>
              <ContextMenuItem onClick={() => onNewHost(node.path)}>
                  <Plus className="mr-2 h-4 w-4" /> New Host
              </ContextMenuItem>
              <ContextMenuItem onClick={() => onNewSubfolder(node.path)}>
                  <FolderPlus className="mr-2 h-4 w-4" /> New Subfolder
              </ContextMenuItem>
          </ContextMenuContent>
      </ContextMenu>
      
      {hasChildren && (
        <CollapsibleContent>
          {childNodes.map(child => (
            <GroupTreeItem 
                key={child.path} 
                node={child} 
                depth={depth + 1}
                expandedPaths={expandedPaths}
                onToggle={onToggle}
                onSelectGroup={onSelectGroup}
                selectedGroup={selectedGroup}
                onEditGroup={onEditGroup}
                onNewHost={onNewHost}
                onNewSubfolder={onNewSubfolder}
            />
          ))}
        </CollapsibleContent>
      )}
    </Collapsible>
  );
};

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
  
  // Navigation & Sessions
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>('vault'); // 'vault' or session.id

  // Modals
  const [editingHost, setEditingHost] = useState<Host | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isQuickSwitcherOpen, setIsQuickSwitcherOpen] = useState(false);
  const [quickSearch, setQuickSearch] = useState('');
  
  // Vault View State
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [currentSection, setCurrentSection] = useState<'hosts' | 'keys' | 'snippets' | 'port'>('hosts');
  const [showAssistant, setShowAssistant] = useState(false);
  const [search, setSearch] = useState('');
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [selectedGroupPath, setSelectedGroupPath] = useState<string | null>(null);
  const [isNewFolderOpen, setIsNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [targetParentPath, setTargetParentPath] = useState<string | null>(null);
  const [snippetPackages, setSnippetPackages] = useState<string[]>([]);

  // --- Effects ---
  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(theme);
    root.style.setProperty('--primary', primaryColor);
    root.style.setProperty('--ring', primaryColor);
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

  const closeSession = (sessionId: string, e?: React.MouseEvent) => {
      e?.stopPropagation();
      setSessions(prev => {
          const newSessions = prev.filter(s => s.id !== sessionId);
          if (activeTabId === sessionId) {
              // If we closed the active tab, switch to the last one, or vault
              if (newSessions.length > 0) {
                  setActiveTabId(newSessions[newSessions.length - 1].id);
              } else {
                  setActiveTabId('vault');
              }
          }
          return newSessions;
      });
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

  const toggleExpand = (path: string) => {
      const newSet = new Set(expandedPaths);
      newSet.has(path) ? newSet.delete(path) : newSet.add(path);
      setExpandedPaths(newSet);
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
      return filtered;
  }, [hosts, selectedGroupPath, search]);

  const displayedGroups = useMemo(() => {
    if (!selectedGroupPath) {
      return (Object.values(buildGroupTree) as GroupNode[]).sort((a, b) => a.name.localeCompare(b.name));
    }
    const node = findGroupNode(selectedGroupPath);
    if (!node || !node.children) return [];
    return (Object.values(node.children) as GroupNode[]).sort((a, b) => a.name.localeCompare(b.name));
  }, [buildGroupTree, selectedGroupPath]);

  const submitNewFolder = () => {
      if(!newFolderName.trim()) return;
      const fullPath = targetParentPath ? `${targetParentPath}/${newFolderName.trim()}` : newFolderName.trim();
      updateCustomGroups(Array.from(new Set([...customGroups, fullPath])));
      if (targetParentPath) setExpandedPaths(prev => new Set(prev).add(targetParentPath));
      setIsNewFolderOpen(false);
  };

  const deleteGroupPath = (path: string) => {
    const keepGroups = customGroups.filter(g => !(g === path || g.startsWith(path + '/')));
    const keepHosts = hosts.map(h => {
      const g = h.group || '';
      if (g === path || g.startsWith(path + '/')) return { ...h, group: '' };
      return h;
    });
    updateCustomGroups(keepGroups);
    updateHosts(keepHosts);
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
    updateCustomGroups(Array.from(new Set(updatedGroups)));
    updateHosts(updatedHosts);
    if (selectedGroupPath && (selectedGroupPath === sourcePath || selectedGroupPath.startsWith(sourcePath + '/'))) {
      setSelectedGroupPath(newPath);
    }
  };

  const moveHostToGroup = (hostId: string, groupPath: string | null) => {
    updateHosts(hosts.map(h => h.id === hostId ? { ...h, group: groupPath || '' } : h));
  };
  
  const currentTerminalTheme = TERMINAL_THEMES.find(t => t.id === terminalThemeId) || TERMINAL_THEMES[0];
  const isVaultActive = activeTabId === 'vault';
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

  // Sort root nodes for display
  const rootNodes = useMemo<GroupNode[]>(
    () => (Object.values(buildGroupTree) as GroupNode[]).sort((a, b) => a.name.localeCompare(b.name)),
    [buildGroupTree]
  );

  const topTabs = (
    <div className="w-full bg-secondary/90 border-b border-border/60 backdrop-blur app-drag">
      <div 
        className="h-10 px-3 flex items-center gap-2" 
        style={{ paddingLeft: isMacClient ? 76 : 12 }}
      >
        <div 
          onClick={() => setActiveTabId('vault')}
          className={cn(
            "h-8 px-3 rounded-md border text-xs font-semibold cursor-pointer flex items-center gap-2 app-no-drag",
            isVaultActive ? "bg-primary/20 border-primary/60 text-foreground" : "border-border/60 text-muted-foreground hover:border-primary/40 hover:text-foreground"
          )}
        >
          <Shield size={14} /> Vaults
        </div>
        <div className="h-8 px-3 rounded-md border border-border/60 text-muted-foreground text-xs font-semibold cursor-pointer flex items-center gap-2 app-no-drag">
          <Folder size={14} /> SFTP
        </div>
        {sessions.map(session => (
          <div
            key={session.id}
            onClick={() => setActiveTabId(session.id)}
            className={cn(
              "h-8 pl-3 pr-2 min-w-[140px] max-w-[240px] rounded-md border text-xs font-semibold cursor-pointer flex items-center justify-between gap-2 app-no-drag",
              activeTabId === session.id ? "bg-primary/20 border-primary/60 text-foreground" : "border-border/60 text-muted-foreground hover:border-primary/40 hover:text-foreground"
            )}
          >
            <div className="flex items-center gap-2 truncate">
              <TerminalSquare size={14} className={cn("shrink-0", activeTabId === session.id ? "text-primary" : "text-muted-foreground")} />
              <span className="truncate">{session.hostLabel}</span>
            </div>
            <button
              onClick={(e) => closeSession(session.id, e)}
              className="p-1 rounded-full hover:bg-destructive/10 hover:text-destructive transition-colors"
              aria-label="Close session"
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 app-no-drag"
          onClick={() => setIsQuickSwitcherOpen(true)}
          title="Open quick switcher"
        >
          <Plus size={14} />
        </Button>
        <div className="ml-auto flex items-center gap-2 app-no-drag">
          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground">
            <Bell size={16} />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground">
            <User size={16} />
          </Button>
          <Button 
            variant="ghost" 
            size="icon" 
            className="h-8 w-8 text-muted-foreground hover:text-foreground" 
            onClick={() => setTheme(prev => prev === 'dark' ? 'light' : 'dark')}
            title="Toggle theme"
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </Button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col h-screen text-foreground font-sans nebula-shell" onContextMenu={(e) => e.preventDefault()}>
      {topTabs}

      <div className="flex-1 relative min-h-0">
        {/* Vault layer */}
        <div className={cn("absolute inset-0 flex min-h-0", isVaultActive ? "opacity-100 z-20" : "opacity-0 pointer-events-none z-0")}>
          {/* Sidebar */}
          <div className="w-64 bg-secondary/80 border-r border-border/60 flex flex-col">
            <div className="px-4 py-4 flex items-center gap-3">
              <img src="/logo.svg" alt="netcatty logo" className="h-10 w-10 rounded-xl bg-transparent" />
              <div>
                <p className="text-sm font-bold text-foreground">Netcatty</p>
              </div>
            </div>

            <div className="px-3 space-y-1">
              <Button variant={currentSection === 'hosts' ? 'secondary' : 'ghost'} className="w-full justify-start gap-3 h-10" onClick={() => { setCurrentSection('hosts'); setSelectedGroupPath(null); }}>
                <ListIcon size={16} /> Hosts
              </Button>
              <Button variant={currentSection === 'keys' ? 'secondary' : 'ghost'} className="w-full justify-start gap-3 h-10" onClick={() => { setCurrentSection('keys'); }}>
                <Key size={16} /> Keychain
              </Button>
              <Button variant={currentSection === 'port' ? 'secondary' : 'ghost'} className="w-full justify-start gap-3 h-10" onClick={() => setCurrentSection('port')}>
                <Plug size={16} /> Port Forwarding
              </Button>
              <Button variant={currentSection === 'snippets' ? 'secondary' : 'ghost'} className="w-full justify-start gap-3 h-10" onClick={() => { setCurrentSection('snippets'); }}>
                <FileCode size={16} /> Snippets
              </Button>
              <Button variant="ghost" className="w-full justify-start gap-3 h-10">
                <BookMarked size={16} /> Known Hosts
              </Button>
              <Button variant="ghost" className="w-full justify-start gap-3 h-10">
                <Activity size={16} /> Logs
              </Button>
            </div>

            <div className="mt-auto px-3 pb-4 space-y-2">
              <Button variant={showAssistant ? "secondary" : "ghost"} className="w-full justify-start gap-3" onClick={() => setShowAssistant(!showAssistant)}>
                <Command size={16} /> AI Assistant
              </Button>
              <Button variant="ghost" className="w-full justify-start gap-3" onClick={() => setIsSettingsOpen(true)}>
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
                    <Input placeholder="Find a host or ssh user@hostname..." className="pl-9 h-11 bg-secondary border-border/60 text-sm" value={search} onChange={e => setSearch(e.target.value)} />
                  </div>
                  <Button variant="secondary" className="h-11 px-4" onClick={() => setIsQuickSwitcherOpen(true)}>Connect</Button>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="icon" className="h-10 w-10 text-muted-foreground hover:text-foreground"><LayoutGrid size={16} /></Button>
                    <Button variant="ghost" size="icon" className="h-10 w-10 text-muted-foreground hover:text-foreground"><Grid size={16} /></Button>
                    <Button variant="ghost" size="icon" className="h-10 w-10 text-muted-foreground hover:text-foreground"><Heart size={16} /></Button>
                    <Button variant="ghost" size="icon" className="h-10 w-10 text-muted-foreground hover:text-foreground"><Star size={16} /></Button>
                  </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" className="h-11 px-3" onClick={() => { setEditingHost(null); setIsFormOpen(true); }}>
                    <Plus size={14} className="mr-2" /> New Host
                  </Button>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button size="sm" variant="ghost" className="h-11 w-10 px-0">
                        <ChevronRight size={16} />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-44 p-1">
                      <Button
                        variant="ghost"
                        className="w-full justify-start gap-2"
                        onClick={() => { setTargetParentPath(selectedGroupPath); setIsNewFolderOpen(true); }}
                      >
                        <Grid size={14} /> New Group
                      </Button>
                    </PopoverContent>
                  </Popover>
                </div>
                </div>
              </header>
            )}

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
                    <div className={cn("grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4", displayedGroups.length === 0 ? "hidden" : "")}
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
                              className="soft-card elevate rounded-lg p-4 cursor-pointer"
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
                              <div className="flex items-center gap-3">
                                <div className="h-10 w-10 rounded-lg bg-primary/15 text-primary flex items-center justify-center">
                                  <Grid size={18} />
                                </div>
                                <div>
                                  <div className="text-sm font-semibold">{node.name}</div>
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
                    <div className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                      {displayedHosts.map((host, idx) => {
                        const safeHost = sanitizeHost(host);
                        const distro = (safeHost.distro || '').toLowerCase();
                        const accentBg = 'bg-primary/15 text-primary';
                        const distroBadge = { bg: accentBg, text: (safeHost.os || 'L')[0].toUpperCase(), label: safeHost.distro || safeHost.os || 'Linux' };
                        return (
                            <ContextMenu key={host.id}>
                              <ContextMenuTrigger>
                                <div
                                  className="soft-card elevate rounded-xl cursor-pointer h-[72px] px-3 py-2"
                                  draggable
                                  onDragStart={(e) => {
                                    e.dataTransfer.effectAllowed = 'move';
                                    e.dataTransfer.setData('host-id', host.id);
                                  }}
                                  onClick={() => handleConnect(safeHost)}
                                >
                                  <div className="flex items-center gap-3 h-full">
                                    <DistroAvatar host={safeHost} fallback={distroBadge.text} />
                                    <div className="min-w-0 flex flex-col justify-center gap-0.5">
                                      <div className="text-sm font-semibold truncate leading-5">{safeHost.label}</div>
                                      <div className="text-[11px] text-muted-foreground font-mono truncate leading-4">{safeHost.username}@{safeHost.hostname}</div>
                                      {safeHost.distro && <div className="text-[10px] text-muted-foreground truncate leading-4">{distroBadge.label}</div>}
                                    </div>
                                  </div>
                                </div>
                              </ContextMenuTrigger>
                              <ContextMenuContent>
                                <ContextMenuItem onClick={() => handleConnect(host)}>
                                  <Plug className="mr-2 h-4 w-4" /> Connect
                                </ContextMenuItem>
                                <ContextMenuItem onClick={() => handleEditHost(host)}>
                                  <Edit2 className="mr-2 h-4 w-4" /> Edit
                                </ContextMenuItem>
                                <ContextMenuItem className="text-destructive" onClick={() => handleDeleteHost(host.id)}>
                                  <Trash2 className="mr-2 h-4 w-4" /> Delete
                                </ContextMenuItem>
                              </ContextMenuContent>
                            </ContextMenu>
                        );
                        })}
                        {displayedHosts.length === 0 && (
                          <div className="col-span-full flex items-center justify-center py-16">
                            <div className="max-w-sm w-full rounded-2xl bg-secondary/60 px-6 py-8 text-center shadow-lg">
                              <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-background text-muted-foreground shadow-sm">
                                <Search size={20} />
                              </div>
                              <div className="text-sm font-semibold text-foreground">No results found</div>
                              <div className="text-xs text-muted-foreground mt-1">Adjust your search or create a new host.</div>
                              <div className="mt-4 flex items-center justify-center gap-2">
                                <Button size="sm" variant="secondary" onClick={() => { setEditingHost(null); setIsFormOpen(true); }}>
                                  <Plus size={14} className="mr-1" /> New Host
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => setSearch('')}>Clear search</Button>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                  </section>
                </>
              )}

              {currentSection === 'keys' && (
                <KeyManager keys={keys} onSave={k => updateKeys([...keys, k])} onDelete={id => updateKeys(keys.filter(k => k.id !== id))} />
              )}
              {currentSection === 'snippets' && (
                <SnippetsManager
                  snippets={snippets}
                  packages={snippetPackages}
                  hosts={hosts}
                  onPackagesChange={updateSnippetPackages}
                  onSave={s => updateSnippets(snippets.find(ex => ex.id === s.id) ? snippets.map(ex => ex.id === s.id ? s : ex) : [...snippets, s])}
                  onDelete={id => updateSnippets(snippets.filter(s => s.id !== id))}
                />
              )}
              {currentSection === 'port' && <PortForwarding />}
            </div>
          </div>
        </div>

        {/* Terminal layer (kept mounted) */}
        <div className={cn("absolute inset-0 bg-background", isVaultActive ? "opacity-0 pointer-events-none z-0" : "opacity-100 z-10")}>
          {sessions.map(session => {
              const host = hosts.find(h => h.id === session.hostId);
              if (!host) return null;
              const isVisible = activeTabId === session.id && !isVaultActive;
              return (
                  <div 
                      key={session.id} 
                      className={cn("absolute inset-0 bg-background", isVisible ? "z-10" : "opacity-0 pointer-events-none")}
                  >
                      <Terminal 
                          host={host} 
                          keys={keys} 
                          snippets={snippets} 
                          isVisible={isVisible}
                          fontSize={14}
                          terminalTheme={currentTerminalTheme}
                          sessionId={session.id}
                          onStatusChange={(next) => updateSessionStatus(session.id, next)}
                          onSessionExit={() => updateSessionStatus(session.id, 'disconnected')}
                          onOsDetected={(hid, distro) => updateHostDistro(hid, distro)}
                      />
                  </div>
              );
          })}
          {showAssistant && (
            <div className="absolute right-0 top-0 bottom-0 z-20 shadow-2xl animate-in slide-in-from-right-10">
                <AssistantPanel />
            </div>
          )}
        </div>
      </div>
      {isQuickSwitcherOpen && (
        <div 
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-lg flex flex-col"
          onClick={(e) => { if (e.target === e.currentTarget) setIsQuickSwitcherOpen(false); }}
        >
          <div className="max-w-5xl w-full mx-auto px-6 pt-14 space-y-4 app-no-drag">
            <div className="flex items-center gap-3">
              <Input
                autoFocus
                value={quickSearch}
                onChange={e => setQuickSearch(e.target.value)}
                placeholder="Search hosts or tabs..."
                className="h-12 text-sm bg-secondary border-primary/50 focus-visible:ring-primary"
              />
              <div className="text-xs text-muted-foreground">⌘K</div>
            </div>
            <div className="bg-secondary/90 border border-border/70 rounded-2xl shadow-2xl overflow-hidden">
              <div className="px-4 py-3 flex items-center justify-between text-xs font-semibold text-muted-foreground/90">
                <span>Recent connections</span>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" disabled>Create a workspace</Button>
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" disabled>Restore</Button>
                </div>
              </div>
              <div className="divide-y divide-border/70">
                {quickResults.length > 0 ? quickResults.map(host => (
                  <div
                    key={host.id}
                    className="flex items-center justify-between px-4 py-3 hover:bg-primary/10 cursor-pointer transition-colors"
                    onClick={(e) => { e.stopPropagation(); handleConnect(host); setIsQuickSwitcherOpen(false); setQuickSearch(''); }}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="h-8 w-8 rounded-md flex items-center justify-center bg-primary/15 text-primary">
                        <Monitor size={14} />
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold truncate">{host.label}</div>
                        <div className="text-[11px] text-muted-foreground font-mono truncate">{host.username}@{host.hostname}</div>
                      </div>
                    </div>
                    <div className="text-[11px] text-muted-foreground">{host.group || 'Personal'}</div>
                  </div>
                )) : (
                  <div className="px-4 py-6 text-sm text-muted-foreground text-center">No matches. Start typing to search.</div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
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
    </div>
  );
}

export default App;
