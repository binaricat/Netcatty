import React, { useMemo } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { TreeNode, TREE_ROW_HEIGHT } from './SftpPaneTreeNode';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SftpPaneTreeRowsProps = Record<string, any>;

export function useSftpPaneTreeRows(props: SftpPaneTreeRowsProps) {
  const {
    nodeDescriptors, scrollTop, viewportHeight, tRef, columnTemplate, selectedPaths, dragOverNodePath,
    toggleExpand, handleNodeClick, stableOnOpenEntry, stableOnDragStart, stableOnDragEnd,
    handleNodeDragOver, handleNodeDrop, handleNodeDragLeave, handleNodeContextMenu,
  } = props;

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
    tRef,
  ]);

  return { totalHeight, treeRows, visibleRange };
}
