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

const isLiveTerminalCwdSource = (source?: RendererCwdSource | null): boolean =>
  source === "osc7" || source === "inferred";

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

/**
 * Single-channel shells cannot probe pwd and often have no OSC 7. Clearing the
 * last inferred directory on an ordinary command makes the next relative cd in
 * a split pane lose its base, so SFTP follow stays on the old path.
 */
export const shouldPreserveTerminalCwdAcrossCommand = (
  restrictExtraSshChannels: boolean,
): boolean => restrictExtraSshChannels;

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
  if (requireActiveShellCwd && knownCwd && isLiveTerminalCwdSource(rendererCwdSource)) {
    return knownCwd;
  }
  const canUseRendererFallback = allowRendererFallback && (
    !requireActiveShellCwd || isLiveTerminalCwdSource(rendererCwdSource)
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
export const PROBE_SESSION_CWD_RETRY_MS = 250;
export const PROBE_SESSION_CWD_MAX_ATTEMPTS = 3;

export type ProbeBackendSessionCwdAfterCommandOptions = {
  sessionId: string;
  osc7SignalAtCommand: number;
  getOsc7Signal: () => number;
  getSessionPwd: (sessionId: string, options?: SessionPwdOptions) => Promise<SessionPwdResult>;
  canProbe?: () => boolean | Promise<boolean>;
  /**
   * Cwd last observed when the command was submitted. A probe result equal to
   * it may be a stale read that raced the remote command execution (e.g. `cd`
   * still in flight over a slower link), so the read is retried briefly before
   * publishing instead of reporting the pre-command directory (#3588).
   */
  baselineCwd?: string | null;
  maxAttempts?: number;
  retryDelayMs?: number;
  /** Abort pending retries, e.g. when the scheduler cancelled the probe. */
  isCancelled?: () => boolean;
};

/** One guarded backend pwd read, without retry logic. */
const probeBackendSessionPwdOnce = async ({
  sessionId,
  osc7SignalAtCommand,
  getOsc7Signal,
  getSessionPwd,
  canProbe,
}: Pick<ProbeBackendSessionCwdAfterCommandOptions, "sessionId" | "osc7SignalAtCommand" | "getOsc7Signal" | "getSessionPwd" | "canProbe">): Promise<string | null> => {
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Probe backend pwd when OSC 7 did not report after a command.
 *
 * Without a `baselineCwd` this performs a single read. With one, it retries a
 * bounded number of times while the reported pwd still equals the pre-command
 * baseline — the shell may not have executed the submitted command yet — and
 * publishes the first read that differs from the baseline *and* repeats on a
 * later attempt. That stability check keeps an earlier queued `cd` (still in
 * flight over a slower link) from being published as the result of the latest
 * submission; a probe that never settles publishes its last differing read.
 * If every read within the retry window still equals the baseline, the
 * submitted command may still be in flight (e.g. `sleep 2 && cd /tmp`), so
 * the baseline is unconfirmed and the probe publishes null — leaving the cwd
 * invalid rather than republishing the stale pre-command directory (#3589);
 * the next command's probe or an OSC 7 report settles it. A failed probe
 * still resolves to null without retrying, matching the legacy single-read
 * behavior.
 */
export const probeBackendSessionCwdAfterCommand = async ({
  sessionId,
  osc7SignalAtCommand,
  getOsc7Signal,
  getSessionPwd,
  canProbe = () => true,
  baselineCwd,
  maxAttempts = baselineCwd ? PROBE_SESSION_CWD_MAX_ATTEMPTS : 1,
  retryDelayMs = PROBE_SESSION_CWD_RETRY_MS,
  isCancelled = () => false,
}: ProbeBackendSessionCwdAfterCommandOptions): Promise<string | null> => {
  let lastResult: string | null = null;
  // Most recent read that differed from the baseline. It is only trustworthy
  // as the executed result once a later read repeats it — the first differing
  // read may belong to an earlier queued cwd command that is still in flight.
  let candidate: string | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      if (isCancelled() || getOsc7Signal() !== osc7SignalAtCommand) return null;
      await sleep(retryDelayMs);
      if (isCancelled() || getOsc7Signal() !== osc7SignalAtCommand) return null;
    }
    lastResult = await probeBackendSessionPwdOnce({
      sessionId,
      osc7SignalAtCommand,
      getOsc7Signal,
      getSessionPwd,
      canProbe,
    });
    if (isCancelled()) return null;
    if (lastResult === null) return lastResult;
    if (!baselineCwd) return lastResult;
    if (lastResult === baselineCwd) continue;
    if (candidate !== null && lastResult === candidate) return lastResult;
    candidate = lastResult;
  }
  // Reaching here with an unset candidate means every read still matched the
  // baseline: the executed command has not been observed yet, so publishing
  // `lastResult` would republish the stale baseline. Leave the cwd invalid.
  return candidate;
};

export const scheduleBackendCwdProbeAfterCommand = (
  options: ProbeBackendSessionCwdAfterCommandOptions & {
    onProbedCwd: (cwd: string) => void;
    delayMs?: number;
  },
): (() => void) => {
  const delayMs = options.delayMs ?? PROBE_SESSION_CWD_AFTER_COMMAND_MS;
  let cancelled = false;
  const timeoutId = setTimeout(() => {
    void probeBackendSessionCwdAfterCommand({
      ...options,
      isCancelled: () => cancelled,
    }).then((cwd) => {
      if (cancelled) return;
      if (cwd) options.onProbedCwd(cwd);
    });
  }, delayMs);
  return () => {
    cancelled = true;
    clearTimeout(timeoutId);
  };
};
