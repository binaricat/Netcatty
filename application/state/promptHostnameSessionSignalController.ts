import type { TerminalSession } from '../../domain/models';
import {
  extractTerminalPromptHostname,
  isJumpServerMenuPrompt,
} from '../../domain/terminalPromptSecurity';

type PromptHostnameSessionSignalOptions = {
  getSession: (sessionId: string) => Pick<TerminalSession, 'protocol'> | undefined;
  onChange: (
    sessionId: string,
    hostname: string | null,
    options: { fromJumpServer: boolean },
  ) => void;
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
  const published = new Map<string, string>();
  const jumpServerSessions = new Set<string>();
  const tailLimit = Math.max(256, maxTailChars);

  const forgetSession = (sessionId: string): void => {
    tails.delete(sessionId);
    published.delete(sessionId);
    jumpServerSessions.delete(sessionId);
  };

  return {
    forgetSession,
    pruneSessions(validSessionIds: ReadonlySet<string>): void {
      for (const sessionId of [...tails.keys(), ...published.keys(), ...jumpServerSessions]) {
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
      if (
        (combined.includes('Opt>') || combined.includes('[Host]>'))
        && combined.split(/\r\n|\r|\n/u).some((line) => isJumpServerMenuPrompt(line))
      ) {
        jumpServerSessions.add(sessionId);
      }

      const detected = extractTerminalPromptHostname(tail);
      if (!detected) {
        if (isJumpServerMenuPrompt(tail) && published.has(sessionId)) {
          published.delete(sessionId);
          onChange(sessionId, null, { fromJumpServer: true });
        }
        return;
      }

      const detectedKey = normalizedHostname(detected);
      if (!detectedKey) return;

      // Observe the prompt, not whether its hostname matches an IP or DNS alias.
      // The domain title policy decides if this presentation is shown.
      if (published.get(sessionId) === detectedKey) return;
      published.set(sessionId, detectedKey);
      onChange(sessionId, detected, {
        fromJumpServer: jumpServerSessions.has(sessionId),
      });
    },
  };
}
