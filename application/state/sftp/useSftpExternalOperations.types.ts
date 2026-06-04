import type React from "react";
import type { FileConflict, FileConflictAction, TransferTask, SftpFilenameEncoding } from "../../../domain/models";
import type { UploadResult } from "../../../lib/uploadService";
import type { DropEntry } from "../../../lib/sftpFileUtils";
import type { SftpPane } from "./types";

export interface UseSftpExternalOperationsParams {
  getActivePane: (side: "left" | "right") => SftpPane | null;
  getPaneByConnectionId: (connectionId: string) => SftpPane | null;
  refresh: (side: "left" | "right", options?: { tabId?: string }) => Promise<void>;
  sftpSessionsRef: React.MutableRefObject<Map<string, string>>;
  connectionCacheKeyMapRef: React.MutableRefObject<Map<string, string>>;
  clearDirCacheEntry?: (connectionId: string, path: string) => void;
  useCompressedUpload?: boolean;
  addExternalUpload?: (task: TransferTask) => void;
  updateExternalUpload?: (taskId: string, updates: Partial<TransferTask>) => void;
  isTransferCancelled?: (taskId: string) => boolean;
  dismissExternalUpload?: (taskId: string) => void;
}

export interface SftpExternalOperationsResult {
  readTextFile: (side: "left" | "right", filePath: string) => Promise<string>;
  readBinaryFile: (side: "left" | "right", filePath: string) => Promise<ArrayBuffer>;
  writeTextFile: (side: "left" | "right", filePath: string, content: string) => Promise<void>;
  writeTextFileByConnection: (
    connectionId: string,
    expectedHostId: string,
    filePath: string,
    content: string,
    filenameEncoding?: SftpFilenameEncoding,
  ) => Promise<void>;
  downloadToTempAndOpen: (
    side: "left" | "right",
    remotePath: string,
    fileName: string,
    appPath: string,
    options?: { enableWatch?: boolean }
  ) => Promise<{ localTempPath: string; watchId?: string }>;
  openWithSystemDefault: (side: "left" | "right", remotePath: string, fileName: string, options?: { enableWatch?: boolean }) => Promise<void>;
  activeFileWatchCountRef: React.MutableRefObject<number>;
  uploadExternalFiles: (
    side: "left" | "right",
    dataTransfer: DataTransfer,
    targetPath?: string
  ) => Promise<UploadResult[]>;
  uploadExternalFileList: (
    side: "left" | "right",
    fileList: FileList | File[],
    targetPath?: string
  ) => Promise<UploadResult[]>;
  uploadExternalFolderPath: (
    side: "left" | "right",
    folderPath: string,
    targetPath?: string
  ) => Promise<UploadResult[]>;
  uploadExternalEntries: (
    side: "left" | "right",
    entries: DropEntry[],
    options?: { targetPath?: string }
  ) => Promise<UploadResult[]>;
  cancelExternalUpload: () => Promise<void>;
  selectApplication: () => Promise<{ path: string; name: string } | null>;
  uploadConflicts: FileConflict[];
  resolveUploadConflict: (conflictId: string, action: FileConflictAction, applyToAll?: boolean) => void;
}
