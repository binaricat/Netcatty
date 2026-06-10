import { useCallback, useRef, useState } from 'react';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
import {
  mergeRemoteHistory,
  parseBashHistory,
  parseFishHistory,
  parseZshHistory,
} from '../../domain/remoteHistory';
import type { RemoteHistoryEntry } from '../../domain/models';

export interface RemoteHistoryHostState {
  entries: RemoteHistoryEntry[];
  loading: boolean;
  error: string | null;
  fetchedAt: number | null;
}

const EMPTY_STATE: RemoteHistoryHostState = {
  entries: [],
  loading: false,
  error: null,
  fetchedAt: null,
};

export interface UseRemoteHistoryState {
  getState: (hostId: string | null | undefined) => RemoteHistoryHostState;
  fetch: (sessionId: string, hostId: string) => Promise<void>;
  clear: (hostId: string) => void;
}

/**
 * Owns per-host remote shell history state. Fetches the remote host's shell
 * history via the SSH bridge — which detects the login shell and returns only
 * the matching file(s) — parses and de-dupes them, and keeps an in-memory
 * cache keyed by hostId. The cache is intentionally not persisted — history
 * files can contain sensitive content, so we re-fetch each time the panel is
 * opened for a host without cached data.
 */
export function useRemoteHistoryState(): UseRemoteHistoryState {
  const [byHost, setByHost] = useState<Record<string, RemoteHistoryHostState>>({});
  // Track the latest request per host so stale responses (e.g., rapid refresh
  // clicks) can't overwrite the current one.
  const requestIdByHost = useRef<Record<string, number>>({});

  const getState = useCallback(
    (hostId: string | null | undefined): RemoteHistoryHostState => {
      if (!hostId) return EMPTY_STATE;
      return byHost[hostId] ?? EMPTY_STATE;
    },
    [byHost],
  );

  const fetch = useCallback(async (sessionId: string, hostId: string) => {
    if (!sessionId || !hostId) return;
    const bridge = netcattyBridge.get();
    if (!bridge?.readRemoteHistory) {
      setByHost((prev) => ({
        ...prev,
        [hostId]: {
          entries: prev[hostId]?.entries ?? [],
          loading: false,
          error: 'Remote history is not available in this build.',
          fetchedAt: prev[hostId]?.fetchedAt ?? null,
        },
      }));
      return;
    }

    const reqId = (requestIdByHost.current[hostId] ?? 0) + 1;
    requestIdByHost.current[hostId] = reqId;

    setByHost((prev) => ({
      ...prev,
      [hostId]: {
        entries: prev[hostId]?.entries ?? [],
        loading: true,
        error: null,
        fetchedAt: prev[hostId]?.fetchedAt ?? null,
      },
    }));

    try {
      const result = await bridge.readRemoteHistory(sessionId, 1000);
      if (requestIdByHost.current[hostId] !== reqId) return; // stale

      if (!result?.success) {
        setByHost((prev) => ({
          ...prev,
          [hostId]: {
            entries: prev[hostId]?.entries ?? [],
            loading: false,
            error: result?.error || 'Failed to read remote history',
            fetchedAt: prev[hostId]?.fetchedAt ?? null,
          },
        }));
        return;
      }

      // The bridge detects the remote login shell and reports which file(s) it
      // read. Parse only the matching one; fall back to merging all of them
      // when the shell couldn't be determined.
      const lists: RemoteHistoryEntry[][] = [];
      if (result.shell === 'bash') {
        lists.push(parseBashHistory(result.bash ?? ''));
      } else if (result.shell === 'zsh') {
        lists.push(parseZshHistory(result.zsh ?? ''));
      } else if (result.shell === 'fish') {
        lists.push(parseFishHistory(result.fish ?? ''));
      } else {
        lists.push(parseBashHistory(result.bash ?? ''));
        lists.push(parseZshHistory(result.zsh ?? ''));
        lists.push(parseFishHistory(result.fish ?? ''));
      }
      const merged = mergeRemoteHistory(lists);

      setByHost((prev) => ({
        ...prev,
        [hostId]: {
          entries: merged,
          loading: false,
          error: null,
          fetchedAt: Date.now(),
        },
      }));
    } catch (err) {
      if (requestIdByHost.current[hostId] !== reqId) return; // stale
      setByHost((prev) => ({
        ...prev,
        [hostId]: {
          entries: prev[hostId]?.entries ?? [],
          loading: false,
          error: err instanceof Error ? err.message : String(err),
          fetchedAt: prev[hostId]?.fetchedAt ?? null,
        },
      }));
    }
  }, []);

  const clear = useCallback((hostId: string) => {
    requestIdByHost.current[hostId] = (requestIdByHost.current[hostId] ?? 0) + 1;
    setByHost((prev) => {
      if (!(hostId in prev)) return prev;
      const next = { ...prev };
      delete next[hostId];
      return next;
    });
  }, []);

  return { getState, fetch, clear };
}
