import type { CodingCliProviderId } from './codingCliProviders';

/** Braille dot-spinner frames used by Codex and several other agent TUIs. */
export const CODING_CLI_BRAILLE_SPINNER_FRAMES = [
  '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏',
] as const;

const BRAILLE_SPINNER_RE = /^[\s⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✳✴✶✻✽❋◆◇]+/u;
const ACTION_REQUIRED_PREFIX_RE = /^\[\s*[!.]\s*\]\s*(?:Action Required\s*)?/iu;
const LEADING_SEPARATOR_RE = /^[\s·•….]+/u;

const CLAUDE_MARKERS = ['claude code', 'claude', 'anthropic'] as const;
const CODEX_STATUS_WORDS = ['working', 'thinking', 'ready', 'waiting'] as const;
const BUSY_STATUS_WORDS = ['working', 'thinking', 'running', 'compacting', 'generating'] as const;
const WAITING_STATUS_WORDS = ['waiting', 'permission', 'approval', 'confirm', 'input required'] as const;

export type CodingCliActivityPhase = 'idle' | 'busy' | 'waiting';

export function normalizeCodingCliTitle(title: string): string {
  let normalized = title.trim().replace(BRAILLE_SPINNER_RE, '').trim();
  normalized = normalized.replace(ACTION_REQUIRED_PREFIX_RE, '').trim();
  normalized = normalized.replace(LEADING_SEPARATOR_RE, '').trim();
  return normalized;
}

export function normalizeCodingCliDynamicTitleForStorage(title: string): string {
  let normalized = title.trim().replace(BRAILLE_SPINNER_RE, '').trim();
  normalized = normalized.replace(LEADING_SEPARATOR_RE, '').trim();
  return normalized;
}

export function titleHasBrailleSpinner(title: string): boolean {
  return CODING_CLI_BRAILLE_SPINNER_FRAMES.some((frame) => title.includes(frame));
}

export function titleIncludesPhrase(title: string, phrase: string): boolean {
  const normalized = title.toLowerCase();
  const needle = phrase.toLowerCase().trim();
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, 'i').test(normalized);
}

export function inferCodingCliProviderFromTitleSignals(title: string): CodingCliProviderId | undefined {
  const raw = title.trim();
  if (!raw) return undefined;

  if (titleIncludesPhrase(raw, 'claude code') || raw.includes('✳') || titleIncludesPhrase(raw, 'claude')) {
    return 'claude';
  }
  if (titleIncludesPhrase(raw, 'opencode')) return 'opencode';
  if (titleIncludesPhrase(raw, 'codex') || titleIncludesPhrase(raw, 'chatgpt')) return 'codex';
  if (titleIncludesPhrase(raw, 'github copilot') || titleIncludesPhrase(raw, 'copilot')) return 'copilot';
  if (titleIncludesPhrase(raw, 'codebuddy')) return 'codebuddy';
  if (titleIncludesPhrase(raw, 'gemini')) return 'gemini';
  if (titleIncludesPhrase(raw, 'moonshot') || titleIncludesPhrase(raw, 'kimi')) return 'kimi';
  if (titleIncludesPhrase(raw, 'factory droid') || titleIncludesPhrase(raw, 'factory ai')) return 'droid';
  if (titleIncludesPhrase(raw, 'droid')) return 'droid';
  if (titleIncludesPhrase(raw, 'cursor agent') || titleIncludesPhrase(raw, 'cursor')) return 'cursor';

  const stripped = normalizeCodingCliTitle(raw).toLowerCase();
  if (
    titleHasBrailleSpinner(raw)
    && CODEX_STATUS_WORDS.some((word) => titleIncludesPhrase(stripped, word))
    && !CLAUDE_MARKERS.some((marker) => titleIncludesPhrase(raw, marker))
  ) {
    return 'codex';
  }

  return undefined;
}

export function resolveCodingCliActivityPhase(
  title: string | undefined,
  providerId?: CodingCliProviderId,
): CodingCliActivityPhase {
  const raw = title?.trim();
  if (!raw || !providerId) return 'idle';

  const normalized = normalizeCodingCliTitle(raw).toLowerCase();

  if (WAITING_STATUS_WORDS.some((word) => titleIncludesPhrase(normalized, word))) {
    return 'waiting';
  }

  if (titleHasBrailleSpinner(raw) || raw.includes('✳')) {
    return 'busy';
  }

  if (BUSY_STATUS_WORDS.some((word) => titleIncludesPhrase(normalized, word))) {
    return 'busy';
  }

  if (providerId === 'codex' && CODEX_STATUS_WORDS.includes(normalized as typeof CODEX_STATUS_WORDS[number])) {
    return normalized === 'ready' ? 'idle' : 'busy';
  }

  return 'idle';
}

const SHELL_TITLE_RE = /^(?:bash|zsh|fish|pwsh|powershell|sh|nu|xonsh|cmd)(?:\s|$|[(@])/i;
const SHELL_PATH_TITLE_RE = /^(?:(?:[^@\s:]+@)?[^:\s]+:)?(?:~(?:\/|$)|\/|[A-Za-z]:[\\/])/;

/** Whether a shell-reported title no longer reflects an active coding CLI session. */
export function shouldClearCodingCliProviderForTitle(
  title: string,
  providerId: CodingCliProviderId,
): boolean {
  const trimmed = title.trim();
  if (!trimmed) return true;

  const inferredId = inferCodingCliProviderFromTitleSignals(trimmed);
  if (inferredId === providerId) return false;
  if (inferredId) return true;
  if (SHELL_TITLE_RE.test(trimmed)) return true;
  if (SHELL_PATH_TITLE_RE.test(trimmed)) return true;

  // Ambiguous titles (e.g. Codex project names) may still be an active agent session.
  return false;
}
