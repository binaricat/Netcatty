/**
 * useExternalEditorSettings - Reactive store & launcher for External Editor integration
 *
 * Device-local (not cloud-synced because executable paths differ across machines).
 * Uses useSyncExternalStore + window `storage` events so the Settings window and
 * main Terminal/SFTP windows stay immediately in sync.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  buildDirectSshTarget,
  buildSshBridgeHostname,
  getHostKeyForExternalEditor,
  normalizeExternalEditorSettings,
  validateAndNormalizeRemotePath,
  type ExternalEditorConnectionMode,
  type ExternalEditorHostIdentity,
  type ExternalEditorHostTrustPolicy,
  type ExternalEditorPresetId,
  type ExternalEditorSettings,
  type ExternalEditorTargetKind,
} from '../../domain/externalEditor';
import { STORAGE_KEY_EXTERNAL_EDITOR } from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import {
  netcattyBridge,
  type ExternalEditorBridgeConfigStatus,
  type ExternalEditorDetectEntry,
  type ExternalEditorOpenRemoteResult,
} from '../../infrastructure/services/netcattyBridge';

export type {
  ExternalEditorBridgeConfigStatus,
  ExternalEditorDetectEntry,
  ExternalEditorOpenRemoteResult,
};

const subscribers = new Set<() => void>();

function hasBrowserStorage(): boolean {
  return typeof window !== 'undefined' && 'localStorage' in window;
}

function loadExternalEditorSettings(): ExternalEditorSettings {
  if (!hasBrowserStorage()) {
    return normalizeExternalEditorSettings(undefined);
  }
  try {
    const stored = localStorageAdapter.read<Partial<ExternalEditorSettings>>(STORAGE_KEY_EXTERNAL_EDITOR);
    return normalizeExternalEditorSettings(stored);
  } catch {
    return normalizeExternalEditorSettings(undefined);
  }
}

let currentSettings: ExternalEditorSettings = loadExternalEditorSettings();
let storageListenerAttached = false;

function ensureStorageListener() {
  if (storageListenerAttached || typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return;
  }
  storageListenerAttached = true;
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key === STORAGE_KEY_EXTERNAL_EDITOR) {
      writeSettings(loadExternalEditorSettings(), false);
    }
  });
}

ensureStorageListener();

function notifySubscribers() {
  subscribers.forEach((cb) => cb());
}

function writeSettings(next: ExternalEditorSettings, persist = true) {
  currentSettings = normalizeExternalEditorSettings(next);
  if (persist && hasBrowserStorage()) {
    try {
      localStorageAdapter.write(STORAGE_KEY_EXTERNAL_EDITOR, currentSettings);
    } catch {
      // ignore storage write failures in restricted contexts
    }
  }
  notifySubscribers();
}

function subscribe(callback: () => void) {
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
  };
}

export function getExternalEditorSettingsSnapshot(): ExternalEditorSettings {
  return currentSettings;
}

export function updateExternalEditorSettings(
  updater: (prev: ExternalEditorSettings) => ExternalEditorSettings,
): ExternalEditorSettings {
  const next = updater(currentSettings);
  writeSettings(next, true);
  return currentSettings;
}

export function setExternalEditorHostTrust(
  host: ExternalEditorHostIdentity,
  policy: ExternalEditorHostTrustPolicy,
): void {
  const hostKey = getHostKeyForExternalEditor(host);
  if (!hostKey) return;
  updateExternalEditorSettings((prev) => ({
    ...prev,
    trustedHosts: {
      ...prev.trustedHosts,
      [hostKey]: policy,
    },
  }));
}

export function removeExternalEditorHostTrust(hostKey: string): void {
  updateExternalEditorSettings((prev) => {
    if (!Object.prototype.hasOwnProperty.call(prev.trustedHosts, hostKey)) return prev;
    const nextTrusted = { ...prev.trustedHosts };
    delete nextTrusted[hostKey];
    return {
      ...prev,
      trustedHosts: nextTrusted,
    };
  });
}

export interface LaunchRemoteExternalEditorParams {
  editorId?: ExternalEditorPresetId;
  host: ExternalEditorHostIdentity;
  remotePath: string;
  fallbackCwd?: string;
  kind?: ExternalEditorTargetKind;
  sessionId?: string;
  sftpId?: string;
  settings?: ExternalEditorSettings;
}

/**
 * Shared application-layer launcher invoked by both Terminal OSC 7337 handlers
 * and SFTP context menus.
 */
export async function launchRemoteExternalEditor(
  params: LaunchRemoteExternalEditorParams,
): Promise<ExternalEditorOpenRemoteResult> {
  const bridge = netcattyBridge.get();
  if (!bridge?.externalEditor?.openRemote) {
    throw new Error('External editor integration requires the desktop application.');
  }

  const settings = params.settings ?? getExternalEditorSettingsSnapshot();
  const editorId = params.editorId ?? settings.defaultEditor;
  const editorConfig = settings.editors[editorId];

  const validated = validateAndNormalizeRemotePath(params.remotePath, params.fallbackCwd);
  if (!validated.ok) {
    throw new Error('error' in validated ? validated.error : 'Invalid remote path');
  }

  const connectionMode = settings.connectionMode;
  const bridgeHost = connectionMode === 'bridge'
    ? buildSshBridgeHostname(params.host)
    : undefined;
  const directSshTarget = connectionMode === 'direct'
    ? buildDirectSshTarget(params.host) ?? undefined
    : undefined;

  if (connectionMode === 'direct' && !directSshTarget) {
    throw new Error('Cannot construct a valid OpenSSH target for this host.');
  }

  return bridge.externalEditor.openRemote({
    editorId,
    executablePath: editorConfig?.executablePath || undefined,
    customArgs: editorId === 'custom' ? editorConfig?.customArgs : undefined,
    connectionMode,
    bridgeHost,
    directSshTarget,
    sessionId: params.sessionId,
    sftpId: params.sftpId,
    hostId: params.host.hostId,
    hostname: params.host.hostname,
    port: params.host.port,
    username: params.host.username,
    remotePath: validated.path,
    kind: params.kind ?? 'auto',
  });
}

export async function detectInstalledExternalEditors(): Promise<Record<string, ExternalEditorDetectEntry>> {
  const bridge = netcattyBridge.get();
  if (!bridge?.externalEditor?.detect) return {};
  return (await bridge.externalEditor.detect()) || {};
}

export async function getExternalEditorBridgeConfigStatus(): Promise<ExternalEditorBridgeConfigStatus | null> {
  const bridge = netcattyBridge.get();
  if (!bridge?.externalEditor?.getBridgeConfigStatus) return null;
  return (await bridge.externalEditor.getBridgeConfigStatus()) || null;
}

export async function installExternalEditorBridgeConfig(): Promise<ExternalEditorBridgeConfigStatus | null> {
  const bridge = netcattyBridge.get();
  if (!bridge?.externalEditor?.installBridgeConfig) return null;
  return bridge.externalEditor.installBridgeConfig();
}

export async function removeExternalEditorBridgeConfig(): Promise<ExternalEditorBridgeConfigStatus | null> {
  const bridge = netcattyBridge.get();
  if (!bridge?.externalEditor?.removeBridgeConfig) return null;
  return bridge.externalEditor.removeBridgeConfig();
}

export async function selectExternalEditorApplication(): Promise<{ path: string; name?: string } | null> {
  const bridge = netcattyBridge.get();
  if (!bridge?.selectApplication) return null;
  return (await bridge.selectApplication()) || null;
}

function getTerminalAutoSetupSnapshotKey(): string {
  const s = currentSettings;
  return `${s.terminalRequestsEnabled ? 1 : 0}:${s.autoSetupShellIntegration ? 1 : 0}:${s.defaultEditor}`;
}

/**
 * Narrow selector for Terminal panes so edits to unrelated External Editor settings
 * (executable paths, custom args, trust list, bridge mode) never re-render open terminals.
 */
export function useExternalEditorTerminalAutoSetupConfig(): {
  terminalRequestsEnabled: boolean;
  autoSetupShellIntegration: boolean;
  defaultEditor: ExternalEditorPresetId;
} {
  const key = useSyncExternalStore(
    subscribe,
    getTerminalAutoSetupSnapshotKey,
    getTerminalAutoSetupSnapshotKey,
  );
  useEffect(() => {
    ensureStorageListener();
  }, []);
  const [reqFlag, autoFlag, defaultEditor] = key.split(':');
  return {
    terminalRequestsEnabled: reqFlag === '1',
    autoSetupShellIntegration: autoFlag === '1',
    defaultEditor: defaultEditor as ExternalEditorPresetId,
  };
}

export function useExternalEditorSettings() {
  const settings = useSyncExternalStore(
    subscribe,
    getExternalEditorSettingsSnapshot,
    getExternalEditorSettingsSnapshot,
  );

  useEffect(() => {
    ensureStorageListener();
  }, []);

  const setDefaultEditor = useCallback((editorId: ExternalEditorPresetId) => {
    updateExternalEditorSettings((prev) => ({
      ...prev,
      defaultEditor: editorId,
    }));
  }, []);

  const setEditorExecutablePath = useCallback((editorId: ExternalEditorPresetId, executablePath: string) => {
    updateExternalEditorSettings((prev) => ({
      ...prev,
      editors: {
        ...prev.editors,
        [editorId]: {
          ...prev.editors[editorId],
          executablePath,
        },
      },
    }));
  }, []);

  const setCustomEditorArgs = useCallback((customArgs: string[]) => {
    updateExternalEditorSettings((prev) => ({
      ...prev,
      editors: {
        ...prev.editors,
        custom: {
          ...prev.editors.custom,
          customArgs,
        },
      },
    }));
  }, []);

  const setTerminalRequestsEnabled = useCallback((enabled: boolean) => {
    updateExternalEditorSettings((prev) => ({
      ...prev,
      terminalRequestsEnabled: enabled,
    }));
  }, []);

  const setAutoSetupShellIntegration = useCallback((enabled: boolean) => {
    updateExternalEditorSettings((prev) => ({
      ...prev,
      autoSetupShellIntegration: enabled,
    }));
  }, []);

  const setDefaultTrustPolicy = useCallback((policy: ExternalEditorHostTrustPolicy) => {
    updateExternalEditorSettings((prev) => ({
      ...prev,
      defaultTrustPolicy: policy,
    }));
  }, []);

  const setConnectionMode = useCallback((mode: ExternalEditorConnectionMode) => {
    updateExternalEditorSettings((prev) => ({
      ...prev,
      connectionMode: mode,
    }));
  }, []);

  const setHostTrustPolicy = useCallback((hostKey: string, policy: ExternalEditorHostTrustPolicy) => {
    updateExternalEditorSettings((prev) => ({
      ...prev,
      trustedHosts: {
        ...prev.trustedHosts,
        [hostKey]: policy,
      },
    }));
  }, []);

  const removeHostTrustPolicy = useCallback((hostKey: string) => {
    removeExternalEditorHostTrust(hostKey);
  }, []);

  return {
    settings,
    setDefaultEditor,
    setEditorExecutablePath,
    setCustomEditorArgs,
    setTerminalRequestsEnabled,
    setAutoSetupShellIntegration,
    setDefaultTrustPolicy,
    setConnectionMode,
    setHostTrustPolicy,
    removeHostTrustPolicy,
  };
}

/**
 * Application-state hook owning external editor detection, `~/.ssh/config` bridge
 * installation/removal, and application picker lifecycle so UI settings sections
 * stay presentation-only.
 */
export function useExternalEditorEnvironment() {
  const [detectedEditors, setDetectedEditors] = useState<Record<string, ExternalEditorDetectEntry>>({});
  const [detecting, setDetecting] = useState(false);
  const [selectingApp, setSelectingApp] = useState(false);
  const [bridgeStatus, setBridgeStatus] = useState<ExternalEditorBridgeConfigStatus | null>(null);
  const [bridgeBusy, setBridgeBusy] = useState(false);
  const [bridgeError, setBridgeError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshStatus = useCallback(async () => {
    setDetecting(true);
    try {
      const [detected, cfg] = await Promise.all([
        detectInstalledExternalEditors(),
        getExternalEditorBridgeConfigStatus(),
      ]);
      if (!mountedRef.current) return;
      setDetectedEditors(detected);
      setBridgeStatus(cfg);
      setBridgeError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setBridgeError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) {
        setDetecting(false);
      }
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const browseExecutable = useCallback(async (editorId: ExternalEditorPresetId): Promise<string | null> => {
    setSelectingApp(true);
    try {
      const picked = await selectExternalEditorApplication();
      if (picked?.path) {
        updateExternalEditorSettings((prev) => ({
          ...prev,
          editors: {
            ...prev.editors,
            [editorId]: {
              ...prev.editors[editorId],
              executablePath: picked.path,
            },
          },
        }));
        return picked.path;
      }
      return null;
    } catch (err) {
      console.error('[ExternalEditor] Failed to select executable:', err);
      return null;
    } finally {
      if (mountedRef.current) {
        setSelectingApp(false);
      }
    }
  }, []);

  const installBridgeConfig = useCallback(async () => {
    setBridgeBusy(true);
    setBridgeError(null);
    try {
      const status = await installExternalEditorBridgeConfig();
      if (mountedRef.current && status) {
        setBridgeStatus(status);
      }
    } catch (err) {
      if (mountedRef.current) {
        setBridgeError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (mountedRef.current) {
        setBridgeBusy(false);
      }
    }
  }, []);

  const removeBridgeConfig = useCallback(async () => {
    setBridgeBusy(true);
    setBridgeError(null);
    try {
      const status = await removeExternalEditorBridgeConfig();
      if (mountedRef.current && status) {
        setBridgeStatus(status);
      }
    } catch (err) {
      if (mountedRef.current) {
        setBridgeError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (mountedRef.current) {
        setBridgeBusy(false);
      }
    }
  }, []);

  return {
    detectedEditors,
    detecting,
    selectingApp,
    bridgeStatus,
    bridgeBusy,
    bridgeError,
    refreshStatus,
    browseExecutable,
    installBridgeConfig,
    removeBridgeConfig,
  };
}
