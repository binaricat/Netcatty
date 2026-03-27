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
import { isNavigableDirectory, getFileIcon, formatDate, formatBytes } from './utils';
import { joinPath } from '../../application/state/sftp/utils';
import { useSftpPaneCallbacks } from './SftpContext';
import { useI18n } from '../../application/i18n/I18nProvider';
import { isKnownBinaryFile } from '../../lib/sftpFileUtils';

type NodeDescriptor =
  | { type: 'node'; entry: SftpFileEntry; entryPath: string; depth: number; isExpanded: boolean; isLoading: boolean }
  | { type: 'loading' | 'error'; key: string; depth: number };

interface SftpPaneTreeViewProps {
  pane: SftpPane;
  side: 'left' | 'right';
  onLoadChildren: (path: string) => Promise<SftpFileEntry[]>;
  onOpenEntry: (entry: SftpFileEntry) => void;
  onDragStart: (files: { name: string; isDirectory: boolean }[], side: 'left' | 'right') => void;
  onDragEnd: () => void;
  openRenameDialog: (entryPath: string) => void;
  openDeleteConfirm: (targets: string[]) => void;
  onCopyToOtherPane: (files: { name: string; isDirectory: boolean }[]) => void;
  onOpenFileWith?: (entry: SftpFileEntry) => void;
  onEditFile?: (entry: SftpFileEntry) => void;
  onDownloadFile?: (entry: SftpFileEntry) => void;
  onEditPermissions?: (entry: SftpFileEntry) => void;
  setShowNewFolderDialog: (open: boolean) => void;
  setShowNewFileDialog: (open: boolean) => void;
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
  onOpenEntry: (entry: SftpFileEntry) => void;
  onDragStart: (entry: SftpFileEntry, isDir: boolean) => void;
  onDragEnd: () => void;
  onCopyToOtherPane: (entry: SftpFileEntry, isDir: boolean) => void;
  onOpenFileWith?: (entry: SftpFileEntry) => void;
  onEditFile?: (entry: SftpFileEntry) => void;
  onDownloadFile?: (entry: SftpFileEntry) => void;
  onEditPermissions?: (entry: SftpFileEntry) => void;
  openRenameDialog: (entryPath: string) => void;
  openDeleteConfirm: (targets: string[]) => void;
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
            else onOpenEntry(entry);
          }}
          draggable
          onDragStart={() => onDragStart(entry, isDir)}
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
            else onOpenEntry(entry);
          }}>
            {isDir
              ? <><Folder size={14} className="mr-2" />{t('sftp.context.open')}</>
              : <><ExternalLink size={14} className="mr-2" />{t('sftp.context.open')}</>}
          </ContextMenuItem>
          {!isDir && onOpenFileWith && (
            <ContextMenuItem onClick={() => onOpenFileWith(entry)}>
              <ExternalLink size={14} className="mr-2" />{t('sftp.context.openWith')}
            </ContextMenuItem>
          )}
          {!isDir && !isKnownBinaryFile(entry.name) && onEditFile && (
            <ContextMenuItem onClick={() => onEditFile(entry)}>
              <Edit2 size={14} className="mr-2" />{t('sftp.context.edit')}
            </ContextMenuItem>
          )}
          {onDownloadFile && (!isDir || !isLocal) && (
            <ContextMenuItem onClick={() => onDownloadFile(entry)}>
              <Download size={14} className="mr-2" />{t('sftp.context.download')}
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => onCopyToOtherPane(entry, isDir)}>
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
            <ContextMenuItem onClick={() => onEditPermissions(entry)}>
              <Shield size={14} className="mr-2" />{t('sftp.context.permissions')}
            </ContextMenuItem>
          )}
          <ContextMenuItem
            className="text-destructive"
            onClick={() => openDeleteConfirm([entryPath])}
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
}) => {
  const { t } = useI18n();
  const tRef = useRef(t);
  tRef.current = t;
  const callbacks = useSftpPaneCallbacks(side);

  const childrenCacheRef = useRef<Map<string, SftpFileEntry[]>>(new Map());
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [errorPaths, setErrorPaths] = useState<Set<string>>(new Set());
  const lastClickedPathRef = useRef<string | null>(null);

  // Stable refs for props that change identity on every parent render,
  // so TreeNode's React.memo shallow comparison can actually bail out.
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
  // selectedFiles held in ref — prevents it from flowing into TreeNode props and
  // causing full tree rebuilds on every selection change
  const selectedFilesRef = useRef(pane.selectedFiles);
  selectedFilesRef.current = pane.selectedFiles;
  // callbacks held in ref — handleNodeClick and stableOnRefresh can have empty deps
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  // onLoadChildren held in ref — toggleExpand can have empty deps
  const onLoadChildrenRef = useRef(onLoadChildren);
  onLoadChildrenRef.current = onLoadChildren;
  // side is constant per pane instance — held in ref so stableOnDragStart has empty deps
  const sideRef = useRef(side);
  sideRef.current = side;

  // Stable callbacks wrapping the refs — identity never changes
  const stableOnOpenEntry = useCallback((e: SftpFileEntry) => onOpenEntryRef.current(e), []);
  // Drag start resolves multi-selection via ref; side via ref so deps stay empty
  const stableOnDragStart = useCallback((entry: SftpFileEntry, isDir: boolean) => {
    const sel = selectedFilesRef.current;
    const files = sel.has(entry.name)
      ? Array.from(sel).map(name => ({ name, isDirectory: name === entry.name ? isDir : false }))
      : [{ name: entry.name, isDirectory: isDir }];
    onDragStartRef.current(files, sideRef.current);
  }, []);
  const stableOnDragEnd = useCallback(() => onDragEndRef.current(), []);
  // Selection-aware copy: resolves multi-selection via ref so TreeNode never needs selectedFiles
  const stableOnCopyToOtherPane = useCallback((entry: SftpFileEntry, isDir: boolean) => {
    const sel = selectedFilesRef.current;
    const files = sel.has(entry.name)
      ? Array.from(sel).map(name => ({ name, isDirectory: name === entry.name ? isDir : false }))
      : [{ name: entry.name, isDirectory: isDir }];
    onCopyToOtherPaneRef.current(files);
  }, []);
  // Selection-aware delete: targets are full paths from TreeNode
  const stableOpenDeleteConfirm = useCallback((targets: string[]) => {
    openDeleteConfirmRef.current(targets);
  }, []);
  const stableOnOpenFileWith = useCallback((e: SftpFileEntry) => onOpenFileWithRef.current?.(e), []);
  const stableOnEditFile = useCallback((e: SftpFileEntry) => onEditFileRef.current?.(e), []);
  const stableOnDownloadFile = useCallback((e: SftpFileEntry) => onDownloadFileRef.current?.(e), []);
  const stableOnEditPermissions = useCallback((e: SftpFileEntry) => onEditPermissionsRef.current?.(e), []);
  const stableOpenRenameDialog = useCallback((entryPath: string) => openRenameDialogRef.current(entryPath), []);
  const stableSetShowNewFolderDialog = useCallback((open: boolean) => setShowNewFolderDialogRef.current(open), []);
  const stableSetShowNewFileDialog = useCallback((open: boolean) => setShowNewFileDialogRef.current(open), []);

  // Mirror expandedPaths in a ref so toggleExpand doesn't need it as a dep
  const expandedPathsRef = useRef(expandedPaths);
  expandedPathsRef.current = expandedPaths;

  // Reset tree state when the root path changes (navigation or refresh)
  useEffect(() => {
    childrenCacheRef.current.clear();
    setExpandedPaths(new Set());
    setLoadingPaths(new Set());
    setErrorPaths(new Set());
    lastClickedPathRef.current = null;
  }, [pane.connection?.currentPath]);

  const toggleExpand = useCallback(async (entry: SftpFileEntry, entryPath: string) => {
    if (!isNavigableDirectory(entry)) return;
    if (expandedPathsRef.current.has(entryPath)) {
      setExpandedPaths(prev => { const s = new Set(prev); s.delete(entryPath); return s; });
      return;
    }
    if (childrenCacheRef.current.has(entryPath)) {
      setExpandedPaths(prev => new Set(prev).add(entryPath));
      return;
    }
    setLoadingPaths(prev => new Set(prev).add(entryPath));
    setErrorPaths(prev => { const s = new Set(prev); s.delete(entryPath); return s; });
    try {
      const children = await onLoadChildrenRef.current(entryPath);
      childrenCacheRef.current.set(entryPath, children);
      setExpandedPaths(prev => new Set(prev).add(entryPath));
    } catch {
      setErrorPaths(prev => new Set(prev).add(entryPath));
    } finally {
      setLoadingPaths(prev => { const s = new Set(prev); s.delete(entryPath); return s; });
    }
  }, []);

  // Declared before handleNodeClick which references it in its closure
  const flatVisibleNodesRef = useRef<{ entry: SftpFileEntry; parentPath: string }[]>([]);

  const handleNodeClick = useCallback((entry: SftpFileEntry, entryPath: string, e: React.MouseEvent) => {
    if (e.shiftKey && lastClickedPathRef.current) {
      const flat = flatVisibleNodesRef.current;
      const lastIdx = flat.findIndex(n => joinPath(n.parentPath, n.entry.name) === lastClickedPathRef.current);
      const currIdx = flat.findIndex(n => joinPath(n.parentPath, n.entry.name) === entryPath);
      if (lastIdx !== -1 && currIdx !== -1) {
        const parentPath = flat[currIdx].parentPath;
        const start = Math.min(lastIdx, currIdx);
        const end = Math.max(lastIdx, currIdx);
        const names = flat.slice(start, end + 1)
          .filter(n => n.parentPath === parentPath)
          .map(n => n.entry.name);
        callbacksRef.current.onRangeSelect(names);
      }
    } else if (e.ctrlKey || e.metaKey) {
      callbacksRef.current.onToggleSelection(entry.name, true);
    } else {
      callbacksRef.current.onToggleSelection(entry.name, false);
    }
    lastClickedPathRef.current = entryPath;
  }, []);

  const stableOnRefresh = useCallback(() => callbacksRef.current.onRefresh(), []);

  // Stage 1: compute tree structure — does NOT depend on selectedFiles.
  // Rebuilds only when files, expand/load/error state, or stable callbacks change.
  const { nodeDescriptors, flatVisibleNodes } = useMemo(() => {
    const flat: { entry: SftpFileEntry; parentPath: string }[] = [];
    const descriptors: NodeDescriptor[] = [];

    const buildTree = (entries: SftpFileEntry[], parentPath: string, depth: number) => {
      for (const entry of entries) {
        const entryPath = joinPath(parentPath, entry.name);
        flat.push({ entry, parentPath });
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
    return { nodeDescriptors: descriptors, flatVisibleNodes: flat };
  // pane.connection?.currentPath is intentionally excluded: path changes trigger the
  // useEffect above which resets the tree, so including it here would rebuild the
  // entire node list twice on every navigation.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    pane.files,
    expandedPaths, loadingPaths, errorPaths,
  ]);

  // Stage 2: inject isSelected and render — only reruns when selection or structure changes.
  const treeNodes = useMemo(() => {
    return nodeDescriptors.map(d => {
      if (d.type === 'loading') {
        return (
          <div
            key={d.key}
            style={{ paddingLeft: (d.depth + 1) * 16 + 8 }}
            className="py-1 text-xs text-muted-foreground flex items-center gap-1"
          >
            <Loader2 size={12} className="animate-spin" /> {tRef.current('sftp.tree.loading')}
          </div>
        );
      }
      if (d.type === 'error') {
        return (
          <div
            key={d.key}
            style={{ paddingLeft: (d.depth + 1) * 16 + 8 }}
            className="py-1 text-xs text-destructive flex items-center gap-1"
          >
            <AlertCircle size={12} /> {tRef.current('sftp.tree.loadError')}
          </div>
        );
      }
      return (
        <TreeNode
          key={d.entryPath}
          entry={d.entry}
          entryPath={d.entryPath}
          depth={d.depth}
          isExpanded={d.isExpanded}
          isLoading={d.isLoading}
          isSelected={pane.selectedFiles.has(d.entry.name)}
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
    nodeDescriptors, pane.selectedFiles, pane.connection?.isLocal,
    toggleExpand, handleNodeClick,
    stableOnOpenEntry, stableOnDragStart, stableOnDragEnd, stableOnCopyToOtherPane,
    stableOnOpenFileWith, stableOnEditFile, stableOnDownloadFile, stableOnEditPermissions,
    stableOpenRenameDialog, stableOpenDeleteConfirm, stableOnRefresh,
    stableSetShowNewFolderDialog, stableSetShowNewFileDialog,
  ]);

  // Keep flat list in sync for shift-click range selection
  flatVisibleNodesRef.current = flatVisibleNodes;

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
