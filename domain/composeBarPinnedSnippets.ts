export type PinnedSnippetDropPosition = 'before' | 'after';

export function normalizePinnedSnippetIds(ids: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }
  return normalized;
}

export function arePinnedSnippetIdsEqual(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Reorder a pinned snippet ID relative to a target ID.
 * Returns a copy of the normalized input unchanged when either ID is unknown
 * or identical, so deleted/stale drag payloads never corrupt pinned order.
 */
export function reorderPinnedSnippetIds(
  currentIds: readonly string[],
  draggedId: string,
  targetId: string,
  position?: PinnedSnippetDropPosition,
): string[] {
  const normalized = normalizePinnedSnippetIds(currentIds);
  if (!draggedId || !targetId || draggedId === targetId) {
    return normalized;
  }

  const fromIndex = normalized.indexOf(draggedId);
  const originalTargetIndex = normalized.indexOf(targetId);
  if (fromIndex === -1 || originalTargetIndex === -1) {
    return normalized;
  }

  const effectivePosition: PinnedSnippetDropPosition =
    position ?? (fromIndex < originalTargetIndex ? 'after' : 'before');

  const withoutDragged = normalized.filter((id) => id !== draggedId);
  const targetIndex = withoutDragged.indexOf(targetId);
  if (targetIndex === -1) {
    return normalized;
  }

  const insertIndex = effectivePosition === 'before' ? targetIndex : targetIndex + 1;
  return [
    ...withoutDragged.slice(0, insertIndex),
    draggedId,
    ...withoutDragged.slice(insertIndex),
  ];
}
