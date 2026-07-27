import type { CodingCliProviderId } from './codingCliProviders';

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

type ControlSequenceMode =
  | 'text'
  | 'esc'
  | 'escIntermediate'
  | 'csi'
  | 'string'
  | 'stringEsc';

function createTerminalControlSequenceStripper() {
  let mode: ControlSequenceMode = 'text';
  let stringAllowsBel = false;

  const feed = (text: string): string => {
    let visible = '';
    for (const char of text) {
      const code = char.charCodeAt(0);
      if (mode === 'text') {
        if (char === ESC) mode = 'esc';
        else visible += char;
      } else if (mode === 'esc') {
        if (char === '[') {
          mode = 'csi';
        } else if (char === ']' || char === 'P' || char === 'X' || char === '^' || char === '_') {
          mode = 'string';
          stringAllowsBel = char === ']';
        } else if (code >= 0x20 && code <= 0x2f) {
          mode = 'escIntermediate';
        } else {
          mode = 'text';
          // ESC final bytes span 0x30-0x7e. Preserve only invalid bytes rather
          // than silently swallowing ordinary output.
          if (code < 0x30 || code > 0x7e) visible += char;
        }
      } else if (mode === 'escIntermediate') {
        if (code >= 0x20 && code <= 0x2f) continue;
        mode = char === ESC ? 'esc' : 'text';
        if (char !== ESC && (code < 0x30 || code > 0x7e)) visible += char;
      } else if (mode === 'csi') {
        if (code >= 0x40 && code <= 0x7e) mode = 'text';
      } else if (mode === 'string') {
        if (stringAllowsBel && char === BEL) mode = 'text';
        else if (char === ESC) mode = 'stringEsc';
      } else if (char === '\\') {
        mode = 'text';
      } else if (stringAllowsBel && char === BEL) {
        mode = 'text';
      } else if (char !== ESC) {
        mode = 'string';
      }
    }
    return visible;
  };

  return {
    feed,
    reset: () => {
      mode = 'text';
      stringAllowsBel = false;
    },
  };
}

/** Strip ANSI/OSC sequences so startup banners remain readable. */
export function stripTerminalControlSequences(text: string): string {
  return createTerminalControlSequenceStripper().feed(text);
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
    // Match Claude's actual welcome banner, not installer messages such as
    // "Setting up Claude Code..." which are ordinary shell output.
    test: (text) => /\bWelcome to Claude Code\b/i.test(text) || text.includes('✳'),
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
    // The installer prints the brand and a shaded ASCII wordmark. The TUI's
    // startup logo uses a distinct space-filled third row, so require both
    // TUI rows instead of matching ordinary OpenCode text.
    test: (text) => (
      /█▀▀█\s+█▀▀█\s+█▀▀█\s+█▀▀▄[\s\S]{0,512}█ {2}█\s+█ {2}█\s+█▀▀▀\s+█ {2}█/.test(text)
    ),
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
  let visibleBuffer = '';
  let bytesFed = 0;
  let exhausted = false;
  const controlSequenceStripper = createTerminalControlSequenceStripper();

  const feed = (chunk: string): CodingCliProviderId | undefined => {
    if (!chunk || exhausted) return undefined;

    bytesFed += chunk.length;
    visibleBuffer = `${visibleBuffer}${controlSequenceStripper.feed(chunk)}`
      .slice(-OUTPUT_SCAN_BUFFER_LIMIT);
    const providerId = inferCodingCliProviderFromOutput(visibleBuffer);
    if (providerId) return providerId;

    if (bytesFed >= OUTPUT_SCAN_BYTE_LIMIT) {
      exhausted = true;
    }

    return undefined;
  };

  const reset = () => {
    visibleBuffer = '';
    bytesFed = 0;
    exhausted = false;
    controlSequenceStripper.reset();
  };

  const isExhausted = () => exhausted;

  return { feed, reset, isExhausted };
}
