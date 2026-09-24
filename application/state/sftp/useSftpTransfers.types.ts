import type { MutableRefObject } from "react";
import type { FileConflict, FileConflictAction, LocalDownloadTargetExpectation, SftpFileEntry, SftpFilenameEncoding, TransferStatus, TransferTask } from "../../../domain/models";
import type { SftpPane } from "./types";
import type { AcquireTransferSessionFn } from "./transferDirectoryOps";

export interface UseSftpTransfersParams {
  ownerId: string;
  canPrepareAdoption?: boolean;
  /** False when SFTP side panel is retained-but-hidden after close. */
  surfaceVisible?: boolean;
  getActivePane: (side: "left" | "right") => SftpPane | null;
  getPaneByConnectionId: (connectionId: string) => SftpPane | null;
  getTabByConnectionId: (connectionId: string) => { side: "left" | "right"; tabId: string; pane: SftpPane } | null;
  updateTab: (side: "left" | "right", tabId: string, updater: (pane: SftpPane) => SftpPane) => void;
  refresh: (side: "left" | "right", options?: { tabId?: string }) => Promise<void>;
  clearCacheForConnection: (connectionId: string) => void;
  sftpSessionsRef: MutableRefObject<Map<string, string>>;
  connectionCacheKeyMapRef: MutableRefObject<Map<string, string>>;
  listLocalFiles: (path: string) => Promise<SftpFileEntry[]>;
  listRemoteFiles: (sftpId: string, path: string, encoding?: SftpFilenameEncoding) => Promise<SftpFileEntry[]>;
  handleSessionError: (side: "left" | "right", error: Error) => void;
  /** FileZilla-style dedicated transfer sessions (1–2 per host). */
  acquireTransferSession?: AcquireTransferSessionFn;
}

export interface UseSftpTransfersResult {
  transfers: TransferTask[];
  conflicts: FileConflict[];
  activeTransfersCount: number;
  startTransfer: (
    sourceFiles: { name: string; isDirectory: boolean }[],
    sourceSide: "left" | "right",
    targetSide: "left" | "right",
    options?: {
      sourcePane?: SftpPane;
      sourcePath?: string;
      sourceConnectionId?: string;
      targetPath?: string;
      onTransferComplete?: (result: TransferResult) => void | Promise<void>;
    },
  ) => Promise<TransferResult[]>;
  downloadToLocal: (params: {
    fileName: string;
    sourcePath: string;
    targetPath: string;
    expectedLocalTarget?: LocalDownloadTargetExpectation;
    sftpId: string;
    connectionId: string;
    sourceHostId: string;
    sourceHostLabel: string;
    sourceEncoding?: SftpFilenameEncoding;
    isDirectory: boolean;
    totalBytes?: number;
  }) => Promise<TransferStatus>;
  cancelTransfer: (transferId: string) => Promise<void>;
  pauseTransfer: (transferId: string) => Promise<void>;
  resumeTransfer: (transferId: string) => Promise<void>;
  prioritizeTransfer: (transferId: string) => void;
  isTransferCancelled: (transferId: string) => boolean;
  retryTransfer: (transferId: string) => Promise<void>;
  clearCompletedTransfers: () => void;
  dismissTransfer: (transferId: string) => void;
  resolveConflict: (conflictId: string, action: FileConflictAction, applyToAll?: boolean) => Promise<void>;
}

export interface TransferResult {
  id: string;
  fileName: string;
  originalFileName?: string;
  status: TransferStatus;
}
