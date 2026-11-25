import { useCallback, useEffect, useState } from 'react';
import {
  STORAGE_KEY_AI_EXTERNAL_MCP_APPROVAL_ALERT,
  STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED,
  STORAGE_KEY_AI_EXTERNAL_MCP_FOCUS_ON_HOST_OPEN,
  STORAGE_KEY_AI_EXTERNAL_MCP_HTTP_ALLOW_CUSTOM_BIND,
  STORAGE_KEY_AI_EXTERNAL_MCP_HTTP_CLIENT_HOST,
  STORAGE_KEY_AI_EXTERNAL_MCP_HTTP_ENABLED,
  STORAGE_KEY_AI_EXTERNAL_MCP_HTTP_LISTEN_ADDRESS,
  STORAGE_KEY_AI_EXTERNAL_MCP_HTTP_PORT,
  STORAGE_KEY_AI_EXTERNAL_MCP_IDLE_TIMEOUT_MINUTES,
  STORAGE_KEY_AI_EXTERNAL_MCP_MODE,
  STORAGE_KEY_AI_EXTERNAL_MCP_REDACTION,
  STORAGE_KEY_AI_EXTERNAL_MCP_SILENT_SESSIONS,
  STORAGE_KEY_AI_PERMISSION_MODE,
  STORAGE_KEY_AI_PRIVACY,
  STORAGE_KEY_AI_SESSION_IDLE_TIMEOUT_MINUTES,
} from '../../infrastructure/config/storageKeys';
import type { AIPermissionMode } from '../../infrastructure/ai/types';
import { DEFAULT_EXTERNAL_MCP_HTTP_PORT } from '../../domain/externalMcpHttp';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
import { AI_STATE_CHANGED_EVENT, emitAIStateChanged } from './aiStateEvents';

export type ExternalMcpMode = 'temporary' | 'persistent';
export type ExternalMcpApprovalAlertMode = 'off' | 'unfocused' | 'always';

export const DEFAULT_EXTERNAL_MCP_APPROVAL_ALERT_MODE: ExternalMcpApprovalAlertMode = 'unfocused';

const DEFAULT_EXTERNAL_MCP_IDLE_TIMEOUT_MINUTES = 10;
const MIN_EXTERNAL_MCP_IDLE_TIMEOUT_MINUTES = 1;
const MAX_EXTERNAL_MCP_IDLE_TIMEOUT_MINUTES = 24 * 60;
const DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES = 480;
/** Keep top-bar / settings switch state aligned with runtime auto-disable. */
export const EXTERNAL_MCP_RUNTIME_STATUS_POLL_MS = 3000;

// Always-mounted top-bar consumers can poll before App finishes startup reconcile.
// Gate runtime auto-clear until that reconcile has run on the main window.
let externalMcpStartupReady = false;
let externalMcpStartupReadyWaitPromise: Promise<void> | null = null;
let externalMcpStartupReadyWaitResolve: (() => void) | null = null;
/** Bumps on every intentional enable/disable so stale startup applies lose. */
let externalMcpEnableGeneration = 0;
let externalMcpConfigError: string | null = null;
// Module-level ref-counted runtime status poller so multiple mounted hook
// instances (AppView + Settings > AI) share a single 3s timer and pause while hidden.
let externalMcpPollRefs = 0;
let externalMcpPollIntervalId: ReturnType<typeof setInterval> | null = null;
let externalMcpPollInFlight = false;
let externalMcpPollGeneration = 0;
let externalMcpPollVisibilityDocument: Document | null = null;

function isExternalMcpDocumentHidden(): boolean {
  if (typeof document === 'undefined') return false;
  if (typeof document.visibilityState === 'string') {
    return document.visibilityState === 'hidden';
  }
  return document.hidden === true;
}

async function syncExternalMcpRuntimeStatus(): Promise<void> {
  if (externalMcpPollRefs <= 0 || externalMcpPollInFlight || isExternalMcpDocumentHidden()) {
    return;
  }
  const generation = externalMcpPollGeneration;
  externalMcpPollInFlight = true;
  try {
    // Wait until App has finished startup reconcile so a still-disabled runtime
    // is not mistaken for "user turned it off / idle timeout".
    await waitForExternalMcpStartupReady();
    if (generation !== externalMcpPollGeneration || externalMcpPollRefs <= 0 || isExternalMcpDocumentHidden()) {
      return;
    }
    const status = await netcattyBridge.get()?.externalMcpGetStatus?.();
    if (generation !== externalMcpPollGeneration || externalMcpPollRefs <= 0) {
      return;
    }
    // Only clear the shared switch for an intentional runtime-off (idle /
    // explicit disable). Start failures set error and should keep preference.
    if (status?.ok && !status.enabled && !status.error) {
      localStorageAdapter.writeBoolean(STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED, false);
      emitAIStateChanged(STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED);
    }
  } catch {
    // Keep the user's stored switch state during transient bridge errors.
  } finally {
    externalMcpPollInFlight = false;
  }
}

function syncExternalMcpPollTimer(): void {
  const shouldPoll = externalMcpPollRefs > 0 && !isExternalMcpDocumentHidden();
  if (shouldPoll) {
    if (externalMcpPollIntervalId === null) {
      externalMcpPollIntervalId = setInterval(() => {
        void syncExternalMcpRuntimeStatus();
      }, EXTERNAL_MCP_RUNTIME_STATUS_POLL_MS);
    }
  } else if (externalMcpPollIntervalId !== null) {
    clearInterval(externalMcpPollIntervalId);
    externalMcpPollIntervalId = null;
  }
}

function handleExternalMcpVisibilityChange(): void {
  if (isExternalMcpDocumentHidden()) {
    externalMcpPollGeneration += 1;
    syncExternalMcpPollTimer();
    return;
  }
  syncExternalMcpPollTimer();
  void syncExternalMcpRuntimeStatus();
}

function attachExternalMcpVisibilityListener(): void {
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
    return;
  }
  if (externalMcpPollVisibilityDocument === document) return;
  if (
    externalMcpPollVisibilityDocument
    && typeof externalMcpPollVisibilityDocument.removeEventListener === 'function'
  ) {
    externalMcpPollVisibilityDocument.removeEventListener('visibilitychange', handleExternalMcpVisibilityChange);
  }
  document.addEventListener('visibilitychange', handleExternalMcpVisibilityChange);
  externalMcpPollVisibilityDocument = document;
}

function detachExternalMcpVisibilityListener(): void {
  if (!externalMcpPollVisibilityDocument) return;
  if (typeof externalMcpPollVisibilityDocument.removeEventListener === 'function') {
    externalMcpPollVisibilityDocument.removeEventListener('visibilitychange', handleExternalMcpVisibilityChange);
  }
  externalMcpPollVisibilityDocument = null;
}

function getWindowHash(hash?: string): string {
  if (typeof hash === 'string') return hash;
  return typeof window !== 'undefined' ? window.location.hash : '';
}

function isPeerSessionWindowLocation(hash?: string): boolean {
  return getWindowHash(hash).startsWith('#/session-window');
}

/** Only the main App shell runs startup reconcile and owns the ready gate. */
export function shouldWaitForExternalMcpStartupReady(hash?: string): boolean {
  const current = getWindowHash(hash);
  if (!current || current === '#' || current === '#/') return true;
  // Peer windows never own External MCP lifecycle.
  if (current.startsWith('#/session-window')) return false;
  // Settings / tray / popup windows mount the shared hook but never run App reconcile.
  if (current.startsWith('#/settings')) return false;
  if (current.startsWith('#/tray')) return false;
  if (current.startsWith('#/terminal-popup')) return false;
  return true;
}

export function markExternalMcpStartupReady(): void {
  if (externalMcpStartupReady) return;
  externalMcpStartupReady = true;
  const resolve = externalMcpStartupReadyWaitResolve;
  externalMcpStartupReadyWaitResolve = null;
  externalMcpStartupReadyWaitPromise = null;
  resolve?.();
}

export function resetExternalMcpStartupReadyForTests(): void {
  externalMcpStartupReady = false;
  externalMcpStartupReadyWaitPromise = null;
  externalMcpStartupReadyWaitResolve = null;
  externalMcpEnableGeneration = 0;
  externalMcpConfigError = null;
  externalMcpStartupSyncPromise = null;
  if (externalMcpPollIntervalId !== null) {
    clearInterval(externalMcpPollIntervalId);
    externalMcpPollIntervalId = null;
  }
  detachExternalMcpVisibilityListener();
  externalMcpPollRefs = 0;
  externalMcpPollInFlight = false;
  externalMcpPollGeneration = 0;
}

export function getExternalMcpEnableGenerationForTests(): number {
  return externalMcpEnableGeneration;
}

export function bumpExternalMcpEnableGenerationForTests(): number {
  externalMcpEnableGeneration += 1;
  return externalMcpEnableGeneration;
}

export function isExternalMcpStartupReady(): boolean {
  return externalMcpStartupReady;
}

/** Exposed for tests: single-flight waiter count is 0 or 1. */
export function getExternalMcpStartupReadyWaiterCountForTests(): number {
  return externalMcpStartupReadyWaitResolve ? 1 : 0;
}

export function waitForExternalMcpStartupReady(hash?: string): Promise<void> {
  // Non-main routes intentionally skip App reconcile; do not block forever there.
  if (!shouldWaitForExternalMcpStartupReady(hash) || externalMcpStartupReady) {
    return Promise.resolve();
  }
  if (!externalMcpStartupReadyWaitPromise) {
    externalMcpStartupReadyWaitPromise = new Promise<void>((resolve) => {
      externalMcpStartupReadyWaitResolve = resolve;
    });
  }
  return externalMcpStartupReadyWaitPromise;
}

export type AIPrivacySettings = {
  enabled: boolean;
  redactPrivateIps: boolean;
  cidrs: string[];
  patterns: string[];
};

export function defaultAIPrivacySettings(): AIPrivacySettings {
  return { enabled: false, redactPrivateIps: false, cidrs: [], patterns: [] };
}

/** Missing settings are opt-out; corrupt settings must never silently opt out. */
export function readAIPrivacySettings(): AIPrivacySettings {
  // The shared key wins, including invalid data: never fall back to a weaker legacy policy.
  // Leave the legacy value intact for older installs; Apply writes only the validated shared key.
  const stored = localStorageAdapter.readString(STORAGE_KEY_AI_PRIVACY)
    ?? localStorageAdapter.readString(STORAGE_KEY_AI_EXTERNAL_MCP_REDACTION);
  if (stored === null) return defaultAIPrivacySettings();
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    throw new Error('Invalid saved AI privacy settings. Review and apply the settings again.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid saved AI privacy settings. Review and apply the settings again.');
  }
  const settings = value as Record<string, unknown>;
  if (
    Object.keys(settings).some((key) => !['enabled', 'redactPrivateIps', 'cidrs', 'patterns'].includes(key))
    || typeof settings.enabled !== 'boolean'
    || typeof settings.redactPrivateIps !== 'boolean'
    || !Array.isArray(settings.cidrs) || !settings.cidrs.every((item) => typeof item === 'string')
    || !Array.isArray(settings.patterns) || !settings.patterns.every((item) => typeof item === 'string')
  ) {
    throw new Error('Invalid saved AI privacy settings. Review and apply the settings again.');
  }
  return {
    enabled: settings.enabled,
    redactPrivateIps: settings.redactPrivateIps,
    cidrs: [...settings.cidrs],
    patterns: [...settings.patterns],
  };
}

function configResponseError(
  result: unknown,
  unverifiedMessage = 'External MCP settings could not be verified. The bridge has not been enabled.',
): string | null {
  if (result && typeof result === 'object' && 'ok' in result && result.ok === true) return null;
  if (result && typeof result === 'object' && 'error' in result && typeof result.error === 'string' && result.error) {
    return result.error;
  }
  return unverifiedMessage;
}

/** Validate in the main process before committing any privacy preference. */
export async function applyAIPrivacySettings(
  settings: AIPrivacySettings,
  bridge: ExternalMcpBridge | undefined = netcattyBridge.get(),
): Promise<void> {
  const result = await bridge?.externalMcpSetConfig?.({ redaction: settings });
  const error = configResponseError(result, 'AI privacy settings could not be verified. Try applying them again.');
  if (error) throw new Error(error);
  if (!localStorageAdapter.write(STORAGE_KEY_AI_PRIVACY, settings)) {
    throw new Error('AI privacy settings could not be saved. Apply them again before restarting.');
  }
  externalMcpConfigError = null;
  emitAIStateChanged(STORAGE_KEY_AI_PRIVACY);
}

function readAIPrivacyState() {
  try {
    return { settings: readAIPrivacySettings(), error: null as string | null };
  } catch (error) {
    return {
      settings: defaultAIPrivacySettings(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function useAIPrivacyState() {
  const [state, setState] = useState(readAIPrivacyState);
  const [applying, setApplying] = useState(false);
  const apply = useCallback(async (settings: AIPrivacySettings): Promise<boolean> => {
    setApplying(true);
    try {
      await applyAIPrivacySettings(settings);
      setState({ settings, error: null });
      return true;
    } catch (error) {
      setState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : String(error),
      }));
      return false;
    } finally {
      setApplying(false);
    }
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY_AI_PRIVACY || event.key === STORAGE_KEY_AI_EXTERNAL_MCP_REDACTION) {
        setState(readAIPrivacyState());
      }
    };
    const onLocalChange = (event: Event) => {
      const key = (event as CustomEvent<{ key?: string }>).detail?.key;
      if (key === STORAGE_KEY_AI_PRIVACY || key === STORAGE_KEY_AI_EXTERNAL_MCP_REDACTION) {
        setState(readAIPrivacyState());
      }
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener(AI_STATE_CHANGED_EVENT, onLocalChange);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(AI_STATE_CHANGED_EVENT, onLocalChange);
    };
  }, []);

  return { ...state, applying, apply };
}

/** Compatibility exports for existing External MCP configuration callers. One shared policy only. */
export type ExternalMcpRedactionSettings = AIPrivacySettings;
export const defaultExternalMcpRedactionSettings = defaultAIPrivacySettings;
export const readExternalMcpRedactionSettings = readAIPrivacySettings;
export const applyExternalMcpRedactionSettings = applyAIPrivacySettings;
export const useExternalMcpRedactionState = useAIPrivacyState;

export type ExternalMcpHttpSettings = {
  enabled: boolean;
  port: number;
  allowCustomBind: boolean;
  listenAddress: string;
  clientHost: string;
};

type ExternalMcpConfig = {
  mode?: ExternalMcpMode;
  idleTimeoutMinutes?: number;
  sessionIdleTimeoutMinutes?: number;
  /** null invalidates shared privacy when persisted settings cannot be read safely. */
  redaction?: AIPrivacySettings | null;
  httpEnabled?: boolean;
  httpPort?: number;
  httpAllowCustomBind?: boolean;
  httpListenAddress?: string;
  httpClientHost?: string;
};

type ExternalMcpBridge = {
  aiMcpSetPermissionMode?: (mode: AIPermissionMode) => Promise<unknown> | unknown;
  externalMcpSetConfig?: (config: ExternalMcpConfig) => Promise<unknown> | unknown;
  externalMcpSetEnabled?: (enabled: boolean) => Promise<unknown> | unknown;
  externalMcpGetStatus?: () => Promise<{
    ok?: boolean;
    enabled?: boolean;
    state?: string;
    error?: string | null;
  } | undefined>;
};

export type ExternalMcpStartupSyncPlan = {
  config: ExternalMcpConfig;
  runtimeEnabled: boolean;
  storedEnabled: boolean;
  shouldPersistStoredEnabled: boolean;
  configError?: string;
};

export function normalizeExternalMcpMode(value: string | null): ExternalMcpMode {
  return value === 'persistent' ? 'persistent' : 'temporary';
}

function readAIPermissionMode(): AIPermissionMode {
  const stored = localStorageAdapter.readString(STORAGE_KEY_AI_PERMISSION_MODE);
  return stored === 'observer' || stored === 'auto' ? stored : 'confirm';
}

export function normalizeExternalMcpIdleTimeoutMinutes(value: number | null): number {
  if (!Number.isFinite(value)) return DEFAULT_EXTERNAL_MCP_IDLE_TIMEOUT_MINUTES;
  return Math.min(
    MAX_EXTERNAL_MCP_IDLE_TIMEOUT_MINUTES,
    Math.max(
      MIN_EXTERNAL_MCP_IDLE_TIMEOUT_MINUTES,
      Math.round(value ?? DEFAULT_EXTERNAL_MCP_IDLE_TIMEOUT_MINUTES),
    ),
  );
}

export function readExternalMcpStoredEnabled(): boolean {
  return localStorageAdapter.readBoolean(STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED) ?? false;
}

export function readExternalMcpMode(): ExternalMcpMode {
  return normalizeExternalMcpMode(localStorageAdapter.readString(STORAGE_KEY_AI_EXTERNAL_MCP_MODE));
}

export function writeExternalMcpMode(mode: ExternalMcpMode): ExternalMcpMode {
  const normalized = normalizeExternalMcpMode(mode);
  localStorageAdapter.writeString(STORAGE_KEY_AI_EXTERNAL_MCP_MODE, normalized);
  emitAIStateChanged(STORAGE_KEY_AI_EXTERNAL_MCP_MODE);
  return normalized;
}

export function readExternalMcpIdleTimeoutMinutes(): number {
  return normalizeExternalMcpIdleTimeoutMinutes(
    localStorageAdapter.readNumber(STORAGE_KEY_AI_EXTERNAL_MCP_IDLE_TIMEOUT_MINUTES),
  );
}

export function writeExternalMcpIdleTimeoutMinutes(minutes: number): number {
  const normalized = normalizeExternalMcpIdleTimeoutMinutes(minutes);
  localStorageAdapter.writeNumber(STORAGE_KEY_AI_EXTERNAL_MCP_IDLE_TIMEOUT_MINUTES, normalized);
  emitAIStateChanged(STORAGE_KEY_AI_EXTERNAL_MCP_IDLE_TIMEOUT_MINUTES);
  return normalized;
}

/** Whether host_open should surface/focus the main window. Defaults to true (existing behavior). */
export function readExternalMcpFocusOnHostOpen(): boolean {
  return localStorageAdapter.readBoolean(STORAGE_KEY_AI_EXTERNAL_MCP_FOCUS_ON_HOST_OPEN) ?? true;
}

export function writeExternalMcpFocusOnHostOpen(focusOnHostOpen: boolean): void {
  localStorageAdapter.writeBoolean(STORAGE_KEY_AI_EXTERNAL_MCP_FOCUS_ON_HOST_OPEN, focusOnHostOpen);
  emitAIStateChanged(STORAGE_KEY_AI_EXTERNAL_MCP_FOCUS_ON_HOST_OPEN);
}

export function normalizeExternalMcpApprovalAlertMode(value: string | null): ExternalMcpApprovalAlertMode {
  return value === 'off' || value === 'always' || value === 'unfocused'
    ? value
    : DEFAULT_EXTERNAL_MCP_APPROVAL_ALERT_MODE;
}

/** System notification preference for confirm-mode External MCP approvals. */
export function readExternalMcpApprovalAlertMode(): ExternalMcpApprovalAlertMode {
  return normalizeExternalMcpApprovalAlertMode(
    localStorageAdapter.readString(STORAGE_KEY_AI_EXTERNAL_MCP_APPROVAL_ALERT),
  );
}

export function writeExternalMcpApprovalAlertMode(mode: ExternalMcpApprovalAlertMode): ExternalMcpApprovalAlertMode {
  const normalized = normalizeExternalMcpApprovalAlertMode(mode);
  localStorageAdapter.writeString(STORAGE_KEY_AI_EXTERNAL_MCP_APPROVAL_ALERT, normalized);
  emitAIStateChanged(STORAGE_KEY_AI_EXTERNAL_MCP_APPROVAL_ALERT);
  return normalized;
}

/** Whether host_open sessions stay hidden from the tab bar. Defaults to false (existing behavior). */
export function readExternalMcpSilentSessions(): boolean {
  return localStorageAdapter.readBoolean(STORAGE_KEY_AI_EXTERNAL_MCP_SILENT_SESSIONS) ?? false;
}

export function writeExternalMcpSilentSessions(silentSessions: boolean): void {
  localStorageAdapter.writeBoolean(STORAGE_KEY_AI_EXTERNAL_MCP_SILENT_SESSIONS, silentSessions);
  emitAIStateChanged(STORAGE_KEY_AI_EXTERNAL_MCP_SILENT_SESSIONS);
}

export function normalizeSessionIdleTimeoutMinutes(value: number | null): number {
  if (!Number.isFinite(value)) return DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES;
  return Math.min(
    MAX_EXTERNAL_MCP_IDLE_TIMEOUT_MINUTES,
    Math.max(
      MIN_EXTERNAL_MCP_IDLE_TIMEOUT_MINUTES,
      Math.round(value ?? DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES),
    ),
  );
}

export function readSessionIdleTimeoutMinutes(): number {
  return normalizeSessionIdleTimeoutMinutes(
    localStorageAdapter.readNumber(STORAGE_KEY_AI_SESSION_IDLE_TIMEOUT_MINUTES),
  );
}

export function writeSessionIdleTimeoutMinutes(minutes: number): number {
  const normalized = normalizeSessionIdleTimeoutMinutes(minutes);
  localStorageAdapter.writeNumber(STORAGE_KEY_AI_SESSION_IDLE_TIMEOUT_MINUTES, normalized);
  emitAIStateChanged(STORAGE_KEY_AI_SESSION_IDLE_TIMEOUT_MINUTES);
  return normalized;
}

const MIN_EXTERNAL_MCP_HTTP_PORT = 1024;
const MAX_EXTERNAL_MCP_HTTP_PORT = 65535;

export function normalizeExternalMcpHttpPort(value: number | null): number {
  if (!Number.isInteger(value)) return DEFAULT_EXTERNAL_MCP_HTTP_PORT;
  if (value < MIN_EXTERNAL_MCP_HTTP_PORT || value > MAX_EXTERNAL_MCP_HTTP_PORT) {
    return DEFAULT_EXTERNAL_MCP_HTTP_PORT;
  }
  return value;
}

export function normalizeExternalMcpHttpListenAddress(value: string | null): string {
  const address = (value ?? '').trim();
  if (!address) return '0.0.0.0';
  return address;
}

export function readExternalMcpHttpEnabled(): boolean {
  return localStorageAdapter.readBoolean(STORAGE_KEY_AI_EXTERNAL_MCP_HTTP_ENABLED) ?? false;
}

export function writeExternalMcpHttpEnabled(enabled: boolean): boolean {
  localStorageAdapter.writeBoolean(STORAGE_KEY_AI_EXTERNAL_MCP_HTTP_ENABLED, enabled);
  emitAIStateChanged(STORAGE_KEY_AI_EXTERNAL_MCP_HTTP_ENABLED);
  return enabled;
}

export function readExternalMcpHttpPort(): number {
  return normalizeExternalMcpHttpPort(
    localStorageAdapter.readNumber(STORAGE_KEY_AI_EXTERNAL_MCP_HTTP_PORT),
  );
}

export function writeExternalMcpHttpPort(port: number): number {
  const normalized = normalizeExternalMcpHttpPort(port);
  localStorageAdapter.writeNumber(STORAGE_KEY_AI_EXTERNAL_MCP_HTTP_PORT, normalized);
  emitAIStateChanged(STORAGE_KEY_AI_EXTERNAL_MCP_HTTP_PORT);
  return normalized;
}

export function readExternalMcpHttpAllowCustomBind(): boolean {
  return localStorageAdapter.readBoolean(STORAGE_KEY_AI_EXTERNAL_MCP_HTTP_ALLOW_CUSTOM_BIND) ?? false;
}

export function writeExternalMcpHttpAllowCustomBind(allowCustomBind: boolean): boolean {
  localStorageAdapter.writeBoolean(STORAGE_KEY_AI_EXTERNAL_MCP_HTTP_ALLOW_CUSTOM_BIND, allowCustomBind);
  emitAIStateChanged(STORAGE_KEY_AI_EXTERNAL_MCP_HTTP_ALLOW_CUSTOM_BIND);
  return allowCustomBind;
}

export function readExternalMcpHttpListenAddress(): string {
  return normalizeExternalMcpHttpListenAddress(
    localStorageAdapter.readString(STORAGE_KEY_AI_EXTERNAL_MCP_HTTP_LISTEN_ADDRESS),
  );
}

export function writeExternalMcpHttpListenAddress(listenAddress: string): string {
  const normalized = normalizeExternalMcpHttpListenAddress(listenAddress);
  localStorageAdapter.writeString(STORAGE_KEY_AI_EXTERNAL_MCP_HTTP_LISTEN_ADDRESS, normalized);
  emitAIStateChanged(STORAGE_KEY_AI_EXTERNAL_MCP_HTTP_LISTEN_ADDRESS);
  return normalized;
}

export function normalizeExternalMcpHttpClientHost(value: string | null): string {
  return (value ?? '').trim();
}

export function readExternalMcpHttpClientHost(): string {
  return normalizeExternalMcpHttpClientHost(
    localStorageAdapter.readString(STORAGE_KEY_AI_EXTERNAL_MCP_HTTP_CLIENT_HOST),
  );
}

export function writeExternalMcpHttpClientHost(clientHost: string): string {
  const normalized = normalizeExternalMcpHttpClientHost(clientHost);
  localStorageAdapter.writeString(STORAGE_KEY_AI_EXTERNAL_MCP_HTTP_CLIENT_HOST, normalized);
  emitAIStateChanged(STORAGE_KEY_AI_EXTERNAL_MCP_HTTP_CLIENT_HOST);
  return normalized;
}

export function readExternalMcpHttpSettings(): ExternalMcpHttpSettings {
  return {
    enabled: readExternalMcpHttpEnabled(),
    port: readExternalMcpHttpPort(),
    allowCustomBind: readExternalMcpHttpAllowCustomBind(),
    listenAddress: readExternalMcpHttpListenAddress(),
    clientHost: readExternalMcpHttpClientHost(),
  };
}

function httpConfigFromSettings(settings: ExternalMcpHttpSettings): Pick<
  ExternalMcpConfig,
  'httpEnabled' | 'httpPort' | 'httpAllowCustomBind' | 'httpListenAddress' | 'httpClientHost'
> {
  return {
    httpEnabled: settings.enabled,
    httpPort: settings.port,
    httpAllowCustomBind: settings.allowCustomBind,
    httpListenAddress: settings.listenAddress,
    httpClientHost: settings.clientHost,
  };
}

export function shouldStartExternalMcpOnStartup({
  enabled,
  mode,
}: {
  enabled: boolean;
  mode: ExternalMcpMode;
}): boolean {
  return mode === 'persistent' && enabled;
}

export function readExternalMcpStartupEnabled(): boolean {
  return shouldStartExternalMcpOnStartup({
    enabled: readExternalMcpStoredEnabled(),
    mode: readExternalMcpMode(),
  });
}

export function createExternalMcpStartupSyncPlan({
  enabled,
  mode,
  idleTimeoutMinutes,
  sessionIdleTimeoutMinutes,
  redaction = defaultAIPrivacySettings(),
  http = {
    enabled: false,
    port: DEFAULT_EXTERNAL_MCP_HTTP_PORT,
    allowCustomBind: false,
    listenAddress: '0.0.0.0',
    clientHost: '',
  },
}: {
  enabled: boolean;
  mode: ExternalMcpMode;
  idleTimeoutMinutes: number;
  sessionIdleTimeoutMinutes: number;
  http?: ExternalMcpHttpSettings;
  redaction?: AIPrivacySettings;
}): ExternalMcpStartupSyncPlan {
  const runtimeEnabled = shouldStartExternalMcpOnStartup({ enabled, mode });
  const storedEnabled = runtimeEnabled;
  return {
    config: {
      mode,
      idleTimeoutMinutes,
      sessionIdleTimeoutMinutes,
      redaction,
      ...httpConfigFromSettings(http),
    },
    runtimeEnabled,
    storedEnabled,
    shouldPersistStoredEnabled: storedEnabled !== enabled,
  };
}

export function readExternalMcpStartupSyncPlan(): ExternalMcpStartupSyncPlan {
  let redaction = defaultAIPrivacySettings();
  let configError: string | undefined;
  try {
    redaction = readAIPrivacySettings();
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error);
  }
  const plan = createExternalMcpStartupSyncPlan({
    enabled: readExternalMcpStoredEnabled(),
    mode: readExternalMcpMode(),
    idleTimeoutMinutes: readExternalMcpIdleTimeoutMinutes(),
    sessionIdleTimeoutMinutes: readSessionIdleTimeoutMinutes(),
    http: readExternalMcpHttpSettings(),
    redaction,
  });
  return configError ? { ...plan, runtimeEnabled: false, configError } : plan;
}

export async function syncExternalMcpConfig(
  bridge: ExternalMcpBridge | undefined = netcattyBridge.get(),
): Promise<void> {
  const plan = readExternalMcpStartupSyncPlan();
  if (plan.configError) {
    // A corrupt saved policy must block all managed agents, not only External MCP.
    // Keep the original recovery error even if notifying the main process fails.
    try {
      await bridge?.externalMcpSetConfig?.({ redaction: null });
    } catch {
      // The saved policy still needs user repair regardless of bridge availability.
    }
    throw new Error(plan.configError);
  }
  const result = await bridge?.externalMcpSetConfig?.(plan.config);
  const error = configResponseError(result);
  if (error) throw new Error(error);
  if (JSON.stringify(readAIPrivacySettings()) !== JSON.stringify(plan.config.redaction)) {
    throw new Error('AI privacy settings changed. Try enabling the bridge again.');
  }
}

/**
 * App-startup reconcile: only persistent+enabled starts the runtime.
 * Temporary mode never auto-starts, and we clear a stale stored enabled flag
 * so Settings remounts cannot accidentally re-enable temporary mode.
 */
export async function syncExternalMcpStartupState(
  bridge: ExternalMcpBridge | undefined = netcattyBridge.get(),
): Promise<ExternalMcpStartupSyncPlan> {
  // Snapshot once for config push; re-read after awaits so a concurrent top-bar
  // toggle during boot wins over a stale enable/disable decision.
  const startupGeneration = externalMcpEnableGeneration;
  const initialPlan = readExternalMcpStartupSyncPlan();
  try {
    // External MCP discovery is written while enabling, so restore the saved
    // permission first instead of exposing the main-process default (confirm).
    await Promise.resolve(bridge?.aiMcpSetPermissionMode?.(readAIPermissionMode()));
  } catch {
    // Permission sync is best-effort; the main process keeps its safe default.
  }
  let configError = initialPlan.configError;
  try {
    if (configError) {
      // Explicit invalidation is distinct from a rejected draft Apply, which keeps
      // the previous working policy. Never replace corrupt saved data with defaults.
      await Promise.resolve(bridge?.externalMcpSetConfig?.({ redaction: null }));
    } else {
      const result = await Promise.resolve(bridge?.externalMcpSetConfig?.(initialPlan.config));
      configError = configResponseError(result) ?? undefined;
    }
  } catch (error) {
    configError ??= error instanceof Error ? error.message : String(error);
  }

  // A user toggle during config await invalidates this startup apply.
  if (externalMcpEnableGeneration !== startupGeneration) {
    return readExternalMcpStartupSyncPlan();
  }

  const plan = readExternalMcpStartupSyncPlan();
  if (JSON.stringify(plan.config.redaction) !== JSON.stringify(initialPlan.config.redaction)) {
    configError = 'AI privacy settings changed during startup. Enable the bridge again.';
  }
  if (configError || plan.configError) {
    // A rejected or unverified config must never expose an unprotected runtime.
    plan.configError = configError || plan.configError;
    plan.runtimeEnabled = false;
    plan.storedEnabled = false;
    plan.shouldPersistStoredEnabled = readExternalMcpStoredEnabled();
  }
  externalMcpConfigError = plan.configError ?? null;
  emitAIStateChanged(STORAGE_KEY_AI_PRIVACY);
  if (plan.shouldPersistStoredEnabled) {
    localStorageAdapter.writeBoolean(STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED, plan.storedEnabled);
    emitAIStateChanged(STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED);
  }

  // Capture generation again immediately before applying runtime enable/disable.
  const applyGeneration = externalMcpEnableGeneration;
  if (applyGeneration !== startupGeneration) {
    return plan;
  }
  try {
    await Promise.resolve(bridge?.externalMcpSetEnabled?.(plan.runtimeEnabled));
  } catch {
    // Keep stored preference on transient enable failure; runtime status + error
    // surface can recover without wiping always-on intent.
  }
  return plan;
}

let externalMcpStartupSyncPromise: Promise<ExternalMcpStartupSyncPlan> | null = null;

/**
 * Startup reconcile runs exactly once per renderer load. A remounted App must
 * await the same settled promise instead of pushing a second enable/disable to
 * the main process, which would fight the user's live toggle.
 */
export function syncExternalMcpStartupStateOnce(
  bridge: ExternalMcpBridge | undefined = netcattyBridge.get(),
): Promise<ExternalMcpStartupSyncPlan> {
  if (!externalMcpStartupSyncPromise) {
    externalMcpStartupSyncPromise = syncExternalMcpStartupState(bridge);
  }
  return externalMcpStartupSyncPromise;
}

export function resetExternalMcpStartupSyncOnceForTests(): void {
  externalMcpStartupSyncPromise = null;
}

export function useExternalMcpToggleState() {
  // UI mirrors the stored switch. Startup reconcile (App mount, main window only)
  // decides whether temporary mode should clear/persist and start the runtime.
  const isPeerSessionWindow = isPeerSessionWindowLocation();
  const [enabled, setEnabledRaw] = useState<boolean>(() => readExternalMcpStoredEnabled());

  const persistEnabled = useCallback((nextEnabled: boolean) => {
    setEnabledRaw(nextEnabled);
    localStorageAdapter.writeBoolean(STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED, nextEnabled);
    emitAIStateChanged(STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED);
  }, []);

  const [error, setError] = useState<string | null>(() => externalMcpConfigError);

  const setEnabled = useCallback(async (nextEnabled: boolean) => {
    // Peer session windows mirror storage, but never own the main lifecycle.
    if (isPeerSessionWindow) {
      persistEnabled(nextEnabled);
      return;
    }
    if (!nextEnabled) persistEnabled(false);
    const generation = ++externalMcpEnableGeneration;
    setError(null);
    externalMcpConfigError = null;
    const bridge = netcattyBridge.get();
    try {
      // Even a manual enable must apply and verify saved privacy settings first.
      if (nextEnabled) await syncExternalMcpConfig(bridge);
      if (generation !== externalMcpEnableGeneration) return;
      const result = await bridge?.externalMcpSetEnabled?.(nextEnabled);
      if (nextEnabled && result && typeof result === 'object' && 'ok' in result && result.ok === false) {
        throw new Error('error' in result && typeof result.error === 'string' && result.error
          ? result.error : 'External MCP could not be enabled.');
      }
      if (generation === externalMcpEnableGeneration) persistEnabled(nextEnabled);
    } catch (cause) {
      if (generation !== externalMcpEnableGeneration) return;
      externalMcpConfigError = cause instanceof Error ? cause.message : String(cause);
      setError(externalMcpConfigError);
      if (nextEnabled) {
        persistEnabled(false);
        await Promise.resolve(bridge?.externalMcpSetEnabled?.(false)).catch(() => undefined);
      }
    } finally {
      emitAIStateChanged(STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED);
    }
  }, [isPeerSessionWindow, persistEnabled]);

  useEffect(() => {
    const syncFromStorage = () => {
      const nextEnabled = readExternalMcpStoredEnabled();
      setEnabledRaw(nextEnabled);
      setError(externalMcpConfigError);
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED) return;
      syncFromStorage();
    };
    const handleLocalStateChanged = (event: Event) => {
      const key = (event as CustomEvent<{ key?: string }>).detail?.key;
      if (key !== STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED && key !== STORAGE_KEY_AI_EXTERNAL_MCP_REDACTION) return;
      syncFromStorage();
    };

    window.addEventListener('storage', handleStorage);
    window.addEventListener(AI_STATE_CHANGED_EVENT, handleLocalStateChanged);
    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener(AI_STATE_CHANGED_EVENT, handleLocalStateChanged);
    };
  }, []);

  useEffect(() => {
    // Peer windows must never auto-clear the shared stored switch from runtime status.
    if (isPeerSessionWindow || !enabled) return;

    externalMcpPollRefs += 1;
    if (externalMcpPollRefs === 1) {
      externalMcpPollGeneration += 1;
      attachExternalMcpVisibilityListener();
      syncExternalMcpPollTimer();
      void syncExternalMcpRuntimeStatus();
    } else if (!isExternalMcpDocumentHidden() && externalMcpPollIntervalId === null) {
      syncExternalMcpPollTimer();
    }

    return () => {
      externalMcpPollRefs = Math.max(0, externalMcpPollRefs - 1);
      if (externalMcpPollRefs === 0) {
        externalMcpPollGeneration += 1;
        detachExternalMcpVisibilityListener();
        syncExternalMcpPollTimer();
      }
    };
  }, [enabled, isPeerSessionWindow]);

  return { enabled, setEnabled, error };
}
