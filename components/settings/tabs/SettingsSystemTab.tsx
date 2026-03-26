/**
 * Settings System Tab - System information, temp file management, session logs, and global hotkey
 */
import { AlertTriangle, ChevronDown, ChevronRight, Download, ExternalLink, FileText, FolderOpen, HardDrive, Keyboard, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import React, { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../../application/i18n/I18nProvider";
import { getCredentialProtectionAvailability } from "../../../infrastructure/services/credentialProtection";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import type { UpdateState } from '../../../application/state/useUpdateCheck';
import { SessionLogFormat, keyEventToString } from "../../../domain/models";
import { TabsContent } from "../../ui/tabs";
import { Button } from "../../ui/button";
import { Toggle, Select, SettingRow } from "../settings-ui";
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
  toggleWindowHotkey: string;
  setToggleWindowHotkey: (hotkey: string) => void;
  closeToTray: boolean;
  setCloseToTray: (enabled: boolean) => void;
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
  toggleWindowHotkey,
  setToggleWindowHotkey,
  closeToTray,
  setCloseToTray,
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
    <TabsContent
      value="system"
      className="data-[state=inactive]:hidden h-full flex flex-col"
    >
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-8 py-6">
        <div className="max-w-2xl space-y-8">
          {/* Header */}
          <div>
            <h2 className="text-xl font-semibold">{t("settings.system.title")}</h2>
            <p className="text-sm text-muted-foreground mt-1">
              {t("settings.system.description")}
            </p>
          </div>

          {/* Software Update Section */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Download size={18} className="text-muted-foreground" />
              <h3 className="text-base font-medium">{t('settings.update.title')}</h3>
            </div>
            <div className="rounded-lg border border-border/60 p-4 space-y-3">
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
          </div>

          {/* Credential Protection Section */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <HardDrive size={18} className="text-muted-foreground" />
              <h3 className="text-base font-medium">{t("settings.system.credentials.title")}</h3>
            </div>

            <div className="bg-muted/30 rounded-lg p-4 space-y-3">
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
            </div>
          </div>

          {/* Crash Logs Section */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <AlertTriangle size={18} className="text-muted-foreground" />
              <h3 className="text-base font-medium">{t("settings.system.crashLogs.title")}</h3>
            </div>

            <div className="bg-muted/30 rounded-lg p-4 space-y-3">
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
                                  <div className="text-muted-foreground truncate" title={text}>
                                    {text}
                                  </div>
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
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleOpenCrashLogsDir}
                  title={t("settings.system.openFolder")}
                >
                  <FolderOpen size={16} />
                </Button>
              </div>

              {crashLogClearResult && (
                <p className="text-sm text-muted-foreground">
                  {t("settings.system.crashLogs.cleared").replace("{count}", String(crashLogClearResult.deletedCount))}
                </p>
              )}
            </div>

            <p className="text-xs text-muted-foreground">
              {t("settings.system.crashLogs.hint")}
            </p>
          </div>

          {/* Temp Directory Section */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <HardDrive size={18} className="text-muted-foreground" />
              <h3 className="text-base font-medium">{t("settings.system.tempDirectory")}</h3>
            </div>

            <div className="bg-muted/30 rounded-lg p-4 space-y-3">
              {/* Path */}
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-muted-foreground">{t("settings.system.location")}</p>
                  <p className="text-sm font-mono mt-1 break-all">
                    {isLoading ? "..." : (tempDirInfo?.path ?? "-")}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0"
                  onClick={handleOpenTempDir}
                  disabled={!tempDirInfo?.path}
                  title={t("settings.system.openFolder")}
                >
                  <FolderOpen size={16} />
                </Button>
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
            </div>

            <p className="text-xs text-muted-foreground">
              {t("settings.system.tempDirectoryHint")}
            </p>
          </div>

          {/* Session Logs Section */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <FileText size={18} className="text-muted-foreground" />
              <h3 className="text-base font-medium">{t("settings.sessionLogs.title")}</h3>
            </div>

            <div className="bg-muted/30 rounded-lg p-4 space-y-4">
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
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={handleOpenSessionLogsDir}
                      className="shrink-0"
                      title={t("settings.sessionLogs.openFolder")}
                    >
                      <FolderOpen size={16} />
                    </Button>
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
                  disabled={!sessionLogsEnabled}
                />
              </SettingRow>
            </div>

            <p className="text-xs text-muted-foreground">
              {t("settings.sessionLogs.hint")}
            </p>
          </div>

          {/* Global Toggle Window Section (Quake Mode) */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Keyboard size={18} className="text-muted-foreground" />
              <h3 className="text-base font-medium">{t("settings.globalHotkey.title")}</h3>
            </div>

            <div className="bg-muted/30 rounded-lg p-4 space-y-4">
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
                      <button
                        onClick={handleResetHotkey}
                        className="p-1 hover:bg-muted rounded"
                        title={t("settings.globalHotkey.reset")}
                      >
                        <RotateCcw size={14} />
                      </button>
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
            </div>

            <p className="text-xs text-muted-foreground">
              {t("settings.globalHotkey.hint")}
            </p>
          </div>
        </div>
      </div>
    </TabsContent>
  );
};

export default SettingsSystemTab;
