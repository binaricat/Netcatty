/**
 * ScriptsSidePanel - Lightweight scripts browser for the terminal side panel
 *
 * Shows snippets organized by package hierarchy as a single tree view.
 * Packages expand / collapse via a chevron; clicking a snippet executes it
 * in the focused terminal session. Typing in the search box flattens to a
 * list of matching snippets regardless of package nesting.
 */

import {
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Edit2,
  Expand,
  FolderPlus,
  Layers,
  Minimize2,
  Package,
  Play,
  Plus,
  Search,
  Trash2,
  Zap,
} from 'lucide-react';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useI18n } from '../application/i18n/I18nProvider';
import { getScriptRecordingSnapshot, subscribeScriptRecording } from '../application/state/scriptRecordingStore.ts';
import { VaultDeleteConfirmDialog } from './vault/VaultDeleteConfirmDialog';
import { reorderVaultItems, reorderVaultStrings, sortByVaultOrder } from '../domain/vaultOrder';
import { isScriptSnippet } from '../domain/snippetScript.ts';
import { cn } from '../lib/utils';
import { Snippet } from '../types';
import type { ScriptRun } from '../types/global/netcatty-bridge-script.d.ts';
import { ScriptRunList } from './scripts/ScriptRunList';
import { ScriptRecordingHelpDialog } from './scripts/ScriptRecordingHelpDialog';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from './ui/context-menu';
import { Dropdown, DropdownContent, DropdownTrigger } from './ui/dropdown';
import { FixedSizeVirtualList } from './ui/FixedSizeVirtualList';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { SnippetCommandTooltipContent } from './snippets/SnippetCommandTooltipContent';
import { TERMINAL_SIDE_PANEL_INNER_HEADER_CLASS } from './terminalLayer/terminalSidePanelChrome';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';

const toolbarIconButtonClass =
  'h-7 w-7 shrink-0 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors disabled:opacity-40 disabled:pointer-events-none';

const SCRIPT_ROW_HEIGHT = 34;

const isRootPackagePath = (path: string): boolean => {
  const body = path.startsWith('/') ? path.slice(1) : path;
  return body.length > 0 && !body.includes('/');
};

interface ScriptsSidePanelProps {
  snippets: Snippet[];
  packages: string[];
  onSnippetClick: (snippet: Snippet) => void;
  onRunScript?: (snippet: Snippet) => void;
  onRunScriptOnWorkspace?: (snippet: Snippet, mode: 'sequential' | 'parallel') => void;
  onSnippetsChange?: (snippets: Snippet[]) => void;
  onPackagesChange?: (packages: string[]) => void;
  isVisible?: boolean;
  runs?: ScriptRun[];
  onStopRun?: (runId: string) => void;
  onPauseRun?: (runId: string) => void;
  onResumeRun?: (runId: string) => void;
  onStartRecording?: () => void;
  focusedSessionId?: string;
  /**
   * When set, bulk-delete confirmation is owned by the parent. Required when
   * this panel is nested in a Popover — the portalled confirm would otherwise
   * steal focus, dismiss the popover, and unmount the prompt.
   */
  onBulkDeleteRequest?: (ids: string[]) => void;
}

type TreeRow =
  | {
      type: 'package';
      id: string;
      path: string;
      name: string;
      depth: number;
      count: number;
      hasChildren: boolean;
      isExpanded: boolean;
    }
  | {
      type: 'snippet';
      id: string;
      depth: number;
      snippet: Snippet;
      packagePath: string;
    };

const pkgDisplayName = (path: string) => {
  const clean = path.startsWith('/') ? path.slice(1) : path;
  const last = clean.split('/').filter(Boolean).pop() ?? clean;
  // Preserve the leading slash on absolute root packages so they stay
  // distinguishable from relative ones (matches the previous breadcrumb UI).
  return path.startsWith('/') && !clean.includes('/') ? `/${last}` : last;
};

const packageDisplayIndex = (packages: string[], path: string): number => {
  const exactIndex = packages.indexOf(path);
  if (exactIndex >= 0) return exactIndex;
  const childIndex = packages.findIndex((pkg) => pkg.startsWith(`${path}/`));
  return childIndex >= 0 ? childIndex : Number.MAX_SAFE_INTEGER;
};

let activeScriptsDropIndicator: HTMLElement | null = null;

const clearScriptsDropIndicator = () => {
  activeScriptsDropIndicator?.removeAttribute('data-vault-drop-position');
  activeScriptsDropIndicator = null;
};

const markScriptsDropIndicator = (target: HTMLElement, position: 'before' | 'after') => {
  if (target.dataset.vaultDropPosition === position) return;
  clearScriptsDropIndicator();
  target.dataset.vaultDropPosition = position;
  activeScriptsDropIndicator = target;
};

const markScriptsInsideIndicator = (target: HTMLElement) => {
  if (target.dataset.vaultDropPosition === 'inside') return;
  clearScriptsDropIndicator();
  target.dataset.vaultDropPosition = 'inside';
  activeScriptsDropIndicator = target;
};

const getVerticalDropIntent = (
  element: HTMLElement,
  clientY: number,
): 'before' | 'inside' | 'after' => {
  const rect = element.getBoundingClientRect();
  const edgeSize = Math.max(8, Math.min(14, rect.height * 0.28));
  if (clientY <= rect.top + edgeSize) return 'before';
  if (clientY >= rect.bottom - edgeSize) return 'after';
  return 'inside';
};

const hasDragType = (dataTransfer: DataTransfer, type: string) =>
  Array.from(dataTransfer.types).includes(type);

/** Collect every package path (including implied ancestors) shown in the tree. */
export function collectScriptsSidePanelPackagePaths(
  packages: string[],
  snippets: Snippet[],
): string[] {
  const normalizedPackages = new Set<string>();
  const addWithAncestors = (raw: string) => {
    const path = raw.trim();
    if (!path) return;
    const isAbs = path.startsWith('/');
    const body = isAbs ? path.slice(1) : path;
    const parts = body.split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i += 1) {
      const sub = parts.slice(0, i).join('/');
      normalizedPackages.add(isAbs ? `/${sub}` : sub);
    }
  };

  packages.forEach(addWithAncestors);
  snippets.forEach((snippet) => {
    if (snippet.package) addWithAncestors(snippet.package);
  });
  return Array.from(normalizedPackages);
}

export function buildScriptsSidePanelRows({
  snippets,
  packages,
  expandedPaths,
}: {
  snippets: Snippet[];
  packages: string[];
  expandedPaths: Set<string>;
}): TreeRow[] {
  const normalizedPackages = new Set(collectScriptsSidePanelPackagePaths(packages, snippets));

  const snippetsByPackage = new Map<string, Snippet[]>();
  const descendantCountByPackage = new Map<string, number>();
  const bumpCount = (path: string) => {
    descendantCountByPackage.set(path, (descendantCountByPackage.get(path) ?? 0) + 1);
  };

  for (const snippet of snippets) {
    const pkg = snippet.package || '';
    const bucket = snippetsByPackage.get(pkg);
    if (bucket) bucket.push(snippet);
    else snippetsByPackage.set(pkg, [snippet]);

    if (pkg === '') {
      bumpCount('');
      continue;
    }

    let path = pkg;
    while (true) {
      bumpCount(path);
      const slash = path.lastIndexOf('/');
      if (slash < 0) break;
      path = path.slice(0, slash);
    }
  }

  const packagePaths = Array.from(normalizedPackages);
  const childPackagesOf = (parent: string | null): string[] => {
    const prefix = parent === null ? '' : `${parent}/`;
    return packagePaths
      .filter((path) => {
        if (parent === null) {
          const body = path.startsWith('/') ? path.slice(1) : path;
          return !body.includes('/');
        }
        if (!path.startsWith(prefix)) return false;
        const rest = path.slice(prefix.length);
        return rest.length > 0 && !rest.includes('/');
      })
      .sort((a, b) => {
        const orderDiff = packageDisplayIndex(packages, a) - packageDisplayIndex(packages, b);
        if (orderDiff !== 0) return orderDiff;
        return pkgDisplayName(a).localeCompare(pkgDisplayName(b));
      });
  };

  const snippetsIn = (pkg: string | null): Snippet[] =>
    sortByVaultOrder(snippetsByPackage.get(pkg ?? '') ?? []);

  const rows: TreeRow[] = [];
  const walk = (pkg: string, depth: number) => {
    const children = childPackagesOf(pkg);
    const localSnippets = snippetsIn(pkg);
    const hasChildren = children.length > 0 || localSnippets.length > 0;
    const isExpanded = expandedPaths.has(pkg);

    rows.push({
      type: 'package',
      id: pkg,
      path: pkg,
      name: pkgDisplayName(pkg),
      depth,
      count: descendantCountByPackage.get(pkg) ?? 0,
      hasChildren,
      isExpanded,
    });

    if (!isExpanded) return;
    children.forEach((child) => walk(child, depth + 1));
    localSnippets.forEach((snippet) =>
      rows.push({ type: 'snippet', id: snippet.id, depth: depth + 1, snippet, packagePath: pkg }),
    );
  };

  snippetsIn(null).forEach((snippet) =>
    rows.push({ type: 'snippet', id: snippet.id, depth: 0, snippet, packagePath: '' }),
  );
  childPackagesOf(null).forEach((root) => walk(root, 0));

  return rows;
}

const ScriptsSidePanelInner: React.FC<ScriptsSidePanelProps> = ({
  snippets,
  packages,
  onSnippetClick,
  onRunScript,
  onRunScriptOnWorkspace,
  onSnippetsChange,
  onPackagesChange,
  isVisible = true,
  runs = [],
  onStopRun,
  onPauseRun,
  onResumeRun,
  onStartRecording,
  focusedSessionId,
  onBulkDeleteRequest,
}) => {
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const [subView, setSubView] = useState<'library' | 'running'>('library');
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);
  const [selectedSnippetIds, setSelectedSnippetIds] = useState<Set<string>>(new Set());
  const [pendingDeleteIds, setPendingDeleteIds] = useState<string[] | null>(null);
  const [isPackageDialogOpen, setIsPackageDialogOpen] = useState(false);
  const [newPackageName, setNewPackageName] = useState('');
  const [packageError, setPackageError] = useState('');
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const packageDialogRef = useRef<HTMLDivElement>(null);
  const packageNameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ packagePath?: string }>).detail;
      setSubView('library');
      setSearch('');
      if (detail?.packagePath) {
        setExpandedPaths((prev) => {
          const next = new Set(prev);
          let path = detail.packagePath || '';
          while (path) {
            next.add(path);
            const slash = path.lastIndexOf('/');
            if (slash < 0) break;
            path = path.slice(0, slash);
          }
          next.add('');
          return next;
        });
      }
    };
    window.addEventListener('netcatty:scripts:saved', handler);
    return () => window.removeEventListener('netcatty:scripts:saved', handler);
  }, []);

  // Normalize the package list + derive ancestor packages implied by each path
  // (e.g. package "a/b/c" implies roots "a" and "a/b" even when not listed).
  const normalizedPackages = useMemo(() => {
    if (!isVisible) return new Set<string>();
    return new Set(collectScriptsSidePanelPackagePaths(packages, snippets));
  }, [packages, snippets, isVisible]);

  // Track every package we've ever observed so we can tell "new" from
  // "previously-seen-but-user-collapsed". Without this, any unrelated refresh
  // that reduced prev.size (because the user collapsed a row) would
  // incorrectly trip a bulk re-expand.
  const seenPackagesRef = useRef<Set<string>>(new Set());

  // Default: auto-expand packages the first time they appear, so the user sees
  // everything without drilling in. After that, respect the user's collapse
  // choices across unrelated refreshes.
  useEffect(() => {
    if (!isVisible) return;
    const seen = seenPackagesRef.current;
    const newlySeen: string[] = [];
    normalizedPackages.forEach((p) => {
      if (!seen.has(p)) {
        seen.add(p);
        newlySeen.push(p);
      }
    });
    if (newlySeen.length === 0) return;
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      // Only auto-expand root packages on first sight — expanding the full
      // tree upfront was freezing the panel on large snippet libraries.
      newlySeen.filter(isRootPackagePath).forEach((p) => next.add(p));
      return next;
    });
  }, [normalizedPackages, isVisible]);

  const togglePackage = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const expandAllGroups = useCallback(() => {
    setExpandedPaths(new Set(normalizedPackages));
  }, [normalizedPackages]);

  const collapseAllGroups = useCallback(() => {
    setExpandedPaths(new Set());
  }, []);

  const clearSnippetSelection = useCallback(() => {
    setSelectedSnippetIds(new Set());
    setIsMultiSelectMode(false);
  }, []);

  useEffect(() => {
    setSelectedSnippetIds((prev) => {
      if (prev.size === 0) return prev;
      const alive = new Set(snippets.map((snippet) => snippet.id));
      let changed = false;
      const next = new Set<string>();
      prev.forEach((id) => {
        if (alive.has(id)) next.add(id);
        else changed = true;
      });
      return changed ? next : prev;
    });
  }, [snippets]);

  useEffect(() => {
    if (!isVisible) setPendingDeleteIds(null);
  }, [isVisible]);

  // Parent-owned confirm (compact toolbar popover) dispatches the shared delete
  // event; clear local multi-select when that bulk delete lands.
  useEffect(() => {
    if (!onBulkDeleteRequest) return;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ ids?: string[] }>).detail;
      if (!detail?.ids?.length) return;
      clearSnippetSelection();
    };
    window.addEventListener('netcatty:snippets:delete', handler);
    return () => window.removeEventListener('netcatty:snippets:delete', handler);
  }, [clearSnippetSelection, onBulkDeleteRequest]);

  const toggleSnippetSelection = useCallback((id: string) => {
    setSelectedSnippetIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const deleteSelectedSnippets = useCallback(() => {
    const ids = snippets
      .filter((snippet) => selectedSnippetIds.has(snippet.id))
      .map((snippet) => snippet.id);
    if (ids.length === 0) return;
    if (onBulkDeleteRequest) {
      onBulkDeleteRequest(ids);
      return;
    }
    setPendingDeleteIds(ids);
  }, [onBulkDeleteRequest, selectedSnippetIds, snippets]);

  const existingPendingDeleteIds = pendingDeleteIds
    ? pendingDeleteIds.filter((id) => snippets.some((snippet) => snippet.id === id))
    : [];

  const confirmDeleteSelectedSnippets = useCallback(() => {
    const ids = (pendingDeleteIds ?? []).filter((id) =>
      snippets.some((snippet) => snippet.id === id),
    );
    setPendingDeleteIds(null);
    if (ids.length === 0) {
      clearSnippetSelection();
      return;
    }
    // Always route through the shared event so AppSideEffects can clear host
    // login/connect bindings (onSnippetsChange alone would leave them stale).
    window.dispatchEvent(
      new CustomEvent('netcatty:snippets:delete', { detail: { ids } }),
    );
    clearSnippetSelection();
  }, [clearSnippetSelection, pendingDeleteIds, snippets]);

  // When search is active, flatten everything (no tree, no packages).
  const searchMatches = useMemo(() => {
    if (!isVisible) return null;
    const q = search.trim().toLowerCase();
    if (!q) return null;
    return sortByVaultOrder(snippets.filter(
      (s) =>
        s.label.toLowerCase().includes(q) ||
        s.command.toLowerCase().includes(q),
    ));
  }, [snippets, search, isVisible]);

  const rows = useMemo<TreeRow[]>(() => {
    if (!isVisible) return [];
    if (searchMatches !== null) return [];

    return buildScriptsSidePanelRows({ snippets, packages, expandedPaths });
  }, [snippets, packages, expandedPaths, searchMatches, isVisible]);

  type ScriptsListItem =
    | { key: string; kind: 'search'; snippet: Snippet }
    | { key: string; kind: 'package'; row: Extract<TreeRow, { type: 'package' }>; countLabel: string }
    | { key: string; kind: 'snippet'; row: Extract<TreeRow, { type: 'snippet' }> };

  const listItems = useMemo((): ScriptsListItem[] => {
    if (!isVisible) return [];
    if (searchMatches !== null) {
      return searchMatches.map((snippet) => ({
        key: `search:${snippet.id}`,
        kind: 'search',
        snippet,
      }));
    }
    return rows.flatMap((row): ScriptsListItem[] => {
      if (row.type === 'package') {
        return [{
          key: `pkg:${row.id}`,
          kind: 'package',
          row,
          countLabel: t('snippets.package.count', { count: row.count }),
        }];
      }
      return [{
        key: `snip:${row.id}`,
        kind: 'snippet',
        row,
      }];
    });
  }, [rows, searchMatches, t, isVisible]);

  const handleSnippetClick = useCallback(
    (snippet: Snippet) => {
      if (isMultiSelectMode) {
        toggleSnippetSelection(snippet.id);
        return;
      }
      if (isScriptSnippet(snippet)) {
        onRunScript?.(snippet);
        setSubView('running');
        return;
      }
      onSnippetClick(snippet);
    },
    [isMultiSelectMode, onRunScript, onSnippetClick, toggleSnippetSelection],
  );

  const hasSearch = search.trim().length > 0;
  const canExpandCollapse = normalizedPackages.size > 0 && !hasSearch;

  const sessionRuns = useMemo(() => {
    if (!focusedSessionId) return runs;
    return runs.filter((run) => run.sessionId === focusedSessionId);
  }, [focusedSessionId, runs]);

  const recordingState = useSyncExternalStore(
    subscribeScriptRecording,
    getScriptRecordingSnapshot,
    getScriptRecordingSnapshot,
  );
  const isRecordingFocusedSession = Boolean(
    focusedSessionId && recordingState.sessionId === focusedSessionId,
  );
  const canStartRecording = Boolean(onStartRecording && focusedSessionId);
  const recordingDisabledReason = !onStartRecording
    ? 'unavailable'
    : !focusedSessionId
      ? 'noSession'
      : null;
  const recordingButtonLabel = isRecordingFocusedSession
    ? t('scripts.recording.active')
    : t('scripts.recording.start');

  const moveSnippetToPackage = useCallback((snippetId: string, packagePath: string | null) => {
    if (!onSnippetsChange) return;
    const targetPackage = packagePath || '';
    const snippet = snippets.find((item) => item.id === snippetId);
    if (!snippet || (snippet.package || '') === targetPackage) return;
    onSnippetsChange(snippets.map((item) =>
      item.id === snippetId ? { ...item, package: targetPackage } : item,
    ));
  }, [onSnippetsChange, snippets]);

  const movePackageToPackage = useCallback((source: string, target: string | null) => {
    if (!onPackagesChange || !onSnippetsChange) return;
    const name = source.split('/').pop() || '';
    const isAbsolute = source.startsWith('/');
    const newPath = target ? `${target}/${name}` : (isAbsolute ? `/${name}` : name);
    if (newPath === source || newPath.startsWith(`${source}/`) || packages.includes(newPath)) return;

    const updatedPackages = packages.map((path) => {
      if (path === source) return newPath;
      if (path.startsWith(`${source}/`)) return newPath + path.substring(source.length);
      return path;
    });
    const updatedSnippets = snippets.map((snippet) => {
      const packagePath = snippet.package || '';
      if (packagePath === source) return { ...snippet, package: newPath };
      if (packagePath.startsWith(`${source}/`)) {
        return { ...snippet, package: newPath + packagePath.substring(source.length) };
      }
      return snippet;
    });

    onPackagesChange(Array.from(new Set(updatedPackages)));
    onSnippetsChange(updatedSnippets);
  }, [onPackagesChange, onSnippetsChange, packages, snippets]);

  const reorderSnippetToTarget = useCallback((
    sourceSnippetId: string,
    targetSnippetId: string,
    position: 'before' | 'after',
  ) => {
    if (!onSnippetsChange || sourceSnippetId === targetSnippetId) return;
    const targetSnippet = snippets.find((snippet) => snippet.id === targetSnippetId);
    if (!targetSnippet) return;
    const movedSnippets = snippets.map((snippet) =>
      snippet.id === sourceSnippetId
        ? { ...snippet, package: targetSnippet.package || '' }
        : snippet,
    );
    onSnippetsChange(reorderVaultItems(movedSnippets, sourceSnippetId, targetSnippetId, position));
  }, [onSnippetsChange, snippets]);

  const reorderPackageToTarget = useCallback((
    sourcePackage: string,
    targetPackage: string,
    position: 'before' | 'after',
  ) => {
    if (!onPackagesChange || sourcePackage === targetPackage) return;
    const parentOf = (path: string) => {
      const parts = path.split('/').filter(Boolean);
      const prefix = path.startsWith('/') ? '/' : '';
      return prefix + parts.slice(0, -1).join('/');
    };
    if (parentOf(sourcePackage) !== parentOf(targetPackage)) return;
    const sortablePackages = Array.from(new Set([...packages, sourcePackage, targetPackage]));
    onPackagesChange(reorderVaultStrings(sortablePackages, sourcePackage, targetPackage, position));
  }, [onPackagesChange, packages]);

  const handleRowDragOver = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (!onSnippetsChange && !onPackagesChange) return;
    const row = event.currentTarget;
    const targetSnippetId = row.getAttribute('data-snippet-id');
    const targetPackage = row.getAttribute('data-pkg-path');
    const isDraggingSnippet = hasDragType(event.dataTransfer, 'snippet-id');
    const isDraggingPackage = hasDragType(event.dataTransfer, 'pkg-path');
    if (targetSnippetId && isDraggingSnippet) {
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
      const rect = row.getBoundingClientRect();
      markScriptsDropIndicator(row, event.clientY < rect.top + rect.height / 2 ? 'before' : 'after');
      return;
    }
    if (targetPackage && isDraggingSnippet) {
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
      markScriptsInsideIndicator(row);
      return;
    }
    if (targetPackage && isDraggingPackage) {
      const sourcePackage = event.dataTransfer.getData('pkg-path');
      if (
        sourcePackage &&
        (sourcePackage === targetPackage || targetPackage.startsWith(`${sourcePackage}/`))
      ) {
        event.dataTransfer.dropEffect = 'none';
        clearScriptsDropIndicator();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
      const intent = getVerticalDropIntent(row, event.clientY);
      if (intent === 'inside') {
        markScriptsInsideIndicator(row);
        return;
      }
      markScriptsDropIndicator(row, intent);
      return;
    }
    event.dataTransfer.dropEffect = 'none';
    clearScriptsDropIndicator();
  }, [onPackagesChange, onSnippetsChange]);

  const handleRowDrop = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (!onSnippetsChange && !onPackagesChange) return;
    const row = event.currentTarget;
    clearScriptsDropIndicator();

    const targetSnippetId = row.getAttribute('data-snippet-id');
    const targetPackage = row.getAttribute('data-pkg-path');
    const sourceSnippetId = event.dataTransfer.getData('snippet-id');
    const sourcePackage = event.dataTransfer.getData('pkg-path');

    if (sourceSnippetId && targetSnippetId) {
      event.preventDefault();
      event.stopPropagation();
      const rect = row.getBoundingClientRect();
      reorderSnippetToTarget(
        sourceSnippetId,
        targetSnippetId,
        event.clientY < rect.top + rect.height / 2 ? 'before' : 'after',
      );
      return;
    }
    if (sourceSnippetId && targetPackage) {
      event.preventDefault();
      event.stopPropagation();
      moveSnippetToPackage(sourceSnippetId, targetPackage);
      return;
    }
    if (sourcePackage && targetPackage) {
      event.preventDefault();
      event.stopPropagation();
      const intent = getVerticalDropIntent(row, event.clientY);
      if (intent === 'inside') movePackageToPackage(sourcePackage, targetPackage);
      else reorderPackageToTarget(sourcePackage, targetPackage, intent);
    }
  }, [
    movePackageToPackage,
    moveSnippetToPackage,
    onPackagesChange,
    onSnippetsChange,
    reorderPackageToTarget,
    reorderSnippetToTarget,
  ]);

  const handleAddSnippet = useCallback(() => {
    window.dispatchEvent(new CustomEvent('netcatty:snippets:add'));
  }, []);

  const handleAddScript = useCallback(() => {
    window.dispatchEvent(new CustomEvent('netcatty:scripts:add'));
  }, []);

  const openPackageDialog = useCallback(() => {
    setNewPackageName('');
    setPackageError('');
    setIsPackageDialogOpen(true);
  }, []);

  // Keep Tab focus inside the package dialog while it is open.
  useEffect(() => {
    if (!isPackageDialogOpen) return;
    const focusTimer = window.setTimeout(() => packageNameInputRef.current?.focus(), 30);

    const listFocusable = (): HTMLElement[] => {
      const root = packageDialogRef.current;
      if (!root) return [];
      const nodes = root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      return Array.from(nodes).filter((el) => {
        if (el.classList.contains('sr-only')) return false;
        if (el.getAttribute('aria-hidden') === 'true') return false;
        return el.tabIndex >= 0 || el.tagName === 'INPUT' || el.tagName === 'BUTTON';
      });
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const focusable = listFocusable();
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (!active || active === first || !packageDialogRef.current?.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (!active || active === last || !packageDialogRef.current?.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };

    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as Node | null;
      if (target && packageDialogRef.current?.contains(target)) return;
      (listFocusable()[0] ?? packageNameInputRef.current)?.focus();
    };

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [isPackageDialogOpen]);

  const handleCreatePackage = useCallback(() => {
    if (!onPackagesChange) {
      setPackageError(t('snippets.renameDialog.error.empty'));
      return;
    }
    const name = newPackageName.trim();
    if (!name) {
      setPackageError(t('snippets.renameDialog.error.empty'));
      return;
    }
    // Match SnippetsManager.createPackage path rules so tree rows stay stable.
    if (!/^\/?([\w\p{L}\p{N}-]+(\/[\w\p{L}\p{N}-]+)*)\/?$/u.test(name)) {
      setPackageError(t('snippets.renameDialog.error.invalidChars'));
      return;
    }
    let full = name.endsWith('/') ? name.slice(0, -1) : name;
    if (full !== '/' && full.endsWith('/')) full = full.slice(0, -1);
    const existingPackage = packages.find((p) => p.toLowerCase() === full.toLowerCase());
    if (existingPackage) {
      setPackageError(t('snippets.renameDialog.error.duplicate'));
      return;
    }
    onPackagesChange([...packages, full]);
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      let path = full.startsWith('/') ? full.slice(1) : full;
      // Expand both absolute and relative forms used by the tree walker.
      next.add(full);
      while (path) {
        next.add(path);
        if (full.startsWith('/')) next.add(`/${path}`);
        const slash = path.lastIndexOf('/');
        if (slash < 0) break;
        path = path.slice(0, slash);
      }
      return next;
    });
    setIsPackageDialogOpen(false);
    setNewPackageName('');
    setPackageError('');
  }, [newPackageName, onPackagesChange, packages, t]);

  const handleEditSnippet = useCallback((snippet: Snippet) => {
    window.dispatchEvent(
      new CustomEvent('netcatty:snippets:edit', { detail: { snippet } }),
    );
  }, []);

  const handleDeleteSnippet = useCallback((id: string) => {
    window.dispatchEvent(
      new CustomEvent('netcatty:snippets:delete', { detail: { id } }),
    );
  }, []);

  if (!isVisible) return null;

  const hasAnyContent = snippets.length > 0 || packages.length > 0;

  return (
    <TooltipProvider delayDuration={300}>
    <div
      className="relative h-full flex flex-col bg-background overflow-hidden"
      data-section="snippets-panel"
    >
      {/* Sub view tabs */}
      <div className={cn(
        TERMINAL_SIDE_PANEL_INNER_HEADER_CLASS,
        'px-2 border-b border-border/50 flex items-center gap-1',
      )}>
        <button
          type="button"
          className={cn(
            'flex-1 h-6 rounded-md text-[11px]',
            subView === 'library' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted/50',
          )}
          onClick={() => setSubView('library')}
        >
          {t('scripts.sidePanel.library')}
        </button>
        <button
          type="button"
          className={cn(
            'flex-1 h-6 rounded-md text-[11px]',
            subView === 'running' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted/50',
          )}
          onClick={() => setSubView('running')}
        >
          {t('scripts.sidePanel.running')}
        </button>
      </div>

      {subView === 'running' ? (
        <div className="flex-1 min-h-0 overflow-auto">
          <ScriptRunList
            runs={sessionRuns}
            onStop={onStopRun ?? (() => {})}
            onPause={onPauseRun ?? (() => {})}
            onResume={onResumeRun ?? (() => {})}
          />
        </div>
      ) : (
      <>
      {/* Search + tree actions + Add */}
      <div className="shrink-0 px-2 py-1.5 border-b border-border/50 flex items-center gap-1">
        <div className="relative flex-1 min-w-0">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('snippets.searchPlaceholder')}
            className="h-7 pl-7 text-xs bg-muted/30 border-none"
          />
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={toolbarIconButtonClass}
              disabled={!canExpandCollapse}
              aria-label={t('vault.tree.expandAll')}
              onClick={expandAllGroups}
            >
              <Expand size={14} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('vault.tree.expandAll')}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={toolbarIconButtonClass}
              disabled={!canExpandCollapse}
              aria-label={t('vault.tree.collapseAll')}
              onClick={collapseAllGroups}
            >
              <Minimize2 size={14} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('vault.tree.collapseAll')}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={cn(
                toolbarIconButtonClass,
                isMultiSelectMode && 'bg-muted/70 text-foreground',
              )}
              aria-label={t('snippets.action.selectSnippets')}
              aria-pressed={isMultiSelectMode}
              onClick={() => {
                if (isMultiSelectMode) {
                  clearSnippetSelection();
                } else {
                  setIsMultiSelectMode(true);
                }
              }}
            >
              <CheckSquare size={14} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('snippets.action.selectSnippets')}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={cn(
                toolbarIconButtonClass,
                selectedSnippetIds.size > 0 && 'text-destructive hover:text-destructive',
              )}
              disabled={selectedSnippetIds.size === 0}
              aria-label={t('snippets.selection.deleteSelected', { count: selectedSnippetIds.size })}
              onClick={deleteSelectedSnippets}
            >
              <Trash2 size={14} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t('snippets.selection.deleteSelected', { count: selectedSnippetIds.size })}
          </TooltipContent>
        </Tooltip>
        {/* Split add control: primary = new snippet; menu = package / automation script */}
        <div className="shrink-0 flex items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleAddSnippet}
                aria-label={t('snippets.action.newSnippet')}
                className="h-7 w-7 flex items-center justify-center rounded-l-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
              >
                <Plus size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent>{t('snippets.action.newSnippet')}</TooltipContent>
          </Tooltip>
          <Dropdown open={addMenuOpen} onOpenChange={setAddMenuOpen}>
            <DropdownTrigger asChild>
              <button
                type="button"
                aria-label={t('common.more')}
                aria-haspopup="menu"
                aria-expanded={addMenuOpen}
                className="h-7 w-5 flex items-center justify-center rounded-r-md border-l border-border/40 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
              >
                <ChevronDown size={12} />
              </button>
            </DropdownTrigger>
            <DropdownContent className="w-48 p-1" align="end">
              <button
                type="button"
                className="w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded-md hover:bg-muted transition-colors"
                onClick={() => {
                  setAddMenuOpen(false);
                  handleAddSnippet();
                }}
              >
                <Zap size={12} className="text-muted-foreground" />
                {t('snippets.action.newSnippet')}
              </button>
              {onPackagesChange ? (
                <button
                  type="button"
                  className="w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded-md hover:bg-muted transition-colors"
                  onClick={() => {
                    setAddMenuOpen(false);
                    openPackageDialog();
                  }}
                >
                  <FolderPlus size={12} className="text-muted-foreground" />
                  {t('snippets.action.newPackage')}
                </button>
              ) : null}
              <button
                type="button"
                className="w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded-md hover:bg-muted transition-colors"
                onClick={() => {
                  setAddMenuOpen(false);
                  handleAddScript();
                }}
              >
                <Play size={12} className="text-primary" />
                {t('snippets.action.newScript')}
              </button>
            </DropdownContent>
          </Dropdown>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0">
        {!hasAnyContent ? (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <Zap size={24} className="opacity-40 mb-2" />
            <span className="text-xs">{t('terminal.toolbar.noSnippets')}</span>
          </div>
        ) : hasAnyContent && searchMatches !== null && searchMatches.length === 0 ? (
          <div className="px-3 py-4 text-xs text-muted-foreground italic text-center">
            {t('common.noResultsFound')}
          </div>
        ) : (
          <FixedSizeVirtualList
            className="h-full"
            contentClassName="py-1"
            items={listItems}
            itemHeight={SCRIPT_ROW_HEIGHT}
            getItemKey={(item) => item.key}
            renderItem={(item) => {
              if (item.kind === 'search') {
                const isScript = isScriptSnippet(item.snippet);
                return (
                  <SnippetRow
                    snippet={item.snippet}
                    depth={0}
                    subtitle={item.snippet.package || t('terminal.toolbar.library')}
                    selected={selectedSnippetIds.has(item.snippet.id)}
                    multiSelect={isMultiSelectMode}
                    draggable={false}
                    sortableTarget={false}
                    onDragOver={handleRowDragOver}
                    onDrop={handleRowDrop}
                    onDragEnd={clearScriptsDropIndicator}
                    onClick={() => handleSnippetClick(item.snippet)}
                    onEdit={() => handleEditSnippet(item.snippet)}
                    onDelete={() => handleDeleteSnippet(item.snippet.id)}
                    onRunParallel={onRunScriptOnWorkspace
                      ? () => onRunScriptOnWorkspace(item.snippet, 'parallel')
                      : undefined}
                    onRunSequential={isScript && onRunScriptOnWorkspace
                      ? () => onRunScriptOnWorkspace(item.snippet, 'sequential')
                      : undefined}
                    runParallelLabel={isScript
                      ? t('scripts.actions.runParallel')
                      : t('scripts.actions.runOnAllTabs')}
                    runSequentialLabel={t('scripts.actions.runSequential')}
                    editLabel={t('action.edit')}
                    deleteLabel={t('action.delete')}
                  />
                );
              }
              if (item.kind === 'package') {
                return (
                  <PackageRow
                    row={item.row}
                    countLabel={item.countLabel}
                    draggable={Boolean(onPackagesChange || onSnippetsChange)}
                    onDragOver={handleRowDragOver}
                    onDrop={handleRowDrop}
                    onDragEnd={clearScriptsDropIndicator}
                    onToggle={() => togglePackage(item.row.path)}
                  />
                );
              }
              {
                const isScript = isScriptSnippet(item.row.snippet);
                return (
                  <SnippetRow
                    snippet={item.row.snippet}
                    depth={item.row.depth}
                    selected={selectedSnippetIds.has(item.row.snippet.id)}
                    multiSelect={isMultiSelectMode}
                    draggable={Boolean(onSnippetsChange) && !isMultiSelectMode}
                    sortableTarget={true}
                    onDragOver={handleRowDragOver}
                    onDrop={handleRowDrop}
                    onDragEnd={clearScriptsDropIndicator}
                    onClick={() => handleSnippetClick(item.row.snippet)}
                    onEdit={() => handleEditSnippet(item.row.snippet)}
                    onDelete={() => handleDeleteSnippet(item.row.snippet.id)}
                    onRunParallel={onRunScriptOnWorkspace
                      ? () => onRunScriptOnWorkspace(item.row.snippet, 'parallel')
                      : undefined}
                    onRunSequential={isScript && onRunScriptOnWorkspace
                      ? () => onRunScriptOnWorkspace(item.row.snippet, 'sequential')
                      : undefined}
                    runParallelLabel={isScript
                      ? t('scripts.actions.runParallel')
                      : t('scripts.actions.runOnAllTabs')}
                    runSequentialLabel={t('scripts.actions.runSequential')}
                    editLabel={t('action.edit')}
                    deleteLabel={t('action.delete')}
                  />
                );
              }
            }}
          />
        )}
      </div>
      <div className="shrink-0 px-2 py-2 border-t border-border/50 flex items-center gap-2">
        <button
          type="button"
          onClick={handleAddScript}
          className="flex-1 h-8 rounded-md text-xs bg-secondary/60 hover:bg-secondary"
        >
          {t('scripts.sidePanel.newScript')}
        </button>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onStartRecording}
              disabled={!canStartRecording}
              className={cn(
                'flex-1 h-8 rounded-md text-xs disabled:opacity-50',
                isRecordingFocusedSession
                  ? 'bg-red-500/15 text-red-500 hover:bg-red-500/25'
                  : 'bg-secondary/60 hover:bg-secondary',
              )}
            >
              {recordingButtonLabel}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-[240px]">
            {recordingDisabledReason === 'unavailable'
              ? t('scripts.recording.unavailableHint')
              : recordingDisabledReason === 'noSession'
                ? t('scripts.recording.noSession')
                : isRecordingFocusedSession
                  ? t('scripts.recording.activeHint')
                  : t('scripts.recording.startHint')}
          </TooltipContent>
        </Tooltip>
        <ScriptRecordingHelpDialog />
      </div>
      {isRecordingFocusedSession ? (
        <p className="shrink-0 px-2 pb-2 text-[10px] text-muted-foreground leading-relaxed">
          {t('scripts.recording.activeHint')}
        </p>
      ) : null}
      </>
      )}

      {isPackageDialogOpen ? (
        <div
          ref={packageDialogRef}
          className="absolute inset-0 z-40 flex items-center justify-center bg-background/80 p-3"
          role="dialog"
          aria-modal="true"
          data-state="open"
          aria-label={t('snippets.packageDialog.title')}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setIsPackageDialogOpen(false);
            }
          }}
          onClick={() => setIsPackageDialogOpen(false)}
        >
          <button
            type="button"
            data-dialog-close="true"
            tabIndex={-1}
            aria-hidden="true"
            className="sr-only"
            onClick={() => setIsPackageDialogOpen(false)}
          >
            {t('common.close')}
          </button>
          <div
            className="w-full max-w-[280px] rounded-lg border border-border/60 bg-background p-3 space-y-3 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div>
              <p className="text-sm font-semibold">{t('snippets.packageDialog.title')}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {t('snippets.packageDialog.parent', { parent: t('snippets.packageDialog.root') })}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t('field.name')}</Label>
              <Input
                ref={packageNameInputRef}
                value={newPackageName}
                onChange={(e) => {
                  setNewPackageName(e.target.value);
                  setPackageError('');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleCreatePackage();
                  }
                }}
                placeholder={t('snippets.packageDialog.placeholder')}
                className="h-8 text-xs"
              />
              <p className="text-[10px] text-muted-foreground">{t('snippets.packageDialog.hint')}</p>
              {packageError ? (
                <p className="text-[10px] text-destructive">{packageError}</p>
              ) : null}
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setIsPackageDialogOpen(false)}
              >
                {t('common.cancel')}
              </Button>
              <Button type="button" size="sm" onClick={handleCreatePackage}>
                {t('common.create')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {!onBulkDeleteRequest ? (
        <VaultDeleteConfirmDialog
          open={Boolean(pendingDeleteIds)}
          title={t('snippets.selection.deleteConfirmTitle', {
            count: existingPendingDeleteIds.length,
          })}
          description={t('snippets.selection.deleteConfirmDesc')}
          onOpenChange={(open) => {
            if (!open) setPendingDeleteIds(null);
          }}
          onConfirm={confirmDeleteSelectedSnippets}
        />
      ) : null}
    </div>
    </TooltipProvider>
  );
};

interface PackageRowProps {
  row: Extract<TreeRow, { type: 'package' }>;
  countLabel: string;
  draggable: boolean;
  onDragOver: (event: React.DragEvent<HTMLElement>) => void;
  onDrop: (event: React.DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onToggle: () => void;
}

const PackageRow = memo<PackageRowProps>(({ row, countLabel, draggable, onDragOver, onDrop, onDragEnd, onToggle }) => (
  <button
    type="button"
    onClick={onToggle}
    className="vault-drop-indicator-row w-full flex items-center gap-1.5 pr-3 py-1.5 text-left hover:bg-accent/50 transition-colors"
    style={{ paddingLeft: 8 + row.depth * 14 }}
    data-pkg-path={row.path}
    draggable={draggable}
    onDragStart={(event) => {
      if (!draggable) return;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('pkg-path', row.path);
    }}
    onDragOver={onDragOver}
    onDrop={onDrop}
    onDragEnd={onDragEnd}
  >
    <ChevronRight
      size={12}
      className={cn(
        'shrink-0 text-muted-foreground transition-transform',
        row.isExpanded && 'rotate-90',
        !row.hasChildren && 'opacity-0',
      )}
    />
    <Package size={12} className="shrink-0 text-primary/80" />
    <span className="flex-1 min-w-0 truncate text-xs font-medium">{row.name}</span>
    <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">{countLabel}</span>
  </button>
));
PackageRow.displayName = 'PackageRow';

interface SnippetRowProps {
  snippet: Snippet;
  depth: number;
  subtitle?: string;
  selected?: boolean;
  multiSelect?: boolean;
  draggable: boolean;
  sortableTarget: boolean;
  onDragOver: (event: React.DragEvent<HTMLElement>) => void;
  onDrop: (event: React.DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onClick: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onRunParallel?: () => void;
  onRunSequential?: () => void;
  runParallelLabel?: string;
  runSequentialLabel?: string;
  editLabel: string;
  deleteLabel: string;
}

const SnippetRow = memo<SnippetRowProps>(({
  snippet,
  depth,
  subtitle,
  selected = false,
  multiSelect = false,
  draggable,
  sortableTarget,
  onDragOver,
  onDrop,
  onDragEnd,
  onClick,
  onEdit,
  onDelete,
  onRunParallel,
  onRunSequential,
  runParallelLabel,
  runSequentialLabel,
  editLabel,
  deleteLabel,
}) => (
  <ContextMenu>
    <ContextMenuTrigger asChild>
      <div
        className="vault-drop-indicator-row"
        data-snippet-id={sortableTarget ? snippet.id : undefined}
        draggable={draggable}
        onDragStart={(event) => {
          if (!draggable) return;
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('snippet-id', snippet.id);
        }}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragEnd={onDragEnd}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onClick}
              aria-pressed={multiSelect ? selected : undefined}
              className={cn(
                'w-full flex items-center gap-1.5 pr-3 py-1.5 text-left hover:bg-accent/50 transition-colors overflow-hidden',
                selected && 'bg-primary/10 hover:bg-primary/15',
              )}
              style={{ paddingLeft: 8 + depth * 14 }}
            >
              {/* Hidden chevron column mirrors PackageRow's layout so the
                  snippet icon lines up exactly with the package icon above. */}
              <ChevronRight size={12} className="shrink-0 opacity-0" aria-hidden />
              {multiSelect ? (
                <CheckSquare
                  size={12}
                  className={cn(
                    'shrink-0',
                    selected ? 'text-primary' : 'text-muted-foreground/70',
                  )}
                />
              ) : isScriptSnippet(snippet) ? (
                <Play size={12} className="shrink-0 text-primary" />
              ) : (
                <Zap size={12} className="shrink-0 text-muted-foreground" />
              )}
              <span className="flex-1 min-w-0 truncate text-xs font-medium">{snippet.label}</span>
              {subtitle && (
                <span className="shrink-0 max-w-[40%] truncate text-[10px] text-muted-foreground">
                  {subtitle}
                </span>
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" align="start">
            <SnippetCommandTooltipContent label={snippet.label} command={snippet.command} />
          </TooltipContent>
        </Tooltip>
      </div>
    </ContextMenuTrigger>
    <ContextMenuContent>
      {onRunParallel ? (
        <ContextMenuItem onClick={onRunParallel}>
          <Layers className="mr-2 h-4 w-4" /> {runParallelLabel}
        </ContextMenuItem>
      ) : null}
      {onRunSequential ? (
        <ContextMenuItem onClick={onRunSequential}>
          <Layers className="mr-2 h-4 w-4" /> {runSequentialLabel}
        </ContextMenuItem>
      ) : null}
      <ContextMenuItem onClick={onEdit}>
        <Edit2 className="mr-2 h-4 w-4" /> {editLabel}
      </ContextMenuItem>
      <ContextMenuItem className="text-destructive" onClick={onDelete}>
        <Trash2 className="mr-2 h-4 w-4" /> {deleteLabel}
      </ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>
));
SnippetRow.displayName = 'SnippetRow';

export const ScriptsSidePanel = memo(ScriptsSidePanelInner);
ScriptsSidePanel.displayName = 'ScriptsSidePanel';
