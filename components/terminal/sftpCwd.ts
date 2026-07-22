type SessionPwdResult = {
  success: boolean;
  cwd?: string | null;
};

type SessionPwdOptions = {
  allowHomeFallback?: boolean;
};

type ResolvePreferredTerminalCwdOptions = {
  rendererCwd?: string | null;
  sessionId?: string | null;
  getSessionPwd: (sessionId: string, options?: SessionPwdOptions) => Promise<SessionPwdResult>;
  /** When true, always probe the backend instead of trusting renderer cwd. */
  preferFreshBackend?: boolean;
  /** When false, a failed backend probe must not return a cached renderer cwd. */
  allowRendererFallback?: boolean;
};

const normalizeCwd = (cwd?: string | null): string | null => {
  if (typeof cwd !== "string" || cwd.trim().length === 0) return null;
  return cwd;
};

export type TerminalCwdTracker = {
  getRendererCwd: () => string | undefined;
  setRendererCwd: (cwd?: string | null) => string | undefined;
  clearRendererCwd: () => void;
};

export const createTerminalCwdTracker = (): TerminalCwdTracker => {
  let rendererCwd: string | undefined;

  return {
    getRendererCwd: () => rendererCwd,
    setRendererCwd: (cwd) => {
      rendererCwd = normalizeCwd(cwd) ?? undefined;
      return rendererCwd;
    },
    clearRendererCwd: () => {
      rendererCwd = undefined;
    },
  };
};

export const resolvePreferredTerminalCwd = async ({
  rendererCwd,
  sessionId,
  getSessionPwd,
  preferFreshBackend = false,
  allowRendererFallback = true,
}: ResolvePreferredTerminalCwdOptions): Promise<string | null> => {
  const knownCwd = normalizeCwd(rendererCwd);
  if (!preferFreshBackend && knownCwd) return knownCwd;
  if (!sessionId) return allowRendererFallback ? knownCwd : null;

  try {
    const result = await getSessionPwd(
      sessionId,
      preferFreshBackend ? { allowHomeFallback: false } : undefined,
    );
    const backendCwd = result.success ? normalizeCwd(result.cwd) : null;
    return backendCwd ?? (allowRendererFallback ? knownCwd : null);
  } catch {
    return allowRendererFallback ? knownCwd : null;
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
    const result = await getSessionPwd(sessionId);
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
