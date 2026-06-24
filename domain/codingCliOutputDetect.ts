import type { CodingCliProviderId } from './codingCliProviders';

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const ANSI_CSI_RE = new RegExp(`${ESC}\\[[0-9:;?]*[ -/]*[@-~]`, 'g');
const OSC_SEQUENCE_RE = new RegExp(`${ESC}\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)`, 'g');
const LONE_ESC_RE = new RegExp(`${ESC}[@-_]`, 'g');

/** Strip ANSI/OSC sequences so startup banners remain readable. */
export function stripTerminalControlSequences(text: string): string {
  return text
    .replace(ANSI_CSI_RE, '')
    .replace(OSC_SEQUENCE_RE, '')
    .replace(LONE_ESC_RE, '');
}

type OutputSignature = {
  id: CodingCliProviderId;
  test: (text: string) => boolean;
};

/**
 * Startup banners and prompts emitted by coding CLIs.
 * Codex does not put its name in OSC titles by default (openai/codex#18740),
 * but always prints an "OpenAI Codex" header when the TUI starts.
 */
const OUTPUT_SIGNATURES: readonly OutputSignature[] = [
  {
    id: 'codex',
    test: (text) => /(?:^|\s)(?:>\s*)?OpenAI Codex(?:\s*\(|$|\s)/i.test(text),
  },
  {
    id: 'claude',
    test: (text) => /Claude Code/i.test(text) || text.includes('✳'),
  },
  {
    id: 'copilot',
    test: (text) => /GitHub Copilot/i.test(text),
  },
  {
    id: 'gemini',
    test: (text) => /Gemini CLI/i.test(text),
  },
  {
    id: 'droid',
    test: (text) => /Factory Droid/i.test(text) || /Factory\.ai/i.test(text),
  },
  {
    id: 'opencode',
    test: (text) => /\bOpenCode\b/i.test(text),
  },
  {
    id: 'kimi',
    test: (text) => /\bMoonshot\b/i.test(text) || /\bKimi\b/i.test(text),
  },
] as const;

const OUTPUT_SCAN_BUFFER_LIMIT = 8192;
const OUTPUT_SCAN_BYTE_LIMIT = 16384;

export function inferCodingCliProviderFromOutput(text: string): CodingCliProviderId | undefined {
  const normalized = stripTerminalControlSequences(text);
  if (!normalized.trim()) return undefined;

  for (const signature of OUTPUT_SIGNATURES) {
    if (signature.test(normalized)) {
      return signature.id;
    }
  }

  return undefined;
}

export type CodingCliOutputScanner = {
  feed: (chunk: string) => CodingCliProviderId | undefined;
  reset: () => void;
  isExhausted: () => boolean;
};

/** Rolling buffer scanner for live terminal output chunks. */
export function createCodingCliOutputScanner(): CodingCliOutputScanner {
  let buffer = '';
  let bytesFed = 0;
  let exhausted = false;

  const feed = (chunk: string): CodingCliProviderId | undefined => {
    if (!chunk || exhausted) return undefined;

    bytesFed += chunk.length;
    buffer = `${buffer}${stripTerminalControlSequences(chunk)}`.slice(-OUTPUT_SCAN_BUFFER_LIMIT);
    const providerId = inferCodingCliProviderFromOutput(buffer);
    if (providerId) return providerId;

    if (bytesFed >= OUTPUT_SCAN_BYTE_LIMIT) {
      exhausted = true;
    }

    return undefined;
  };

  const reset = () => {
    buffer = '';
    bytesFed = 0;
    exhausted = false;
  };

  const isExhausted = () => exhausted;

  return { feed, reset, isExhausted };
}
