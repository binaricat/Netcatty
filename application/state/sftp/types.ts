import { Host, KnownHost, SftpConnection, SftpFileEntry, SftpFilenameEncoding } from "../../../domain/models";
import { createNavHistory, type SftpNavHistory } from "../../../domain/sftpNavHistory";

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
  navHistory?: SftpNavHistory;
}

export interface SftpHostKeyInfo {
  hostname: string;
  port: number;
  keyType: string;
  fingerprint: string;
  publicKey?: string;
  status?: "unknown" | "changed";
  knownHostId?: string;
  knownFingerprint?: string;
}

export interface SftpHostKeyVerificationState {
  hostKeyInfo: SftpHostKeyInfo;
  progressLogs: string[];
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
  navHistory: createNavHistory(),
});

// File watch event types
export interface FileWatchSyncedEvent {
  watchId: string;
  localPath: string;
  remotePath: string;
  bytesWritten: number;
  warning?: string;
}

export interface FileWatchErrorEvent {
  watchId: string;
  localPath: string;
  remotePath: string;
  error: string;
}

export interface SftpStateOptions {
  transferOwnerId?: string;
  canPrepareTransferAdoption?: boolean;
  /**
   * When false the side panel is retained-but-hidden (closed during transfer).
   * Progress must not force React state paints for the hidden tree.
   */
  surfaceVisible?: boolean;
  onFileWatchSynced?: (event: FileWatchSyncedEvent) => void;
  onFileWatchError?: (event: FileWatchErrorEvent) => void;
  useCompressedUpload?: boolean;
  defaultShowHiddenFiles?: boolean;
  autoConnectLocalOnMount?: boolean;
  /**
   * When false, park (soft-close) browse SFTP channels so transfer-pool
   * sessions stay independent. Defaults to true (interactive).
   */
  interactive?: boolean;
  /**
   * Global SSH keepalive settings, forwarded through to per-SFTP-connection
   * keepalive resolution so a host that has opted into its own override
   * is honored for SFTP browsing too (not just the terminal session).
   */
  terminalSettings?: { verifyHostKeys: boolean; keepaliveInterval: number; keepaliveCountMax: number };
  knownHosts?: KnownHost[];
  onAddKnownHost?: (knownHost: KnownHost) => void;
  /**
   * Resolve a live terminal session id for a vault host so transfer-pool opens
   * can reuse that SSH transport (openSftpForSession) instead of a cold connect.
   * When `host` is provided, only return a session whose live endpoint matches.
   */
  resolveTransferSourceSessionId?: (hostId: string, host?: Host) => string | undefined;
  /**
   * Resolve a live terminal session id for restoring parked browse sessions.
   * This keeps side-panel tab switches on the already-authenticated SSH transport.
   */
  resolveBrowseSourceSessionId?: (hostId: string, host?: Host) => string | undefined;
  /**
   * @deprecated Transfer channels no longer park independently. SSH keep-alive
   * is controlled by sshTransportIdleTtlMs in settings.
   */
  transferPoolIdleTtlMs?: number;
}
