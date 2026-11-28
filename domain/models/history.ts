// Known Hosts - discovered from system SSH known_hosts file
import type { HostIconColorId, HostIconColorMode, HostIconId, HostIconMode, HostProtocol } from './connection';

export interface KnownHost {
  id: string;
  hostname: string; // The host pattern from known_hosts
  port: number;
  keyType: string; // ssh-rsa, ssh-ed25519, ecdsa-sha2-nistp256, etc.
  publicKey: string; // The host's public key fingerprint or full key
  fingerprint?: string; // SHA256 fingerprint without the SHA256: prefix
  discoveredAt: number;
  lastSeen?: number;
  convertedToHostId?: string; // If converted to managed host
  order?: number;
}

// Shell History - records real commands executed in terminal sessions
export interface ShellHistoryEntry {
  id: string;
  command: string;
  hostId: string; // ID of the host where command was executed
  hostLabel: string; // Label for display
  sessionId: string;
  timestamp: number;
}

// Remote Shell History - commands parsed from a remote host's own shell
// history file (~/.bash_history, ~/.zsh_history, fish_history), read on
// demand through the SSH/ET exec channel. Distinct from ShellHistoryEntry,
// which records commands typed inside Netcatty's own terminal sessions.
export type RemoteHistorySource = 'bash' | 'zsh' | 'fish';

export interface RemoteHistoryEntry {
  id: string;
  command: string;
  source: RemoteHistorySource;
  timestamp?: number; // Only set when the history file carries one (zsh EXTENDED_HISTORY, fish `when`)
}

export interface RemoteDesktopRecordingClip {
  id: string; // UUID referencing <userData>/recordings/<id>.webm
  startedAt: number; // Wall-clock ms when recording started
  endedAt: number; // Wall-clock ms when recording ended
  durationMs: number; // Finalized clip duration in milliseconds
  bytes: number; // Finalized clip file size in bytes
  mimeType: string; // e.g. 'video/webm;codecs=vp9,opus'
  hasAudio: boolean; // Whether an audio track was merged into the clip
  hasThumbnail?: boolean; // Whether <id>.jpg exists on disk (never inline base64)
  width?: number; // Recorded video frame width in pixels
  height?: number; // Recorded video frame height in pixels
}

export type RemoteDesktopSessionEventKind =
  | 'connected'
  | 'reconnected'
  | 'disconnected'
  | 'resized'
  | 'clipboard_upload'
  | 'clipboard_download'
  | 'shared_folder_mounted'
  | 'shared_folder_unmounted'
  | 'screenshot'
  | 'recording_started'
  | 'recording_stopped'
  | 'error';

export interface RemoteDesktopSessionEvent {
  id: string;
  timestamp: number;
  kind: RemoteDesktopSessionEventKind;
  summary: string;
  detail?: string;
}

export interface RemoteDesktopSessionMetadata {
  resolution?: { width: number; height: number };
  securityLabel?: string; // e.g. 'TLS / NLA', 'TLS', 'RC4-128', 'RFB'
  tunneled?: boolean;
  monitorCount?: number;
  disconnectReason?: string;
  thumbnailId?: string; // UUID referencing <userData>/recordings/<id>.jpg for unrecorded sessions
}

// Connection Log - records connection history
export interface ConnectionLog {
  id: string;
  sessionId?: string; // Terminal session ID for matching during capture
  hostId: string; // Host ID (can be empty for local terminal)
  hostLabel: string; // Display label (e.g., 'Local Terminal' or host label)
  hostname: string; // Target hostname or 'localhost'
  username: string; // SSH username or system username
  protocol: HostProtocol;
  hostOs?: 'linux' | 'windows' | 'macos'; // Snapshot of the connected host OS for log icons
  hostDistro?: string; // Snapshot of the connected host distro/vendor icon id
  hostIconMode?: HostIconMode; // Snapshot of the host icon mode for log icons
  hostIconId?: HostIconId; // Snapshot of the built-in host icon id
  hostIconColorMode?: HostIconColorMode; // Snapshot of the host icon color source
  hostIconColor?: HostIconColorId; // Snapshot of the host icon color id
  hostIconColorCustom?: string; // Snapshot of the custom host icon color
  startTime: number; // Connection start timestamp
  endTime?: number; // Connection end timestamp (undefined if still active)
  localUsername: string; // System username of the local user
  localHostname: string; // Local machine hostname
  saved: boolean; // Whether this log is bookmarked/saved
  terminalData?: string; // Captured terminal output data for replay
  themeId?: string; // Terminal theme ID for this log view
  fontSize?: number; // Terminal font size for this log view
  recordingId?: string; // UUID referencing <userData>/recordings/<id>.webm (legacy / latest clip mirror)
  recordingMimeType?: string; // e.g. 'video/webm;codecs=vp9,opus'
  recordingDurationMs?: number; // Finalized recording duration in milliseconds
  recordingBytes?: number; // Finalized recording file size in bytes
  recordingHasAudio?: boolean; // Whether an audio track was merged into the recording
  recordings?: RemoteDesktopRecordingClip[]; // Multi-clip recordings for a single RDP/VNC session
  remoteDesktopMeta?: RemoteDesktopSessionMetadata; // Structured RDP/VNC connection summary
  remoteDesktopEvents?: RemoteDesktopSessionEvent[]; // Bounded chronological session activity timeline
}

// Session Logs Settings - for auto-saving terminal logs to local filesystem
export type SessionLogFormat = 'txt' | 'raw' | 'html';

// Managed Source - external file that manages a group of hosts (e.g., ~/.ssh/config)
type ManagedSourceType = 'ssh_config';

export interface ManagedSource {
  id: string;
  type: ManagedSourceType;
  filePath: string;
  groupName: string;
  lastSyncedAt: number;
  lastFileHash?: string;
}
