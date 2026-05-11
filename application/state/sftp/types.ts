import { SftpConnection, SftpFileEntry, SftpFilenameEncoding } from "../../../domain/models";

export interface SftpPane {
  id: string;
  connection: SftpConnection | null;
  files: SftpFileEntry[];
  loading: boolean;
  reconnecting: boolean;
  error: string | null;
  connectionLogs: string[];
  selectedFiles: Set<string>;
  filter: string;
  filenameEncoding: SftpFilenameEncoding;
  showHiddenFiles: boolean;
  transferMutationToken: number;
}

// Multi-tab state for left and right sides
export interface SftpSideTabs {
  tabs: SftpPane[];
  activeTabId: string | null;
}

// Constants for empty placeholder pane IDs
export const EMPTY_LEFT_PANE_ID = "__empty_left__";
export const EMPTY_RIGHT_PANE_ID = "__empty_right__";

export const createEmptyPane = (
  id?: string,
  showHiddenFiles = false,
): SftpPane => ({
  id: id || crypto.randomUUID(),
  connection: null,
  files: [],
  loading: false,
  reconnecting: false,
  error: null,
  connectionLogs: [],
  selectedFiles: new Set(),
  filter: "",
  filenameEncoding: "auto",
  showHiddenFiles,
  transferMutationToken: 0,
});

// File watch event types
export interface FileWatchSyncedEvent {
  watchId: string;
  localPath: string;
  remotePath: string;
  bytesWritten: number;
}

export interface FileWatchErrorEvent {
  watchId: string;
  localPath: string;
  remotePath: string;
  error: string;
}

export interface SftpStateOptions {
  onFileWatchSynced?: (event: FileWatchSyncedEvent) => void;
  onFileWatchError?: (event: FileWatchErrorEvent) => void;
  useCompressedUpload?: boolean;
  defaultShowHiddenFiles?: boolean;
  autoConnectLocalOnMount?: boolean;
  /**
   * Global SSH keepalive settings, forwarded through to per-SFTP-connection
   * keepalive resolution so a host that has opted into its own override
   * is honored for SFTP browsing too (not just the terminal session).
   */
  terminalSettings?: { keepaliveInterval: number; keepaliveCountMax: number };
}
