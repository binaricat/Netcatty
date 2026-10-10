import { useEffect, useMemo } from 'react';
import {
  createSessionHistorySearch,
  type SessionHistorySearch,
} from './sessionHistorySearch';

/**
 * Owns one search instance per mounted session history drawer.
 *
 * The search index cache is bound to this instance (not module scope), so
 * several concurrently mounted drawers — one per terminal tab — each keep
 * their own indexes: pruning in one drawer never drops another drawer's
 * entries, and the unmount below releases only this drawer's store instead of
 * discarding the shared cache for every drawer. Cache keys are the session
 * objects themselves, so clearing on unmount drops all strong session
 * references together with the retained haystack characters.
 */
export function useSessionHistorySearch(): SessionHistorySearch {
  const search = useMemo(() => createSessionHistorySearch(), []);
  useEffect(() => () => {
    search.clearSessionHistorySearchCache();
  }, [search]);
  return search;
}
