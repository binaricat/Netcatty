/**
 * ScriptsSidePanel - Lightweight scripts browser for the terminal side panel
 *
 * Shows snippets organized by package hierarchy as a single tree view.
 * Packages expand / collapse via a chevron; clicking a snippet executes it
 * in the focused terminal session. Typing in the search box flattens to a
 * list of matching snippets regardless of package nesting.
 */

import { ChevronRight, Edit2, Layers, Package, Play, Plus, Search, Trash2, Zap } from 'lucide-react';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useI18n } from '../application/i18n/I18nProvider';
import { getScriptRecordingSnapshot, subscribeScriptRecording } from '../application/state/scriptRecordingStore.ts';
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
import { FixedSizeVirtualList } from './ui/FixedSizeVirtualList';
import { Input } from './ui/input';
import { SnippetCommandTooltipContent } from './snippets/SnippetCommandTooltipContent';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';

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

export function buildScriptsSidePanelRows({
  snippets,
  packages,
  expandedPaths,
}: {
  snippets: Snippet[];
  packages: string[];
  expandedPaths: Set<string>;
}): TreeRow[] {
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
}) => {
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const [subView, setSubView] = useState<'library' | 'running'>('library');
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());

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
    const set = new Set<string>();
    const addWithAncestors = (raw: string) => {
      const path = raw.trim();
      if (!path) return;
      const isAbs = path.startsWith('/');
      const body = isAbs ? path.slice(1) : path;
      const parts = body.split('/').filter(Boolean);
      for (let i = 1; i <= parts.length; i++) {
        const sub = parts.slice(0, i).join('/');
        set.add(isAbs ? `/${sub}` : sub);
      }
    };
    packages.forEach(addWithAncestors);
    // A snippet may reference a package path that's not in `packages` yet.
    snippets.forEach((s) => {
      if (s.package) addWithAncestors(s.package);
    });
    return set;
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
      if (isScriptSnippet(snippet)) {
        onRunScript?.(snippet);
        setSubView('running');
        return;
      }
      onSnippetClick(snippet);
    },
    [onRunScript, onSnippetClick],
  );

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
      className="h-full flex flex-col bg-background overflow-hidden"
      data-section="snippets-panel"
    >
      {/* Sub view tabs */}
      <div className="shrink-0 px-2 py-1 border-b border-border/50 flex items-center gap-1">
        <button
          type="button"
          className={cn(
            'flex-1 h-7 rounded-md text-xs',
            subView === 'library' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-muted/50',
          )}
          onClick={() => setSubView('library')}
        >
          {t('scripts.sidePanel.library')}
        </button>
        <button
          type="button"
          className={cn(
            'flex-1 h-7 rounded-md text-xs',
            subView === 'running' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-muted/50',
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
      {/* Search + Add */}
      <div className="shrink-0 px-2 py-1.5 border-b border-border/50 flex items-center gap-1.5">
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
              onClick={handleAddSnippet}
              aria-label={t('snippets.action.newSnippet')}
              className="shrink-0 h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
            >
              <Plus size={14} />
            </button>
          </TooltipTrigger>
          <TooltipContent>{t('snippets.action.newSnippet')}</TooltipContent>
        </Tooltip>
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
                return (
                  <SnippetRow
                    snippet={item.snippet}
                    depth={0}
                    subtitle={item.snippet.package || t('terminal.toolbar.library')}
                    draggable={false}
                    sortableTarget={false}
                    onDragOver={handleRowDragOver}
                    onDrop={handleRowDrop}
                    onDragEnd={clearScriptsDropIndicator}
                    onClick={() => handleSnippetClick(item.snippet)}
                    onEdit={() => handleEditSnippet(item.snippet)}
                    onDelete={() => handleDeleteSnippet(item.snippet.id)}
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
              return (
                <SnippetRow
                  snippet={item.row.snippet}
                  depth={item.row.depth}
                  draggable={Boolean(onSnippetsChange)}
                  sortableTarget={true}
                  onDragOver={handleRowDragOver}
                  onDrop={handleRowDrop}
                  onDragEnd={clearScriptsDropIndicator}
                  onClick={() => handleSnippetClick(item.row.snippet)}
                  onEdit={() => handleEditSnippet(item.row.snippet)}
                  onDelete={() => handleDeleteSnippet(item.row.snippet.id)}
                  onRunParallel={isScriptSnippet(item.row.snippet) && onRunScriptOnWorkspace
                    ? () => onRunScriptOnWorkspace(item.row.snippet, 'parallel')
                    : undefined}
                  onRunSequential={isScriptSnippet(item.row.snippet) && onRunScriptOnWorkspace
                    ? () => onRunScriptOnWorkspace(item.row.snippet, 'sequential')
                    : undefined}
                  runParallelLabel={t('scripts.actions.runParallel')}
                  runSequentialLabel={t('scripts.actions.runSequential')}
                  editLabel={t('action.edit')}
                  deleteLabel={t('action.delete')}
                />
              );
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
              className="w-full flex items-center gap-1.5 pr-3 py-1.5 text-left hover:bg-accent/50 transition-colors overflow-hidden"
              style={{ paddingLeft: 8 + depth * 14 }}
            >
              {/* Hidden chevron column mirrors PackageRow's layout so the
                  snippet icon lines up exactly with the package icon above. */}
              <ChevronRight size={12} className="shrink-0 opacity-0" aria-hidden />
              {isScriptSnippet(snippet) ? (
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
