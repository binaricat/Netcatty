import { useCallback, useEffect, useRef, useState } from 'react';
import {
  arePinnedSnippetIdsEqual,
  normalizePinnedSnippetIds,
  reorderPinnedSnippetIds,
  type PinnedSnippetDropPosition,
} from '../../domain/composeBarPinnedSnippets';
import { STORAGE_KEY_COMPOSE_BAR_PINNED_SNIPPETS } from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';

const COMPOSE_BAR_PINNED_SNIPPETS_CHANGE_EVENT = 'netcatty-compose-bar-pinned-snippets-change';

interface PinnedState {
  pinnedIds: string[];
  /** True when the user has never saved pins (localStorage key absent). */
  neverSaved: boolean;
  /** True when this state transition should be written to storage and broadcast. */
  persist: boolean;
}

function readPinnedState(): PinnedState {
  const stored = localStorageAdapter.read<string[]>(STORAGE_KEY_COMPOSE_BAR_PINNED_SNIPPETS);
  if (stored === null) {
    return { pinnedIds: [], neverSaved: true, persist: false };
  }
  return {
    pinnedIds: Array.isArray(stored) ? normalizePinnedSnippetIds(stored) : [],
    neverSaved: false,
    persist: false,
  };
}

function parseSnippetIdKey(snippetIdKey?: string): Set<string> | null {
  if (!snippetIdKey) return null;
  const ids = snippetIdKey.split('\0').filter(Boolean);
  if (ids.length === 0) return null;
  return new Set(ids);
}

/**
 * Persisted snippet IDs shown on the terminal compose bar quick strip.
 * Pass a stable `snippetIdKey` (`ids.join('\\0')`) to prune pins for deleted snippets.
 * On first run, `defaultSeedIds` are written once when pins were never saved.
 */
export function useComposeBarPinnedSnippets(
  snippetIdKey?: string,
  defaultSeedIds?: readonly string[],
) {
  const [{ pinnedIds, neverSaved, persist }, setPinnedState] = useState(readPinnedState);
  const needsSeedRef = useRef(neverSaved);

  const setPinnedIds = useCallback((updater: string[] | ((prev: string[]) => string[])) => {
    setPinnedState((prev) => {
      const nextIds = normalizePinnedSnippetIds(
        typeof updater === 'function' ? updater(prev.pinnedIds) : updater,
      );
      if (arePinnedSnippetIdsEqual(prev.pinnedIds, nextIds)) {
        return prev;
      }
      needsSeedRef.current = false;
      return { pinnedIds: nextIds, neverSaved: false, persist: true };
    });
  }, []);

  useEffect(() => {
    if (!persist) return;
    localStorageAdapter.write(STORAGE_KEY_COMPOSE_BAR_PINNED_SNIPPETS, pinnedIds);
    if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent(COMPOSE_BAR_PINNED_SNIPPETS_CHANGE_EVENT, {
          detail: { pinnedIds },
        }),
      );
    }
  }, [pinnedIds, persist]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const applyExternalIds = (incoming: readonly unknown[]) => {
      const nextIds = normalizePinnedSnippetIds(incoming);
      needsSeedRef.current = false;
      setPinnedState((prev) => {
        if (!prev.neverSaved && arePinnedSnippetIdsEqual(prev.pinnedIds, nextIds)) {
          return prev;
        }
        return { pinnedIds: nextIds, neverSaved: false, persist: false };
      });
    };

    const handleCustom = (event: Event) => {
      const detail = (event as CustomEvent<{ pinnedIds?: unknown[] }>).detail;
      if (!Array.isArray(detail?.pinnedIds)) return;
      applyExternalIds(detail.pinnedIds);
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY_COMPOSE_BAR_PINNED_SNIPPETS) return;
      const stored = localStorageAdapter.read<string[]>(STORAGE_KEY_COMPOSE_BAR_PINNED_SNIPPETS);
      applyExternalIds(Array.isArray(stored) ? stored : []);
    };

    window.addEventListener(COMPOSE_BAR_PINNED_SNIPPETS_CHANGE_EVENT, handleCustom);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener(COMPOSE_BAR_PINNED_SNIPPETS_CHANGE_EVENT, handleCustom);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  useEffect(() => {
    if (!needsSeedRef.current) return;

    const seed = normalizePinnedSnippetIds(defaultSeedIds ?? []).slice(0, 4);
    if (seed.length === 0) return;

    const applySeed = () => {
      if (!needsSeedRef.current) return;
      needsSeedRef.current = false;
      setPinnedState({ pinnedIds: [...seed], neverSaved: false, persist: true });
    };

    const isBuiltinSeed = seed.every((id) => id.startsWith('__compose_builtin_'));
    if (!isBuiltinSeed) {
      applySeed();
      return;
    }

    // Brief delay so vault snippets can load before falling back to built-ins.
    const timer = setTimeout(applySeed, 300);
    return () => clearTimeout(timer);
  }, [defaultSeedIds]);

  useEffect(() => {
    const valid = parseSnippetIdKey(snippetIdKey);
    if (!valid) return;
    setPinnedIds((prev) => {
      const next = prev.filter((id) => valid.has(id) || id.startsWith('__compose_builtin_'));
      return next.length === prev.length ? prev : next;
    });
  }, [snippetIdKey, setPinnedIds]);

  const pin = useCallback((id: string) => {
    setPinnedIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, [setPinnedIds]);

  const unpin = useCallback((id: string) => {
    setPinnedIds((prev) => prev.filter((x) => x !== id));
  }, [setPinnedIds]);

  const toggle = useCallback((id: string) => {
    setPinnedIds((prev) => (
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    ));
  }, [setPinnedIds]);

  const reorder = useCallback(
    (draggedId: string, targetId: string, position?: PinnedSnippetDropPosition) => {
      setPinnedIds((prev) => reorderPinnedSnippetIds(prev, draggedId, targetId, position));
    },
    [setPinnedIds],
  );

  const isPinned = useCallback((id: string) => pinnedIds.includes(id), [pinnedIds]);

  return { pinnedIds, pin, unpin, toggle, reorder, isPinned };
}
