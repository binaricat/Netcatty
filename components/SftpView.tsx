import React, { useMemo, useState, useCallback, useRef, useEffect, memo } from 'react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { cn } from '../lib/utils';
import { Host, SSHKey, SftpFileEntry, TransferTask } from '../types';
import { DistroAvatar } from './DistroAvatar';
import { useSftpState, SftpPane } from '../application/state/useSftpState';
import { useIsSftpActive } from '../application/state/activeTabStore';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from './ui/context-menu';

// Format bytes with appropriate unit (B, KB, MB, GB)
const formatBytes = (bytes: number | string): string => {
    const numBytes = typeof bytes === 'string' ? parseInt(bytes, 10) : bytes;
    if (isNaN(numBytes) || numBytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(numBytes) / Math.log(1024));
    const size = numBytes / Math.pow(1024, i);
    return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

// Format date as YYYY-MM-DD HH:mm:ss in local timezone
const formatDate = (timestamp: number | undefined): string => {
    if (!timestamp) return '--';
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return '--';
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

// Sort configuration types
type SortField = 'name' | 'size' | 'modified' | 'type';
type SortOrder = 'asc' | 'desc';

import {
    FileCode,
    Folder,
    HardDrive,
    Monitor,
    Plus,
    X,
    RefreshCw,
    ChevronLeft,
    ChevronRight,
    ArrowDown,
    Loader2,
    AlertCircle,
    CheckCircle2,
    XCircle,
    Trash2,
    Download,
    Upload,
    FolderPlus,
    Pencil,
    Copy,
    ChevronDown,
    Home,
    Search,
    Shield,
    FileText,
    FileImage,
    FileVideo,
    FileAudio,
    FileArchive,
    FileSpreadsheet,
    FileType,
    File,
    Terminal,
    Settings,
    Database,
    Globe,
    Lock,
    Key,
} from 'lucide-react';

// Comprehensive file icon helper
const getFileIcon = (entry: SftpFileEntry) => {
    if (entry.type === 'directory') return <Folder size={14} />;

    const ext = entry.name.split('.').pop()?.toLowerCase() || '';

    // Documents
    if (['doc', 'docx', 'rtf', 'odt'].includes(ext))
        return <FileText size={14} className="text-blue-500" />;
    if (['xls', 'xlsx', 'csv', 'ods'].includes(ext))
        return <FileSpreadsheet size={14} className="text-green-500" />;
    if (['ppt', 'pptx', 'odp'].includes(ext))
        return <FileType size={14} className="text-orange-500" />;
    if (['pdf'].includes(ext))
        return <FileText size={14} className="text-red-500" />;

    // Code/Scripts
    if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'].includes(ext))
        return <FileCode size={14} className="text-yellow-500" />;
    if (['py', 'pyc', 'pyw'].includes(ext))
        return <FileCode size={14} className="text-blue-400" />;
    if (['sh', 'bash', 'zsh', 'fish', 'bat', 'cmd', 'ps1'].includes(ext))
        return <Terminal size={14} className="text-green-400" />;
    if (['c', 'cpp', 'h', 'hpp', 'cc', 'cxx'].includes(ext))
        return <FileCode size={14} className="text-blue-600" />;
    if (['java', 'class', 'jar'].includes(ext))
        return <FileCode size={14} className="text-orange-600" />;
    if (['go'].includes(ext))
        return <FileCode size={14} className="text-cyan-500" />;
    if (['rs'].includes(ext))
        return <FileCode size={14} className="text-orange-400" />;
    if (['rb'].includes(ext))
        return <FileCode size={14} className="text-red-400" />;
    if (['php'].includes(ext))
        return <FileCode size={14} className="text-purple-500" />;
    if (['html', 'htm', 'xhtml'].includes(ext))
        return <Globe size={14} className="text-orange-500" />;
    if (['css', 'scss', 'sass', 'less'].includes(ext))
        return <FileCode size={14} className="text-blue-500" />;
    if (['vue', 'svelte'].includes(ext))
        return <FileCode size={14} className="text-green-500" />;

    // Config/Data
    if (['json', 'json5'].includes(ext))
        return <FileCode size={14} className="text-yellow-600" />;
    if (['xml', 'xsl', 'xslt'].includes(ext))
        return <FileCode size={14} className="text-orange-400" />;
    if (['yml', 'yaml'].includes(ext))
        return <Settings size={14} className="text-pink-400" />;
    if (['toml', 'ini', 'conf', 'cfg', 'config'].includes(ext))
        return <Settings size={14} className="text-gray-400" />;
    if (['env'].includes(ext))
        return <Lock size={14} className="text-yellow-500" />;
    if (['sql', 'sqlite', 'db'].includes(ext))
        return <Database size={14} className="text-blue-400" />;

    // Images
    if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tiff', 'tif', 'heic', 'heif', 'avif'].includes(ext))
        return <FileImage size={14} className="text-purple-400" />;

    // Videos
    if (['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', '3gp', 'mpeg', 'mpg'].includes(ext))
        return <FileVideo size={14} className="text-pink-500" />;

    // Audio
    if (['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus', 'aiff'].includes(ext))
        return <FileAudio size={14} className="text-green-400" />;

    // Archives
    if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz', 'tbz2', 'lz', 'lzma', 'cab', 'iso', 'dmg'].includes(ext))
        return <FileArchive size={14} className="text-amber-500" />;

    // Executables
    if (['exe', 'msi', 'app', 'deb', 'rpm', 'apk', 'ipa'].includes(ext))
        return <File size={14} className="text-red-400" />;
    if (['dll', 'so', 'dylib'].includes(ext))
        return <File size={14} className="text-gray-500" />;

    // Keys/Certs
    if (['pem', 'crt', 'cer', 'key', 'pub', 'ppk'].includes(ext))
        return <Key size={14} className="text-yellow-400" />;

    // Text/Markdown
    if (['md', 'markdown', 'mdx'].includes(ext))
        return <FileText size={14} className="text-gray-400" />;
    if (['txt', 'log', 'text'].includes(ext))
        return <FileText size={14} className="text-muted-foreground" />;

    // Default
    return <FileCode size={14} />;
};

// Breadcrumb component
const BreadcrumbInner: React.FC<{
    path: string;
    onNavigate: (path: string) => void;
    onHome: () => void;
}> = ({ path, onNavigate, onHome }) => {
    // Handle both Windows (C:\path) and Unix (/path) style paths
    const isWindowsPath = /^[A-Za-z]:/.test(path);
    const separator = isWindowsPath ? /[\\/]/ : /\//;
    const parts = path.split(separator).filter(Boolean);

    // For Windows, first part might be drive letter like "C:"
    const buildPath = (index: number) => {
        if (isWindowsPath) {
            return parts.slice(0, index + 1).join('\\');
        }
        return '/' + parts.slice(0, index + 1).join('/');
    };

    return (
        <div className="flex items-center gap-1 text-xs text-muted-foreground overflow-x-auto scrollbar-none">
            <button
                onClick={onHome}
                className="hover:text-foreground p-1 rounded hover:bg-secondary/60 shrink-0"
                title="Go to home"
            >
                <Home size={12} />
            </button>
            <ChevronRight size={12} className="opacity-40 shrink-0" />
            {parts.map((part, idx) => {
                const partPath = buildPath(idx);
                const isLast = idx === parts.length - 1;
                return (
                    <React.Fragment key={partPath}>
                        <button
                            onClick={() => onNavigate(partPath)}
                            className={cn(
                                "hover:text-foreground px-1 py-0.5 rounded hover:bg-secondary/60 truncate max-w-[120px]",
                                isLast && "text-foreground font-medium"
                            )}
                        >
                            {part}
                        </button>
                        {!isLast && <ChevronRight size={12} className="opacity-40 shrink-0" />}
                    </React.Fragment>
                );
            })}
        </div>
    );
};

const Breadcrumb = memo(BreadcrumbInner);
Breadcrumb.displayName = 'Breadcrumb';

// Column widths type
interface ColumnWidths {
    name: number;
    modified: number;
    size: number;
    type: number;
}

// File row component
const FileRowInner: React.FC<{
    entry: SftpFileEntry;
    isSelected: boolean;
    isDragOver: boolean;
    columnWidths: ColumnWidths;
    onSelect: (e: React.MouseEvent) => void;
    onOpen: () => void;
    onDragStart: (e: React.DragEvent) => void;
    onDragEnd: () => void;
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: () => void;
    onDrop: (e: React.DragEvent) => void;
}> = ({ entry, isSelected, isDragOver, columnWidths, onSelect, onOpen, onDragStart, onDragEnd, onDragOver, onDragLeave, onDrop }) => {
    const isParentDir = entry.name === '..';

    return (
        <div
            draggable={!isParentDir}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            onClick={onSelect}
            onDoubleClick={onOpen}
            className={cn(
                "px-4 py-2 items-center cursor-pointer text-sm transition-colors",
                isSelected ? "bg-primary/15 text-foreground" : "hover:bg-secondary/40",
                isDragOver && entry.type === 'directory' && "bg-primary/25 ring-1 ring-primary/50"
            )}
            style={{ display: 'grid', gridTemplateColumns: `${columnWidths.name}% ${columnWidths.modified}% ${columnWidths.size}% ${columnWidths.type}%` }}
        >
            <div className="flex items-center gap-3 min-w-0">
                <div className={cn(
                    "h-7 w-7 rounded flex items-center justify-center shrink-0",
                    entry.type === 'directory' ? "bg-primary/10 text-primary" : "bg-secondary/60 text-muted-foreground"
                )}>
                    {entry.type === 'directory' ? <Folder size={14} /> : getFileIcon(entry)}
                </div>
                <span className="truncate">{entry.name}</span>
            </div>
            <span className="text-xs text-muted-foreground truncate">{formatDate(entry.lastModified)}</span>
            <span className="text-xs text-muted-foreground truncate text-right">
                {entry.type === 'directory' ? '--' : formatBytes(entry.size)}
            </span>
            <span className="text-xs text-muted-foreground truncate capitalize text-right">
                {entry.type === 'directory' ? 'folder' : entry.name.split('.').pop()?.toLowerCase() || 'file'}
            </span>
        </div>
    );
};

// Memoized FileRow
const FileRow = memo(FileRowInner);
FileRow.displayName = 'FileRow';

// Helper to format bytes for transfer display
const formatTransferBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const size = bytes / Math.pow(1024, i);
    return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

// Transfer item component
const TransferItemInner: React.FC<{
    task: TransferTask;
    onCancel: () => void;
    onRetry: () => void;
    onDismiss: () => void;
}> = ({ task, onCancel, onRetry, onDismiss }) => {
    const progress = task.totalBytes > 0 ? Math.min((task.transferredBytes / task.totalBytes) * 100, 100) : 0;

    // Format speed with appropriate unit
    const formatSpeed = (bytesPerSecond: number): string => {
        if (bytesPerSecond <= 0) return '';
        if (bytesPerSecond >= 1024 * 1024) {
            return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
        }
        return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
    };
    const speedFormatted = formatSpeed(task.speed);

    const remainingBytes = task.totalBytes - task.transferredBytes;
    const remainingTime = task.speed > 0
        ? Math.ceil(remainingBytes / task.speed)
        : 0;
    const remainingFormatted = remainingTime > 60
        ? `~${Math.ceil(remainingTime / 60)}m left`
        : remainingTime > 0
            ? `~${remainingTime}s left`
            : '';

    // Format bytes transferred / total
    const bytesDisplay = task.status === 'transferring' && task.totalBytes > 0
        ? `${formatTransferBytes(task.transferredBytes)} / ${formatTransferBytes(task.totalBytes)}`
        : task.status === 'completed' && task.totalBytes > 0
            ? formatTransferBytes(task.totalBytes)
            : '';

    return (
        <div className="flex items-center gap-3 px-4 py-2.5 bg-background/60 border-t border-border/40 backdrop-blur-sm">
            <div className="h-6 w-6 rounded flex items-center justify-center shrink-0">
                {task.status === 'transferring' && <Loader2 size={14} className="animate-spin text-primary" />}
                {task.status === 'pending' && <ArrowDown size={14} className="text-muted-foreground animate-bounce" />}
                {task.status === 'completed' && <CheckCircle2 size={14} className="text-green-500" />}
                {task.status === 'failed' && <XCircle size={14} className="text-destructive" />}
                {task.status === 'cancelled' && <XCircle size={14} className="text-muted-foreground" />}
            </div>

            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                    <span className="text-sm truncate font-medium">{task.fileName}</span>
                    {task.status === 'transferring' && speedFormatted && (
                        <span className="text-xs text-primary/80 font-mono">{speedFormatted}</span>
                    )}
                    {task.status === 'transferring' && remainingFormatted && (
                        <span className="text-xs text-muted-foreground">{remainingFormatted}</span>
                    )}
                </div>
                {(task.status === 'transferring' || task.status === 'pending') && (
                    <div className="flex items-center gap-2 mt-1.5">
                        <div className="flex-1 h-2 bg-secondary/80 rounded-full overflow-hidden">
                            <div
                                className={cn(
                                    "h-full rounded-full relative overflow-hidden",
                                    task.status === 'pending'
                                        ? "bg-muted-foreground/50 animate-pulse"
                                        : "bg-gradient-to-r from-primary via-primary/90 to-primary"
                                )}
                                style={{
                                    width: task.status === 'pending' ? '100%' : `${progress}%`,
                                    transition: 'width 150ms ease-out'
                                }}
                            >
                                {/* Animated shine effect */}
                                {task.status === 'transferring' && (
                                    <div
                                        className="absolute inset-0 w-1/2 h-full"
                                        style={{
                                            background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.4) 50%, transparent 100%)',
                                            animation: 'progress-shimmer 1.5s ease-in-out infinite',
                                        }}
                                    />
                                )}
                            </div>
                        </div>
                        <span className="text-[11px] text-muted-foreground shrink-0 min-w-[40px] text-right font-mono">
                            {task.status === 'pending' ? 'waiting...' : `${Math.round(progress)}%`}
                        </span>
                    </div>
                )}
                {task.status === 'transferring' && bytesDisplay && (
                    <div className="text-[10px] text-muted-foreground mt-0.5 font-mono">
                        {bytesDisplay}
                    </div>
                )}
                {task.status === 'completed' && bytesDisplay && (
                    <div className="text-[10px] text-green-600 mt-0.5">
                        Completed • {bytesDisplay}
                    </div>
                )}
                {task.status === 'failed' && task.error && (
                    <span className="text-xs text-destructive">{task.error}</span>
                )}
            </div>

            <div className="flex items-center gap-1 shrink-0">
                {task.status === 'failed' && (
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onRetry} title="Retry">
                        <RefreshCw size={12} />
                    </Button>
                )}
                {(task.status === 'pending' || task.status === 'transferring') && (
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={onCancel} title="Cancel">
                        <X size={12} />
                    </Button>
                )}
                {(task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') && (
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onDismiss} title="Dismiss">
                        <X size={12} />
                    </Button>
                )}
            </div>
        </div>
    );
};

// Memoized TransferItem
const TransferItem = memo(TransferItemInner);
TransferItem.displayName = 'TransferItem';

// SFTP Pane component
interface SftpPaneViewProps {
    side: 'left' | 'right';
    pane: SftpPane;
    hosts: Host[];
    filteredFiles: SftpFileEntry[];
    onConnect: (host: Host | 'local') => void;
    onDisconnect: () => void;
    onNavigateTo: (path: string) => void;
    onNavigateUp: () => void;
    onRefresh: () => void;
    onOpenEntry: (entry: SftpFileEntry) => void;
    onToggleSelection: (fileName: string, multiSelect: boolean) => void;
    onRangeSelect: (fileNames: string[]) => void;
    onClearSelection: () => void;
    onSetFilter: (filter: string) => void;
    onCreateDirectory: (name: string) => Promise<void>;
    onDeleteFiles: (fileNames: string[]) => Promise<void>;
    onRenameFile: (oldName: string, newName: string) => Promise<void>;
    onCopyToOtherPane: (files: { name: string; isDirectory: boolean }[]) => void;
    onReceiveFromOtherPane: (files: { name: string; isDirectory: boolean }[]) => void;
    onEditPermissions?: (file: SftpFileEntry) => void;
    draggedFiles: { name: string; isDirectory: boolean; side: 'left' | 'right' }[] | null;
    onDragStart: (files: { name: string; isDirectory: boolean }[], side: 'left' | 'right') => void;
    onDragEnd: () => void;
}

const SftpPaneViewInner: React.FC<SftpPaneViewProps> = ({
    side,
    pane,
    hosts,
    filteredFiles,
    onConnect,
    onDisconnect,
    onNavigateTo,
    onNavigateUp,
    onRefresh,
    onOpenEntry,
    onToggleSelection,
    onRangeSelect,
    onClearSelection,
    onSetFilter,
    onCreateDirectory,
    onDeleteFiles,
    onRenameFile,
    onCopyToOtherPane,
    onReceiveFromOtherPane,
    onEditPermissions,
    draggedFiles,
    onDragStart,
    onDragEnd,
}) => {
    const [showHostPicker, setShowHostPicker] = useState(false);
    const [hostSearch, setHostSearch] = useState('');
    const [showNewFolderDialog, setShowNewFolderDialog] = useState(false);
    const [newFolderName, setNewFolderName] = useState('');
    const [showRenameDialog, setShowRenameDialog] = useState(false);
    const [renameTarget, setRenameTarget] = useState<string | null>(null);
    const [renameName, setRenameName] = useState('');
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [deleteTargets, setDeleteTargets] = useState<string[]>([]);
    const [dragOverEntry, setDragOverEntry] = useState<string | null>(null);
    const [isDragOverPane, setIsDragOverPane] = useState(false);
    const fileListRef = useRef<HTMLDivElement>(null);
    const lastSelectedIndexRef = useRef<number | null>(null);

    // Sorting state
    const [sortField, setSortField] = useState<SortField>('name');
    const [sortOrder, setSortOrder] = useState<SortOrder>('asc');

    // Column widths (percentages)
    const [columnWidths, setColumnWidths] = useState<ColumnWidths>({ name: 45, modified: 25, size: 15, type: 15 });
    const resizingRef = useRef<{ field: keyof ColumnWidths; startX: number; startWidth: number } | null>(null);

    // Editable path state
    const [isEditingPath, setIsEditingPath] = useState(false);
    const [editingPathValue, setEditingPathValue] = useState('');
    const [showPathSuggestions, setShowPathSuggestions] = useState(false);
    const [pathSuggestionIndex, setPathSuggestionIndex] = useState(-1);
    const pathInputRef = useRef<HTMLInputElement>(null);
    const pathDropdownRef = useRef<HTMLDivElement>(null);

    // Path suggestions: combine current directory subfolders with recently visited paths
    const pathSuggestions = useMemo(() => {
        if (!isEditingPath || !pane.connection) return [];

        const currentValue = editingPathValue.trim().toLowerCase();
        const suggestions: { path: string; type: 'folder' | 'history' }[] = [];

        // Add current subdirectories as suggestions
        const folders = filteredFiles.filter(f => f.type === 'directory' && f.name !== '..');
        folders.forEach(f => {
            const fullPath = pane.connection?.currentPath === '/'
                ? `/${f.name}`
                : `${pane.connection?.currentPath}/${f.name}`;
            if (!currentValue || fullPath.toLowerCase().includes(currentValue) || f.name.toLowerCase().includes(currentValue)) {
                suggestions.push({ path: fullPath, type: 'folder' });
            }
        });

        // Common quick paths
        const quickPaths = ['/home', '/var', '/etc', '/tmp', '/usr', '/opt', '/root'];
        quickPaths.forEach(qp => {
            if (!currentValue || qp.toLowerCase().includes(currentValue)) {
                if (!suggestions.some(s => s.path === qp)) {
                    suggestions.push({ path: qp, type: 'history' });
                }
            }
        });

        return suggestions.slice(0, 8); // Limit to 8 suggestions
    }, [isEditingPath, editingPathValue, filteredFiles, pane.connection]);

    const filteredHosts = useMemo(() => {
        const term = hostSearch.trim().toLowerCase();
        return hosts.filter(h =>
            !term ||
            h.label.toLowerCase().includes(term) ||
            h.hostname.toLowerCase().includes(term)
        ).sort((a, b) => a.label.localeCompare(b.label));
    }, [hosts, hostSearch]);

    // Add parent entry if not at root
    const displayFiles = useMemo(() => {
        if (!pane.connection) return [];
        if (pane.connection.currentPath === '/') return filteredFiles;
        const parentEntry: SftpFileEntry = {
            name: '..',
            type: 'directory',
            size: 0,
            sizeFormatted: '--',
            lastModified: 0,
            lastModifiedFormatted: '--',
        };
        return [parentEntry, ...filteredFiles.filter(f => f.name !== '..')];
    }, [pane.connection, filteredFiles]);

    // Sorted files
    const sortedDisplayFiles = useMemo(() => {
        if (!displayFiles.length) return displayFiles;

        // Separate parent entry (..) from the rest
        const parentEntry = displayFiles.find(f => f.name === '..');
        const otherFiles = displayFiles.filter(f => f.name !== '..');

        const sorted = [...otherFiles].sort((a, b) => {
            // Directories always first (except when sorting by type)
            if (sortField !== 'type') {
                if (a.type === 'directory' && b.type !== 'directory') return -1;
                if (a.type !== 'directory' && b.type === 'directory') return 1;
            }

            let cmp = 0;
            switch (sortField) {
                case 'name':
                    cmp = a.name.localeCompare(b.name);
                    break;
                case 'size':
                    cmp = (a.size || 0) - (b.size || 0);
                    break;
                case 'modified':
                    cmp = (a.lastModified || 0) - (b.lastModified || 0);
                    break;
                case 'type':
                    const extA = a.type === 'directory' ? 'folder' : a.name.split('.').pop()?.toLowerCase() || '';
                    const extB = b.type === 'directory' ? 'folder' : b.name.split('.').pop()?.toLowerCase() || '';
                    cmp = extA.localeCompare(extB);
                    break;
            }
            return sortOrder === 'asc' ? cmp : -cmp;
        });

        return parentEntry ? [parentEntry, ...sorted] : sorted;
    }, [displayFiles, sortField, sortOrder]);

    const handleSort = (field: SortField) => {
        if (sortField === field) {
            setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc');
        } else {
            setSortField(field);
            setSortOrder('asc');
        }
    };

    // Column resize handlers
    const handleResizeStart = (field: keyof ColumnWidths, e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        resizingRef.current = { field, startX: e.clientX, startWidth: columnWidths[field] };
        document.addEventListener('mousemove', handleResizeMove);
        document.addEventListener('mouseup', handleResizeEnd);
    };

    const handleResizeMove = useCallback((e: MouseEvent) => {
        if (!resizingRef.current) return;
        const diff = e.clientX - resizingRef.current.startX;
        const newWidth = Math.max(10, Math.min(60, resizingRef.current.startWidth + diff / 5));
        setColumnWidths(prev => ({ ...prev, [resizingRef.current!.field]: newWidth }));
    }, []);

    const handleResizeEnd = useCallback(() => {
        resizingRef.current = null;
        document.removeEventListener('mousemove', handleResizeMove);
        document.removeEventListener('mouseup', handleResizeEnd);
    }, [handleResizeMove]);

    // Path editing handlers
    const handlePathDoubleClick = () => {
        if (!pane.connection) return;
        setEditingPathValue(pane.connection.currentPath);
        setIsEditingPath(true);
        setShowPathSuggestions(true);
        setPathSuggestionIndex(-1);
        setTimeout(() => pathInputRef.current?.select(), 0);
    };

    const handlePathSubmit = (pathOverride?: string) => {
        const newPath = (pathOverride ?? editingPathValue).trim() || '/';
        setIsEditingPath(false);
        setShowPathSuggestions(false);
        setPathSuggestionIndex(-1);
        if (pane.connection && newPath !== pane.connection.currentPath) {
            onNavigateTo(newPath.startsWith('/') ? newPath : `/${newPath}`);
        }
    };

    const handlePathKeyDown = (e: React.KeyboardEvent) => {
        if (showPathSuggestions && pathSuggestions.length > 0) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setPathSuggestionIndex(prev =>
                    prev < pathSuggestions.length - 1 ? prev + 1 : 0
                );
                return;
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setPathSuggestionIndex(prev =>
                    prev > 0 ? prev - 1 : pathSuggestions.length - 1
                );
                return;
            } else if (e.key === 'Tab' && pathSuggestionIndex >= 0) {
                e.preventDefault();
                setEditingPathValue(pathSuggestions[pathSuggestionIndex].path);
                return;
            }
        }
        if (e.key === 'Enter') {
            if (pathSuggestionIndex >= 0 && pathSuggestions[pathSuggestionIndex]) {
                handlePathSubmit(pathSuggestions[pathSuggestionIndex].path);
            } else {
                handlePathSubmit();
            }
        } else if (e.key === 'Escape') {
            setIsEditingPath(false);
            setShowPathSuggestions(false);
            setPathSuggestionIndex(-1);
        }
    };

    const handlePathChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setEditingPathValue(e.target.value);
        setShowPathSuggestions(true);
        setPathSuggestionIndex(-1);
    };

    const handlePathBlur = (e: React.FocusEvent) => {
        // Delay to allow click on suggestion
        setTimeout(() => {
            if (!pathDropdownRef.current?.contains(document.activeElement)) {
                handlePathSubmit();
            }
        }, 150);
    };

    const selectPathSuggestion = (path: string) => {
        setEditingPathValue(path);
        handlePathSubmit(path);
    };

    const handleCreateFolder = async () => {
        if (!newFolderName.trim()) return;
        try {
            await onCreateDirectory(newFolderName.trim());
            setShowNewFolderDialog(false);
            setNewFolderName('');
        } catch (err) {
            // Error handling
        }
    };

    const handleRename = async () => {
        if (!renameTarget || !renameName.trim()) return;
        try {
            await onRenameFile(renameTarget, renameName.trim());
            setShowRenameDialog(false);
            setRenameTarget(null);
            setRenameName('');
        } catch (err) {
            // Error handling
        }
    };

    const handleDelete = async () => {
        if (deleteTargets.length === 0) return;
        try {
            await onDeleteFiles(deleteTargets);
            setShowDeleteConfirm(false);
            setDeleteTargets([]);
            onClearSelection();
        } catch (err) {
            // Error handling
        }
    };

    const handlePaneDragOver = (e: React.DragEvent) => {
        if (!draggedFiles || draggedFiles[0]?.side === side) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setIsDragOverPane(true);
    };

    // Track the pane container ref for proper drag leave detection
    const paneContainerRef = useRef<HTMLDivElement>(null);

    const handlePaneDragLeave = (e: React.DragEvent) => {
        // Only set isDragOverPane to false when actually leaving the pane container
        // Check if the related target is outside of our pane container
        const relatedTarget = e.relatedTarget as Node | null;
        if (relatedTarget && paneContainerRef.current?.contains(relatedTarget)) {
            // Still inside the pane, don't clear drag state
            return;
        }
        setIsDragOverPane(false);
        setDragOverEntry(null);
    };

    const handlePaneDrop = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragOverPane(false);
        setDragOverEntry(null);

        if (!draggedFiles || draggedFiles[0]?.side === side) return;
        // Files are being dropped ON this pane FROM the other pane
        // Transfer to current directory
        onReceiveFromOtherPane(draggedFiles.map(f => ({ name: f.name, isDirectory: f.isDirectory })));
    };

    const handleFileDragStart = (entry: SftpFileEntry, e: React.DragEvent) => {
        if (entry.name === '..') {
            e.preventDefault();
            return;
        }

        const selectedNames = Array.from(pane.selectedFiles);
        const files = selectedNames.includes(entry.name)
            ? sortedDisplayFiles.filter(f => selectedNames.includes(f.name)).map(f => ({
                name: f.name,
                isDirectory: f.type === 'directory',
                side,
            }))
            : [{ name: entry.name, isDirectory: entry.type === 'directory', side }];

        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('text/plain', files.map(f => f.name).join('\n'));
        onDragStart(files, side);
    };

    const handleEntryDragOver = (entry: SftpFileEntry, e: React.DragEvent) => {
        if (!draggedFiles || draggedFiles[0]?.side === side) return;
        // Highlight directories as potential drop targets
        if (entry.type === 'directory' && entry.name !== '..') {
            e.preventDefault();
            e.stopPropagation();
            setDragOverEntry(entry.name);
        }
    };

    const handleEntryDrop = (entry: SftpFileEntry, e: React.DragEvent) => {
        // Only handle drop on directories, otherwise let it bubble to pane drop handler
        if (!draggedFiles || draggedFiles[0]?.side === side) return;

        if (entry.type === 'directory' && entry.name !== '..') {
            e.preventDefault();
            e.stopPropagation();
            setDragOverEntry(null);
            setIsDragOverPane(false);
            // Files dropped ON a directory - transfer to that directory
            // TODO: transfer into the target directory instead of current directory
            onReceiveFromOtherPane(draggedFiles.map(f => ({ name: f.name, isDirectory: f.isDirectory })));
        }
        // For non-directory entries, let the event bubble up to pane drop handler
    };

    const openRenameDialog = (name: string) => {
        setRenameTarget(name);
        setRenameName(name);
        setShowRenameDialog(true);
    };

    const openDeleteConfirm = (names: string[]) => {
        setDeleteTargets(names);
        setShowDeleteConfirm(true);
    };

    if (!pane.connection) {
        return (
            <div className="absolute inset-0 flex flex-col">
                <div className="h-12 px-4 border-b border-border/60 flex items-center gap-3 shrink-0">
                    <div className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
                        {side === 'left' ? <Monitor size={14} /> : <HardDrive size={14} />}
                        <span>{side === 'left' ? 'Local' : 'Remote'}</span>
                    </div>
                    <Button variant="outline" size="sm" className="h-8 px-3" onClick={() => setShowHostPicker(true)}>
                        <Plus size={14} className="mr-2" /> Select host
                    </Button>
                </div>

                <div className="flex-1 flex flex-col items-center justify-center text-center gap-4 p-6">
                    <div className="h-14 w-14 rounded-xl bg-secondary/60 text-primary flex items-center justify-center">
                        {side === 'left' ? <Monitor size={24} /> : <HardDrive size={24} />}
                    </div>
                    <div>
                        <div className="text-sm font-semibold mb-1">Select a host to start</div>
                        <div className="text-xs text-muted-foreground">
                            Choose a local or remote filesystem to browse
                        </div>
                    </div>
                    <Button onClick={() => setShowHostPicker(true)}>
                        <Plus size={14} className="mr-2" /> Select host
                    </Button>
                </div>

                {/* Host picker dialog */}
                <Dialog open={showHostPicker} onOpenChange={setShowHostPicker}>
                    <DialogContent className="max-w-md">
                        <DialogHeader>
                            <DialogTitle>Select Host</DialogTitle>
                            <DialogDescription>
                                Pick a host for the {side} pane
                            </DialogDescription>
                        </DialogHeader>
                        <div className="space-y-3">
                            <Input
                                value={hostSearch}
                                onChange={e => setHostSearch(e.target.value)}
                                placeholder="Search hosts..."
                                className="h-9"
                            />

                            {/* Local option */}
                            <div
                                className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-border/70 bg-secondary/30 cursor-pointer hover:border-primary/50 hover:bg-secondary/50 transition-colors"
                                onClick={() => { onConnect('local'); setShowHostPicker(false); }}
                            >
                                <div className="flex items-center gap-3">
                                    <div className="h-9 w-9 rounded-lg bg-primary/10 border border-primary/30 flex items-center justify-center text-primary">
                                        <Monitor size={16} />
                                    </div>
                                    <div>
                                        <div className="text-sm font-medium">Local filesystem</div>
                                        <div className="text-xs text-muted-foreground">Browse local files</div>
                                    </div>
                                </div>
                                <Badge variant="outline" className="text-[10px]">Local</Badge>
                            </div>

                            {/* Remote hosts */}
                            <div className="max-h-64 overflow-auto space-y-2">
                                {filteredHosts.map(host => (
                                    <div
                                        key={host.id}
                                        className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-border/70 bg-secondary/30 cursor-pointer hover:border-primary/50 hover:bg-secondary/50 transition-colors"
                                        onClick={() => { onConnect(host); setShowHostPicker(false); }}
                                    >
                                        <div className="flex items-center gap-3 min-w-0">
                                            <DistroAvatar host={host} fallback={host.label[0].toUpperCase()} className="h-9 w-9" />
                                            <div className="min-w-0">
                                                <div className="text-sm font-medium truncate">{host.label}</div>
                                                <div className="text-xs text-muted-foreground truncate">
                                                    {host.username}@{host.hostname}
                                                </div>
                                            </div>
                                        </div>
                                        <Badge variant="secondary" className="text-[10px] bg-primary/10 text-primary border-primary/30">
                                            SSH
                                        </Badge>
                                    </div>
                                ))}
                                {filteredHosts.length === 0 && (
                                    <div className="text-xs text-muted-foreground text-center py-6 border border-dashed border-border/60 rounded-lg">
                                        No matching hosts
                                    </div>
                                )}
                            </div>
                        </div>
                    </DialogContent>
                </Dialog>
            </div>
        );
    }

    return (
        <div
            ref={paneContainerRef}
            className={cn(
                "absolute inset-0 flex flex-col transition-colors",
                isDragOverPane && "bg-primary/5"
            )}
            onDragOver={handlePaneDragOver}
            onDragLeave={handlePaneDragLeave}
            onDrop={handlePaneDrop}
        >
            {/* Header */}
            <div className="h-12 px-4 border-b border-border/60 flex items-center gap-3">
                <div className="flex items-center gap-2 text-sm font-semibold">
                    {pane.connection.isLocal ? <Monitor size={14} /> : <HardDrive size={14} />}
                    <span>{pane.connection.hostLabel}</span>
                    {(pane.connection.status === 'connecting' || pane.reconnecting) && (
                        <Loader2 size={12} className="animate-spin text-muted-foreground" />
                    )}
                    {pane.reconnecting && (
                        <span className="text-xs text-muted-foreground">Reconnecting...</span>
                    )}
                    {pane.connection.status === 'error' && !pane.reconnecting && (
                        <AlertCircle size={12} className="text-destructive" />
                    )}
                </div>

                <Button variant="outline" size="sm" className="h-8 px-3" onClick={() => setShowHostPicker(true)}>
                    <RefreshCw size={12} className="mr-1" /> Change
                </Button>

                <div className="flex items-center gap-1 ml-auto">
                    <div className="relative">
                        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            value={pane.filter}
                            onChange={e => onSetFilter(e.target.value)}
                            placeholder="Filter..."
                            className="h-8 w-36 pl-8 pr-7 text-xs bg-secondary/40"
                        />
                        {pane.filter && (
                            <button
                                onClick={() => onSetFilter('')}
                                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                            >
                                <X size={12} />
                            </button>
                        )}
                    </div>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onRefresh} title="Refresh">
                        <RefreshCw size={14} className={(pane.loading || pane.reconnecting) ? 'animate-spin' : ''} />
                    </Button>
                </div>
            </div>

            {/* Toolbar */}
            <div className="h-10 px-4 flex items-center gap-2 border-b border-border/40 bg-secondary/20">
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onNavigateUp} title="Go up">
                    <ChevronLeft size={14} />
                </Button>

                {/* Editable Breadcrumb with autocomplete */}
                {isEditingPath ? (
                    <div className="relative flex-1">
                        <Input
                            ref={pathInputRef}
                            value={editingPathValue}
                            onChange={handlePathChange}
                            onBlur={handlePathBlur}
                            onKeyDown={handlePathKeyDown}
                            onFocus={() => setShowPathSuggestions(true)}
                            className="h-7 w-full text-xs bg-background"
                            autoFocus
                        />
                        {/* Path suggestions dropdown */}
                        {showPathSuggestions && pathSuggestions.length > 0 && (
                            <div
                                ref={pathDropdownRef}
                                className="absolute top-full left-0 right-0 mt-1 bg-popover border border-border rounded-md shadow-lg z-50 max-h-48 overflow-auto"
                            >
                                {pathSuggestions.map((suggestion, idx) => (
                                    <button
                                        key={suggestion.path}
                                        type="button"
                                        className={cn(
                                            "w-full px-3 py-2 text-left text-xs flex items-center gap-2 hover:bg-secondary/60 transition-colors",
                                            idx === pathSuggestionIndex && "bg-secondary/80"
                                        )}
                                        onMouseDown={(e) => {
                                            e.preventDefault();
                                            selectPathSuggestion(suggestion.path);
                                        }}
                                    >
                                        {suggestion.type === 'folder' ? (
                                            <Folder size={12} className="text-primary shrink-0" />
                                        ) : (
                                            <Home size={12} className="text-muted-foreground shrink-0" />
                                        )}
                                        <span className="truncate font-mono">{suggestion.path}</span>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                ) : (
                    <div
                        className="flex-1 cursor-text hover:bg-secondary/50 rounded px-1 transition-colors"
                        onDoubleClick={handlePathDoubleClick}
                        title="Double-click to edit path"
                    >
                        <Breadcrumb
                            path={pane.connection.currentPath}
                            onNavigate={onNavigateTo}
                            onHome={() => pane.connection?.homeDir && onNavigateTo(pane.connection.homeDir)}
                        />
                    </div>
                )}

                <div className="ml-auto flex items-center gap-1">
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => setShowNewFolderDialog(true)}
                    >
                        <FolderPlus size={12} className="mr-1" /> New Folder
                    </Button>
                </div>
            </div>

            {/* File list header with sortable columns and resize handles */}
            <div
                className="text-[11px] uppercase tracking-wide text-muted-foreground px-4 py-2 border-b border-border/40 bg-secondary/10 select-none"
                style={{ display: 'grid', gridTemplateColumns: `${columnWidths.name}% ${columnWidths.modified}% ${columnWidths.size}% ${columnWidths.type}%` }}
            >
                <div
                    className="flex items-center gap-1 cursor-pointer hover:text-foreground relative pr-2"
                    onClick={() => handleSort('name')}
                >
                    <span>Name</span>
                    {sortField === 'name' && (
                        <span className="text-primary">{sortOrder === 'asc' ? '↑' : '↓'}</span>
                    )}
                    <div
                        className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/50 transition-colors"
                        onMouseDown={(e) => handleResizeStart('name', e)}
                    />
                </div>
                <div
                    className="flex items-center gap-1 cursor-pointer hover:text-foreground relative pr-2"
                    onClick={() => handleSort('modified')}
                >
                    <span>Modified</span>
                    {sortField === 'modified' && (
                        <span className="text-primary">{sortOrder === 'asc' ? '↑' : '↓'}</span>
                    )}
                    <div
                        className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/50 transition-colors"
                        onMouseDown={(e) => handleResizeStart('modified', e)}
                    />
                </div>
                <div
                    className="flex items-center gap-1 cursor-pointer hover:text-foreground relative pr-2 justify-end"
                    onClick={() => handleSort('size')}
                >
                    {sortField === 'size' && (
                        <span className="text-primary">{sortOrder === 'asc' ? '↑' : '↓'}</span>
                    )}
                    <span>Size</span>
                    <div
                        className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/50 transition-colors"
                        onMouseDown={(e) => handleResizeStart('size', e)}
                    />
                </div>
                <div
                    className="flex items-center gap-1 cursor-pointer hover:text-foreground justify-end"
                    onClick={() => handleSort('type')}
                >
                    {sortField === 'type' && (
                        <span className="text-primary">{sortOrder === 'asc' ? '↑' : '↓'}</span>
                    )}
                    <span>Kind</span>
                </div>
            </div>

            {/* File list */}
            <div
                ref={fileListRef}
                className={cn(
                    "flex-1 min-h-0 overflow-y-auto relative",
                    isDragOverPane && "ring-2 ring-primary/30 ring-inset"
                )}
            >
                {pane.loading && sortedDisplayFiles.length === 0 ? (
                    <div className="flex items-center justify-center h-full">
                        <Loader2 size={24} className="animate-spin text-muted-foreground" />
                    </div>
                ) : pane.error ? (
                    <div className="flex flex-col items-center justify-center h-full gap-2 text-destructive">
                        <AlertCircle size={24} />
                        <span className="text-sm">{pane.error}</span>
                        <Button variant="outline" size="sm" onClick={onRefresh}>
                            Retry
                        </Button>
                    </div>
                ) : sortedDisplayFiles.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                        <Folder size={32} className="mb-2 opacity-50" />
                        <span className="text-sm">Empty directory</span>
                    </div>
                ) : (
                    <div className="divide-y divide-border/30">
                        {sortedDisplayFiles.map((entry, idx) => (
                            <ContextMenu key={`${entry.name}-${idx}`}>
                                <ContextMenuTrigger>
                                    <FileRow
                                        entry={entry}
                                        isSelected={pane.selectedFiles.has(entry.name)}
                                        isDragOver={dragOverEntry === entry.name}
                                        columnWidths={columnWidths}
                                        onSelect={(e) => {
                                            if (entry.name === '..') return;

                                            if (e.shiftKey && lastSelectedIndexRef.current !== null) {
                                                // Shift-click: range select based on sortedDisplayFiles
                                                const start = Math.min(lastSelectedIndexRef.current, idx);
                                                const end = Math.max(lastSelectedIndexRef.current, idx);
                                                // Get file names from sorted display files
                                                const selectedFileNames = sortedDisplayFiles
                                                    .slice(start, end + 1)
                                                    .filter(f => f.name !== '..')
                                                    .map(f => f.name);
                                                onRangeSelect(selectedFileNames);
                                            } else {
                                                // Normal or Ctrl/Cmd click
                                                onToggleSelection(entry.name, e.ctrlKey || e.metaKey);
                                                lastSelectedIndexRef.current = idx;
                                            }
                                        }}
                                        onOpen={() => onOpenEntry(entry)}
                                        onDragStart={(e) => handleFileDragStart(entry, e)}
                                        onDragEnd={onDragEnd}
                                        onDragOver={(e) => handleEntryDragOver(entry, e)}
                                        onDragLeave={() => setDragOverEntry(null)}
                                        onDrop={(e) => handleEntryDrop(entry, e)}
                                    />
                                </ContextMenuTrigger>
                                {entry.name !== '..' && (
                                    <ContextMenuContent>
                                        <ContextMenuItem onClick={() => onOpenEntry(entry)}>
                                            {entry.type === 'directory' ? 'Open' : 'Download'}
                                        </ContextMenuItem>
                                        <ContextMenuSeparator />
                                        <ContextMenuItem onClick={() => {
                                            const files = pane.selectedFiles.has(entry.name)
                                                ? Array.from(pane.selectedFiles)
                                                : [entry.name];
                                            const fileData = files.map(name => {
                                                const file = sortedDisplayFiles.find(f => f.name === name);
                                                return { name, isDirectory: file?.type === 'directory' || false };
                                            });
                                            onCopyToOtherPane(fileData);
                                        }}>
                                            <Copy size={14} className="mr-2" /> Copy to other pane
                                        </ContextMenuItem>
                                        <ContextMenuSeparator />
                                        <ContextMenuItem onClick={() => openRenameDialog(entry.name)}>
                                            <Pencil size={14} className="mr-2" /> Rename
                                        </ContextMenuItem>
                                        {onEditPermissions && pane.connection && !pane.connection.isLocal && (
                                            <ContextMenuItem onClick={() => onEditPermissions(entry)}>
                                                <Shield size={14} className="mr-2" /> Permissions
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
                                            <Trash2 size={14} className="mr-2" /> Delete
                                        </ContextMenuItem>
                                        <ContextMenuSeparator />
                                        <ContextMenuItem onClick={onRefresh}>
                                            <RefreshCw size={14} className="mr-2" /> Refresh
                                        </ContextMenuItem>
                                        <ContextMenuItem onClick={() => setShowNewFolderDialog(true)}>
                                            <FolderPlus size={14} className="mr-2" /> New Folder
                                        </ContextMenuItem>
                                    </ContextMenuContent>
                                )}
                            </ContextMenu>
                        ))}
                    </div>
                )}

                {/* Drop overlay */}
                {isDragOverPane && draggedFiles && draggedFiles[0]?.side !== side && (
                    <div className="absolute inset-0 flex items-center justify-center bg-primary/5 pointer-events-none">
                        <div className="flex flex-col items-center gap-2 text-primary">
                            <ArrowDown size={32} />
                            <span className="text-sm font-medium">Drop files here</span>
                        </div>
                    </div>
                )}
            </div>

            {/* Footer - pinned at bottom */}
            <div className="h-9 shrink-0 px-4 flex items-center justify-between text-[11px] text-muted-foreground border-t border-border/40 bg-secondary/30">
                <span>
                    {sortedDisplayFiles.filter(f => f.name !== '..').length} items
                    {pane.selectedFiles.size > 0 && ` • ${pane.selectedFiles.size} selected`}
                </span>
                <span className="truncate max-w-[200px]">{pane.connection.currentPath}</span>
            </div>

            {/* New folder dialog */}
            <Dialog open={showNewFolderDialog} onOpenChange={setShowNewFolderDialog}>
                <DialogContent className="max-w-sm">
                    <DialogHeader>
                        <DialogTitle>New Folder</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4">
                        <div className="space-y-2">
                            <Label>Folder name</Label>
                            <Input
                                value={newFolderName}
                                onChange={e => setNewFolderName(e.target.value)}
                                placeholder="Enter folder name"
                                onKeyDown={e => e.key === 'Enter' && handleCreateFolder()}
                                autoFocus
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setShowNewFolderDialog(false)}>Cancel</Button>
                        <Button onClick={handleCreateFolder} disabled={!newFolderName.trim()}>Create</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Rename dialog */}
            <Dialog open={showRenameDialog} onOpenChange={setShowRenameDialog}>
                <DialogContent className="max-w-sm">
                    <DialogHeader>
                        <DialogTitle>Rename</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4">
                        <div className="space-y-2">
                            <Label>New name</Label>
                            <Input
                                value={renameName}
                                onChange={e => setRenameName(e.target.value)}
                                placeholder="Enter new name"
                                onKeyDown={e => e.key === 'Enter' && handleRename()}
                                autoFocus
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setShowRenameDialog(false)}>Cancel</Button>
                        <Button onClick={handleRename} disabled={!renameName.trim()}>Rename</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Delete confirmation */}
            <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
                <DialogContent className="max-w-sm">
                    <DialogHeader>
                        <DialogTitle>Delete {deleteTargets.length} item{deleteTargets.length > 1 ? 's' : ''}?</DialogTitle>
                        <DialogDescription>
                            This action cannot be undone. The following will be deleted:
                        </DialogDescription>
                    </DialogHeader>
                    <div className="max-h-32 overflow-auto text-sm space-y-1">
                        {deleteTargets.map(name => (
                            <div key={name} className="flex items-center gap-2 text-muted-foreground">
                                <Trash2 size={12} />
                                <span className="truncate">{name}</span>
                            </div>
                        ))}
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setShowDeleteConfirm(false)}>Cancel</Button>
                        <Button variant="destructive" onClick={handleDelete}>Delete</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Host picker */}
            <Dialog open={showHostPicker} onOpenChange={setShowHostPicker}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>Select Host</DialogTitle>
                        <DialogDescription>
                            Pick a host for the {side} pane
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-3">
                        <Input
                            value={hostSearch}
                            onChange={e => setHostSearch(e.target.value)}
                            placeholder="Search hosts..."
                            className="h-9"
                        />

                        <div
                            className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-border/70 bg-secondary/30 cursor-pointer hover:border-primary/50 hover:bg-secondary/50 transition-colors"
                            onClick={() => { onDisconnect(); onConnect('local'); setShowHostPicker(false); }}
                        >
                            <div className="flex items-center gap-3">
                                <div className="h-9 w-9 rounded-lg bg-primary/10 border border-primary/30 flex items-center justify-center text-primary">
                                    <Monitor size={16} />
                                </div>
                                <div>
                                    <div className="text-sm font-medium">Local filesystem</div>
                                    <div className="text-xs text-muted-foreground">Browse local files</div>
                                </div>
                            </div>
                            <Badge variant="outline" className="text-[10px]">Local</Badge>
                        </div>

                        <div className="max-h-64 overflow-auto space-y-2">
                            {filteredHosts.map(host => (
                                <div
                                    key={host.id}
                                    className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-border/70 bg-secondary/30 cursor-pointer hover:border-primary/50 hover:bg-secondary/50 transition-colors"
                                    onClick={() => { onDisconnect(); onConnect(host); setShowHostPicker(false); }}
                                >
                                    <div className="flex items-center gap-3 min-w-0">
                                        <DistroAvatar host={host} fallback={host.label[0].toUpperCase()} className="h-9 w-9" />
                                        <div className="min-w-0">
                                            <div className="text-sm font-medium truncate">{host.label}</div>
                                            <div className="text-xs text-muted-foreground truncate">
                                                {host.username}@{host.hostname}
                                            </div>
                                        </div>
                                    </div>
                                    <Badge variant="secondary" className="text-[10px] bg-primary/10 text-primary border-primary/30">
                                        SSH
                                    </Badge>
                                </div>
                            ))}
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
};

// Memoized SftpPaneView - only re-renders when pane data or callbacks change
const SftpPaneView = memo(SftpPaneViewInner);
SftpPaneView.displayName = 'SftpPaneView';

// Conflict Resolution Dialog
interface ConflictDialogProps {
    conflicts: { transferId: string; fileName: string; sourcePath: string; targetPath: string; existingSize: number; newSize: number; existingModified: number; newModified: number; }[];
    onResolve: (conflictId: string, action: 'replace' | 'skip' | 'duplicate') => void;
    formatFileSize: (size: number) => string;
}

const ConflictDialog: React.FC<ConflictDialogProps> = ({ conflicts, onResolve, formatFileSize }) => {
    const [applyToAll, setApplyToAll] = useState(false);
    const conflict = conflicts[0]; // Handle first conflict

    if (!conflict) return null;

    const formatDate = (timestamp: number) => {
        return new Date(timestamp).toLocaleString();
    };

    const handleAction = (action: 'replace' | 'skip' | 'duplicate') => {
        if (applyToAll) {
            // Apply to all conflicts
            conflicts.forEach(c => onResolve(c.transferId, action));
        } else {
            onResolve(conflict.transferId, action);
        }
        setApplyToAll(false);
    };

    return (
        <Dialog open={!!conflict} onOpenChange={() => handleAction('skip')}>
            <DialogContent className="sm:max-w-[480px]">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <AlertCircle className="h-5 w-5 text-yellow-500" />
                        File Conflict
                    </DialogTitle>
                    <DialogDescription>
                        A file with the same name already exists at the destination
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 py-4">
                    <div className="text-sm">
                        <span className="font-medium">{conflict.fileName}</span>
                        <span className="text-muted-foreground ml-1">already exists</span>
                    </div>

                    <div className="grid grid-cols-2 gap-4 text-xs">
                        <div className="p-3 rounded-lg bg-secondary/50 border border-border/60">
                            <div className="font-medium mb-2 text-muted-foreground">Existing file</div>
                            <div className="space-y-1">
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">Size:</span>
                                    <span>{formatFileSize(conflict.existingSize)}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">Modified:</span>
                                    <span>{formatDate(conflict.existingModified)}</span>
                                </div>
                            </div>
                        </div>

                        <div className="p-3 rounded-lg bg-primary/10 border border-primary/30">
                            <div className="font-medium mb-2 text-primary">New file</div>
                            <div className="space-y-1">
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">Size:</span>
                                    <span>{formatFileSize(conflict.newSize)}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">Modified:</span>
                                    <span>{formatDate(conflict.newModified)}</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    {conflicts.length > 1 && (
                        <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                            <input
                                type="checkbox"
                                checked={applyToAll}
                                onChange={(e) => setApplyToAll(e.target.checked)}
                                className="rounded border-border"
                            />
                            Apply this action to all {conflicts.length} remaining conflicts
                        </label>
                    )}
                </div>

                <DialogFooter className="flex gap-2">
                    <Button
                        variant="outline"
                        onClick={() => handleAction('skip')}
                        className="flex-1"
                    >
                        Skip
                    </Button>
                    <Button
                        variant="outline"
                        onClick={() => handleAction('duplicate')}
                        className="flex-1"
                    >
                        Keep Both
                    </Button>
                    <Button
                        variant="default"
                        onClick={() => handleAction('replace')}
                        className="flex-1"
                    >
                        Replace
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

// Permissions Editor Dialog
interface PermissionsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    file: SftpFileEntry | null;
    onSave: (file: SftpFileEntry, permissions: string) => void;
}

const PermissionsDialog: React.FC<PermissionsDialogProps> = ({ open, onOpenChange, file, onSave }) => {
    const [permissions, setPermissions] = useState({
        owner: { read: false, write: false, execute: false },
        group: { read: false, write: false, execute: false },
        others: { read: false, write: false, execute: false },
    });

    // Parse permissions from file
    useEffect(() => {
        if (file?.permissions) {
            const perms = file.permissions;
            // Parse rwxrwxrwx format (skip first char for type)
            const pStr = perms.length === 10 ? perms.slice(1) : perms;
            if (pStr.length >= 9) {
                setPermissions({
                    owner: {
                        read: pStr[0] === 'r',
                        write: pStr[1] === 'w',
                        execute: pStr[2] === 'x' || pStr[2] === 's',
                    },
                    group: {
                        read: pStr[3] === 'r',
                        write: pStr[4] === 'w',
                        execute: pStr[5] === 'x' || pStr[5] === 's',
                    },
                    others: {
                        read: pStr[6] === 'r',
                        write: pStr[7] === 'w',
                        execute: pStr[8] === 'x' || pStr[8] === 't',
                    },
                });
            }
        }
    }, [file]);

    const togglePerm = (role: 'owner' | 'group' | 'others', perm: 'read' | 'write' | 'execute') => {
        setPermissions(prev => ({
            ...prev,
            [role]: { ...prev[role], [perm]: !prev[role][perm] }
        }));
    };

    const getOctalPermissions = (): string => {
        const getNum = (p: { read: boolean; write: boolean; execute: boolean }) =>
            (p.read ? 4 : 0) + (p.write ? 2 : 0) + (p.execute ? 1 : 0);
        return `${getNum(permissions.owner)}${getNum(permissions.group)}${getNum(permissions.others)}`;
    };

    const getSymbolicPermissions = (): string => {
        const getSym = (p: { read: boolean; write: boolean; execute: boolean }) =>
            `${p.read ? 'r' : '-'}${p.write ? 'w' : '-'}${p.execute ? 'x' : '-'}`;
        return getSym(permissions.owner) + getSym(permissions.group) + getSym(permissions.others);
    };

    const handleSave = () => {
        if (file) {
            onSave(file, getOctalPermissions());
            onOpenChange(false);
        }
    };

    if (!file) return null;

    const PermRow = ({ role, label }: { role: 'owner' | 'group' | 'others'; label: string }) => (
        <div className="flex items-center gap-4">
            <div className="w-16 text-sm font-medium">{label}</div>
            <div className="flex gap-3">
                {(['read', 'write', 'execute'] as const).map(perm => (
                    <label key={perm} className="flex items-center gap-1.5 cursor-pointer">
                        <input
                            type="checkbox"
                            checked={permissions[role][perm]}
                            onChange={() => togglePerm(role, perm)}
                            className="rounded border-border"
                        />
                        <span className="text-xs capitalize">{perm[0].toUpperCase()}</span>
                    </label>
                ))}
            </div>
        </div>
    );

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[400px]">
                <DialogHeader>
                    <DialogTitle>Edit Permissions</DialogTitle>
                    <DialogDescription className="truncate">
                        {file.name}
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 py-4">
                    <div className="space-y-3">
                        <PermRow role="owner" label="Owner" />
                        <PermRow role="group" label="Group" />
                        <PermRow role="others" label="Others" />
                    </div>

                    <div className="flex items-center justify-between pt-2 border-t border-border/60">
                        <div className="text-xs text-muted-foreground">
                            Octal: <span className="font-mono text-foreground">{getOctalPermissions()}</span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                            Symbolic: <span className="font-mono text-foreground">{getSymbolicPermissions()}</span>
                        </div>
                    </div>
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button onClick={handleSave}>
                        Apply
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

// Main SftpView component
interface SftpViewProps {
    hosts: Host[];
    keys: SSHKey[];
}

const SftpViewInner: React.FC<SftpViewProps> = ({ hosts, keys }) => {
    // Subscribe to isActive from external store - only re-renders when sftp active state changes
    const isActive = useIsSftpActive();
    const sftp = useSftpState(hosts, keys);
    const [permissionsState, setPermissionsState] = useState<{ file: SftpFileEntry; side: 'left' | 'right' } | null>(null);
    const [draggedFiles, setDraggedFiles] = useState<{ name: string; isDirectory: boolean; side: 'left' | 'right' }[] | null>(null);

    // Memoized callbacks - stable references
    const handleDragStart = useCallback((files: { name: string; isDirectory: boolean }[], side: 'left' | 'right') => {
        setDraggedFiles(files.map(f => ({ ...f, side })));
    }, []);

    const handleDragEnd = useCallback(() => {
        setDraggedFiles(null);
    }, []);

    // Copy to other pane: source is the current pane, target is the other pane
    const handleCopyToOtherPaneLeft = useCallback((files: { name: string; isDirectory: boolean }[]) => {
        sftp.startTransfer(files, 'left', 'right');  // from left to right
    }, [sftp.startTransfer]);

    const handleCopyToOtherPaneRight = useCallback((files: { name: string; isDirectory: boolean }[]) => {
        sftp.startTransfer(files, 'right', 'left');  // from right to left
    }, [sftp.startTransfer]);

    // Receive from other pane (drag-drop): source is other pane, target is this pane
    const handleReceiveFromOtherPaneLeft = useCallback((files: { name: string; isDirectory: boolean }[]) => {
        sftp.startTransfer(files, 'right', 'left');  // from right to left
    }, [sftp.startTransfer]);

    const handleReceiveFromOtherPaneRight = useCallback((files: { name: string; isDirectory: boolean }[]) => {
        sftp.startTransfer(files, 'left', 'right');  // from left to right
    }, [sftp.startTransfer]);

    // Pane-specific callbacks using useCallback
    const handleConnectLeft = useCallback((host: Host) => sftp.connect('left', host), [sftp.connect]);
    const handleConnectRight = useCallback((host: Host) => sftp.connect('right', host), [sftp.connect]);
    const handleDisconnectLeft = useCallback(() => sftp.disconnect('left'), [sftp.disconnect]);
    const handleDisconnectRight = useCallback(() => sftp.disconnect('right'), [sftp.disconnect]);
    const handleNavigateToLeft = useCallback((path: string) => sftp.navigateTo('left', path), [sftp.navigateTo]);
    const handleNavigateToRight = useCallback((path: string) => sftp.navigateTo('right', path), [sftp.navigateTo]);
    const handleNavigateUpLeft = useCallback(() => sftp.navigateUp('left'), [sftp.navigateUp]);
    const handleNavigateUpRight = useCallback(() => sftp.navigateUp('right'), [sftp.navigateUp]);
    const handleRefreshLeft = useCallback(() => sftp.refresh('left'), [sftp.refresh]);
    const handleRefreshRight = useCallback(() => sftp.refresh('right'), [sftp.refresh]);
    const handleOpenEntryLeft = useCallback((entry: SftpFileEntry) => sftp.openEntry('left', entry), [sftp.openEntry]);
    const handleOpenEntryRight = useCallback((entry: SftpFileEntry) => sftp.openEntry('right', entry), [sftp.openEntry]);
    const handleToggleSelectionLeft = useCallback((name: string, multi: boolean) => sftp.toggleSelection('left', name, multi), [sftp.toggleSelection]);
    const handleToggleSelectionRight = useCallback((name: string, multi: boolean) => sftp.toggleSelection('right', name, multi), [sftp.toggleSelection]);
    const handleRangeSelectLeft = useCallback((fileNames: string[]) => sftp.rangeSelect('left', fileNames), [sftp.rangeSelect]);
    const handleRangeSelectRight = useCallback((fileNames: string[]) => sftp.rangeSelect('right', fileNames), [sftp.rangeSelect]);
    const handleClearSelectionLeft = useCallback(() => sftp.clearSelection('left'), [sftp.clearSelection]);
    const handleClearSelectionRight = useCallback(() => sftp.clearSelection('right'), [sftp.clearSelection]);
    const handleSetFilterLeft = useCallback((filter: string) => sftp.setFilter('left', filter), [sftp.setFilter]);
    const handleSetFilterRight = useCallback((filter: string) => sftp.setFilter('right', filter), [sftp.setFilter]);
    const handleCreateDirectoryLeft = useCallback((name: string) => sftp.createDirectory('left', name), [sftp.createDirectory]);
    const handleCreateDirectoryRight = useCallback((name: string) => sftp.createDirectory('right', name), [sftp.createDirectory]);
    const handleDeleteFilesLeft = useCallback((names: string[]) => sftp.deleteFiles('left', names), [sftp.deleteFiles]);
    const handleDeleteFilesRight = useCallback((names: string[]) => sftp.deleteFiles('right', names), [sftp.deleteFiles]);
    const handleRenameFileLeft = useCallback((old: string, newName: string) => sftp.renameFile('left', old, newName), [sftp.renameFile]);
    const handleRenameFileRight = useCallback((old: string, newName: string) => sftp.renameFile('right', old, newName), [sftp.renameFile]);
    const handleEditPermissionsLeft = useCallback((file: SftpFileEntry) => setPermissionsState({ file, side: 'left' }), []);
    const handleEditPermissionsRight = useCallback((file: SftpFileEntry) => setPermissionsState({ file, side: 'right' }), []);

    // Only compute filtered files when active to save processing
    const leftFilteredFiles = useMemo(() => sftp.getFilteredFiles(sftp.leftPane), [sftp.leftPane, sftp.getFilteredFiles]);
    const rightFilteredFiles = useMemo(() => sftp.getFilteredFiles(sftp.rightPane), [sftp.rightPane, sftp.getFilteredFiles]);

    // Show transfer queue
    const visibleTransfers = useMemo(() => sftp.transfers.slice(-5), [sftp.transfers]);

    // Use visibility + pointer-events instead of display:none to preserve component state
    // and avoid re-rendering when switching tabs
    // When inactive, also set z-index to -1 to prevent rendering artifacts
    const containerStyle: React.CSSProperties = isActive
        ? {}
        : { visibility: 'hidden', pointerEvents: 'none', position: 'absolute', zIndex: -1 };

    return (
        <div
            className={cn("absolute inset-0 min-h-0 flex flex-col", isActive ? "z-20" : "")}
            style={containerStyle}
        >
            {/* Main content */}
            <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 min-h-0 border-t border-border/70">
                {/* Left pane */}
                <div className="relative border-r border-border/70">
                    <SftpPaneView
                        side="left"
                        pane={sftp.leftPane}
                        hosts={hosts}
                        filteredFiles={leftFilteredFiles}
                        onConnect={handleConnectLeft}
                        onDisconnect={handleDisconnectLeft}
                        onNavigateTo={handleNavigateToLeft}
                        onNavigateUp={handleNavigateUpLeft}
                        onRefresh={handleRefreshLeft}
                        onOpenEntry={handleOpenEntryLeft}
                        onToggleSelection={handleToggleSelectionLeft}
                        onRangeSelect={handleRangeSelectLeft}
                        onClearSelection={handleClearSelectionLeft}
                        onSetFilter={handleSetFilterLeft}
                        onCreateDirectory={handleCreateDirectoryLeft}
                        onDeleteFiles={handleDeleteFilesLeft}
                        onRenameFile={handleRenameFileLeft}
                        onCopyToOtherPane={handleCopyToOtherPaneLeft}
                        onReceiveFromOtherPane={handleReceiveFromOtherPaneLeft}
                        onEditPermissions={handleEditPermissionsLeft}
                        draggedFiles={draggedFiles}
                        onDragStart={handleDragStart}
                        onDragEnd={handleDragEnd}
                    />
                </div>

                {/* Right pane */}
                <div className="relative">
                    <SftpPaneView
                        side="right"
                        pane={sftp.rightPane}
                        hosts={hosts}
                        filteredFiles={rightFilteredFiles}
                        onConnect={handleConnectRight}
                        onDisconnect={handleDisconnectRight}
                        onNavigateTo={handleNavigateToRight}
                        onNavigateUp={handleNavigateUpRight}
                        onRefresh={handleRefreshRight}
                        onOpenEntry={handleOpenEntryRight}
                        onToggleSelection={handleToggleSelectionRight}
                        onRangeSelect={handleRangeSelectRight}
                        onClearSelection={handleClearSelectionRight}
                        onSetFilter={handleSetFilterRight}
                        onCreateDirectory={handleCreateDirectoryRight}
                        onDeleteFiles={handleDeleteFilesRight}
                        onRenameFile={handleRenameFileRight}
                        onCopyToOtherPane={handleCopyToOtherPaneRight}
                        onReceiveFromOtherPane={handleReceiveFromOtherPaneRight}
                        onEditPermissions={handleEditPermissionsRight}
                        draggedFiles={draggedFiles}
                        onDragStart={handleDragStart}
                        onDragEnd={handleDragEnd}
                    />
                </div>
            </div>

            {/* Transfer queue */}
            {sftp.transfers.length > 0 && (
                <div className="border-t border-border/70 bg-secondary/80 backdrop-blur-sm shrink-0">
                    <div className="flex items-center justify-between px-4 py-2 text-xs text-muted-foreground border-b border-border/40">
                        <span className="font-medium">
                            Transfers
                            {sftp.activeTransfersCount > 0 && (
                                <span className="ml-2 text-primary">({sftp.activeTransfersCount} active)</span>
                            )}
                        </span>
                        {sftp.transfers.some(t => t.status === 'completed' || t.status === 'cancelled') && (
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 px-2 text-xs"
                                onClick={sftp.clearCompletedTransfers}
                            >
                                Clear completed
                            </Button>
                        )}
                    </div>
                    <div className="max-h-40 overflow-auto">
                        {visibleTransfers.map(task => (
                            <TransferItem
                                key={task.id}
                                task={task}
                                onCancel={() => sftp.cancelTransfer(task.id)}
                                onRetry={() => sftp.retryTransfer(task.id)}
                                onDismiss={() => sftp.dismissTransfer(task.id)}
                            />
                        ))}
                    </div>
                </div>
            )}

            {/* Conflict Resolution Dialog */}
            <ConflictDialog
                conflicts={sftp.conflicts}
                onResolve={sftp.resolveConflict}
                formatFileSize={sftp.formatFileSize}
            />

            {/* Permissions Dialog */}
            <PermissionsDialog
                open={!!permissionsState}
                onOpenChange={(open) => !open && setPermissionsState(null)}
                file={permissionsState?.file ?? null}
                onSave={(file, permissions) => {
                    if (permissionsState) {
                        const fullPath = sftp.joinPath(
                            permissionsState.side === 'left'
                                ? sftp.leftPane.connection?.currentPath || ''
                                : sftp.rightPane.connection?.currentPath || '',
                            file.name
                        );
                        sftp.changePermissions(permissionsState.side, fullPath, permissions);
                    }
                    setPermissionsState(null);
                }}
            />
        </div>
    );
};

// Only re-render when data props change - isActive is now managed internally via store subscription
const sftpViewAreEqual = (prev: SftpViewProps, next: SftpViewProps): boolean => {
    return prev.hosts === next.hosts && prev.keys === next.keys;
};

export const SftpView = memo(SftpViewInner, sftpViewAreEqual);
SftpView.displayName = 'SftpView';
