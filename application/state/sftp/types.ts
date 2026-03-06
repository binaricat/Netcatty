import { SftpConnection, SftpFileEntry, SftpFilenameEncoding } from "../../../domain/models";

export interface SftpPane {
  id: string;
  connection: SftpConnection | null;
  files: SftpFileEntry[];
  loading: boolean;
  reconnecting: boolean;
  error: string | null;
  selectedFiles: Set<string>;
  filter: string;
  filenameEncoding: SftpFilenameEncoding;
}

// Multi-tab state for left and right sides
export interface SftpSideTabs {
  tabs: SftpPane[];
  activeTabId: string | null;
}

// Constants for empty placeholder pane IDs
export const EMPTY_LEFT_PANE_ID = "__empty_left__";
export const EMPTY_RIGHT_PANE_ID = "__empty_right__";

export const createEmptyPane = (id?: string): SftpPane => ({
  id: id || crypto.randomUUID(),
  connection: null,
  files: [],
  loading: false,
  reconnecting: false,
  error: null,
  selectedFiles: new Set(),
  filter: "",
  filenameEncoding: "auto",
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
}
