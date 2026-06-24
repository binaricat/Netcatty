const safeParse = <T>(value: string | null): T | null => {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
};

export const LOCAL_STORAGE_ADAPTER_CHANGED_EVENT = 'netcatty:local-storage-adapter-changed';

const pendingChangedKeys = new Set<string>();
let emitChangedKeysTimer: ReturnType<typeof setTimeout> | null = null;

function dispatchLocalStorageAdapterChanged(key: string): void {
  try {
    const target = globalThis as typeof globalThis & {
      dispatchEvent?: (event: Event) => boolean;
      CustomEvent?: typeof CustomEvent;
    };
    if (typeof target.dispatchEvent !== 'function' || typeof target.CustomEvent !== 'function') return;
    target.dispatchEvent(new target.CustomEvent<{ key: string }>(
      LOCAL_STORAGE_ADAPTER_CHANGED_EVENT,
      { detail: { key } },
    ));
  } catch {
    // ignore
  }
}

function emitLocalStorageAdapterChanged(key: string): void {
  pendingChangedKeys.add(key);
  if (emitChangedKeysTimer) return;

  // Defer same-window storage notifications so React render-phase writes do
  // not synchronously trigger state updates in unrelated components.
  emitChangedKeysTimer = setTimeout(() => {
    emitChangedKeysTimer = null;
    const keys = Array.from(pendingChangedKeys);
    pendingChangedKeys.clear();
    for (const changedKey of keys) {
      dispatchLocalStorageAdapterChanged(changedKey);
    }
  }, 0);
}

/**
 * Safely write to localStorage, catching QuotaExceededError.
 * Returns true if the write succeeded, false if storage quota was exceeded.
 */
function safeSetItem(key: string, value: string): boolean {
  try {
    if (localStorage.getItem(key) === value) {
      return true;
    }
    localStorage.setItem(key, value);
    emitLocalStorageAdapterChanged(key);
    return true;
  } catch (err) {
    if (
      err instanceof DOMException &&
      (err.name === 'QuotaExceededError' || err.code === 22)
    ) {
      console.warn(
        `[localStorageAdapter] QuotaExceededError writing key "${key}" (${value.length} chars). Data was not persisted.`,
      );
      return false;
    }
    throw err; // Re-throw unexpected errors
  }
}

export const localStorageAdapter = {
  read<T>(key: string): T | null {
    return safeParse<T>(localStorage.getItem(key));
  },
  write<T>(key: string, value: T): boolean {
    const json = JSON.stringify(value);
    return safeSetItem(key, json);
  },
  readString(key: string): string | null {
    return localStorage.getItem(key);
  },
  writeString(key: string, value: string): boolean {
    return safeSetItem(key, value);
  },
  readBoolean(key: string): boolean | null {
    const value = localStorage.getItem(key);
    if (value === null) return null;
    if (value === "true") return true;
    if (value === "false") return false;
    return null;
  },
  writeBoolean(key: string, value: boolean): boolean {
    return safeSetItem(key, value ? "true" : "false");
  },
  readNumber(key: string): number | null {
    const value = localStorage.getItem(key);
    if (!value) return null;
    const num = parseInt(value, 10);
    return isNaN(num) ? null : num;
  },
  writeNumber(key: string, value: number): boolean {
    return safeSetItem(key, String(value));
  },
  remove(key: string) {
    if (localStorage.getItem(key) === null) return;
    localStorage.removeItem(key);
    emitLocalStorageAdapterChanged(key);
  },
};
