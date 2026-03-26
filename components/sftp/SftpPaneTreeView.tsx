import React, { useCallback, useReducer, useRef, useState } from 'react';
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

interface SftpPaneTreeViewProps {
  pane: SftpPane;
  side: 'left' | 'right';
  onLoadChildren: (path: string) => Promise<SftpFileEntry[]>;
  onOpenEntry: (entry: SftpFileEntry) => void;
  onNavigateTo: (path: string) => void;
  draggedFiles: { name: string; isDirectory: boolean; side: 'left' | 'right' }[] | null;
  onDragStart: (files: { name: string; isDirectory: boolean }[], side: 'left' | 'right') => void;
  onDragEnd: () => void;
  openRenameDialog: (name: string) => void;
  openDeleteConfirm: (targets: string[]) => void;
  onCopyToOtherPane: (files: { name: string; isDirectory: boolean }[]) => void;
  onOpenFileWith?: (entry: SftpFileEntry) => void;
  onEditFile?: (entry: SftpFileEntry) => void;
  onDownloadFile?: (entry: SftpFileEntry) => void;
  onEditPermissions?: (entry: SftpFileEntry) => void;
}

export const SftpPaneTreeView: React.FC<SftpPaneTreeViewProps> = ({
  pane,
  side,
  onLoadChildren,
  onOpenEntry,
  onNavigateTo: _onNavigateTo,
  draggedFiles: _draggedFiles,
  onDragStart,
  onDragEnd,
  openRenameDialog,
  openDeleteConfirm,
  onCopyToOtherPane,
  onOpenFileWith,
  onEditFile,
  onDownloadFile,
  onEditPermissions,
}) => {
  const { t } = useI18n();
  const callbacks = useSftpPaneCallbacks(side);

  const childrenCacheRef = useRef<Map<string, SftpFileEntry[]>>(new Map());
  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [errorPaths, setErrorPaths] = useState<Set<string>>(new Set());
  const lastClickedPathRef = useRef<string | null>(null);
  const flatVisibleNodesRef = useRef<{ entry: SftpFileEntry; parentPath: string }[]>([]);

  const toggleExpand = useCallback(async (entry: SftpFileEntry, entryPath: string) => {
    if (!isNavigableDirectory(entry)) return;
    if (expandedPaths.has(entryPath)) {
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
      const children = await onLoadChildren(entryPath);
      childrenCacheRef.current.set(entryPath, children);
      setExpandedPaths(prev => new Set(prev).add(entryPath));
    } catch {
      setErrorPaths(prev => new Set(prev).add(entryPath));
    } finally {
      setLoadingPaths(prev => { const s = new Set(prev); s.delete(entryPath); return s; });
      forceUpdate();
    }
  }, [expandedPaths, onLoadChildren]);

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
        callbacks.onRangeSelect(names);
      }
    } else if (e.ctrlKey || e.metaKey) {
      callbacks.onToggleSelection(entry.name, true);
    } else {
      callbacks.onToggleSelection(entry.name, false);
    }
    lastClickedPathRef.current = entryPath;
  }, [callbacks]);

  const renderNode = useCallback((entry: SftpFileEntry, entryPath: string, depth: number): React.ReactNode => {
    const isDir = isNavigableDirectory(entry);
    const isExpanded = expandedPaths.has(entryPath);
    const isLoading = loadingPaths.has(entryPath);
    const isSelected = pane.selectedFiles.has(entry.name);

    const currentPath = pane.connection?.currentPath ?? '';
    const sep = currentPath.includes('\\') ? '\\' : '/';
    const fullPath = currentPath === '/' || currentPath === ''
      ? `/${entry.name}`
      : `${currentPath.replace(/[/\\]+$/, '')}${sep}${entry.name}`;

    const icon = isDir
      ? (isExpanded
          ? <FolderOpen size={14} className="shrink-0 text-yellow-500" />
          : <Folder size={14} className="shrink-0 text-yellow-500" />)
      : getFileIcon(entry);

    return (
      <ContextMenu key={entryPath}>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              'flex items-center gap-1 px-2 py-[2px] cursor-pointer select-none hover:bg-accent/50 text-sm',
              isSelected && 'bg-accent text-accent-foreground',
            )}
            style={{ paddingLeft: depth * 16 + 8 }}
            onClick={e => handleNodeClick(entry, entryPath, e)}
            onDoubleClick={() => {
              if (isDir) {
                void toggleExpand(entry, entryPath);
              } else {
                onOpenEntry(entry);
              }
            }}
            draggable
            onDragStart={() => {
              const files = pane.selectedFiles.has(entry.name)
                ? Array.from(pane.selectedFiles).map(name => ({
                    name,
                    isDirectory: name === entry.name ? isDir : false,
                  }))
                : [{ name: entry.name, isDirectory: isDir }];
              onDragStart(files, side);
            }}
            onDragEnd={onDragEnd}
          >
            {/* Expand arrow */}
            <span className="shrink-0 w-4 flex items-center justify-center">
              {isDir ? (
                isLoading ? (
                  <Loader2 size={12} className="animate-spin text-muted-foreground" />
                ) : (
                  <ChevronRight
                    size={14}
                    className={cn('transition-transform text-muted-foreground', isExpanded && 'rotate-90')}
                    onClick={e => { e.stopPropagation(); void toggleExpand(entry, entryPath); }}
                  />
                )
              ) : null}
            </span>
            {/* File icon */}
            <span className="shrink-0">{icon}</span>
            {/* Name */}
            <span className="flex-1 truncate">{entry.name}</span>
            {/* Modified */}
            <span className="w-[140px] shrink-0 text-muted-foreground text-xs truncate">
              {formatDate(entry.lastModified)}
            </span>
            {/* Size */}
            <span className="w-[80px] shrink-0 text-right text-muted-foreground text-xs">
              {isDir ? '--' : formatBytes(entry.size ?? 0)}
            </span>
            {/* Kind */}
            <span className="w-[60px] shrink-0 text-right text-muted-foreground text-xs truncate">
              {isDir ? t('sftp.kind.folder') : (entry.name.split('.').pop()?.toUpperCase() ?? '--')}
            </span>
          </div>
        </ContextMenuTrigger>
        {entry.name !== '..' && (
          <ContextMenuContent>
            <ContextMenuItem onClick={() => {
              if (isDir) {
                void toggleExpand(entry, entryPath);
              } else {
                onOpenEntry(entry);
              }
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
            {onDownloadFile && (!isDir || !pane.connection?.isLocal) && (
              <ContextMenuItem onClick={() => onDownloadFile(entry)}>
                <Download size={14} className="mr-2" />{t('sftp.context.download')}
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => {
              const files = pane.selectedFiles.has(entry.name)
                ? Array.from(pane.selectedFiles)
                : [entry.name];
              const fileData = files.map(name => ({
                name,
                isDirectory: name === entry.name ? isDir : false,
              }));
              onCopyToOtherPane(fileData);
            }}>
              <Copy size={14} className="mr-2" />{t('sftp.context.copyToOtherPane')}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => navigator.clipboard.writeText(fullPath)}>
              <ClipboardCopy size={14} className="mr-2" />{t('sftp.context.copyPath')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => openRenameDialog(entry.name)}>
              <Pencil size={14} className="mr-2" />{t('common.rename')}
            </ContextMenuItem>
            {onEditPermissions && pane.connection && !pane.connection.isLocal && (
              <ContextMenuItem onClick={() => onEditPermissions(entry)}>
                <Shield size={14} className="mr-2" />{t('sftp.context.permissions')}
              </ContextMenuItem>
            )}
            <ContextMenuItem
              className="text-destructive"
              onClick={() => {
                const files = pane.selectedFiles.has(entry.name)
                  ? Array.from(pane.selectedFiles)
                  : [entry.name];
                openDeleteConfirm(files);
              }}
            >
              <Trash2 size={14} className="mr-2" />{t('action.delete')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => callbacks.onRefresh()}>
              <RefreshCw size={14} className="mr-2" />{t('common.refresh')}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => {
              const name = window.prompt(t('sftp.newFolder'));
              if (name) callbacks.onCreateDirectory(name).catch(() => {});
            }}>
              <FolderPlus size={14} className="mr-2" />{t('sftp.newFolder')}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => {
              const name = window.prompt(t('sftp.newFile'));
              if (name) callbacks.onCreateFile(name).catch(() => {});
            }}>
              <FilePlus size={14} className="mr-2" />{t('sftp.newFile')}
            </ContextMenuItem>
          </ContextMenuContent>
        )}
      </ContextMenu>
    );
  }, [
    expandedPaths, loadingPaths, pane.selectedFiles, pane.connection,
    handleNodeClick, toggleExpand, onOpenEntry, onDragStart, onDragEnd, side,
    onOpenFileWith, onEditFile, onDownloadFile, onEditPermissions,
    onCopyToOtherPane, openRenameDialog, openDeleteConfirm, callbacks, t,
  ]);

  const renderTree = useCallback((entries: SftpFileEntry[], parentPath: string, depth: number): React.ReactNode[] => {
    const nodes: React.ReactNode[] = [];
    for (const entry of entries) {
      const entryPath = joinPath(parentPath, entry.name);
      flatVisibleNodesRef.current.push({ entry, parentPath });
      nodes.push(renderNode(entry, entryPath, depth));
      if (isNavigableDirectory(entry) && expandedPaths.has(entryPath)) {
        if (loadingPaths.has(entryPath)) {
          nodes.push(
            <div
              key={`${entryPath}-loading`}
              style={{ paddingLeft: (depth + 1) * 16 + 8 }}
              className="py-1 text-xs text-muted-foreground flex items-center gap-1"
            >
              <Loader2 size={12} className="animate-spin" /> {t('sftp.tree.loading')}
            </div>
          );
        } else if (errorPaths.has(entryPath)) {
          nodes.push(
            <div
              key={`${entryPath}-error`}
              style={{ paddingLeft: (depth + 1) * 16 + 8 }}
              className="py-1 text-xs text-destructive flex items-center gap-1"
            >
              <AlertCircle size={12} /> {t('sftp.tree.loadError')}
            </div>
          );
        } else {
          const children = childrenCacheRef.current.get(entryPath) ?? [];
          nodes.push(...renderTree(children, entryPath, depth + 1));
        }
      }
    }
    return nodes;
  }, [expandedPaths, loadingPaths, errorPaths, renderNode, t]);

  // Reset flat visible nodes before each render
  flatVisibleNodesRef.current = [];

  const rootEntries = pane.files ?? [];
  const rootPath = pane.connection?.currentPath ?? '';
  const treeNodes = renderTree(rootEntries, rootPath, 0);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto text-sm">
      {/* Column header */}
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
