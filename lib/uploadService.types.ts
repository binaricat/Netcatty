export interface UploadProgress {
  transferred: number;
  total: number;
  speed: number;
  /** Percentage (0-100) */
  percent: number;
  phase?: import('../domain/models/sftp').TransferPhase;
  /** Contiguous durable offset from the transfer bridge (may lag transferred). */
  checkpointBytes?: number;
  sourceFingerprint?: string;
  resumable?: boolean;
  pauseUnavailableReason?: string;
}

export interface UploadTaskInfo {
  id: string;
  fileName: string;
  /** Display name for bundled tasks (e.g., "folder (5 files)") */
  displayName: string;
  isDirectory: boolean;
  progressMode?: 'bytes' | 'files';
  parentTaskId?: string;
  totalBytes: number;
  transferredBytes: number;
  speed: number;
  fileCount: number;
  completedCount: number;
  sourcePath?: string;
  /** Background job API used to control this task after its page closes. */
  controlKind?: 'stream' | 'compressed-upload';
}

export interface UploadResult {
  fileName: string;
  success: boolean;
  error?: string;
  cancelled?: boolean;
}

export interface UploadCallbacks {
  /** Called when a new task is created (for bundled folders or standalone files) */
  onTaskCreated?: (task: UploadTaskInfo) => void;
  /** Called when task progress is updated */
  onTaskProgress?: (taskId: string, progress: UploadProgress) => void;
  /** Called when a task is completed */
  onTaskCompleted?: (taskId: string, totalBytes: number) => void;
  /** Called when a task fails */
  onTaskFailed?: (taskId: string, error: string) => void;
  /** Called when a task is cancelled */
  onTaskCancelled?: (taskId: string) => void;
  /** Called when scanning starts (for showing placeholder) */
  onScanningStart?: (taskId: string, info?: { label?: string }) => void;
  /** Live scan counters (file/dir totals) while enumerating a drop */
  onScanningProgress?: (taskId: string, progress: {
    fileCount: number;
    directoryCount: number;
    entryCount: number;
    label?: string;
  }) => void;
  /** Called when scanning ends */
  onScanningEnd?: (taskId: string) => void;
  /** Called when task name needs to be updated (for phase changes) */
  onTaskNameUpdate?: (taskId: string, newName: string) => void;
}

export interface UploadBridge {
  /** Main-process transfer events own file progress and terminal lifecycle. */
  managesTransferLifecycle?: boolean;
  writeLocalFile?: (path: string, data: ArrayBuffer) => Promise<void>;
  mkdirLocal?: (path: string) => Promise<void>;
  statLocal?: (path: string) => Promise<{ type: 'file' | 'directory' | 'symlink'; size: number; lastModified: number } | null>;
  /** No-follow local metadata so Replace can unlink symlinks before writeLocalFile. */
  lstatLocal?: (path: string) => Promise<{ type: 'file' | 'directory' | 'symlink'; size: number; lastModified: number } | null>;
  deleteLocalFile?: (path: string, expectedType?: 'file' | 'directory' | 'symlink') => Promise<void>;
  stageUploadFile?: (file: File, taskId: string) => Promise<string>;
  cancelStagedUploadFile?: (taskId: string) => Promise<unknown>;
  deleteTempFile?: (path: string) => Promise<unknown>;
  mkdirSftp: (sftpId: string, path: string) => Promise<void>;
  /** Followed remote metadata — resume / sizing must use target bytes, not the link node. */
  statSftp?: (sftpId: string, path: string) => Promise<{ type: 'file' | 'directory' | 'symlink'; size: number; lastModified: number } | null>;
  /** No-follow remote metadata so Replace can unlink symlinks before in-place upload. */
  lstatSftp?: (sftpId: string, path: string) => Promise<{ type: 'file' | 'directory' | 'symlink'; size: number; lastModified: number } | null>;
  deleteSftp?: (sftpId: string, path: string, expectedType?: 'file' | 'directory' | 'symlink') => Promise<void>;
  /** Stream transfer using local file path (avoids loading file into memory) */
  startStreamTransfer?: (
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
      totalBytes?: number;
      sourceEncoding?: import('../domain/models/sftp').SftpFilenameEncoding;
      targetEncoding?: import('../domain/models/sftp').SftpFilenameEncoding;
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
      skipAdmission?: boolean;
    }
  ) => Promise<{ transferId: string; totalBytes?: number; error?: string; cancelled?: boolean }>;
  cancelTransfer?: (transferId: string) => Promise<void>;
}

export interface UploadConfig {
  /** Target directory path */
  targetPath: string;
  /** SFTP session ID (null for local) */
  sftpId: string | null;
  /** Stable target host ID, used to apply the concurrency limit per server. */
  targetHostId?: string;
  /** Maximum number of files this upload may admit at once. */
  fileTransferConcurrency?: number;
  /** Is this a local file system upload? */
  isLocal: boolean;
  /** The bridge for file operations */
  bridge: UploadBridge;
  /** Path joining function */
  joinPath: (base: string, name: string) => string;
  /** Callbacks for progress updates */
  callbacks?: UploadCallbacks;
  /** Use compressed upload for folders (requires tar on both local and remote) */
  useCompressedUpload?: boolean;
  resolveConflict?: (conflict: {
    fileName: string;
    targetPath: string;
    isDirectory: boolean;
    existingType?: 'file' | 'directory' | 'symlink';
    existingSize: number;
    newSize: number;
    existingModified: number;
    newModified: number;
    applyToAllCount: number;
  }) => Promise<'stop' | 'skip' | 'replace' | 'duplicate' | 'merge'>;
}
