import React, { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AlertCircle, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '../ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '../ui/context-menu';
import { TREE_ROW_HEIGHT, type NodeDescriptor } from './SftpPaneTreeNode';
import { INITIAL_TREE_PATHS_STATE, treePathsReducer } from './sftpTreePathsReducer';
import { useSftpPaneTreeContextMenu } from './useSftpPaneTreeContextMenu';
import { useSftpPaneTreeRows } from './useSftpPaneTreeRows';
import { SftpMoveToDialog } from './SftpMoveToDialog';
import type { SftpFileEntry } from '../../types';
import { getParentPath, joinPath } from '../../application/state/sftp/utils';
import { buildSftpColumnTemplate, filterHiddenFiles, isNavigableDirectory, isSftpColumnMenuKey, sortSftpEntries } from './utils';
import type { SftpTransferSource } from './SftpContext';
import type { SftpPaneTreeViewProps } from './SftpPaneTreeView.types';
import { sftpTreeSelectionStore, useSftpTreeSelectionState } from './hooks/useSftpTreeSelectionStore';
import { sftpKeyboardSelectionStore, sftpTreeEnterStore } from './hooks/useSftpKeyboardShortcuts';
import { useI18n } from '../../application/i18n/I18nProvider';
import { SftpColumnMenuItems } from './SftpColumnMenuItems';
import {
  shouldShowSftpUploadFolderMenu,
  shouldShowSftpUploadFilesMenu,
} from './sftpUploadMenu';
interface ContextTarget {
  entry: SftpFileEntry;
  entryPath: string;
}
export const SftpPaneTreeView = React.memo<SftpPaneTreeViewProps>(({
  pane,
  side,
  onPrepareSelection,
  onLoadChildren,
  onMoveEntriesToPath,
  onNavigateUp,
  onNavigateTo,
  onRefresh,
  onOpenEntry,
  onDragStart,
  onDragEnd,
  openRenameDialog,
  openDeleteConfirm,
  onCopyToOtherPane,
  onReceiveFromOtherPane,
  onOpenFileWithSystemDefault,
  onOpenFileWith,
  onEditFile,
  onDownloadFile,
  onEditPermissions,
  draggedFiles,
  openNewFolderDialog,
  openNewFileDialog,
  onUploadExternalFiles,
  onUploadExternalFileList,
  onUploadExternalFolder,
  sorting,
  reloadRequest,
}) => {
  const {
    columnWidths,
    visibleColumns,
    directoriesFirst,
    handleSort,
    handleResizeStart,
    toggleColumnVisibility,
    toggleDirectoriesFirst,
    sortField,
    sortOrder,
  } = sorting;
  const { t } = useI18n();
  const columnTemplate = buildSftpColumnTemplate(columnWidths, visibleColumns);
  const tRef = useRef(t);
  tRef.current = t;
  const [dragOverNodePath, setDragOverNodePath] = useState<string | null>(null);
  const onUploadExternalFilesRef = useRef(onUploadExternalFiles);
  onUploadExternalFilesRef.current = onUploadExternalFiles;
  const onUploadExternalFileListRef = useRef(onUploadExternalFileList);
  onUploadExternalFileListRef.current = onUploadExternalFileList;
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetPathRef = useRef<string | undefined>(undefined);
  const uploadEnabled = shouldShowSftpUploadFilesMenu({
    isLocal: !!pane.connection?.isLocal,
    hasFileListUpload: !!onUploadExternalFileList,
  });
  const folderUploadEnabled = shouldShowSftpUploadFolderMenu({
    isLocal: !!pane.connection?.isLocal,
    hasFolderUpload: !!onUploadExternalFolder,
  });
  const triggerUploadPicker = useCallback((targetPath?: string) => {
    if (!uploadEnabled) return;
    const input = uploadInputRef.current;
    if (!input) return;
    uploadTargetPathRef.current = targetPath;
    input.value = '';
    input.click();
  }, [uploadEnabled]);
  const handleUploadInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) {
      uploadTargetPathRef.current = undefined;
      return;
    }
    const targetPath = uploadTargetPathRef.current;
    uploadTargetPathRef.current = undefined;
    void onUploadExternalFileListRef.current?.(files, targetPath);
  }, []);
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
  const pendingScrollTopRef = useRef(0);
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    pendingScrollTopRef.current = e.currentTarget.scrollTop;
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      setScrollTop(pendingScrollTopRef.current);
    });
  }, []);
  const [contextTarget, setContextTarget] = useState<ContextTarget | null>(null);
  const [showMoveToDialog, setShowMoveToDialog] = useState(false);
  const [moveToPath, setMoveToPath] = useState('');
  const [moveTargetPaths, setMoveTargetPaths] = useState<string[]>([]);
  const [moveToError, setMoveToError] = useState<string | null>(null);
  const [isMoving, setIsMoving] = useState(false);
  const [moveToSuggestions, setMoveToSuggestions] = useState<string[]>([]);
  const [moveToSuggestionIndex, setMoveToSuggestionIndex] = useState(-1);
  const moveToInputRef = useRef<HTMLInputElement>(null);
  const moveToSuggestionsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const treeSelectionStateRef = useRef(treeSelectionState);
  treeSelectionStateRef.current = treeSelectionState;
  const treeGenerationRef = useRef(0);
  const previousRootPathRef = useRef(pane.connection?.currentPath ?? '');
  const previousConnectionIdRef = useRef(pane.connection?.id ?? null);
  const [rootEntries, setRootEntries] = useState<SftpFileEntry[]>(pane.files ?? []);
  const [resolvedRootPath, setResolvedRootPath] = useState(pane.connection?.currentPath ?? '');
  useEffect(() => {
    if (selectedPaths.size === 0) {
      lastClickedPathRef.current = null;
      sftpKeyboardSelectionStore.clear(pane.id);
    }
  }, [pane.id, selectedPaths.size]);
  const onOpenEntryRef = useRef(onOpenEntry);
  onOpenEntryRef.current = onOpenEntry;
  const onNavigateUpRef = useRef(onNavigateUp);
  onNavigateUpRef.current = onNavigateUp;
  const onNavigateToRef = useRef(onNavigateTo);
  onNavigateToRef.current = onNavigateTo;
  const onPrepareSelectionRef = useRef(onPrepareSelection);
  onPrepareSelectionRef.current = onPrepareSelection;
  const onMoveEntriesToPathRef = useRef(onMoveEntriesToPath);
  onMoveEntriesToPathRef.current = onMoveEntriesToPath;
  const onDragStartRef = useRef(onDragStart);
  onDragStartRef.current = onDragStart;
  const onDragEndRef = useRef(onDragEnd);
  onDragEndRef.current = onDragEnd;
  const onCopyToOtherPaneRef = useRef(onCopyToOtherPane);
  onCopyToOtherPaneRef.current = onCopyToOtherPane;
  const onReceiveFromOtherPaneRef = useRef(onReceiveFromOtherPane);
  onReceiveFromOtherPaneRef.current = onReceiveFromOtherPane;
  const onOpenFileWithSystemDefaultRef = useRef(onOpenFileWithSystemDefault);
  onOpenFileWithSystemDefaultRef.current = onOpenFileWithSystemDefault;
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
  const prevSortKeyRef = useRef(`${sortField}:${sortOrder}:${directoriesFirst}:${pane.showHiddenFiles}`);
  const sortKey = `${sortField}:${sortOrder}:${directoriesFirst}:${pane.showHiddenFiles}`;
  if (prevSortKeyRef.current !== sortKey) {
    prevSortKeyRef.current = sortKey;
    sortedChildrenCacheRef.current.clear();
  }
  useEffect(() => {
    const currentPath = pane.connection?.currentPath ?? '';
    if (!currentPath) {
      setResolvedRootPath('');
      setRootEntries([]);
      return;
    }
    if (!pane.loading) {
      setResolvedRootPath(currentPath);
      setRootEntries(pane.files ?? []);
      sortedChildrenCacheRef.current.delete(currentPath);
    }
  }, [pane.connection?.currentPath, pane.loading, pane.files]);
  const loadChildrenForPath = useCallback(async (entryPath: string) => {
    const generation = treeGenerationRef.current;
    dispatchTreePaths({ type: 'START_LOADING', path: entryPath });
    try {
      const children = await onLoadChildrenRef.current(entryPath);
      if (generation !== treeGenerationRef.current) {
        return false;
      }
      childrenCacheRef.current.set(entryPath, children);
      dispatchTreePaths({ type: 'FINISH_LOADING', path: entryPath });
      return true;
    } catch {
      if (generation === treeGenerationRef.current) {
        dispatchTreePaths({ type: 'LOAD_ERROR', path: entryPath });
      }
      return false;
    }
  }, []);
  const toggleExpand = useCallback(async (entry: SftpFileEntry, entryPath: string) => {
    if (!isNavigableDirectory(entry)) return;
    if (expandedPathsRef.current.has(entryPath)) {
      dispatchTreePaths({ type: 'COLLAPSE', path: entryPath });
      return;
    }
    if (loadingPathsRef.current.has(entryPath)) return;
    if (!childrenCacheRef.current.has(entryPath)) {
      const loaded = await loadChildrenForPath(entryPath);
      if (!loaded) return;
    }
    dispatchTreePaths({ type: 'EXPAND', path: entryPath });
  }, [loadChildrenForPath]);
  const reloadExpandedPaths = useCallback(async (paths: string[]) => {
    await Promise.all(paths.map((path) => loadChildrenForPath(path)));
  }, [loadChildrenForPath]);
  const reloadRootPath = useCallback(async (rootPath: string) => {
    try {
      const children = await onLoadChildrenRef.current(rootPath);
      if ((pane.connection?.currentPath ?? '') !== rootPath) return;
      setResolvedRootPath(rootPath);
      setRootEntries(children);
      sortedChildrenCacheRef.current.delete(rootPath);
    } catch {
      // Ignore refresh failures; the next explicit refresh can retry.
    }
  }, [pane.connection?.currentPath]);
  useEffect(() => {
    const rootPath = pane.connection?.currentPath ?? '';
    const connectionId = pane.connection?.id ?? null;
    const pathChanged = previousRootPathRef.current !== rootPath;
    const connectionChanged = previousConnectionIdRef.current !== connectionId;
    previousRootPathRef.current = rootPath;
    previousConnectionIdRef.current = connectionId;
    if (pathChanged || connectionChanged) {
      invalidateTreeCache();
      dispatchTreePaths({ type: 'RESET' });
      sftpTreeSelectionStore.clearSelection(pane.id);
      sftpKeyboardSelectionStore.clear(pane.id);
      lastClickedPathRef.current = null;
    }
  }, [pane.connection?.currentPath, pane.connection?.id, pane.id, invalidateTreeCache]);
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
    const shouldReloadRoot = targets.includes(rootPath);
    if (shouldReloadRoot) {
      void reloadRootPath(rootPath);
    }
    const expandedTargets = targets.filter((targetPath) =>
      targetPath !== rootPath && expandedPathsRef.current.has(targetPath),
    );
    if (expandedTargets.length > 0) {
      void reloadExpandedPaths(expandedTargets);
    }
  }, [invalidatePathCache, invalidateTreeCache, pane.connection?.currentPath, reloadExpandedPaths, reloadRequest, reloadRootPath]);
  const focusTreeContainer = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    if (document.activeElement !== container) {
      container.focus();
    }
  }, []);
  const handleNodeClick = useCallback((entry: SftpFileEntry, entryPath: string, e: React.MouseEvent) => {
    focusTreeContainer();
    const state = treeSelectionStateRef.current;
    const currentIdx = state.visibleIndexByPath.get(entryPath) ?? -1;
    const nextSelection: string[] = (() => {
      if (e.shiftKey && lastClickedPathRef.current) {
        const items = state.visibleItems;
        const lastIdx = state.visibleIndexByPath.get(lastClickedPathRef.current) ?? -1;
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
    onPrepareSelectionRef.current();
    sftpTreeSelectionStore.setSelection(pane.id, nextSelection);
    if (currentIdx !== -1) {
      if (e.shiftKey && lastClickedPathRef.current) {
        const anchorIdx = state.visibleIndexByPath.get(lastClickedPathRef.current) ?? currentIdx;
        sftpKeyboardSelectionStore.set(pane.id, anchorIdx, currentIdx);
      } else {
        sftpKeyboardSelectionStore.set(pane.id, currentIdx, currentIdx);
      }
    }
    lastClickedPathRef.current = entryPath;
  }, [focusTreeContainer, pane.id]);
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
    const state = treeSelectionStateRef.current;
    const items = state.visibleItems;
    if (items.length === 0) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      const currentSelected = [...selectedPathsRef.current];
      let { anchor: anchorIdx, focus: focusIdx } = sftpKeyboardSelectionStore.get(pane.id);
      if (currentSelected.length === 0) {
        anchorIdx = e.shiftKey ? 0 : -1;
        focusIdx = -1;
      } else {
        const focusPath = items[focusIdx]?.path;
        if (!focusPath || !state.selectedPaths.has(focusPath)) {
          focusIdx = state.visibleIndexByPath.get(currentSelected[currentSelected.length - 1]) ?? 0;
          anchorIdx = focusIdx;
          sftpKeyboardSelectionStore.set(pane.id, anchorIdx, focusIdx);
        }
      }
      let nextIdx = focusIdx + delta;
      if (nextIdx < 0) nextIdx = 0;
      if (nextIdx >= items.length) nextIdx = items.length - 1;
      onPrepareSelectionRef.current();
      if (e.shiftKey && currentSelected.length > 0) {
        const start = Math.min(anchorIdx, nextIdx);
        const end = Math.max(anchorIdx, nextIdx);
        const paths = items.slice(start, end + 1).map((item) => item.path);
        sftpTreeSelectionStore.setSelection(pane.id, paths);
        sftpKeyboardSelectionStore.set(pane.id, anchorIdx, nextIdx);
      } else {
        sftpTreeSelectionStore.setSelection(pane.id, [items[nextIdx].path]);
        sftpKeyboardSelectionStore.set(pane.id, nextIdx, nextIdx);
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
      if (entry.name === '..') {
        openTreeEntry(entry, item.path);
        return;
      }
      if (item.isDirectory) {
        void toggleExpand(entry, item.path);
        return;
      }
      openTreeEntry(entry, item.path);
    }
  }, [openTreeEntry, pane.id, toggleExpand]);
  const { nodeDescriptors, flatVisibleNodes, entryByPath } = useMemo(() => {
    const flat: Array<{ entry: SftpFileEntry; entryPath: string }> = [];
    const descriptors: NodeDescriptor[] = [];
    const pathMap = new Map<string, SftpFileEntry>();
    const currentPath = resolvedRootPath;
    const isRootPath = currentPath === '/' || /^[A-Za-z]:[\\/]?$/.test(currentPath);
    if (!isRootPath && currentPath) {
      const files = rootEntries;
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
      const sorted = sortSftpEntries(
        filterHiddenFiles(entries, pane.showHiddenFiles),
        sortField,
        sortOrder,
        directoriesFirst,
      );
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
    buildTree(rootEntries, currentPath, 0);
    return { nodeDescriptors: descriptors, flatVisibleNodes: flat, entryByPath: pathMap };
  }, [
    rootEntries,
    resolvedRootPath,
    pane.showHiddenFiles,
    sortField,
    sortOrder,
    directoriesFirst,
    expandedPaths,
    loadingPaths,
    errorPaths,
  ]);
  const entryByPathRef = useRef(entryByPath);
  entryByPathRef.current = entryByPath;
  useEffect(() => {
    if (selectedPaths.size !== 1) return;
    const selectedPath = selectedPaths.values().next().value;
    if (!selectedPath) return;
    const selectedIndex = nodeDescriptors.findIndex(
      (descriptor) => descriptor.type === 'node' && descriptor.entryPath === selectedPath,
    );
    const container = scrollContainerRef.current;
    if (selectedIndex < 0 || !container) return;

    const rowTop = selectedIndex * TREE_ROW_HEIGHT;
    const rowBottom = rowTop + TREE_ROW_HEIGHT;
    if (rowTop < container.scrollTop) {
      container.scrollTop = rowTop;
    } else if (rowBottom > container.scrollTop + container.clientHeight) {
      container.scrollTop = rowBottom - container.clientHeight;
    }
  }, [nodeDescriptors, selectedPaths]);
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
          sourcePath: getParentPath(entryPath),
        })),
    );
  }, [flatVisibleNodes, pane.id]);
  useEffect(() => {
    return () => {
      sftpTreeSelectionStore.clearPane(pane.id);
    };
  }, [pane.id]);
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
        void toggleExpand(entry, action.entryPath);
      } else {
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
  const stableOnDragStart = useCallback((entry: SftpFileEntry, entryPath: string, isDir: boolean, e: React.DragEvent) => {
    const files = toTransferSources(getActionPaths(entryPath));
    if (files.length === 0) {
      files.push({
        name: entry.name,
        isDirectory: isDir,
        sourceConnectionId: pane.connection?.id,
        sourcePath: getParentPath(entryPath),
      });
    }
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData('text/plain', files.map((f) => f.name).join('\n'));
    onDragStartRef.current(files, sideRef.current);
  }, [getActionPaths, pane.connection?.id, toTransferSources]);
  const stableOnDragEnd = useCallback(() => onDragEndRef.current(), []);
  const applyLocalMoveMutation = useCallback((
    sourceParentPaths: string[],
    targetPath: string,
    movedEntries: SftpFileEntry[],
  ) => {
    if (movedEntries.length === 0) return;
    const currentPath = pane.connection?.currentPath ?? '';
    const movedNameSet = new Set(movedEntries.map((entry) => entry.name));
    const uniqueSourceParents = Array.from(new Set(sourceParentPaths));
    if (currentPath) {
      if (uniqueSourceParents.includes(currentPath)) {
        setRootEntries((prev) => prev.filter((entry) => !movedNameSet.has(entry.name)));
      } else if (currentPath === targetPath) {
        setRootEntries((prev) => {
          const next = [...prev];
          for (const entry of movedEntries) {
            if (!next.some((candidate) => candidate.name === entry.name)) {
              next.push(entry);
            }
          }
          return next;
        });
      }
    }
    for (const sourceParent of uniqueSourceParents) {
      if (sourceParent === currentPath) continue;
      const cached = childrenCacheRef.current.get(sourceParent);
      if (!cached) continue;
      childrenCacheRef.current.set(
        sourceParent,
        cached.filter((entry) => !movedNameSet.has(entry.name)),
      );
      sortedChildrenCacheRef.current.delete(sourceParent);
    }
    if (targetPath !== currentPath) {
      const targetCache = childrenCacheRef.current.get(targetPath);
      if (targetCache) {
        const next = [...targetCache];
        for (const entry of movedEntries) {
          if (!next.some((candidate) => candidate.name === entry.name)) {
            next.push(entry);
          }
        }
        childrenCacheRef.current.set(targetPath, next);
        sortedChildrenCacheRef.current.delete(targetPath);
      }
    }
  }, [pane.connection?.currentPath]);
  const executeMoveAction = useCallback(async (sourcePaths: string[], targetPath: string) => {
    try {
      await onMoveEntriesToPathRef.current(sourcePaths, targetPath);
      const sourceParents = sourcePaths.map((p) => getParentPath(p));
      const movedEntries = sourcePaths
        .map((p) => entryByPathRef.current.get(p))
        .filter((e): e is SftpFileEntry => Boolean(e));
      applyLocalMoveMutation(sourceParents, targetPath, movedEntries);
      const syncTargets = Array.from(new Set(
        [targetPath, ...sourceParents].filter((p) => p && expandedPathsRef.current.has(p)),
      ));
      if (syncTargets.length > 0) void reloadExpandedPaths(syncTargets);
    } catch {
      throw new Error('Move failed');
    }
  }, [applyLocalMoveMutation, reloadExpandedPaths]);
  const fetchMoveToSuggestions = useCallback((inputPath: string) => {
    if (moveToSuggestionsTimerRef.current) clearTimeout(moveToSuggestionsTimerRef.current);
    if (!inputPath.trim()) {
      setMoveToSuggestions([]);
      return;
    }
    const parentDir = inputPath.endsWith('/') || inputPath.endsWith('\\') ? inputPath : getParentPath(inputPath);
    const prefix = inputPath.endsWith('/') || inputPath.endsWith('\\') ? '' : inputPath.split(/[/\\]/).pop()?.toLowerCase() ?? '';
    moveToSuggestionsTimerRef.current = setTimeout(async () => {
      try {
        const entries = await onLoadChildrenRef.current(parentDir);
        const dirs = entries
          .filter((e) => isNavigableDirectory(e) && e.name !== '..')
          .map((e) => joinPath(parentDir, e.name))
          .filter((p) => !prefix || p.split(/[/\\]/).pop()!.toLowerCase().startsWith(prefix));
        setMoveToSuggestions(dirs.slice(0, 8));
      } catch {
        setMoveToSuggestions([]);
      }
    }, 200);
  }, []);
  const handleMoveToSubmit = useCallback(async () => {
    const target = moveToPath.trim();
    if (!target || isMoving) return;
    setIsMoving(true);
    setMoveToError(null);
    try {
      await onLoadChildrenRef.current(target);
      await executeMoveAction(moveTargetPaths, target);
      setShowMoveToDialog(false);
    } catch {
      setMoveToError(tRef.current('sftp.moveTo.pathNotFound'));
    } finally {
      setIsMoving(false);
    }
  }, [moveToPath, isMoving, executeMoveAction, moveTargetPaths]);
  const getSamePaneDragPaths = useCallback((): string[] | null => {
    const dragged = draggedFilesRef.current;
    if (!dragged || dragged.length === 0) return null;
    if (dragged[0]?.side !== sideRef.current) return null;
    const currentConnectionId = pane.connection?.id;
    const paths = dragged
      .filter((file) => file.sourceConnectionId === currentConnectionId && file.sourcePath)
      .map((file) => joinPath(file.sourcePath!, file.name));
    return paths.length > 0 ? paths : null;
  }, [pane.connection?.id]);
  const handleNodeDragOver = useCallback((entryPath: string, e: React.DragEvent) => {
    const entry = entryByPathRef.current.get(entryPath);
    if (!entry) return;
    const isDir = isNavigableDirectory(entry);
    const samePaneDragPaths = getSamePaneDragPaths();
    if (samePaneDragPaths && isDir && entry.name !== '..') {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      setDragOverNodePath(entryPath);
      return;
    }
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
  }, [getSamePaneDragPaths]);
  const handleNodeDrop = useCallback((entryPath: string, e: React.DragEvent) => {
    const entry = entryByPathRef.current.get(entryPath);
    if (!entry) return;
    const isDir = isNavigableDirectory(entry);
    const samePaneDragPaths = getSamePaneDragPaths();
    if (samePaneDragPaths && isDir && entry.name !== '..') {
      e.preventDefault();
      e.stopPropagation();
      setDragOverNodePath(null);
      const movedEntries = samePaneDragPaths
        .map((path) => entryByPathRef.current.get(path))
        .filter((value): value is SftpFileEntry => Boolean(value));
      const sourceParents = samePaneDragPaths.map((path) => getParentPath(path));
      void (async () => {
        try {
          await onMoveEntriesToPathRef.current(samePaneDragPaths, entryPath);
          applyLocalMoveMutation(sourceParents, entryPath, movedEntries);
          const syncTargets = Array.from(
            new Set(
              [entryPath, ...sourceParents].filter((path) => path && expandedPathsRef.current.has(path)),
            ),
          );
          if (syncTargets.length > 0) {
            void reloadExpandedPaths(syncTargets);
          }
        } catch {
          // Ignore optimistic move refresh failures; the visible tree keeps its current state.
        }
      })();
      return;
    }
    const hasFiles = e.dataTransfer.types.includes('Files');
    const isInternalDrag = draggedFilesRef.current && draggedFilesRef.current[0]?.side !== sideRef.current;
    if (isInternalDrag && isDir && entry.name !== '..') {
      e.preventDefault();
      e.stopPropagation();
      setDragOverNodePath(null);
      onReceiveFromOtherPaneRef.current(
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
  }, [applyLocalMoveMutation, getSamePaneDragPaths, reloadExpandedPaths]);
  const handleNodeDragLeave = useCallback(() => {
    setDragOverNodePath(null);
  }, []);
  const handleNodeContextMenu = useCallback((entry: SftpFileEntry, entryPath: string, _e: React.MouseEvent) => {
    setContextTarget({ entry, entryPath });
  }, []);
  const { totalHeight, treeRows, visibleRange } = useSftpPaneTreeRows({
    nodeDescriptors,
    scrollTop,
    viewportHeight,
    tRef,
    columnTemplate,
    visibleColumns,
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
  });
  const contextMenuContent = useSftpPaneTreeContextMenu({
    contextTarget,
    pane,
    toggleExpand,
    stableOnOpenEntry,
    stableOnRefresh,
    getActionPaths,
    toTransferSources,
    executeMoveAction,
    triggerUploadPicker,
    onUploadExternalFolder,
    uploadEnabled,
    folderUploadEnabled,
    setMoveTargetPaths,
    setMoveToPath,
    setMoveToError,
    setMoveToSuggestions,
    setMoveToSuggestionIndex,
    setIsMoving,
    setShowMoveToDialog,
    tRef,
    onCopyToOtherPaneRef,
    onNavigateToRef,
    onOpenFileWithSystemDefaultRef,
    onOpenFileWithRef,
    onEditFileRef,
    onDownloadFileRef,
    onEditPermissionsRef,
    openDeleteConfirmRef,
    openRenameDialogRef,
    openNewFolderDialogRef,
    openNewFileDialogRef,
  });
  return (
    <div className="relative flex-1 min-h-0 flex flex-col text-sm">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className="text-[11px] uppercase tracking-wide text-muted-foreground px-4 py-2 border-b border-border/40 bg-secondary/10 select-none shrink-0"
            data-section="terminal-sftp-tree-header"
            tabIndex={0}
            aria-label={t('sftp.columns.configure')}
            onKeyDown={(e) => {
              if (!isSftpColumnMenuKey(e.key, e.shiftKey)) return;
              e.preventDefault();
              const rect = e.currentTarget.getBoundingClientRect();
              e.currentTarget.dispatchEvent(new MouseEvent('contextmenu', {
                bubbles: true,
                cancelable: true,
                clientX: rect.left + 16,
                clientY: rect.top + rect.height / 2,
              }));
            }}
            style={{ display: 'grid', gridTemplateColumns: columnTemplate }}
          >
            <div
              className="flex items-center gap-1 cursor-pointer hover:text-foreground relative pr-2 min-w-0 overflow-hidden"
              onClick={() => handleSort('name')}
            >
              <span className="truncate whitespace-nowrap">{t('sftp.columns.name')}</span>
              {sortField === 'name' && (
                <span className="shrink-0 text-primary">
                  {sortOrder === 'asc' ? '↑' : '↓'}
                </span>
              )}
              <div
                className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/50 transition-colors"
                onMouseDown={(e) => handleResizeStart('name', e)}
              />
            </div>
            {visibleColumns.modified && (
              <div
                className="flex items-center gap-1 cursor-pointer hover:text-foreground relative pr-2 min-w-0 overflow-hidden"
                onClick={() => handleSort('modified')}
              >
                <span className="truncate whitespace-nowrap">{t('sftp.columns.modified')}</span>
                {sortField === 'modified' && (
                  <span className="shrink-0 text-primary">
                    {sortOrder === 'asc' ? '↑' : '↓'}
                  </span>
                )}
                <div
                  className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/50 transition-colors"
                  onMouseDown={(e) => handleResizeStart('modified', e)}
                />
              </div>
            )}
            {visibleColumns.size && (
              <div
                className="flex items-center justify-end gap-1 cursor-pointer hover:text-foreground relative pr-2 min-w-0 overflow-hidden"
                onClick={() => handleSort('size')}
              >
                {sortField === 'size' && (
                  <span className="shrink-0 text-primary">
                    {sortOrder === 'asc' ? '↑' : '↓'}
                  </span>
                )}
                <span className="truncate whitespace-nowrap">{t('sftp.columns.size')}</span>
                <div
                  className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/50 transition-colors"
                  onMouseDown={(e) => handleResizeStart('size', e)}
                />
              </div>
            )}
            {visibleColumns.type && (
              <div
                className="flex items-center justify-end gap-1 cursor-pointer hover:text-foreground min-w-0 overflow-hidden"
                onClick={() => handleSort('type')}
              >
                {sortField === 'type' && (
                  <span className="shrink-0 text-primary">
                    {sortOrder === 'asc' ? '↑' : '↓'}
                  </span>
                )}
                <span className="truncate whitespace-nowrap">{t('sftp.columns.kind')}</span>
              </div>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <SftpColumnMenuItems
            visibleColumns={visibleColumns}
            directoriesFirst={directoriesFirst}
            toggleColumnVisibility={toggleColumnVisibility}
            toggleDirectoriesFirst={toggleDirectoriesFirst}
          />
        </ContextMenuContent>
      </ContextMenu>
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
            {pane.error && !pane.reconnecting && pane.files.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
                <AlertCircle size={28} className="text-destructive/70" />
                <span className="max-w-xs text-xs leading-relaxed">{t(pane.error)}</span>
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={stableOnRefresh}>
                  <RefreshCw size={14} className="mr-2" />
                  {t('sftp.retry')}
                </Button>
              </div>
            ) : (
              <div
                className={visibleRange.virtualized ? 'relative' : undefined}
                style={visibleRange.virtualized ? { height: totalHeight } : undefined}
              >
                {treeRows}
              </div>
            )}
          </div>
        </ContextMenuTrigger>
        {contextMenuContent}
      </ContextMenu>
      {uploadEnabled && (
        <input
          ref={uploadInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleUploadInputChange}
        />
      )}
      {pane.loading && !pane.connection?.reusedConnection && !pane.reconnecting && (
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
      <SftpMoveToDialog
        showMoveToDialog={showMoveToDialog}
        setShowMoveToDialog={setShowMoveToDialog}
        setMoveToPath={setMoveToPath}
        setMoveToError={setMoveToError}
        setMoveToSuggestions={setMoveToSuggestions}
        setMoveToSuggestionIndex={setMoveToSuggestionIndex}
        setIsMoving={setIsMoving}
        t={t}
        moveToInputRef={moveToInputRef}
        moveToPath={moveToPath}
        fetchMoveToSuggestions={fetchMoveToSuggestions}
        moveToSuggestions={moveToSuggestions}
        moveToSuggestionIndex={moveToSuggestionIndex}
        moveToError={moveToError}
        isMoving={isMoving}
        handleMoveToSubmit={handleMoveToSubmit}
      />
    </div>
  );
});
SftpPaneTreeView.displayName = 'SftpPaneTreeView';
