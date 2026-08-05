import type React from "react";
import type { FileConflict, FileConflictAction, Host, SftpFilenameEncoding } from "../../../domain/models";
import type { UploadResult } from "../../../lib/uploadService";
import type { DropEntry } from "../../../lib/sftpFileUtils";
import type { SftpPane } from "./types";
import type { UploadEndpointPin } from "./uploadTargetPin";

export interface UseSftpExternalOperationsParams {
  ownerId: string;
  getActivePane: (side: "left" | "right") => SftpPane | null;
  getPaneByConnectionId: (connectionId: string) => SftpPane | null;
  getPaneByTabId: (tabId: string) => SftpPane | null;
  getTabByConnectionId?: (connectionId: string) => {
    side: "left" | "right";
    tabId: string;
    pane: SftpPane;
  } | null;
  getSideByTabId?: (tabId: string) => "left" | "right" | null;
  refresh: (side: "left" | "right", options?: { tabId?: string }) => Promise<void>;
  sftpSessionsRef: React.MutableRefObject<Map<string, string>>;
  connectionCacheKeyMapRef: React.MutableRefObject<Map<string, string>>;
  /**
   * Ensure a live remote SFTP session for the pane (reconnect when missing/dead).
   * Required for uploads/downloads that must not fail with "SFTP session not found".
   */
  ensureRemoteSftpId?: (
    side: "left" | "right",
    options?: { forceReconnect?: boolean; connectionId?: string; tabId?: string },
  ) => Promise<string>;
  /**
   * Per-tab connect-time host (includes session hostname/port/user overrides).
   * Used so pooled stream uploads open the pinned browse endpoint.
   */
  resolveConnectedHost?: (tabId: string) => Host | "local" | null | undefined;
  /**
   * FileZilla-style dedicated transfer sessions for bulk uploads.
   * When set, remote stream uploads prefer pool connections (1–2/host)
   * over the browse session so interactive listing stays responsive.
   */
  acquireTransferSession?: (
    hostId: string,
    transferId: string,
    connectHost?: Host,
  ) => Promise<{ sftpId: string; release: () => void; discard: () => void }>;
  clearDirCacheEntry?: (connectionId: string, path: string) => void;
  useCompressedUpload?: boolean;
  isTransferCancelled?: (taskId: string) => boolean;
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
    sftpTabId?: string,
  ) => Promise<string>;
  downloadToTempAndOpen: (
    side: "left" | "right",
    remotePath: string,
    fileName: string,
    appPath: string,
    options?: { enableWatch?: boolean }
  ) => Promise<{ localTempPath: string; watchId?: string }>;
  openWithSystemDefault: (side: "left" | "right", remotePath: string, fileName: string, options?: { enableWatch?: boolean }) => Promise<void>;
  activeFileWatchCountRef: React.MutableRefObject<number>;
  /** Remote temps opened in an external editor; keeps browse sessions from parking. */
  activeExternalEditCount: number;
  /** Drop retainers after closeSftp deletes that session's registered temps. */
  forgetExternalEditTempsForSftp: (sftpId: string) => void;
  releaseExternalFileWatches: (cleanupTempFiles?: boolean) => Promise<void>;
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
    targetPath?: string,
    options?: { connectionId?: string; tabId?: string; endpointPin?: UploadEndpointPin },
  ) => Promise<UploadResult[]>;
  uploadExternalEntries: (
    side: "left" | "right",
    entries: DropEntry[],
    options?: { targetPath?: string; connectionId?: string; tabId?: string; endpointPin?: UploadEndpointPin },
  ) => Promise<UploadResult[]>;
  cancelExternalUpload: (taskId?: string) => Promise<void>;
  selectApplication: () => Promise<{ path: string; name: string } | null>;
  uploadConflicts: FileConflict[];
  resolveUploadConflict: (conflictId: string, action: FileConflictAction, applyToAll?: boolean) => void;
}
