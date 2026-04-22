import { useEffect, useMemo, useRef } from "react";
import type { MutableRefObject } from "react";
import type { SftpStateApi } from "../../../application/state/useSftpState";
import type { RemoteFile, SftpFilenameEncoding } from "../../../types";
import type { SftpPaneCallbacks } from "../SftpContext";
import type { SftpPane } from "../../../application/state/sftp/types";
import { useSftpViewPaneActions } from "./useSftpViewPaneActions";
import { useSftpViewFileOps } from "./useSftpViewFileOps";
import type { FileOpenerType, SystemAppInfo } from "../../../lib/sftpFileUtils";
import { formatFileSize, formatDate } from '../../../application/state/sftp/utils';
import { isSessionError } from "../../../application/state/sftp/errors";
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
  mkdirLocal?: (path: string) => Promise<void>;
  deleteLocalFile?: (path: string) => Promise<void>;
}

export const useSftpViewPaneCallbacks = ({
  sftpRef,
  behaviorRef,
  autoSyncRef,
  getOpenerForFileRef,
  setOpenerForExtension,
  t,
  listSftp,
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
    showSaveDialog,
    selectDirectory,
    startStreamTransfer,
    getSftpIdForConnection,
  });

  const listLocalFilesRef = useRef(listLocalFiles);
  const listSftpRef = useRef(listSftp);
  const getSftpIdForConnectionRef = useRef(getSftpIdForConnection);

  useEffect(() => {
    listLocalFilesRef.current = listLocalFiles;
    listSftpRef.current = listSftp;
    getSftpIdForConnectionRef.current = getSftpIdForConnection;
  }, [listLocalFiles, listSftp, getSftpIdForConnection]);

  const makeListDirectory = (side: "left" | "right", getPane: () => SftpPane) =>
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
        return normalizeEntries(await listLocalFilesRef.current(path));
      }
      const sftpId = getSftpIdForConnectionRef.current?.(pane.connection.id);
      if (!sftpId) {
        const error = new Error("SFTP session not found");
        sftpRef.current.reportSessionError(side, error);
        throw error;
      }

      let rawFiles: RemoteFile[] | undefined;
      try {
        rawFiles = await listSftpRef.current?.(sftpId, path, pane.filenameEncoding);
      } catch (err) {
        if (isSessionError(err)) {
          sftpRef.current.reportSessionError(side, err as Error);
        }
        throw err;
      }

      if (!rawFiles) return [];
      return normalizeEntries(rawFiles);
    };

  /* eslint-disable react-hooks/exhaustive-deps -- Handlers use refs, so they are stable */
  const leftCallbacks = useMemo<SftpPaneCallbacks>(
    () => ({
      onConnect: paneActions.onConnectLeft,
      onDisconnect: paneActions.onDisconnectLeft,
      onPrepareSelection: paneActions.onPrepareSelectionLeft,
      onNavigateTo: paneActions.onNavigateToLeft,
      onNavigateUp: paneActions.onNavigateUpLeft,
      onRefresh: paneActions.onRefreshLeft,
      onRefreshTab: paneActions.onRefreshTabLeft,
      onSetFilenameEncoding: paneActions.onSetFilenameEncodingLeft,
      onOpenEntry: fileOps.onOpenEntryLeft,
      onToggleSelection: paneActions.onToggleSelectionLeft,
      onRangeSelect: paneActions.onRangeSelectLeft,
      onClearSelection: paneActions.onClearSelectionLeft,
      onSetFilter: paneActions.onSetFilterLeft,
      onCreateDirectory: paneActions.onCreateDirectoryLeft,
      onCreateDirectoryAtPath: paneActions.onCreateDirectoryAtPathLeft,
      onCreateFile: paneActions.onCreateFileLeft,
      onCreateFileAtPath: paneActions.onCreateFileAtPathLeft,
      onDeleteFiles: paneActions.onDeleteFilesLeft,
      onDeleteFilesAtPath: paneActions.onDeleteFilesAtPathLeft,
      onRenameFile: paneActions.onRenameFileLeft,
      onRenameFileAtPath: paneActions.onRenameFileAtPathLeft,
      onMoveEntriesToPath: paneActions.onMoveEntriesToPathLeft,
      onCopyToOtherPane: paneActions.onCopyToOtherPaneLeft,
      onReceiveFromOtherPane: paneActions.onReceiveFromOtherPaneLeft,
      onEditPermissions: fileOps.onEditPermissionsLeft,
      onEditFile: fileOps.onEditFileLeft,
      onOpenFile: fileOps.onOpenFileLeft,
      onOpenFileWith: fileOps.onOpenFileWithLeft,
      onDownloadFile: fileOps.onDownloadFileLeft,
      onUploadExternalFiles: fileOps.onUploadExternalFilesLeft,
      onListDirectory: makeListDirectory("left", () => sftpRef.current.leftPane),
    }),
    [],
  );

  const rightCallbacks = useMemo<SftpPaneCallbacks>(
    () => ({
      onConnect: paneActions.onConnectRight,
      onDisconnect: paneActions.onDisconnectRight,
      onPrepareSelection: paneActions.onPrepareSelectionRight,
      onNavigateTo: paneActions.onNavigateToRight,
      onNavigateUp: paneActions.onNavigateUpRight,
      onRefresh: paneActions.onRefreshRight,
      onRefreshTab: paneActions.onRefreshTabRight,
      onSetFilenameEncoding: paneActions.onSetFilenameEncodingRight,
      onOpenEntry: fileOps.onOpenEntryRight,
      onToggleSelection: paneActions.onToggleSelectionRight,
      onRangeSelect: paneActions.onRangeSelectRight,
      onClearSelection: paneActions.onClearSelectionRight,
      onSetFilter: paneActions.onSetFilterRight,
      onCreateDirectory: paneActions.onCreateDirectoryRight,
      onCreateDirectoryAtPath: paneActions.onCreateDirectoryAtPathRight,
      onCreateFile: paneActions.onCreateFileRight,
      onCreateFileAtPath: paneActions.onCreateFileAtPathRight,
      onDeleteFiles: paneActions.onDeleteFilesRight,
      onDeleteFilesAtPath: paneActions.onDeleteFilesAtPathRight,
      onRenameFile: paneActions.onRenameFileRight,
      onRenameFileAtPath: paneActions.onRenameFileAtPathRight,
      onMoveEntriesToPath: paneActions.onMoveEntriesToPathRight,
      onCopyToOtherPane: paneActions.onCopyToOtherPaneRight,
      onReceiveFromOtherPane: paneActions.onReceiveFromOtherPaneRight,
      onEditPermissions: fileOps.onEditPermissionsRight,
      onEditFile: fileOps.onEditFileRight,
      onOpenFile: fileOps.onOpenFileRight,
      onOpenFileWith: fileOps.onOpenFileWithRight,
      onDownloadFile: fileOps.onDownloadFileRight,
      onUploadExternalFiles: fileOps.onUploadExternalFilesRight,
      onListDirectory: makeListDirectory("right", () => sftpRef.current.rightPane),
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
    onPromoteToTab: fileOps.onPromoteToTab,
    handleFileOpenerSelect: fileOps.handleFileOpenerSelect,
    handleSelectSystemApp: fileOps.handleSelectSystemApp,
  };
};
