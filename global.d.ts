import type { RemoteFile, SftpFilenameEncoding } from "./types";
import type { S3Config, SMBConfig, SyncedFile, WebDAVConfig } from "./domain/sync";

declare global {
  // Extend HTMLInputElement to support webkitdirectory attribute
  namespace JSX {
    interface IntrinsicElements {
      input: React.DetailedHTMLProps<React.InputHTMLAttributes<HTMLInputElement> & {
        webkitdirectory?: string;
      }, HTMLInputElement>;
    }
  }

  // Proxy configuration for SSH connections
  interface NetcattyProxyConfig {
    type: 'http' | 'socks5';
    host: string;
    port: number;
    username?: string;
    password?: string;
  }

  // Jump host configuration for SSH tunneling
  interface NetcattyJumpHost {
    hostname: string;
    port: number;
    username: string;
    password?: string;
    privateKey?: string;
    certificate?: string;
    passphrase?: string;
    publicKey?: string;
    keyId?: string;
    keySource?: 'generated' | 'imported';
    label?: string; // Display label for UI
  }

  // Host key information for verification
  // Reserved for future host key verification UI feature
  interface _NetcattyHostKeyInfo {
    hostname: string;
    port: number;
    keyType: string;
    fingerprint: string;
    publicKey?: string;
  }

  interface NetcattySSHOptions {
    sessionId?: string;
    hostname: string;
    username: string;
    port?: number;
    password?: string;
    privateKey?: string;
    // Optional OpenSSH user certificate
    certificate?: string;
    publicKey?: string; // OpenSSH public key line
    keyId?: string;
    keySource?: 'generated' | 'imported';
    agentForwarding?: boolean;
    cols?: number;
    rows?: number;
    charset?: string;
    extraArgs?: string[];
    startupCommand?: string;
    passphrase?: string;
    // Environment variables to set in the remote shell
    env?: Record<string, string>;
    // Proxy configuration
    proxy?: NetcattyProxyConfig;
    // Jump hosts (bastion chain)
    jumpHosts?: NetcattyJumpHost[];
    // SSH-level keepalive interval in seconds (0 = disabled)
    keepaliveInterval?: number;
    // Use sudo for SFTP server
    sudo?: boolean;
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

  // Port Forwarding Types
  interface PortForwardOptions {
    tunnelId: string;
    type: 'local' | 'remote' | 'dynamic';
    localPort: number;
    bindAddress?: string;
    remoteHost?: string;
    remotePort?: number;
    // SSH connection details
    hostname: string;
    port?: number;
    username: string;
    password?: string;
    privateKey?: string;
  }

  interface PortForwardResult {
    tunnelId: string;
    success: boolean;
    error?: string;
  }

  interface PortForwardStatusResult {
    tunnelId: string;
    status: 'inactive' | 'connecting' | 'active' | 'error';
    type?: 'local' | 'remote' | 'dynamic';
    error?: string;
  }

  type PortForwardStatusCallback = (status: 'inactive' | 'connecting' | 'active' | 'error', error?: string) => void;

  interface NetcattyBridge {
    startSSHSession(options: NetcattySSHOptions): Promise<string>;
    startTelnetSession?(options: {
      sessionId?: string;
      hostname: string;
      port?: number;
      cols?: number;
      rows?: number;
      charset?: string;
      env?: Record<string, string>;
    }): Promise<string>;
    startMoshSession?(options: {
      sessionId?: string;
      hostname: string;
      username?: string;
      port?: number;
      moshServerPath?: string;
      agentForwarding?: boolean;
      cols?: number;
      rows?: number;
      charset?: string;
      env?: Record<string, string>;
    }): Promise<string>;
    startLocalSession?(options: { sessionId?: string; cols?: number; rows?: number; shell?: string; cwd?: string; env?: Record<string, string> }): Promise<string>;
    startSerialSession?(options: {
      sessionId?: string;
      path: string;
      baudRate?: number;
      dataBits?: 5 | 6 | 7 | 8;
      stopBits?: 1 | 1.5 | 2;
      parity?: 'none' | 'even' | 'odd' | 'mark' | 'space';
      flowControl?: 'none' | 'xon/xoff' | 'rts/cts';
    }): Promise<string>;
    listSerialPorts?(): Promise<Array<{
      path: string;
      manufacturer: string;
      serialNumber: string;
      vendorId: string;
      productId: string;
      pnpId: string;
    }>>;
    getDefaultShell?(): Promise<string>;
    validatePath?(path: string, type?: 'file' | 'directory' | 'any'): Promise<{ exists: boolean; isFile: boolean; isDirectory: boolean }>;
    generateKeyPair?(options: {
      type: 'RSA' | 'ECDSA' | 'ED25519';
      bits?: number;
      comment?: string;
    }): Promise<{ success: boolean; privateKey?: string; publicKey?: string; error?: string }>;
    checkSshAgent?(): Promise<{ running: boolean; startupType: string | null; error: string | null }>;
    getDefaultKeys?(): Promise<Array<{ name: string; path: string }>>;
    execCommand(options: {
      hostname: string;
      username: string;
      port?: number;
      password?: string;
      privateKey?: string;
      command: string;
      timeout?: number;
    }): Promise<{ stdout: string; stderr: string; code: number | null }>;
    /** Get current working directory from an active SSH session */
    getSessionPwd?(sessionId: string): Promise<{ success: boolean; cwd?: string; error?: string }>;
    /** Get server stats (CPU, Memory, Disk, Network) from an active SSH session - Linux only */
    getServerStats?(sessionId: string): Promise<{
      success: boolean;
      error?: string;
      stats?: {
        cpu: number | null;           // CPU usage percentage (0-100)
        cpuCores: number | null;      // Number of CPU cores
        cpuPerCore: number[];         // Per-core CPU usage array
        memTotal: number | null;      // Total memory in MB
        memUsed: number | null;       // Used memory in MB (excluding buffers/cache)
        memFree: number | null;       // Free memory in MB
        memBuffers: number | null;    // Buffers in MB
        memCached: number | null;     // Cached in MB
        topProcesses: Array<{         // Top 10 processes by memory
          pid: string;
          memPercent: number;
          command: string;
        }>;
        diskPercent: number | null;   // Disk usage percentage for root partition
        diskUsed: number | null;      // Disk used in GB
        diskTotal: number | null;     // Total disk in GB
        disks: Array<{                // All mounted disks
          mountPoint: string;
          used: number;               // Used in GB
          total: number;              // Total in GB
          percent: number;            // Usage percentage
        }>;
        netRxSpeed: number;           // Total network receive speed (bytes/sec)
        netTxSpeed: number;           // Total network transmit speed (bytes/sec)
        netInterfaces: Array<{        // Per-interface network stats
          name: string;               // Interface name (e.g., eth0, ens33)
          rxBytes: number;            // Total received bytes
          txBytes: number;            // Total transmitted bytes
          rxSpeed: number;            // Receive speed (bytes/sec)
          txSpeed: number;            // Transmit speed (bytes/sec)
        }>;
      };
    }>;
    writeToSession(sessionId: string, data: string): void;
    resizeSession(sessionId: string, cols: number, rows: number): void;
    closeSession(sessionId: string): void;
    onSessionData(sessionId: string, cb: (data: string) => void): () => void;
    onSessionExit(
      sessionId: string,
      cb: (evt: { exitCode?: number; signal?: number }) => void
    ): () => void;
    onAuthFailed?(
      sessionId: string,
      cb: (evt: { sessionId: string; error: string; hostname: string }) => void
    ): () => void;

    // Keyboard-interactive authentication (2FA/MFA)
    onKeyboardInteractive?(
      cb: (request: {
        requestId: string;
        sessionId: string;
        name: string;
        instructions: string;
        prompts: Array<{ prompt: string; echo: boolean }>;
        hostname: string;
        savedPassword?: string | null;
      }) => void
    ): () => void;
    respondKeyboardInteractive?(
      requestId: string,
      responses: string[],
      cancelled?: boolean
    ): Promise<{ success: boolean; error?: string }>;

    // Passphrase request for encrypted SSH keys
    onPassphraseRequest?(
      cb: (request: {
        requestId: string;
        keyPath: string;
        keyName: string;
        hostname?: string;
      }) => void
    ): () => void;
    respondPassphrase?(
      requestId: string,
      passphrase: string,
      cancelled?: boolean
    ): Promise<{ success: boolean; error?: string }>;
    respondPassphraseSkip?(
      requestId: string
    ): Promise<{ success: boolean; error?: string }>;
    onPassphraseTimeout?(
      cb: (event: { requestId: string }) => void
    ): () => void;

    // SFTP operations
    openSftp(options: NetcattySSHOptions): Promise<string>;
    listSftp(sftpId: string, path: string, encoding?: SftpFilenameEncoding): Promise<RemoteFile[]>;
    readSftp(sftpId: string, path: string, encoding?: SftpFilenameEncoding): Promise<string>;
    readSftpBinary?(sftpId: string, path: string, encoding?: SftpFilenameEncoding): Promise<ArrayBuffer>;
    writeSftp(sftpId: string, path: string, content: string, encoding?: SftpFilenameEncoding): Promise<void>;
    writeSftpBinary?(sftpId: string, path: string, content: ArrayBuffer, encoding?: SftpFilenameEncoding): Promise<void>;
    closeSftp(sftpId: string): Promise<void>;
    mkdirSftp(sftpId: string, path: string, encoding?: SftpFilenameEncoding): Promise<void>;
    deleteSftp?(sftpId: string, path: string, encoding?: SftpFilenameEncoding): Promise<void>;
    renameSftp?(sftpId: string, oldPath: string, newPath: string, encoding?: SftpFilenameEncoding): Promise<void>;
    statSftp?(sftpId: string, path: string, encoding?: SftpFilenameEncoding): Promise<SftpStatResult>;
    chmodSftp?(sftpId: string, path: string, mode: string, encoding?: SftpFilenameEncoding): Promise<void>;

    // Write binary with real-time progress callback
    writeSftpBinaryWithProgress?(
      sftpId: string, 
      path: string, 
      content: ArrayBuffer, 
      transferId: string,
      encoding?: SftpFilenameEncoding,
      onProgress?: (transferred: number, total: number, speed: number) => void,
      onComplete?: () => void,
      onError?: (error: string) => void
    ): Promise<{ success: boolean; transferId: string; cancelled?: boolean }>;

    // Cancel an in-progress SFTP upload
    cancelSftpUpload?(transferId: string): Promise<{ success: boolean }>;

    // Transfer with progress
    uploadFile?(sftpId: string, localPath: string, remotePath: string, transferId: string): Promise<void>;
    downloadFile?(sftpId: string, remotePath: string, localPath: string, transferId: string): Promise<void>;
    cancelTransfer?(transferId: string): Promise<void>;
    
    // Compressed folder upload
    startCompressedUpload?(
      options: {
        compressionId: string;
        folderPath: string;
        targetPath: string;
        sftpId: string;
        folderName: string;
      },
      onProgress?: (phase: string, transferred: number, total: number) => void,
      onComplete?: () => void,
      onError?: (error: string) => void
    ): Promise<{ compressionId: string; success?: boolean; error?: string }>;
    cancelCompressedUpload?(compressionId: string): Promise<{ success: boolean }>;
    checkCompressedUploadSupport?(sftpId: string): Promise<{
      supported: boolean;
      localTar: boolean;
      remoteTar: boolean;
      error?: string;
    }>;
    
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
        sourceEncoding?: SftpFilenameEncoding;
        targetEncoding?: SftpFilenameEncoding;
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
    getSystemInfo?(): Promise<{ username: string; hostname: string }>;

    setTheme?(theme: 'light' | 'dark'): Promise<boolean>;
    setBackgroundColor?(color: string): Promise<boolean>;
    setLanguage?(language: string): Promise<boolean>;
    // Window controls for custom title bar (Windows/Linux)
    windowMinimize?(): Promise<void>;
    windowMaximize?(): Promise<boolean>;
    windowClose?(): Promise<void>;
    windowIsMaximized?(): Promise<boolean>;
    windowIsFullscreen?(): Promise<boolean>;
    onWindowFullScreenChanged?(cb: (isFullscreen: boolean) => void): () => void;

    // Settings window
    openSettingsWindow?(): Promise<boolean>;
    closeSettingsWindow?(): Promise<void>;

    // Cross-window settings sync
    notifySettingsChanged?(payload: { key: string; value: unknown }): void;
    onSettingsChanged?(cb: (payload: { key: string; value: unknown }) => void): () => void;

    // Cloud sync master password (stored in-memory + persisted via Electron safeStorage)
    cloudSyncSetSessionPassword?(password: string): Promise<boolean>;
    cloudSyncGetSessionPassword?(): Promise<string | null>;
    cloudSyncClearSessionPassword?(): Promise<boolean>;

    // Cloud sync network operations (proxied via main process)
    cloudSyncWebdavInitialize?(config: WebDAVConfig): Promise<{ resourceId: string | null }>;
    cloudSyncWebdavUpload?(
      config: WebDAVConfig,
      syncedFile: SyncedFile
    ): Promise<{ resourceId: string }>;
    cloudSyncWebdavDownload?(config: WebDAVConfig): Promise<{ syncedFile: SyncedFile | null }>;
    cloudSyncWebdavDelete?(config: WebDAVConfig): Promise<{ ok: true }>;

    cloudSyncS3Initialize?(config: S3Config): Promise<{ resourceId: string | null }>;
    cloudSyncS3Upload?(
      config: S3Config,
      syncedFile: SyncedFile
    ): Promise<{ resourceId: string }>;
    cloudSyncS3Download?(config: S3Config): Promise<{ syncedFile: SyncedFile | null }>;
    cloudSyncS3Delete?(config: S3Config): Promise<{ ok: true }>;

    cloudSyncSmbInitialize?(config: SMBConfig): Promise<{ resourceId: string | null }>;
    cloudSyncSmbUpload?(
      config: SMBConfig,
      syncedFile: SyncedFile
    ): Promise<{ resourceId: string }>;
    cloudSyncSmbDownload?(config: SMBConfig): Promise<{ syncedFile: SyncedFile | null }>;
    cloudSyncSmbDelete?(config: SMBConfig): Promise<{ ok: true }>;

    // Port Forwarding
    startPortForward?(options: PortForwardOptions): Promise<PortForwardResult>;
    stopPortForward?(tunnelId: string): Promise<PortForwardResult>;
    getPortForwardStatus?(tunnelId: string): Promise<PortForwardStatusResult>;
    listPortForwards?(): Promise<{ tunnelId: string; type: string; status: string }[]>;
    onPortForwardStatus?(tunnelId: string, cb: PortForwardStatusCallback): () => void;

    // Known Hosts
    readKnownHosts?(): Promise<string | null>;

    // Open URL in default browser
    openExternal?(url: string): Promise<void>;

    // App info (name/version/platform) for About screens
    getAppInfo?(): Promise<{ name: string; version: string; platform: string }>;

    // Notify main process the renderer has mounted/painted (used to avoid initial blank screen).
    rendererReady?(): void;

    onLanguageChanged?(cb: (language: string) => void): () => void;

    // Chain progress listener for jump host connections
    // Callback receives: (currentHop: number, totalHops: number, hostLabel: string, status: string)
    onChainProgress?(cb: (hop: number, total: number, label: string, status: string) => void): () => void;

    // OAuth callback server for cloud sync
    startOAuthCallback?(expectedState?: string): Promise<{ code: string; state?: string }>;
    cancelOAuthCallback?(): Promise<void>;

    // GitHub Device Flow (cloud sync)
    githubStartDeviceFlow?(options?: { clientId?: string; scope?: string }): Promise<{
      deviceCode: string;
      userCode: string;
      verificationUri: string;
      expiresAt: number;
      interval: number;
    }>;
    githubPollDeviceFlowToken?(options: { clientId?: string; deviceCode: string }): Promise<{
      access_token?: string;
      token_type?: string;
      scope?: string;
      error?: string;
      error_description?: string;
    }>;

    // Google OAuth (cloud sync) - proxied via main process to avoid CORS
    googleExchangeCodeForTokens?(options: {
      clientId: string;
      clientSecret?: string;
      code: string;
      codeVerifier: string;
      redirectUri: string;
    }): Promise<{
      accessToken: string;
      refreshToken?: string;
      expiresAt?: number;
      tokenType: string;
      scope?: string;
    }>;
    googleRefreshAccessToken?(options: {
      clientId: string;
      clientSecret?: string;
      refreshToken: string;
    }): Promise<{
      accessToken: string;
      refreshToken: string;
      expiresAt?: number;
      tokenType: string;
      scope?: string;
    }>;
    googleGetUserInfo?(options: { accessToken: string }): Promise<{
      id: string;
      email: string;
      name: string;
      picture?: string;
    }>;

    // Google Drive API (cloud sync) - proxied via main process to avoid CORS/COEP issues
    googleDriveFindSyncFile?(options: { accessToken: string; fileName?: string }): Promise<{ fileId: string | null }>;
    googleDriveCreateSyncFile?(options: { accessToken: string; fileName?: string; syncedFile: unknown }): Promise<{ fileId: string }>;
    googleDriveUpdateSyncFile?(options: { accessToken: string; fileId: string; syncedFile: unknown }): Promise<{ ok: true }>;
    googleDriveDownloadSyncFile?(options: { accessToken: string; fileId: string }): Promise<{ syncedFile: unknown | null }>;
    googleDriveDeleteSyncFile?(options: { accessToken: string; fileId: string }): Promise<{ ok: true }>;

    // OneDrive OAuth + Graph (cloud sync) - proxied via main process to avoid CORS
    onedriveExchangeCodeForTokens?(options: {
      clientId: string;
      code: string;
      codeVerifier: string;
      redirectUri: string;
      scope?: string;
    }): Promise<{
      accessToken: string;
      refreshToken?: string;
      expiresAt?: number;
      tokenType: string;
      scope?: string;
    }>;
    onedriveRefreshAccessToken?(options: {
      clientId: string;
      refreshToken: string;
      scope?: string;
    }): Promise<{
      accessToken: string;
      refreshToken: string;
      expiresAt?: number;
      tokenType: string;
      scope?: string;
    }>;
    onedriveGetUserInfo?(options: { accessToken: string }): Promise<{
      id: string;
      email: string;
      name: string;
      avatarDataUrl?: string;
    }>;
    onedriveFindSyncFile?(options: { accessToken: string; fileName?: string }): Promise<{ fileId: string | null }>;
    onedriveUploadSyncFile?(options: { accessToken: string; fileName?: string; syncedFile: unknown }): Promise<{ fileId: string | null }>;
    onedriveDownloadSyncFile?(options: { accessToken: string; fileId?: string; fileName?: string }): Promise<{ syncedFile: unknown | null }>;
    onedriveDeleteSyncFile?(options: { accessToken: string; fileId: string }): Promise<{ ok: true }>;

    // File opener helpers (for "Open With" feature)
    selectApplication?(): Promise<{ path: string; name: string } | null>;
    openWithApplication?(filePath: string, appPath: string): Promise<boolean>;
    downloadSftpToTemp?(sftpId: string, remotePath: string, fileName: string, encoding?: SftpFilenameEncoding): Promise<string>;

    // Save dialog for file downloads
    showSaveDialog?(defaultPath: string, filters?: Array<{ name: string; extensions: string[] }>): Promise<string | null>;

    // File watcher for auto-sync feature
    startFileWatch?(localPath: string, remotePath: string, sftpId: string, encoding?: SftpFilenameEncoding): Promise<{ watchId: string }>;
    stopFileWatch?(watchId: string, cleanupTempFile?: boolean): Promise<{ success: boolean }>;
    listFileWatches?(): Promise<Array<{ watchId: string; localPath: string; remotePath: string; sftpId: string }>>;
    registerTempFile?(sftpId: string, localPath: string): Promise<{ success: boolean }>;
    onFileWatchSynced?(cb: (payload: { watchId: string; localPath: string; remotePath: string; bytesWritten: number }) => void): () => void;
    onFileWatchError?(cb: (payload: { watchId: string; localPath: string; remotePath: string; error: string }) => void): () => void;

    // Temp file cleanup
    deleteTempFile?(filePath: string): Promise<{ success: boolean }>;

    // Temp directory management
    getTempDirInfo?(): Promise<{ path: string; fileCount: number; totalSize: number }>;
    clearTempDir?(): Promise<{ deletedCount: number; failedCount: number; error?: string }>;
    getTempDirPath?(): Promise<string>;
    openTempDir?(): Promise<{ success: boolean }>;

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

    // Get file path from File object (for drag-and-drop, uses Electron's webUtils)
    getPathForFile?(file: File): string | undefined;
  }

  interface Window {
    netcatty?: NetcattyBridge;
  }

}

export { };
