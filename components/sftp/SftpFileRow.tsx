/**
 * SFTP File row component for file list
 */

import { Folder, Link } from 'lucide-react';
import React, { memo, useCallback } from 'react';
import { cn } from '../../lib/utils';
import { SftpFileEntry } from '../../types';
import { buildSftpColumnTemplate, ColumnWidths, formatBytes, formatDate, getFileIcon, isNavigableDirectory } from './utils';

interface SftpFileRowProps {
    entry: SftpFileEntry;
    index: number;
    isSelected: boolean;
    showSelectionHighlight: boolean;
    isDragOver: boolean;
    columnWidths: ColumnWidths;
    onSelect: (entry: SftpFileEntry, index: number, e: React.MouseEvent) => void;
    onOpen: (entry: SftpFileEntry) => void;
    onDragStart: (entry: SftpFileEntry, e: React.DragEvent) => void;
    onDragEnd: () => void;
    onDragOver: (entry: SftpFileEntry, e: React.DragEvent) => void;
    onDragLeave: () => void;
    onDrop: (entry: SftpFileEntry, e: React.DragEvent) => void;
}

const SftpFileRowInner: React.FC<SftpFileRowProps> = ({
    entry,
    index,
    isSelected,
    showSelectionHighlight,
    isDragOver,
    columnWidths,
    onSelect,
    onOpen,
    onDragStart,
    onDragEnd,
    onDragOver,
    onDragLeave,
    onDrop,
}) => {
    const isParentDir = entry.name === '..';
    // A symlink pointing to a directory behaves like a directory (navigable, accepts drops)
    const isNavDir = isNavigableDirectory(entry);
    const isSymlinkToDirectory = entry.type === 'symlink' && entry.linkTarget === 'directory';
    const modifiedLabel = entry.lastModifiedFormatted || formatDate(entry.lastModified);
    const sizeLabel = entry.sizeFormatted || formatBytes(entry.size);
    const handleSelect = useCallback((e: React.MouseEvent) => {
        onSelect(entry, index, e);
    }, [entry, index, onSelect]);
    const handleOpen = useCallback(() => {
        onOpen(entry);
    }, [entry, onOpen]);
    const handleDragStart = useCallback((e: React.DragEvent) => {
        onDragStart(entry, e);
    }, [entry, onDragStart]);
    const handleDragOver = useCallback((e: React.DragEvent) => {
        onDragOver(entry, e);
    }, [entry, onDragOver]);
    const handleDrop = useCallback((e: React.DragEvent) => {
        onDrop(entry, e);
    }, [entry, onDrop]);
    const isSelectionVisible = isSelected && showSelectionHighlight;

    return (
        <div
            data-sftp-row="true"
            data-entry-name={entry.name}
            data-selected={isSelected ? "true" : "false"}
            draggable={!isParentDir}
            onDragStart={handleDragStart}
            onDragEnd={onDragEnd}
            onDragOver={handleDragOver}
            onDragLeave={onDragLeave}
            onDrop={handleDrop}
            onClick={handleSelect}
            onDoubleClick={handleOpen}
            className={cn(
                "px-4 py-2 items-center cursor-pointer text-sm hover:bg-accent/50",
                isSelectionVisible && "bg-accent text-accent-foreground",
                isDragOver && isNavDir && "bg-primary/25 ring-1 ring-primary/50"
            )}
            style={{ display: 'grid', gridTemplateColumns: buildSftpColumnTemplate(columnWidths) }}
        >
            <div className="flex items-center gap-3 min-w-0">
                <div className={cn(
                    "h-7 w-7 rounded flex items-center justify-center shrink-0 relative",
                    isSelectionVisible
                        ? "bg-accent-foreground/10 text-accent-foreground"
                        : isNavDir
                            ? "bg-primary/10 text-primary"
                            : "bg-secondary/60 text-muted-foreground"
                )}>
                    {isNavDir ? <Folder size={14} /> : getFileIcon(entry)}
                    {/* Show link indicator for symlinks */}
                    {entry.type === 'symlink' && (
                        <Link
                            size={8}
                            className={cn(
                                "absolute -bottom-0.5 -right-0.5",
                                isSelectionVisible ? "text-accent-foreground/80" : "text-muted-foreground",
                            )}
                            aria-hidden="true"
                        />
                    )}
                </div>
                <span
                    className={cn(
                        "truncate",
                        entry.type === 'symlink' && "italic pr-1",
                        isSelectionVisible && "font-medium",
                    )}
                    title={entry.name}
                >
                    {entry.name}
                    {entry.type === 'symlink' && <span className="sr-only"> (symbolic link)</span>}
                </span>
            </div>
            <span className={cn("text-xs truncate", isSelectionVisible ? "text-accent-foreground/85" : "text-muted-foreground")}>{modifiedLabel}</span>
            <span className={cn("text-xs truncate text-right", isSelectionVisible ? "text-accent-foreground/85" : "text-muted-foreground")}>
                {isNavDir ? '--' : sizeLabel}
            </span>
            <span className={cn("text-xs truncate capitalize text-right", isSelectionVisible ? "text-accent-foreground/85" : "text-muted-foreground")}>
                {isSymlinkToDirectory ? 'link → folder' : entry.type === 'directory' ? 'folder' : entry.type === 'symlink' ? 'link' : entry.name.split('.').pop()?.toLowerCase() || 'file'}
            </span>
        </div>
    );
};

const areEqual = (prev: SftpFileRowProps, next: SftpFileRowProps): boolean => {
    if (prev.index !== next.index) return false;
    if (prev.isSelected !== next.isSelected) return false;
    if (prev.isDragOver !== next.isDragOver) return false;
    if (prev.columnWidths.name !== next.columnWidths.name) return false;
    if (prev.columnWidths.modified !== next.columnWidths.modified) return false;
    if (prev.columnWidths.size !== next.columnWidths.size) return false;
    if (prev.columnWidths.type !== next.columnWidths.type) return false;
    // Compare callbacks - important for ".." entry which has static properties
    if (prev.onOpen !== next.onOpen) return false;
    if (prev.onSelect !== next.onSelect) return false;
    const prevEntry = prev.entry;
    const nextEntry = next.entry;
    return (
        prevEntry.name === nextEntry.name &&
        prevEntry.type === nextEntry.type &&
        prevEntry.size === nextEntry.size &&
        prevEntry.lastModified === nextEntry.lastModified &&
        prevEntry.linkTarget === nextEntry.linkTarget &&
        prevEntry.sizeFormatted === nextEntry.sizeFormatted &&
        prevEntry.lastModifiedFormatted === nextEntry.lastModifiedFormatted
    );
};

export const SftpFileRow = memo(SftpFileRowInner, areEqual);
SftpFileRow.displayName = 'SftpFileRow';
