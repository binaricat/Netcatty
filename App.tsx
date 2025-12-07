import React, { useState, useEffect, useMemo, useRef } from 'react';
import Terminal from './components/Terminal';
import AssistantPanel from './components/AssistantPanel';
import KeyManager from './components/KeyManager';
import SnippetsManager from './components/SnippetsManager';
import SettingsDialog from './components/SettingsDialog';
import PortForwarding from './components/PortForwarding';
import HostDetailsPanel from './components/HostDetailsPanel';
import { Host, SSHKey, GroupNode, Snippet, SyncConfig, TerminalSession, Workspace, WorkspaceNode, RemoteFile } from './types';
import { TERMINAL_THEMES } from './lib/terminalThemes';
import { 
  Plus, Search, Settings, LayoutGrid, List as ListIcon, Monitor, Command, 
  Trash2, Edit2, Key, Folder, FolderOpen, ChevronRight, FolderPlus, FileCode,
  X, TerminalSquare, Shield, Grid, Heart, Star, Bell, User, Plug, BookMarked, Activity, Sun, Moon,
  HardDrive, RefreshCw
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

type FileItem = RemoteFile & { kind?: string };

const LOCAL_FILE_MAP: Record<string, FileItem[]> = {
  "/": [
    { name: "Applications", type: "directory", size: "--", lastModified: "--", kind: "folder" },
    { name: "Users", type: "directory", size: "--", lastModified: "--", kind: "folder" },
  ],
  "/Users": [
    { name: "chenqi", type: "directory", size: "--", lastModified: "Dec 27, 2025 9:10 AM", kind: "folder" },
  ],
  "/Users/chenqi": [
    { name: "Documents", type: "directory", size: "--", lastModified: "Dec 12, 2025 10:18 AM", kind: "folder" },
    { name: "Downloads", type: "directory", size: "--", lastModified: "Dec 17, 2025 3:40 AM", kind: "folder" },
    { name: "Pictures", type: "directory", size: "--", lastModified: "Jul 19, 2025 10:52 PM", kind: "folder" },
    { name: "Projects", type: "directory", size: "--", lastModified: "Dec 3, 2025 2:22 PM", kind: "folder" },
    { name: "notes.txt", type: "file", size: "3.2 KB", lastModified: "Nov 2, 2025 9:12 PM", kind: "txt" },
  ],
  "/Users/chenqi/Downloads": [
    { name: "archive.zip", type: "file", size: "128 MB", lastModified: "Dec 2, 2025 11:12 PM", kind: "zip" },
    { name: "release", type: "directory", size: "--", lastModified: "Dec 1, 2025 5:00 PM", kind: "folder" },
  ],
  "/Users/chenqi/Projects": [
    { name: "nebula-ssh", type: "directory", size: "--", lastModified: "Dec 27, 2025 9:10 AM", kind: "folder" },
    { name: "readme.md", type: "file", size: "7.2 KB", lastModified: "Nov 4, 2025 8:12 AM", kind: "md" },
  ],
  "/Users/chenqi/Projects/nebula-ssh": [
    { name: "src", type: "directory", size: "--", lastModified: "Dec 18, 2025 12:12 PM", kind: "folder" },
    { name: "package.json", type: "file", size: "2.4 KB", lastModified: "Dec 18, 2025 12:12 PM", kind: "json" },
    { name: "README.md", type: "file", size: "4.1 KB", lastModified: "Nov 30, 2025 9:40 AM", kind: "md" },
  ],
};

const REMOTE_FILE_MAP: Record<string, FileItem[]> = {
  "/": [
    { name: "root", type: "directory", size: "--", lastModified: "--", kind: "folder" },
    { name: "var", type: "directory", size: "--", lastModified: "--", kind: "folder" },
    { name: "etc", type: "directory", size: "--", lastModified: "--", kind: "folder" },
    { name: "opt", type: "directory", size: "--", lastModified: "--", kind: "folder" },
  ],
  "/root": [
    { name: "deploy.sh", type: "file", size: "21.3 KB", lastModified: "Sep 28, 2025 3:42 PM", kind: "sh" },
    { name: "clean.sh", type: "file", size: "1.6 KB", lastModified: "Sep 28, 2025 3:46 PM", kind: "sh" },
    { name: "update.sh", type: "file", size: "498 Bytes", lastModified: "Nov 17, 2025 10:20 PM", kind: "sh" },
    { name: "notes", type: "directory", size: "--", lastModified: "Sep 15, 2025 10:20 PM", kind: "folder" },
  ],
  "/root/notes": [
    { name: "todo.md", type: "file", size: "1.2 KB", lastModified: "Sep 10, 2025 8:11 PM", kind: "md" },
    { name: "deploy-checklist.md", type: "file", size: "2.4 KB", lastModified: "Sep 9, 2025 6:05 PM", kind: "md" },
  ],
  "/var": [
    { name: "log", type: "directory", size: "--", lastModified: "Aug 1, 2025 12:00 PM", kind: "folder" },
    { name: "www", type: "directory", size: "--", lastModified: "Jul 1, 2025 7:32 PM", kind: "folder" },
  ],
  "/var/log": [
    { name: "syslog", type: "file", size: "14.2 MB", lastModified: "Dec 17, 2025 7:11 PM", kind: "log" },
    { name: "kern.log", type: "file", size: "2.9 MB", lastModified: "Dec 17, 2025 7:07 PM", kind: "log" },
  ],
  "/etc": [
    { name: "nginx", type: "directory", size: "--", lastModified: "Nov 1, 2025 4:20 PM", kind: "folder" },
    { name: "ssh", type: "directory", size: "--", lastModified: "Oct 12, 2025 11:20 AM", kind: "folder" },
    { name: "timezone", type: "file", size: "122 Bytes", lastModified: "Oct 2, 2025 9:02 AM", kind: "conf" },
  ],
  "/etc/nginx": [
    { name: "nginx.conf", type: "file", size: "3.4 KB", lastModified: "Nov 1, 2025 4:20 PM", kind: "conf" },
    { name: "sites-enabled", type: "directory", size: "--", lastModified: "Nov 1, 2025 4:20 PM", kind: "folder" },
  ],
  "/etc/ssh": [
    { name: "sshd_config", type: "file", size: "2.1 KB", lastModified: "Oct 12, 2025 11:21 AM", kind: "conf" },
    { name: "ssh_config", type: "file", size: "1.1 KB", lastModified: "Oct 12, 2025 11:19 AM", kind: "conf" },
  ],
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
  const [activeTabId, setActiveTabId] = useState<string>('vault'); // 'vault', session.id, or workspace.id
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{
    direction: 'horizontal' | 'vertical';
    position: 'left' | 'right' | 'top' | 'bottom';
    targetSessionId?: string;
    rect?: { x: number; y: number; w: number; h: number };
  } | null>(null);
  const [workspaceArea, setWorkspaceArea] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const workspaceOuterRef = useRef<HTMLDivElement>(null);
  const workspaceInnerRef = useRef<HTMLDivElement>(null);
  const workspaceOverlayRef = useRef<HTMLDivElement>(null);
  const [resizing, setResizing] = useState<{
    workspaceId: string;
    splitId: string;
    index: number;
    direction: 'vertical' | 'horizontal';
    startSizes: number[];
    startArea: { w: number; h: number };
    startClient: { x: number; y: number };
  } | null>(null);

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
  const [focusedSessionId, setFocusedSessionId] = useState<string | null>(null);

  // SFTP View State
  type SftpPaneTab = { id: string; label: string; isLocal: boolean; hostId?: string; path: string; filter: string; status?: 'idle' | 'connecting' | 'connected' };
  const [sftpLeftTabs, setSftpLeftTabs] = useState<SftpPaneTab[]>([
    { id: 'local-default', label: 'Local', isLocal: true, hostId: 'local', path: '/Users/chenqi', filter: '' },
  ]);
  const [sftpRightTabs, setSftpRightTabs] = useState<SftpPaneTab[]>([]);
  const [sftpLeftActiveId, setSftpLeftActiveId] = useState<string>('local-default');
  const [sftpRightActiveId, setSftpRightActiveId] = useState<string | null>(null);
  const [sftpHostModalSide, setSftpHostModalSide] = useState<'left' | 'right' | null>(null);
  const [sftpHostPickerSearch, setSftpHostPickerSearch] = useState('');

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

  const sftpGroups = useMemo(() => {
    const bucket: Record<string, number> = {};
    hosts.forEach(h => {
      const key = (h.group || 'Ungrouped').split('/')[0] || 'Ungrouped';
      bucket[key] = (bucket[key] || 0) + 1;
    });
    return Object.entries(bucket)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [hosts]);

  const filteredSftpHosts = useMemo(() => {
    const term = sftpHostPickerSearch.trim().toLowerCase();
    return hosts
      .filter(h => {
        if (!term) return true;
        return (
          h.label.toLowerCase().includes(term) ||
          h.hostname.toLowerCase().includes(term) ||
          (h.group || '').toLowerCase().includes(term)
        );
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [hosts, sftpHostPickerSearch]);

  const breadcrumbForPath = (path: string) => {
    if (path === '/') return [{ label: '/', path: '/' }];
    const parts = path.split('/').filter(Boolean);
    const crumbs = parts.map((part, idx) => ({
      label: part,
      path: '/' + parts.slice(0, idx + 1).join('/'),
    }));
    return [{ label: '/', path: '/' }, ...crumbs];
  };

  const parentForPath = (path: string) => {
    if (path === '/') return '/';
    const parts = path.split('/').filter(Boolean);
    parts.pop();
    return parts.length ? `/${parts.join('/')}` : '/';
  };

  const applyFileFilter = (items: FileItem[], filter: string) => {
    const term = filter.trim().toLowerCase();
    if (!term) return items;
    return items.filter(item => item.name === '..' || item.name.toLowerCase().includes(term));
  };

  const getEntriesForTab = (tab: SftpPaneTab | null) => {
    if (!tab) return [];
    const map = tab.isLocal ? LOCAL_FILE_MAP : REMOTE_FILE_MAP;
    const files = map[tab.path] || [];
    const withParent = tab.path === '/' ? files : [{ name: '..', type: 'directory', size: '--', lastModified: '--', kind: 'folder' }, ...files];
    return applyFileFilter(withParent, tab.filter);
  };

  const formatKind = (item: FileItem) => {
    if (item.type === 'directory') return 'folder';
    if (item.kind) return item.kind;
    const ext = item.name.split('.').pop();
    return ext ? ext.toLowerCase() : 'file';
  };

  const updateTabField = (side: 'left' | 'right', tabId: string, updater: (tab: SftpPaneTab) => Partial<SftpPaneTab>) => {
    const apply = (tabs: SftpPaneTab[]) => tabs.map(tab => tab.id === tabId ? { ...tab, ...updater(tab) } : tab);
    side === 'left' ? setSftpLeftTabs(apply) : setSftpRightTabs(apply);
  };

  const openEntry = (side: 'left' | 'right', tab: SftpPaneTab | null, item: FileItem) => {
    if (!tab || item.type !== 'directory') return;
    if (item.name === '..') {
      const parent = parentForPath(tab.path);
      updateTabField(side, tab.id, () => ({ path: parent }));
      return;
    }
    const next = tab.path === '/' ? `/${item.name}` : `${tab.path}/${item.name}`;
    updateTabField(side, tab.id, () => ({ path: next }));
  };

  const addTab = (side: 'left' | 'right', tab: SftpPaneTab) => {
    if (side === 'left') {
      setSftpLeftTabs(prev => [...prev, tab]);
      setSftpLeftActiveId(tab.id);
    } else {
      setSftpRightTabs(prev => [...prev, tab]);
      setSftpRightActiveId(tab.id);
    }
  };

  const closeTab = (side: 'left' | 'right', tabId: string) => {
    if (side === 'left') {
      setSftpLeftTabs(prev => {
        const next = prev.filter(t => t.id !== tabId);
        const fallback = next[next.length - 1];
        setSftpLeftActiveId(fallback ? fallback.id : '');
        return next.length ? next : [{ id: 'local-default', label: 'Local', isLocal: true, hostId: 'local', path: '/Users/chenqi', filter: '', status: 'connected' }];
      });
    } else {
      setSftpRightTabs(prev => {
        const next = prev.filter(t => t.id !== tabId);
        const fallback = next[next.length - 1] || null;
        setSftpRightActiveId(fallback ? fallback.id : null);
        return next;
      });
    }
  };

  const ensureActiveTabs = () => {
    if (sftpLeftTabs.length && !sftpLeftTabs.find(t => t.id === sftpLeftActiveId)) {
      setSftpLeftActiveId(sftpLeftTabs[0].id);
    }
    if (sftpRightTabs.length && sftpRightActiveId && !sftpRightTabs.find(t => t.id === sftpRightActiveId)) {
      setSftpRightActiveId(sftpRightTabs[0].id);
    }
  };

  useEffect(() => {
    ensureActiveTabs();
  }, [sftpLeftTabs, sftpRightTabs]);

  const activeLeftTab = useMemo(() => sftpLeftTabs.find(t => t.id === sftpLeftActiveId) || sftpLeftTabs[0] || null, [sftpLeftActiveId, sftpLeftTabs]);
  const activeRightTab = useMemo(() => {
    if (sftpRightActiveId) return sftpRightTabs.find(t => t.id === sftpRightActiveId) || null;
    return sftpRightTabs[0] || null;
  }, [sftpRightActiveId, sftpRightTabs]);

  const leftEntries = useMemo(() => getEntriesForTab(activeLeftTab), [activeLeftTab]);
  const rightEntries = useMemo(() => getEntriesForTab(activeRightTab), [activeRightTab]);
  const leftBreadcrumbs = useMemo(() => breadcrumbForPath(activeLeftTab?.path || '/'), [activeLeftTab]);
  const rightBreadcrumbs = useMemo(() => breadcrumbForPath(activeRightTab?.path || '/'), [activeRightTab]);

  const selectHostForSide = (side: 'left' | 'right', host: Host | 'local') => {
    const tabId = `tab-${side}-${crypto.randomUUID()}`;
    if (host === 'local') {
      addTab(side, { id: tabId, label: 'Local', isLocal: true, hostId: 'local', path: '/Users/chenqi', filter: '', status: 'connected' });
    } else {
      addTab(side, { id: tabId, label: host.label, isLocal: false, hostId: host.id, path: '/root', filter: '', status: 'connected' });
    }
    setSftpHostModalSide(null);
    setSftpHostPickerSearch('');
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
    const name = window.prompt('Rename workspace', target.title);
    if (!name || !name.trim()) return;
    setWorkspaces(prev => prev.map(w => w.id === workspaceId ? { ...w, title: name.trim() } : w));
  };

  type WorkspaceRect = { x: number; y: number; w: number; h: number };

  const computeSplitHint = (e: React.DragEvent): {
    direction: 'horizontal' | 'vertical';
    position: 'left' | 'right' | 'top' | 'bottom';
    targetSessionId?: string;
    rect?: { x: number; y: number; w: number; h: number };
  } | null => {
    const surface = workspaceOverlayRef.current || workspaceInnerRef.current || workspaceOuterRef.current;
    if (!surface || !workspaceArea.width || !workspaceArea.height) return null;
    const rect = surface.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;
    if (localX < 0 || localX > rect.width || localY < 0 || localY > rect.height) return null;

    let targetSessionId: string | undefined;
    let targetRect: WorkspaceRect | undefined;
    const workspaceEntries = Object.entries(activeWorkspaceRects) as Array<[string, WorkspaceRect]>;
    workspaceEntries.forEach(([sessionId, area]) => {
      if (targetSessionId) return;
      if (
        localX >= area.x &&
        localX <= area.x + area.w &&
        localY >= area.y &&
        localY <= area.y + area.h
      ) {
        targetSessionId = sessionId;
        targetRect = area;
      }
    });

    const baseRect: WorkspaceRect = targetRect || { x: 0, y: 0, w: rect.width, h: rect.height };
    const relX = (localX - baseRect.x) / baseRect.w;
    const relY = (localY - baseRect.y) / baseRect.h;

    const prefersVertical = Math.abs(relX - 0.5) > Math.abs(relY - 0.5);
    const direction = prefersVertical ? 'vertical' : 'horizontal';
    const position = prefersVertical
      ? (relX < 0.5 ? 'left' : 'right')
      : (relY < 0.5 ? 'top' : 'bottom');

    const previewRect: WorkspaceRect = { ...baseRect };
    if (direction === 'vertical') {
      previewRect.w = baseRect.w / 2;
      previewRect.x = position === 'left' ? baseRect.x : baseRect.x + baseRect.w / 2;
    } else {
      previewRect.h = baseRect.h / 2;
      previewRect.y = position === 'top' ? baseRect.y : baseRect.y + baseRect.h / 2;
    }

    return {
      direction,
      position,
      targetSessionId,
      rect: previewRect,
    };
  };

  const createWorkspaceFromSessions = (
    baseSessionId: string,
    joiningSessionId: string,
    hint: { direction: 'horizontal' | 'vertical'; position: 'left' | 'right' | 'top' | 'bottom'; targetSessionId?: string } | null
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

  const handleWorkspaceDrop = (e: React.DragEvent) => {
    const draggedSessionId = e.dataTransfer.getData('session-id');
    if (!draggedSessionId) return;
    e.preventDefault();
    const hint = computeSplitHint(e);
    setDropHint(null);

    if (activeWorkspace) {
      const draggedSession = sessions.find(s => s.id === draggedSessionId);
      if (!draggedSession || draggedSession.workspaceId) return;
      addSessionToWorkspace(activeWorkspace.id, draggedSessionId, hint);
      return;
    }

    if (activeSession) {
      createWorkspaceFromSessions(activeSession.id, draggedSessionId, hint);
    }
  };

  const computeWorkspaceRects = (workspace?: Workspace, size?: { width: number; height: number }): Record<string, WorkspaceRect> => {
    if (!workspace) return {} as Record<string, WorkspaceRect>;
    const wTotal = size?.width || 1;
    const hTotal = size?.height || 1;
    const rects: Record<string, WorkspaceRect> = {};
    const walk = (node: WorkspaceNode, area: WorkspaceRect) => {
      if (node.type === 'pane') {
        rects[node.sessionId] = area;
        return;
      }
      const isVertical = node.direction === 'vertical';
      const sizes = (node.sizes && node.sizes.length === node.children.length ? node.sizes : Array(node.children.length).fill(1));
      const total = sizes.reduce((acc, n) => acc + n, 0) || 1;
      let offset = 0;
      node.children.forEach((child, idx) => {
        const share = sizes[idx] / total;
        const childArea = isVertical
          ? { x: area.x + area.w * offset, y: area.y, w: area.w * share, h: area.h }
          : { x: area.x, y: area.y + area.h * offset, w: area.w, h: area.h * share };
        walk(child, childArea);
        offset += share;
      });
    };
    walk(workspace.root, { x: 0, y: 0, w: wTotal, h: hTotal });
    return rects;
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
  const isSftpActive = activeTabId === 'sftp';
  const isTerminalLayerActive = !isVaultActive && !isSftpActive;
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
  const activeWorkspace = useMemo(() => workspaces.find(w => w.id === activeTabId), [workspaces, activeTabId]);
  const activeSession = useMemo(() => sessions.find(s => s.id === activeTabId), [sessions, activeTabId]);
  const orphanSessions = useMemo(() => sessions.filter(s => !s.workspaceId), [sessions]);
  const activeWorkspaceRects = useMemo<Record<string, WorkspaceRect>>(
    () => computeWorkspaceRects(activeWorkspace, workspaceArea),
    [activeWorkspace, workspaceArea]
  );

  useEffect(() => {
    if (!workspaceInnerRef.current) return;
    const el = workspaceInnerRef.current;
    const updateSize = () => setWorkspaceArea({ width: el.clientWidth, height: el.clientHeight });
    updateSize();
    const observer = new ResizeObserver(() => updateSize());
    observer.observe(el);
    return () => observer.disconnect();
  }, [activeWorkspace]);

  type ResizerHandle = {
    id: string;
    splitId: string;
    index: number;
    direction: 'vertical' | 'horizontal';
    rect: { x: number; y: number; w: number; h: number };
    splitArea: { w: number; h: number };
  };

  const collectResizers = (workspace?: Workspace, size?: { width: number; height: number }): ResizerHandle[] => {
    if (!workspace || !size?.width || !size?.height) return [];
    const resizers: ResizerHandle[] = [];
    const walk = (node: WorkspaceNode, area: { x: number; y: number; w: number; h: number }) => {
      if (node.type === 'pane') return;
      const isVertical = node.direction === 'vertical';
      const sizes = (node.sizes && node.sizes.length === node.children.length ? node.sizes : Array(node.children.length).fill(1));
      const total = sizes.reduce((acc, n) => acc + n, 0) || 1;
      let offset = 0;
      node.children.forEach((child, idx) => {
        const share = sizes[idx] / total;
        const childArea = isVertical
          ? { x: area.x + area.w * offset, y: area.y, w: area.w * share, h: area.h }
          : { x: area.x, y: area.y + area.h * offset, w: area.w, h: area.h * share };
        if (idx < node.children.length - 1) {
          const boundary = isVertical ? childArea.x + childArea.w : childArea.y + childArea.h;
          const rect = isVertical
            ? { x: boundary - 2, y: area.y, w: 4, h: area.h }
            : { x: area.x, y: boundary - 2, w: area.w, h: 4 };
          resizers.push({
            id: `${node.id}-${idx}`,
            splitId: node.id,
            index: idx,
            direction: node.direction,
            rect,
            splitArea: { w: area.w, h: area.h },
          });
        }
        walk(child, childArea);
        offset += share;
      });
    };
    walk(workspace.root, { x: 0, y: 0, w: size.width, h: size.height });
    return resizers;
  };

  const activeResizers = useMemo(() => collectResizers(activeWorkspace, workspaceArea), [activeWorkspace, workspaceArea]);

  const findSplitNode = (node: WorkspaceNode, splitId: string): WorkspaceNode | null => {
    if (node.type === 'split') {
      if (node.id === splitId) return node;
      for (const child of node.children) {
        const found = findSplitNode(child, splitId);
        if (found) return found;
      }
    }
    return null;
  };

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

  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) => {
      const dimension = resizing.direction === 'vertical' ? resizing.startArea.w : resizing.startArea.h;
      if (dimension <= 0) return;
      const total = resizing.startSizes.reduce((acc, n) => acc + n, 0) || 1;
      const pxSizes = resizing.startSizes.map(s => (s / total) * dimension);
      const i = resizing.index;
      const delta = (resizing.direction === 'vertical' ? e.clientX - resizing.startClient.x : e.clientY - resizing.startClient.y);
      let a = pxSizes[i] + delta;
      let b = pxSizes[i + 1] - delta;
      const minPx = Math.min(120, dimension / 2);
      if (a < minPx) {
        const diff = minPx - a;
        a = minPx;
        b -= diff;
      }
      if (b < minPx) {
        const diff = minPx - b;
        b = minPx;
        a -= diff;
      }
      const newPxSizes = [...pxSizes];
      newPxSizes[i] = Math.max(minPx, a);
      newPxSizes[i + 1] = Math.max(minPx, b);
      const totalPx = newPxSizes.reduce((acc, n) => acc + n, 0) || 1;
      const newSizes = newPxSizes.map(n => n / totalPx);
      updateSplitSizes(resizing.workspaceId, resizing.splitId, newSizes);
    };
    const onUp = () => setResizing(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [resizing]);

  const sessionStatusDot = (status: TerminalSession['status']) => {
    const tone = status === 'connected'
      ? "bg-emerald-400"
      : status === 'connecting'
        ? "bg-amber-400"
        : "bg-rose-500";
    return <span className={cn("inline-block h-2 w-2 rounded-full shadow-[0_0_0_2px_rgba(0,0,0,0.35)]", tone)} />;
  };

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
        <div 
          onClick={() => setActiveTabId('sftp')}
          className={cn(
            "h-8 px-3 rounded-md border text-xs font-semibold cursor-pointer flex items-center gap-2 app-no-drag",
            isSftpActive ? "bg-primary/20 border-primary/60 text-foreground" : "border-border/60 text-muted-foreground hover:border-primary/40 hover:text-foreground"
          )}
        >
          <Folder size={14} /> SFTP
        </div>
        {orphanSessions.map(session => (
          <div
            key={session.id}
            onClick={() => setActiveTabId(session.id)}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('session-id', session.id);
              setDraggingSessionId(session.id);
            }}
            onDragEnd={() => {
              setDraggingSessionId(null);
              setDropHint(null);
            }}
            className={cn(
              "h-8 pl-3 pr-2 min-w-[140px] max-w-[240px] rounded-md border text-xs font-semibold cursor-pointer flex items-center justify-between gap-2 app-no-drag",
              activeTabId === session.id ? "bg-primary/20 border-primary/60 text-foreground" : "border-border/60 text-muted-foreground hover:border-primary/40 hover:text-foreground",
              draggingSessionId === session.id ? "opacity-70" : ""
            )}
          >
            <div className="flex items-center gap-2 truncate">
              <TerminalSquare size={14} className={cn("shrink-0", activeTabId === session.id ? "text-primary" : "text-muted-foreground")} />
              <span className="truncate">{session.hostLabel}</span>
              {sessionStatusDot(session.status)}
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
        {workspaces.map(workspace => {
          const paneCount = sessions.filter(s => s.workspaceId === workspace.id).length;
          const isActive = activeTabId === workspace.id;
          return (
            <ContextMenu key={workspace.id}>
              <ContextMenuTrigger asChild>
                <div
                  onClick={() => setActiveTabId(workspace.id)}
                  className={cn(
                    "h-8 pl-3 pr-2 min-w-[150px] max-w-[260px] rounded-md border text-xs font-semibold cursor-pointer flex items-center justify-between gap-2 app-no-drag",
                    isActive ? "bg-primary/20 border-primary/60 text-foreground" : "border-border/60 text-muted-foreground hover:border-primary/40 hover:text-foreground"
                  )}
                >
                  <div className="flex items-center gap-2 truncate">
                    <LayoutGrid size={14} className={cn("shrink-0", isActive ? "text-primary" : "text-muted-foreground")} />
                    <span className="truncate">{workspace.title}</span>
                  </div>
                  <div className="text-[10px] px-2 py-1 rounded-full border border-border/70 bg-background/60 min-w-[28px] text-center">
                    {paneCount}
                  </div>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onClick={() => renameWorkspace(workspace.id)}>
                  <Edit2 className="mr-2 h-4 w-4" /> Rename
                </ContextMenuItem>
                <ContextMenuItem className="text-destructive" onClick={() => closeWorkspace(workspace.id)}>
                  <Trash2 className="mr-2 h-4 w-4" /> Close
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
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

        {/* SFTP layer */}
        <div className={cn("absolute inset-0 flex min-h-0", isSftpActive ? "opacity-100 z-20" : "opacity-0 pointer-events-none z-0")}>
          <div className="flex-1 flex flex-col min-h-0 bg-background">
            <div className="h-14 px-4 border-b border-border/60 bg-secondary/80 backdrop-blur flex items-center gap-3">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <HardDrive size={14} /> <span>SFTP Workspace</span>
              </div>
              <div className="ml-auto flex items-center gap-2 app-no-drag">
                <Badge variant="secondary" className="bg-emerald-500/10 text-emerald-100 border border-emerald-500/30">Tabbed panes</Badge>
                <Button variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground hover:text-foreground" onClick={() => { setSftpLeftTabs([{ id: 'local-default', label: 'Local', isLocal: true, hostId: 'local', path: '/Users/chenqi', filter: '', status: 'connected' }]); setSftpLeftActiveId('local-default'); setSftpRightTabs([]); setSftpRightActiveId(null); }}>
                  <RefreshCw size={14} />
                </Button>
              </div>
            </div>

            <div className="flex-1 grid grid-cols-1 xl:grid-cols-2 min-h-0 border-t border-border/70">
              {/* Left pane */}
              <div className="flex flex-col min-h-0 border-r border-border/70">
                <div className="h-12 px-4 border-b border-border/60 flex items-center gap-3">
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <Monitor size={14} />
                    <span>{activeLeftTab?.label || 'Local / Hosts'}</span>
                  </div>
                  <div className="flex items-center gap-2 overflow-x-auto no-scrollbar flex-nowrap whitespace-nowrap">
                    {sftpLeftTabs.map(tab => (
                      <div
                        key={tab.id}
                        className={cn(
                          "flex items-center gap-2 px-3 h-9 rounded-md border text-xs cursor-pointer flex-shrink-0",
                          tab.id === activeLeftTab?.id ? "border-primary/60 bg-primary/10 text-foreground" : "border-border/60 bg-secondary/60 text-muted-foreground hover:text-foreground"
                        )}
                        onClick={() => setSftpLeftActiveId(tab.id)}
                      >
                        <span className="truncate max-w-[120px]">{tab.label}</span>
                        <button
                          className="hover:text-destructive"
                          onClick={(e) => { e.stopPropagation(); closeTab('left', tab.id); }}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <Button variant="outline" size="sm" className="h-9 px-3" onClick={() => setSftpHostModalSide('left')}>
                    <Plus size={14} className="mr-2" /> Add host
                  </Button>
                  {activeLeftTab && (
                    <div className="flex items-center gap-2 ml-auto">
                      <Input
                        value={activeLeftTab.filter}
                        onChange={(e) => updateTabField('left', activeLeftTab.id, () => ({ filter: e.target.value }))}
                        placeholder="Filter"
                        className="h-9 w-44 bg-background/60"
                      />
                      <Button variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground hover:text-foreground" onClick={() => updateTabField('left', activeLeftTab.id, () => ({ filter: '' }))}>
                        <X size={14} />
                      </Button>
                    </div>
                  )}
                </div>

                <div className="px-4 py-2 text-xs text-muted-foreground flex items-center gap-2">
                  {leftBreadcrumbs.map((crumb, idx) => (
                    <React.Fragment key={crumb.path}>
                      <button
                        className={cn("hover:text-foreground", activeLeftTab?.path === crumb.path && "text-foreground font-semibold")}
                        onClick={() => activeLeftTab && updateTabField('left', activeLeftTab.id, () => ({ path: crumb.path }))}
                      >
                        {crumb.label}
                      </button>
                      {idx < leftBreadcrumbs.length - 1 && <span className="opacity-60">/</span>}
                    </React.Fragment>
                  ))}
                </div>

                <div className="flex-1 flex flex-col min-h-0">
                  <div className="grid grid-cols-[minmax(0,1fr)_160px_100px_100px] text-[11px] uppercase tracking-wide text-muted-foreground px-4 py-2 border-y border-border/70">
                    <span>Name</span>
                    <span>Date Modified</span>
                    <span>Size</span>
                    <span>Kind</span>
                  </div>
                  <div className="flex-1 overflow-auto divide-y divide-border/60">
                    {leftEntries.map((file, idx) => (
                      <div
                        key={`${file.name}-${idx}`}
                        className="grid grid-cols-[minmax(0,1fr)_160px_100px_100px] px-4 py-2 items-center hover:bg-primary/5 cursor-pointer text-sm"
                        onClick={() => openEntry('left', activeLeftTab, file)}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className={cn("h-8 w-8 rounded-md flex items-center justify-center border border-border/60", file.type === 'directory' ? "bg-primary/10 text-primary" : "bg-secondary/60 text-muted-foreground")}>
                            {file.type === 'directory' ? <Folder size={14} /> : <FileCode size={14} />}
                          </div>
                          <span className="truncate">{file.name}</span>
                        </div>
                        <span className="text-xs text-muted-foreground truncate">{file.lastModified}</span>
                        <span className="text-xs text-muted-foreground truncate">{file.size}</span>
                        <span className="text-xs text-muted-foreground truncate capitalize">{formatKind(file)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="h-10 px-4 flex items-center justify-between text-[11px] text-muted-foreground border-t border-border/70">
                    <span>{leftEntries.length} items</span>
                    <span>{activeLeftTab?.path}</span>
                  </div>
                </div>
              </div>

              {/* Right pane */}
              <div className="flex flex-col min-h-0">
                <div className="h-12 px-4 border-b border-border/60 flex items-center gap-3">
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <HardDrive size={14} />
                    <span>{activeRightTab?.label || 'Remote'}</span>
                  </div>
                  <div className="flex items-center gap-2 overflow-x-auto no-scrollbar flex-nowrap whitespace-nowrap">
                    {sftpRightTabs.map(tab => (
                      <div
                        key={tab.id}
                        className={cn(
                          "flex items-center gap-2 px-3 h-9 rounded-md border text-xs cursor-pointer flex-shrink-0",
                          tab.id === activeRightTab?.id ? "border-primary/60 bg-primary/10 text-foreground" : "border-border/60 bg-secondary/60 text-muted-foreground hover:text-foreground"
                        )}
                        onClick={() => setSftpRightActiveId(tab.id)}
                      >
                        <span className="truncate max-w-[120px]">{tab.label}</span>
                        <button
                          className="hover:text-destructive"
                          onClick={(e) => { e.stopPropagation(); closeTab('right', tab.id); }}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <Button variant="outline" size="sm" className="h-9 px-3" onClick={() => setSftpHostModalSide('right')}>
                    <Plus size={14} className="mr-2" /> Add host
                  </Button>
                  {activeRightTab && (
                    <div className="flex items-center gap-2 ml-auto">
                      {activeRightTab.hostId && (
                        <Badge variant="secondary" className="bg-emerald-500/10 text-emerald-100 border-emerald-500/30">
                          Connected
                        </Badge>
                      )}
                      <Input
                        value={activeRightTab.filter}
                        onChange={(e) => updateTabField('right', activeRightTab.id, () => ({ filter: e.target.value }))}
                        placeholder="Filter remote"
                        className="h-9 w-44 bg-background/60"
                      />
                      <Button variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground hover:text-foreground" onClick={() => updateTabField('right', activeRightTab.id, () => ({ filter: '' }))}>
                        <X size={14} />
                      </Button>
                    </div>
                  )}
                </div>

                {activeRightTab ? (
                  <>
                    <div className="px-4 py-2 text-xs text-muted-foreground flex items-center gap-2">
                      {rightBreadcrumbs.map((crumb, idx) => (
                        <React.Fragment key={crumb.path}>
                          <button
                            className={cn("hover:text-foreground", activeRightTab.path === crumb.path && "text-foreground font-semibold")}
                            onClick={() => updateTabField('right', activeRightTab.id, () => ({ path: crumb.path }))}
                          >
                            {crumb.label}
                          </button>
                          {idx < rightBreadcrumbs.length - 1 && <span className="opacity-60">/</span>}
                        </React.Fragment>
                      ))}
                    </div>
                    <div className="flex-1 flex flex-col min-h-0">
                      <div className="grid grid-cols-[minmax(0,1fr)_160px_100px_100px] text-[11px] uppercase tracking-wide text-muted-foreground px-4 py-2 border-y border-border/70">
                        <span>Name</span>
                        <span>Date Modified</span>
                        <span>Size</span>
                        <span>Kind</span>
                      </div>
                      <div className="flex-1 overflow-auto divide-y divide-border/60 relative">
                        {rightEntries.map((file, idx) => (
                          <div
                            key={`${file.name}-${idx}`}
                            className="grid grid-cols-[minmax(0,1fr)_160px_100px_100px] px-4 py-2 items-center hover:bg-primary/5 cursor-pointer text-sm"
                            onClick={() => openEntry('right', activeRightTab, file)}
                          >
                            <div className="flex items-center gap-3 min-w-0">
                              <div className={cn("h-8 w-8 rounded-md flex items-center justify-center border border-border/60", file.type === 'directory' ? "bg-primary/10 text-primary" : "bg-secondary/60 text-muted-foreground")}>
                                {file.type === 'directory' ? <Folder size={14} /> : <FileCode size={14} />}
                              </div>
                              <span className="truncate">{file.name}</span>
                            </div>
                            <span className="text-xs text-muted-foreground truncate">{file.lastModified}</span>
                            <span className="text-xs text-muted-foreground truncate">{file.size}</span>
                            <span className="text-xs text-muted-foreground truncate capitalize">{formatKind(file)}</span>
                          </div>
                        ))}
                      </div>
                      <div className="h-10 px-4 flex items-center justify-between text-[11px] text-muted-foreground border-t border-border/70">
                        <span>{rightEntries.length} items</span>
                        <span>{activeRightTab?.hostId || 'No host'}</span>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="flex-1 flex flex-col items-center justify-center text-center gap-3">
                    <div className="h-12 w-12 rounded-xl bg-secondary/60 text-primary flex items-center justify-center">
                      <Folder size={20} />
                    </div>
                    <div className="text-sm font-semibold">Select a host to start</div>
                    <div className="text-xs text-muted-foreground">Use “Add host” to open a remote in this pane.</div>
                    <Button onClick={() => setSftpHostModalSide('right')}>Add host</Button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        <Dialog open={!!sftpHostModalSide} onOpenChange={(open) => setSftpHostModalSide(open ? (sftpHostModalSide || 'left') : null)}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Select Host</DialogTitle>
              <DialogDescription>Pick a host to open as a new tab on the {sftpHostModalSide === 'left' ? 'left' : 'right'} pane.</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <Input
                value={sftpHostPickerSearch}
                onChange={(e) => setSftpHostPickerSearch(e.target.value)}
                placeholder="Search hosts"
                className="h-10"
              />
              <div
                className="flex items-center justify-between px-3 py-2 rounded-md border border-border/70 bg-secondary/50 cursor-pointer hover:border-primary/60"
                onClick={() => selectHostForSide(sftpHostModalSide || 'left', 'local')}
              >
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-md bg-primary/10 border border-primary/50 flex items-center justify-center text-primary font-semibold">L</div>
                  <div>
                    <div className="text-sm font-semibold">Local filesystem</div>
                    <div className="text-xs text-muted-foreground">/Users/chenqi</div>
                  </div>
                </div>
                <Badge variant="outline">Local</Badge>
              </div>
              <div className="max-h-72 overflow-auto space-y-2 pr-1">
                {filteredSftpHosts.map(host => (
                  <div
                    key={host.id}
                    className="flex items-center justify-between px-3 py-2 rounded-md border border-border/70 bg-secondary/50 cursor-pointer hover:border-primary/60"
                    onClick={() => selectHostForSide(sftpHostModalSide || 'left', host)}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <DistroAvatar host={host} fallback={(host.os || 'L')[0].toUpperCase()} className="h-9 w-9" />
                      <div className="min-w-0">
                        <div className="text-sm font-semibold truncate">{host.label}</div>
                        <div className="text-xs text-muted-foreground truncate">{host.username}@{host.hostname}</div>
                        <div className="text-[11px] text-muted-foreground truncate">{host.group || 'Personal'}</div>
                      </div>
                    </div>
                    <Badge variant="secondary" className="bg-primary/10 text-primary border-primary/30">Host</Badge>
                  </div>
                ))}
                {filteredSftpHosts.length === 0 && (
                  <div className="text-xs text-muted-foreground px-3 py-6 text-center border border-dashed border-border/70 rounded-md">
                    No matching hosts
                  </div>
                )}
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* Terminal layer (kept mounted) */}
        <div
          ref={workspaceOuterRef}
          className={cn("absolute inset-0 bg-background", isTerminalLayerActive ? "opacity-100 z-10" : "opacity-0 pointer-events-none z-0")}
        >
          {draggingSessionId && (
            <div
              ref={workspaceOverlayRef}
              className="absolute inset-0 z-30"
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes('session-id')) return;
                e.preventDefault();
                e.stopPropagation();
                const hint = computeSplitHint(e);
                setDropHint(hint);
              }}
              onDragLeave={(e) => {
                if (!e.dataTransfer.types.includes('session-id')) return;
                setDropHint(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDraggingSessionId(null);
                handleWorkspaceDrop(e);
              }}
            >
              {dropHint && (
                <div className="absolute inset-0 pointer-events-none">
                  <div
                    className="absolute bg-emerald-600/35 border border-emerald-400/70 backdrop-blur-sm transition-all duration-150"
                    style={{
                      width: dropHint.rect ? `${dropHint.rect.w}px` : dropHint.direction === 'vertical' ? '50%' : '100%',
                      height: dropHint.rect ? `${dropHint.rect.h}px` : dropHint.direction === 'vertical' ? '100%' : '50%',
                      left: dropHint.rect ? `${dropHint.rect.x}px` : dropHint.direction === 'vertical' ? (dropHint.position === 'left' ? 0 : '50%') : 0,
                      top: dropHint.rect ? `${dropHint.rect.y}px` : dropHint.direction === 'vertical' ? 0 : (dropHint.position === 'top' ? 0 : '50%'),
                    }}
                  />
                </div>
              )}
            </div>
          )}
          <div ref={workspaceInnerRef} className="absolute inset-0 p-3">
            {sessions.map(session => {
              const host = hosts.find(h => h.id === session.hostId);
              if (!host) return null;
              const inActiveWorkspace = !!activeWorkspace && session.workspaceId === activeWorkspace.id;
              const isActiveSolo = activeTabId === session.id && !activeWorkspace && isTerminalLayerActive;
              const isVisible = (inActiveWorkspace || isActiveSolo) && isTerminalLayerActive;
              const rect = inActiveWorkspace ? activeWorkspaceRects[session.id] : null;
              const isFocused = focusedSessionId === session.id && isVisible;

              const layoutStyle = rect
                ? {
                    left: `${rect.x}px`,
                    top: `${rect.y}px`,
                    width: `${rect.w}px`,
                    height: `${rect.h}px`,
                  }
                : { left: 0, top: 0, width: '100%', height: '100%' };

              return (
                <div
                  key={session.id}
                  className={cn(
                    "absolute bg-background transition-opacity border border-border/60",
                    isVisible ? "z-10" : "opacity-0 pointer-events-none"
                  )}
                  style={
                    isFocused
                      ? {
                          ...layoutStyle,
                          outline: '2px solid hsl(var(--primary))',
                          outlineOffset: -4,
                          boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.12)',
                        }
                      : layoutStyle
                  }
                  onClick={() => setFocusedSessionId(session.id)}
                >
                  <Terminal
                    host={host}
                    keys={keys}
                    snippets={snippets}
                    isVisible={isVisible}
                    inWorkspace={inActiveWorkspace}
                    fontSize={14}
                    terminalTheme={currentTerminalTheme}
                    sessionId={session.id}
                    onCloseSession={() => closeSession(session.id)}
                    onStatusChange={(next) => updateSessionStatus(session.id, next)}
                    onSessionExit={() => updateSessionStatus(session.id, 'disconnected')}
                    onOsDetected={(hid, distro) => updateHostDistro(hid, distro)}
                  />
                </div>
              );
            })}
            {activeResizers.map(handle => (
              <div
                key={handle.id}
                className={cn("absolute group", handle.direction === 'vertical' ? "cursor-ew-resize" : "cursor-ns-resize")}
                style={{
                  left: `${handle.rect.x - 3}px`,
                  top: `${handle.rect.y - 3}px`,
                  width: `${handle.rect.w + 6}px`,
                  height: `${handle.rect.h + 6}px`,
                  zIndex: 25,
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const ws = activeWorkspace;
                  if (!ws) return;
                  const split = findSplitNode(ws.root, handle.splitId);
                  const childCount = split && split.type === 'split' ? split.children.length : 0;
                  const sizes = split && split.type === 'split' && split.sizes && split.sizes.length === childCount
                    ? split.sizes
                    : Array(childCount).fill(1);
                  setResizing({
                    workspaceId: ws.id,
                    splitId: handle.splitId,
                    index: handle.index,
                    direction: handle.direction,
                    startSizes: sizes.length ? sizes : [1, 1],
                    startArea: handle.splitArea,
                    startClient: { x: e.clientX, y: e.clientY },
                  });
                }}
              >
                <div
                  className={cn(
                    "absolute bg-border/70 group-hover:bg-primary/60 transition-colors",
                    handle.direction === 'vertical' ? "w-px h-full left-1/2 -translate-x-1/2" : "h-px w-full top-1/2 -translate-y-1/2"
                  )}
                  style={{
                    top: handle.direction === 'vertical' ? 0 : undefined,
                    left: handle.direction === 'vertical' ? undefined : 0,
                  }}
                />
              </div>
            ))}
          </div>
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
