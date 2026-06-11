import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../../application/i18n/I18nProvider';
import type { I18nContextValue } from '../../../application/i18n/I18nProvider';
import { sessionCapabilitiesStore } from '../../../application/state/sessionCapabilitiesStore';
import type { SessionCapabilities } from '../../../domain/systemManager/types';
import type { useSystemManagerBackend } from '../../../application/state/useSystemManagerBackend';
import { nextPollData } from '../listStable';

type Backend = ReturnType<typeof useSystemManagerBackend>;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function normalizePollingErrorMessage(error: unknown, t: I18nContextValue['t']): string {
  const message = error instanceof Error ? error.message : String(error || 'Unknown error');
  const lower = message.toLowerCase();
  if (lower.includes('channel open failure') || lower.includes('unable to exec')) {
    return t('systemManager.errors.sshChannelUnavailable');
  }
  return message;
}

/** Stable i18n ref so polling fetchers do not reset when locale re-renders. */
export function useStableTranslate(): I18nContextValue['t'] {
  const { t } = useI18n();
  const tRef = useRef(t);
  tRef.current = t;
  return useCallback(
    (key, values) => tRef.current(key, values),
    [],
  );
}

export function useSessionCapabilities(
  sessionId: string | null,
  isConnected: boolean,
  backend: Backend,
  enabled: boolean,
) {
  const [capabilities, setCapabilities] = useState<SessionCapabilities | undefined>(
    () => (sessionId ? sessionCapabilitiesStore.get(sessionId) : undefined),
  );
  const [probing, setProbing] = useState(false);

  useEffect(() => {
    if (!sessionId) return undefined;
    return sessionCapabilitiesStore.subscribe(sessionId, () => {
      setCapabilities(sessionCapabilitiesStore.get(sessionId));
    });
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || isConnected) return undefined;
    sessionCapabilitiesStore.delete(sessionId);
    return undefined;
  }, [sessionId, isConnected]);

  const probe = useCallback(async (force = false) => {
    if (!sessionId || !isConnected) return;
    if (!force && sessionCapabilitiesStore.get(sessionId)) return;
    setProbing(true);
    try {
      const result = await backend.probeSystemCapabilities(sessionId);
      if (result.success && result.capabilities) {
        sessionCapabilitiesStore.set(sessionId, result.capabilities);
      }
    } finally {
      setProbing(false);
    }
  }, [backend, isConnected, sessionId]);

  useEffect(() => {
    if (!sessionId || !isConnected || !enabled) return undefined;
    void probe();
    return undefined;
  }, [enabled, sessionId, isConnected, probe]);

  return { capabilities, probing, refreshCapabilities: () => probe(true) };
}

/** Prefetch capabilities only for the given session ids (e.g. when System panel opens). */
export function useSystemCapabilitiesWarmup(
  sessionIds: string[],
  backend: Backend,
  enabled: boolean,
) {
  const backendRef = useRef(backend);
  backendRef.current = backend;
  const inflightRef = useRef(new Set<string>());

  const sessionKey = enabled ? sessionIds.slice().sort().join(',') : '';

  useEffect(() => {
    if (!sessionKey) return undefined;
    for (const sessionId of sessionKey.split(',')) {
      if (!sessionId || sessionCapabilitiesStore.get(sessionId)) continue;
      if (inflightRef.current.has(sessionId)) continue;
      inflightRef.current.add(sessionId);
      void backendRef.current.probeSystemCapabilities(sessionId).then((result) => {
        inflightRef.current.delete(sessionId);
        if (result.success && result.capabilities) {
          sessionCapabilitiesStore.set(sessionId, result.capabilities);
        }
      });
    }
    return undefined;
  }, [sessionKey]);
}

export function usePolling<T>(
  fetcher: () => Promise<T | null>,
  intervalMs: number,
  enabled: boolean,
  merge?: (prev: T | null, next: T) => T,
) {
  const stableT = useStableTranslate();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const failuresRef = useRef(0);
  const hasDataRef = useRef(false);
  const inflightRef = useRef(false);
  const fetcherRef = useRef(fetcher);
  const mergeRef = useRef(merge);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  fetcherRef.current = fetcher;
  mergeRef.current = merge;

  const clearPollTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const pollDelayMs = useCallback(() => {
    if (failuresRef.current >= 3) return intervalMs * 4;
    return intervalMs;
  }, [intervalMs]);

  const run = useCallback(async (options?: { withLoading?: boolean; minLoadingMs?: number }) => {
    if (!enabled || inflightRef.current) return;
    inflightRef.current = true;
    const showLoading = options?.withLoading ?? !hasDataRef.current;
    const startedAt = Date.now();
    if (showLoading) setLoading(true);
    try {
      const result = await fetcherRef.current();
      if (result !== null) {
        setData((prev) => {
          const mergeFn = mergeRef.current;
          const next = mergeFn ? mergeFn(prev, result) : nextPollData(prev, result);
          if (next !== prev) hasDataRef.current = true;
          return next;
        });
        setError(null);
        failuresRef.current = 0;
      }
    } catch (err) {
      failuresRef.current += 1;
      setData(null);
      hasDataRef.current = false;
      setError(normalizePollingErrorMessage(err, stableT));
    } finally {
      inflightRef.current = false;
      if (showLoading) {
        const remaining = Math.max(0, (options?.minLoadingMs ?? 0) - (Date.now() - startedAt));
        if (remaining > 0) await delay(remaining);
        setLoading(false);
      }
    }
  }, [enabled, stableT]);

  const scheduleNextPoll = useCallback(() => {
    clearPollTimer();
    if (!enabled) return;
    timerRef.current = setTimeout(() => {
      void run({ withLoading: false }).finally(() => {
        scheduleNextPoll();
      });
    }, pollDelayMs());
  }, [clearPollTimer, enabled, pollDelayMs, run]);

  useEffect(() => {
    if (!enabled) {
      clearPollTimer();
      setData(null);
      setError(null);
      failuresRef.current = 0;
      hasDataRef.current = false;
      return undefined;
    }
    void run({ withLoading: true }).finally(() => {
      scheduleNextPoll();
    });
    return () => {
      clearPollTimer();
    };
  }, [clearPollTimer, enabled, intervalMs, run, scheduleNextPoll]);

  const refresh = useCallback(async () => {
    failuresRef.current = 0;
    await run({ withLoading: true, minLoadingMs: 450 });
  }, [run]);

  return { data, error, loading, refresh };
}
