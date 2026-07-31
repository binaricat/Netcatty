/** Max persisted compose-bar send history entries (oldest dropped). */
export const COMPOSE_BAR_HISTORY_MAX = 100;

export type ComposeBarHistoryDirection = 'up' | 'down';

export interface ComposeBarHistoryNavInput {
  entries: readonly string[];
  /** `entries.length` means the live draft; `0..length-1` browses history. */
  index: number;
  draft: string;
  currentValue: string;
}

export interface ComposeBarHistoryNavResult {
  index: number;
  value: string;
  draft: string;
}

/** Keep only non-empty string history rows (for storage load / sanitize). */
export function normalizeComposeBarHistory(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => (
    typeof entry === 'string' && entry.length > 0 && entry.trim().length > 0
  ));
}

/**
 * Append a sent compose-bar command. Skips empties, consecutive duplicates,
 * and trims the ring to {@link COMPOSE_BAR_HISTORY_MAX}.
 */
export function appendComposeBarHistory(
  entries: readonly string[],
  command: string,
  max = COMPOSE_BAR_HISTORY_MAX,
): string[] {
  if (!command || !command.trim()) return [...entries];
  if (entries[entries.length - 1] === command) return [...entries];
  return [...entries, command].slice(-Math.max(1, max));
}

/** True when Up/Down should recall history instead of moving within the textarea. */
export function canNavigateComposeBarHistory(
  value: string,
  selectionStart: number,
  direction: ComposeBarHistoryDirection,
  selectionEnd = selectionStart,
): boolean {
  if (selectionStart !== selectionEnd) return false;
  const cursor = Math.max(0, Math.min(selectionStart, value.length));
  if (direction === 'up') {
    return !value.slice(0, cursor).includes('\n');
  }
  return !value.slice(cursor).includes('\n');
}

/**
 * Shell-style history walk for the compose bar: Up goes older, Down goes newer,
 * and moving past the newest entry restores the saved draft.
 */
export function navigateComposeBarHistory(
  state: ComposeBarHistoryNavInput,
  direction: ComposeBarHistoryDirection,
): ComposeBarHistoryNavResult | null {
  const { entries } = state;
  if (entries.length === 0) return null;

  const liveIndex = entries.length;
  let index = Number.isFinite(state.index) ? state.index : liveIndex;
  if (index < 0) index = 0;
  if (index > liveIndex) index = liveIndex;

  if (direction === 'up') {
    if (index <= 0) return null;
    const draft = index === liveIndex ? state.currentValue : state.draft;
    const nextIndex = index - 1;
    return { index: nextIndex, value: entries[nextIndex] ?? '', draft };
  }

  if (index >= liveIndex) return null;
  const nextIndex = index + 1;
  if (nextIndex >= liveIndex) {
    return { index: liveIndex, value: state.draft, draft: state.draft };
  }
  return { index: nextIndex, value: entries[nextIndex] ?? '', draft: state.draft };
}
