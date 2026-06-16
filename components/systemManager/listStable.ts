import { useMemo, useRef } from 'react';

function pollSnapshotEqual<T>(prev: T | null, next: T): boolean {
  if (prev === next) return true;
  if (prev === null) return false;
  try {
    return JSON.stringify(prev) === JSON.stringify(next);
  } catch {
    return false;
  }
}

function itemSnapshotEqual<T>(a: T, b: T): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** Skip React state updates when polled payload is unchanged. */
export function nextPollData<T>(prev: T | null, next: T): T {
  return pollSnapshotEqual(prev, next) ? prev as T : next;
}

/**
 * Merge polled list rows by key, reusing previous item references when unchanged.
 * Keeps React.memo row components from re-rendering when other rows update.
 */
export function mergePollListByKey<T, K extends string | number>(
  prev: T[] | null,
  next: T[],
  getKey: (item: T) => K,
  isEqual: (a: T, b: T) => boolean = itemSnapshotEqual,
): T[] {
  if (prev === null) return next;
  if (prev.length !== next.length) return next;

  const nextByKey = new Map(next.map((item) => [getKey(item), item]));
  if (prev.some((item) => !nextByKey.has(getKey(item)))) return next;
  if (next.some((item) => !prev.some((p) => getKey(p) === getKey(item)))) return next;

  let changed = false;
  const merged = prev.map((oldItem) => {
    const newItem = nextByKey.get(getKey(oldItem))!;
    if (isEqual(oldItem, newItem)) return oldItem;
    changed = true;
    return newItem;
  });
  return changed ? merged : prev;
}

/**
 * Keep list row order stable across poll refreshes.
 * Re-sorts only when sortToken changes (sort / filter / search), or when items are added/removed.
 */
export function useStableListOrder<T, K extends string | number>(
  items: T[],
  getKey: (item: T) => K,
  sortToken: string,
  compare: (a: T, b: T) => number,
): T[] {
  const orderRef = useRef<K[]>([]);
  const lastSortTokenRef = useRef('');
  const lastMembershipRef = useRef('');
  const outputRef = useRef<T[]>([]);

  return useMemo(() => {
    const byKey = new Map(items.map((item) => [getKey(item), item]));
    const membership = [...items.map(getKey)].sort().join('|');

    if (sortToken !== lastSortTokenRef.current || membership !== lastMembershipRef.current) {
      lastSortTokenRef.current = sortToken;
      lastMembershipRef.current = membership;
      orderRef.current = [...items].sort(compare).map(getKey);
    } else {
      const alive = new Set(items.map(getKey));
      orderRef.current = orderRef.current.filter((key) => alive.has(key));
      for (const item of items) {
        const key = getKey(item);
        if (!orderRef.current.includes(key)) {
          orderRef.current.push(key);
        }
      }
    }

    const nextOutput = orderRef.current
      .map((key) => byKey.get(key))
      .filter((item): item is T => item !== undefined);

    const prevOutput = outputRef.current;
    if (
      nextOutput.length === prevOutput.length
      && nextOutput.every((item, index) => item === prevOutput[index])
    ) {
      return prevOutput;
    }

    outputRef.current = nextOutput;
    return nextOutput;
  }, [items, sortToken, compare, getKey]);
}
