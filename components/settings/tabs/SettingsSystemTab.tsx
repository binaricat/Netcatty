/**
 * Settings System Tab - System information, temp file management, session logs, and global hotkey
 */
import { ChevronDown, ChevronRight, Download, ExternalLink, FolderOpen, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import React, { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../../application/i18n/I18nProvider";
import { getCredentialProtectionAvailability } from "../../../infrastructure/services/credentialProtection";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import type { UpdateState } from '../../../application/state/useUpdateCheck';
import { SessionLogFormat, keyEventToString } from "../../../domain/models";
import type { HttpNetworkProxyMode, HttpNetworkProxySettings } from "../../../domain/httpNetworkProxy";
import { Button } from "../../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import { Toggle, Select, SettingRow, SectionHeader, SettingCard, SettingsTabContent } from "../settings-ui";
import { cn } from "../../../lib/utils";

interface CrashLogFile {
  fileName: string;
  date: string;
  size: number;
  entryCount: number;
}

interface CrashLogEntry {
  timestamp: string;
  source: string;
  message: string;
  stack?: string;
  errorMeta?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  pid?: number;
  platform?: string;
  arch?: string;
  version?: string;
  electronVersion?: string;
  osVersion?: string;
  memoryMB?: { rss: number; heapUsed: number; heapTotal: number };
  activeSessionCount?: number;
  uptimeSeconds?: number;
}

interface TempDirInfo {
  path: string;
  fileCount: number;
  totalSize: number;
}

interface SshDebugLogInfo {
  enabled: boolean;
  path: string;
  exists: boolean;
  size: number;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/** Returns a locale-agnostic relative time string for the given timestamp. */
function formatLastChecked(
  timestamp: number | null,
  t: (key: string) => string,
): string {
  if (!timestamp) return '';
  const diffMs = Date.now() - timestamp;
  if (diffMs < 0) return t('settings.update.lastCheckedJustNow');
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return t('settings.update.lastCheckedJustNow');
  if (diffMins < 60)
    return t('settings.update.lastCheckedMinutesAgo').replace('{n}', String(diffMins));
  const diffHours = Math.floor(diffMins / 60);
  return t('settings.update.lastCheckedHoursAgo').replace('{n}', String(diffHours));
}

interface SettingsSystemTabProps {
  sessionLogsEnabled: boolean;
  setSessionLogsEnabled: (enabled: boolean) => void;
  sessionLogsDir: string;
  setSessionLogsDir: (dir: string) => void;
  sessionLogsFormat: SessionLogFormat;
  setSessionLogsFormat: (format: SessionLogFormat) => void;
  sessionLogsTimestampsEnabled: boolean;
  setSessionLogsTimestampsEnabled: (enabled: boolean) => void;
  sshDebugLogsEnabled: boolean;
  setSshDebugLogsEnabled: (enabled: boolean) => void;
  sshDeepLinkEnabled: boolean;
  setSshDeepLinkEnabled: (enabled: boolean) => void;
  jmsDeepLinkEnabled: boolean;
  setJmsDeepLinkEnabled: (enabled: boolean) => void;
  restorePreviousSession: boolean;
  setRestorePreviousSession: (enabled: boolean) => void;
  restoreTerminalCwd: boolean;
  setRestoreTerminalCwd: (enabled: boolean) => void;
  toggleWindowHotkey: string;
  setToggleWindowHotkey: (hotkey: string) => void;
  closeToTray: boolean;
  setCloseToTray: (enabled: boolean) => void;
  httpNetworkProxy: HttpNetworkProxySettings;
  setHttpNetworkProxy: (settings: HttpNetworkProxySettings | ((prev: HttpNetworkProxySettings) => HttpNetworkProxySettings)) => void;
  hotkeyRegistrationError: string | null;
  globalHotkeyEnabled: boolean;
  setGlobalHotkeyEnabled: (enabled: boolean) => void;
  autoUpdateEnabled: boolean;
  setAutoUpdateEnabled: (enabled: boolean) => void;
  // Unified update state — from useUpdateCheck hook in SettingsPageContent
  updateState: UpdateState;
  checkNow: () => Promise<unknown>;
  installUpdate: () => void;
  openReleasePage: () => void;
  startDownload: () => void;
}

const SettingsSystemTab: React.FC<SettingsSystemTabProps> = ({
  sessionLogsEnabled,
  setSessionLogsEnabled,
  sessionLogsDir,
  setSessionLogsDir,
  sessionLogsFormat,
  setSessionLogsFormat,
  sessionLogsTimestampsEnabled,
  setSessionLogsTimestampsEnabled,
  sshDebugLogsEnabled,
  setSshDebugLogsEnabled,
  sshDeepLinkEnabled,
  setSshDeepLinkEnabled,
  jmsDeepLinkEnabled,
  setJmsDeepLinkEnabled,
  restorePreviousSession,
  setRestorePreviousSession,
  restoreTerminalCwd,
  setRestoreTerminalCwd,
  toggleWindowHotkey,
  setToggleWindowHotkey,
  closeToTray,
  setCloseToTray,
  httpNetworkProxy,
  setHttpNetworkProxy,
  hotkeyRegistrationError,
  globalHotkeyEnabled,
  setGlobalHotkeyEnabled,
  autoUpdateEnabled,
  setAutoUpdateEnabled,
  updateState,
  checkNow,
  installUpdate,
  openReleasePage,
  startDownload,
}) => {
  const { t } = useI18n();
  const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

  const [tempDirInfo, setTempDirInfo] = useState<TempDirInfo | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [clearResult, setClearResult] = useState<{ deletedCount: number; failedCount: number } | null>(null);
  const [isRecordingHotkey, setIsRecordingHotkey] = useState(false);
  const [hotkeyError, setHotkeyError] = useState<string | null>(null);
  const [credentialsAvailable, setCredentialsAvailable] = useState<boolean | null>(null);
  const [isCheckingCredentials, setIsCheckingCredentials] = useState(false);
  const [crashLogs, setCrashLogs] = useState<CrashLogFile[]>([]);
  const [isLoadingCrashLogs, setIsLoadingCrashLogs] = useState(false);
  const [expandedLog, setExpandedLog] = useState<string | null>(null);
  const [logEntries, setLogEntries] = useState<CrashLogEntry[]>([]);
  const [isClearingCrashLogs, setIsClearingCrashLogs] = useState(false);
  const [crashLogClearResult, setCrashLogClearResult] = useState<{ deletedCount: number } | null>(null);
  const [sshDebugLogInfo, setSshDebugLogInfo] = useState<SshDebugLogInfo | null>(null);
  const [isLoadingSshDebugLogInfo, setIsLoadingSshDebugLogInfo] = useState(false);

  const [appVersion, setAppVersion] = useState('');

  // Load app version on mount
  useEffect(() => {
    const promise = netcattyBridge.get()?.getAppInfo?.();
    if (promise) {
      promise.then((info) => {
        setAppVersion(info?.version ?? '');
      }).catch(() => {});
    }
  }, []);

  const loadTempDirInfo = useCallback(async () => {
    const bridge = netcattyBridge.get();
    if (!bridge?.getTempDirInfo) return;

    setIsLoading(true);
    try {
      const info = await bridge.getTempDirInfo();
      setTempDirInfo(info);
    } catch (err) {
      console.error("[SettingsSystemTab] Failed to get temp dir info:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTempDirInfo();
  }, [loadTempDirInfo]);

  const loadCredentialProtectionStatus = useCallback(async () => {
    setIsCheckingCredentials(true);
    try {
      const available = await getCredentialProtectionAvailability();
      setCredentialsAvailable(available);
    } finally {
      setIsCheckingCredentials(false);
    }
  }, []);

  useEffect(() => {
    void loadCredentialProtectionStatus();
  }, [loadCredentialProtectionStatus]);

  const loadCrashLogs = useCallback(async () => {
    const bridge = netcattyBridge.get();
    if (!bridge?.getCrashLogs) return;
    setIsLoadingCrashLogs(true);
    try {
      const logs = await bridge.getCrashLogs();
      setCrashLogs(logs);
    } catch (err) {
      console.error("[SettingsSystemTab] Failed to load crash logs:", err);
    } finally {
      setIsLoadingCrashLogs(false);
    }
  }, []);

  useEffect(() => {
    void loadCrashLogs();
  }, [loadCrashLogs]);

  const loadSshDebugLogInfo = useCallback(async () => {
    const bridge = netcattyBridge.get();
    if (!bridge?.getSshDebugLogInfo) return;
    setIsLoadingSshDebugLogInfo(true);
    try {
      const info = await bridge.getSshDebugLogInfo();
      setSshDebugLogInfo(info);
    } catch (err) {
      console.error("[SettingsSystemTab] Failed to load SSH debug log info:", err);
    } finally {
      setIsLoadingSshDebugLogInfo(false);
    }
  }, []);

  useEffect(() => {
    void loadSshDebugLogInfo();
  }, [loadSshDebugLogInfo, sshDebugLogsEnabled]);

  const expandRequestRef = React.useRef(0);
  const handleExpandCrashLog = useCallback(async (fileName: string) => {
    if (expandedLog === fileName) {
      setExpandedLog(null);
      setLogEntries([]);
      return;
    }
    const bridge = netcattyBridge.get();
    if (!bridge?.readCrashLog) return;
    const requestId = ++expandRequestRef.current;
    // Optimistically show expanded state while loading
    setExpandedLog(fileName);
    setLogEntries([]);
    try {
      const entries = await bridge.readCrashLog(fileName);
      // Discard if user clicked a different file while awaiting
      if (expandRequestRef.current !== requestId) return;
      setLogEntries(entries);
    } catch (err) {
      if (expandRequestRef.current !== requestId) return;
      console.error("[SettingsSystemTab] Failed to read crash log:", err);
    }
  }, [expandedLog]);

  const handleClearCrashLogs = useCallback(async () => {
    const bridge = netcattyBridge.get();
    if (!bridge?.clearCrashLogs) return;
    setIsClearingCrashLogs(true);
    setCrashLogClearResult(null);
    try {
      const result = await bridge.clearCrashLogs();
      setCrashLogClearResult(result);
      setExpandedLog(null);
      setLogEntries([]);
      // Reload the list so partial failures still show remaining files
      await loadCrashLogs();
    } catch (err) {
      console.error("[SettingsSystemTab] Failed to clear crash logs:", err);
    } finally {
      setIsClearingCrashLogs(false);
    }
  }, [loadCrashLogs]);

  const handleOpenCrashLogsDir = useCallback(async () => {
    const bridge = netcattyBridge.get();
    if (!bridge?.openCrashLogsDir) return;
    await bridge.openCrashLogsDir();
  }, []);

  const handleClearTempFiles = useCallback(async () => {
    const bridge = netcattyBridge.get();
    if (!bridge?.clearTempDir) return;

    setIsClearing(true);
    setClearResult(null);
    try {
      const result = await bridge.clearTempDir();
      setClearResult(result);
      // Refresh info after clearing
      await loadTempDirInfo();
    } catch (err) {
      console.error("[SettingsSystemTab] Failed to clear temp dir:", err);
    } finally {
      setIsClearing(false);
    }
  }, [loadTempDirInfo]);

  const handleOpenTempDir = useCallback(async () => {
    const bridge = netcattyBridge.get();
    if (!tempDirInfo?.path || !bridge?.openTempDir) return;
    await bridge.openTempDir();
  }, [tempDirInfo]);

  const handleSelectSessionLogsDir = useCallback(async () => {
    const bridge = netcattyBridge.get();
    if (!bridge?.selectSessionLogsDir) return;

    try {
      const result = await bridge.selectSessionLogsDir();
      if (result.success && result.directory) {
        setSessionLogsDir(result.directory);
      }
    } catch (err) {
      console.error("[SettingsSystemTab] Failed to select directory:", err);
    }
  }, [setSessionLogsDir]);

  const handleOpenSessionLogsDir = useCallback(async () => {
    const bridge = netcattyBridge.get();
    if (!sessionLogsDir || !bridge?.openSessionLogsDir) return;

    try {
      await bridge.openSessionLogsDir(sessionLogsDir);
    } catch (err) {
      console.error("[SettingsSystemTab] Failed to open directory:", err);
    }
  }, [sessionLogsDir]);

  const handleOpenSshDebugLogDir = useCallback(async () => {
    const bridge = netcattyBridge.get();
    if (!bridge?.openSshDebugLogDir) return;
    await bridge.openSshDebugLogDir();
  }, []);

  // Handle global toggle hotkey recording
  const cancelHotkeyRecording = useCallback(() => {
    setIsRecordingHotkey(false);
  }, []);

  const handleResetHotkey = useCallback(() => {
    // Reset to default hotkey (Ctrl+` or ⌃+` on Mac)
    const defaultHotkey = isMac ? '⌃ + `' : 'Ctrl + `';
    setToggleWindowHotkey(defaultHotkey);
    setHotkeyError(null);
  }, [isMac, setToggleWindowHotkey]);

  // Hotkey recording effect
  useEffect(() => {
    if (!isRecordingHotkey) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") {
        cancelHotkeyRecording();
        return;
      }

      // Ignore modifier-only keys
      if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return;

      const keyString = keyEventToString(e, isMac);
      setToggleWindowHotkey(keyString);
      setHotkeyError(null);
      cancelHotkeyRecording();
    };

    const handleClick = () => {
      cancelHotkeyRecording();
    };

    const timer = setTimeout(() => {
      window.addEventListener("click", handleClick, true);
    }, 100);

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("click", handleClick, true);
    };
  }, [isRecordingHotkey, isMac, setToggleWindowHotkey, cancelHotkeyRecording]);

  const formatOptions = [
    { value: "txt", label: t("settings.sessionLogs.formatTxt") },
    { value: "raw", label: t("settings.sessionLogs.formatRaw") },
    { value: "html", label: t("settings.sessionLogs.formatHtml") },
  ];

  return (
    <SettingsTabContent value="system">
          <SectionHeader title={t('settings.update.title')} />
            <SettingCard className="space-y-3 py-4">
              {/* Current version */}
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">
                  {t('settings.update.currentVersion')}
                </span>
                <span className="text-sm font-mono">
                  {updateState.currentVersion || appVersion || '...'}
                </span>
              </div>

              {/* Status message — priority: autoDownloadStatus > isChecking/manualCheckStatus */}
              {updateState.autoDownloadStatus === 'downloading' && (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    {t('settings.update.downloading').replace('{percent}', String(updateState.downloadPercent))}
                  </p>
                  <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-primary transition-all duration-300"
                      style={{ width: `${updateState.downloadPercent}%` }}
                    />
                  </div>
                </div>
              )}
              {updateState.autoDownloadStatus === 'ready' && (
                <p className="text-sm text-green-600 dark:text-green-400">
                  {t('settings.update.readyToInstall')}
                </p>
              )}
              {updateState.autoDownloadStatus === 'error' && (
                <p className="text-sm text-destructive">
                  {updateState.downloadError || t('settings.update.error')}
                </p>
              )}
              {updateState.autoDownloadStatus === 'idle' && (
                <>
                  {updateState.manualCheckStatus === 'up-to-date' && (
                    <p className="text-sm text-green-600 dark:text-green-400">
                      {t('settings.update.upToDate')}
                    </p>
                  )}
                  {(updateState.manualCheckStatus === 'available' || (updateState.manualCheckStatus === 'idle' && updateState.hasUpdate)) && (
                    <p className="text-sm text-blue-600 dark:text-blue-400">
                      {t('settings.update.available').replace(
                        '{version}',
                        updateState.latestRelease?.version ?? ''
                      )}
                    </p>
                  )}
                  {updateState.manualCheckStatus === 'error' && (
                    <p className="text-sm text-destructive">
                      {updateState.error || t('settings.update.error')}
                    </p>
                  )}
                </>
              )}

              {/* Action buttons */}
              <div className="flex items-center gap-2 pt-1">
                {/* Checking spinner — shown when isChecking OR manualCheckStatus=checking, but no active download */}
                {(updateState.autoDownloadStatus === 'idle' || updateState.autoDownloadStatus === 'error') &&
                  (updateState.isChecking || updateState.manualCheckStatus === 'checking') ? (
                  <Button variant="outline" size="sm" disabled>
                    <RefreshCw size={14} className="mr-1.5 animate-spin" />
                    {t('settings.update.checking')}
                  </Button>
                ) : (updateState.autoDownloadStatus === 'idle' || updateState.autoDownloadStatus === 'error') ? (
                  /* Check button — shown in idle states and in error state (allows retry) */
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void checkNow()}
                  >
                    <RefreshCw size={14} className="mr-1.5" />
                    {t('settings.update.checkForUpdates')}
                  </Button>
                ) : null}

                {/* Install button — shown when download is complete */}
                {updateState.autoDownloadStatus === 'ready' && (
                  <Button variant="default" size="sm" onClick={installUpdate}>
                    <RotateCcw size={14} className="mr-1.5" />
                    {t('settings.update.restartNow')}
                  </Button>
                )}

                {/* Open releases — shown on download error */}
                {updateState.autoDownloadStatus === 'error' && (
                  <Button variant="ghost" size="sm" onClick={openReleasePage}>
                    <ExternalLink size={14} className="mr-1.5" />
                    {t('settings.update.manualDownload')}
                  </Button>
                )}

                {/* Download button — shown when update found and no download in progress */}
                {updateState.autoDownloadStatus === 'idle' &&
                  updateState.manualCheckStatus === 'available' && (
                  <Button variant="outline" size="sm" onClick={startDownload}>
                    <Download size={14} className="mr-1.5" />
                    {t('update.downloadNow')}
                  </Button>
                )}

                {/* Open releases — fallback for unsupported platforms or check errors */}
                {updateState.autoDownloadStatus === 'idle' &&
                  (updateState.manualCheckStatus === 'available' || updateState.manualCheckStatus === 'error' || (updateState.manualCheckStatus === 'idle' && updateState.hasUpdate)) && (
                  <Button variant="ghost" size="sm" onClick={openReleasePage}>
                    <ExternalLink size={14} className="mr-1.5" />
                    {t('settings.update.manualDownload')}
                  </Button>
                )}
              </div>
              <SettingRow
                label={t('settings.update.autoUpdateEnabled')}
                description={t('settings.update.autoUpdateEnabledDesc')}
              >
                <Toggle
                  checked={autoUpdateEnabled}
                  onChange={setAutoUpdateEnabled}
                />
              </SettingRow>
            </SettingCard>
            <p className="text-xs text-muted-foreground">
              {updateState.lastCheckedAt && (
                <span>
                  {t('settings.update.lastCheckedPrefix')}
                  {formatLastChecked(updateState.lastCheckedAt, t)}
                  {'　'}
                </span>
              )}
              {t('settings.update.hint')}
            </p>

          <SectionHeader title={t("settings.system.networkProxy.title")} />
            <SettingCard className="space-y-4 py-4">
              <SettingRow
                label={t("settings.system.networkProxy.mode")}
                description={t("settings.system.networkProxy.description")}
              >
                <Select
                  value={httpNetworkProxy.mode}
                  onChange={(value) => {
                    const mode = value as HttpNetworkProxyMode;
                    setHttpNetworkProxy((prev) => ({ ...prev, mode }));
                  }}
                  options={[
                    { value: "system", label: t("settings.system.networkProxy.mode.system") },
                    { value: "direct", label: t("settings.system.networkProxy.mode.direct") },
                    { value: "custom", label: t("settings.system.networkProxy.mode.custom") },
                  ]}
                />
              </SettingRow>
              {httpNetworkProxy.mode === "custom" && (
                <>
                  <SettingRow
                    label={t("settings.system.networkProxy.url")}
                    description={t("settings.system.networkProxy.url.desc")}
                  >
                    <input
                      type="text"
                      value={httpNetworkProxy.url}
                      onChange={(e) => {
                        const url = e.target.value;
                        setHttpNetworkProxy((prev) => ({ ...prev, url }));
                      }}
                      placeholder={t("settings.system.networkProxy.url.placeholder")}
                      className="w-64 h-9 rounded-md border border-input bg-background px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </SettingRow>
                  <SettingRow
                    label={t("settings.system.networkProxy.bypass")}
                    description={t("settings.system.networkProxy.bypass.desc")}
                  >
                    <input
                      type="text"
                      value={httpNetworkProxy.bypass}
                      onChange={(e) => {
                        const bypass = e.target.value;
                        setHttpNetworkProxy((prev) => ({ ...prev, bypass }));
                      }}
                      placeholder={t("settings.system.networkProxy.bypass.placeholder")}
                      className="w-64 h-9 rounded-md border border-input bg-background px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </SettingRow>
                </>
              )}
            </SettingCard>
            <p className="text-xs text-muted-foreground">
              {t("settings.system.networkProxy.hint")}
            </p>

          <SectionHeader title={t("settings.system.credentials.title")} />
            <SettingCard className="space-y-3 py-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm text-muted-foreground">
                    {t("settings.system.credentials.status")}
                  </p>
                  <p
                    className={cn(
                      "text-sm font-medium mt-1",
                      credentialsAvailable === true && "text-emerald-600 dark:text-emerald-400",
                      credentialsAvailable === false && "text-amber-600 dark:text-amber-400",
                    )}
                  >
                    {isCheckingCredentials
                      ? t("settings.system.credentials.checking")
                      : credentialsAvailable === true
                        ? t("settings.system.credentials.available")
                        : credentialsAvailable === false
                          ? t("settings.system.credentials.unavailable")
                          : t("settings.system.credentials.unknown")}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={loadCredentialProtectionStatus}
                  disabled={isCheckingCredentials}
                  className="gap-1.5"
                >
                  <RefreshCw size={14} className={isCheckingCredentials ? "animate-spin" : ""} />
                  {t("settings.system.refresh")}
                </Button>
              </div>

              {credentialsAvailable === false && (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  {t("settings.system.credentials.unavailableHint")}
                </p>
              )}

              <p className="text-xs text-muted-foreground">
                {t("settings.system.credentials.portabilityHint")}
              </p>
            </SettingCard>

          <SectionHeader title={t("settings.system.crashLogs.title")} />
            <SettingCard className="space-y-3 py-4">
              <p className="text-sm text-muted-foreground">
                {t("settings.system.crashLogs.description")}
              </p>

              {crashLogs.length === 0 && !isLoadingCrashLogs && (
                <p className="text-sm text-muted-foreground italic">
                  {t("settings.system.crashLogs.noLogs")}
                </p>
              )}

              {crashLogs.length > 0 && (
                <div className="space-y-2">
                  {crashLogs.map((log) => (
                    <div key={log.fileName} className="border border-border/60 rounded-md overflow-hidden">
                      <button
                        onClick={() => handleExpandCrashLog(log.fileName)}
                        className="w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-muted/50 transition-colors"
                      >
                        <div className="flex items-center gap-2">
                          {expandedLog === log.fileName ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          <span className="font-mono">{log.date}</span>
                          <span className="text-muted-foreground">
                            ({t("settings.system.crashLogs.entries").replace("{count}", String(log.entryCount))})
                          </span>
                        </div>
                        <span className="text-xs text-muted-foreground">{formatBytes(log.size)}</span>
                      </button>

                      {expandedLog === log.fileName && logEntries.length > 0 && (
                        <div className="border-t border-border/60 max-h-64 overflow-y-auto">
                          {logEntries.map((entry, idx) => (
                            <div key={idx} className="px-3 py-2 text-xs border-b border-border/30 last:border-b-0 space-y-1">
                              <div className="flex items-center gap-3 flex-wrap">
                                <span className="font-mono text-muted-foreground">
                                  {new Date(entry.timestamp).toLocaleTimeString()}
                                </span>
                                <span className="px-1.5 py-0.5 rounded bg-destructive/10 text-destructive font-medium">
                                  {entry.source}
                                </span>
                              </div>
                              <p className="font-mono break-all">{entry.message}</p>
                              {entry.errorMeta && Object.keys(entry.errorMeta).length > 0 && (
                                <div className="flex items-center gap-2 flex-wrap">
                                  {Object.entries(entry.errorMeta).map(([k, v]) => (
                                    <span key={k} className="px-1.5 py-0.5 rounded bg-muted font-mono">
                                      {k}={String(v)}
                                    </span>
                                  ))}
                                </div>
                              )}
                              {entry.extra && Object.keys(entry.extra).length > 0 && (
                                <div className="flex items-center gap-2 flex-wrap">
                                  {Object.entries(entry.extra).map(([k, v]) => (
                                    <span key={k} className="px-1.5 py-0.5 rounded bg-muted font-mono">
                                      {k}={String(v)}
                                    </span>
                                  ))}
                                </div>
                              )}
                              {(() => {
                                const parts: string[] = [];
                                if (entry.version) parts.push(`v${entry.version}`);
                                if (entry.electronVersion) parts.push(`Electron ${entry.electronVersion}`);
                                if (entry.platform) parts.push(`${entry.platform}/${entry.arch}`);
                                if (entry.osVersion) parts.push(`OS ${entry.osVersion}`);
                                if (entry.pid) parts.push(`PID ${entry.pid}`);
                                if (entry.activeSessionCount != null && entry.activeSessionCount >= 0) parts.push(`Sessions: ${entry.activeSessionCount}`);
                                if (entry.memoryMB) parts.push(`RAM: ${entry.memoryMB.rss}MB`);
                                if (entry.uptimeSeconds != null) parts.push(`Uptime: ${entry.uptimeSeconds}s`);
                                const text = parts.join('  ');
                                return text ? (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <div className="text-muted-foreground truncate cursor-default">
                                        {text}
                                      </div>
                                    </TooltipTrigger>
                                    <TooltipContent>{text}</TooltipContent>
                                  </Tooltip>
                                ) : null;
                              })()}
                              {entry.stack && (
                                <pre className="mt-1 p-2 bg-muted rounded text-[11px] leading-relaxed overflow-x-auto whitespace-pre-wrap break-all text-muted-foreground">
                                  {entry.stack}
                                </pre>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Actions */}
              <div className="flex items-center gap-2 pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={loadCrashLogs}
                  disabled={isLoadingCrashLogs}
                  className="gap-1.5"
                >
                  <RefreshCw size={14} className={isLoadingCrashLogs ? "animate-spin" : ""} />
                  {t("settings.system.refresh")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleClearCrashLogs}
                  disabled={isClearingCrashLogs || crashLogs.length === 0}
                  className="gap-1.5 text-destructive hover:text-destructive hover:bg-destructive/10"
                >
                  <Trash2 size={14} />
                  {t("settings.system.crashLogs.clear")}
                </Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={handleOpenCrashLogsDir}
                    >
                      <FolderOpen size={16} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t("settings.system.openFolder")}</TooltipContent>
                </Tooltip>
              </div>

              {crashLogClearResult && (
                <p className="text-sm text-muted-foreground">
                  {t("settings.system.crashLogs.cleared").replace("{count}", String(crashLogClearResult.deletedCount))}
                </p>
              )}
            </SettingCard>

            <p className="text-xs text-muted-foreground">
              {t("settings.system.crashLogs.hint")}
            </p>

          <SectionHeader title={t("settings.system.tempDirectory")} />
            <SettingCard className="space-y-3 py-4">
              {/* Path */}
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-muted-foreground">{t("settings.system.location")}</p>
                  <p className="text-sm font-mono mt-1 break-all">
                    {isLoading ? "..." : (tempDirInfo?.path ?? "-")}
                  </p>
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0"
                      onClick={handleOpenTempDir}
                      disabled={!tempDirInfo?.path}
                    >
                      <FolderOpen size={16} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t("settings.system.openFolder")}</TooltipContent>
                </Tooltip>
              </div>

              {/* Stats */}
              <div className="flex items-center gap-6 text-sm">
                <div>
                  <span className="text-muted-foreground">{t("settings.system.fileCount")}:</span>{" "}
                  <span className="font-medium">
                    {isLoading ? "..." : (tempDirInfo?.fileCount ?? 0)}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">{t("settings.system.totalSize")}:</span>{" "}
                  <span className="font-medium">
                    {isLoading ? "..." : formatBytes(tempDirInfo?.totalSize ?? 0)}
                  </span>
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={loadTempDirInfo}
                  disabled={isLoading}
                  className="gap-1.5"
                >
                  <RefreshCw size={14} className={isLoading ? "animate-spin" : ""} />
                  {t("settings.system.refresh")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleClearTempFiles}
                  disabled={isClearing || (tempDirInfo?.fileCount ?? 0) === 0}
                  className="gap-1.5 text-destructive hover:text-destructive hover:bg-destructive/10"
                >
                  <Trash2 size={14} />
                  {isClearing ? t("settings.system.clearing") : t("settings.system.clearTempFiles")}
                </Button>
              </div>

              {/* Clear Result */}
              {clearResult && (
                <p className="text-sm text-muted-foreground">
                  {t("settings.system.clearResult", {
                    deleted: clearResult.deletedCount,
                    failed: clearResult.failedCount,
                  })}
                </p>
              )}
            </SettingCard>

            <p className="text-xs text-muted-foreground">
              {t("settings.system.tempDirectoryHint")}
            </p>

          <SectionHeader title={t("settings.sessionRestore.title")} />
            <SettingCard className="space-y-4 py-4">
              <SettingRow
                label={t("settings.sessionRestore.restorePreviousSession")}
                description={t("settings.sessionRestore.restorePreviousSessionDesc")}
              >
                <Toggle
                  checked={restorePreviousSession}
                  onChange={setRestorePreviousSession}
                />
              </SettingRow>
              <SettingRow
                label={t("settings.sessionRestore.restoreTerminalCwd")}
                description={t("settings.sessionRestore.restoreTerminalCwdDesc")}
              >
                <Toggle
                  checked={restoreTerminalCwd}
                  onChange={setRestoreTerminalCwd}
                />
              </SettingRow>
            </SettingCard>

          <SectionHeader title={t("settings.sessionLogs.title")} />
            <SettingCard className="space-y-4 py-4">
              {/* Enable Toggle */}
              <SettingRow
                label={t("settings.sessionLogs.enableAutoSave")}
                description={t("settings.sessionLogs.enableAutoSaveDesc")}
              >
                <Toggle
                  checked={sessionLogsEnabled}
                  onChange={setSessionLogsEnabled}
                />
              </SettingRow>

              {/* Directory Selection */}
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{t("settings.sessionLogs.directory")}</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="bg-background border border-input rounded-md px-3 py-2 text-sm font-mono truncate">
                      {sessionLogsDir || t("settings.sessionLogs.noDirectory")}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleSelectSessionLogsDir}
                    className="shrink-0"
                  >
                    {t("settings.sessionLogs.browse")}
                  </Button>
                  {sessionLogsDir && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={handleOpenSessionLogsDir}
                          className="shrink-0"
                        >
                          <FolderOpen size={16} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t("settings.sessionLogs.openFolder")}</TooltipContent>
                    </Tooltip>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("settings.sessionLogs.directoryHint")}
                </p>
              </div>

              {/* Format Selection */}
              <SettingRow
                label={t("settings.sessionLogs.format")}
                description={t("settings.sessionLogs.formatDesc")}
              >
                <Select
                  value={sessionLogsFormat}
                  options={formatOptions}
                  onChange={(val) => setSessionLogsFormat(val as SessionLogFormat)}
                  className="w-44"
                />
              </SettingRow>

              <SettingRow
                label={t("settings.sessionLogs.timestamps")}
                description={t("settings.sessionLogs.timestampsDesc")}
              >
                <Toggle
                  checked={sessionLogsTimestampsEnabled}
                  onChange={setSessionLogsTimestampsEnabled}
                />
              </SettingRow>
            </SettingCard>

            <p className="text-xs text-muted-foreground">
              {t("settings.sessionLogs.hint")}
            </p>

          <SectionHeader title={t('settings.sshDeepLink.title')} />
            <SettingCard>
              <SettingRow
                label={t('settings.sshDeepLink.enable')}
                description={t('settings.sshDeepLink.enableDesc')}
              >
                <Toggle
                  checked={sshDeepLinkEnabled}
                  onChange={setSshDeepLinkEnabled}
                  ariaLabel={t('settings.sshDeepLink.enable')}
                />
              </SettingRow>
            </SettingCard>

          <SectionHeader title={t('settings.jmsDeepLink.title')} />
            <SettingCard>
              <SettingRow
                label={t('settings.jmsDeepLink.enable')}
                description={t('settings.jmsDeepLink.enableDesc')}
              >
                <Toggle
                  checked={jmsDeepLinkEnabled}
                  onChange={setJmsDeepLinkEnabled}
                  ariaLabel={t('settings.jmsDeepLink.enable')}
                />
              </SettingRow>
            </SettingCard>

          <SectionHeader title={t("settings.sshDebugLogs.title")} />
            <SettingCard className="min-w-0 max-w-full overflow-hidden space-y-4 py-4">
              <SettingRow
                label={t("settings.sshDebugLogs.enable")}
                description={t("settings.sshDebugLogs.enableDesc")}
              >
                <Toggle
                  checked={sshDebugLogsEnabled}
                  onChange={setSshDebugLogsEnabled}
                />
              </SettingRow>

              <div className="space-y-2">
                <span className="text-sm font-medium">{t("settings.sshDebugLogs.location")}</span>
                <div className="grid w-full min-w-0 max-w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2">
                  <div className="min-w-0 overflow-hidden">
                    <div
                      className="w-full min-w-0 overflow-hidden truncate rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
                      title={isLoadingSshDebugLogInfo ? "..." : (sshDebugLogInfo?.path || "-")}
                    >
                      {isLoadingSshDebugLogInfo ? "..." : (sshDebugLogInfo?.path || "-")}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={loadSshDebugLogInfo}
                    disabled={isLoadingSshDebugLogInfo}
                    className="shrink-0 gap-1.5"
                  >
                    <RefreshCw size={14} className={isLoadingSshDebugLogInfo ? "animate-spin" : ""} />
                    {t("settings.system.refresh")}
                  </Button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={handleOpenSshDebugLogDir}
                        className="shrink-0"
                      >
                        <FolderOpen size={16} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("settings.system.openFolder")}</TooltipContent>
                  </Tooltip>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span>
                    {t("settings.sshDebugLogs.status")}:{" "}
                    {sshDebugLogsEnabled ? t("settings.sshDebugLogs.statusOn") : t("settings.sshDebugLogs.statusOff")}
                  </span>
                  <span>
                    {t("settings.sshDebugLogs.size")}: {formatBytes(sshDebugLogInfo?.size ?? 0)}
                  </span>
                </div>
              </div>
            </SettingCard>

            <p className="text-xs text-muted-foreground">
              {t("settings.sshDebugLogs.hint")}
            </p>

          <SectionHeader title={t("settings.globalHotkey.title")} />
            <SettingCard className="space-y-4 py-4">
              {/* Enable/Disable Global Hotkey */}
              <SettingRow
                label={t('settings.globalHotkey.enabled')}
                description={t('settings.globalHotkey.enabledDesc')}
              >
                <Toggle
                  checked={globalHotkeyEnabled}
                  onChange={setGlobalHotkeyEnabled}
                />
              </SettingRow>

              <div className={cn(!globalHotkeyEnabled && "opacity-50 pointer-events-none")}>
                {/* Toggle Window Hotkey */}
                <SettingRow
                  label={t("settings.globalHotkey.toggleWindow")}
                  description={t("settings.globalHotkey.toggleWindowDesc")}
                >
                  <div className="flex items-center gap-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setIsRecordingHotkey(true);
                      }}
                      className={cn(
                        "px-3 py-1.5 text-sm font-mono rounded border transition-colors min-w-[100px] text-center",
                        isRecordingHotkey
                          ? "border-primary bg-primary/10 animate-pulse"
                          : "border-border hover:border-primary/50",
                      )}
                    >
                      {isRecordingHotkey
                        ? t("settings.shortcuts.recording")
                        : toggleWindowHotkey || t("settings.globalHotkey.notSet")}
                    </button>
                    {toggleWindowHotkey && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            onClick={handleResetHotkey}
                            className="p-1 hover:bg-muted rounded"
                          >
                            <RotateCcw size={14} />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>{t("settings.globalHotkey.reset")}</TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                </SettingRow>
                {(hotkeyError || hotkeyRegistrationError) && (
                  <p className="text-sm text-destructive mt-2">{hotkeyError || hotkeyRegistrationError}</p>
                )}
              </div>

              {/* Close to Tray */}
              <SettingRow
                label={t("settings.globalHotkey.closeToTray")}
                description={t("settings.globalHotkey.closeToTrayDesc")}
              >
                <Toggle
                  checked={closeToTray}
                  onChange={setCloseToTray}
                />
              </SettingRow>
            </SettingCard>

            <p className="text-xs text-muted-foreground">
              {t("settings.globalHotkey.hint")}
            </p>
    </SettingsTabContent>
  );
};

export default React.memo(SettingsSystemTab);
