import React, { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  AlertCircle,
  ChevronRight,
  ClipboardCopy,
  CornerUpLeft,
  Copy,
  Download,
  Edit2,
  ExternalLink,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Loader2,
  Pencil,
  RefreshCw,
  Shield,
  Trash2,
} from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../ui/context-menu';
import { cn } from '../../lib/utils';
import type { SftpFileEntry } from '../../types';
import type { SftpPane } from '../../application/state/sftp/types';
import { getParentPath, joinPath } from '../../application/state/sftp/utils';
import { filterHiddenFiles, formatBytes, formatDate, getFileIcon, isNavigableDirectory, sortSftpEntries, type ColumnWidths, type SortField, type SortOrder } from './utils';
import type { SftpTransferSource } from './SftpContext';
import { sftpTreeSelectionStore, useSftpTreeSelectionState } from './hooks/useSftpTreeSelectionStore';
import { sftpTreeEnterStore } from './hooks/useSftpKeyboardShortcuts';
import { useI18n } from '../../application/i18n/I18nProvider';
import { isKnownBinaryFile } from '../../lib/sftpFileUtils';

type NodeDescriptor =
  | { type: 'node'; entry: SftpFileEntry; entryPath: string; depth: number; isExpanded: boolean; isLoading: boolean }
  | { type: 'loading' | 'error'; key: string; depth: number };

interface SftpPaneTreeViewProps {
  pane: SftpPane;
  side: 'left' | 'right';
  onLoadChildren: (path: string) => Promise<SftpFileEntry[]>;
  onNavigateUp: () => void;
  onRefresh: () => void;
  onOpenEntry: (entry: SftpFileEntry, fullPath?: string) => void;
  onDragStart: (files: SftpTransferSource[], side: 'left' | 'right') => void;
  onDragEnd: () => void;
  openRenameDialog: (entryPath: string) => void;
  openDeleteConfirm: (targets: string[]) => void;
  onCopyToOtherPane: (files: SftpTransferSource[]) => void;
  onOpenFileWith?: (entry: SftpFileEntry, fullPath?: string) => void;
  onEditFile?: (entry: SftpFileEntry, fullPath?: string) => void;
  onDownloadFile?: (entry: SftpFileEntry, fullPath?: string) => void;
  onEditPermissions?: (entry: SftpFileEntry, fullPath?: string) => void;
  draggedFiles: (SftpTransferSource & { side: 'left' | 'right' })[] | null;
  openNewFolderDialog: (targetPath: string) => void;
  openNewFileDialog: (targetPath: string) => void;
  onUploadExternalFiles?: (dataTransfer: DataTransfer, targetPath?: string) => Promise<void>;
  columnWidths: ColumnWidths;
  handleSort: (field: SortField) => void;
  handleResizeStart: (field: keyof ColumnWidths, e: React.MouseEvent) => void;
  sortField: SortField;
  sortOrder: SortOrder;
  reloadRequest: { token: number; paths?: string[]; full?: boolean };
}

// ── Simplified TreeNode (no per-node ContextMenu) ────────────────────

interface TreeNodeProps {
  entry: SftpFileEntry;
  entryPath: string;
  depth: number;
  columnTemplate: string;
  isSelected: boolean;
  isExpanded: boolean;
  isLoading: boolean;
  isDragOver: boolean;
  onToggleExpand: (entry: SftpFileEntry, entryPath: string) => void;
  onNodeClick: (entry: SftpFileEntry, entryPath: string, e: React.MouseEvent) => void;
  onOpenEntry: (entry: SftpFileEntry, entryPath: string) => void;
  onDragStart: (entry: SftpFileEntry, entryPath: string, isDir: boolean) => void;
  onDragEnd: () => void;
  onDragOverEntry: (entryPath: string, e: React.DragEvent) => void;
  onDropEntry: (entryPath: string, e: React.DragEvent) => void;
  onDragLeaveEntry: () => void;
  onContextMenu: (entry: SftpFileEntry, entryPath: string, e: React.MouseEvent) => void;
}

const TREE_ROW_HEIGHT = 28;

const TreeNode = React.memo<TreeNodeProps>(({
  entry, entryPath, depth, columnTemplate, isSelected,
  isExpanded, isLoading, isDragOver,
  onToggleExpand, onNodeClick, onOpenEntry, onDragStart, onDragEnd,
  onDragOverEntry, onDropEntry, onDragLeaveEntry,
  onContextMenu,
}) => {
  const { t } = useI18n();
  const isParentEntry = entry.name === '..';
  const isDir = isNavigableDirectory(entry);
  const icon = isDir
      ? (isExpanded
          ? <FolderOpen size={14} className="shrink-0 text-yellow-500" />
          : <Folder size={14} className="shrink-0 text-yellow-500" />)
      : getFileIcon(entry);

  return (
    <div
      className={cn(
        'grid items-center gap-x-1 px-2 cursor-pointer select-none hover:bg-accent/50 text-sm',
        isSelected && 'bg-accent text-accent-foreground',
        isDragOver && 'ring-2 ring-primary/50 ring-inset bg-primary/10',
      )}
      style={{ gridTemplateColumns: columnTemplate, height: TREE_ROW_HEIGHT }}
      onClick={e => onNodeClick(entry, entryPath, e)}
      onDoubleClick={() => {
        if (isParentEntry) { onOpenEntry(entry, entryPath); return; }
        if (isDir) void onToggleExpand(entry, entryPath);
        else onOpenEntry(entry, entryPath);
      }}
      onContextMenu={e => {
        if (!isParentEntry) {
          onContextMenu(entry, entryPath, e);
        }
      }}
      draggable={!isParentEntry}
      onDragStart={() => { if (!isParentEntry) onDragStart(entry, entryPath, isDir); }}
      onDragEnd={onDragEnd}
      onDragOver={e => onDragOverEntry(entryPath, e)}
      onDrop={e => onDropEntry(entryPath, e)}
      onDragLeave={onDragLeaveEntry}
    >
      <div
        className="flex min-w-0 items-center gap-1"
        style={{ paddingLeft: depth * 16 + 8 }}
      >
        <span className="shrink-0 w-4 flex items-center justify-center">
          {isParentEntry ? (
            <CornerUpLeft size={14} className="text-muted-foreground" />
          ) : isDir ? (
            isLoading ? (
              <Loader2 size={12} className="animate-spin text-muted-foreground" />
            ) : (
              <ChevronRight
                size={14}
                className={cn('transition-transform text-muted-foreground', isExpanded && 'rotate-90')}
                onClick={e => { e.stopPropagation(); void onToggleExpand(entry, entryPath); }}
              />
            )
          ) : null}
        </span>
        {!isParentEntry && <span className="shrink-0">{icon}</span>}
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      </div>
      <span className="min-w-0 text-muted-foreground text-xs truncate">
        {isParentEntry ? '' : formatDate(entry.lastModified)}
      </span>
      <span className="min-w-0 text-right text-muted-foreground text-xs truncate">
        {isParentEntry ? '' : (isDir ? '--' : formatBytes(entry.size ?? 0))}
      </span>
      <span className="min-w-0 text-right text-muted-foreground text-xs truncate">
        {isParentEntry ? '' : (isDir ? t('sftp.kind.folder') : (entry.name.split('.').pop()?.toUpperCase() ?? '--'))}
      </span>
    </div>
  );
});
TreeNode.displayName = 'TreeNode';

// ── Tree paths reducer (unchanged) ──────────────────────────────────

type TreePathsState = {
  expandedPaths: Set<string>;
  loadingPaths: Set<string>;
  errorPaths: Set<string>;
};

type TreePathsAction =
  | { type: 'START_LOADING'; path: string }
  | { type: 'FINISH_LOADING'; path: string }
  | { type: 'LOAD_ERROR'; path: string }
  | { type: 'EXPAND'; path: string }
  | { type: 'COLLAPSE'; path: string }
  | { type: 'RESET' };

const INITIAL_TREE_PATHS_STATE: TreePathsState = {
  expandedPaths: new Set(),
  loadingPaths: new Set(),
  errorPaths: new Set(),
};

function treePathsReducer(state: TreePathsState, action: TreePathsAction): TreePathsState {
  switch (action.type) {
    case 'START_LOADING': {
      const loadingPaths = new Set(state.loadingPaths);
      loadingPaths.add(action.path);
      const errorPaths = new Set(state.errorPaths);
      errorPaths.delete(action.path);
      return { ...state, loadingPaths, errorPaths };
    }
    case 'FINISH_LOADING': {
      const loadingPaths = new Set(state.loadingPaths);
      loadingPaths.delete(action.path);
      return { ...state, loadingPaths };
    }
    case 'LOAD_ERROR': {
      const loadingPaths = new Set(state.loadingPaths);
      loadingPaths.delete(action.path);
      const errorPaths = new Set(state.errorPaths);
      errorPaths.add(action.path);
      return { ...state, loadingPaths, errorPaths };
    }
    case 'EXPAND': {
      const expandedPaths = new Set(state.expandedPaths);
      expandedPaths.add(action.path);
      return { ...state, expandedPaths };
    }
    case 'COLLAPSE': {
      const expandedPaths = new Set(state.expandedPaths);
      expandedPaths.delete(action.path);
      return { ...state, expandedPaths };
    }
    case 'RESET':
      return INITIAL_TREE_PATHS_STATE;
    default:
      return state;
  }
}

// ── Context target type ─────────────────────────────────────────────

interface ContextTarget {
  entry: SftpFileEntry;
  entryPath: string;
}

// ── Main tree view component ────────────────────────────────────────

export const SftpPaneTreeView = React.memo<SftpPaneTreeViewProps>(({
  pane,
  side,
  onLoadChildren,
  onNavigateUp,
  onRefresh,
  onOpenEntry,
  onDragStart,
  onDragEnd,
  openRenameDialog,
  openDeleteConfirm,
  onCopyToOtherPane,
  onOpenFileWith,
  onEditFile,
  onDownloadFile,
  onEditPermissions,
  draggedFiles,
  openNewFolderDialog,
  openNewFileDialog,
  onUploadExternalFiles,
  columnWidths,
  handleSort,
  handleResizeStart,
  sortField,
  sortOrder,
  reloadRequest,
}) => {
  const { t } = useI18n();
  const columnTemplate = `${columnWidths.name}% ${columnWidths.modified}% ${columnWidths.size}% ${columnWidths.type}%`;
  const tRef = useRef(t);
  tRef.current = t;

  // ── Drag-over state for external file drops on directories ──────
  const [dragOverNodePath, setDragOverNodePath] = useState<string | null>(null);
  const onUploadExternalFilesRef = useRef(onUploadExternalFiles);
  onUploadExternalFilesRef.current = onUploadExternalFiles;

  // ── Virtual scrolling state ──────────────────────────────────────
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const scrollFrameRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const update = () => setViewportHeight(container.clientHeight);
    update();
    const raf = window.requestAnimationFrame(update);
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(container);
    return () => {
      resizeObserver.disconnect();
      window.cancelAnimationFrame(raf);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
    };
  }, []);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const nextTop = e.currentTarget.scrollTop;
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      setScrollTop(nextTop);
    });
  }, []);

  // ── Shared context menu state ────────────────────────────────────
  const [contextTarget, setContextTarget] = useState<ContextTarget | null>(null);

  // ── Tree data state ──────────────────────────────────────────────
  const childrenCacheRef = useRef<Map<string, SftpFileEntry[]>>(new Map());
  const sortedChildrenCacheRef = useRef<Map<string, SftpFileEntry[]>>(new Map());
  const [treePaths, dispatchTreePaths] = useReducer(treePathsReducer, INITIAL_TREE_PATHS_STATE);
  const { expandedPaths, loadingPaths, errorPaths } = treePaths;
  const treeSelectionState = useSftpTreeSelectionState(pane.id);
  const selectedPaths = treeSelectionState.selectedPaths;
  const lastClickedPathRef = useRef<string | null>(null);
  const expandedPathsRef = useRef(expandedPaths);
  expandedPathsRef.current = expandedPaths;
  const loadingPathsRef = useRef(loadingPaths);
  loadingPathsRef.current = loadingPaths;
  const selectedPathsRef = useRef(selectedPaths);
  selectedPathsRef.current = selectedPaths;
  const treeGenerationRef = useRef(0);
  const previousRootPathRef = useRef(pane.connection?.currentPath ?? '');
  const [resolvedRootPath, setResolvedRootPath] = useState(pane.connection?.currentPath ?? '');
  const currentRootPath = pane.connection?.currentPath ?? '';
  const visibleRootPath = pane.loading ? resolvedRootPath : currentRootPath;

  const onOpenEntryRef = useRef(onOpenEntry);
  onOpenEntryRef.current = onOpenEntry;
  const onNavigateUpRef = useRef(onNavigateUp);
  onNavigateUpRef.current = onNavigateUp;
  const onDragStartRef = useRef(onDragStart);
  onDragStartRef.current = onDragStart;
  const onDragEndRef = useRef(onDragEnd);
  onDragEndRef.current = onDragEnd;
  const onCopyToOtherPaneRef = useRef(onCopyToOtherPane);
  onCopyToOtherPaneRef.current = onCopyToOtherPane;
  const onOpenFileWithRef = useRef(onOpenFileWith);
  onOpenFileWithRef.current = onOpenFileWith;
  const onEditFileRef = useRef(onEditFile);
  onEditFileRef.current = onEditFile;
  const onDownloadFileRef = useRef(onDownloadFile);
  onDownloadFileRef.current = onDownloadFile;
  const onEditPermissionsRef = useRef(onEditPermissions);
  onEditPermissionsRef.current = onEditPermissions;
  const openRenameDialogRef = useRef(openRenameDialog);
  openRenameDialogRef.current = openRenameDialog;
  const openDeleteConfirmRef = useRef(openDeleteConfirm);
  openDeleteConfirmRef.current = openDeleteConfirm;
  const openNewFolderDialogRef = useRef(openNewFolderDialog);
  openNewFolderDialogRef.current = openNewFolderDialog;
  const openNewFileDialogRef = useRef(openNewFileDialog);
  openNewFileDialogRef.current = openNewFileDialog;
  const onLoadChildrenRef = useRef(onLoadChildren);
  onLoadChildrenRef.current = onLoadChildren;
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;
  const sideRef = useRef(side);
  sideRef.current = side;
  const draggedFilesRef = useRef(draggedFiles);
  draggedFilesRef.current = draggedFiles;

  const invalidateTreeCache = useCallback(() => {
    treeGenerationRef.current += 1;
    childrenCacheRef.current.clear();
    sortedChildrenCacheRef.current.clear();
  }, []);

  const invalidatePathCache = useCallback((targetPath: string) => {
    treeGenerationRef.current += 1;
    childrenCacheRef.current.delete(targetPath);
    sortedChildrenCacheRef.current.delete(targetPath);
  }, []);

  // Clear sorted cache when sort/filter settings change
  const prevSortKeyRef = useRef(`${sortField}:${sortOrder}:${pane.showHiddenFiles}`);
  const sortKey = `${sortField}:${sortOrder}:${pane.showHiddenFiles}`;
  if (prevSortKeyRef.current !== sortKey) {
    prevSortKeyRef.current = sortKey;
    sortedChildrenCacheRef.current.clear();
  }

  useEffect(() => {
    const rootPath = pane.connection?.currentPath;
    if (!rootPath) return;
    sortedChildrenCacheRef.current.delete(rootPath);
  }, [pane.connection?.currentPath, pane.files]);

  useEffect(() => {
    const currentPath = pane.connection?.currentPath ?? '';
    if (!currentPath) {
      setResolvedRootPath('');
      return;
    }
    if (!pane.loading) {
      setResolvedRootPath(currentPath);
    }
  }, [pane.connection?.currentPath, pane.loading]);

  const loadChildrenForPath = useCallback(async (entryPath: string) => {
    const generation = treeGenerationRef.current;
    dispatchTreePaths({ type: 'START_LOADING', path: entryPath });

    try {
      const children = await onLoadChildrenRef.current(entryPath);
      if (generation !== treeGenerationRef.current) {
        return false;
      }
      childrenCacheRef.current.set(entryPath, children);
      return true;
    } catch {
      if (generation === treeGenerationRef.current) {
        dispatchTreePaths({ type: 'LOAD_ERROR', path: entryPath });
      }
      return false;
    } finally {
      if (generation === treeGenerationRef.current) {
        dispatchTreePaths({ type: 'FINISH_LOADING', path: entryPath });
      }
    }
  }, []);

  const toggleExpand = useCallback(async (entry: SftpFileEntry, entryPath: string) => {
    if (!isNavigableDirectory(entry)) return;
    if (expandedPathsRef.current.has(entryPath)) {
      dispatchTreePaths({ type: 'COLLAPSE', path: entryPath });
      return;
    }
    // Guard against concurrent loads for the same path
    if (loadingPathsRef.current.has(entryPath)) return;
    if (!childrenCacheRef.current.has(entryPath)) {
      const loaded = await loadChildrenForPath(entryPath);
      if (!loaded) return;
    }
    dispatchTreePaths({ type: 'EXPAND', path: entryPath });
  }, [loadChildrenForPath]);

  const reloadExpandedPaths = useCallback(async (paths: string[]) => {
    for (const path of paths) {
      await loadChildrenForPath(path);
    }
  }, [loadChildrenForPath]);

  useEffect(() => {
    const rootPath = pane.connection?.currentPath ?? '';
    const pathChanged = previousRootPathRef.current !== rootPath;
    previousRootPathRef.current = rootPath;

    if (pathChanged) {
      invalidateTreeCache();
      dispatchTreePaths({ type: 'RESET' });
      sftpTreeSelectionStore.clearSelection(pane.id);
      lastClickedPathRef.current = null;
    }
  }, [pane.connection?.currentPath, pane.id, invalidateTreeCache]);

  useEffect(() => {
    if (!reloadRequest.token) return;
    const rootPath = pane.connection?.currentPath;
    if (!rootPath) return;

    if (reloadRequest.full || !reloadRequest.paths || reloadRequest.paths.length === 0) {
      const expanded = Array.from(expandedPathsRef.current);
      invalidateTreeCache();
      if (expanded.length > 0) {
        void reloadExpandedPaths(expanded);
      }
      return;
    }

    const targets = Array.from(new Set(reloadRequest.paths));
    for (const targetPath of targets) {
      invalidatePathCache(targetPath);
    }

    const expandedTargets = targets.filter((targetPath) =>
      targetPath !== rootPath && expandedPathsRef.current.has(targetPath),
    );
    if (expandedTargets.length > 0) {
      void reloadExpandedPaths(expandedTargets);
    }
  }, [invalidatePathCache, invalidateTreeCache, pane.connection?.currentPath, reloadExpandedPaths, reloadRequest]);

  const focusTreeContainer = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    if (document.activeElement !== container) {
      container.focus();
    }
  }, []);

  const handleNodeClick = useCallback((entry: SftpFileEntry, entryPath: string, e: React.MouseEvent) => {
    focusTreeContainer();

    const nextSelection: string[] = (() => {
      if (e.shiftKey && lastClickedPathRef.current) {
        const items = treeSelectionState.visibleItems;
        const lastIdx = treeSelectionState.visibleIndexByPath.get(lastClickedPathRef.current) ?? -1;
        const currentIdx = treeSelectionState.visibleIndexByPath.get(entryPath) ?? -1;
        if (lastIdx !== -1 && currentIdx !== -1) {
          const parentPath = getParentPath(entryPath);
          const start = Math.min(lastIdx, currentIdx);
          const end = Math.max(lastIdx, currentIdx);
          return items
              .slice(start, end + 1)
              .filter(item => getParentPath(item.path) === parentPath)
              .map(item => item.path);
        }
      }

      if (e.ctrlKey || e.metaKey) {
        const next = new Set<string>(selectedPathsRef.current);
        if (next.has(entryPath)) next.delete(entryPath);
        else next.add(entryPath);
        return Array.from(next);
      }

      return [entryPath];
    })();

    sftpTreeSelectionStore.setSelection(pane.id, nextSelection);

    lastClickedPathRef.current = entryPath;
  }, [focusTreeContainer, pane.id, treeSelectionState.visibleIndexByPath, treeSelectionState.visibleItems]);

  const openTreeEntry = useCallback((entry: SftpFileEntry, entryPath: string) => {
    if (entry.name === '..') {
      onNavigateUpRef.current();
      return;
    }
    onOpenEntryRef.current(entry, entryPath);
  }, []);

  const stableOnRefresh = useCallback(() => onRefreshRef.current(), []);

  const handleTreeContainerKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;

    const items = treeSelectionState.visibleItems;
    if (items.length === 0) return;

    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();

      const delta = e.key === 'ArrowDown' ? 1 : -1;
      const currentSelected = [...selectedPathsRef.current];
      let currentIdx = -1;
      if (currentSelected.length === 1) {
        currentIdx = treeSelectionState.visibleIndexByPath.get(currentSelected[0]) ?? -1;
      }

      let nextIdx = currentIdx + delta;
      if (nextIdx < 0) nextIdx = 0;
      if (nextIdx >= items.length) nextIdx = items.length - 1;

      if (e.shiftKey && currentSelected.length > 0) {
        const anchorIdx = currentIdx >= 0 ? currentIdx : 0;
        const start = Math.min(anchorIdx, nextIdx);
        const end = Math.max(anchorIdx, nextIdx);
        const paths = items.slice(start, end + 1).map((item) => item.path);
        sftpTreeSelectionStore.setSelection(pane.id, paths);
      } else {
        sftpTreeSelectionStore.setSelection(pane.id, [items[nextIdx].path]);
      }

      lastClickedPathRef.current = items[nextIdx].path;
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      const selected = sftpTreeSelectionStore.getSelectedItems(pane.id);
      if (selected.length !== 1) return;

      e.preventDefault();
      e.stopPropagation();

      const item = selected[0];
      const entry = entryByPathRef.current.get(item.path);
      if (!entry) return;

      if (item.isParentNavigation || entry.name === '..') {
        openTreeEntry(entry, item.path);
        return;
      }

      if (item.isDirectory) {
        void toggleExpand(entry, item.path);
        return;
      }

      openTreeEntry(entry, item.path);
    }
  }, [openTreeEntry, pane.id, toggleExpand, treeSelectionState.visibleIndexByPath, treeSelectionState.visibleItems]);

  const { nodeDescriptors, flatVisibleNodes, entryByPath } = useMemo(() => {
    const flat: Array<{ entry: SftpFileEntry; entryPath: string }> = [];
    const descriptors: NodeDescriptor[] = [];
    const pathMap = new Map<string, SftpFileEntry>();

    // Prepend ".." entry for parent navigation when not at root
    const currentPath = visibleRootPath;
    const isRootPath = currentPath === '/' || /^[A-Za-z]:[\\/]?$/.test(currentPath);
    if (!isRootPath && currentPath) {
      const files = pane.files ?? [];
      let parentEntry = files.find(f => f.name === '..');
      if (!parentEntry) {
        parentEntry = {
          name: '..',
          type: 'directory',
          size: 0,
          sizeFormatted: '--',
          lastModified: 0,
          lastModifiedFormatted: '--',
        };
      }
      const parentPath = getParentPath(currentPath);
      flat.push({ entry: parentEntry, entryPath: parentPath });
      pathMap.set(parentPath, parentEntry);
      descriptors.push({
        type: 'node',
        entry: parentEntry,
        entryPath: parentPath,
        depth: 0,
        isExpanded: false,
        isLoading: false,
      });
    }

    const getSortedEntries = (entries: SftpFileEntry[], parentPath: string): SftpFileEntry[] => {
      const cached = sortedChildrenCacheRef.current.get(parentPath);
      if (cached) return cached;
      const sorted = sortSftpEntries(filterHiddenFiles(entries, pane.showHiddenFiles), sortField, sortOrder);
      sortedChildrenCacheRef.current.set(parentPath, sorted);
      return sorted;
    };

    const buildTree = (entries: SftpFileEntry[], parentPath: string, depth: number) => {
      for (const entry of getSortedEntries(entries, parentPath)) {
        if (entry.name === '..') continue; // Skip ".." from file list; already handled above
        const entryPath = joinPath(parentPath, entry.name);
        flat.push({ entry, entryPath });
        pathMap.set(entryPath, entry);
        descriptors.push({
          type: 'node',
          entry,
          entryPath,
          depth,
          isExpanded: expandedPaths.has(entryPath),
          isLoading: loadingPaths.has(entryPath),
        });
        if (isNavigableDirectory(entry) && expandedPaths.has(entryPath)) {
          if (loadingPaths.has(entryPath)) {
            descriptors.push({ type: 'loading', key: `${entryPath}-loading`, depth });
          } else if (errorPaths.has(entryPath)) {
            descriptors.push({ type: 'error', key: `${entryPath}-error`, depth });
          } else {
            buildTree(childrenCacheRef.current.get(entryPath) ?? [], entryPath, depth + 1);
          }
        }
      }
    };

    buildTree(pane.files ?? [], currentPath, 0);
    return { nodeDescriptors: descriptors, flatVisibleNodes: flat, entryByPath: pathMap };
  }, [
    pane.files,
    visibleRootPath,
    pane.showHiddenFiles,
    sortField,
    sortOrder,
    expandedPaths,
    loadingPaths,
    errorPaths,
  ]);

  const entryByPathRef = useRef(entryByPath);
  entryByPathRef.current = entryByPath;

  const prevVisiblePathsRef = useRef<string[]>([]);
  useEffect(() => {
    const currentPaths = flatVisibleNodes
      .filter(({ entry }) => entry.name !== '..')
      .map(({ entryPath }) => entryPath);
    const prev = prevVisiblePathsRef.current;
    if (
      currentPaths.length === prev.length &&
      currentPaths.every((p, i) => p === prev[i])
    ) {
      return;
    }
    prevVisiblePathsRef.current = currentPaths;
    sftpTreeSelectionStore.setVisibleItems(
      pane.id,
      flatVisibleNodes
        .filter(({ entry }) => entry.name !== '..')
        .map(({ entry, entryPath }) => ({
          path: entryPath,
          name: entry.name,
          isDirectory: isNavigableDirectory(entry),
          isParentNavigation: entry.name === '..',
          sourcePath: getParentPath(entryPath),
        })),
    );
  }, [flatVisibleNodes, pane.id]);

  useEffect(() => {
    return () => {
      sftpTreeSelectionStore.clearPane(pane.id);
    };
  }, [pane.id]);

  // Subscribe to tree Enter key actions from the keyboard shortcut hook
  useEffect(() => {
    return sftpTreeEnterStore.subscribe(() => {
      const action = sftpTreeEnterStore.get();
      if (!action || action.paneId !== pane.id) return;
      sftpTreeEnterStore.clear();

      const entry = entryByPathRef.current.get(action.entryPath);
      if (!entry) return;

      if (entry.name === '..') {
        onNavigateUpRef.current();
      } else if (action.isDirectory) {
        // Toggle expand for directories in tree view
        void toggleExpand(entry, action.entryPath);
      } else {
        // Open file
        onOpenEntryRef.current(entry, action.entryPath);
      }
    });
  }, [pane.id, toggleExpand]);

  const getActionPaths = useCallback((entryPath: string) => {
    const selected = selectedPathsRef.current;
    return selected.has(entryPath) ? Array.from(selected) : [entryPath];
  }, []);

  const toTransferSources = useCallback((paths: string[]): SftpTransferSource[] => {
    const sources: SftpTransferSource[] = [];
    for (const path of paths) {
      const entry = entryByPathRef.current.get(path);
      if (!entry || entry.name === '..') continue;
      sources.push({
        name: entry.name,
        isDirectory: isNavigableDirectory(entry),
        sourceConnectionId: pane.connection?.id,
        sourcePath: getParentPath(path),
      });
    }
    return sources;
  }, [pane.connection?.id]);

  const stableOnOpenEntry = useCallback((entry: SftpFileEntry, entryPath: string) => {
    openTreeEntry(entry, entryPath);
  }, [openTreeEntry]);

  const stableOnDragStart = useCallback((entry: SftpFileEntry, entryPath: string, isDir: boolean) => {
    const files = toTransferSources(getActionPaths(entryPath));
    if (files.length === 0) {
      files.push({
        name: entry.name,
        isDirectory: isDir,
        sourceConnectionId: pane.connection?.id,
        sourcePath: getParentPath(entryPath),
      });
    }
    onDragStartRef.current(files, sideRef.current);
  }, [getActionPaths, pane.connection?.id, toTransferSources]);

  const stableOnDragEnd = useCallback(() => onDragEndRef.current(), []);

  // ── External file drag-over/drop handlers for tree directory nodes ──
  const handleNodeDragOver = useCallback((entryPath: string, e: React.DragEvent) => {
    const entry = entryByPathRef.current.get(entryPath);
    if (!entry) return;
    const isDir = isNavigableDirectory(entry);
    const isInternalDrag = draggedFilesRef.current && draggedFilesRef.current[0]?.side !== sideRef.current;
    if (isInternalDrag && isDir && entry.name !== '..') {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      setDragOverNodePath(entryPath);
      return;
    }
    const hasFiles = e.dataTransfer.types.includes('Files');
    if (hasFiles && isDir && entry.name !== '..') {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      setDragOverNodePath(entryPath);
    }
  }, []);

  const handleNodeDrop = useCallback((entryPath: string, e: React.DragEvent) => {
    const entry = entryByPathRef.current.get(entryPath);
    if (!entry) return;
    const isDir = isNavigableDirectory(entry);
    const hasFiles = e.dataTransfer.types.includes('Files');
    const isInternalDrag = draggedFilesRef.current && draggedFilesRef.current[0]?.side !== sideRef.current;
    if (isInternalDrag && isDir && entry.name !== '..') {
      e.preventDefault();
      e.stopPropagation();
      setDragOverNodePath(null);
      onCopyToOtherPaneRef.current(
        draggedFilesRef.current.map((file) => ({ ...file, targetPath: entryPath })),
      );
      return;
    }
    if (hasFiles && isDir && entry.name !== '..') {
      e.preventDefault();
      e.stopPropagation();
      setDragOverNodePath(null);
      if (onUploadExternalFilesRef.current) {
        void onUploadExternalFilesRef.current(e.dataTransfer, entryPath);
      }
    }
  }, []);

  const handleNodeDragLeave = useCallback(() => {
    setDragOverNodePath(null);
  }, []);

  // ── Shared context menu handler (called by each TreeNode) ────────
  const handleNodeContextMenu = useCallback((entry: SftpFileEntry, entryPath: string, _e: React.MouseEvent) => {
    // Store the right-clicked target; the native contextmenu event bubbles up
    // to the Radix ContextMenuTrigger wrapping the scroll area.
    setContextTarget({ entry, entryPath });
  }, []);

  // ── Virtual scrolling computation ────────────────────────────────
  const { totalHeight, visibleRange } = useMemo(() => {
    const totalCount = nodeDescriptors.length;
    const total = totalCount * TREE_ROW_HEIGHT;
    const shouldVirtualize = viewportHeight > 0 && totalCount > 50;

    if (!shouldVirtualize) {
      return { totalHeight: 0, visibleRange: { start: 0, end: totalCount - 1, virtualized: false } };
    }

    const overscan = 6;
    const start = Math.max(0, Math.floor(scrollTop / TREE_ROW_HEIGHT) - overscan);
    const end = Math.min(totalCount - 1, Math.ceil((scrollTop + viewportHeight) / TREE_ROW_HEIGHT) + overscan);
    return { totalHeight: total, visibleRange: { start, end, virtualized: true } };
  }, [nodeDescriptors.length, scrollTop, viewportHeight]);

  // ── Render visible rows ──────────────────────────────────────────
  const treeRows = useMemo(() => {
    const { start, end, virtualized } = visibleRange;
    const rows: React.ReactNode[] = [];

    for (let i = start; i <= end; i++) {
      const descriptor = nodeDescriptors[i];
      if (!descriptor) continue;

      let content: React.ReactNode;
      if (descriptor.type === 'loading') {
        content = (
          <div
            style={{ paddingLeft: (descriptor.depth + 1) * 16 + 8, height: TREE_ROW_HEIGHT }}
            className="text-xs text-muted-foreground flex items-center gap-1"
          >
            <Loader2 size={12} className="animate-spin" /> {tRef.current('sftp.tree.loading')}
          </div>
        );
      } else if (descriptor.type === 'error') {
        content = (
          <div
            style={{ paddingLeft: (descriptor.depth + 1) * 16 + 8, height: TREE_ROW_HEIGHT }}
            className="text-xs text-destructive flex items-center gap-1"
          >
            <AlertCircle size={12} /> {tRef.current('sftp.tree.loadError')}
          </div>
        );
      } else {
        content = (
          <TreeNode
            entry={descriptor.entry}
            entryPath={descriptor.entryPath}
            depth={descriptor.depth}
            columnTemplate={columnTemplate}
            isSelected={selectedPaths.has(descriptor.entryPath)}
            isExpanded={descriptor.isExpanded}
            isLoading={descriptor.isLoading}
            isDragOver={dragOverNodePath === descriptor.entryPath}
            onToggleExpand={toggleExpand}
            onNodeClick={handleNodeClick}
            onOpenEntry={stableOnOpenEntry}
            onDragStart={stableOnDragStart}
            onDragEnd={stableOnDragEnd}
            onDragOverEntry={handleNodeDragOver}
            onDropEntry={handleNodeDrop}
            onDragLeaveEntry={handleNodeDragLeave}
            onContextMenu={handleNodeContextMenu}
          />
        );
      }

      const key = descriptor.type === 'node' ? descriptor.entryPath : descriptor.key;
      if (virtualized) {
        rows.push(
          <div
            key={key}
            className="absolute left-0 right-0"
            style={{ top: i * TREE_ROW_HEIGHT, height: TREE_ROW_HEIGHT }}
          >
            {content}
          </div>,
        );
      } else {
        rows.push(<React.Fragment key={key}>{content}</React.Fragment>);
      }
    }

    return rows;
  }, [
    visibleRange,
    nodeDescriptors,
    columnTemplate,
    selectedPaths,
    dragOverNodePath,
    toggleExpand,
    handleNodeClick,
    stableOnOpenEntry,
    stableOnDragStart,
    stableOnDragEnd,
    handleNodeDragOver,
    handleNodeDrop,
    handleNodeDragLeave,
    handleNodeContextMenu,
  ]);

  // ── Shared context menu content (single instance) ────────────────
  const contextMenuContent = useMemo(() => {
    const target = contextTarget;
    if (!target) return null;

    const { entry, entryPath } = target;
    const isDir = isNavigableDirectory(entry);
    const isLocal = pane.connection?.isLocal;

    const handleOpen = () => {
      if (isDir) void toggleExpand(entry, entryPath);
      else stableOnOpenEntry(entry, entryPath);
    };

    const handleCopyToOtherPane = () => {
      const paths = getActionPaths(entryPath);
      const files = toTransferSources(paths);
      if (files.length === 0) {
        files.push({
          name: entry.name,
          isDirectory: isDir,
          sourceConnectionId: pane.connection?.id,
          sourcePath: getParentPath(entryPath),
        });
      }
      onCopyToOtherPaneRef.current(files);
    };

    const handleDelete = () => {
      openDeleteConfirmRef.current(getActionPaths(entryPath));
    };

    return (
      <ContextMenuContent>
        <ContextMenuItem onClick={handleOpen}>
          {isDir
            ? <><Folder size={14} className="mr-2" />{tRef.current('sftp.context.open')}</>
            : <><ExternalLink size={14} className="mr-2" />{tRef.current('sftp.context.open')}</>}
        </ContextMenuItem>
        {!isDir && onOpenFileWithRef.current && (
          <ContextMenuItem onClick={() => onOpenFileWithRef.current?.(entry, entryPath)}>
            <ExternalLink size={14} className="mr-2" />{tRef.current('sftp.context.openWith')}
          </ContextMenuItem>
        )}
        {!isDir && !isKnownBinaryFile(entry.name) && onEditFileRef.current && (
          <ContextMenuItem onClick={() => onEditFileRef.current?.(entry, entryPath)}>
            <Edit2 size={14} className="mr-2" />{tRef.current('sftp.context.edit')}
          </ContextMenuItem>
        )}
        {onDownloadFileRef.current && (!isDir || !isLocal) && (
          <ContextMenuItem onClick={() => onDownloadFileRef.current?.(entry, entryPath)}>
            <Download size={14} className="mr-2" />{tRef.current('sftp.context.download')}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={handleCopyToOtherPane}>
          <Copy size={14} className="mr-2" />{tRef.current('sftp.context.copyToOtherPane')}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => navigator.clipboard.writeText(entryPath)}>
          <ClipboardCopy size={14} className="mr-2" />{tRef.current('sftp.context.copyPath')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => openRenameDialogRef.current(entryPath)}>
          <Pencil size={14} className="mr-2" />{tRef.current('common.rename')}
        </ContextMenuItem>
        {onEditPermissionsRef.current && !isLocal && (
          <ContextMenuItem onClick={() => onEditPermissionsRef.current?.(entry, entryPath)}>
            <Shield size={14} className="mr-2" />{tRef.current('sftp.context.permissions')}
          </ContextMenuItem>
        )}
        <ContextMenuItem
          className="text-destructive"
          onClick={handleDelete}
        >
          <Trash2 size={14} className="mr-2" />{tRef.current('action.delete')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={stableOnRefresh}>
          <RefreshCw size={14} className="mr-2" />{tRef.current('common.refresh')}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => openNewFolderDialogRef.current(isDir ? entryPath : getParentPath(entryPath))}>
          <FolderPlus size={14} className="mr-2" />{tRef.current('sftp.newFolder')}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => openNewFileDialogRef.current(isDir ? entryPath : getParentPath(entryPath))}>
          <FilePlus size={14} className="mr-2" />{tRef.current('sftp.newFile')}
        </ContextMenuItem>
      </ContextMenuContent>
    );
  }, [
    contextTarget,
    pane.connection?.isLocal,
    pane.connection?.id,
    toggleExpand,
    stableOnOpenEntry,
    stableOnRefresh,
    getActionPaths,
    toTransferSources,
  ]);

  return (
    <div className="relative flex-1 min-h-0 flex flex-col text-sm">
      <div
        className="text-[11px] uppercase tracking-wide text-muted-foreground px-4 py-2 border-b border-border/40 bg-secondary/10 select-none shrink-0"
        style={{ display: 'grid', gridTemplateColumns: columnTemplate }}
      >
        <div
          className="flex items-center gap-1 cursor-pointer hover:text-foreground relative pr-2 min-w-0"
          onClick={() => handleSort('name')}
        >
          <span>{t('sftp.columns.name')}</span>
          {sortField === 'name' && (
            <span className="text-primary">
              {sortOrder === 'asc' ? '↑' : '↓'}
            </span>
          )}
          <div
            className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/50 transition-colors"
            onMouseDown={(e) => handleResizeStart('name', e)}
          />
        </div>
        <div
          className="flex items-center gap-1 cursor-pointer hover:text-foreground relative pr-2 min-w-0"
          onClick={() => handleSort('modified')}
        >
          <span>{t('sftp.columns.modified')}</span>
          {sortField === 'modified' && (
            <span className="text-primary">
              {sortOrder === 'asc' ? '↑' : '↓'}
            </span>
          )}
          <div
            className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/50 transition-colors"
            onMouseDown={(e) => handleResizeStart('modified', e)}
          />
        </div>
        <div
          className="flex items-center justify-end gap-1 cursor-pointer hover:text-foreground relative pr-2 min-w-0"
          onClick={() => handleSort('size')}
        >
          {sortField === 'size' && (
            <span className="text-primary">
              {sortOrder === 'asc' ? '↑' : '↓'}
            </span>
          )}
          <span>{t('sftp.columns.size')}</span>
          <div
            className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/50 transition-colors"
            onMouseDown={(e) => handleResizeStart('size', e)}
          />
        </div>
        <div
          className="flex items-center justify-end gap-1 cursor-pointer hover:text-foreground min-w-0"
          onClick={() => handleSort('type')}
        >
          {sortField === 'type' && (
            <span className="text-primary">
              {sortOrder === 'asc' ? '↑' : '↓'}
            </span>
          )}
          <span>{t('sftp.columns.kind')}</span>
        </div>
      </div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={scrollContainerRef}
            className="flex-1 min-h-0 overflow-y-auto outline-none"
            tabIndex={0}
            onScroll={handleScroll}
            onKeyDown={handleTreeContainerKeyDown}
            onMouseDown={focusTreeContainer}
          >
            <div
              className={visibleRange.virtualized ? 'relative' : undefined}
              style={visibleRange.virtualized ? { height: totalHeight } : undefined}
            >
              {treeRows}
            </div>
          </div>
        </ContextMenuTrigger>
        {contextMenuContent}
      </ContextMenu>

      {pane.loading && !pane.reconnecting && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-background/40 backdrop-blur-[1px] z-10 pointer-events-none">
          <Loader2 size={24} className="animate-spin text-muted-foreground" />
          {pane.connectionLogs.length > 0 && (
            <div className="w-full max-w-sm mt-2 space-y-0.5 px-4">
              {pane.connectionLogs.map((log, i) => (
                <div key={i} className="text-[11px] text-muted-foreground truncate">
                  {log}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {pane.reconnecting && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80 backdrop-blur-sm z-20">
          <div className="flex flex-col items-center gap-3 p-6 rounded-xl bg-secondary/90 border border-border/60 shadow-lg">
            <Loader2 size={32} className="animate-spin text-primary" />
            <div className="text-center">
              <div className="text-sm font-medium">{t('sftp.reconnecting.title')}</div>
              <div className="text-xs text-muted-foreground mt-1">{t('sftp.reconnecting.desc')}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
SftpPaneTreeView.displayName = 'SftpPaneTreeView';
