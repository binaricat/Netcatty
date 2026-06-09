import React from 'react';
import { ChevronRight, CornerUpLeft, Folder, FolderOpen, Loader2 } from 'lucide-react';
import type { SftpFileEntry } from '../../types';
import { formatBytes, formatDate, getFileIcon, isNavigableDirectory } from './utils';
import { useI18n } from '../../application/i18n/I18nProvider';
import { cn } from '../../lib/utils';

export type NodeDescriptor =
  | { type: 'node'; entry: SftpFileEntry; entryPath: string; depth: number; isExpanded: boolean; isLoading: boolean }
  | { type: 'loading' | 'error'; key: string; depth: number };

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
  onDragStart: (entry: SftpFileEntry, entryPath: string, isDir: boolean, e: React.DragEvent) => void;
  onDragEnd: () => void;
  onDragOverEntry: (entryPath: string, e: React.DragEvent) => void;
  onDropEntry: (entryPath: string, e: React.DragEvent) => void;
  onDragLeaveEntry: () => void;
  onContextMenu: (entry: SftpFileEntry, entryPath: string, e: React.MouseEvent) => void;
}

export const TREE_ROW_HEIGHT = 28;

export const TreeNode = React.memo<TreeNodeProps>(({
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
      data-section="terminal-sftp-tree-row"
      data-entry-name={entry.name}
      data-entry-type={isDir ? 'directory' : entry.type}
      data-selected={isSelected ? 'true' : 'false'}
      data-expanded={isDir ? (isExpanded ? 'true' : 'false') : undefined}
      data-drag-over={isDragOver ? 'true' : 'false'}
      className={cn(
        'grid items-center gap-x-1 px-2 cursor-pointer select-none text-sm',
        isSelected
          ? 'bg-accent text-accent-foreground hover:bg-accent'
          : 'hover:bg-accent/50',
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
      onDragStart={e => { if (!isParentEntry) onDragStart(entry, entryPath, isDir, e); }}
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
