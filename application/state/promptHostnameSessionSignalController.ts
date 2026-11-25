import type { TerminalSession } from '../../domain/models';
import {
  extractTerminalPromptHostname,
  isJumpServerMenuPrompt,
} from '../../domain/terminalPromptSecurity';

type PromptHostnameSessionSignalOptions = {
  getSession: (sessionId: string) => Pick<TerminalSession, 'protocol' | 'hostname'> | undefined;
  onChange: (sessionId: string, hostname: string | null) => void;
  maxTailChars?: number;
};

const DEFAULT_MAX_TAIL_CHARS = 8_192;

function normalizedHostname(hostname: string): string {
  return hostname.trim().toLocaleLowerCase().replace(/\.$/u, '');
}

export function createPromptHostnameSessionSignalController({
  getSession,
  onChange,
  maxTailChars = DEFAULT_MAX_TAIL_CHARS,
}: PromptHostnameSessionSignalOptions) {
  const tails = new Map<string, string>();
  const baselines = new Map<string, string>();
  const published = new Map<string, string>();
  const tailLimit = Math.max(256, maxTailChars);

  const forgetSession = (sessionId: string): void => {
    tails.delete(sessionId);
    baselines.delete(sessionId);
    published.delete(sessionId);
  };

  return {
    forgetSession,
    pruneSessions(validSessionIds: ReadonlySet<string>): void {
      for (const sessionId of [...tails.keys(), ...baselines.keys(), ...published.keys()]) {
        if (!validSessionIds.has(sessionId)) {
          forgetSession(sessionId);
        }
      }
    },
    handleTerminalOutput(sessionId: string, chunk: string): void {
      const session = getSession(sessionId);
      if (!session) {
        forgetSession(sessionId);
        return;
      }
      if ((session.protocol ?? 'ssh') !== 'ssh') return;

      const combined = `${tails.get(sessionId) ?? ''}${chunk}`;
      const tail = combined.slice(-tailLimit);
      tails.set(sessionId, tail);

      const detected = extractTerminalPromptHostname(tail);
      if (!detected) {
        if (isJumpServerMenuPrompt(tail) && published.has(sessionId)) {
          published.delete(sessionId);
          onChange(sessionId, null);
        }
        return;
      }

      const detectedKey = normalizedHostname(detected);
      if (!detectedKey) return;

      let baseline = baselines.get(sessionId);
      if (baseline === undefined) {
        baseline = normalizedHostname(session.hostname) || detectedKey;
        baselines.set(sessionId, baseline);
      }

      if (detectedKey === baseline) {
        if (!published.has(sessionId)) return;
        published.delete(sessionId);
        onChange(sessionId, null);
        return;
      }

      if (published.get(sessionId) === detectedKey) return;
      published.set(sessionId, detectedKey);
      onChange(sessionId, detected);
    },
  };
}
