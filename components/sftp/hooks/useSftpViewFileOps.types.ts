import type React from "react";
import type { MutableRefObject } from "react";
import type { SftpFileEntry, SftpFilenameEncoding } from "../../../types";
import type { SftpStateApi } from "../../../application/state/useSftpState";
import type { FileOpenerType, SystemAppInfo } from "../../../lib/sftpFileUtils";
import type { TextEditorModalSnapshot } from "../../TextEditorModal";

export interface UseSftpViewFileOpsParams {
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
}

export interface UseSftpViewFileOpsResult {
  permissionsState: { file: SftpFileEntry; side: "left" | "right"; fullPath: string } | null;
  setPermissionsState: React.Dispatch<
    React.SetStateAction<{ file: SftpFileEntry; side: "left" | "right"; fullPath: string } | null>
  >;
  showTextEditor: boolean;
  setShowTextEditor: React.Dispatch<React.SetStateAction<boolean>>;
  textEditorTarget: {
    file: SftpFileEntry;
    side: "left" | "right";
    fullPath: string;
  } | null;
  setTextEditorTarget: React.Dispatch<
    React.SetStateAction<{
      file: SftpFileEntry;
      side: "left" | "right";
      fullPath: string;
    } | null>
  >;
  textEditorContent: string;
  setTextEditorContent: React.Dispatch<React.SetStateAction<string>>;
  loadingTextContent: boolean;
  showFileOpenerDialog: boolean;
  setShowFileOpenerDialog: React.Dispatch<React.SetStateAction<boolean>>;
  fileOpenerTarget: {
    file: SftpFileEntry;
    side: "left" | "right";
    fullPath: string;
  } | null;
  setFileOpenerTarget: React.Dispatch<
    React.SetStateAction<{
      file: SftpFileEntry;
      side: "left" | "right";
      fullPath: string;
    } | null>
  >;
  handleSaveTextFile: (content: string) => Promise<void>;
  onPromoteToTab: (snapshot: TextEditorModalSnapshot) => void;
  handleFileOpenerSelect: (
    openerType: FileOpenerType,
    setAsDefault: boolean,
    systemApp?: SystemAppInfo,
  ) => Promise<void>;
  handleSelectSystemApp: () => Promise<SystemAppInfo | null>;
  onEditPermissionsLeft: (file: SftpFileEntry, fullPath?: string) => void;
  onEditPermissionsRight: (file: SftpFileEntry, fullPath?: string) => void;
  onOpenEntryLeft: (entry: SftpFileEntry, fullPath?: string) => void;
  onOpenEntryRight: (entry: SftpFileEntry, fullPath?: string) => void;
  onEditFileLeft: (file: SftpFileEntry, fullPath?: string) => void;
  onEditFileRight: (file: SftpFileEntry, fullPath?: string) => void;
  onOpenFileLeft: (file: SftpFileEntry, fullPath?: string) => void;
  onOpenFileRight: (file: SftpFileEntry, fullPath?: string) => void;
  onOpenFileWithLeft: (file: SftpFileEntry, fullPath?: string) => void;
  onOpenFileWithRight: (file: SftpFileEntry, fullPath?: string) => void;
  onDownloadFileLeft: (file: SftpFileEntry, fullPath?: string) => void;
  onDownloadFileRight: (file: SftpFileEntry, fullPath?: string) => void;
  onDownloadFilesLeft: (files: SftpFileEntry[]) => void;
  onDownloadFilesRight: (files: SftpFileEntry[]) => void;
  onUploadExternalFilesLeft: (dataTransfer: DataTransfer, targetPath?: string) => void;
  onUploadExternalFilesRight: (dataTransfer: DataTransfer, targetPath?: string) => void;
  onUploadExternalFileListLeft: (fileList: FileList, targetPath?: string) => void;
  onUploadExternalFileListRight: (fileList: FileList, targetPath?: string) => void;
  onUploadExternalFolderLeft: (targetPath?: string) => Promise<void>;
  onUploadExternalFolderRight: (targetPath?: string) => Promise<void>;
}

