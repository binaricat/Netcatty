import { Check, ChevronDown, Clock, Copy, Edit2, FileCode, FolderPlus, Keyboard, LayoutGrid, List as ListIcon, Loader2, Package, Play, Plus, RotateCcw, Search, Trash2 } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../application/i18n/I18nProvider';
import { useStoredViewMode } from '../application/state/useStoredViewMode';
import { STORAGE_KEY_VAULT_SNIPPETS_VIEW_MODE } from '../infrastructure/config/storageKeys';
import { cn, isMacPlatform } from '../lib/utils';
import { Host, ShellHistoryEntry, Snippet, SSHKey } from '../types';
import { HotkeyScheme, KeyBinding, keyEventToString, ManagedSource, matchesKeyBinding, parseKeyCombo } from '../domain/models';
import { DistroAvatar } from './DistroAvatar';
import SelectHostPanel from './SelectHostPanel';
import { AsidePanel, AsidePanelContent } from './ui/aside-panel';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Combobox, ComboboxOption } from './ui/combobox';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from './ui/context-menu';
import { Dropdown, DropdownContent, DropdownTrigger } from './ui/dropdown';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { SortDropdown, SortMode } from './ui/sort-dropdown';
import { Textarea } from './ui/textarea';

interface SnippetsManagerProps {
  snippets: Snippet[];
  packages: string[];
  hosts: Host[];
  customGroups?: string[];
  shellHistory: ShellHistoryEntry[];
  hotkeyScheme: HotkeyScheme;
  keyBindings: KeyBinding[];
  onSave: (snippet: Snippet) => void;
  onDelete: (id: string) => void;
  onPackagesChange: (packages: string[]) => void;
  onRunSnippet?: (snippet: Snippet, targetHosts: Host[]) => void;
  // Props for inline host creation
  availableKeys?: SSHKey[];
  managedSources?: ManagedSource[];
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
  hotkeyScheme,
  keyBindings,
  onSave,
  onDelete,
  onPackagesChange,
  onRunSnippet,
  availableKeys = [],
  managedSources = [],
  onSaveHost,
  onCreateGroup,
}) => {
  const { t } = useI18n();
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

  // Rename package state
  const [isRenameDialogOpen, setIsRenameDialogOpen] = useState(false);
  const [renamingPackagePath, setRenamingPackagePath] = useState<string | null>(null);
  const [renamePackageName, setRenamePackageName] = useState('');
  const [renameError, setRenameError] = useState('');

  // Search, sort, and view mode state
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useStoredViewMode(
    STORAGE_KEY_VAULT_SNIPPETS_VIEW_MODE,
    'grid',
  );
  const [sortMode, setSortMode] = useState<SortMode>('az');

  // Shell history lazy loading state
  const [historyVisibleCount, setHistoryVisibleCount] = useState(HISTORY_PAGE_SIZE);
  const historyScrollRef = useRef<HTMLDivElement>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  // Shortkey recording state
  const [isRecordingShortkey, setIsRecordingShortkey] = useState(false);
  const [shortkeyError, setShortkeyError] = useState<string | null>(null);

  const existingShortkeys = useMemo(() => (
    snippets.filter(s => Boolean(s.shortkey) && s.id !== editingSnippet.id)
  ), [snippets, editingSnippet.id]);

  const isMac = useMemo(() => (
    hotkeyScheme === 'mac' || (hotkeyScheme === 'disabled' && isMacPlatform())
  ), [hotkeyScheme]);

  const activeSystemBindings = useMemo(() => {
    return keyBindings.flatMap((binding) => {
      const entries: { binding: string; isMac: boolean }[] = [];
      const macBinding = binding.mac;
      const pcBinding = binding.pc;

      if (hotkeyScheme === 'mac') {
        if (macBinding && macBinding !== 'Disabled') {
          entries.push({ binding: macBinding, isMac: true });
        }
        return entries;
      }

      if (hotkeyScheme === 'pc') {
        if (pcBinding && pcBinding !== 'Disabled') {
          entries.push({ binding: pcBinding, isMac: false });
        }
        return entries;
      }

      if (macBinding && macBinding !== 'Disabled') {
        entries.push({ binding: macBinding, isMac: true });
      }
      if (pcBinding && pcBinding !== 'Disabled') {
        entries.push({ binding: pcBinding, isMac: false });
      }
      return entries;
    });
  }, [hotkeyScheme, keyBindings]);

  const buildKeyEventFromString = useCallback((keyString: string) => {
    const parsed = parseKeyCombo(keyString);
    if (!parsed) return null;

    const modifiers = new Set(parsed.modifiers);
    const key = parsed.key;
    const normalizedKey = (() => {
      switch (key) {
        case 'Space':
          return ' ';
        case '↑':
          return 'ArrowUp';
        case '↓':
          return 'ArrowDown';
        case '←':
          return 'ArrowLeft';
        case '→':
          return 'ArrowRight';
        case 'Esc':
          return 'Escape';
        case '⌫':
          return 'Backspace';
        case 'Del':
          return 'Delete';
        case '↵':
          return 'Enter';
        case '⇥':
          return 'Tab';
        default:
          return key.length === 1 ? key.toLowerCase() : key;
      }
    })();

    return new KeyboardEvent('keydown', {
      key: normalizedKey,
      metaKey: modifiers.has('⌘') || modifiers.has('Win'),
      ctrlKey: modifiers.has('⌃') || modifiers.has('Ctrl'),
      altKey: modifiers.has('⌥') || modifiers.has('Alt'),
      shiftKey: modifiers.has('Shift'),
    });
  }, []);

  // Validate shortkey for conflicts (case-insensitive comparison)
  const normalizeKeyString = useCallback((value: string) => (
    value.toLowerCase().replace(/\s+/g, '')
  ), []);

  const validateShortkey = useCallback((key: string): string | null => {
    if (!key) return null;
    
    const syntheticEvent = buildKeyEventFromString(key);
    if (syntheticEvent) {
      const conflictsSystem = activeSystemBindings.some(({ binding, isMac: bindingIsMac }) => (
        matchesKeyBinding(syntheticEvent, binding, bindingIsMac)
      ));
      if (conflictsSystem) {
        return t('snippets.shortkey.error.systemConflict');
      }
    }
    
    // Check other snippet shortcuts
    if (syntheticEvent) {
      for (const snippet of existingShortkeys) {
        if (snippet.shortkey && matchesKeyBinding(syntheticEvent, snippet.shortkey, isMac)) {
          return t('snippets.shortkey.error.snippetConflict', { name: snippet.label });
        }
      }
    } else {
      const normalizedKey = normalizeKeyString(key);
      const conflictingSnippet = existingShortkeys.find(snippet => (
        snippet.shortkey && normalizeKeyString(snippet.shortkey) === normalizedKey
      ));
      if (conflictingSnippet) {
        return t('snippets.shortkey.error.snippetConflict', { name: conflictingSnippet.label });
      }
    }
    
    return null;
  }, [
    activeSystemBindings,
    buildKeyEventFromString,
    existingShortkeys,
    isMac,
    normalizeKeyString,
    t,
  ]);

  // Handle shortkey recording
  useEffect(() => {
    if (!isRecordingShortkey) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // Escape cancels recording
      if (e.key === 'Escape') {
        setIsRecordingShortkey(false);
        setShortkeyError(null);
        return;
      }

      // Skip pure modifier keys
      if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return;

      const keyString = keyEventToString(e, isMac);
      
      // Validate the new shortkey
      const error = validateShortkey(keyString);
      if (error) {
        setShortkeyError(error);
        // Don't stop recording, let user try again
        return;
      }
      
      setShortkeyError(null);
      setEditingSnippet(prev => ({ ...prev, shortkey: keyString }));
      setIsRecordingShortkey(false);
    };

    const handleClick = () => {
      setIsRecordingShortkey(false);
      setShortkeyError(null);
    };

    // Delay adding click handler by 100ms to prevent the button click that
    // initiated recording from immediately triggering the click handler
    const timer = setTimeout(() => {
      window.addEventListener('click', handleClick, true);
    }, 100);

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('click', handleClick, true);
    };
  }, [isRecordingShortkey, isMac, validateShortkey]);

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
        shortkey: editingSnippet.shortkey,
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
      // Separate absolute paths (starting with /) from relative paths
      const absolutePaths = packages.filter(p => p.startsWith('/'));
      const relativePaths = packages.filter(p => !p.startsWith('/'));
      
      const results: { name: string; path: string; count: number }[] = [];
      
      // Process relative paths (traditional behavior)
      const relativeRoots = relativePaths
        .map((p) => p.split('/')[0])
        .filter((name): name is string => Boolean(name) && name.length > 0);
      
      Array.from(new Set(relativeRoots)).forEach((name: string) => {
        const path: string = name;
        const count = snippets.filter((s) => {
          const pkg = s.package || '';
          return pkg === path || pkg.startsWith(path + '/');
        }).length;
        results.push({ name, path, count });
      });
      
      // Process absolute paths - show them as separate roots with "/" prefix
      const absoluteRoots = absolutePaths
        .map((p) => {
          const cleanPath = p.substring(1); // Remove leading slash
          const firstSegment = cleanPath.split('/')[0];
          return firstSegment;
        })
        .filter((name): name is string => Boolean(name) && name.length > 0);
      
      Array.from(new Set(absoluteRoots)).forEach((name: string) => {
        const path: string = `/${name}`;
        const displayName: string = `/${name}`; // Show with leading slash to distinguish
        const count = snippets.filter((s) => {
          const pkg = s.package || '';
          return pkg === path || pkg.startsWith(path + '/');
        }).length;
        results.push({ name: displayName, path, count });
      });
      
      return results;
    }
    
    const prefix = selectedPackage + '/';
    const children = packages
      .filter((p) => p.startsWith(prefix))
      .map((p) => p.replace(prefix, '').split('/')[0])
      .filter((name): name is string => Boolean(name) && name.length > 0);
    return Array.from(new Set(children)).map((name) => {
      const path = `${selectedPackage}/${name}`;
      // Count snippets in this package AND all nested packages
      const count = snippets.filter((s) => {
        const pkg = s.package || '';
        return pkg === path || pkg.startsWith(path + '/');
      }).length;
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
    const isAbsolute = selectedPackage.startsWith('/');
    const parts = selectedPackage.split('/').filter(Boolean);
    return parts.map((name, idx) => {
      const pathSegments = parts.slice(0, idx + 1);
      const path = isAbsolute ? `/${pathSegments.join('/')}` : pathSegments.join('/');
      return { name, path };
    });
  }, [selectedPackage]);

  const createPackage = () => {
    const name = newPackageName.trim();
    if (!name) return;
    
    // Allow leading slash and validate the rest - allow hyphens anywhere in package names
    if (!/^\/?([\w-]+(\/[\w-]+)*)\/?$/.test(name)) {
      // Could add toast notification here for invalid characters
      return;
    }
    
    // Normalize path construction to avoid double slashes
    let full: string;
    if (selectedPackage) {
      // Strip leading slash from name when we're inside a package to avoid double slashes
      const normalizedName = name.startsWith('/') ? name.substring(1) : name;
      full = `${selectedPackage}/${normalizedName}`;
    } else {
      // At root level, preserve the leading slash if user intended it
      full = name;
    }

    // Strip trailing slash to ensure consistent path handling
    if (full.endsWith('/')) {
      full = full.slice(0, -1);
    }
    
    // Check for duplicate package names (case-insensitive)
    const existingPackage = packages.find(p => p.toLowerCase() === full.toLowerCase());
    if (existingPackage) {
      // Could add toast notification here for duplicate package
      return;
    }
    
    onPackagesChange([...packages, full]);
    setNewPackageName('');
    setIsPackageDialogOpen(false);
  };

  const deletePackage = (path: string) => {
    // Remove the package and all its children
    const keep = packages.filter((p) => !(p === path || p.startsWith(path + '/')));
    
    // Move all snippets from deleted packages to root
    const updatedSnippets = snippets.map((s) => {
      if (!s.package) return s;
      if (s.package === path || s.package.startsWith(path + '/')) {
        return { ...s, package: '' };
      }
      return s;
    });
    
    // Update packages first, then save snippets
    onPackagesChange(keep);
    
    // Only save snippets that were actually modified
    const modifiedSnippets = updatedSnippets.filter((s, index) => 
      s.package !== snippets[index].package
    );
    modifiedSnippets.forEach(onSave);
    
    // Reset selected package if it was deleted
    if (selectedPackage && (selectedPackage === path || selectedPackage.startsWith(path + '/'))) {
      setSelectedPackage(null);
    }
  };

  const movePackage = (source: string, target: string | null) => {
    const name = source.split('/').pop() || '';
    const isAbsolute = source.startsWith('/');
    const newPath = target ? `${target}/${name}` : (isAbsolute ? `/${name}` : name);
    if (newPath === source || newPath.startsWith(source + '/')) return;

    // Check if target path already exists
    if (packages.includes(newPath)) return;

    const updatedPackages = packages.map((p) => {
      if (p === source) return newPath;
      // Use more precise replacement to avoid substring issues
      if (p.startsWith(source + '/')) {
        return newPath + p.substring(source.length);
      }
      return p;
    });

    const updatedSnippets = snippets.map((s) => {
      if (!s.package) return s;
      if (s.package === source) return { ...s, package: newPath };
      // Use more precise replacement to avoid substring issues
      if (s.package.startsWith(source + '/')) {
        return { ...s, package: newPath + s.package.substring(source.length) };
      }
      return s;
    });

    onPackagesChange(Array.from(new Set(updatedPackages)));
    updatedSnippets.forEach(onSave);
    if (selectedPackage === source) setSelectedPackage(newPath);
  };

  const openRenameDialog = (path: string) => {
    const name = path.split('/').pop() || '';
    setRenamingPackagePath(path);
    setRenamePackageName(name);
    setRenameError('');
    setIsRenameDialogOpen(true);
  };

  const renamePackage = () => {
    if (!renamingPackagePath) return;

    const newName = renamePackageName.trim();

    // Validate: empty name
    if (!newName) {
      setRenameError(t('snippets.renameDialog.error.empty'));
      return;
    }

    // Validate: same rules as createPackage - only allow letters, numbers, hyphens, underscores
    // Since we're renaming a single segment (no slashes allowed), use the segment-level pattern
    if (!/^[\w-]+$/.test(newName)) {
      setRenameError(t('snippets.renameDialog.error.invalidChars'));
      return;
    }

    // Build new path
    const parts = renamingPackagePath.split('/');
    parts[parts.length - 1] = newName;
    const newPath = parts.join('/');

    // Validate: same name
    if (newPath === renamingPackagePath) {
      setIsRenameDialogOpen(false);
      return;
    }

    // Validate: duplicate (case-insensitive)
    const existingPackage = packages.find(p => p.toLowerCase() === newPath.toLowerCase());
    if (existingPackage) {
      setRenameError(t('snippets.renameDialog.error.duplicate'));
      return;
    }

    // Update all packages with this path or nested under it
    const updatedPackages = packages.map((p) => {
      if (p === renamingPackagePath) return newPath;
      if (p.startsWith(renamingPackagePath + '/')) {
        return newPath + p.substring(renamingPackagePath.length);
      }
      return p;
    });

    // Update all snippets with this package or nested under it
    const updatedSnippets = snippets.map((s) => {
      if (!s.package) return s;
      if (s.package === renamingPackagePath) return { ...s, package: newPath };
      if (s.package.startsWith(renamingPackagePath + '/')) {
        return { ...s, package: newPath + s.package.substring(renamingPackagePath.length) };
      }
      return s;
    });

    onPackagesChange(Array.from(new Set(updatedPackages)));
    updatedSnippets.forEach(onSave);

    // Update selected package if it was renamed
    if (selectedPackage === renamingPackagePath) {
      setSelectedPackage(newPath);
    } else if (selectedPackage?.startsWith(renamingPackagePath + '/')) {
      setSelectedPackage(newPath + selectedPackage.substring(renamingPackagePath.length));
    }

    // Update editingSnippet.package if it's in the renamed package (fixes stale state when editing)
    if (editingSnippet.package) {
      if (editingSnippet.package === renamingPackagePath) {
        setEditingSnippet(prev => ({ ...prev, package: newPath }));
      } else if (editingSnippet.package.startsWith(renamingPackagePath + '/')) {
        setEditingSnippet(prev => ({
          ...prev,
          package: newPath + prev.package!.substring(renamingPackagePath.length)
        }));
      }
    }

    setIsRenameDialogOpen(false);
  };

  const moveSnippet = (id: string, pkg: string | null) => {
    const sn = snippets.find((s) => s.id === id);
    if (!sn) return;
    onSave({ ...sn, package: pkg || '' });
  };

  // Package options for Combobox
  const packageOptions: ComboboxOption[] = useMemo(() => {
    // Generate all possible parent paths for each package
    const allPaths = new Set<string>();
    
    packages.forEach(pkg => {
      // Add the full package path
      allPaths.add(pkg);
      
      // Add all parent paths
      const parts = pkg.split('/').filter(Boolean);
      const isAbsolute = pkg.startsWith('/');
      
      for (let i = 1; i < parts.length; i++) {
        const parentPath = (isAbsolute ? '/' : '') + parts.slice(0, i).join('/');
        allPaths.add(parentPath);
      }
    });
    
    return Array.from(allPaths)
      .sort((a, b) => {
        // Sort by depth first (shorter paths first), then alphabetically
        const depthA = (a.match(/\//g) || []).length;
        const depthB = (b.match(/\//g) || []).length;
        if (depthA !== depthB) return depthA - depthB;
        return a.localeCompare(b);
      })
      .map(p => ({
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
          managedSources={managedSources}
          onSaveHost={onSaveHost}
          onCreateGroup={onCreateGroup}
          title={t('snippets.targets.add')}
        />
      );
    }

    if (rightPanelMode === 'edit-snippet') {
      return (
        <AsidePanel
          open={true}
          onClose={handleClosePanel}
          title={editingSnippet.id ? t('snippets.panel.editTitle') : t('snippets.panel.newTitle')}
          actions={
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={handleSubmit}
              disabled={!editingSnippet.label || !editingSnippet.command}
              aria-label={t('common.save')}
            >
              <Check size={16} />
            </Button>
          }
        >
          <AsidePanelContent>
            {/* Action Description */}
            <Card className="p-3 space-y-2 bg-card border-border/80">
              <p className="text-xs font-semibold text-muted-foreground">{t('snippets.field.description')}</p>
              <Input
                placeholder={t('snippets.field.descriptionPlaceholder')}
                value={editingSnippet.label || ''}
                onChange={(e) => setEditingSnippet({ ...editingSnippet, label: e.target.value })}
                className="h-10"
              />
            </Card>

            {/* Package */}
            <Card className="p-3 space-y-2 bg-card border-border/80">
              <p className="text-xs font-semibold text-muted-foreground">{t('snippets.field.package')}</p>
              <Combobox
                options={packageOptions}
                value={editingSnippet.package || selectedPackage || ''}
                onValueChange={(val) => {
                  setEditingSnippet({ ...editingSnippet, package: val });
                  // If selecting an implicit parent path, persist it to packages
                  if (val && !packages.includes(val)) {
                    onPackagesChange([...packages, val]);
                  }
                }}
                placeholder={t('snippets.field.packagePlaceholder')}
                allowCreate={true}
                onCreateNew={(val) => {
                  if (!packages.includes(val)) {
                    onPackagesChange([...packages, val]);
                  }
                }}
                createText={t('snippets.field.createPackage')}
                icon={<Package size={16} />}
                triggerClassName="h-10"
              />
            </Card>

            {/* Script */}
            <Card className="p-3 space-y-2 bg-card border-border/80">
              <p className="text-xs font-semibold text-muted-foreground">{t('snippets.field.scriptRequired')}</p>
              <Textarea
                placeholder="ls -l"
                className="min-h-[120px] font-mono text-xs"
                value={editingSnippet.command || ''}
                onChange={(e) => setEditingSnippet({ ...editingSnippet, command: e.target.value })}
              />
            </Card>

            {/* Shortkey */}
            <Card className="p-3 space-y-2 bg-card border-border/80">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-muted-foreground">{t('snippets.field.shortkey')}</p>
                {editingSnippet.shortkey && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => {
                      setEditingSnippet(prev => ({ ...prev, shortkey: undefined }));
                      setShortkeyError(null);
                    }}
                    title={t('snippets.shortkey.clear')}
                  >
                    <RotateCcw size={12} />
                  </Button>
                )}
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsRecordingShortkey(true);
                  setShortkeyError(null);
                }}
                className={cn(
                  "w-full h-10 px-3 text-sm font-mono rounded-lg border transition-colors flex items-center justify-center gap-2",
                  isRecordingShortkey
                    ? "border-primary bg-primary/10 animate-pulse"
                    : "border-border hover:border-primary/50 bg-background"
                )}
              >
                <Keyboard size={14} className="text-muted-foreground" />
                {isRecordingShortkey
                  ? t('snippets.shortkey.recording')
                  : editingSnippet.shortkey || t('snippets.shortkey.placeholder')}
              </button>
              {shortkeyError && (
                <p className="text-xs text-destructive">{shortkeyError}</p>
              )}
              <p className="text-[11px] text-muted-foreground">{t('snippets.shortkey.hint')}</p>
            </Card>

            {/* Targets */}
            <Card className="p-3 space-y-3 bg-card border-border/80">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-muted-foreground">{t('snippets.targets.title')}</p>
                <Button variant="ghost" size="sm" className="h-6 px-2 text-xs text-primary" onClick={openTargetPicker}>
                  {t('action.edit')}
                </Button>
              </div>

              {targetHosts.length === 0 ? (
                <Button
                  variant="secondary"
                  className="w-full h-10"
                  onClick={openTargetPicker}
                >
                  {t('snippets.targets.add')}
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
              {editingSnippet.targets?.length ? t('action.run') : t('common.save')}
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
          title={t('snippets.history.title')}
          subtitle={t('snippets.history.subtitle', { count: shellHistory.length })}
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
                <p className="text-sm">{t('snippets.history.emptyTitle')}</p>
                <p className="text-xs mt-1">{t('snippets.history.emptyDesc')}</p>
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
                        {t('snippets.history.loadMore')}
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
        <header className="border-b border-border/50 bg-secondary/80 backdrop-blur">
          <div className="h-14 px-4 py-2 flex items-center gap-2">
            {/* Search box */}
            <div className="relative w-64">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder={t('snippets.searchPlaceholder')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-10 pl-9 bg-secondary border-border/60 text-sm"
              />
            </div>
            <Button onClick={() => handleEdit()} size="sm" className="h-10">
              <Plus size={14} className="mr-2" /> {t('snippets.action.newSnippet')}
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
              <FolderPlus size={14} className="mr-1" /> {t('snippets.action.newPackage')}
            </Button>
            <Button
              variant={rightPanelMode === 'history' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-10 gap-2"
              onClick={() => setRightPanelMode(rightPanelMode === 'history' ? 'none' : 'history')}
            >
              <Clock size={14} /> {t('snippets.history.title')}
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
                    <LayoutGrid size={14} /> {t('snippets.view.grid')}
                  </Button>
                  <Button
                    variant={viewMode === 'list' ? 'secondary' : 'ghost'}
                    className="w-full justify-start gap-2 h-9"
                    onClick={() => setViewMode('list')}
                  >
                    <ListIcon size={14} /> {t('snippets.view.list')}
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
        </header>
        <div className="flex items-center gap-2 text-sm font-semibold px-4 py-2">
          <button className="text-primary hover:underline" onClick={() => setSelectedPackage(null)}>{t('snippets.breadcrumb.allPackages')}</button>
          {breadcrumb.map((b) => (
            <span key={b.path} className="flex items-center gap-2">
              <span className="text-muted-foreground">{t('snippets.breadcrumb.separator')}</span>
              <button className="text-primary hover:underline" onClick={() => setSelectedPackage(b.path)}>{b.name}</button>
            </span>
          ))}
        </div>

        {!snippets.length && displayedPackages.length === 0 && (
          <div className="flex-1 flex items-center justify-center px-4">
            <div className="flex flex-col items-center justify-center text-muted-foreground">
              <div className="h-16 w-16 rounded-2xl bg-secondary/80 flex items-center justify-center mb-4">
                <FileCode size={32} className="opacity-60" />
              </div>
              <h3 className="text-lg font-semibold text-foreground mb-2">{t('snippets.empty.title')}</h3>
              <p className="text-sm text-center max-w-sm">{t('snippets.empty.desc')}</p>
            </div>
          </div>
        )}

        <div className="flex-1 space-y-3 overflow-y-auto px-4 pb-4">
          {displayedPackages.length > 0 && (
            <>
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-muted-foreground">{t('snippets.section.packages')}</h3>
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
                            <div className="text-[11px] text-muted-foreground">{t('snippets.package.count', { count: pkg.count })}</div>
                          </div>
                        </div>
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onClick={() => setSelectedPackage(pkg.path)}>{t('action.open')}</ContextMenuItem>
                      <ContextMenuItem onClick={() => openRenameDialog(pkg.path)}>{t('common.rename')}</ContextMenuItem>
                      <ContextMenuItem className="text-destructive" onClick={() => deletePackage(pkg.path)}>{t('action.delete')}</ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                ))}
              </div>
            </>
          )}

          {displayedSnippets.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-muted-foreground">{t('snippets.section.snippets')}</h3>
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
                              {snippet.command.replace(/\s+/g, ' ') || t('snippets.commandFallback')}
                            </div>
                          </div>
                          {snippet.shortkey && (
                            <div className="shrink-0 px-2 py-1 text-[10px] font-mono rounded border border-border bg-muted/50 text-muted-foreground">
                              {snippet.shortkey}
                            </div>
                          )}
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
                        <Play className="mr-2 h-4 w-4" /> {t('action.run')}
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem onClick={() => handleEdit(snippet)}>
                        <Edit2 className="mr-2 h-4 w-4" /> {t('action.edit')}
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => handleCopy(snippet.id, snippet.command)}>
                        <Copy className="mr-2 h-4 w-4" /> {t('action.copy')}
                      </ContextMenuItem>
                      <ContextMenuItem className="text-destructive" onClick={() => onDelete(snippet.id)}>
                        <Trash2 className="mr-2 h-4 w-4" /> {t('action.delete')}
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
              <p className="text-sm font-semibold">{t('snippets.packageDialog.title')}</p>
              <p className="text-xs text-muted-foreground">{t('snippets.packageDialog.parent', { parent: selectedPackage || t('snippets.packageDialog.root') })}</p>
            </div>
            <div className="space-y-2">
              <Label>{t('field.name')}</Label>
              <Input
                autoFocus
                placeholder={t('snippets.packageDialog.placeholder')}
                value={newPackageName}
                onChange={(e) => setNewPackageName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createPackage()}
                pattern="^/?([\w-]+(/[\w-]+)*)?/?$"
                title="Package names can contain letters, numbers, hyphens, underscores, and forward slashes. Can optionally start with /"
              />
              <p className="text-[11px] text-muted-foreground">{t('snippets.packageDialog.hint')}</p>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setIsPackageDialogOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button onClick={createPackage}>{t('common.create')}</Button>
            </div>
          </Card>
        </div>
      )}

      {/* Rename Package Dialog */}
      {isRenameDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <Card className="w-full max-w-sm p-4 space-y-4">
            <div>
              <p className="text-sm font-semibold">{t('snippets.renameDialog.title')}</p>
              <p className="text-xs text-muted-foreground">{t('snippets.renameDialog.currentPath', { path: renamingPackagePath })}</p>
            </div>
            <div className="space-y-2">
              <Label>{t('field.name')}</Label>
              <Input
                autoFocus
                placeholder={t('snippets.renameDialog.placeholder')}
                value={renamePackageName}
                onChange={(e) => {
                  setRenamePackageName(e.target.value);
                  setRenameError('');
                }}
                onKeyDown={(e) => e.key === 'Enter' && renamePackage()}
              />
              {renameError && (
                <p className="text-[11px] text-destructive">{renameError}</p>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setIsRenameDialogOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button onClick={renamePackage}>{t('common.rename')}</Button>
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
  const { t } = useI18n();
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

    if (diffMins < 1) return t('snippets.history.time.justNow');
    if (diffMins < 60) return t('snippets.history.time.minutesAgo', { count: diffMins });
    if (diffHours < 24) return t('snippets.history.time.hoursAgo', { count: diffHours });
    if (diffDays < 7) return t('snippets.history.time.daysAgo', { count: diffDays });
    return date.toLocaleDateString();
  };

  return (
    <div className="group rounded-lg bg-background/60 border border-border/50 p-3">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="font-mono text-sm truncate">{entry.command}</div>
          <div className="flex items-center gap-2 mt-1 text-[11px] text-muted-foreground">
            <span>{entry.hostLabel}</span>
            <span>{t('snippets.history.separator')}</span>
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
              {t('common.save')}
            </Button>
          </div>
        )}
      </div>
      {isEditing && (
        <div className="mt-3 space-y-2">
          <Input
            placeholder={t('snippets.history.labelPlaceholder')}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSave()}
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setIsEditing(false); setLabel(''); }}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={handleSave} disabled={!label.trim()}>
              {t('snippets.history.saveAsSnippet')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

export default SnippetsManager;
