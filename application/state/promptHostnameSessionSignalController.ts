import type { TerminalSession } from '../../domain/models';
import { extractTerminalPromptHostname } from '../../domain/terminalPromptSecurity';

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

  return {
    handleTerminalOutput(sessionId: string, chunk: string): void {
      const session = getSession(sessionId);
      if (!session || (session.protocol ?? 'ssh') !== 'ssh') return;

      const combined = `${tails.get(sessionId) ?? ''}${chunk}`;
      tails.set(sessionId, combined.slice(-tailLimit));

      const detected = extractTerminalPromptHostname(tails.get(sessionId) ?? '');
      if (!detected) return;

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
