import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { cn } from '../lib/utils';
import { Host, SSHKey, SftpFileEntry, TransferTask } from '../types';
import { DistroAvatar } from './DistroAvatar';
import { useSftpState, SftpPane } from '../application/state/useSftpState';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from './ui/context-menu';
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
} from 'lucide-react';

// File icon helper
const getFileIcon = (entry: SftpFileEntry) => {
  if (entry.type === 'directory') return <Folder size={14} />;
  const ext = entry.name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'sh':
    case 'bash':
    case 'zsh':
      return <FileCode size={14} className="text-green-500" />;
    case 'js':
    case 'ts':
    case 'jsx':
    case 'tsx':
      return <FileCode size={14} className="text-yellow-500" />;
    case 'py':
      return <FileCode size={14} className="text-blue-500" />;
    case 'json':
    case 'yml':
    case 'yaml':
    case 'xml':
      return <FileCode size={14} className="text-orange-500" />;
    case 'md':
    case 'txt':
      return <FileCode size={14} className="text-muted-foreground" />;
    default:
      return <FileCode size={14} />;
  }
};

// Breadcrumb component
const Breadcrumb: React.FC<{
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

// File row component
const FileRow: React.FC<{
  entry: SftpFileEntry;
  isSelected: boolean;
  isDragOver: boolean;
  onSelect: (e: React.MouseEvent) => void;
  onOpen: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
}> = ({ entry, isSelected, isDragOver, onSelect, onOpen, onDragStart, onDragEnd, onDragOver, onDragLeave, onDrop }) => {
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
        "grid grid-cols-[minmax(0,1fr)_140px_80px_60px] px-4 py-2 items-center cursor-pointer text-sm transition-colors",
        isSelected ? "bg-primary/15 text-foreground" : "hover:bg-secondary/40",
        isDragOver && entry.type === 'directory' && "bg-primary/25 ring-1 ring-primary/50"
      )}
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
      <span className="text-xs text-muted-foreground truncate">{entry.lastModifiedFormatted}</span>
      <span className="text-xs text-muted-foreground truncate text-right">{entry.sizeFormatted}</span>
      <span className="text-xs text-muted-foreground truncate capitalize text-right">
        {entry.type === 'directory' ? 'folder' : entry.name.split('.').pop()?.toLowerCase() || 'file'}
      </span>
    </div>
  );
};

// Transfer item component
const TransferItem: React.FC<{
  task: TransferTask;
  onCancel: () => void;
  onRetry: () => void;
  onDismiss: () => void;
}> = ({ task, onCancel, onRetry, onDismiss }) => {
  const progress = task.totalBytes > 0 ? (task.transferredBytes / task.totalBytes) * 100 : 0;
  const speedFormatted = task.speed > 0 
    ? `${(task.speed / 1024).toFixed(1)} KB/s` 
    : '';
  
  const remainingBytes = task.totalBytes - task.transferredBytes;
  const remainingTime = task.speed > 0 
    ? Math.ceil(remainingBytes / task.speed) 
    : 0;
  const remainingFormatted = remainingTime > 60 
    ? `~${Math.ceil(remainingTime / 60)} min remaining`
    : remainingTime > 0 
      ? `~${remainingTime}s remaining`
      : '';

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 bg-background/60 border-t border-border/40 backdrop-blur-sm">
      <div className="h-6 w-6 rounded flex items-center justify-center shrink-0">
        {task.status === 'transferring' && <Loader2 size={14} className="animate-spin text-primary" />}
        {task.status === 'pending' && <ArrowDown size={14} className="text-muted-foreground" />}
        {task.status === 'completed' && <CheckCircle2 size={14} className="text-green-500" />}
        {task.status === 'failed' && <XCircle size={14} className="text-destructive" />}
        {task.status === 'cancelled' && <XCircle size={14} className="text-muted-foreground" />}
      </div>
      
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm truncate">{task.fileName}</span>
          {task.status === 'transferring' && speedFormatted && (
            <span className="text-xs text-muted-foreground">{speedFormatted}</span>
          )}
        </div>
        {task.status === 'transferring' && (
          <div className="flex items-center gap-2 mt-1">
            <div className="flex-1 h-1.5 bg-secondary/80 rounded-full overflow-hidden">
              <div 
                className="h-full bg-gradient-to-r from-primary to-primary/80 rounded-full transition-all duration-300 ease-out relative"
                style={{ width: `${progress}%` }}
              >
                <div className="absolute inset-0 bg-white/20 animate-pulse" />
              </div>
            </div>
            <span className="text-[10px] text-muted-foreground shrink-0 w-20 text-right">{Math.round(progress)}%</span>
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
          <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={onCancel} title="Cancel">
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

// SFTP Pane component
const SftpPaneView: React.FC<{
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
  onClearSelection: () => void;
  onSetFilter: (filter: string) => void;
  onCreateDirectory: (name: string) => Promise<void>;
  onDeleteFiles: (fileNames: string[]) => Promise<void>;
  onRenameFile: (oldName: string, newName: string) => Promise<void>;
  onStartTransfer: (files: { name: string; isDirectory: boolean }[]) => void;
  onEditPermissions?: (file: SftpFileEntry) => void;
  draggedFiles: { name: string; isDirectory: boolean; side: 'left' | 'right' }[] | null;
  onDragStart: (files: { name: string; isDirectory: boolean }[], side: 'left' | 'right') => void;
  onDragEnd: () => void;
}> = ({
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
  onClearSelection,
  onSetFilter,
  onCreateDirectory,
  onDeleteFiles,
  onRenameFile,
  onStartTransfer,
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

  const handlePaneDragLeave = (e: React.DragEvent) => {
    if (!fileListRef.current?.contains(e.relatedTarget as Node)) {
      setIsDragOverPane(false);
    }
  };

  const handlePaneDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOverPane(false);
    setDragOverEntry(null);
    
    if (!draggedFiles || draggedFiles[0]?.side === side) return;
    onStartTransfer(draggedFiles.map(f => ({ name: f.name, isDirectory: f.isDirectory })));
  };

  const handleFileDragStart = (entry: SftpFileEntry, e: React.DragEvent) => {
    if (entry.name === '..') {
      e.preventDefault();
      return;
    }
    
    const selectedNames = Array.from(pane.selectedFiles);
    const files = selectedNames.includes(entry.name)
      ? displayFiles.filter(f => selectedNames.includes(f.name)).map(f => ({ 
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
    if (entry.type !== 'directory' || entry.name === '..') return;
    
    e.preventDefault();
    e.stopPropagation();
    setDragOverEntry(entry.name);
  };

  const handleEntryDrop = (entry: SftpFileEntry, e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverEntry(null);
    setIsDragOverPane(false);
    
    if (!draggedFiles || draggedFiles[0]?.side === side) return;
    if (entry.type !== 'directory') return;
    
    // Navigate to directory first, then transfer
    // For now, just transfer to current directory
    onStartTransfer(draggedFiles.map(f => ({ name: f.name, isDirectory: f.isDirectory })));
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
          {pane.connection.status === 'connecting' && (
            <Loader2 size={12} className="animate-spin text-muted-foreground" />
          )}
          {pane.connection.status === 'error' && (
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
            <RefreshCw size={14} className={pane.loading ? 'animate-spin' : ''} />
          </Button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="h-10 px-4 flex items-center gap-2 border-b border-border/40 bg-secondary/20">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onNavigateUp} title="Go up">
          <ChevronLeft size={14} />
        </Button>
        <Breadcrumb 
          path={pane.connection.currentPath} 
          onNavigate={onNavigateTo}
          onHome={() => pane.connection?.homeDir && onNavigateTo(pane.connection.homeDir)}
        />
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

      {/* File list header */}
      <div className="grid grid-cols-[minmax(0,1fr)_140px_80px_60px] text-[11px] uppercase tracking-wide text-muted-foreground px-4 py-2 border-b border-border/40 bg-secondary/10">
        <span>Name</span>
        <span>Modified</span>
        <span className="text-right">Size</span>
        <span className="text-right">Kind</span>
      </div>

      {/* File list */}
      <div 
        ref={fileListRef}
        className={cn(
          "flex-1 min-h-0 overflow-y-auto relative",
          isDragOverPane && "ring-2 ring-primary/30 ring-inset"
        )}
      >
        {pane.loading && displayFiles.length === 0 ? (
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
        ) : displayFiles.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <Folder size={32} className="mb-2 opacity-50" />
            <span className="text-sm">Empty directory</span>
          </div>
        ) : (
          <div className="divide-y divide-border/30">
            {displayFiles.map((entry, idx) => (
              <ContextMenu key={`${entry.name}-${idx}`}>
                <ContextMenuTrigger>
                  <FileRow
                    entry={entry}
                    isSelected={pane.selectedFiles.has(entry.name)}
                    isDragOver={dragOverEntry === entry.name}
                    onSelect={(e) => {
                      if (entry.name === '..') return;
                      onToggleSelection(entry.name, e.ctrlKey || e.metaKey);
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
                        const file = displayFiles.find(f => f.name === name);
                        return { name, isDirectory: file?.type === 'directory' || false };
                      });
                      onStartTransfer(fileData);
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
          {displayFiles.filter(f => f.name !== '..').length} items
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
  isActive: boolean;
}

export const SftpView: React.FC<SftpViewProps> = ({ hosts, keys, isActive }) => {
  const sftp = useSftpState(hosts, keys);
  const [permissionsState, setPermissionsState] = useState<{ file: SftpFileEntry; side: 'left' | 'right' } | null>(null);
  const [draggedFiles, setDraggedFiles] = useState<{ name: string; isDirectory: boolean; side: 'left' | 'right' }[] | null>(null);

  const leftFilteredFiles = useMemo(() => sftp.getFilteredFiles(sftp.leftPane), [sftp.leftPane]);
  const rightFilteredFiles = useMemo(() => sftp.getFilteredFiles(sftp.rightPane), [sftp.rightPane]);

  const handleDragStart = (files: { name: string; isDirectory: boolean }[], side: 'left' | 'right') => {
    setDraggedFiles(files.map(f => ({ ...f, side })));
  };

  const handleDragEnd = () => {
    setDraggedFiles(null);
  };

  const handleStartTransfer = (sourceSide: 'left' | 'right') => (files: { name: string; isDirectory: boolean }[]) => {
    const targetSide = sourceSide === 'left' ? 'right' : 'left';
    sftp.startTransfer(files, sourceSide, targetSide);
  };

  // Show transfer queue
  const visibleTransfers = sftp.transfers.slice(-5); // Show last 5 transfers

  return (
    <div
      className="absolute inset-0 min-h-0 flex flex-col z-20"
      style={{ display: isActive ? 'flex' : 'none' }}
    >
      {/* Main content */}
      <div className="flex-1 grid grid-cols-1 xl:grid-cols-2 min-h-0 border-t border-border/70">
        {/* Left pane */}
        <div className="relative border-r border-border/70">
          <SftpPaneView
            side="left"
            pane={sftp.leftPane}
            hosts={hosts}
            filteredFiles={leftFilteredFiles}
            onConnect={(host) => sftp.connect('left', host)}
            onDisconnect={() => sftp.disconnect('left')}
            onNavigateTo={(path) => sftp.navigateTo('left', path)}
            onNavigateUp={() => sftp.navigateUp('left')}
            onRefresh={() => sftp.refresh('left')}
            onOpenEntry={(entry) => sftp.openEntry('left', entry)}
            onToggleSelection={(name, multi) => sftp.toggleSelection('left', name, multi)}
            onClearSelection={() => sftp.clearSelection('left')}
            onSetFilter={(filter) => sftp.setFilter('left', filter)}
            onCreateDirectory={(name) => sftp.createDirectory('left', name)}
            onDeleteFiles={(names) => sftp.deleteFiles('left', names)}
            onRenameFile={(old, newName) => sftp.renameFile('left', old, newName)}
            onStartTransfer={handleStartTransfer('left')}
            onEditPermissions={(file) => setPermissionsState({ file, side: 'left' })}
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
            onConnect={(host) => sftp.connect('right', host)}
            onDisconnect={() => sftp.disconnect('right')}
            onNavigateTo={(path) => sftp.navigateTo('right', path)}
            onNavigateUp={() => sftp.navigateUp('right')}
            onRefresh={() => sftp.refresh('right')}
            onOpenEntry={(entry) => sftp.openEntry('right', entry)}
            onToggleSelection={(name, multi) => sftp.toggleSelection('right', name, multi)}
            onClearSelection={() => sftp.clearSelection('right')}
            onSetFilter={(filter) => sftp.setFilter('right', filter)}
            onCreateDirectory={(name) => sftp.createDirectory('right', name)}
            onDeleteFiles={(names) => sftp.deleteFiles('right', names)}
            onRenameFile={(old, newName) => sftp.renameFile('right', old, newName)}
            onStartTransfer={handleStartTransfer('right')}
            onEditPermissions={(file) => setPermissionsState({ file, side: 'right' })}
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
