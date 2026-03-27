import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ChevronRight,
  ClipboardCopy,
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
import { filterHiddenFiles, formatBytes, formatDate, getFileIcon, isNavigableDirectory } from './utils';
import { treeSelectionStore, type SftpTransferSource } from './SftpContext';
import { useI18n } from '../../application/i18n/I18nProvider';
import { isKnownBinaryFile } from '../../lib/sftpFileUtils';

type NodeDescriptor =
  | { type: 'node'; entry: SftpFileEntry; entryPath: string; depth: number; isExpanded: boolean; isLoading: boolean }
  | { type: 'loading' | 'error'; key: string; depth: number };

interface SftpPaneTreeViewProps {
  pane: SftpPane;
  side: 'left' | 'right';
  onLoadChildren: (path: string) => Promise<SftpFileEntry[]>;
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
  setShowNewFolderDialog: (open: boolean) => void;
  setShowNewFileDialog: (open: boolean) => void;
  reloadVersion: number;
}

interface TreeNodeProps {
  entry: SftpFileEntry;
  entryPath: string;
  depth: number;
  isExpanded: boolean;
  isLoading: boolean;
  isSelected: boolean;
  isLocal: boolean | undefined;
  onToggleExpand: (entry: SftpFileEntry, entryPath: string) => void;
  onNodeClick: (entry: SftpFileEntry, entryPath: string, e: React.MouseEvent) => void;
  onOpenEntry: (entry: SftpFileEntry, entryPath: string) => void;
  onDragStart: (entry: SftpFileEntry, entryPath: string, isDir: boolean) => void;
  onDragEnd: () => void;
  onCopyToOtherPane: (entry: SftpFileEntry, entryPath: string, isDir: boolean) => void;
  onOpenFileWith?: (entry: SftpFileEntry, entryPath: string) => void;
  onEditFile?: (entry: SftpFileEntry, entryPath: string) => void;
  onDownloadFile?: (entry: SftpFileEntry, entryPath: string) => void;
  onEditPermissions?: (entry: SftpFileEntry, entryPath: string) => void;
  openRenameDialog: (entryPath: string) => void;
  openDeleteConfirm: (entryPath: string) => void;
  onRefresh: () => void;
  setShowNewFolderDialog: (open: boolean) => void;
  setShowNewFileDialog: (open: boolean) => void;
}

const TreeNode = React.memo<TreeNodeProps>(({
  entry, entryPath, depth,
  isExpanded, isLoading, isSelected, isLocal,
  onToggleExpand, onNodeClick, onOpenEntry, onDragStart, onDragEnd,
  onCopyToOtherPane, onOpenFileWith, onEditFile, onDownloadFile, onEditPermissions,
  openRenameDialog, openDeleteConfirm, onRefresh,
  setShowNewFolderDialog, setShowNewFileDialog,
}) => {
  const { t } = useI18n();
  const isDir = isNavigableDirectory(entry);
  const icon = isDir
    ? (isExpanded
        ? <FolderOpen size={14} className="shrink-0 text-yellow-500" />
        : <Folder size={14} className="shrink-0 text-yellow-500" />)
    : getFileIcon(entry);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            'flex items-center gap-1 px-2 py-[2px] cursor-pointer select-none hover:bg-accent/50 text-sm',
            isSelected && 'bg-accent text-accent-foreground',
          )}
          style={{ paddingLeft: depth * 16 + 8 }}
          onClick={e => onNodeClick(entry, entryPath, e)}
          onDoubleClick={() => {
            if (isDir) void onToggleExpand(entry, entryPath);
            else onOpenEntry(entry, entryPath);
          }}
          draggable
          onDragStart={() => onDragStart(entry, entryPath, isDir)}
          onDragEnd={onDragEnd}
        >
          <span className="shrink-0 w-4 flex items-center justify-center">
            {isDir ? (
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
          <span className="shrink-0">{icon}</span>
          <span className="flex-1 truncate">{entry.name}</span>
          <span className="w-[140px] shrink-0 text-muted-foreground text-xs truncate">
            {formatDate(entry.lastModified)}
          </span>
          <span className="w-[80px] shrink-0 text-right text-muted-foreground text-xs">
            {isDir ? '--' : formatBytes(entry.size ?? 0)}
          </span>
          <span className="w-[60px] shrink-0 text-right text-muted-foreground text-xs truncate">
            {isDir ? t('sftp.kind.folder') : (entry.name.split('.').pop()?.toUpperCase() ?? '--')}
          </span>
        </div>
      </ContextMenuTrigger>
      {entry.name !== '..' && (
        <ContextMenuContent>
          <ContextMenuItem onClick={() => {
            if (isDir) void onToggleExpand(entry, entryPath);
            else onOpenEntry(entry, entryPath);
          }}>
            {isDir
              ? <><Folder size={14} className="mr-2" />{t('sftp.context.open')}</>
              : <><ExternalLink size={14} className="mr-2" />{t('sftp.context.open')}</>}
          </ContextMenuItem>
          {!isDir && onOpenFileWith && (
            <ContextMenuItem onClick={() => onOpenFileWith(entry, entryPath)}>
              <ExternalLink size={14} className="mr-2" />{t('sftp.context.openWith')}
            </ContextMenuItem>
          )}
          {!isDir && !isKnownBinaryFile(entry.name) && onEditFile && (
            <ContextMenuItem onClick={() => onEditFile(entry, entryPath)}>
              <Edit2 size={14} className="mr-2" />{t('sftp.context.edit')}
            </ContextMenuItem>
          )}
          {onDownloadFile && (!isDir || !isLocal) && (
            <ContextMenuItem onClick={() => onDownloadFile(entry, entryPath)}>
              <Download size={14} className="mr-2" />{t('sftp.context.download')}
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => onCopyToOtherPane(entry, entryPath, isDir)}>
            <Copy size={14} className="mr-2" />{t('sftp.context.copyToOtherPane')}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => navigator.clipboard.writeText(entryPath)}>
            <ClipboardCopy size={14} className="mr-2" />{t('sftp.context.copyPath')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => openRenameDialog(entryPath)}>
            <Pencil size={14} className="mr-2" />{t('common.rename')}
          </ContextMenuItem>
          {onEditPermissions && !isLocal && (
            <ContextMenuItem onClick={() => onEditPermissions(entry, entryPath)}>
              <Shield size={14} className="mr-2" />{t('sftp.context.permissions')}
            </ContextMenuItem>
          )}
          <ContextMenuItem
            className="text-destructive"
            onClick={() => openDeleteConfirm(entryPath)}
          >
            <Trash2 size={14} className="mr-2" />{t('action.delete')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={onRefresh}>
            <RefreshCw size={14} className="mr-2" />{t('common.refresh')}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => setShowNewFolderDialog(true)}>
            <FolderPlus size={14} className="mr-2" />{t('sftp.newFolder')}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => setShowNewFileDialog(true)}>
            <FilePlus size={14} className="mr-2" />{t('sftp.newFile')}
          </ContextMenuItem>
        </ContextMenuContent>
      )}
    </ContextMenu>
  );
});
TreeNode.displayName = 'TreeNode';

export const SftpPaneTreeView: React.FC<SftpPaneTreeViewProps> = ({
  pane,
  side,
  onLoadChildren,
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
  setShowNewFolderDialog,
  setShowNewFileDialog,
  reloadVersion,
}) => {
  const { t } = useI18n();
  const tRef = useRef(t);
  tRef.current = t;

  const childrenCacheRef = useRef<Map<string, SftpFileEntry[]>>(new Map());
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [errorPaths, setErrorPaths] = useState<Set<string>>(new Set());
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const lastClickedPathRef = useRef<string | null>(null);
  const expandedPathsRef = useRef(expandedPaths);
  expandedPathsRef.current = expandedPaths;
  const selectedPathsRef = useRef(selectedPaths);
  selectedPathsRef.current = selectedPaths;
  const treeGenerationRef = useRef(0);
  const previousRootPathRef = useRef(pane.connection?.currentPath ?? '');

  const onOpenEntryRef = useRef(onOpenEntry);
  onOpenEntryRef.current = onOpenEntry;
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
  const setShowNewFolderDialogRef = useRef(setShowNewFolderDialog);
  setShowNewFolderDialogRef.current = setShowNewFolderDialog;
  const setShowNewFileDialogRef = useRef(setShowNewFileDialog);
  setShowNewFileDialogRef.current = setShowNewFileDialog;
  const onLoadChildrenRef = useRef(onLoadChildren);
  onLoadChildrenRef.current = onLoadChildren;
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;
  const sideRef = useRef(side);
  sideRef.current = side;

  const invalidateTreeCache = useCallback(() => {
    treeGenerationRef.current += 1;
    childrenCacheRef.current.clear();
  }, []);

  const loadChildrenForPath = useCallback(async (entryPath: string) => {
    const generation = treeGenerationRef.current;
    setLoadingPaths(prev => new Set(prev).add(entryPath));
    setErrorPaths(prev => {
      const next = new Set(prev);
      next.delete(entryPath);
      return next;
    });

    try {
      const children = await onLoadChildrenRef.current(entryPath);
      if (generation !== treeGenerationRef.current) {
        return false;
      }
      childrenCacheRef.current.set(entryPath, children);
      return true;
    } catch {
      if (generation === treeGenerationRef.current) {
        setErrorPaths(prev => new Set(prev).add(entryPath));
      }
      return false;
    } finally {
      if (generation === treeGenerationRef.current) {
        setLoadingPaths(prev => {
          const next = new Set(prev);
          next.delete(entryPath);
          return next;
        });
      }
    }
  }, []);

  const toggleExpand = useCallback(async (entry: SftpFileEntry, entryPath: string) => {
    if (!isNavigableDirectory(entry)) return;
    if (expandedPathsRef.current.has(entryPath)) {
      setExpandedPaths(prev => {
        const next = new Set(prev);
        next.delete(entryPath);
        return next;
      });
      return;
    }
    if (!childrenCacheRef.current.has(entryPath)) {
      const loaded = await loadChildrenForPath(entryPath);
      if (!loaded) return;
    }
    setExpandedPaths(prev => new Set(prev).add(entryPath));
  }, [loadChildrenForPath]);

  useEffect(() => {
    const rootPath = pane.connection?.currentPath ?? '';
    const pathChanged = previousRootPathRef.current !== rootPath;
    previousRootPathRef.current = rootPath;

    if (pathChanged) {
      invalidateTreeCache();
      setExpandedPaths(new Set());
      setLoadingPaths(new Set());
      setErrorPaths(new Set());
      setSelectedPaths(new Set());
      lastClickedPathRef.current = null;
      return;
    }

    const expanded = Array.from(expandedPathsRef.current);
    if (expanded.length === 0) {
      return;
    }

    invalidateTreeCache();
    void Promise.all(expanded.map(path => loadChildrenForPath(path)));
  }, [pane.connection?.currentPath, pane.files, pane.showHiddenFiles, invalidateTreeCache, loadChildrenForPath, reloadVersion]);

  const flatVisibleNodesRef = useRef<Array<{ entry: SftpFileEntry; entryPath: string }>>([]);

  const handleNodeClick = useCallback((entry: SftpFileEntry, entryPath: string, e: React.MouseEvent) => {
    if (entry.name === '..') return;

    setSelectedPaths(prev => {
      if (e.shiftKey && lastClickedPathRef.current) {
        const flat = flatVisibleNodesRef.current;
        const lastIdx = flat.findIndex(node => node.entryPath === lastClickedPathRef.current);
        const currentIdx = flat.findIndex(node => node.entryPath === entryPath);
        if (lastIdx !== -1 && currentIdx !== -1) {
          const parentPath = getParentPath(entryPath);
          const start = Math.min(lastIdx, currentIdx);
          const end = Math.max(lastIdx, currentIdx);
          return new Set(
            flat
              .slice(start, end + 1)
              .filter(node => getParentPath(node.entryPath) === parentPath)
              .map(node => node.entryPath),
          );
        }
      }

      if (e.ctrlKey || e.metaKey) {
        const next = new Set(prev);
        if (next.has(entryPath)) next.delete(entryPath);
        else next.add(entryPath);
        return next;
      }

      return new Set([entryPath]);
    });

    lastClickedPathRef.current = entryPath;
  }, []);

  const stableOnRefresh = useCallback(() => onRefreshRef.current(), []);

  const { nodeDescriptors, flatVisibleNodes, entryByPath } = useMemo(() => {
    const flat: Array<{ entry: SftpFileEntry; entryPath: string }> = [];
    const descriptors: NodeDescriptor[] = [];
    const pathMap = new Map<string, SftpFileEntry>();

    const buildTree = (entries: SftpFileEntry[], parentPath: string, depth: number) => {
      for (const entry of filterHiddenFiles(entries, pane.showHiddenFiles)) {
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

    buildTree(pane.files ?? [], pane.connection?.currentPath ?? '', 0);
    return { nodeDescriptors: descriptors, flatVisibleNodes: flat, entryByPath: pathMap };
  }, [
    pane.files,
    pane.connection?.currentPath,
    pane.showHiddenFiles,
    expandedPaths,
    loadingPaths,
    errorPaths,
  ]);

  flatVisibleNodesRef.current = flatVisibleNodes;
  const entryByPathRef = useRef(entryByPath);
  entryByPathRef.current = entryByPath;

  useEffect(() => {
    treeSelectionStore.setSelection(
      side,
      Array.from(selectedPaths)
        .map(path => {
          const entry = entryByPath.get(path);
          if (!entry || entry.name === '..') return null;
          return {
            path,
            name: entry.name,
            isDirectory: isNavigableDirectory(entry),
          };
        })
        .filter((entry): entry is { path: string; name: string; isDirectory: boolean } => entry !== null),
    );

    return () => {
      treeSelectionStore.clearSelection(side);
    };
  }, [entryByPath, selectedPaths, side]);

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
    onOpenEntryRef.current(entry, entryPath);
  }, []);

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

  const stableOnCopyToOtherPane = useCallback((entry: SftpFileEntry, entryPath: string, isDir: boolean) => {
    const files = toTransferSources(getActionPaths(entryPath));
    if (files.length === 0) {
      files.push({
        name: entry.name,
        isDirectory: isDir,
        sourceConnectionId: pane.connection?.id,
        sourcePath: getParentPath(entryPath),
      });
    }
    onCopyToOtherPaneRef.current(files);
  }, [getActionPaths, pane.connection?.id, toTransferSources]);

  const stableOnOpenFileWith = useCallback((entry: SftpFileEntry, entryPath: string) => {
    onOpenFileWithRef.current?.(entry, entryPath);
  }, []);
  const stableOnEditFile = useCallback((entry: SftpFileEntry, entryPath: string) => {
    onEditFileRef.current?.(entry, entryPath);
  }, []);
  const stableOnDownloadFile = useCallback((entry: SftpFileEntry, entryPath: string) => {
    onDownloadFileRef.current?.(entry, entryPath);
  }, []);
  const stableOnEditPermissions = useCallback((entry: SftpFileEntry, entryPath: string) => {
    onEditPermissionsRef.current?.(entry, entryPath);
  }, []);
  const stableOpenRenameDialog = useCallback((entryPath: string) => openRenameDialogRef.current(entryPath), []);
  const stableOpenDeleteConfirm = useCallback((entryPath: string) => {
    openDeleteConfirmRef.current(getActionPaths(entryPath));
  }, [getActionPaths]);
  const stableSetShowNewFolderDialog = useCallback((open: boolean) => setShowNewFolderDialogRef.current(open), []);
  const stableSetShowNewFileDialog = useCallback((open: boolean) => setShowNewFileDialogRef.current(open), []);

  const treeNodes = useMemo(() => {
    return nodeDescriptors.map(descriptor => {
      if (descriptor.type === 'loading') {
        return (
          <div
            key={descriptor.key}
            style={{ paddingLeft: (descriptor.depth + 1) * 16 + 8 }}
            className="py-1 text-xs text-muted-foreground flex items-center gap-1"
          >
            <Loader2 size={12} className="animate-spin" /> {tRef.current('sftp.tree.loading')}
          </div>
        );
      }
      if (descriptor.type === 'error') {
        return (
          <div
            key={descriptor.key}
            style={{ paddingLeft: (descriptor.depth + 1) * 16 + 8 }}
            className="py-1 text-xs text-destructive flex items-center gap-1"
          >
            <AlertCircle size={12} /> {tRef.current('sftp.tree.loadError')}
          </div>
        );
      }
      return (
        <TreeNode
          key={descriptor.entryPath}
          entry={descriptor.entry}
          entryPath={descriptor.entryPath}
          depth={descriptor.depth}
          isExpanded={descriptor.isExpanded}
          isLoading={descriptor.isLoading}
          isSelected={selectedPaths.has(descriptor.entryPath)}
          isLocal={pane.connection?.isLocal}
          onToggleExpand={toggleExpand}
          onNodeClick={handleNodeClick}
          onOpenEntry={stableOnOpenEntry}
          onDragStart={stableOnDragStart}
          onDragEnd={stableOnDragEnd}
          onCopyToOtherPane={stableOnCopyToOtherPane}
          onOpenFileWith={stableOnOpenFileWith}
          onEditFile={stableOnEditFile}
          onDownloadFile={stableOnDownloadFile}
          onEditPermissions={stableOnEditPermissions}
          openRenameDialog={stableOpenRenameDialog}
          openDeleteConfirm={stableOpenDeleteConfirm}
          onRefresh={stableOnRefresh}
          setShowNewFolderDialog={stableSetShowNewFolderDialog}
          setShowNewFileDialog={stableSetShowNewFileDialog}
        />
      );
    });
  }, [
    nodeDescriptors,
    selectedPaths,
    pane.connection?.isLocal,
    toggleExpand,
    handleNodeClick,
    stableOnOpenEntry,
    stableOnDragStart,
    stableOnDragEnd,
    stableOnCopyToOtherPane,
    stableOnOpenFileWith,
    stableOnEditFile,
    stableOnDownloadFile,
    stableOnEditPermissions,
    stableOpenRenameDialog,
    stableOpenDeleteConfirm,
    stableOnRefresh,
    stableSetShowNewFolderDialog,
    stableSetShowNewFileDialog,
  ]);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto text-sm">
      <div
        className="text-[11px] uppercase tracking-wide text-muted-foreground px-4 py-2 border-b border-border/40 bg-secondary/10 select-none sticky top-0 z-10"
        style={{ display: 'grid', gridTemplateColumns: '1fr 140px 80px 60px' }}
      >
        <div>{t('sftp.columns.name')}</div>
        <div>{t('sftp.columns.modified')}</div>
        <div className="text-right">{t('sftp.columns.size')}</div>
        <div className="text-right">{t('sftp.columns.kind')}</div>
      </div>
      {treeNodes}
    </div>
  );
};
