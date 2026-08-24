import type { RemoteFile, SftpFilenameEncoding, TransferDirection } from "../../types";

declare global {
  interface NetcattyBridge {
    // SFTP operations
    openSftp(options: NetcattySSHOptions): Promise<string>;
    openSftpForSession?(sessionId: string, options?: NetcattySSHOptions): Promise<string>;
    listSftp(sftpId: string, path: string, encoding?: SftpFilenameEncoding): Promise<RemoteFile[]>;
    realpathSftp?(sftpId: string, path: string, encoding?: SftpFilenameEncoding): Promise<string>;
    readSftp(sftpId: string, path: string, encoding?: SftpFilenameEncoding): Promise<string>;
    readSftpBinary?(sftpId: string, path: string, encoding?: SftpFilenameEncoding): Promise<ArrayBuffer>;
    writeSftp(sftpId: string, path: string, content: string, encoding?: SftpFilenameEncoding): Promise<void>;
    writeSftpBinary?(sftpId: string, path: string, content: ArrayBuffer, encoding?: SftpFilenameEncoding): Promise<void>;
    closeSftp(sftpId: string): Promise<void | { success?: boolean; deferred?: boolean; leaseCount?: number }>;
    retainSftpTransferSession?(sftpId: string, leaseId: string): Promise<{ success: boolean; reason?: string }>;
    releaseSftpTransferSession?(sftpId: string, leaseId: string): Promise<{ success: boolean; reason?: string }>;
    mkdirSftp(sftpId: string, path: string, encoding?: SftpFilenameEncoding): Promise<void>;
    deleteSftp?(
      sftpId: string,
      path: string,
      encoding?: SftpFilenameEncoding,
      expectedType?: SftpStatResult["type"],
    ): Promise<void>;
    renameSftp?(sftpId: string, oldPath: string, newPath: string, encoding?: SftpFilenameEncoding): Promise<void>;
    statSftp?(sftpId: string, path: string, encoding?: SftpFilenameEncoding): Promise<SftpStatResult>;
    /** No-follow remote metadata for conflict detection (symlink vs target). Missing path → null. */
    lstatSftp?(sftpId: string, path: string, encoding?: SftpFilenameEncoding): Promise<SftpStatResult | null>;
    chmodSftp?(sftpId: string, path: string, mode: string, encoding?: SftpFilenameEncoding): Promise<void>;
    /** Extract a remote archive into its parent directory via SSH exec. */
    extractSftpArchive?(sftpId: string, path: string, encoding?: SftpFilenameEncoding): Promise<{ success: boolean }>;
    getSftpHomeDir?(sftpId: string, encoding?: SftpFilenameEncoding): Promise<{ success: boolean; homeDir?: string; error?: string }>;

    // Transfer with progress
    cancelTransfer?(transferId: string): Promise<void>;
    /** Clear a pre-start cancel latch so intentional same-id resume/retry can run. */
    clearPendingTransferCancel?(transferId: string): Promise<{ success: boolean } | void>;
    sameHostCopyDirectory?(sftpId: string, sourcePath: string, targetPath: string, encoding?: SftpFilenameEncoding, transferId?: string): Promise<{ success: boolean }>;

    // Compressed folder upload
    startCompressedUpload?(
      options: {
        compressionId: string;
        folderPath: string;
        targetPath: string;
        sftpId: string;
        folderName: string;
        totalBytes: number;
      }
    ): Promise<{ compressionId: string; success?: boolean; error?: string }>;
    cancelCompressedUpload?(compressionId: string): Promise<{ success: boolean }>;
    pauseCompressedUpload?(compressionId: string): Promise<{ success: boolean; deferred?: boolean; lifecycleEpoch?: number; reason?: string }>;
    resumeCompressedUpload?(compressionId: string): Promise<{ success: boolean; lifecycleEpoch?: number; reason?: string }>;
    checkCompressedUploadSupport?(sftpId: string): Promise<{
      supported: boolean;
      localTar: boolean;
      remoteTar: boolean;
      error?: string;
    }>;

    // Streaming transfer with real progress and cancellation
    startStreamTransfer?(
      options: {
        transferId: string;
        sourcePath: string;
        targetPath: string;
        sourceType: 'local' | 'sftp';
        targetType: 'local' | 'sftp';
        sourceSftpId?: string;
        targetSftpId?: string;
        sourceHostId?: string;
        targetHostId?: string;
        parentTaskId?: string;
        directoryEntryIndex?: number;
        directoryEntryIdentity?: string;
        totalBytes?: number;
        sourceEncoding?: SftpFilenameEncoding;
        targetEncoding?: SftpFilenameEncoding;
        sameHost?: boolean;
        resumable?: boolean;
        checkpointBytes?: number;
        resumeStage?: 'direct' | 'download' | 'upload';
        downloadCheckpointBytes?: number;
        uploadCheckpointBytes?: number;
        sourceFingerprint?: string;
        lifecycleEpoch?: number;
        lifecycleState?: 'queued' | 'pausing' | 'paused' | 'transferring';
        pauseUnavailableReason?: string;
        globalConcurrency?: number;
        /** When true, skip main-process admission (renderer already scheduled). */
        skipAdmission?: boolean;
      }
    ): Promise<{ transferId: string; totalBytes?: number; error?: string; cancelled?: boolean }>;
    pauseTransfer?(transferId: string): Promise<{
      success: boolean;
      checkpointBytes?: number;
      resumeStage?: 'direct' | 'download' | 'upload';
      downloadCheckpointBytes?: number;
      uploadCheckpointBytes?: number;
      sourceFingerprint?: string;
      lifecycleEpoch?: number;
      reason?: string;
    }>;
    resumeTransfer?(transferId: string): Promise<{ success: boolean; reason?: string; lifecycleEpoch?: number }>;
    prioritizeTransfer?(transferId: string): Promise<{ success: boolean }>;
    setGlobalTransferConcurrency?(limit: number): Promise<{ success: boolean; limit: number }>;
    cleanupTransferArtifacts?(payload: {
      transferId: string;
      sourcePath: string;
      targetPath: string;
      targetSftpId?: string;
      targetEncoding?: SftpFilenameEncoding;
      stagedTargetPath?: string;
    }): Promise<{ success: boolean }>;
    onGlobalSftpTransferEvent?(callback: (event: {
      type: 'queued' | 'started' | 'progress' | 'pausing' | 'paused' | 'resumed' | 'cancelled' | 'completed' | 'failed';
      transferId: string;
      direction?: TransferDirection;
      fileName?: string;
      sourcePath?: string;
      targetPath?: string;
      startedAt?: number;
      endedAt?: number;
      error?: string;
      transferred?: number;
      totalBytes?: number;
      speed?: number;
      checkpointBytes?: number;
      resumeStage?: 'direct' | 'download' | 'upload';
      downloadCheckpointBytes?: number;
      uploadCheckpointBytes?: number;
      sourceFingerprint?: string;
      isDirectory?: boolean;
      controlKind?: 'stream' | 'compressed-upload';
      phase?: 'scanning' | 'compressing' | 'uploading' | 'transferring' | 'extracting' | 'verifying';
      sessionId?: string;
      sourceHostId?: string;
      targetHostId?: string;
      parentTaskId?: string;
      directoryEntryIndex?: number;
      directoryEntryIdentity?: string;
      lifecycleEpoch?: number;
      lifecycleState?: 'queued' | 'pausing' | 'paused' | 'transferring';
      resumable?: boolean;
      pauseUnavailableReason?: string;
    }) => void): () => void;

    // Local filesystem operations
    listLocalDir?(path: string): Promise<RemoteFile[]>;
    readLocalFile?(path: string, options?: { maxBytes?: number }): Promise<ArrayBuffer>;
    writeLocalFile?(path: string, content: ArrayBuffer): Promise<void>;
    deleteLocalFile?(path: string, expectedType?: SftpStatResult["type"]): Promise<void>;
    renameLocalFile?(oldPath: string, newPath: string): Promise<void>;
    extractLocalArchive?(path: string): Promise<{ success: boolean }>;
    mkdirLocal?(path: string): Promise<void>;
    statLocal?(path: string): Promise<SftpStatResult>;
    /** No-follow local metadata for conflict detection (symlink vs target). */
    lstatLocal?(path: string): Promise<SftpStatResult>;
    listLocalTree?(
      path: string,
      options?: {
        onProgress?: (progress: {
          fileCount: number;
          directoryCount: number;
          entryCount: number;
        }) => void;
        /** Stream discovered rows while the walk continues (edge-scan/upload). */
        onEntries?: (entries: Array<{
          localPath: string;
          relativePath: string;
          type: 'file' | 'directory';
          size: number;
          lastModified: number;
        }>) => void;
        /** Renderer-generated ID used by cancelLocalTreeScan. */
        scanId?: string;
        limits?: {
          maxDirectories?: number;
          maxEntries?: number;
        };
      },
    ): Promise<Array<{
      localPath: string;
      relativePath: string;
      type: 'file' | 'directory';
      size: number;
      lastModified: number;
      }>>;
    cancelLocalTreeScan?(scanId: string): Promise<void>;
    getHomeDir?(): Promise<string>;
    listDrives?(): Promise<string[]>;
    getSystemInfo?(): Promise<{ username: string; hostname: string }>;
  }
}

export {};
