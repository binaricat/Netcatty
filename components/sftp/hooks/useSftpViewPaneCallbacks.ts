import { useMemo } from "react";
import type { MutableRefObject } from "react";
import type { SftpStateApi } from "../../../application/state/useSftpState";
import type { SftpPaneCallbacks } from "../SftpContext";
import { useSftpViewPaneActions } from "./useSftpViewPaneActions";
import { useSftpViewFileOps } from "./useSftpViewFileOps";
import type { FileOpenerType, SystemAppInfo } from "../../../lib/sftpFileUtils";

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
  showSaveDialog?: (defaultPath: string, filters?: Array<{ name: string; extensions: string[] }>) => Promise<string | null>;
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
    },
    onProgress?: (transferred: number, total: number, speed: number) => void,
    onComplete?: () => void,
    onError?: (error: string) => void
  ) => Promise<{ transferId: string; totalBytes?: number; error?: string }>;
  getSftpIdForConnection?: (connectionId: string) => string | undefined;
}

export const useSftpViewPaneCallbacks = ({
  sftpRef,
  behaviorRef,
  autoSyncRef,
  getOpenerForFileRef,
  setOpenerForExtension,
  t,
  showSaveDialog,
  startStreamTransfer,
  getSftpIdForConnection,
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
    startStreamTransfer,
    getSftpIdForConnection,
  });

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
      onRenameFile: paneActions.onRenameFileLeft,
      onCopyToOtherPane: paneActions.onCopyToOtherPaneLeft,
      onReceiveFromOtherPane: paneActions.onReceiveFromOtherPaneLeft,
      onEditPermissions: fileOps.onEditPermissionsLeft,
      onEditFile: fileOps.onEditFileLeft,
      onOpenFile: fileOps.onOpenFileLeft,
      onOpenFileWith: fileOps.onOpenFileWithLeft,
      onDownloadFile: fileOps.onDownloadFileLeft,
      onUploadExternalFiles: fileOps.onUploadExternalFilesLeft,
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
      onRenameFile: paneActions.onRenameFileRight,
      onCopyToOtherPane: paneActions.onCopyToOtherPaneRight,
      onReceiveFromOtherPane: paneActions.onReceiveFromOtherPaneRight,
      onEditPermissions: fileOps.onEditPermissionsRight,
      onEditFile: fileOps.onEditFileRight,
      onOpenFile: fileOps.onOpenFileRight,
      onOpenFileWith: fileOps.onOpenFileWithRight,
      onDownloadFile: fileOps.onDownloadFileRight,
      onUploadExternalFiles: fileOps.onUploadExternalFilesRight,
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
