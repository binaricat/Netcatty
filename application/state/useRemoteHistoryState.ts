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

const PENDING_RETRY_MS = 1500;
const PENDING_MAX_RETRIES = 12;

export interface UseRemoteHistoryState {
  getState: (
    hostId: string | null | undefined,
    sessionId?: string | null,
  ) => RemoteHistoryHostState;
  fetch: (sessionId: string, hostId: string) => Promise<void>;
  clear: (hostId: string, sessionId?: string | null) => void;
}

function cacheKey(hostId: string, sessionId: string): string {
  return `${hostId}\0${sessionId}`;
}

/**
 * Owns per-session remote shell history state. Fetches the remote host's shell
 * history via the SSH bridge — which detects the login shell and returns only
 * the matching file(s) — parses and de-dupes them, and keeps an in-memory
 * cache keyed by (hostId, sessionId). The cache is intentionally not persisted
 * — history files can contain sensitive content.
 */
export function useRemoteHistoryState(): UseRemoteHistoryState {
  const [byKey, setByKey] = useState<Record<string, RemoteHistoryHostState>>({});
  const requestIdByKey = useRef<Record<string, number>>({});

  const getState = useCallback(
    (
      hostId: string | null | undefined,
      sessionId?: string | null,
    ): RemoteHistoryHostState => {
      if (!hostId || !sessionId) return EMPTY_STATE;
      return byKey[cacheKey(hostId, sessionId)] ?? EMPTY_STATE;
    },
    [byKey],
  );

  const fetch = useCallback(async (sessionId: string, hostId: string) => {
    if (!sessionId || !hostId) return;
    const key = cacheKey(hostId, sessionId);
    const bridge = netcattyBridge.get();
    if (!bridge?.readRemoteHistory) {
      setByKey((prev) => ({
        ...prev,
        [key]: {
          entries: prev[key]?.entries ?? [],
          loading: false,
          error: 'Remote history is not available in this build.',
          fetchedAt: prev[key]?.fetchedAt ?? null,
        },
      }));
      return;
    }

    const reqId = (requestIdByKey.current[key] ?? 0) + 1;
    requestIdByKey.current[key] = reqId;

    setByKey((prev) => ({
      ...prev,
      [key]: {
        entries: prev[key]?.entries ?? [],
        loading: true,
        error: null,
        fetchedAt: prev[key]?.fetchedAt ?? null,
      },
    }));

    const isStale = () => requestIdByKey.current[key] !== reqId;

    try {
      for (let attempt = 0; attempt <= PENDING_MAX_RETRIES; attempt += 1) {
        const result = await bridge.readRemoteHistory(sessionId, 1000);
        if (isStale()) return;

        if (!result?.success) {
          if (result?.pending && attempt < PENDING_MAX_RETRIES) {
            await new Promise((resolve) => {
              window.setTimeout(resolve, PENDING_RETRY_MS);
            });
            if (isStale()) return;
            continue;
          }

          setByKey((prev) => ({
            ...prev,
            [key]: {
              entries: prev[key]?.entries ?? [],
              loading: false,
              error: result?.pending
                ? 'Remote history is not ready yet. Try again shortly.'
                : (result?.error || 'Failed to read remote history'),
              fetchedAt: prev[key]?.fetchedAt ?? null,
            },
          }));
          return;
        }

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

        setByKey((prev) => ({
          ...prev,
          [key]: {
            entries: merged,
            loading: false,
            error: null,
            fetchedAt: Date.now(),
          },
        }));
        return;
      }
    } catch (err) {
      if (isStale()) return;
      setByKey((prev) => ({
        ...prev,
        [key]: {
          entries: prev[key]?.entries ?? [],
          loading: false,
          error: err instanceof Error ? err.message : String(err),
          fetchedAt: prev[key]?.fetchedAt ?? null,
        },
      }));
    }
  }, []);

  const clear = useCallback((hostId: string, sessionId?: string | null) => {
    const key = sessionId ? cacheKey(hostId, sessionId) : hostId;
    requestIdByKey.current[key] = (requestIdByKey.current[key] ?? 0) + 1;
    setByKey((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  return { getState, fetch, clear };
}
