import { ChevronDown, Clock, Copy, Edit2, FileCode, FolderPlus, LayoutGrid, List as ListIcon, Package, Play, Plus, Search, Trash2 } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../application/i18n/I18nProvider';
import { useStoredViewMode } from '../application/state/useStoredViewMode';
import { STORAGE_KEY_VAULT_SNIPPETS_VIEW_MODE } from '../infrastructure/config/storageKeys';
import { cn, isMacPlatform } from '../lib/utils';
import { Host, ProxyProfile, ShellHistoryEntry, Snippet, SSHKey } from '../types';
import { HotkeyScheme, KeyBinding, keyEventToString, ManagedSource, matchesKeyBinding, parseKeyCombo } from '../domain/models';
import { reorderVaultItems, reorderVaultStrings, sortByVaultOrder } from '../domain/vaultOrder';
import { Button } from './ui/button';
import { ComboboxOption } from './ui/combobox';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from './ui/context-menu';
import { Dropdown, DropdownContent, DropdownTrigger } from './ui/dropdown';
import { SortDropdown, SortMode } from './ui/sort-dropdown';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { SnippetsRightPanel } from './SnippetsRightPanel';
import { SnippetsPackageDialogs } from './SnippetsPackageDialogs';
import {
  VaultHeaderSearch,
  VaultPageHeader,
  vaultHeaderIconButtonClass,
  vaultHeaderSecondaryButtonClass,
  vaultSectionTitleClass,
} from './vault/VaultPageHeader';
import {
  VaultEntityIcon,
  vaultPrimaryIconClass,
  vaultSnippetIconClass,
} from './vault/VaultEntityIcon';
import {
  clearVaultDropIndicator as clearSnippetDropIndicator,
  getVaultDropIntent as getPackageDropIntent,
  getVaultDropPosition as getDropPosition,
  hasVaultDragType as hasDragType,
  markVaultDropIndicator as markSnippetDropIndicator,
  markVaultInsideDropIndicator as markSnippetInsideIndicator,
  useVaultGridLayoutAnimation,
} from './vault/vaultReorderDrag';

interface SnippetsManagerProps {
  snippets: Snippet[];
  packages: string[];
  hosts: Host[];
  customGroups?: string[];
  shellHistory: ShellHistoryEntry[];
  hotkeyScheme: HotkeyScheme;
  keyBindings: KeyBinding[];
  onSave: (snippet: Snippet) => void;
  onBulkSave: (snippets: Snippet[]) => void;
  onDelete: (id: string) => void;
  onPackagesChange: (packages: string[]) => void;
  onRunSnippet?: (snippet: Snippet, targetHosts: Host[]) => void;
  availableKeys?: SSHKey[];
  proxyProfiles?: ProxyProfile[];
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
  onBulkSave,
  onDelete,
  onPackagesChange,
  onRunSnippet,
  availableKeys = [],
  proxyProfiles = [],
  managedSources = [],
  onSaveHost,
  onCreateGroup,
}) => {
  const { t } = useI18n();
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

  const [isRenameDialogOpen, setIsRenameDialogOpen] = useState(false);
  const [renamingPackagePath, setRenamingPackagePath] = useState<string | null>(null);
  const [renamePackageName, setRenamePackageName] = useState('');
  const [renameError, setRenameError] = useState('');

  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useStoredViewMode(
    STORAGE_KEY_VAULT_SNIPPETS_VIEW_MODE,
    'grid',
  );
  const [sortMode, setSortMode] = useState<SortMode>('manual');
  const listRef = useRef<HTMLDivElement | null>(null);
  const lastPreviewReorderRef = useRef<string | null>(null);
  const draggingSnippetIdRef = useRef<string | null>(null);
  const draggingPackagePathRef = useRef<string | null>(null);
  const [draggingSnippetId, setDraggingSnippetId] = useState<string | null>(null);
  const [draggingPackagePath, setDraggingPackagePath] = useState<string | null>(null);
  const prepareGridLayoutAnimation = useVaultGridLayoutAnimation(listRef);

  const [historyVisibleCount, setHistoryVisibleCount] = useState(HISTORY_PAGE_SIZE);
  const historyScrollRef = useRef<HTMLDivElement>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

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

  useEffect(() => {
    if (!isRecordingShortkey) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape') {
        setIsRecordingShortkey(false);
        setShortkeyError(null);
        return;
      }

      if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return;

      const keyString = keyEventToString(e, isMac);
      
      const error = validateShortkey(keyString);
      if (error) {
        setShortkeyError(error);
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
        noAutoRun: editingSnippet.noAutoRun,
        order: editingSnippet.order,
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
    const packageIndexByPath = new Map(packages.map((pkg, index) => [pkg, index]));
    const getPackageDisplayOrder = (path: string) => {
      const exactIndex = packageIndexByPath.get(path);
      if (typeof exactIndex === 'number') return exactIndex;
      const childIndex = packages.findIndex((pkg) => pkg.startsWith(path + '/'));
      return childIndex >= 0 ? childIndex : Number.MAX_SAFE_INTEGER;
    };
    const sortBySavedPackageOrder = (
      items: { name: string; path: string; count: number }[],
    ) => {
      return [...items].sort((a, b) => {
        const orderDiff = getPackageDisplayOrder(a.path) - getPackageDisplayOrder(b.path);
        if (orderDiff !== 0) return orderDiff;
        return a.name.localeCompare(b.name);
      });
    };

    if (!selectedPackage) {
      const absolutePaths = packages.filter(p => p.startsWith('/'));
      const relativePaths = packages.filter(p => !p.startsWith('/'));
      
      const results: { name: string; path: string; count: number }[] = [];
      
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
      
      return sortBySavedPackageOrder(results);
    }
    
    const prefix = selectedPackage + '/';
    const children = packages
      .filter((p) => p.startsWith(prefix))
      .map((p) => p.replace(prefix, '').split('/')[0])
      .filter((name): name is string => Boolean(name) && name.length > 0);
    return sortBySavedPackageOrder(Array.from(new Set<string>(children)).map((name) => {
      const path = `${selectedPackage}/${name}`;
      const count = snippets.filter((s) => {
        const pkg = s.package || '';
        return pkg === path || pkg.startsWith(path + '/');
      }).length;
      return { name, path, count };
    }));
  }, [packages, selectedPackage, snippets]);

  const displayedSnippets = useMemo(() => {
    const hasSearch = search.trim().length > 0;
    let result = hasSearch
      ? snippets
      : snippets.filter((s) => (s.package || '') === (selectedPackage || ''));
    if (hasSearch) {
      const s = search.toLowerCase();
      result = result.filter(sn =>
        sn.label.toLowerCase().includes(s) ||
        sn.command.toLowerCase().includes(s)
      );
    }
    result = [...result].sort((a, b) => {
      switch (sortMode) {
        case 'az':
          return a.label.localeCompare(b.label);
        case 'za':
          return b.label.localeCompare(a.label);
        case 'manual':
          return 0;
        default:
          return 0;
      }
    });
    return sortMode === 'manual' ? sortByVaultOrder(result) : result;
  }, [snippets, selectedPackage, search, sortMode]);

  const isSearchActive = search.trim().length > 0;

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
    
    if (!/^\/?([\w\p{L}\p{N}-]+(\/[\w\p{L}\p{N}-]+)*)\/?$/u.test(name)) {
      return;
    }
    
    let full: string;
    if (selectedPackage) {
      const normalizedName = name.startsWith('/') ? name.substring(1) : name;
      full = `${selectedPackage}/${normalizedName}`;
    } else {
      full = name;
    }

    if (full.endsWith('/')) {
      full = full.slice(0, -1);
    }
    
    const existingPackage = packages.find(p => p.toLowerCase() === full.toLowerCase());
    if (existingPackage) {
      return;
    }
    
    onPackagesChange([...packages, full]);
    setNewPackageName('');
    setIsPackageDialogOpen(false);
  };

  const deletePackage = (path: string) => {
    const keep = packages.filter((p) => !(p === path || p.startsWith(path + '/')));
    
    const updatedSnippets = snippets.map((s) => {
      if (!s.package) return s;
      if (s.package === path || s.package.startsWith(path + '/')) {
        return { ...s, package: '' };
      }
      return s;
    });
    
    onPackagesChange(keep);
    
    onBulkSave(updatedSnippets);
    
    if (selectedPackage && (selectedPackage === path || selectedPackage.startsWith(path + '/'))) {
      setSelectedPackage(null);
    }
  };

  const movePackage = (source: string, target: string | null) => {
    const name = source.split('/').pop() || '';
    const isAbsolute = source.startsWith('/');
    const newPath = target ? `${target}/${name}` : (isAbsolute ? `/${name}` : name);
    if (newPath === source || newPath.startsWith(source + '/')) return;

    if (packages.includes(newPath)) return;

    const updatedPackages = packages.map((p) => {
      if (p === source) return newPath;
      if (p.startsWith(source + '/')) {
        return newPath + p.substring(source.length);
      }
      return p;
    });

    const updatedSnippets = snippets.map((s) => {
      if (!s.package) return s;
      if (s.package === source) return { ...s, package: newPath };
      if (s.package.startsWith(source + '/')) {
        return { ...s, package: newPath + s.package.substring(source.length) };
      }
      return s;
    });

    onPackagesChange(Array.from(new Set(updatedPackages)));
    onBulkSave(updatedSnippets);
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

    if (!newName) {
      setRenameError(t('snippets.renameDialog.error.empty'));
      return;
    }

    if (!/^[\w\p{L}\p{N}-]+$/u.test(newName)) {
      setRenameError(t('snippets.renameDialog.error.invalidChars'));
      return;
    }

    const parts = renamingPackagePath.split('/');
    parts[parts.length - 1] = newName;
    const newPath = parts.join('/');

    if (newPath === renamingPackagePath) {
      setIsRenameDialogOpen(false);
      return;
    }

    const existingPackage = packages.find(p => p !== renamingPackagePath && p.toLowerCase() === newPath.toLowerCase());
    if (existingPackage) {
      setRenameError(t('snippets.renameDialog.error.duplicate'));
      return;
    }

    const updatedPackages = packages.map((p) => {
      if (p === renamingPackagePath) return newPath;
      if (p.startsWith(renamingPackagePath + '/')) {
        return newPath + p.substring(renamingPackagePath.length);
      }
      return p;
    });

    const updatedSnippets = snippets.map((s) => {
      if (!s.package) return s;
      if (s.package === renamingPackagePath) return { ...s, package: newPath };
      if (s.package.startsWith(renamingPackagePath + '/')) {
        return { ...s, package: newPath + s.package.substring(renamingPackagePath.length) };
      }
      return s;
    });

    onPackagesChange(Array.from(new Set(updatedPackages)));
    onBulkSave(updatedSnippets);

    if (selectedPackage === renamingPackagePath) {
      setSelectedPackage(newPath);
    } else if (selectedPackage?.startsWith(renamingPackagePath + '/')) {
      setSelectedPackage(newPath + selectedPackage.substring(renamingPackagePath.length));
    }

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

  const parentOfPackage = useCallback((path: string) => {
    const parts = path.split('/').filter(Boolean);
    const prefix = path.startsWith('/') ? '/' : '';
    return prefix + parts.slice(0, -1).join('/');
  }, []);

  const resetSnippetDragState = useCallback(() => {
    clearSnippetDropIndicator();
    lastPreviewReorderRef.current = null;
    draggingSnippetIdRef.current = null;
    draggingPackagePathRef.current = null;
    setDraggingSnippetId(null);
    setDraggingPackagePath(null);
  }, []);

  const handleReorderDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const target = (event.target as Element | null)?.closest('[data-snippet-id], [data-pkg-path]');
    if (!(target instanceof HTMLElement)) return;

    const isGrid = viewMode === 'grid';
    const targetSnippetId = target.getAttribute('data-snippet-id');
    const targetPackage = target.getAttribute('data-pkg-path');
    const isDraggingSnippet = Boolean(draggingSnippetIdRef.current) || hasDragType(event.dataTransfer, 'snippet-id');
    const isDraggingPackage = Boolean(draggingPackagePathRef.current) || hasDragType(event.dataTransfer, 'pkg-path');
    if (targetSnippetId && isDraggingSnippet) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const sourceSnippetId = draggingSnippetIdRef.current || event.dataTransfer.getData('snippet-id');
      const position = getDropPosition(target, event.clientX, event.clientY, isGrid);
      if (isGrid && sourceSnippetId && sourceSnippetId !== targetSnippetId) {
        const targetSnippet = snippets.find((snippet) => snippet.id === targetSnippetId);
        const sourceSnippet = snippets.find((snippet) => snippet.id === sourceSnippetId);
        if (!targetSnippet || !sourceSnippet) return;
        const previewKey = `${sourceSnippetId}:${targetSnippetId}:${position}`;
        if (lastPreviewReorderRef.current === previewKey) return;
        prepareGridLayoutAnimation();
        lastPreviewReorderRef.current = previewKey;
        const movedSnippets = snippets.map((snippet) =>
          snippet.id === sourceSnippetId
            ? { ...snippet, package: targetSnippet.package || '' }
            : snippet,
        );
        onBulkSave(reorderVaultItems(movedSnippets, sourceSnippetId, targetSnippetId, position));
        setSortMode('manual');
        return;
      }
      markSnippetDropIndicator(target, position, isGrid ? 'x' : 'y');
      return;
    }
    if (targetPackage && isDraggingSnippet) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      markSnippetInsideIndicator(target);
      return;
    }
    if (targetPackage && isDraggingPackage) {
      const sourcePackage = draggingPackagePathRef.current || event.dataTransfer.getData('pkg-path');
      if (
        sourcePackage &&
        targetPackage.startsWith(`${sourcePackage}/`)
      ) {
        event.dataTransfer.dropEffect = 'none';
        clearSnippetDropIndicator();
        return;
      }
      const intent = getPackageDropIntent(target, event.clientX, event.clientY, isGrid);
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      if (intent === 'inside') {
        markSnippetInsideIndicator(target);
        return;
      }
      if (
        isGrid &&
        sourcePackage &&
        parentOfPackage(sourcePackage) === parentOfPackage(targetPackage)
      ) {
        const previewKey = `package:${sourcePackage}:${targetPackage}:${intent}`;
        if (lastPreviewReorderRef.current !== previewKey) {
          prepareGridLayoutAnimation();
          lastPreviewReorderRef.current = previewKey;
          const sortablePackages = Array.from(new Set([...packages, sourcePackage, targetPackage]));
          onPackagesChange(reorderVaultStrings(sortablePackages, sourcePackage, targetPackage, intent));
          setSortMode('manual');
        }
        return;
      }
      markSnippetDropIndicator(target, intent, isGrid ? 'x' : 'y');
      return;
    }
    event.dataTransfer.dropEffect = 'none';
    clearSnippetDropIndicator();
  }, [
    onBulkSave,
    onPackagesChange,
    packages,
    parentOfPackage,
    prepareGridLayoutAnimation,
    snippets,
    viewMode,
  ]);

  const handleReorderDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const target = (event.target as Element | null)?.closest('[data-snippet-id], [data-pkg-path]');
    clearSnippetDropIndicator();
    if (!(target instanceof HTMLElement)) return;
    const isGrid = viewMode === 'grid';

    const sourceSnippetId = draggingSnippetIdRef.current || event.dataTransfer.getData('snippet-id');
    const targetSnippetId = target.getAttribute('data-snippet-id');
    if (sourceSnippetId && targetSnippetId) {
      event.preventDefault();
      event.stopPropagation();
      if (sourceSnippetId === targetSnippetId) {
        lastPreviewReorderRef.current = null;
        return;
      }
      const targetSnippet = snippets.find((snippet) => snippet.id === targetSnippetId);
      const sourceSnippet = snippets.find((snippet) => snippet.id === sourceSnippetId);
      if (!targetSnippet || !sourceSnippet) return;
      const movedSnippets = snippets.map((snippet) =>
        snippet.id === sourceSnippetId
          ? { ...snippet, package: targetSnippet.package || '' }
          : snippet,
      );
      const position = getDropPosition(target, event.clientX, event.clientY, isGrid);
      const previewKey = `${sourceSnippetId}:${targetSnippetId}:${position}`;
      if (!isGrid || lastPreviewReorderRef.current !== previewKey) {
        prepareGridLayoutAnimation();
        onBulkSave(reorderVaultItems(
          movedSnippets,
          sourceSnippetId,
          targetSnippetId,
          position,
        ));
      }
      lastPreviewReorderRef.current = null;
      setSortMode('manual');
      return;
    }

    const sourcePackage = draggingPackagePathRef.current || event.dataTransfer.getData('pkg-path');
    const targetPackage = target.getAttribute('data-pkg-path');
    if (sourcePackage && targetPackage) {
      event.preventDefault();
      event.stopPropagation();
      if (sourcePackage === targetPackage) {
        lastPreviewReorderRef.current = null;
        return;
      }
      const intent = getPackageDropIntent(target, event.clientX, event.clientY, isGrid);
      if (intent === 'inside') return;
      if (parentOfPackage(sourcePackage) !== parentOfPackage(targetPackage)) return;
      const sortablePackages = Array.from(new Set([...packages, sourcePackage, targetPackage]));
      const previewKey = `package:${sourcePackage}:${targetPackage}:${intent}`;
      if (!isGrid || lastPreviewReorderRef.current !== previewKey) {
        prepareGridLayoutAnimation();
        onPackagesChange(reorderVaultStrings(sortablePackages, sourcePackage, targetPackage, intent));
      }
      lastPreviewReorderRef.current = null;
      setSortMode('manual');
    }
  }, [
    onBulkSave,
    onPackagesChange,
    packages,
    parentOfPackage,
    prepareGridLayoutAnimation,
    snippets,
    viewMode,
  ]);

  const packageOptions: ComboboxOption[] = useMemo(() => {
    const allPaths = new Set<string>();
    
    packages.forEach(pkg => {
      allPaths.add(pkg);
      
      const parts = pkg.split('/').filter(Boolean);
      const isAbsolute = pkg.startsWith('/');
      
      for (let i = 1; i < parts.length; i++) {
        const parentPath = (isAbsolute ? '/' : '') + parts.slice(0, i).join('/');
        allPaths.add(parentPath);
      }
    });
    
    return Array.from(allPaths)
      .sort((a, b) => {
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

  const visibleHistory = useMemo(() => {
    return shellHistory.slice(0, historyVisibleCount);
  }, [shellHistory, historyVisibleCount]);

  const hasMoreHistory = historyVisibleCount < shellHistory.length;

  const loadMoreHistory = useCallback(() => {
    if (isLoadingMore || !hasMoreHistory) return;
    setIsLoadingMore(true);
    setTimeout(() => {
      setHistoryVisibleCount((prev) => Math.min(prev + HISTORY_PAGE_SIZE, shellHistory.length));
      setIsLoadingMore(false);
    }, 200);
  }, [isLoadingMore, hasMoreHistory, shellHistory.length]);

  const handleHistoryScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.target as HTMLDivElement;
    const scrollBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
    if (scrollBottom < 100 && hasMoreHistory && !isLoadingMore) {
      loadMoreHistory();
    }
  }, [hasMoreHistory, isLoadingMore, loadMoreHistory]);

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

  const renderRightPanel = () => (
    <SnippetsRightPanel
      rightPanelMode={rightPanelMode}
      hosts={hosts}
      customGroups={customGroups}
      targetSelection={targetSelection}
      handleTargetSelect={handleTargetSelect}
      handleTargetPickerBack={handleTargetPickerBack}
      availableKeys={availableKeys}
      proxyProfiles={proxyProfiles}
      managedSources={managedSources}
      onSaveHost={onSaveHost}
      onCreateGroup={onCreateGroup}
      t={t}
      handleClosePanel={handleClosePanel}
      editingSnippet={editingSnippet}
      onDelete={onDelete}
      handleSubmit={handleSubmit}
      setEditingSnippet={setEditingSnippet}
      packageOptions={packageOptions}
      selectedPackage={selectedPackage}
      packages={packages}
      onPackagesChange={onPackagesChange}
      shortkeyError={shortkeyError}
      setShortkeyError={setShortkeyError}
      isRecordingShortkey={isRecordingShortkey}
      setIsRecordingShortkey={setIsRecordingShortkey}
      openTargetPicker={openTargetPicker}
      targetHosts={targetHosts}
      shellHistory={shellHistory}
      handleHistoryScroll={handleHistoryScroll}
      historyScrollRef={historyScrollRef}
      visibleHistory={visibleHistory}
      saveHistoryAsSnippet={saveHistoryAsSnippet}
      handleCopy={handleCopy}
      copiedId={copiedId}
      hasMoreHistory={hasMoreHistory}
      isLoadingMore={isLoadingMore}
      loadMoreHistory={loadMoreHistory}
    />
  );

  return (
    <TooltipProvider delayDuration={300}>
    <div className="h-full min-h-0 flex relative">
      <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
        <VaultPageHeader>
            <VaultHeaderSearch
              placeholder={t('snippets.searchPlaceholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-64"
            />
            <Button onClick={() => handleEdit()} size="sm" className="h-10 px-3">
              <Plus size={14} className="mr-2" /> {t('snippets.action.newSnippet')}
            </Button>
            <Button
              onClick={() => {
                setNewPackageName('');
                setIsPackageDialogOpen(true);
              }}
              size="sm"
              variant="secondary"
              className={vaultHeaderSecondaryButtonClass}
            >
              <FolderPlus size={14} className="mr-1" /> {t('snippets.action.newPackage')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className={cn(
                vaultHeaderSecondaryButtonClass,
                rightPanelMode === 'history' && "bg-foreground/10 hover:bg-foreground/15",
              )}
              onClick={() => setRightPanelMode(rightPanelMode === 'history' ? 'none' : 'history')}
            >
              <Clock size={14} /> {t('snippets.history.title')}
            </Button>
            <div className="flex items-center gap-1 ml-auto">
              <Dropdown>
                <DropdownTrigger asChild>
                  <Button variant="ghost" size="icon" className={vaultHeaderIconButtonClass}>
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
                className={vaultHeaderIconButtonClass}
              />
            </div>
        </VaultPageHeader>
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

        <div
          ref={listRef}
          className="flex-1 space-y-3 overflow-y-auto px-4 pb-4"
          onDragOverCapture={handleReorderDragOver}
          onDropCapture={handleReorderDrop}
          onDragEndCapture={resetSnippetDragState}
        >
          {displayedPackages.length > 0 && !search.trim() && (
            <>
              <div className="flex items-center justify-between">
                <h3 className={vaultSectionTitleClass}>{t('snippets.section.packages')}</h3>
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
                          "vault-drop-indicator-row group cursor-pointer overflow-hidden",
                          viewMode === 'grid'
                            ? "soft-card elevate rounded-xl h-[68px] px-3 py-2"
                            : "h-14 px-3 py-2 hover:bg-secondary/60 rounded-lg transition-colors"
                        )}
                        data-pkg-path={pkg.path}
                        data-vault-grid-item={`snippet-package:${pkg.path}`}
                        data-vault-reorder-grid={viewMode === 'grid' ? 'true' : undefined}
                        data-vault-reorder-dragging={draggingPackagePath === pkg.path ? 'true' : undefined}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.effectAllowed = 'move';
                          e.dataTransfer.setData('pkg-path', pkg.path);
                          draggingPackagePathRef.current = pkg.path;
                          setDraggingPackagePath(pkg.path);
                          lastPreviewReorderRef.current = null;
                        }}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault();
                          const sId = draggingSnippetIdRef.current || e.dataTransfer.getData('snippet-id');
                          const pPath = draggingPackagePathRef.current || e.dataTransfer.getData('pkg-path');
                          if (sId) moveSnippet(sId, pkg.path);
                          if (
                            pPath &&
                            getPackageDropIntent(e.currentTarget, e.clientX, e.clientY, viewMode === 'grid') === 'inside'
                          ) {
                            movePackage(pPath, pkg.path);
                          }
                        }}
                        onClick={() => setSelectedPackage(pkg.path)}
                      >
                        <div className="flex items-center gap-3 h-full min-w-0">
                          <VaultEntityIcon
                            className={vaultPrimaryIconClass}
                            icon={<Package size={18} />}
                          />
                          <div className="w-0 flex-1">
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
              <h3 className={vaultSectionTitleClass}>{t('snippets.section.snippets')}</h3>
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
                          "vault-drop-indicator-row group cursor-pointer overflow-hidden",
                          viewMode === 'grid'
                            ? "soft-card elevate rounded-xl h-[68px] px-3 py-2"
                            : "h-14 px-3 py-2 hover:bg-secondary/60 rounded-lg transition-colors"
                        )}
                        data-snippet-id={isSearchActive ? undefined : snippet.id}
                        data-vault-grid-item={`snippet:${snippet.id}`}
                        data-vault-reorder-grid={viewMode === 'grid' ? 'true' : undefined}
                        data-vault-reorder-dragging={draggingSnippetId === snippet.id ? 'true' : undefined}
                        draggable={!isSearchActive}
                        onDragStart={(e) => {
                          e.dataTransfer.effectAllowed = 'move';
                          e.dataTransfer.setData('snippet-id', snippet.id);
                          draggingSnippetIdRef.current = snippet.id;
                          setDraggingSnippetId(snippet.id);
                          lastPreviewReorderRef.current = null;
                        }}
                        onClick={() => handleEdit(snippet)}
                      >
                        <div className="flex items-center gap-3 h-full min-w-0">
                          <VaultEntityIcon
                            className={vaultSnippetIconClass}
                            icon={<FileCode size={18} />}
                          />
                          <div className="w-0 flex-1">
                            <div className="text-sm font-semibold truncate">{snippet.label}</div>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div className="text-[11px] text-muted-foreground font-mono leading-4 truncate">
                                  {snippet.command.replace(/\s+/g, ' ') || t('snippets.commandFallback')}
                                </div>
                              </TooltipTrigger>
                              <TooltipContent side="bottom" className="max-w-sm break-all font-mono text-xs">
                                {snippet.command}
                              </TooltipContent>
                            </Tooltip>
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
          {search.trim() && displayedSnippets.length === 0 && (snippets.length > 0 || displayedPackages.length > 0) && (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <div className="h-14 w-14 rounded-2xl bg-secondary/80 flex items-center justify-center mb-3">
                <Search size={24} className="opacity-60" />
              </div>
              <h3 className="text-base font-semibold text-foreground mb-1">
                {t('snippets.search.noResults.title')}
              </h3>
              <p className="text-xs text-center max-w-sm">
                {t('snippets.search.noResults.desc', { query: search.trim() })}
              </p>
            </div>
          )}
        </div>
      </div>

      <SnippetsPackageDialogs
        isPackageDialogOpen={isPackageDialogOpen}
        t={t}
        selectedPackage={selectedPackage}
        newPackageName={newPackageName}
        setNewPackageName={setNewPackageName}
        createPackage={createPackage}
        setIsPackageDialogOpen={setIsPackageDialogOpen}
        isRenameDialogOpen={isRenameDialogOpen}
        renamingPackagePath={renamingPackagePath}
        renamePackageName={renamePackageName}
        setRenamePackageName={setRenamePackageName}
        setRenameError={setRenameError}
        renamePackage={renamePackage}
        renameError={renameError}
        setIsRenameDialogOpen={setIsRenameDialogOpen}
      />

      {renderRightPanel()}
    </div>
    </TooltipProvider>
  );
};

export default SnippetsManager;
