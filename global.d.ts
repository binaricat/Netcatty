import type { TerminalSession, RemoteFile } from "./types";

interface NebulaSSHOptions {
  sessionId?: string;
  hostname: string;
  username: string;
  port?: number;
  password?: string;
  privateKey?: string;
  keyId?: string;
  agentForwarding?: boolean;
  cols?: number;
  rows?: number;
  charset?: string;
  extraArgs?: string[];
}

interface SftpStatResult {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  lastModified: number; // timestamp
  permissions?: string; // e.g., "rwxr-xr-x"
  owner?: string;
  group?: string;
}

interface SftpTransferProgress {
  transferId: string;
  bytesTransferred: number;
  totalBytes: number;
  speed: number; // bytes per second
}

interface NebulaBridge {
  startSSHSession(options: NebulaSSHOptions): Promise<string>;
  startLocalSession?(options: { sessionId?: string; cols?: number; rows?: number; shell?: string; env?: Record<string, string> }): Promise<string>;
  execCommand(options: {
    hostname: string;
    username: string;
    port?: number;
    password?: string;
    privateKey?: string;
    command: string;
    timeout?: number;
  }): Promise<{ stdout: string; stderr: string; code: number | null }>;
  writeToSession(sessionId: string, data: string): void;
  resizeSession(sessionId: string, cols: number, rows: number): void;
  closeSession(sessionId: string): void;
  onSessionData(sessionId: string, cb: (data: string) => void): () => void;
  onSessionExit(
    sessionId: string,
    cb: (evt: { exitCode?: number; signal?: number }) => void
  ): () => void;
  
  // SFTP operations
  openSftp(options: NebulaSSHOptions): Promise<string>;
  listSftp(sftpId: string, path: string): Promise<RemoteFile[]>;
  readSftp(sftpId: string, path: string): Promise<string>;
  readSftpBinary?(sftpId: string, path: string): Promise<ArrayBuffer>;
  writeSftp(sftpId: string, path: string, content: string): Promise<void>;
  writeSftpBinary?(sftpId: string, path: string, content: ArrayBuffer): Promise<void>;
  closeSftp(sftpId: string): Promise<void>;
  mkdirSftp(sftpId: string, path: string): Promise<void>;
  deleteSftp?(sftpId: string, path: string): Promise<void>;
  renameSftp?(sftpId: string, oldPath: string, newPath: string): Promise<void>;
  statSftp?(sftpId: string, path: string): Promise<SftpStatResult>;
  chmodSftp?(sftpId: string, path: string, mode: string): Promise<void>;
  
  // Transfer with progress
  uploadFile?(sftpId: string, localPath: string, remotePath: string, transferId: string): Promise<void>;
  downloadFile?(sftpId: string, remotePath: string, localPath: string, transferId: string): Promise<void>;
  cancelTransfer?(transferId: string): Promise<void>;
  onTransferProgress?(transferId: string, cb: (progress: SftpTransferProgress) => void): () => void;
  
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
      totalBytes?: number;
    },
    onProgress?: (transferred: number, total: number, speed: number) => void,
    onComplete?: () => void,
    onError?: (error: string) => void
  ): Promise<{ transferId: string; totalBytes?: number; error?: string }>;
  
  // Local filesystem operations
  listLocalDir?(path: string): Promise<RemoteFile[]>;
  readLocalFile?(path: string): Promise<ArrayBuffer>;
  writeLocalFile?(path: string, content: ArrayBuffer): Promise<void>;
  deleteLocalFile?(path: string): Promise<void>;
  renameLocalFile?(oldPath: string, newPath: string): Promise<void>;
  mkdirLocal?(path: string): Promise<void>;
  statLocal?(path: string): Promise<SftpStatResult>;
  getHomeDir?(): Promise<string>;
  
  setTheme?(theme: 'light' | 'dark'): Promise<boolean>;
  // Window controls for custom title bar (Windows/Linux)
  windowMinimize?(): Promise<void>;
  windowMaximize?(): Promise<boolean>;
  windowClose?(): Promise<void>;
  windowIsMaximized?(): Promise<boolean>;
}

declare global {
  interface Window {
    nebula?: NebulaBridge;
  }
}

export {};
