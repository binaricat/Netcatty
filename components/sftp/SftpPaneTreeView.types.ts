import type React from 'react';
import type { SftpFileEntry } from '../../types';
import type { SftpPane } from '../../application/state/sftp/types';
import type { SftpTransferSource } from './SftpContext';
import type { ColumnWidths, SortField, SortOrder } from './utils';

export interface SftpPaneTreeViewProps {
  pane: SftpPane;
  side: 'left' | 'right';
  onPrepareSelection: () => void;
  onLoadChildren: (path: string) => Promise<SftpFileEntry[]>;
  onMoveEntriesToPath: (sourcePaths: string[], targetPath: string) => Promise<void>;
  onNavigateUp: () => void;
  onNavigateTo: (path: string) => void;
  onRefresh: () => void;
  onOpenEntry: (entry: SftpFileEntry, fullPath?: string) => void;
  onDragStart: (files: SftpTransferSource[], side: 'left' | 'right') => void;
  onDragEnd: () => void;
  openRenameDialog: (entryPath: string) => void;
  openDeleteConfirm: (targets: string[]) => void;
  onCopyToOtherPane: (files: SftpTransferSource[]) => void;
  onReceiveFromOtherPane: (files: SftpTransferSource[]) => void;
  onOpenFileWith?: (entry: SftpFileEntry, fullPath?: string) => void;
  onEditFile?: (entry: SftpFileEntry, fullPath?: string) => void;
  onDownloadFile?: (entry: SftpFileEntry, fullPath?: string) => void;
  onEditPermissions?: (entry: SftpFileEntry, fullPath?: string) => void;
  draggedFiles: (SftpTransferSource & { side: 'left' | 'right' })[] | null;
  openNewFolderDialog: (targetPath: string) => void;
  openNewFileDialog: (targetPath: string) => void;
  onUploadExternalFiles?: (dataTransfer: DataTransfer, targetPath?: string) => Promise<void>;
  onUploadExternalFileList?: (fileList: FileList, targetPath?: string) => Promise<void>;
  onUploadExternalFolder?: (targetPath?: string) => Promise<void>;
  columnWidths: ColumnWidths;
  handleSort: (field: SortField) => void;
  handleResizeStart: (field: keyof ColumnWidths, e: React.MouseEvent) => void;
  sortField: SortField;
  sortOrder: SortOrder;
  reloadRequest: { token: number; paths?: string[]; full?: boolean };
}
