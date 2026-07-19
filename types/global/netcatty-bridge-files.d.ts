import type { SftpFilenameEncoding } from "../../types";

declare global {
  interface NetcattyBridge {
    // File opener helpers (for "Open With" feature)
    selectApplication?(): Promise<{ path: string; name: string } | null>;
    openWithApplication?(filePath: string, appPath: string): Promise<boolean>;
    openWithSystemDefault?(filePath: string): Promise<{ success: boolean; error?: string }>;
    downloadSftpToTemp?(sftpId: string, remotePath: string, fileName: string, encoding?: SftpFilenameEncoding): Promise<string>;
    downloadSftpToTempWithProgress?(
      sftpId: string,
      remotePath: string,
      fileName: string,
      encoding: SftpFilenameEncoding | undefined,
      transferId: string,
      onProgress?: (transferred: number, total: number, speed: number) => void,
      onComplete?: () => void,
      onError?: (error: string) => void,
      onCancelled?: () => void
    ): Promise<{ localPath: string; cancelled: boolean }>;

    // Save dialog for file downloads
    showSaveDialog?(defaultPath: string, filters?: Array<{ name: string; extensions: string[] }>): Promise<string | null>;
    selectDirectory?(title?: string, defaultPath?: string): Promise<string | null>;
    selectFile?(title?: string, defaultPath?: string, filters?: Array<{ name: string; extensions: string[] }>): Promise<string | null>;

    // File watcher for auto-sync feature
    startFileWatch?(localPath: string, remotePath: string, sftpId: string, encoding?: SftpFilenameEncoding): Promise<{ watchId: string }>;
    stopFileWatch?(watchId: string, cleanupTempFile?: boolean): Promise<{ success: boolean }>;
    listFileWatches?(): Promise<Array<{ watchId: string; localPath: string; remotePath: string; sftpId: string }>>;
    registerTempFile?(sftpId: string, localPath: string): Promise<{ success: boolean }>;
    onFileWatchSynced?(cb: (payload: { watchId: string; localPath: string; remotePath: string; bytesWritten: number }) => void): () => void;
    onFileWatchError?(cb: (payload: { watchId: string; localPath: string; remotePath: string; error: string }) => void): () => void;

    // Temp file cleanup
    deleteTempFile?(filePath: string): Promise<{ success: boolean }>;

    // Crash Logs
    getCrashLogs?(): Promise<Array<{ fileName: string; date: string; size: number; entryCount: number }>>;
    readCrashLog?(fileName: string): Promise<Array<{
      timestamp: string;
      source: string;
      message: string;
      stack?: string;
      errorMeta?: Record<string, unknown>;
      extra?: Record<string, unknown>;
      pid?: number;
      platform?: string;
      arch?: string;
      version?: string;
      electronVersion?: string;
      osVersion?: string;
      memoryMB?: { rss: number; heapUsed: number; heapTotal: number };
      activeSessionCount?: number;
      uptimeSeconds?: number;
    }>>;
    clearCrashLogs?(): Promise<{ deletedCount: number }>;
    openCrashLogsDir?(): Promise<{ success: boolean }>;

    // Temp directory management
    getTempDirInfo?(): Promise<{ path: string; fileCount: number; totalSize: number }>;
    clearTempDir?(): Promise<{ deletedCount: number; failedCount: number; error?: string }>;
    getTempDirPath?(): Promise<string>;
    openTempDir?(): Promise<{ success: boolean }>;
    getToolOutputPersistenceStatus?(): Promise<{ durable: boolean; reason?: string }>;
    writeToolOutputTemp?(record: import('../../infrastructure/ai/harness/toolOutputStore').PersistedToolOutputRecord, content: string): Promise<{ ok: boolean; path?: string; manifestPath?: string; error?: string }>;
    restoreToolOutputTemp?(handleId: string, chatSessionId: string): Promise<{
      path: string;
      record: import('../../infrastructure/ai/harness/toolOutputStore').PersistedToolOutputRecord;
    } | null>;
    readToolOutputTemp?(filePath: string, request?: {
      mode?: 'head' | 'tail' | 'full' | 'range' | 'search';
      maxChars?: number;
      offset?: number;
      query?: string;
    }): Promise<unknown | null>;
    deleteToolOutputTemp?(filePath: string): Promise<{ ok: boolean }>;
    deleteChatToolOutputsTemp?(chatSessionId: string): Promise<{ deletedCount: number }>;
    deleteTerminalToolOutputsTemp?(chatSessionId: string, terminalSessionId: string): Promise<{ deletedCount: number }>;
    deleteTerminalToolOutputsEverywhereTemp?(terminalSessionId: string): Promise<{ deletedCount: number }>;

    // Session Logs
    exportSessionLog?(payload: {
      terminalData: string;
      hostLabel: string;
      hostname: string;
      startTime: number;
      format: 'txt' | 'raw' | 'html';
    }): Promise<{ success: boolean; canceled?: boolean; filePath?: string }>;
    selectSessionLogsDir?(): Promise<{ success: boolean; canceled?: boolean; directory?: string }>;
    autoSaveSessionLog?(payload: {
      terminalData: string;
      hostLabel: string;
      hostname: string;
      hostId: string;
      startTime: number;
      format: 'txt' | 'raw' | 'html';
      directory: string;
    }): Promise<{ success: boolean; error?: string; filePath?: string }>;
    openSessionLogsDir?(directory: string): Promise<{ success: boolean; error?: string }>;
    startManualSessionLog?(payload: {
      sessionId: string;
      sessionName?: string;
      preferredDirectory?: string;
      format?: 'txt' | 'raw' | 'html';
      timestampsEnabled?: boolean;
      initialLine?: string;
    }): Promise<{ success: boolean; started: boolean; canceled?: boolean; error?: string; filePath?: string }>;
    stopManualSessionLog?(payload: {
      sessionId: string;
    }): Promise<{ success: boolean; stopped: boolean; error?: string; filePath?: string }>;
    getManualSessionLogStatus?(payload: {
      sessionId: string;
    }): Promise<{ success: boolean; isLogging: boolean; error?: string }>;

    // Get file path from File object (for drag-and-drop, uses Electron's webUtils)
    getPathForFile?(file: File): string | undefined;
    readClipboardText?(): Promise<string>;
    writeClipboardText?(text: string): Promise<boolean>;
    readClipboardFiles?(): Promise<Array<{ path: string; name: string; isDirectory: boolean; size?: number }>>;
    readClipboardImage?(): Promise<{ path: string; name: string; mediaType: string; size?: number } | null>;

    // Credential encryption (field-level safeStorage for sensitive data at rest)
    credentialsAvailable?(): Promise<boolean>;
    credentialsEncrypt?(plaintext: string): Promise<string>;
    credentialsDecrypt?(value: string): Promise<string>;
  }
}

export {};
