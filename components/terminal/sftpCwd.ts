type SessionPwdResult = {
  success: boolean;
  cwd?: string | null;
};

type ResolvePreferredTerminalCwdOptions = {
  rendererCwd?: string | null;
  sessionId?: string | null;
  getSessionPwd: (sessionId: string) => Promise<SessionPwdResult>;
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
}: ResolvePreferredTerminalCwdOptions): Promise<string | null> => {
  const knownCwd = normalizeCwd(rendererCwd);
  if (knownCwd) return knownCwd;
  if (!sessionId) return null;

  try {
    const result = await getSessionPwd(sessionId);
    return result.success ? normalizeCwd(result.cwd) : null;
  } catch {
    return null;
  }
};
