/**
 * useTerminalExternalEditor - Application-state hook & session provisioner for
 * Terminal External Editor integration (OSC 7337 requests, per-host trust prompts,
 * and session-scoped ~/.netcatty/bin helper provisioning + one-time PATH activation).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  EXTERNAL_EDITOR_AUTO_SETUP_UPDATED_MARKER,
  buildExternalEditorAutoSetupCommand,
  buildExternalEditorSessionActivateCommand,
  getExternalEditorLabel,
  parseExternalEditorAutoSetupShell,
  resolveExternalEditorTrustPolicy,
  shouldAutoSetupExternalEditorShell,
  validateAndNormalizeRemotePath,
  type ExternalEditorOscRequest,
  type ExternalEditorPresetId,
  type ExternalEditorTargetKind,
} from '../../domain/externalEditor';
import type { Host } from '../../domain/models';
import { logger } from '../../lib/logger';
import {
  getExternalEditorSettingsSnapshot,
  launchRemoteExternalEditor,
  setExternalEditorHostTrust,
  useExternalEditorTerminalAutoSetupConfig,
} from './useExternalEditorSettings';

export interface PendingExternalEditorRequest {
  editorId: ExternalEditorPresetId;
  editorLabel: string;
  remotePath: string;
  kind: ExternalEditorTargetKind;
}

export interface ExternalEditorSessionSetupResult {
  success?: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface ExternalEditorSessionProvisionerDeps {
  setupExec: (sessionId: string, command: string) => Promise<ExternalEditorSessionSetupResult>;
  writeToSession: (sessionId: string, data: string, opts?: { automated?: boolean }) => void;
  getCurrentSessionId: () => string | null;
  isReadyForCommandInjection: () => boolean;
  onConfigured?: (editorLabel: string) => void;
  onWarn?: (message: string, detail?: unknown) => void;
  scheduleTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
}

export interface ExternalEditorSessionProvisioner {
  reset: () => void;
  sync: (params: {
    sessionId: string;
    defaultEditor: ExternalEditorPresetId;
  }) => () => void;
}

/**
 * Stateful session helper provisioner separated from React so lifecycle
 * transitions (initial setup, preferred-editor switching without re-injecting
 * PATH, disconnect reset, and cancellation) can be tested deterministically.
 */
export function createExternalEditorSessionProvisioner(
  deps: ExternalEditorSessionProvisionerDeps,
): ExternalEditorSessionProvisioner {
  const scheduleTimer = deps.scheduleTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle));
  const pollIntervalMs = deps.pollIntervalMs ?? 100;
  const maxPollAttempts = deps.maxPollAttempts ?? 60;

  let trackedSessionId: string | null = null;
  let provisionedEditors = new Set<ExternalEditorPresetId>();
  let pathActivated = false;

  const reset = () => {
    trackedSessionId = null;
    provisionedEditors = new Set();
    pathActivated = false;
  };

  const sync = ({
    sessionId,
    defaultEditor,
  }: {
    sessionId: string;
    defaultEditor: ExternalEditorPresetId;
  }): (() => void) => {
    if (trackedSessionId !== sessionId) {
      trackedSessionId = sessionId;
      provisionedEditors = new Set();
      pathActivated = false;
    }

    if (provisionedEditors.has(defaultEditor) && pathActivated) {
      return () => {};
    }

    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    const setupCmd = buildExternalEditorAutoSetupCommand(defaultEditor);

    void deps.setupExec(sessionId, setupCmd).then((result) => {
      if (cancelled) return;
      if (trackedSessionId !== sessionId || deps.getCurrentSessionId() !== sessionId) return;
      if (!result?.success) {
        deps.onWarn?.(
          '[Terminal] External editor session helper setup failed:',
          result?.error || result?.stderr,
        );
        return;
      }

      provisionedEditors.add(defaultEditor);
      const updated = typeof result.stdout === 'string'
        && result.stdout.includes(EXTERNAL_EDITOR_AUTO_SETUP_UPDATED_MARKER);

      // PATH is already active in this shell session (e.g. user changed preferred
      // editor while connected); the new wrapper in ~/.netcatty/bin is immediately
      // available without injecting another PATH command into the running terminal.
      if (pathActivated) {
        if (updated) {
          deps.onConfigured?.(getExternalEditorLabel(defaultEditor));
        }
        return;
      }

      const shellKind = parseExternalEditorAutoSetupShell(result.stdout);
      const activateCmd = buildExternalEditorSessionActivateCommand(shellKind);

      let attempts = 0;
      const tryActivateInSession = () => {
        if (cancelled) return;
        if (trackedSessionId !== sessionId || deps.getCurrentSessionId() !== sessionId) return;
        if (pathActivated) return;

        if (deps.isReadyForCommandInjection()) {
          pathActivated = true;
          deps.writeToSession(sessionId, activateCmd, { automated: true });
          if (updated) {
            deps.onConfigured?.(getExternalEditorLabel(defaultEditor));
          }
          return;
        }

        attempts += 1;
        if (attempts < maxPollAttempts) {
          pollTimer = scheduleTimer(tryActivateInSession, pollIntervalMs);
        }
      };

      tryActivateInSession();
    }).catch((err) => {
      if (cancelled) return;
      deps.onWarn?.('[Terminal] External editor session helper setup error:', err);
    });

    return () => {
      cancelled = true;
      if (pollTimer !== null) {
        clearTimer(pollTimer);
        pollTimer = null;
      }
    };
  };

  return { reset, sync };
}

export interface UseTerminalExternalEditorOptions {
  sessionId: string;
  status: string;
  host: Pick<
    Host,
    'id' | 'hostname' | 'port' | 'username' | 'label' | 'protocol' | 'externalEditorShellIntegration'
  >;
  isLocalConnection: boolean;
  isSerialConnection: boolean;
  getBackendSessionId: () => string | null;
  isVisible: () => boolean;
  getFallbackCwd: () => string | undefined;
  isReadyForCommandInjection: () => boolean;
  setupOsc7Tracking?: (sessionId: string, command: string) => Promise<ExternalEditorSessionSetupResult>;
  writeToSession: (sessionId: string, data: string, opts?: { automated?: boolean }) => void;
  focusTerminal: () => void;
  onOpened: (editorLabel: string, remotePath: string) => void;
  onOpenFailed: (message: string) => void;
  formatFallbackOpenError: (editorLabel: string) => string;
  onAutoSetupConfigured: (editorLabel: string) => void;
}

export function useTerminalExternalEditor(options: UseTerminalExternalEditorOptions) {
  const liveRef = useRef(options);
  liveRef.current = options;

  const {
    sessionId,
    status,
    host,
    isLocalConnection,
    isSerialConnection,
  } = options;
  const hostProtocol = host.protocol || 'ssh';

  const [pendingExternalEditorRequest, setPendingExternalEditorRequest] =
    useState<PendingExternalEditorRequest | null>(null);
  const pendingExternalEditorRequestRef = useRef(pendingExternalEditorRequest);
  pendingExternalEditorRequestRef.current = pendingExternalEditorRequest;
  const lastExternalEditorLaunchRef = useRef<{ key: string; at: number } | null>(null);

  const executeExternalEditorLaunch = useCallback((req: PendingExternalEditorRequest) => {
    const launchKey = `${req.editorId}:${req.kind}:${req.remotePath}`;
    const now = Date.now();
    const prev = lastExternalEditorLaunchRef.current;
    if (prev && prev.key === launchKey && now - prev.at < 800) {
      return;
    }
    lastExternalEditorLaunchRef.current = { key: launchKey, at: now };

    const current = liveRef.current;
    void launchRemoteExternalEditor({
      editorId: req.editorId,
      host: {
        hostId: current.host.id,
        hostname: current.host.hostname,
        port: current.host.port,
        username: current.host.username,
        label: current.host.label,
      },
      remotePath: req.remotePath,
      kind: req.kind,
      sessionId: current.getBackendSessionId() ?? current.sessionId,
    }).then(() => {
      liveRef.current.onOpened(req.editorLabel, req.remotePath);
    }).catch((err) => {
      liveRef.current.onOpenFailed(
        err instanceof Error
          ? err.message
          : liveRef.current.formatFallbackOpenError(req.editorLabel),
      );
    });
  }, []);

  const handleOscExternalEditorRequest = useCallback((request: ExternalEditorOscRequest) => {
    const current = liveRef.current;
    // Strictly scope OSC 7337 remote editor opens to live SSH sessions on visible tabs.
    if (current.isLocalConnection || current.isSerialConnection) return;
    if (!current.isVisible()) return;
    if ((current.host.protocol || 'ssh') !== 'ssh') return;

    const settings = getExternalEditorSettingsSnapshot();
    if (!settings.terminalRequestsEnabled) return;

    const fallbackCwd = current.getFallbackCwd();
    const normalized = validateAndNormalizeRemotePath(request.path, fallbackCwd);
    if (!normalized.ok) {
      logger.warn(
        '[Terminal] Rejected invalid OSC 7337 remote path:',
        'error' in normalized ? normalized.error : 'invalid path',
      );
      return;
    }

    const editorId: ExternalEditorPresetId = request.editorId ?? settings.defaultEditor;
    const editorLabel = getExternalEditorLabel(editorId);
    const hostIdentity = {
      hostId: current.host.id,
      hostname: current.host.hostname,
      port: current.host.port,
      username: current.host.username,
      label: current.host.label,
    };
    const trust = resolveExternalEditorTrustPolicy(settings, hostIdentity);
    if (trust === 'deny') {
      logger.debug('[Terminal] Ignored OSC 7337 external editor request (host denied)');
      return;
    }

    const launchPayload: PendingExternalEditorRequest = {
      editorId,
      editorLabel,
      remotePath: normalized.path,
      kind: request.kind,
    };

    if (trust === 'allow') {
      executeExternalEditorLaunch(launchPayload);
      return;
    }

    // Untrusted host: show explicit inline confirmation prompt (do not overwrite an active prompt).
    setPendingExternalEditorRequest((prev) => prev ?? launchPayload);
  }, [executeExternalEditorLaunch]);

  const handleExternalEditorPromptResponse = useCallback((decision: 'deny' | 'once' | 'always') => {
    const currentRequest = pendingExternalEditorRequestRef.current;
    pendingExternalEditorRequestRef.current = null;
    setPendingExternalEditorRequest(null);
    if (currentRequest) {
      const current = liveRef.current;
      if (decision === 'always') {
        setExternalEditorHostTrust({
          hostId: current.host.id,
          hostname: current.host.hostname,
          port: current.host.port,
          username: current.host.username,
          label: current.host.label,
        }, 'allow');
        executeExternalEditorLaunch(currentRequest);
      } else if (decision === 'once') {
        executeExternalEditorLaunch(currentRequest);
      }
    }
    liveRef.current.focusTerminal();
  }, [executeExternalEditorLaunch]);

  // Session-scoped external editor shell commands: install standalone helpers into
  // ~/.netcatty/bin over the silent exec channel (never modifying shell rc files)
  // and prepend ~/.netcatty/bin to PATH once per connected terminal session.
  const autoSetupConfig = useExternalEditorTerminalAutoSetupConfig();
  const shouldEnableSessionCommands = shouldAutoSetupExternalEditorShell(
    autoSetupConfig,
    { externalEditorShellIntegration: host.externalEditorShellIntegration },
  );
  const defaultExternalEditor = autoSetupConfig.defaultEditor;

  const provisionerRef = useRef<ExternalEditorSessionProvisioner | null>(null);
  if (!provisionerRef.current) {
    provisionerRef.current = createExternalEditorSessionProvisioner({
      setupExec: (activeSessionId, command) => {
        const fn = liveRef.current.setupOsc7Tracking;
        if (!fn) return Promise.resolve({ success: false, error: 'setupOsc7Tracking unavailable' });
        return fn(activeSessionId, command);
      },
      writeToSession: (activeSessionId, data, opts) => {
        liveRef.current.writeToSession(activeSessionId, data, opts);
      },
      getCurrentSessionId: () => liveRef.current.getBackendSessionId() ?? liveRef.current.sessionId,
      isReadyForCommandInjection: () => liveRef.current.isReadyForCommandInjection(),
      onConfigured: (editorLabel) => liveRef.current.onAutoSetupConfigured(editorLabel),
      onWarn: (message, detail) => logger.warn(message, detail),
      scheduleTimer: (fn, ms) => window.setTimeout(fn, ms) as unknown as ReturnType<typeof setTimeout>,
      clearTimer: (handle) => window.clearTimeout(handle as unknown as number),
    });
  }

  useEffect(() => {
    const provisioner = provisionerRef.current;
    if (!provisioner) return;

    if (status !== 'connected') {
      provisioner.reset();
      return;
    }
    if (isLocalConnection || isSerialConnection) return;
    if (hostProtocol !== 'ssh') return;
    if (!shouldEnableSessionCommands) return;
    if (!liveRef.current.setupOsc7Tracking) return;

    const activeSessionId = liveRef.current.getBackendSessionId() ?? sessionId;
    if (!activeSessionId) return;

    return provisioner.sync({
      sessionId: activeSessionId,
      defaultEditor: defaultExternalEditor,
    });
  }, [
    status,
    isLocalConnection,
    isSerialConnection,
    hostProtocol,
    shouldEnableSessionCommands,
    defaultExternalEditor,
    sessionId,
  ]);

  return {
    pendingExternalEditorRequest,
    handleOscExternalEditorRequest,
    handleExternalEditorPromptResponse,
  };
}
