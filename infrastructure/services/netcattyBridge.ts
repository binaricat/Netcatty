export type RemoteDesktopProtocol = "vnc" | "rdp";

export type RemoteDesktopCertDecisionValue = "accept-once" | "accept-always" | "reject";

export interface RemoteDesktopStartOptions {
  sessionId?: string;
  protocol: RemoteDesktopProtocol;
  hostname: string;
  port?: number;
  username?: string;
  password?: string;
  domain?: string;
  hostId?: string;
  label?: string;
  shared?: boolean;
  readOnly?: boolean;
  viewOnly?: boolean;
  quality?: "auto" | "high" | "medium" | "low" | "lossless";
  vncQuality?: number;
  vncCompressionLevel?: number;
  securityMode?: "auto" | "nla" | "tls" | "rdp" | "tls-legacy";
  allowLegacyTls?: boolean;
  ignoreCertErrors?: boolean;
  knownCertFingerprints?: string[];
  expectedCertFingerprint?: string;
  connectTimeoutMs?: number;
  proxy?: {
    type: "http" | "socks5" | "command";
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    command?: string;
  };
  jumpHosts?: Array<Record<string, unknown>>;
  tunnelViaHostSsh?: boolean;
  tunnelTargetHost?: string;
  sshTunnelConfig?: Record<string, unknown>;
  knownHosts?: Array<Record<string, unknown>>;
  verifyHostKeys?: boolean;
}

export interface RemoteDesktopStartResult {
  sessionId: string;
  protocol: RemoteDesktopProtocol;
  wsUrl: string;
  port: number;
}

export interface RemoteDesktopCertVerifyEvent {
  requestId: string;
  sessionId: string;
  protocol: RemoteDesktopProtocol;
  host: string;
  port: number;
  fingerprintSha256: string;
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  serialNumber: string;
  subjectAltName: string;
  previousFingerprint: string | null;
}

export interface RemoteDesktopStatusEvent {
  sessionId: string;
  status: string;
  error?: string;
  fingerprintSha256?: string;
}

export interface RemoteDesktopStatsEvent {
  sessionId: string;
  protocol: RemoteDesktopProtocol;
  rttMs: number | null;
  rxBps: number;
  txBps: number;
  totalRxBytes: number;
  totalTxBytes: number;
  ts: number;
}

export interface RemoteDesktopLocalDisplay {
  id: number;
  left: number;
  top: number;
  width: number;
  height: number;
  scaleFactor: number;
  isPrimary: boolean;
}

export interface RemoteDesktopRdpdrDriveConfig {
  deviceId: number;
  name: string;
  path: string;
  readOnly?: boolean;
}

export interface RemoteDesktopRdpdrPickFolderResult {
  ok: boolean;
  canceled?: boolean;
  path?: string;
  name?: string;
  error?: string;
}

export interface RemoteDesktopRdpdrRegisterDrivesResult {
  ok: boolean;
  error?: string;
  registered: Array<{
    deviceId: number;
    name: string;
    path: string;
    readOnly: boolean;
  }>;
  rejected: Array<{
    deviceId?: number;
    path?: string;
    reason: string;
  }>;
}

export interface RemoteDesktopRdpdrRequest {
  op:
    | "create"
    | "close"
    | "read"
    | "write"
    | "query_directory"
    | "query_information"
    | "query_volume_information"
    | "set_information"
    | "flush"
    | "lock_control"
    | "device_control"
    | "notify_change_directory"
    | "reset";
  deviceId: number;
  fileId: number;
  completionId: number;
  path?: string;
  desiredAccess?: number;
  allocationSize?: number;
  fileAttributes?: number;
  sharedAccess?: number;
  createDisposition?: number;
  createOptions?: number;
  offset?: number;
  length?: number;
  data?: Uint8Array;
  initialQuery?: boolean;
  informationClass?: number;
  creationTime?: string | number;
  lastAccessTime?: string | number;
  lastWriteTime?: string | number;
  changeTime?: string | number;
  renameTarget?: string;
  replaceIfExists?: boolean;
  deleteOnClose?: boolean;
  deletePending?: boolean;
  eofSize?: number;
  operation?: number;
  wait?: boolean;
  ioControlCode?: number;
  outputBufferLength?: number;
  inputBuffer?: Uint8Array;
  watchTree?: boolean;
  completionFilter?: number;
}

export interface RemoteDesktopRdpdrDirectoryEntry {
  fileName: string;
  creationTime: string;
  lastAccessTime: string;
  lastWriteTime: string;
  changeTime: string;
  endOfFile: number;
  allocationSize: number;
  fileAttributes: number;
}

export interface RemoteDesktopRdpdrResponse {
  op: string;
  deviceId: number;
  completionId: number;
  status: number;
  fileId?: number;
  information?: number;
  data?: Uint8Array;
  bytesWritten?: number;
  informationClass?: number;
  entry?: RemoteDesktopRdpdrDirectoryEntry;
  basic?: {
    creationTime: string;
    lastAccessTime: string;
    lastWriteTime: string;
    changeTime: string;
    fileAttributes: number;
  };
  standard?: {
    allocationSize: number;
    endOfFile: number;
    numberOfLinks: number;
    deletePending: boolean;
    directory: boolean;
  };
  attributeTag?: {
    fileAttributes: number;
    reparseTag: number;
  };
  volume?: {
    creationTime: string;
    serialNumber: number;
    supportsObjects: boolean;
    label: string;
  };
  size?: {
    totalAllocationUnits: number;
    availableAllocationUnits: number;
    sectorsPerAllocationUnit: number;
    bytesPerSector: number;
  };
  device?: {
    deviceType: number;
    characteristics: number;
  };
  attribute?: {
    attributes: number;
    maxComponentNameLen: number;
    fileSystemName: string;
  };
  fullSize?: {
    totalAllocationUnits: number;
    callerAvailableAllocationUnits: number;
    actualAvailableAllocationUnits: number;
    sectorsPerAllocationUnit: number;
    bytesPerSector: number;
  };
  outputBuffer?: Uint8Array;
}

export type RemoteDesktopSaveClipboardFileOptions =
  | {
      action?: "oneshot";
      fileName: string;
      data: Uint8Array | string;
      encoding?: "utf8" | "base64";
      defaultDir?: string;
    }
  | {
      action: "begin";
      fileName: string;
      defaultDir?: string;
    }
  | {
      action: "chunk";
      streamId: string;
      data: Uint8Array | string;
    }
  | {
      action: "finish" | "abort";
      streamId: string;
    };

export interface RemoteDesktopSaveClipboardFileResult {
  ok: boolean;
  canceled?: boolean;
  streamId?: string;
  filePath?: string;
  bytesWritten?: number;
  error?: string;
}

export interface RemoteDesktopOpenSystemClientOptions {
  protocol: RemoteDesktopProtocol;
  hostname: string;
  port?: number;
  username?: string;
  domain?: string;
  label?: string;
  rdpContent?: string;
  loadBalanceInfo?: string;
  alternateShell?: string;
  shellWorkingDir?: string;
  audioEnabled?: boolean;
  clipboardSync?: boolean;
  proxy?: RemoteDesktopStartOptions["proxy"];
  jumpHosts?: Array<Record<string, unknown>>;
  tunnelViaHostSsh?: boolean;
  tunnelTargetHost?: string;
  sshTunnelConfig?: Record<string, unknown>;
  knownHosts?: Array<Record<string, unknown>>;
  verifyHostKeys?: boolean;
}

export interface RemoteDesktopOpenSystemClientResult {
  ok: boolean;
  filePath?: string;
  url?: string;
  tunnelId?: string | null;
  error?: string;
}

export interface RemoteDesktopProbeCertInfo {
  fingerprintSha256: string;
  subject?: string;
  issuer?: string;
  validFrom?: string;
  validTo?: string;
  trustStatus: "trusted" | "first-seen" | "changed";
}

export interface RemoteDesktopProbeResult {
  ok: boolean;
  protocol: "rdp" | "vnc";
  host: string;
  port: number;
  rttMs: number | null;
  bannerVerified?: boolean;
  bannerDetail?: string;
  rdpSecurity?: "rdp" | "tls" | "nla" | "rdstls" | "nla-ext";
  rfbVersion?: string;
  vncSecurityTypes?: Array<{ id: number; name: string }>;
  tlsVersion?: string;
  tlsCipher?: string;
  cert?: RemoteDesktopProbeCertInfo;
  error?: string;
  checkedAt: number;
}

export interface RemoteDesktopTestConnectionOptions {
  sessionId?: string;
  protocol: "rdp" | "vnc";
  hostname: string;
  port: number;
  hostId?: string;
  hostLabel?: string;
  securityMode?: "auto" | "nla" | "tls" | "rdp";
  loadBalanceInfo?: string;
  allowLegacyTls?: boolean;
  knownCertFingerprints?: string[];
  proxyConfig?: Record<string, unknown>;
  jumpHosts?: Array<Record<string, unknown>>;
  tunnelViaHostSsh?: boolean;
  tunnelTargetHost?: string;
  sshTunnelConfig?: Record<string, unknown>;
  knownHosts?: Array<Record<string, unknown>>;
  verifyHostKeys?: boolean;
  timeoutMs?: number;
  [key: string]: unknown;
}

export interface RemoteDesktopRecordingsBridgeApi {
  begin(options: {
    mimeType?: string;
    hostLabel?: string;
    protocol: "rdp" | "vnc";
  }): Promise<{ recordingId: string }>;
  append(options: {
    recordingId: string;
    chunk: Uint8Array;
  }): Promise<{ bytesWritten: number }>;
  finish(options: {
    recordingId: string;
    durationMs: number;
    hasAudio?: boolean;
    maxBytes?: number;
    retentionDays?: number;
    protectedIds?: string[];
  }): Promise<{
    recordingId: string;
    bytes: number;
    durationMs: number;
    playbackUrl: string;
  }>;
  abort(options: { recordingId: string }): Promise<{ ok: boolean }>;
  getPlaybackUrl(options: {
    recordingId: string;
  }): Promise<{ url: string | null; exists: boolean; bytes?: number }>;
  saveThumbnail?(options: {
    id?: string;
    data: Uint8Array;
  }): Promise<{ ok: boolean; id?: string; url?: string; bytes?: number }>;
  getThumbnailUrl?(options: {
    id: string;
  }): Promise<{ url: string | null; exists: boolean; bytes?: number }>;
  export(options: {
    recordingId: string;
    defaultFileName?: string;
  }): Promise<{ saved: boolean; filePath?: string }>;
  delete(options: { recordingId: string }): Promise<{ ok: boolean }>;
  deleteMany(options: { recordingIds: string[] }): Promise<{ deleted: number }>;
  clearAll(options?: { protectedIds?: string[] }): Promise<{ deleted: number }>;
  getStats(): Promise<{ count: number; totalBytes: number; dirPath: string }>;
  openFolder(): Promise<{ ok: boolean }>;
  runGc(options: {
    maxBytes?: number;
    retentionDays?: number;
    referencedIds?: string[];
    protectedIds?: string[];
  }): Promise<{ deleted: number }>;
}

export interface RemoteDesktopBridgeApi {
  start(options: RemoteDesktopStartOptions): Promise<RemoteDesktopStartResult>;
  stop(sessionId: string): Promise<{ success: boolean }>;
  testConnection(options: RemoteDesktopTestConnectionOptions): Promise<RemoteDesktopProbeResult>;
  cancelTestConnection(sessionId: string): Promise<{ ok: boolean }>;
  respondCertDecision(
    requestId: string,
    decision: RemoteDesktopCertDecisionValue | { decision?: RemoteDesktopCertDecisionValue; accepted?: boolean; trustAlways?: boolean },
  ): Promise<{ success: boolean; error?: string }>;
  setKeyboardGrab(active: boolean): Promise<{ success: boolean; active: boolean }>;
  saveClipboardFile(options: RemoteDesktopSaveClipboardFileOptions): Promise<RemoteDesktopSaveClipboardFileResult>;
  openSystemClient(options: RemoteDesktopOpenSystemClientOptions): Promise<RemoteDesktopOpenSystemClientResult>;
  stopSystemTunnel(tunnelId: string): Promise<{ ok?: boolean; success?: boolean; error?: string }>;
  getLocalDisplays(): Promise<RemoteDesktopLocalDisplay[]>;
  rdpdrPickFolder(): Promise<RemoteDesktopRdpdrPickFolderResult>;
  rdpdrRegisterDrives(
    sessionId: string,
    drives: RemoteDesktopRdpdrDriveConfig[],
  ): Promise<RemoteDesktopRdpdrRegisterDrivesResult>;
  rdpdrOp(
    sessionId: string,
    request: RemoteDesktopRdpdrRequest,
  ): Promise<RemoteDesktopRdpdrResponse>;
  rdpdrCleanup(sessionId: string): Promise<{ ok: boolean }>;
  onCertVerify(cb: (payload: RemoteDesktopCertVerifyEvent) => void): () => void;
  onStatus(cb: (payload: RemoteDesktopStatusEvent) => void): () => void;
  onStats(cb: (payload: RemoteDesktopStatsEvent) => void): () => void;
  onKeyboardGrabChanged(cb: (payload: { active: boolean }) => void): () => void;
}

declare global {
  interface NetcattyBridge {
    startRemoteDesktopSession?: RemoteDesktopBridgeApi["start"];
    stopRemoteDesktopSession?: RemoteDesktopBridgeApi["stop"];
    testRemoteDesktopConnection?: RemoteDesktopBridgeApi["testConnection"];
    cancelRemoteDesktopTestConnection?: RemoteDesktopBridgeApi["cancelTestConnection"];
    respondRemoteDesktopCertDecision?: RemoteDesktopBridgeApi["respondCertDecision"];
    setRemoteDesktopKeyboardGrab?: RemoteDesktopBridgeApi["setKeyboardGrab"];
    saveRemoteDesktopClipboardFile?: RemoteDesktopBridgeApi["saveClipboardFile"];
    openRemoteDesktopSystemClient?: RemoteDesktopBridgeApi["openSystemClient"];
    stopRemoteDesktopSystemTunnel?: RemoteDesktopBridgeApi["stopSystemTunnel"];
    getRemoteDesktopLocalDisplays?: RemoteDesktopBridgeApi["getLocalDisplays"];
    pickRemoteDesktopRdpdrFolder?: RemoteDesktopBridgeApi["rdpdrPickFolder"];
    registerRemoteDesktopRdpdrDrives?: RemoteDesktopBridgeApi["rdpdrRegisterDrives"];
    invokeRemoteDesktopRdpdrOp?: RemoteDesktopBridgeApi["rdpdrOp"];
    cleanupRemoteDesktopRdpdr?: RemoteDesktopBridgeApi["rdpdrCleanup"];
    onRemoteDesktopCertVerify?: RemoteDesktopBridgeApi["onCertVerify"];
    onRemoteDesktopStatus?: RemoteDesktopBridgeApi["onStatus"];
    onRemoteDesktopStats?: RemoteDesktopBridgeApi["onStats"];
    onRemoteDesktopKeyboardGrabChanged?: RemoteDesktopBridgeApi["onKeyboardGrabChanged"];
    remoteDesktop?: RemoteDesktopBridgeApi;
    remoteDesktopRecordings?: RemoteDesktopRecordingsBridgeApi;
  }
}

export class BridgeUnavailableError extends Error {
  constructor(message = "Netcatty bridge unavailable") {
    super(message);
    this.name = "BridgeUnavailableError";
  }
}

export const netcattyBridge = {
  get(): NetcattyBridge | undefined {
    return typeof window !== 'undefined' ? window.netcatty : undefined;
  },

  require(): NetcattyBridge {
    const bridge = window.netcatty;
    if (!bridge) throw new BridgeUnavailableError();
    return bridge;
  },
};
