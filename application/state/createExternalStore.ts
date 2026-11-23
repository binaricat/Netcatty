import { useSyncExternalStore } from 'react';

export type StoreListener = () => void;

export interface ListenerRegistry {
  subscribe: (listener: StoreListener) => () => void;
  notify: () => void;
  scheduleNotify: () => void;
  readonly size: number;
}

const scheduleFrame = (cb: () => void): number =>
  typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(cb)
    : (setTimeout(cb, 0) as unknown as number);

/**
 * Lightweight listener registry supporting both immediate and rAF-coalesced
 * notifications for `useSyncExternalStore` external stores.
 */
export function createListenerRegistry(): ListenerRegistry {
  const listeners = new Set<StoreListener>();
  let notifyRafId: number | null = null;

  const notify = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    subscribe(listener: StoreListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    notify,
    scheduleNotify(): void {
      if (notifyRafId !== null) return;
      notifyRafId = scheduleFrame(() => {
        notifyRafId = null;
        notify();
      });
    },
    get size(): number {
      return listeners.size;
    },
  };
}

export interface ExternalStore<T> {
  getSnapshot: () => T;
  setSnapshot: (next: T) => void;
  update: (updater: (prev: T) => T) => void;
  subscribe: (listener: StoreListener) => () => void;
  useStore: () => T;
}

export interface CreateExternalStoreOptions<T> {
  isEqual?: (prev: T, next: T) => boolean;
}

/**
 * Factory for simple React `useSyncExternalStore` single-value stores.
 * Defaults to `Object.is` equality to avoid redundant notifications.
 */
export function createExternalStore<T>(
  initial: T,
  options?: CreateExternalStoreOptions<T>,
): ExternalStore<T> {
  const isEqual = options?.isEqual ?? Object.is;
  const registry = createListenerRegistry();
  let snapshot = initial;

  const getSnapshot = (): T => snapshot;

  const setSnapshot = (next: T): void => {
    if (isEqual(snapshot, next)) return;
    snapshot = next;
    registry.notify();
  };

  const update = (updater: (prev: T) => T): void => {
    setSnapshot(updater(snapshot));
  };

  const useStore = (): T =>
    useSyncExternalStore(registry.subscribe, getSnapshot, getSnapshot);

  return {
    getSnapshot,
    setSnapshot,
    update,
    subscribe: registry.subscribe,
    useStore,
  };
}
