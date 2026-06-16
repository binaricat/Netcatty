import { startTransition, useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncRecordState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  updatedAt: number | null;
}

type RecordMap<T> = Record<string, AsyncRecordState<T>>;

interface UseAsyncRecordCacheOptions<TItem, TValue> {
  items: TItem[];
  enabled: boolean;
  getKey: (item: TItem) => string;
  fetchRecord: (item: TItem) => Promise<TValue | null>;
  prefetchLimit?: number;
  prefetchDelayMs?: number;
  staleTimeMs?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function scheduleIdleTask(callback: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(callback, { timeout: 1200 });
    return () => window.cancelIdleCallback(id);
  }

  const id = window.setTimeout(callback, 80);
  return () => window.clearTimeout(id);
}

function normalizeRecordError(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'Unknown error');
}

function isRecordFresh<TValue>(record: AsyncRecordState<TValue> | undefined, staleTimeMs: number): boolean {
  if (!record || record.error || record.updatedAt === null) return false;
  if (!Number.isFinite(staleTimeMs)) return true;
  return Date.now() - record.updatedAt < staleTimeMs;
}

const EMPTY_RECORDS = {};

export function useAsyncRecordCache<TItem, TValue>({
  items,
  enabled,
  getKey,
  fetchRecord,
  prefetchLimit = 64,
  prefetchDelayMs = 16,
  staleTimeMs = 30_000,
}: UseAsyncRecordCacheOptions<TItem, TValue>) {
  const [records, setRecords] = useState<RecordMap<TValue>>(() => EMPTY_RECORDS);
  const recordsRef = useRef<RecordMap<TValue>>(records);
  const enabledRef = useRef(enabled);
  const inflightRef = useRef(new Set<string>());
  const requestVersionRef = useRef(new Map<string, number>());
  const queuedForceRef = useRef(new Set<string>());
  const loadRecordRef = useRef<(
    item: TItem,
    options?: { force?: boolean; urgent?: boolean },
  ) => Promise<void>>(async () => {});

  recordsRef.current = records;
  enabledRef.current = enabled;

  const commitRecords = useCallback((
    updater: (prev: RecordMap<TValue>) => RecordMap<TValue>,
    urgent = false,
  ) => {
    const apply = () => {
      setRecords((prev) => {
        const next = updater(prev);
        recordsRef.current = next;
        return next;
      });
    };

    if (urgent) {
      apply();
      return;
    }

    startTransition(apply);
  }, []);

  const loadRecord = useCallback(async (
    item: TItem,
    options?: { force?: boolean; urgent?: boolean },
  ) => {
    if (!enabledRef.current) return;
    const key = getKey(item);
    if (!key) return;
    if (inflightRef.current.has(key)) {
      if (options?.force) {
        queuedForceRef.current.add(key);
        requestVersionRef.current.set(key, (requestVersionRef.current.get(key) ?? 0) + 1);
      }
      return;
    }

    const existing = recordsRef.current[key];
    if (!options?.force && isRecordFresh(existing, staleTimeMs)) {
      return;
    }

    const requestVersion = (requestVersionRef.current.get(key) ?? 0) + 1;
    requestVersionRef.current.set(key, requestVersion);
    inflightRef.current.add(key);
    commitRecords((prev) => ({
      ...prev,
      [key]: {
        data: prev[key]?.data ?? null,
        loading: true,
        error: null,
        updatedAt: prev[key]?.updatedAt ?? null,
      },
    }), options?.urgent);

    try {
      const data = await fetchRecord(item);
      if (requestVersionRef.current.get(key) !== requestVersion) return;
      commitRecords((prev) => ({
        ...prev,
        [key]: {
          data,
          loading: false,
          error: null,
          updatedAt: Date.now(),
        },
      }));
    } catch (error) {
      if (requestVersionRef.current.get(key) !== requestVersion) return;
      commitRecords((prev) => ({
        ...prev,
        [key]: {
          data: prev[key]?.data ?? null,
          loading: false,
          error: normalizeRecordError(error),
          updatedAt: prev[key]?.updatedAt ?? null,
        },
      }));
    } finally {
      inflightRef.current.delete(key);
      if (queuedForceRef.current.has(key)) {
        if (enabledRef.current) {
          queuedForceRef.current.delete(key);
          void loadRecordRef.current(item, { force: true, urgent: options?.urgent });
        } else {
          commitRecords((prev) => {
            const current = prev[key];
            if (!current?.loading) return prev;
            return {
              ...prev,
              [key]: {
                ...current,
                loading: false,
              },
            };
          }, true);
        }
      }
    }
  }, [commitRecords, fetchRecord, getKey, staleTimeMs]);

  loadRecordRef.current = loadRecord;

  useEffect(() => {
    const itemKeys = new Set(items.map(getKey).filter(Boolean));
    for (const key of queuedForceRef.current) {
      if (!itemKeys.has(key)) {
        queuedForceRef.current.delete(key);
      }
    }
    commitRecords((prev) => {
      let changed = false;
      const next: RecordMap<TValue> = {};
      for (const [key, value] of Object.entries(prev) as Array<[string, AsyncRecordState<TValue>]>) {
        if (!itemKeys.has(key)) {
          changed = true;
          continue;
        }
        next[key] = value;
      }
      return changed ? next : prev;
    });
  }, [commitRecords, getKey, items]);

  useEffect(() => {
    if (!enabled || queuedForceRef.current.size === 0) return;
    for (const item of items) {
      const key = getKey(item);
      if (!key || !queuedForceRef.current.has(key)) continue;
      queuedForceRef.current.delete(key);
      void loadRecord(item, { force: true, urgent: true });
    }
  }, [enabled, getKey, items, loadRecord]);

  useEffect(() => {
    if (!enabled || items.length === 0 || prefetchLimit <= 0) return undefined;

    let cancelled = false;
    const candidates = items.slice(0, prefetchLimit);
    const cancelIdleTask = scheduleIdleTask(() => {
      void (async () => {
        for (const item of candidates) {
          if (cancelled) return;
          await loadRecord(item);
          if (prefetchDelayMs > 0) {
            await delay(prefetchDelayMs);
          }
        }
      })();
    });

    return () => {
      cancelled = true;
      cancelIdleTask();
    };
  }, [enabled, items, loadRecord, prefetchDelayMs, prefetchLimit]);

  const invalidateRecord = useCallback((key: string) => {
    requestVersionRef.current.set(key, (requestVersionRef.current.get(key) ?? 0) + 1);
    queuedForceRef.current.delete(key);
    commitRecords((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _removed, ...next } = prev;
      return next;
    }, true);
  }, [commitRecords]);

  const invalidateMatching = useCallback((matches: (key: string) => boolean) => {
    for (const key of requestVersionRef.current.keys()) {
      if (matches(key)) {
        requestVersionRef.current.set(key, (requestVersionRef.current.get(key) ?? 0) + 1);
        queuedForceRef.current.delete(key);
      }
    }
    commitRecords((prev) => {
      let changed = false;
      const next: RecordMap<TValue> = {};
      for (const [key, value] of Object.entries(prev) as Array<[string, AsyncRecordState<TValue>]>) {
        if (matches(key)) {
          changed = true;
          continue;
        }
        next[key] = value;
      }
      return changed ? next : prev;
    }, true);
  }, [commitRecords]);

  const refreshRecord = useCallback(
    (item: TItem) => loadRecord(item, { force: true, urgent: true }),
    [loadRecord],
  );

  return {
    records,
    loadRecord,
    refreshRecord,
    invalidateRecord,
    invalidateMatching,
  };
}
