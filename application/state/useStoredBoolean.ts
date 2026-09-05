import { useCallback, useEffect, useRef, useState } from "react";
import { localStorageAdapter } from "../../infrastructure/persistence/localStorageAdapter";

/**
 * Hook for persisting a boolean value to localStorage.
 * Syncs across components in the same window via a custom event,
 * and across windows via the native storage event.
 * @param storageKey - The key to use for localStorage
 * @param fallback - The default value if no stored value exists (defaults to false)
 * @returns A tuple of [value, setValue] similar to useState
 */
export const useStoredBoolean = (
    storageKey: string,
    fallback: boolean = false,
) => {
    const [value, setValue] = useState<boolean>(() => {
        const stored = localStorageAdapter.readBoolean(storageKey);
        return stored ?? fallback;
    });
    const valueRef = useRef(value);

    const setAndPersist = useCallback((next: boolean | ((prev: boolean) => boolean)) => {
        // Resolve functional updates before scheduling React state. The updater
        // must stay pure because React may evaluate it while rendering.
        const resolved = typeof next === "function" ? next(valueRef.current) : next;
        valueRef.current = resolved;
        setValue(resolved);
        localStorageAdapter.writeBoolean(storageKey, resolved);
        // Notify other same-window consumers outside the state updater.
        window.dispatchEvent(
            new CustomEvent("stored-boolean-change", { detail: { key: storageKey, value: resolved } }),
        );
    }, [storageKey]);

    useEffect(() => {
        // Sync from other components in the same window
        const handleCustom = (e: Event) => {
            const { key, value: newValue } = (e as CustomEvent).detail;
            if (key === storageKey) {
                valueRef.current = newValue;
                setValue(newValue);
            }
        };
        // Sync from other windows
        const handleStorage = (e: StorageEvent) => {
            if (e.key === storageKey) {
                const stored = localStorageAdapter.readBoolean(storageKey);
                const nextValue = stored ?? fallback;
                valueRef.current = nextValue;
                setValue(nextValue);
            }
        };
        window.addEventListener("stored-boolean-change", handleCustom);
        window.addEventListener("storage", handleStorage);
        return () => {
            window.removeEventListener("stored-boolean-change", handleCustom);
            window.removeEventListener("storage", handleStorage);
        };
    }, [storageKey, fallback]);

    return [value, setAndPersist] as const;
};
