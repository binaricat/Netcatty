import type { Snippet } from '../../types';

export const COMPOSE_BAR_MIN_HEIGHT = 72;
export const COMPOSE_BAR_MAX_HEIGHT = 360;

export function clampComposeBarHeight(height: number): number {
  return Math.max(COMPOSE_BAR_MIN_HEIGHT, Math.min(COMPOSE_BAR_MAX_HEIGHT, height));
}

export function filterComposeBarSnippets(snippets: Snippet[], query: string): Snippet[] {
  const normalized = query.trim().toLowerCase();
  const filtered = normalized
    ? snippets.filter((snippet) => (
      snippet.label.toLowerCase().includes(normalized)
      || snippet.command.toLowerCase().includes(normalized)
      || (snippet.package?.toLowerCase().includes(normalized) ?? false)
    ))
    : snippets;
  return filtered.slice().sort((a, b) => a.label.localeCompare(b.label));
}

export function buildSnippetIdKey(snippetIds: readonly string[]): string {
  return snippetIds.join('\0');
}

/** Built-in quick commands shown until the user customizes the strip. */
export const COMPOSE_BAR_BUILTIN_SNIPPETS: Snippet[] = [
  { id: '__compose_builtin_ls', label: 'ls -la', command: 'ls -la' },
  { id: '__compose_builtin_df', label: 'df -h', command: 'df -h' },
  { id: '__compose_builtin_free', label: 'free -h', command: 'free -h' },
  { id: '__compose_builtin_pwd', label: 'pwd', command: 'pwd' },
];

export const COMPOSE_BAR_BUILTIN_SNIPPET_IDS = COMPOSE_BAR_BUILTIN_SNIPPETS.map((s) => s.id);

export const COMPOSE_BAR_DEFAULT_SEED_COUNT = 4;

export function resolveComposeBarDefaultSeedIds(snippets: Snippet[]): string[] {
  if (snippets.length > 0) {
    return filterComposeBarSnippets(snippets, '')
      .slice(0, COMPOSE_BAR_DEFAULT_SEED_COUNT)
      .map((snippet) => snippet.id);
  }
  return COMPOSE_BAR_BUILTIN_SNIPPET_IDS.slice(0, COMPOSE_BAR_DEFAULT_SEED_COUNT);
}

export function mergeComposeBarSnippetMap(snippets: Snippet[]): Map<string, Snippet> {
  const map = new Map<string, Snippet>();
  for (const builtin of COMPOSE_BAR_BUILTIN_SNIPPETS) {
    map.set(builtin.id, builtin);
  }
  for (const snippet of snippets) {
    map.set(snippet.id, snippet);
  }
  return map;
}
