import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { Host, Snippet, ShellHistoryEntry, SSHKey } from '../types';
import { FileCode, Plus, Trash2, Edit2, Copy, Clock, List as ListIcon, FolderPlus, Play, ArrowLeft, X, Check, ChevronDown, Loader2, Package, Search, LayoutGrid } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Card } from './ui/card';
import { Label } from './ui/label';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger, ContextMenuSeparator } from './ui/context-menu';
import { cn } from '../lib/utils';
import { ScrollArea } from './ui/scroll-area';
import { DistroAvatar } from './DistroAvatar';
import SelectHostPanel from './SelectHostPanel';
import { AsidePanel, AsidePanelContent } from './ui/aside-panel';
import { Combobox, ComboboxOption } from './ui/combobox';
import { Dropdown, DropdownTrigger, DropdownContent } from './ui/dropdown';
import { SortDropdown, SortMode } from './ui/sort-dropdown';

interface SnippetsManagerProps {
  snippets: Snippet[];
  packages: string[];
  hosts: Host[];
  customGroups?: string[];
  shellHistory: ShellHistoryEntry[];
  onSave: (snippet: Snippet) => void;
  onDelete: (id: string) => void;
  onPackagesChange: (packages: string[]) => void;
  onRunSnippet?: (snippet: Snippet, targetHosts: Host[]) => void;
  // Props for inline host creation
  availableKeys?: SSHKey[];
  onSaveHost?: (host: Host) => void;
  onCreateGroup?: (groupPath: string) => void;
}

type RightPanelMode = 'none' | 'edit-snippet' | 'history' | 'select-targets';

const HISTORY_PAGE_SIZE = 30;

const SnippetsManager: React.FC<SnippetsManagerProps> = ({
  snippets,
  packages,
  hosts,
  customGroups = [],
  shellHistory,
  onSave,
  onDelete,
  onPackagesChange,
  onRunSnippet,
  availableKeys = [],
  onSaveHost,
  onCreateGroup,
}) => {
  // Panel state
  const [rightPanelMode, setRightPanelMode] = useState<RightPanelMode>('none');
  const [editingSnippet, setEditingSnippet] = useState<Partial<Snippet>>({
    label: '',
    command: '',
    package: '',
    targets: [],
  });
  const [targetSelection, setTargetSelection] = useState<string[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [selectedPackage, setSelectedPackage] = useState<string | null>(null);
  const [newPackageName, setNewPackageName] = useState('');
  const [isPackageDialogOpen, setIsPackageDialogOpen] = useState(false);

  // Search, sort, and view mode state
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [sortMode, setSortMode] = useState<SortMode>('az');

  // Shell history lazy loading state
  const [historyVisibleCount, setHistoryVisibleCount] = useState(HISTORY_PAGE_SIZE);
  const historyScrollRef = useRef<HTMLDivElement>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  const handleEdit = (snippet?: Snippet) => {
    if (snippet) {
      setEditingSnippet(snippet);
      setTargetSelection(snippet.targets || []);
    } else {
      setEditingSnippet({
        label: '',
        command: '',
        package: selectedPackage || '',
        targets: []
      });
      setTargetSelection([]);
    }
    setRightPanelMode('edit-snippet');
  };

  const handleSubmit = () => {
    if (editingSnippet.label && editingSnippet.command) {
      onSave({
        id: editingSnippet.id || crypto.randomUUID(),
        label: editingSnippet.label,
        command: editingSnippet.command,
        tags: editingSnippet.tags || [],
        package: editingSnippet.package || '',
        targets: targetSelection,
      });
      setRightPanelMode('none');
    }
  };

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const handleClosePanel = () => {
    setRightPanelMode('none');
    setEditingSnippet({ label: '', command: '', package: '', targets: [] });
    setTargetSelection([]);
  };

  const targetHosts = useMemo(() => {
    return targetSelection
      .map((id) => hosts.find((h) => h.id === id))
      .filter((h): h is Host => Boolean(h));
  }, [targetSelection, hosts]);

  const openTargetPicker = () => {
    setRightPanelMode('select-targets');
  };

  const handleTargetSelect = (host: Host) => {
    setTargetSelection((prev) =>
      prev.includes(host.id) ? prev.filter((id) => id !== host.id) : [...prev, host.id]
    );
  };

  const handleTargetPickerBack = () => {
    setRightPanelMode('edit-snippet');
  };

  const displayedPackages = useMemo(() => {
    if (!selectedPackage) {
      const roots = packages
        .map((p) => p.split('/')[0])
        .filter(Boolean);
      return Array.from(new Set(roots)).map((name) => {
        const path = name;
        const count = snippets.filter((s) => (s.package || '') === path).length;
        return { name, path, count };
      });
    }
    const prefix = selectedPackage + '/';
    const children = packages
      .filter((p) => p.startsWith(prefix))
      .map((p) => p.replace(prefix, '').split('/')[0])
      .filter(Boolean);
    return Array.from(new Set(children)).map((name) => {
      const path = `${selectedPackage}/${name}`;
      const count = snippets.filter((s) => (s.package || '') === path).length;
      return { name, path, count };
    });
  }, [packages, selectedPackage, snippets]);

  const displayedSnippets = useMemo(() => {
    let result = snippets.filter((s) => (s.package || '') === (selectedPackage || ''));
    // Apply search filter
    if (search.trim()) {
      const s = search.toLowerCase();
      result = result.filter(sn =>
        sn.label.toLowerCase().includes(s) ||
        sn.command.toLowerCase().includes(s)
      );
    }
    // Apply sorting
    result = [...result].sort((a, b) => {
      switch (sortMode) {
        case 'az':
          return a.label.localeCompare(b.label);
        case 'za':
          return b.label.localeCompare(a.label);
        default:
          return 0;
      }
    });
    return result;
  }, [snippets, selectedPackage, search, sortMode]);

  const breadcrumb = useMemo(() => {
    if (!selectedPackage) return [];
    const parts = selectedPackage.split('/').filter(Boolean);
    return parts.map((name, idx) => ({ name, path: parts.slice(0, idx + 1).join('/') }));
  }, [selectedPackage]);

  const createPackage = () => {
    const name = newPackageName.trim();
    if (!name) return;
    const full = selectedPackage ? `${selectedPackage}/${name}` : name;
    if (!packages.includes(full)) onPackagesChange([...packages, full]);
    setNewPackageName('');
    setIsPackageDialogOpen(false);
  };

  const deletePackage = (path: string) => {
    const keep = packages.filter((p) => !(p === path || p.startsWith(path + '/')));
    const updatedSnippets = snippets.map((s) => {
      if (!s.package) return s;
      if (s.package === path || s.package.startsWith(path + '/')) return { ...s, package: '' };
      return s;
    });
    onPackagesChange(keep);
    updatedSnippets.forEach(onSave);
    if (selectedPackage && (selectedPackage === path || selectedPackage.startsWith(path + '/'))) {
      setSelectedPackage(null);
    }
  };

  const movePackage = (source: string, target: string | null) => {
    const name = source.split('/').pop() || '';
    const newPath = target ? `${target}/${name}` : name;
    if (newPath === source || newPath.startsWith(source + '/')) return;
    const updatedPackages = packages.map((p) => {
      if (p === source) return newPath;
      if (p.startsWith(source + '/')) return p.replace(source, newPath);
      return p;
    });
    const updatedSnippets = snippets.map((s) => {
      if (!s.package) return s;
      if (s.package === source) return { ...s, package: newPath };
      if (s.package.startsWith(source + '/')) return { ...s, package: s.package.replace(source, newPath) };
      return s;
    });
    onPackagesChange(Array.from(new Set(updatedPackages)));
    updatedSnippets.forEach(onSave);
    if (selectedPackage === source) setSelectedPackage(newPath);
  };

  const moveSnippet = (id: string, pkg: string | null) => {
    const sn = snippets.find((s) => s.id === id);
    if (!sn) return;
    onSave({ ...sn, package: pkg || '' });
  };

  // Package options for Combobox
  const packageOptions: ComboboxOption[] = useMemo(() => {
    return packages.map(p => ({
      value: p,
      label: p.includes('/') ? p.split('/').pop()! : p,
      sublabel: p.includes('/') ? p : undefined,
    }));
  }, [packages]);

  // Shell history lazy loading
  const visibleHistory = useMemo(() => {
    return shellHistory.slice(0, historyVisibleCount);
  }, [shellHistory, historyVisibleCount]);

  const hasMoreHistory = historyVisibleCount < shellHistory.length;

  const loadMoreHistory = useCallback(() => {
    if (isLoadingMore || !hasMoreHistory) return;
    setIsLoadingMore(true);
    // Simulate loading delay for smooth UX
    setTimeout(() => {
      setHistoryVisibleCount((prev) => Math.min(prev + HISTORY_PAGE_SIZE, shellHistory.length));
      setIsLoadingMore(false);
    }, 200);
  }, [isLoadingMore, hasMoreHistory, shellHistory.length]);

  // Scroll handler for lazy loading
  const handleHistoryScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.target as HTMLDivElement;
    const scrollBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
    if (scrollBottom < 100 && hasMoreHistory && !isLoadingMore) {
      loadMoreHistory();
    }
  }, [hasMoreHistory, isLoadingMore, loadMoreHistory]);

  // Reset visible count when history panel opens
  useEffect(() => {
    if (rightPanelMode === 'history') {
      setHistoryVisibleCount(HISTORY_PAGE_SIZE);
    }
  }, [rightPanelMode]);

  const saveHistoryAsSnippet = (entry: ShellHistoryEntry, label: string) => {
    if (!label.trim()) return;
    onSave({
      id: crypto.randomUUID(),
      label: label.trim(),
      command: entry.command,
      package: selectedPackage || '',
      targets: [],
    });
  };

  // Render right panel based on mode
  const renderRightPanel = () => {
    if (rightPanelMode === 'select-targets') {
      return (
        <SelectHostPanel
          hosts={hosts}
          customGroups={customGroups}
          selectedHostIds={targetSelection}
          multiSelect={true}
          onSelect={handleTargetSelect}
          onBack={handleTargetPickerBack}
          onContinue={handleTargetPickerBack}
          availableKeys={availableKeys}
          onSaveHost={onSaveHost}
          onCreateGroup={onCreateGroup}
          title="Add targets"
        />
      );
    }

    if (rightPanelMode === 'edit-snippet') {
      return (
        <AsidePanel
          open={true}
          onClose={handleClosePanel}
          title={editingSnippet.id ? 'Edit Snippet' : 'New Snippet'}
          actions={
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={handleSubmit}
              disabled={!editingSnippet.label || !editingSnippet.command}
              aria-label="Save"
            >
              <Check size={16} />
            </Button>
          }
        >
          <AsidePanelContent>
            {/* Action Description */}
            <Card className="p-3 space-y-2 bg-card border-border/80">
              <p className="text-xs font-semibold text-muted-foreground">Action description</p>
              <Input
                placeholder="Example: check network load"
                value={editingSnippet.label || ''}
                onChange={(e) => setEditingSnippet({ ...editingSnippet, label: e.target.value })}
                className="h-10"
              />
            </Card>

            {/* Package */}
            <Card className="p-3 space-y-2 bg-card border-border/80">
              <p className="text-xs font-semibold text-muted-foreground">Add a Package</p>
              <Combobox
                options={packageOptions}
                value={editingSnippet.package || selectedPackage || ''}
                onValueChange={(val) => setEditingSnippet({ ...editingSnippet, package: val })}
                placeholder="Select or create package"
                allowCreate={true}
                onCreateNew={(val) => {
                  if (!packages.includes(val)) {
                    onPackagesChange([...packages, val]);
                  }
                }}
                createText="Create Package"
                icon={<Package size={16} />}
                triggerClassName="h-10"
              />
            </Card>

            {/* Script */}
            <Card className="p-3 space-y-2 bg-card border-border/80">
              <p className="text-xs font-semibold text-muted-foreground">Script *</p>
              <Textarea
                placeholder="ls -l"
                className="min-h-[120px] font-mono text-xs"
                value={editingSnippet.command || ''}
                onChange={(e) => setEditingSnippet({ ...editingSnippet, command: e.target.value })}
              />
            </Card>

            {/* Targets */}
            <Card className="p-3 space-y-3 bg-card border-border/80">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-muted-foreground">Targets</p>
                <Button variant="ghost" size="sm" className="h-6 px-2 text-xs text-primary" onClick={openTargetPicker}>
                  Edit
                </Button>
              </div>

              {targetHosts.length === 0 ? (
                <Button
                  variant="secondary"
                  className="w-full h-10"
                  onClick={openTargetPicker}
                >
                  Add targets
                </Button>
              ) : (
                <div className="space-y-2">
                  {targetHosts.map((h) => (
                    <div key={h.id} className="flex items-center gap-3 px-3 py-2 bg-background/60 border border-border/70 rounded-lg">
                      <DistroAvatar host={h} fallback={h.os[0].toUpperCase()} className="h-10 w-10" />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold truncate">{h.hostname}</div>
                        <div className="text-[11px] text-muted-foreground truncate">
                          {h.protocol || 'ssh'}, {h.username}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </AsidePanelContent>

          {/* Footer */}
          <div className="px-4 py-3 border-t border-border/60 shrink-0">
            <Button
              className="w-full"
              onClick={handleSubmit}
              disabled={!editingSnippet.label || !editingSnippet.command}
            >
              {editingSnippet.targets?.length ? 'Run' : 'Save'}
            </Button>
          </div>
        </AsidePanel>
      );
    }

    if (rightPanelMode === 'history') {
      return (
        <AsidePanel
          open={true}
          onClose={handleClosePanel}
          title="Shell History"
          subtitle={`${shellHistory.length} commands`}
          showBackButton={true}
          onBack={handleClosePanel}
        >
          {/* History List */}
          <div
            className="flex-1 overflow-y-auto p-3 space-y-2"
            onScroll={handleHistoryScroll}
            ref={historyScrollRef}
          >
            {visibleHistory.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <Clock size={32} className="mx-auto mb-3 opacity-50" />
                <p className="text-sm">No shell history yet</p>
                <p className="text-xs mt-1">Commands you execute will appear here</p>
              </div>
            ) : (
              <>
                {visibleHistory.map((entry) => (
                  <HistoryItem
                    key={entry.id}
                    entry={entry}
                    onSaveAsSnippet={saveHistoryAsSnippet}
                    onCopy={() => handleCopy(entry.id, entry.command)}
                    isCopied={copiedId === entry.id}
                  />
                ))}
                {hasMoreHistory && (
                  <div className="py-4 text-center">
                    {isLoadingMore ? (
                      <Loader2 size={20} className="animate-spin mx-auto text-muted-foreground" />
                    ) : (
                      <Button variant="ghost" size="sm" onClick={loadMoreHistory}>
                        Load more
                      </Button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </AsidePanel>
      );
    }

    return null;
  };

  return (
    <div className="h-full flex gap-3 relative">
      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex items-center gap-2 px-4 pt-4 pb-2">
          {/* Search box */}
          <div className="relative w-64">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search snippets..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-10 pl-9 bg-secondary border-border/60 text-sm"
            />
          </div>
          <Button onClick={() => handleEdit()} size="sm" className="h-10">
            <Plus size={14} className="mr-2" /> New Snippet
          </Button>
          <Button
            onClick={() => {
              setNewPackageName('');
              setIsPackageDialogOpen(true);
            }}
            size="sm"
            variant="secondary"
            className="h-10 gap-2"
          >
            <FolderPlus size={14} className="mr-1" /> New Package
          </Button>
          <Button
            variant={rightPanelMode === 'history' ? 'secondary' : 'ghost'}
            size="sm"
            className="h-10 gap-2"
            onClick={() => setRightPanelMode(rightPanelMode === 'history' ? 'none' : 'history')}
          >
            <Clock size={14} /> Shell History
          </Button>
          {/* View mode and sort controls */}
          <div className="flex items-center gap-1 ml-auto">
            <Dropdown>
              <DropdownTrigger asChild>
                <Button variant="ghost" size="icon" className="h-10 w-10">
                  {viewMode === 'grid' ? <LayoutGrid size={16} /> : <ListIcon size={16} />}
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
                  <ListIcon size={14} /> List
                </Button>
              </DropdownContent>
            </Dropdown>
            <SortDropdown
              value={sortMode}
              onChange={setSortMode}
              className="h-10 w-10"
            />
          </div>
        </div>
        <div className="flex items-center gap-2 text-sm font-semibold px-4">
          <button className="text-primary hover:underline" onClick={() => setSelectedPackage(null)}>All packages</button>
          {breadcrumb.map((b) => (
            <span key={b.path} className="flex items-center gap-2">
              <span className="text-muted-foreground">›</span>
              <button className="text-primary hover:underline" onClick={() => setSelectedPackage(b.path)}>{b.name}</button>
            </span>
          ))}
        </div>

        {!snippets.length && displayedPackages.length === 0 && (
          <div className="flex-1 flex items-center justify-center px-4">
            <div className="max-w-md w-full text-center space-y-3 py-12 rounded-2xl bg-secondary/60 border border-border/60 shadow-lg">
              <div className="mx-auto h-12 w-12 rounded-xl bg-muted text-muted-foreground flex items-center justify-center">
                <FileCode size={22} />
              </div>
              <div className="text-sm font-semibold text-foreground">Create snippet</div>
              <div className="text-xs text-muted-foreground px-8">Save your most used commands as snippets to reuse them in one click.</div>
            </div>
          </div>
        )}

        <div className="flex-1 space-y-3 overflow-y-auto px-4 pb-4">
          {displayedPackages.length > 0 && (
            <>
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-muted-foreground">Packages</h3>
              </div>
              <div className={cn(
                viewMode === 'grid'
                  ? "grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3"
                  : "flex flex-col gap-0"
              )}>
                {displayedPackages.map((pkg) => (
                  <ContextMenu key={pkg.path}>
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
                          e.dataTransfer.setData('pkg-path', pkg.path);
                        }}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault();
                          const sId = e.dataTransfer.getData('snippet-id');
                          const pPath = e.dataTransfer.getData('pkg-path');
                          if (sId) moveSnippet(sId, pkg.path);
                          if (pPath) movePackage(pPath, pkg.path);
                        }}
                        onClick={() => setSelectedPackage(pkg.path)}
                      >
                        <div className="flex items-center gap-3 h-full">
                          <div className="h-11 w-11 rounded-xl bg-primary/15 text-primary flex items-center justify-center flex-shrink-0">
                            <Package size={18} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-semibold truncate">{pkg.name}</div>
                            <div className="text-[11px] text-muted-foreground">{pkg.count} snippet{pkg.count === 1 ? '' : 's'}</div>
                          </div>
                        </div>
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onClick={() => setSelectedPackage(pkg.path)}>Open</ContextMenuItem>
                      <ContextMenuItem className="text-destructive" onClick={() => deletePackage(pkg.path)}>Delete</ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                ))}
              </div>
            </>
          )}

          {displayedSnippets.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-muted-foreground">Snippets</h3>
              <div className={cn(
                viewMode === 'grid'
                  ? "grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3"
                  : "flex flex-col gap-0"
              )}>
                {displayedSnippets.map((snippet) => (
                  <ContextMenu key={snippet.id}>
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
                          e.dataTransfer.setData('snippet-id', snippet.id);
                        }}
                        onClick={() => handleEdit(snippet)}
                      >
                        <div className="flex items-center gap-3 h-full">
                          <div className="h-11 w-11 rounded-xl bg-primary/15 text-primary flex items-center justify-center flex-shrink-0">
                            <FileCode size={18} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-semibold truncate">{snippet.label}</div>
                            <div className="text-[11px] text-muted-foreground font-mono leading-4 truncate">
                              {snippet.command.replace(/\s+/g, ' ') || 'Command'}
                            </div>
                          </div>
                          {viewMode === 'list' && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                              onClick={(e) => { e.stopPropagation(); handleEdit(snippet); }}
                            >
                              <Edit2 size={14} />
                            </Button>
                          )}
                        </div>
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem
                        onClick={() => {
                          const targetHostsList = (snippet.targets || [])
                            .map(id => hosts.find(h => h.id === id))
                            .filter((h): h is Host => Boolean(h));
                          if (targetHostsList.length > 0) {
                            onRunSnippet?.(snippet, targetHostsList);
                          }
                        }}
                        disabled={!snippet.targets?.length}
                      >
                        <Play className="mr-2 h-4 w-4" /> Run
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem onClick={() => handleEdit(snippet)}>
                        <Edit2 className="mr-2 h-4 w-4" /> Edit
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => handleCopy(snippet.id, snippet.command)}>
                        <Copy className="mr-2 h-4 w-4" /> Copy
                      </ContextMenuItem>
                      <ContextMenuItem className="text-destructive" onClick={() => onDelete(snippet.id)}>
                        <Trash2 className="mr-2 h-4 w-4" /> Delete
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* New Package Inline Form */}
      {isPackageDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <Card className="w-full max-w-sm p-4 space-y-4">
            <div>
              <p className="text-sm font-semibold">New Package</p>
              <p className="text-xs text-muted-foreground">Parent: {selectedPackage || 'Root'}</p>
            </div>
            <div className="space-y-2">
              <Label>Name</Label>
              <Input
                autoFocus
                placeholder="e.g. ops/maintenance"
                value={newPackageName}
                onChange={(e) => setNewPackageName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createPackage()}
              />
              <p className="text-[11px] text-muted-foreground">Use "/" to create nested packages.</p>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setIsPackageDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={createPackage}>Create</Button>
            </div>
          </Card>
        </div>
      )}

      {/* Right Panel */}
      {renderRightPanel()}
    </div>
  );
};

// History Item Component
interface HistoryItemProps {
  entry: ShellHistoryEntry;
  onSaveAsSnippet: (entry: ShellHistoryEntry, label: string) => void;
  onCopy: () => void;
  isCopied: boolean;
}

const HistoryItem: React.FC<HistoryItemProps> = ({ entry, onSaveAsSnippet, onCopy, isCopied }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [label, setLabel] = useState('');

  const handleSave = () => {
    if (label.trim()) {
      onSaveAsSnippet(entry, label);
      setIsEditing(false);
      setLabel('');
    }
  };

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  return (
    <div className="group rounded-lg bg-background/60 border border-border/50 p-3">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="font-mono text-sm truncate">{entry.command}</div>
          <div className="flex items-center gap-2 mt-1 text-[11px] text-muted-foreground">
            <span>{entry.hostLabel}</span>
            <span>•</span>
            <span>{formatTime(entry.timestamp)}</span>
          </div>
        </div>
        {!isEditing && (
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              onClick={onCopy}
            >
              {isCopied ? <Check size={14} /> : <Copy size={14} />}
            </Button>
            <Button
              variant="default"
              size="sm"
              className="h-7 px-3"
              onClick={() => setIsEditing(true)}
            >
              Save
            </Button>
          </div>
        )}
      </div>
      {isEditing && (
        <div className="mt-3 space-y-2">
          <Input
            placeholder="Set a label for this snippet"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSave()}
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setIsEditing(false); setLabel(''); }}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} disabled={!label.trim()}>
              Save as Snippet
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

export default SnippetsManager;
