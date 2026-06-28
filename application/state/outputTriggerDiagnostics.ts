import type { Snippet } from '@/domain/models';
import { isScriptSnippet } from '@/domain/snippetScript.ts';
import { snippetAppliesToOutputTrigger } from '@/domain/snippetTargets.ts';
import { STORAGE_KEY_OUTPUT_TRIGGER_DEBUG } from '@/infrastructure/config/storageKeys.ts';
import { localStorageAdapter } from '@/infrastructure/persistence/localStorageAdapter.ts';

const LOG_PREFIX = '[output-trigger]';

const isDev =
  typeof import.meta !== 'undefined'
  && typeof import.meta.env !== 'undefined'
  && !!import.meta.env.DEV;

export function isOutputTriggerDebugEnabled(): boolean {
  if (isDev) return true;
  try {
    return localStorageAdapter.readString(STORAGE_KEY_OUTPUT_TRIGGER_DEBUG) === '1';
  } catch {
    return false;
  }
}

function escapeControlByte(code: number): string | null {
  if (code === 0x0d) return '\\r';
  if (code === 0x0a) return '\\n';
  if (code === 0x09) return '\\t';
  if (
    (code >= 0x00 && code <= 0x08)
    || code === 0x0b
    || code === 0x0c
    || (code >= 0x0e && code <= 0x1f)
    || (code >= 0x7f && code <= 0x9f)
  ) {
    return `\\x${code.toString(16).padStart(2, '0')}`;
  }
  return null;
}

/** Visible printable preview for DevTools (escapes control bytes). */
export function previewTerminalBytes(text: string, maxLen = 160): string {
  if (!text) return '(empty)';
  let escaped = '';
  for (const char of text) {
    const code = char.charCodeAt(0);
    const control = escapeControlByte(code);
    escaped += control ?? char;
  }
  if (escaped.length <= maxLen) return escaped;
  return `${escaped.slice(0, maxLen)}…(+${escaped.length - maxLen})`;
}

export type OutputTriggerSkipReason =
  | 'not-script-kind'
  | 'wrong-trigger'
  | 'missing-triggerPattern'
  | 'missing-id'
  | 'host-scope-mismatch'
  | 'eligible';

export function getOutputTriggerSkipReason(
  snippet: Snippet,
  hostId?: string,
): OutputTriggerSkipReason {
  if (!isScriptSnippet(snippet)) return 'not-script-kind';
  if (snippet.trigger !== 'onOutput') return 'wrong-trigger';
  if (!snippet.triggerPattern) return 'missing-triggerPattern';
  if (!snippet.id) return 'missing-id';
  if (!snippetAppliesToOutputTrigger(snippet, hostId)) return 'host-scope-mismatch';
  return 'eligible';
}

export function traceOutputTrigger(event: string, data?: Record<string, unknown>): void {
  if (!isOutputTriggerDebugEnabled()) return;
  // console.debug is hidden unless DevTools level is Verbose — use info so logs are visible by default.
  if (data && Object.keys(data).length > 0) {
    console.info(LOG_PREFIX, event, data);
    return;
  }
  console.info(LOG_PREFIX, event);
}

export function summarizeOnOutputSnippets(snippets: Snippet[], hostId?: string) {
  return snippets
    .filter((snippet) => snippet.trigger === 'onOutput' || isScriptSnippet(snippet))
    .map((snippet) => ({
      id: snippet.id,
      label: snippet.label,
      kind: snippet.kind ?? 'snippet',
      trigger: snippet.trigger ?? 'manual',
      triggerPattern: snippet.triggerPattern,
      targetsAllHosts: snippet.targetsAllHosts ?? false,
      targetCount: snippet.targets?.length ?? 0,
      skipReason: getOutputTriggerSkipReason(snippet, hostId),
    }));
}
