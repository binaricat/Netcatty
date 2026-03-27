import { useMemo } from "react";
import type { MutableRefObject } from "react";
import type { SftpStateApi } from "../../../application/state/useSftpState";
import type { RemoteFile, SftpFilenameEncoding } from "../../../types";
import type { SftpPaneCallbacks } from "../SftpContext";
import type { SftpPane } from "../../../application/state/sftp/types";
import { useSftpViewPaneActions } from "./useSftpViewPaneActions";
import { useSftpViewFileOps } from "./useSftpViewFileOps";
import type { FileOpenerType, SystemAppInfo } from "../../../lib/sftpFileUtils";
import { formatFileSize, formatDate } from '../../../application/state/sftp/utils';
import { filterHiddenFiles } from "../utils";

interface UseSftpViewPaneCallbacksParams {
  sftpRef: MutableRefObject<SftpStateApi>;
  behaviorRef: MutableRefObject<string>;
  autoSyncRef: MutableRefObject<boolean>;
  getOpenerForFileRef: MutableRefObject<
    (fileName: string) => { openerType?: FileOpenerType; systemApp?: SystemAppInfo } | null
  >;
  setOpenerForExtension: (
    extension: string,
    openerType: FileOpenerType,
    systemApp?: SystemAppInfo,
  ) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  listSftp?: (sftpId: string, path: string, encoding?: SftpFilenameEncoding) => Promise<RemoteFile[]>;
  mkdirLocal?: (path: string) => Promise<unknown>;
  deleteLocalFile?: (path: string) => Promise<unknown>;
  showSaveDialog?: (defaultPath: string, filters?: Array<{ name: string; extensions: string[] }>) => Promise<string | null>;
  selectDirectory?: (title?: string, defaultPath?: string) => Promise<string | null>;
  startStreamTransfer?: (
    options: {
      transferId: string;
      sourcePath: string;
      targetPath: string;
      sourceType: 'local' | 'sftp';
      targetType: 'local' | 'sftp';
      sourceSftpId?: string;
      targetSftpId?: string;
      totalBytes?: number;
      sourceEncoding?: SftpFilenameEncoding;
      targetEncoding?: SftpFilenameEncoding;
    },
    onProgress?: (transferred: number, total: number, speed: number) => void,
    onComplete?: () => void,
    onError?: (error: string) => void
  ) => Promise<{ transferId: string; totalBytes?: number; error?: string }>;
  getSftpIdForConnection?: (connectionId: string) => string | undefined;
  listLocalFiles: (path: string) => Promise<RemoteFile[]>;
}

export const useSftpViewPaneCallbacks = ({
  sftpRef,
  behaviorRef,
  autoSyncRef,
  getOpenerForFileRef,
  setOpenerForExtension,
  t,
  listSftp,
  mkdirLocal,
  deleteLocalFile,
  showSaveDialog,
  selectDirectory,
  startStreamTransfer,
  getSftpIdForConnection,
  listLocalFiles,
}: UseSftpViewPaneCallbacksParams) => {
  const paneActions = useSftpViewPaneActions({ sftpRef });
  const fileOps = useSftpViewFileOps({
    sftpRef,
    behaviorRef,
    autoSyncRef,
    getOpenerForFileRef,
    setOpenerForExtension,
    t,
    listSftp,
    mkdirLocal,
    deleteLocalFile,
    showSaveDialog,
    selectDirectory,
    startStreamTransfer,
    getSftpIdForConnection,
  });

  const makeListDirectory = (getPane: () => SftpPane) =>
    async (path: string) => {
      const pane = getPane();
      if (!pane.connection) return [];
      const toSize = (raw: string) => parseInt(raw) || 0;
      const toTs = (raw: string) => new Date(raw).getTime();
      const normalizeEntries = (rawFiles: RemoteFile[]) =>
        filterHiddenFiles(
          rawFiles.map(f => {
            const s = toSize(f.size);
            const ms = toTs(f.lastModified);
            return {
              name: f.name,
              type: f.type as 'file' | 'directory' | 'symlink',
              size: s,
              sizeFormatted: formatFileSize(s),
              lastModified: ms,
              lastModifiedFormatted: formatDate(ms),
              permissions: f.permissions,
              linkTarget: f.linkTarget as 'file' | 'directory' | null | undefined,
              hidden: f.hidden,
            };
          }),
          pane.showHiddenFiles,
        );
      if (pane.connection.isLocal) {
        return normalizeEntries(await listLocalFiles(path));
      }
      const sftpId = getSftpIdForConnection?.(pane.connection.id);
      if (!sftpId) return [];
      const rawFiles = await listSftp?.(sftpId, path, pane.filenameEncoding);
      if (!rawFiles) return [];
      return normalizeEntries(rawFiles);
    };

  /* eslint-disable react-hooks/exhaustive-deps -- Handlers use refs, so they are stable */
  const leftCallbacks = useMemo<SftpPaneCallbacks>(
    () => ({
      onConnect: paneActions.onConnectLeft,
      onDisconnect: paneActions.onDisconnectLeft,
      onNavigateTo: paneActions.onNavigateToLeft,
      onNavigateUp: paneActions.onNavigateUpLeft,
      onRefresh: paneActions.onRefreshLeft,
      onSetFilenameEncoding: paneActions.onSetFilenameEncodingLeft,
      onOpenEntry: fileOps.onOpenEntryLeft,
      onToggleSelection: paneActions.onToggleSelectionLeft,
      onRangeSelect: paneActions.onRangeSelectLeft,
      onClearSelection: paneActions.onClearSelectionLeft,
      onSetFilter: paneActions.onSetFilterLeft,
      onCreateDirectory: paneActions.onCreateDirectoryLeft,
      onCreateFile: paneActions.onCreateFileLeft,
      onDeleteFiles: paneActions.onDeleteFilesLeft,
      onDeleteFilesAtPath: paneActions.onDeleteFilesAtPathLeft,
      onRenameFile: paneActions.onRenameFileLeft,
      onRenameFileAtPath: paneActions.onRenameFileAtPathLeft,
      onCopyToOtherPane: paneActions.onCopyToOtherPaneLeft,
      onReceiveFromOtherPane: paneActions.onReceiveFromOtherPaneLeft,
      onEditPermissions: fileOps.onEditPermissionsLeft,
      onEditFile: fileOps.onEditFileLeft,
      onOpenFile: fileOps.onOpenFileLeft,
      onOpenFileWith: fileOps.onOpenFileWithLeft,
      onDownloadFile: fileOps.onDownloadFileLeft,
      onUploadExternalFiles: fileOps.onUploadExternalFilesLeft,
      onListDirectory: makeListDirectory(() => sftpRef.current.leftPane),
    }),
    [],
  );

  const rightCallbacks = useMemo<SftpPaneCallbacks>(
    () => ({
      onConnect: paneActions.onConnectRight,
      onDisconnect: paneActions.onDisconnectRight,
      onNavigateTo: paneActions.onNavigateToRight,
      onNavigateUp: paneActions.onNavigateUpRight,
      onRefresh: paneActions.onRefreshRight,
      onSetFilenameEncoding: paneActions.onSetFilenameEncodingRight,
      onOpenEntry: fileOps.onOpenEntryRight,
      onToggleSelection: paneActions.onToggleSelectionRight,
      onRangeSelect: paneActions.onRangeSelectRight,
      onClearSelection: paneActions.onClearSelectionRight,
      onSetFilter: paneActions.onSetFilterRight,
      onCreateDirectory: paneActions.onCreateDirectoryRight,
      onCreateFile: paneActions.onCreateFileRight,
      onDeleteFiles: paneActions.onDeleteFilesRight,
      onDeleteFilesAtPath: paneActions.onDeleteFilesAtPathRight,
      onRenameFile: paneActions.onRenameFileRight,
      onRenameFileAtPath: paneActions.onRenameFileAtPathRight,
      onCopyToOtherPane: paneActions.onCopyToOtherPaneRight,
      onReceiveFromOtherPane: paneActions.onReceiveFromOtherPaneRight,
      onEditPermissions: fileOps.onEditPermissionsRight,
      onEditFile: fileOps.onEditFileRight,
      onOpenFile: fileOps.onOpenFileRight,
      onOpenFileWith: fileOps.onOpenFileWithRight,
      onDownloadFile: fileOps.onDownloadFileRight,
      onUploadExternalFiles: fileOps.onUploadExternalFilesRight,
      onListDirectory: makeListDirectory(() => sftpRef.current.rightPane),
    }),
    [],
  );
  /* eslint-enable react-hooks/exhaustive-deps */

  return {
    leftCallbacks,
    rightCallbacks,
    dragCallbacks: paneActions.dragCallbacks,
    draggedFiles: paneActions.draggedFiles,
    permissionsState: fileOps.permissionsState,
    setPermissionsState: fileOps.setPermissionsState,
    showTextEditor: fileOps.showTextEditor,
    setShowTextEditor: fileOps.setShowTextEditor,
    textEditorTarget: fileOps.textEditorTarget,
    setTextEditorTarget: fileOps.setTextEditorTarget,
    textEditorContent: fileOps.textEditorContent,
    setTextEditorContent: fileOps.setTextEditorContent,
    loadingTextContent: fileOps.loadingTextContent,
    showFileOpenerDialog: fileOps.showFileOpenerDialog,
    setShowFileOpenerDialog: fileOps.setShowFileOpenerDialog,
    fileOpenerTarget: fileOps.fileOpenerTarget,
    setFileOpenerTarget: fileOps.setFileOpenerTarget,
    handleSaveTextFile: fileOps.handleSaveTextFile,
    handleFileOpenerSelect: fileOps.handleFileOpenerSelect,
    handleSelectSystemApp: fileOps.handleSelectSystemApp,
  };
};
