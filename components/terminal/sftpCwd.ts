import type { TerminalCwdSource } from "../../application/state/terminalCwdStore";

type SessionPwdResult = {
  success: boolean;
  cwd?: string | null;
};

type SessionPwdOptions = {
  allowHomeFallback?: boolean;
  /**
   * When true, fall back to the same-uid login shell cwd after su/sudo.
   * When omitted, follows allowHomeFallback (backend default).
   */
  allowLoginShellFallback?: boolean;
};

export type RendererCwdSource = TerminalCwdSource;
export type TerminalCwdChangeMeta = { source?: RendererCwdSource };

type ResolvePreferredTerminalCwdOptions = {
  rendererCwd?: string | null;
  rendererCwdSource?: RendererCwdSource;
  sessionId?: string | null;
  getSessionPwd: (sessionId: string, options?: SessionPwdOptions) => Promise<SessionPwdResult>;
  /** When true, always probe the backend instead of trusting renderer cwd. */
  preferFreshBackend?: boolean;
  /** When false, a failed backend probe must not return a cached renderer cwd. */
  allowRendererFallback?: boolean;
  /** Require the active shell cwd; never substitute the login shell or home directory. */
  requireActiveShellCwd?: boolean;
};

const normalizeCwd = (cwd?: string | null): string | null => {
  if (typeof cwd !== "string" || cwd.trim().length === 0) return null;
  return cwd;
};

export type TerminalCwdTracker = {
  getRendererCwd: () => string | undefined;
  getRendererCwdSource: () => RendererCwdSource | undefined;
  setRendererCwd: (
    cwd?: string | null,
    source?: RendererCwdSource,
  ) => string | undefined;
  markRendererCwdStale: () => void;
  clearRendererCwd: () => void;
};

export const createTerminalCwdTracker = (): TerminalCwdTracker => {
  let rendererCwd: string | undefined;
  let rendererCwdSource: RendererCwdSource | undefined;

  return {
    getRendererCwd: () => rendererCwd,
    getRendererCwdSource: () => rendererCwdSource,
    setRendererCwd: (cwd, source = "unknown") => {
      rendererCwd = normalizeCwd(cwd) ?? undefined;
      rendererCwdSource = rendererCwd ? source : undefined;
      return rendererCwd;
    },
    markRendererCwdStale: () => {
      if (rendererCwd) rendererCwdSource = "stale";
    },
    clearRendererCwd: () => {
      rendererCwd = undefined;
      rendererCwdSource = undefined;
    },
  };
};

/** Invalidate both the terminal-local provenance and the shared SFTP-follow cwd. */
export const invalidateTerminalCwdAfterCommand = (
  tracker: TerminalCwdTracker,
  sessionId: string,
  onSnapshotCwdInvalidated: () => void,
  onTerminalCwdChange?: (sessionId: string, cwd: string | null) => void,
): void => {
  onSnapshotCwdInvalidated();
  tracker.markRendererCwdStale();
  onTerminalCwdChange?.(sessionId, null);
};

export const resolvePreferredTerminalCwd = async ({
  rendererCwd,
  rendererCwdSource = "unknown",
  sessionId,
  getSessionPwd,
  preferFreshBackend = false,
  allowRendererFallback = true,
  requireActiveShellCwd = false,
}: ResolvePreferredTerminalCwdOptions): Promise<string | null> => {
  const knownCwd = normalizeCwd(rendererCwd);
  if (requireActiveShellCwd && knownCwd && rendererCwdSource === "osc7") {
    return knownCwd;
  }
  const canUseRendererFallback = allowRendererFallback && (
    !requireActiveShellCwd || rendererCwdSource === "osc7"
  );
  if (!preferFreshBackend && knownCwd && canUseRendererFallback) return knownCwd;
  if (!sessionId) return canUseRendererFallback ? knownCwd : null;

  try {
    const result = await getSessionPwd(
      sessionId,
      // Disable ~ guessing so we do not open SFTP on a fabricated home path,
      // while retaining the legacy login-shell fallback only for callers that
      // do not require proof of the active shell directory (#2886).
      preferFreshBackend
        ? {
          allowHomeFallback: false,
          allowLoginShellFallback: !requireActiveShellCwd,
        }
        : undefined,
    );
    const backendCwd = result.success ? normalizeCwd(result.cwd) : null;
    return backendCwd ?? (canUseRendererFallback ? knownCwd : null);
  } catch {
    return canUseRendererFallback ? knownCwd : null;
  }
};

export const PROBE_SESSION_CWD_AFTER_COMMAND_MS = 150;

export type ProbeBackendSessionCwdAfterCommandOptions = {
  sessionId: string;
  osc7SignalAtCommand: number;
  getOsc7Signal: () => number;
  getSessionPwd: (sessionId: string, options?: SessionPwdOptions) => Promise<SessionPwdResult>;
  canProbe?: () => boolean | Promise<boolean>;
};

/** Probe backend pwd when OSC 7 did not report after a command. */
export const probeBackendSessionCwdAfterCommand = async ({
  sessionId,
  osc7SignalAtCommand,
  getOsc7Signal,
  getSessionPwd,
  canProbe = () => true,
}: ProbeBackendSessionCwdAfterCommandOptions): Promise<string | null> => {
  if (getOsc7Signal() !== osc7SignalAtCommand) return null;
  const allowed = await canProbe();
  if (!allowed || getOsc7Signal() !== osc7SignalAtCommand) return null;

  try {
    // This result is published to SFTP follow as the active shell cwd. Do not
    // let the backend substitute the login shell or home directory after a
    // command such as sudo/su changed the interactive shell identity.
    const result = await getSessionPwd(sessionId, {
      allowHomeFallback: false,
      allowLoginShellFallback: false,
    });
    if (getOsc7Signal() !== osc7SignalAtCommand) return null;
    return result.success ? normalizeCwd(result.cwd) : null;
  } catch {
    return null;
  }
};

export const scheduleBackendCwdProbeAfterCommand = (
  options: ProbeBackendSessionCwdAfterCommandOptions & {
    onProbedCwd: (cwd: string) => void;
    delayMs?: number;
  },
): (() => void) => {
  const delayMs = options.delayMs ?? PROBE_SESSION_CWD_AFTER_COMMAND_MS;
  const timeoutId = setTimeout(() => {
    void probeBackendSessionCwdAfterCommand(options).then((cwd) => {
      if (cwd) options.onProbedCwd(cwd);
    });
  }, delayMs);
  return () => clearTimeout(timeoutId);
};
