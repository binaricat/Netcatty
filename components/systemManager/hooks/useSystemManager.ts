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
  capabilitiesTtlMs: number,
) {
  const ttlMsRef = useRef(capabilitiesTtlMs);
  ttlMsRef.current = capabilitiesTtlMs;

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
        sessionCapabilitiesStore.set(sessionId, result.capabilities, ttlMsRef.current);
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
  capabilitiesTtlMs: number,
) {
  const backendRef = useRef(backend);
  backendRef.current = backend;
  const inflightRef = useRef(new Set<string>());
  const ttlMsRef = useRef(capabilitiesTtlMs);
  ttlMsRef.current = capabilitiesTtlMs;

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
          sessionCapabilitiesStore.set(sessionId, result.capabilities, ttlMsRef.current);
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
  options?: { poll?: boolean; resetKey?: string },
) {
  const stableT = useStableTranslate();
  const resetKey = options?.resetKey ?? '';
  const [data, setData] = useState<T | null>(null);
  const [dataKey, setDataKey] = useState(resetKey);
  const [error, setError] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState(resetKey);
  const [loading, setLoading] = useState(false);
  const [loadingKey, setLoadingKey] = useState(resetKey);
  const failuresRef = useRef(0);
  const hasDataRef = useRef(false);
  const enabledRef = useRef(enabled);
  const generationRef = useRef(0);
  const runIdRef = useRef(0);
  const loadingRunIdRef = useRef(0);
  const inflightRef = useRef<{ generation: number; runId: number } | null>(null);
  const queuedRunRef = useRef<{
    options?: { withLoading?: boolean; minLoadingMs?: number };
    resolve: () => void;
  } | null>(null);
  const fetcherRef = useRef(fetcher);
  const mergeRef = useRef(merge);
  const pollRef = useRef(options?.poll ?? true);
  const resetKeyRef = useRef(resetKey);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  enabledRef.current = enabled;
  fetcherRef.current = fetcher;
  mergeRef.current = merge;
  pollRef.current = options?.poll ?? true;

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

  const resolveQueuedRun = useCallback(() => {
    queuedRunRef.current?.resolve();
    queuedRunRef.current = null;
  }, []);

  const run = useCallback(async (options?: { withLoading?: boolean; minLoadingMs?: number }) => {
    const generation = generationRef.current;
    const runResetKey = resetKeyRef.current;
    if (!enabledRef.current) return;
    if (inflightRef.current?.generation === generation) {
      if (options?.withLoading) {
        queuedRunRef.current?.resolve();
        loadingRunIdRef.current = 0;
        setLoadingKey(runResetKey);
        setLoading(true);
        return new Promise<void>((resolve) => {
          queuedRunRef.current = { options, resolve };
        });
      }
      return;
    }
    const runId = ++runIdRef.current;
    inflightRef.current = { generation, runId };
    const showLoading = options?.withLoading ?? !hasDataRef.current;
    const startedAt = Date.now();
    const isCurrent = () => (
      generationRef.current === generation
      && enabledRef.current
      && inflightRef.current?.runId === runId
      && resetKeyRef.current === runResetKey
    );
    if (showLoading) {
      loadingRunIdRef.current = runId;
      setLoadingKey(runResetKey);
      setLoading(true);
    }
    try {
      const result = await fetcherRef.current();
      if (!isCurrent()) return;
      if (result !== null) {
        setDataKey(runResetKey);
        setData((prev) => {
          const mergeFn = mergeRef.current;
          const next = mergeFn ? mergeFn(prev, result) : nextPollData(prev, result);
          if (next !== prev) hasDataRef.current = true;
          return next;
        });
        setErrorKey(runResetKey);
        setError(null);
        failuresRef.current = 0;
      }
    } catch (err) {
      if (!isCurrent()) return;
      failuresRef.current += 1;
      setDataKey(runResetKey);
      setData(null);
      hasDataRef.current = false;
      setErrorKey(runResetKey);
      setError(normalizePollingErrorMessage(err, stableT));
    } finally {
      if (inflightRef.current?.runId === runId) {
        inflightRef.current = null;
      }
      if (showLoading) {
        const remaining = Math.max(0, (options?.minLoadingMs ?? 0) - (Date.now() - startedAt));
        if (remaining > 0) await delay(remaining);
        if (
          generationRef.current === generation
          && enabledRef.current
          && resetKeyRef.current === runResetKey
          && loadingRunIdRef.current === runId
        ) {
          loadingRunIdRef.current = 0;
          setLoadingKey(runResetKey);
          setLoading(false);
        }
      }
      const queued = queuedRunRef.current;
      if (
        queued
        && generationRef.current === generation
        && enabledRef.current
        && resetKeyRef.current === runResetKey
      ) {
        queuedRunRef.current = null;
        await run(queued.options);
        queued.resolve();
      }
    }
  }, [stableT]);

  const scheduleNextPoll = useCallback(() => {
    clearPollTimer();
    if (!enabledRef.current || !pollRef.current) return;
    const generation = generationRef.current;
    timerRef.current = setTimeout(() => {
      void run({ withLoading: false }).finally(() => {
        if (generationRef.current === generation) {
          scheduleNextPoll();
        }
      });
    }, pollDelayMs());
  }, [clearPollTimer, pollDelayMs, run]);

  useEffect(() => {
    const resetChanged = resetKeyRef.current !== resetKey;
    resetKeyRef.current = resetKey;
    generationRef.current += 1;
    inflightRef.current = null;
    clearPollTimer();
    if (!enabled) {
      resolveQueuedRun();
      loadingRunIdRef.current = 0;
      setLoading(false);
      setLoadingKey(resetKey);
      setDataKey(resetKey);
      setData(null);
      setErrorKey(resetKey);
      setError(null);
      failuresRef.current = 0;
      hasDataRef.current = false;
      return undefined;
    }
    if (resetChanged) {
      resolveQueuedRun();
      loadingRunIdRef.current = 0;
      setLoading(false);
      setLoadingKey(resetKey);
      setDataKey(resetKey);
      setData(null);
      setErrorKey(resetKey);
      setError(null);
      failuresRef.current = 0;
      hasDataRef.current = false;
    }
    const generation = generationRef.current;
    void run({ withLoading: true }).finally(() => {
      if (generationRef.current === generation && pollRef.current) scheduleNextPoll();
    });
    return () => {
      generationRef.current += 1;
      resolveQueuedRun();
      loadingRunIdRef.current = 0;
      inflightRef.current = null;
      clearPollTimer();
    };
  }, [clearPollTimer, enabled, intervalMs, options?.poll, resetKey, resolveQueuedRun, run, scheduleNextPoll]);

  const refresh = useCallback(async () => {
    failuresRef.current = 0;
    await run({ withLoading: true, minLoadingMs: 450 });
  }, [run]);

  return {
    data: dataKey === resetKey ? data : null,
    error: errorKey === resetKey ? error : null,
    loading: loadingKey === resetKey ? loading : enabled,
    refresh,
  };
}
