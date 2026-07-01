import { useCallback, useEffect, useState } from "react";
import {
  LOCAL_STORAGE_ADAPTER_CHANGED_EVENT,
  localStorageAdapter,
} from "../../infrastructure/persistence/localStorageAdapter";

type StoredStringSetter<T extends string> = (nextValue: T | ((currentValue: T) => T)) => void;

const canUseLocalStorage = () => typeof globalThis.localStorage !== "undefined";

export const readStoredStringValue = <T extends string>(
  storageKey: string,
  fallback: T,
  isAllowedValue: (value: string | null) => value is T,
): T => {
  if (!canUseLocalStorage()) return fallback;
  const stored = localStorageAdapter.readString(storageKey);
  return isAllowedValue(stored) ? stored : fallback;
};

export const readOptionalStoredStringValue = <T extends string>(
  storageKey: string,
  isAllowedValue: (value: string | null) => value is T,
): T | null => {
  if (!canUseLocalStorage()) return null;
  const stored = localStorageAdapter.readString(storageKey);
  return isAllowedValue(stored) ? stored : null;
};

export const resolveStoredStringUpdate = <T extends string>(
  currentValue: T,
  nextValue: T | ((currentValue: T) => T),
): T => (typeof nextValue === "function" ? nextValue(currentValue) : nextValue);

export const shouldSyncStoredStringEvent = (storageKey: string, event: Event): boolean => {
  const changedKey = event.type === "storage"
    ? (event as StorageEvent).key
    : (event as CustomEvent<{ key?: string }>).detail?.key;
  return changedKey === storageKey;
};

export const createStoredStringSyncHandlers = <T extends string>({
  storageKey,
  fallback,
  isAllowedValue,
  onValue,
}: {
  storageKey: string;
  fallback: T;
  isAllowedValue: (value: string | null) => value is T;
  onValue: (value: T) => void;
}) => {
  const syncFromStorage = () => {
    onValue(readStoredStringValue(storageKey, fallback, isAllowedValue));
  };

  return {
    handleAdapterChange(event: Event) {
      if (shouldSyncStoredStringEvent(storageKey, event)) syncFromStorage();
    },
    handleBrowserStorage(event: Event) {
      if (shouldSyncStoredStringEvent(storageKey, event)) syncFromStorage();
    },
  };
};

export const useStoredString = <T extends string>(
  storageKey: string,
  fallback: T,
  isAllowedValue: (value: string | null) => value is T,
) => {
  const [value, setValue] = useState<T>(() => readStoredStringValue(
    storageKey,
    fallback,
    isAllowedValue,
  ));

  const setAndPersist = useCallback<StoredStringSetter<T>>((nextValue) => {
    setValue((currentValue) => {
      const resolvedValue = resolveStoredStringUpdate(currentValue, nextValue);
      if (canUseLocalStorage()) {
        localStorageAdapter.writeString(storageKey, resolvedValue);
      }
      return resolvedValue;
    });
  }, [storageKey]);

  useEffect(() => {
    const target = globalThis as typeof globalThis & {
      addEventListener?: (type: string, listener: EventListener) => void;
      removeEventListener?: (type: string, listener: EventListener) => void;
    };
    if (typeof target.addEventListener !== "function") return;

    const {
      handleAdapterChange,
      handleBrowserStorage,
    } = createStoredStringSyncHandlers({
      storageKey,
      fallback,
      isAllowedValue,
      onValue: setValue,
    });

    target.addEventListener(LOCAL_STORAGE_ADAPTER_CHANGED_EVENT, handleAdapterChange);
    target.addEventListener("storage", handleBrowserStorage);
    return () => {
      target.removeEventListener?.(LOCAL_STORAGE_ADAPTER_CHANGED_EVENT, handleAdapterChange);
      target.removeEventListener?.("storage", handleBrowserStorage);
    };
  }, [fallback, isAllowedValue, storageKey]);

  return [value, setAndPersist] as const;
};
