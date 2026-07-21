
declare global {
  interface NetcattyBridge {
    // Auto-update
    checkForUpdate?(): Promise<{
      available: boolean;
      supported?: boolean;
      checking?: boolean;
      version?: string;
      releaseNotes?: string;
      releaseDate?: string | null;
      error?: string;
    }>;
    downloadUpdate?(): Promise<{ success: boolean; error?: string }>;
    installUpdate?(): void;
    getUpdateStatus?(): Promise<{ status: 'idle' | 'available' | 'downloading' | 'ready' | 'error'; percent: number; error: string | null; version: string | null; isChecking?: boolean }>;

    onUpdateDownloadProgress?(cb: (progress: {
      percent: number;
      bytesPerSecond: number;
      transferred: number;
      total: number;
    }) => void): () => void;
    onUpdateAvailable?(cb: (info: {
      version: string;
      releaseNotes: string;
      releaseDate: string | null;
    }) => void): () => void;
    onUpdateNotAvailable?(cb: () => void): () => void;
    onUpdateDownloaded?(cb: () => void): () => void;
    onUpdateError?(cb: (payload: { error: string }) => void): () => void;
    // Fired when an install was requested but blocked by unsaved editors (#1215).
    onUpdateNeedsSave?(cb: () => void): () => void;
    onSshDeepLink?(cb: (payload: { url?: string }) => void): () => void;
    onTelnetDeepLink?(cb: (payload: { url?: string }) => void): () => void;
    onOpenTerminalPath?(cb: (payload: { path?: string }) => void): () => void;
    setSshDeepLinkEnabled?(enabled: boolean): Promise<boolean | { success: boolean; enabled: boolean }>;
    getSshDeepLinkEnabled?(): Promise<boolean>;
    onJmsDeepLink?(cb: (payload: { url?: string }) => void): () => void;
    setJmsDeepLinkEnabled?(enabled: boolean): Promise<boolean | { success: boolean; enabled: boolean }>;
    getJmsDeepLinkEnabled?(): Promise<boolean>;

    // Global Toggle Hotkey (Quake Mode)
    registerGlobalHotkey?(hotkey: string): Promise<{ success: boolean; enabled?: boolean; error?: string; accelerator?: string }>;
    unregisterGlobalHotkey?(): Promise<{ success: boolean }>;
    getGlobalHotkeyStatus?(): Promise<{ enabled: boolean; hotkey: string | null }>;

    // Auto-Update toggle
    getAutoUpdate?(): Promise<{ enabled: boolean }>;
    setAutoUpdate?(enabled: boolean): Promise<{ success: boolean }>;

    // SSH diagnostic logs
    getSshDebugLogInfo?(): Promise<{
      enabled: boolean;
      path: string;
      exists: boolean;
      size: number;
    }>;
    openSshDebugLogDir?(): Promise<{ success: boolean; error?: string }>;

    // System Tray / Close to Tray
    setCloseToTray?(enabled: boolean): Promise<{ success: boolean; enabled: boolean }>;
    isCloseToTray?(): Promise<{ enabled: boolean }>;

    // App-level HTTP(S) network proxy (cloud sync / AI — not SSH ProxyJump)
    setHttpNetworkProxy?(settings: {
      mode: 'system' | 'direct' | 'custom';
      url: string;
      bypass: string;
    }): Promise<{
      success: boolean;
      settings: { mode: 'system' | 'direct' | 'custom'; url: string; bypass: string };
      electronConfig?: unknown;
    }>;
    getHttpNetworkProxy?(): Promise<{
      settings: { mode: 'system' | 'direct' | 'custom'; url: string; bypass: string };
    }>;
    updateTrayMenuData?(data: {
      sessions?: Array<{ id: string; label: string; hostLabel: string; status: "connecting" | "connected" | "disconnected"; workspaceId?: string; workspaceTitle?: string }>;
      hosts?: Array<{ id: string; label?: string; hostname?: string; group?: string; pinned?: boolean; lastConnectedAt?: number; protocol?: string }>;
      portForwardRules?: Array<{
        id: string;
        label: string;
        type: "local" | "remote" | "dynamic";
        localPort: number;
        remoteHost?: string;
        remotePort?: number;
        status: "inactive" | "connecting" | "active" | "error";
      }>;
    }): Promise<{ success: boolean }>;
    onTrayFocusSession?(callback: (sessionId: string) => void): () => void;
    onTrayTogglePortForward?(callback: (ruleId: string, start: boolean) => void): () => void;

    onTrayPanelJumpToSession?(callback: (sessionId: string) => void): () => void;
    onTrayPanelConnectToHost?(callback: (hostId: string) => void): () => void;
    onTrayPanelCloseSession?(callback: (sessionId: string) => void): () => void;

    hideTrayPanel?(): Promise<{ success: boolean }>;
    openMainWindow?(): Promise<{ success: boolean }>;
    quitApp?(): Promise<{ success: boolean }>;
    jumpToSessionFromTrayPanel?(sessionId: string): Promise<{ success: boolean }>;
    connectToHostFromTrayPanel?(hostId: string): Promise<{ success: boolean }>;
    closeSessionFromTrayPanel?(sessionId: string): Promise<{ success: boolean }>;
    onTrayPanelCloseRequest?(callback: () => void): () => void;
    onTrayPanelRefresh?(callback: () => void): () => void;
    onTrayPanelMenuData?(callback: (data: {
      sessions?: Array<{ id: string; label: string; hostLabel: string; status: "connecting" | "connected" | "disconnected"; workspaceId?: string; workspaceTitle?: string }>;
      hosts?: Array<{ id: string; label?: string; hostname?: string; group?: string; pinned?: boolean; lastConnectedAt?: number; protocol?: string }>;
      portForwardRules?: Array<{
        id: string;
        label: string;
        type: "local" | "remote" | "dynamic";
        localPort: number;
        remoteHost?: string;
        remotePort?: number;
        status: "inactive" | "connecting" | "active" | "error";
        hostId?: string;
      }>;
    }) => void): () => void;
  }
}

export {};
