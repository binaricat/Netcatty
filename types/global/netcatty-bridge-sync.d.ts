import type { S3Config, SyncedFile, WebDAVConfig } from "../../domain/sync";

declare global {
  interface NetcattyBridge {
    setTheme?(theme: 'light' | 'dark' | 'system'): Promise<boolean>;
    setBackgroundColor?(color: string): Promise<boolean>;
    setLanguage?(language: string): Promise<boolean>;
    // Window controls for custom title bar (Windows/Linux)
    windowMinimize?(): Promise<void>;
    windowMaximize?(): Promise<boolean>;
    windowClose?(): Promise<void>;
    windowIsMaximized?(): Promise<boolean>;
    windowIsFullscreen?(): Promise<boolean>;
    windowFocus?(): Promise<boolean>;
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

    // Port Forwarding
    startPortForward?(options: PortForwardOptions): Promise<PortForwardResult>;
    stopPortForward?(tunnelId: string): Promise<PortForwardResult>;
    getPortForwardStatus?(tunnelId: string): Promise<PortForwardStatusResult>;
    listPortForwards?(): Promise<{ tunnelId: string; type: string; status: string }[]>;
    stopAllPortForwards?(): Promise<void>;
    stopPortForwardByRuleId?(ruleId: string): Promise<{ stopped: number }>;
    onPortForwardStatus?(tunnelId: string, cb: PortForwardStatusCallback): () => void;

    // Known Hosts
    readKnownHosts?(): Promise<string | null>;

    // Open URL in default browser. Resolves when the URL is handled by
    // either the system browser or the in-app fallback BrowserWindow.
    // Rejects only in the rare case where both paths fail.
    openExternal?(url: string): Promise<void>;
    openPath?(path: string): Promise<{ success: boolean; error?: string }>;

    // App info (name/version/platform) for About screens
    getAppInfo?(): Promise<{ name: string; version: string; platform: string }>;
    ptyGetChildProcesses?(sessionId: string): Promise<Array<{ pid: number; command: string }>>;
    confirmCloseBusy?(payload: {
      command: string;
      title?: string;
      message?: string;
      cancelLabel?: string;
      closeLabel?: string;
    }): Promise<boolean>;
    getVaultBackupCapabilities?(): Promise<{ encryptionAvailable: boolean }>;
    createVaultBackup?(payload: {
      payload: import('./domain/sync').SyncPayload;
      reason: 'app_version_change' | 'before_restore';
      sourceAppVersion?: string;
      targetAppVersion?: string;
      maxCount?: number;
    }): Promise<{
      created: boolean;
      backup: {
        id: string;
        createdAt: number;
        reason: 'app_version_change' | 'before_restore';
        sourceAppVersion?: string;
        targetAppVersion?: string;
        fingerprint: string;
        preview: {
          hostCount: number;
          keyCount: number;
          snippetCount: number;
          identityCount: number;
          portForwardingRuleCount: number;
        };
      } | null;
    }>;
    listVaultBackups?(): Promise<Array<{
      id: string;
      createdAt: number;
      reason: 'app_version_change' | 'before_restore';
      sourceAppVersion?: string;
      targetAppVersion?: string;
      fingerprint: string;
      preview: {
        hostCount: number;
        keyCount: number;
        snippetCount: number;
        identityCount: number;
        portForwardingRuleCount: number;
      };
    }>>;
    readVaultBackup?(payload: { id: string }): Promise<{
      backup: {
        id: string;
        createdAt: number;
        reason: 'app_version_change' | 'before_restore';
        sourceAppVersion?: string;
        targetAppVersion?: string;
        fingerprint: string;
        preview: {
          hostCount: number;
          keyCount: number;
          snippetCount: number;
          identityCount: number;
          portForwardingRuleCount: number;
        };
      };
      payload: import('./domain/sync').SyncPayload;
    }>;
    trimVaultBackups?(payload: { maxCount: number }): Promise<{ deletedCount: number; keptCount: number }>;
    openVaultBackupDir?(): Promise<{ success: boolean; path: string }>;
    // Subscribe to main-process-driven "vault backups changed" events.
    // Returns an unsubscribe callback. Undefined in non-Electron builds.
    onVaultBackupsChanged?(handler: () => void): () => void;

    // Notify main process the renderer has mounted/painted (used to avoid initial blank screen).
    rendererReady?(): void;

    // Quit guard: subscribe to main-process quit requests that query for dirty editors.
    // Listener is called with no arguments; return value is an unsubscribe function.
    onCheckDirtyEditors?(listener: () => void): () => void;
    // Report the dirty-check result back to the main process.
    reportDirtyEditorsResult?(hasDirty: boolean): void;

    onLanguageChanged?(cb: (language: string) => void): () => void;

    // Chain progress listener for jump host connections
    // Callback receives: (sessionId: string, currentHop: number, totalHops: number, hostLabel: string, status: string, error?: string)
    onChainProgress?(cb: (sessionId: string, hop: number, total: number, label: string, status: string, error?: string) => void): () => void;

    // SFTP connection progress listener (auth method logs)
    onSftpConnectionProgress?(cb: (sessionId: string, label: string, status: string, detail?: string) => void): () => void;

    // OAuth callback server for cloud sync. `prepareOAuthCallback` binds the
    // loopback listener and returns the chosen port (preferred 45678, falls
    // back to an OS-assigned free port if busy). The caller then builds the
    // OAuth URL against `redirectUri`, opens the browser, and finally awaits
    // the code via `awaitOAuthCallback`.
    prepareOAuthCallback?(): Promise<{ sessionId: string; port: number; redirectUri: string }>;
    awaitOAuthCallback?(expectedState?: string, sessionId?: string): Promise<{ code: string; state?: string }>;
    cancelOAuthCallback?(sessionId?: string): Promise<void>;

    // GitHub Device Flow (cloud sync)
    githubStartDeviceFlow?(options?: { clientId?: string; scope?: string }): Promise<{
      deviceCode: string;
      userCode: string;
      verificationUri: string;
      expiresAt: number;
      interval: number;
    }>;
    githubPollDeviceFlowToken?(options: { clientId?: string; deviceCode: string; pollId?: string }): Promise<{
      access_token?: string;
      token_type?: string;
      scope?: string;
      error?: string;
      error_description?: string;
    }>;
    githubCancelDeviceFlowPoll?(pollId: string): Promise<void>;

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
  }
}

export {};
