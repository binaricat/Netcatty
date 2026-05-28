export interface UploadProgress {
  transferred: number;
  total: number;
  speed: number;
  /** Percentage (0-100) */
  percent: number;
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
  onScanningStart?: (taskId: string) => void;
  /** Called when scanning ends */
  onScanningEnd?: (taskId: string) => void;
  /** Called when task name needs to be updated (for phase changes) */
  onTaskNameUpdate?: (taskId: string, newName: string) => void;
}

export interface UploadBridge {
  writeLocalFile?: (path: string, data: ArrayBuffer) => Promise<void>;
  mkdirLocal?: (path: string) => Promise<void>;
  statLocal?: (path: string) => Promise<{ type: 'file' | 'directory' | 'symlink'; size: number; lastModified: number } | null>;
  deleteLocalFile?: (path: string) => Promise<void>;
  mkdirSftp: (sftpId: string, path: string) => Promise<void>;
  statSftp?: (sftpId: string, path: string) => Promise<{ type: 'file' | 'directory' | 'symlink'; size: number; lastModified: number } | null>;
  deleteSftp?: (sftpId: string, path: string) => Promise<void>;
  writeSftpBinary?: (sftpId: string, path: string, data: ArrayBuffer) => Promise<void>;
  writeSftpBinaryWithProgress?: (
    sftpId: string,
    path: string,
    data: ArrayBuffer,
    taskId: string,
    onProgress: (transferred: number, total: number, speed: number) => void,
    onComplete?: () => void,
    onError?: (error: string) => void
  ) => Promise<{ success: boolean; cancelled?: boolean } | undefined>;
  cancelSftpUpload?: (taskId: string) => Promise<unknown>;
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
      totalBytes?: number;
    },
    onProgress?: (transferred: number, total: number, speed: number) => void,
    onComplete?: () => void,
    onError?: (error: string) => void
  ) => Promise<{ transferId: string; totalBytes?: number; error?: string; cancelled?: boolean }>;
  cancelTransfer?: (transferId: string) => Promise<void>;
}

export interface UploadConfig {
  /** Target directory path */
  targetPath: string;
  /** SFTP session ID (null for local) */
  sftpId: string | null;
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
