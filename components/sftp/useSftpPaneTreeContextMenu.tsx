import { useMemo } from 'react';
import { ArrowRight, ArrowUp, ClipboardCopy, Copy, Download, Edit2, ExternalLink, FilePlus, Folder, FolderInput, FolderPlus, Pencil, RefreshCw, Shield, Trash2, Upload } from 'lucide-react';
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '../ui/context-menu';
import { getParentPath } from '../../application/state/sftp/utils';
import { isKnownBinaryFile } from '../../lib/sftpFileUtils';
import { isNavigableDirectory } from './utils';
import { getSftpTreeUploadFilesTargetPath, getSftpUploadFilesLabelKey, getSftpUploadFolderLabelKey } from './sftpUploadMenu';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SftpPaneTreeContextMenuProps = Record<string, any>;

export function useSftpPaneTreeContextMenu(props: SftpPaneTreeContextMenuProps) {
  const {
    contextTarget, pane, toggleExpand, stableOnOpenEntry, stableOnRefresh, getActionPaths, toTransferSources,
    executeMoveAction, triggerUploadPicker, onUploadExternalFolder, uploadEnabled, folderUploadEnabled,
    setMoveTargetPaths, setMoveToPath, setMoveToError, setMoveToSuggestions, setMoveToSuggestionIndex,
    setIsMoving, setShowMoveToDialog, tRef, onCopyToOtherPaneRef, onNavigateToRef, onOpenFileWithRef,
    onEditFileRef, onDownloadFileRef, onEditPermissionsRef, openDeleteConfirmRef, openRenameDialogRef,
    openNewFolderDialogRef, openNewFileDialogRef,
  } = props;

  return useMemo(() => {
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
        {isDir && (
          <ContextMenuItem onClick={() => onNavigateToRef.current(entryPath)}>
            <ArrowRight size={14} className="mr-2" />{tRef.current('sftp.context.navigateTo')}
          </ContextMenuItem>
        )}
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
        {(() => {
          const sourceParent = getParentPath(entryPath);
          const targetParent = getParentPath(sourceParent);
          if (sourceParent === targetParent) return null;

          return (
          <ContextMenuItem onClick={() => {
            const paths = getActionPaths(entryPath);
            void executeMoveAction(paths, targetParent);
          }}>
            <ArrowUp size={14} className="mr-2" />{tRef.current('sftp.context.moveToParent')}
          </ContextMenuItem>
          );
        })()}
        <ContextMenuItem onClick={() => {
          setMoveTargetPaths(getActionPaths(entryPath));
          setMoveToPath('');
          setMoveToError(null);
          setMoveToSuggestions([]);
          setMoveToSuggestionIndex(-1);
          setIsMoving(false);
          setShowMoveToDialog(true);
        }}>
          <FolderInput size={14} className="mr-2" />{tRef.current('sftp.context.moveTo')}
        </ContextMenuItem>
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
        {uploadEnabled && (
          <ContextMenuItem
            onClick={() => {
              triggerUploadPicker(getSftpTreeUploadFilesTargetPath(entry, entryPath));
            }}
          >
            <Upload size={14} className="mr-2" />{tRef.current(getSftpUploadFilesLabelKey(entry))}
          </ContextMenuItem>
        )}
        {folderUploadEnabled && (
          <ContextMenuItem
            onClick={() => {
              void onUploadExternalFolder?.(getSftpTreeUploadFilesTargetPath(entry, entryPath));
            }}
          >
            <Upload size={14} className="mr-2" />{tRef.current(getSftpUploadFolderLabelKey(entry))}
          </ContextMenuItem>
        )}
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
    executeMoveAction,
    triggerUploadPicker,
    uploadEnabled,
    folderUploadEnabled,
    onUploadExternalFolder,
    onCopyToOtherPaneRef,
    onDownloadFileRef,
    onEditFileRef,
    onEditPermissionsRef,
    onNavigateToRef,
    onOpenFileWithRef,
    openDeleteConfirmRef,
    openNewFileDialogRef,
    openNewFolderDialogRef,
    openRenameDialogRef,
    setIsMoving,
    setMoveTargetPaths,
    setMoveToError,
    setMoveToPath,
    setMoveToSuggestionIndex,
    setMoveToSuggestions,
    setShowMoveToDialog,
    tRef,
  ]);
}
