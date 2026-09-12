import { useCallback, useEffect, useState } from "react";
import {
    LOCAL_STORAGE_ADAPTER_CHANGED_EVENT,
    localStorageAdapter,
} from "../../infrastructure/persistence/localStorageAdapter";

export const readStoredNumberValue = (
    storageKey: string,
    fallback: number,
    clamp?: { min: number; max: number },
): number => {
    if (typeof globalThis.localStorage === "undefined") return fallback;
    const stored = localStorageAdapter.readNumber(storageKey);
    if (stored === null) return fallback;
    if (clamp) return Math.max(clamp.min, Math.min(clamp.max, stored));
    return stored;
};

export const createStoredNumberSyncHandler = ({
    storageKey,
    readValue,
    onValue,
}: {
    storageKey: string;
    readValue: () => number;
    onValue: (value: number) => void;
}) => (event: Event) => {
    const key = event.type === "storage"
        ? (event as StorageEvent).key
        : (event as CustomEvent<{ key?: string }>).detail?.key;
    if (key === storageKey) onValue(readValue());
};

/**
 * Hook for reading a number from localStorage with lazy persistence.
 * Unlike useStoredString/useStoredBoolean, this hook does NOT auto-persist
 * on every state change — call `persist()` explicitly when ready (e.g. on
 * mouseup after a drag). This avoids flooding localStorage during
 * high-frequency updates like resize drags.
 */
export const useStoredNumber = (
    storageKey: string,
    fallback: number,
    clamp?: { min: number; max: number },
) => {
    const clampMin = clamp?.min;
    const clampMax = clamp?.max;
    const readValue = useCallback(
        () => readStoredNumberValue(
            storageKey,
            fallback,
            clampMin != null && clampMax != null ? { min: clampMin, max: clampMax } : undefined,
        ),
        [clampMax, clampMin, fallback, storageKey],
    );
    const [value, setValue] = useState<number>(readValue);

    useEffect(() => {
        const target = globalThis as typeof globalThis & {
            addEventListener?: (type: string, listener: EventListener) => void;
            removeEventListener?: (type: string, listener: EventListener) => void;
        };
        if (typeof target.addEventListener !== "function") return;
        const sync = createStoredNumberSyncHandler({ storageKey, readValue, onValue: setValue });
        target.addEventListener(LOCAL_STORAGE_ADAPTER_CHANGED_EVENT, sync);
        target.addEventListener("storage", sync);
        return () => {
            target.removeEventListener?.(LOCAL_STORAGE_ADAPTER_CHANGED_EVENT, sync);
            target.removeEventListener?.("storage", sync);
        };
    }, [readValue, storageKey]);

    const persist = useCallback(
        (v: number) => {
            if (typeof globalThis.localStorage === "undefined") return false;
            return localStorageAdapter.writeNumber(storageKey, v);
        },
        [storageKey],
    );

    return [value, setValue, persist] as const;
};
